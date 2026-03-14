const SiteAutomation = require('./site');
const db = require('./db');
const config = require('./config');
const logger = require('./logger');
const notify = require('./notify');
const { computeBookingSlots, groupByDateAndTime } = require('./scheduler');

class BookingEngine {
  /**
   * @param {object}  [opts]
   * @param {boolean} [opts.dryRun=false]   When true, log what would be booked but make no site calls.
   * @param {import('./site')|null} [opts.site=null]
   *   An already-authenticated SiteAutomation instance to reuse.  When provided,
   *   BookingEngine skips init(), login(), and close() — the caller is responsible
   *   for the browser lifecycle.  When null, BookingEngine manages its own session.
   */
  constructor({ dryRun = false, site = null } = {}) {
    this.dryRun = dryRun;
    this._sharedSite = site !== null;
    this.site = site !== null ? site : new SiteAutomation();
  }

  async run() {
    logger.info('=== Golf Scheduler Run Started ===');
    logger.info(`Dry run: ${this.dryRun}`);
    logger.info(`Horizon: ${config.horizonDays} days`);

    const allSlots = computeBookingSlots();
    logger.info(`Computed ${allSlots.length} total slots across ${config.horizonDays} days`);

    await db.ensureBookings(allSlots);

    const pending = await db.getPendingBookings();
    logger.info(`${pending.length} bookings pending`);

    if (pending.length === 0) {
      logger.info('All bookings are up to date. Nothing to do.');
      return { total: 0, booked: 0, failed: 0, partial: 0 };
    }

    const groups = groupByDateAndTime(pending);
    logger.info(`${groups.length} date/time groups to process`);

    if (this.dryRun) {
      logger.info('DRY RUN — showing what would be booked:');
      for (const group of groups) {
        const gi = group.slots[0]?.golfer_index ?? 0;
        const golfer = config.golfers[gi] || config.golfers[0];
        logger.info(`  ${group.date} (${group.dayLabel}): ${group.slots.length} slots [Golfer ${gi + 1}: ${golfer?.email}]`);
        for (const slot of group.slots) {
          logger.info(`    Slot ${slot.slot_index}: ${slot.target_time} — ${slot.players} players (attempt ${slot.attempts + 1})`);
        }
      }
      return { total: pending.length, booked: 0, failed: 0, partial: 0, dryRun: true };
    }

    let stats = { total: pending.length, booked: 0, failed: 0, partial: 0 };

    if (this._sharedSite) {
      // Shared-site mode (e.g. sync+book in same session): use provided site for all bookings.
      try {
        await this.site.clearCart();
        for (const group of groups) {
          try {
            const result = await this._processGroup(group);
            stats.booked += result.booked;
            stats.failed += result.failed;
            stats.partial += result.partial;
          } catch (error) {
            if (error.message.startsWith('BLOCKED')) {
              notify.alertBlocked({ error: error.message });
              break;
            }
            logger.error(`Error processing ${group.date}: ${error.message}`);
            for (const slot of group.slots) {
              await db.markFailed(slot.id, error.message);
            }
            stats.failed += group.slots.length;
          }
        }
      } catch (error) {
        if (error.message.startsWith('BLOCKED')) {
          notify.alertBlocked({ error: error.message });
        } else {
          logger.error(`Fatal error: ${error.message}`);
        }
      }
    } else {
      // Per-golfer mode: group date-groups by golfer_index, create a separate session per golfer.
      const golferGroupsMap = new Map();
      for (const group of groups) {
        const gi = group.slots[0]?.golfer_index ?? 0;
        if (!golferGroupsMap.has(gi)) golferGroupsMap.set(gi, []);
        golferGroupsMap.get(gi).push(group);
      }

      for (const [golferIndex, golferDateGroups] of golferGroupsMap) {
        const golfer = config.golfers[golferIndex] || config.golfers[0];
        logger.info(`Processing ${golferDateGroups.length} date(s) for Golfer ${golferIndex + 1} (${golfer.email})`);

        const site = new SiteAutomation({ email: golfer.email, password: golfer.password });
        this.site = site;

        try {
          await site.init();
          const firstDate = golferDateGroups[0].date;
          await site.navigateToBooking(config.site.courses.pines.id, firstDate);
          await site.login();
          await site.clearCart();

          for (const group of golferDateGroups) {
            try {
              const result = await this._processGroup(group);
              stats.booked += result.booked;
              stats.failed += result.failed;
              stats.partial += result.partial;
            } catch (error) {
              if (error.message.startsWith('BLOCKED')) {
                notify.alertBlocked({ error: error.message });
                break;
              }
              logger.error(`Error processing ${group.date}: ${error.message}`);
              for (const slot of group.slots) {
                await db.markFailed(slot.id, error.message);
              }
              stats.failed += group.slots.length;
            }
          }
        } catch (error) {
          if (error.message.startsWith('BLOCKED')) {
            notify.alertBlocked({ error: error.message });
          } else {
            logger.error(`Fatal error for Golfer ${golferIndex + 1}: ${error.message}`);
          }
        } finally {
          await site.close();
          this.site = null;
        }
      }
    }

    logger.info(`=== Run Complete: ${stats.booked} booked, ${stats.failed} failed, ${stats.partial} partial ===`);
    return stats;
  }

  async _processGroup(group) {
    const { date, dayLabel } = group;
    let { slots } = group;
    logger.info(`Processing: ${date} (${dayLabel}) — ${slots.length} slots`);

    // Check existing reservations on the site before booking
    try {
      const existingReservations = await this.site.getExistingReservations(date);
      if (existingReservations.length > 0) {
        slots = await this._filterAlreadyBooked(slots, existingReservations, date);
        if (slots.length === 0) {
          logger.info(`All slots for ${date} already covered by existing reservations — skipping`);
          return { booked: 0, failed: 0, partial: 0 };
        }
        logger.info(`${slots.length} slot(s) remaining to book for ${date} after reservation check`);
      }
    } catch (error) {
      logger.warn(`Error checking existing reservations for ${date}: ${error.message} — proceeding with booking`);
    }

    const baseStart = slots[0].window_start || slots[0].target_time;
    const baseEnd   = slots[0].window_end   || slots[0].target_time;

    const preferred = slots[0].course || 'Pines';
    const other = preferred === 'Pines' ? 'Oaks' : 'Pines';

    // Build fallback attempts: try ALL time windows on preferred course first,
    // then ALL time windows on other course. This ensures all slots for a day
    // end up on the same course (no splitting across Pines/Oaks).
    // Offsets: original → -1hr → +1hr → -2hr → +2hr
    const offsets = [0, -60, 60, -120, 120];
    const attempts = [];
    for (const course of [preferred, other]) {
      for (const offset of offsets) {
        const start = offset === 0 ? baseStart : this._shiftTime(baseStart, offset);
        const end   = offset === 0 ? baseEnd   : this._shiftTime(baseEnd, offset);
        // Note: _shiftTime uses ((total % 1440) + 1440) % 1440 which always produces [0,1439].
        // The previous negative-time guard was unreachable and has been removed.
        attempts.push({ course, start, end, offset });
      }
    }

    const totalSlots = slots.length;
    const cumulative = { booked: 0, failed: 0, partial: 0 };
    let lockedCourse = null; // Once a slot is booked, lock to that course

    for (const [i, attempt] of attempts.entries()) {
      if (slots.length === 0) break;

      // Once we've booked on a course, skip attempts for the other course
      // This ensures all slots for a day end up on the same course
      if (lockedCourse && attempt.course !== lockedCourse) continue;

      const offsetLabel = attempt.offset === 0 ? '' : ` (${attempt.offset > 0 ? '+' : ''}${attempt.offset / 60}hr)`;
      const label = `${attempt.course} ${attempt.start}-${attempt.end}${offsetLabel}`;
      logger.info(`Attempt ${i + 1}/${attempts.length}: ${label} (${slots.length} slots needed)`);

      const result = await this._tryCourse(slots, date, dayLabel, attempt.course, attempt.start, attempt.end);

      if (result.booked > 0) {
        lockedCourse = attempt.course; // Lock to this course for remaining slots
        cumulative.booked += result.booked;
        // Filter out booked slots for remaining attempts
        slots = slots.filter(s => !result._bookedSlotIds || !result._bookedSlotIds.has(s.id));
        if (slots.length === 0) {
          logger.info(`All slots booked on ${label}`);
          break;
        }
        logger.info(`${result.booked} slot(s) booked on ${label}, ${slots.length} remaining — locked to ${lockedCourse}`);
      } else if (result.slotsFound) {
        logger.warn(`Slots found on ${label} but booking failed — trying next fallback`);
      } else {
        logger.warn(`No available slots on ${label} — trying next fallback`);
      }
    }

    // Final reporting
    cumulative.failed = totalSlots - cumulative.booked;

    if (cumulative.booked === totalSlots) {
      notify.alertSuccess({ date, dayLabel, slots: cumulative.booked, course: lockedCourse || preferred });
    } else if (cumulative.booked > 0) {
      notify.alertPartialBooking({ date, dayLabel, bookedSlots: cumulative.booked, totalSlots });
    } else {
      for (const slot of slots) {
        await db.markFailed(slot.id, `No slots on ${preferred} or ${other} across all time windows (±2hr)`);
      }
      notify.alertFailure({ date, dayLabel, error: `No slots available on either course across all time windows (±2hr)` });
    }

    return cumulative;
  }

  /**
   * Try to book slots on a single course within a specific time window.
   * First tries consecutive slots, then falls back to individual slots.
   * Returns { booked, failed, slotsFound, _bookedSlotIds }
   */
  async _tryCourse(slots, date, dayLabel, courseName, windowStart, windowEnd) {
    const courseId = courseName === 'Oaks' ? config.site.courses.oaks.id : config.site.courses.pines.id;
    const slotsNeeded = slots.length;

    await this.site.navigateToBooking(courseId, date);
    await this.site.selectCourse(courseName);
    await this.site.selectDate(date);

    const teeTimes = await this.site.getAvailableTeeTimes();
    if (teeTimes.length === 0) {
      logger.warn(`No tee times on ${courseName} for ${date}`);
      return { booked: 0, failed: 0, slotsFound: false, _bookedSlotIds: new Set() };
    }

    // Try consecutive slots first (ideal for group play)
    const consecutive = this.site.findConsecutiveSlots(teeTimes, windowStart, windowEnd, slotsNeeded);
    if (consecutive.length > 0) {
      const result = await this._bookSlots(consecutive, slots, date, dayLabel, courseName);
      return { ...result, slotsFound: true };
    }

    // Fall back to individual slots in the window
    const available = this.site.findSlotsInWindow(teeTimes, windowStart, windowEnd, slotsNeeded);
    if (available.length === 0) {
      logger.warn(`No slots in ${windowStart}-${windowEnd} on ${courseName}`);
      return { booked: 0, failed: 0, slotsFound: false, _bookedSlotIds: new Set() };
    }

    logger.info(`Found ${available.length} individual slots on ${courseName}: ${available.map(t => t.time).join(', ')}`);
    const result = await this._bookSlots(available, slots.slice(0, available.length), date, dayLabel, courseName);
    return { ...result, slotsFound: true };
  }

  /**
   * Filter out pending slots that are already covered by existing reservations on the site.
   * Compares each existing reservation time against pending slot target times (±15 min match).
   * Matched slots are marked as 'confirmed' in the DB.
   * Returns the remaining unmatched slots.
   */
  async _filterAlreadyBooked(slots, existingReservations, date) {
    const remaining = [];

    for (const slot of slots) {
      const slotMinutes = this._timeToMinutes(slot.target_time);
      const match = existingReservations.find(res => {
        const resMinutes = this._timeToMinutes(res.time);
        // If slot has a booking window, match any reservation within window ±2hr (covers all fallback offsets)
        if (slot.window_start && slot.window_end) {
          const winStart = this._timeToMinutes(slot.window_start) - 120;
          const winEnd   = this._timeToMinutes(slot.window_end)   + 120;
          return resMinutes >= winStart && resMinutes <= winEnd;
        }
        return Math.abs(resMinutes - slotMinutes) <= 15;
      });

      if (match) {
        logger.info(`Slot ${slot.slot_index} (${slot.target_time}) already covered by existing reservation at ${match.time} (${match.course}) — marking confirmed`);
        await db.markSuccess(slot.id, {
          actualTime: match.time,
          course: match.course,
          confirmationNumber: 'EXISTING_RESERVATION',
          screenshotPath: null,
        });
        // Remove the matched reservation so it doesn't match multiple slots
        const idx = existingReservations.indexOf(match);
        existingReservations.splice(idx, 1);
      } else {
        remaining.push(slot);
      }
    }

    return remaining;
  }

  _timeToMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  }

  _shiftTime(timeStr, minutes) {
    const [h, m] = timeStr.split(':').map(Number);
    const total = h * 60 + m + minutes;
    const totalMod = ((total % 1440) + 1440) % 1440;
    return `${String(Math.floor(totalMod / 60)).padStart(2, '0')}:${String(totalMod % 60).padStart(2, '0')}`;
  }

  _minutesToTime(minutes) {
    const totalMod = ((minutes % 1440) + 1440) % 1440;
    return `${String(Math.floor(totalMod / 60)).padStart(2, '0')}:${String(totalMod % 60).padStart(2, '0')}`;
  }

  async _bookSlots(consecutive, slots, date, dayLabel, courseName) {
    const result = { booked: 0, failed: 0, partial: 0, _bookedSlotIds: new Set() };
    const slotsNeeded = slots.length;
    const courseId = courseName === 'Oaks' ? config.site.courses.oaks.id : config.site.courses.pines.id;
    // Track players actually booked vs target (4 per slot) so we can add compensating slots
    let totalPlayersBooked = 0;
    const targetPlayersTotal = slotsNeeded * 4;

    // Store the times we want to book (element refs go stale after navigation)
    const timesToBook = consecutive.map(t => t.time);

    // TASK-019: Multi-batch split enforcement.
    // The site allows at most 3 tee time slots per booking transaction.
    // The current implementation completes a full checkout per slot (batch size = 1),
    // which always satisfies the ≤3 constraint.  If a caller somehow passes > 3 slots
    // we log the batch breakdown so the intent is clear in the run log.
    const MAX_BATCH_SIZE = 3;
    if (timesToBook.length > MAX_BATCH_SIZE) {
      const numBatches = Math.ceil(timesToBook.length / MAX_BATCH_SIZE);
      const batchSizes = Array.from({ length: numBatches }, (_, i) =>
        Math.min(MAX_BATCH_SIZE, timesToBook.length - i * MAX_BATCH_SIZE)
      );
      logger.info(
        `Batch split triggered: ${timesToBook.length} slots → ${numBatches} batch(es) ` +
        `of [${batchSizes.join(', ')}] slot(s) each (max ${MAX_BATCH_SIZE} per transaction)`
      );
    }

    logger.info(`Will book ${timesToBook.length} slots individually: ${timesToBook.join(', ')}`);

    let bookedCount = 0;
    for (let i = 0; i < timesToBook.length; i++) {
      const targetTime = timesToBook[i];
      const dbSlot = slots[i];

      logger.info(`Booking slot ${i}: ${targetTime} for ${dbSlot.players} players`);

      // Re-scan tee times to get fresh element references
      if (i > 0) {
        await this.site.navigateToBooking(courseId, date);
        await this.site.selectCourse(courseName);
        await this.site.selectDate(date);
      }

      const teeTimes = await this.site.getAvailableTeeTimes();
      const match = teeTimes.find(t => t.time === targetTime);
      if (!match) {
        logger.warn(`Tee time ${targetTime} no longer available (may have just been booked)`);
        await db.markFailed(dbSlot.id, `Tee time ${targetTime} no longer available`);
        result.failed++;
        continue;
      }

      // Book Now → 4 golfers → Add to Cart
      const bookResult = await this.site.bookSlot(match.element, i);

      if (bookResult.success) {
        // Complete checkout: Terms → Complete Your Purchase
        const checkoutResult = await this.site.completeCheckout();

        if (!checkoutResult.success) {
          logger.warn(`Slot ${i} (${targetTime}) checkout FAILED: ${checkoutResult.error || 'unknown error'}`);
          await db.markFailed(dbSlot.id, checkoutResult.error || 'Checkout failed');
          result.failed++;
          continue;
        }

        const confirmation = checkoutResult.confirmationNumber || 'CONFIRMED';
        logger.info(`Slot ${i} (${targetTime}) checkout succeeded! Confirmation: ${confirmation}`);

        // TASK-020: Post-checkout verification via Reservations page.
        // Only run verification when we have a real numeric confirmation number.
        // If the page loads but does not contain the booking, mark as failed.
        // If the page is unreachable / returns no reservations at all (possible
        // caching delay after checkout), skip verification and keep confirmed.
        let verificationFailed = false;
        if (/^\d+$/.test(confirmation)) {
          try {
            const vResult = await this.site.verifyBookingOnSite(date, targetTime);
            if (!vResult.verified) {
              if (vResult.reservations && vResult.reservations.length > 0) {
                // Reservations page loaded but our booking was NOT among them — real failure.
                logger.warn(
                  `Slot ${i} (${targetTime}) VERIFICATION FAILED: booking Res#${confirmation} ` +
                  `not found on Reservations page for ${date} — marking failed`
                );
                await db.markFailed(dbSlot.id, `Post-checkout verification failed: Res#${confirmation} not found on Reservations page`);
                result.failed++;
                verificationFailed = true;
              } else {
                // Page returned no reservations — likely a caching delay; skip and keep confirmed.
                logger.warn(
                  `Slot ${i} (${targetTime}) verification skipped: Reservations page returned no entries ` +
                  `(possible caching delay) — keeping confirmed`
                );
              }
            } else {
              logger.info(`Slot ${i} (${targetTime}) verification passed`);
            }
          } catch (verifyErr) {
            // Unreachable / timeout — skip verification; keep confirmed.
            logger.warn(
              `Slot ${i} (${targetTime}) verification error (${verifyErr.message}) — skipping, keeping confirmed`
            );
          }
        }

        if (!verificationFailed) {
          const playersBooked = bookResult.selectedCount || 4;
          await db.markSuccess(dbSlot.id, {
            actualTime: targetTime,
            course: courseName,
            confirmationNumber: confirmation,
            screenshotPath: checkoutResult.screenshotPath || bookResult.screenshotPath,
          });
          bookedCount++;
          totalPlayersBooked += playersBooked;
          result.booked++;
          result._bookedSlotIds.add(dbSlot.id);
        }
      } else {
        await db.markFailed(dbSlot.id, bookResult.error);
        result.failed++;
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    // If fewer-than-4-player slots were booked, add compensating pending slots
    // so the next booking run can fill the remaining players up to the target.
    if (totalPlayersBooked > 0 && totalPlayersBooked < targetPlayersTotal) {
      const deficit = targetPlayersTotal - totalPlayersBooked;
      const extraSlots = Math.ceil(deficit / 4); // additional 4-player-target slots needed
      logger.info(
        `Player deficit on ${date}: booked ${totalPlayersBooked}/${targetPlayersTotal} players — ` +
        `adding ${extraSlots} extra pending slot(s)`
      );
      // Use the last booked slot as reference for day_label, window, golfer_index
      const refSlot = slots[slots.length - 1];
      const maxSlotIndex = Math.max(...slots.map(s => s.slot_index));
      const extraBookings = [];
      for (let e = 0; e < extraSlots; e++) {
        // Space extra slots 10 min after the last target_time
        const lastTime = slots[slots.length - 1].target_time;
        const lastMins = this._timeToMinutes(lastTime) + (e + 1) * 10;
        const extraTime = this._minutesToTime(lastMins);
        extraBookings.push({
          date,
          dayLabel: refSlot.day_label,
          targetTime: extraTime,
          windowStart: refSlot.window_start,
          windowEnd: refSlot.window_end,
          course: courseName,
          slotIndex: maxSlotIndex + 1 + e,
          players: 4,
          golferIndex: refSlot.golfer_index,
        });
      }
      await db.ensureBookings(extraBookings);
      result._extraSlotsAdded = extraSlots;
    }

    return result;
  }
}

module.exports = BookingEngine;
