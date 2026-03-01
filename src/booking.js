const SiteAutomation = require('./site');
const db = require('./db');
const config = require('./config');
const logger = require('./logger');
const notify = require('./notify');
const { computeBookingSlots, groupByDateAndTime } = require('./scheduler');

class BookingEngine {
  constructor({ dryRun = false } = {}) {
    this.dryRun = dryRun;
    this.site = new SiteAutomation();
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
        logger.info(`  ${group.date} (${group.dayLabel}): ${group.slots.length} slots`);
        for (const slot of group.slots) {
          logger.info(`    Slot ${slot.slot_index}: ${slot.target_time} — ${slot.players} players (attempt ${slot.attempts + 1})`);
        }
      }
      return { total: pending.length, booked: 0, failed: 0, partial: 0, dryRun: true };
    }

    let stats = { total: pending.length, booked: 0, failed: 0, partial: 0 };

    try {
      await this.site.init();

      const firstDate = groups[0].date;
      await this.site.navigateToBooking(config.site.courses.pines.id, firstDate);
      await this.site.login();

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
    } finally {
      await this.site.close();
    }

    logger.info(`=== Run Complete: ${stats.booked} booked, ${stats.failed} failed, ${stats.partial} partial ===`);
    return stats;
  }

  async _processGroup(group) {
    const { date, dayLabel, slots } = group;
    logger.info(`Processing: ${date} (${dayLabel}) — ${slots.length} slots`);

    const windowStart = slots[0].window_start || slots[0].target_time;
    const windowEnd = slots[0].window_end || slots[0].target_time;
    const slotsNeeded = slots.length;

    // Try preferred course first, then fallback
    const preferred = slots[0].course || 'Pines';
    const allCourses = [
      { id: config.site.courses.pines.id, name: 'Pines' },
      { id: config.site.courses.oaks.id, name: 'Oaks' },
    ];
    const coursesToTry = [
      allCourses.find(c => c.name === preferred),
      allCourses.find(c => c.name !== preferred),
    ];

    // Pass 1: Try to find consecutive slots on each course (ideal)
    for (const course of coursesToTry) {
      logger.info(`Trying ${course.name} course for ${date} (consecutive)...`);
      await this.site.navigateToBooking(course.id, date);
      await this.site.selectCourse();
      await this.site.selectDate(date);

      const teeTimes = await this.site.getAvailableTeeTimes();
      if (teeTimes.length === 0) {
        logger.warn(`No tee times on ${course.name} for ${date}`);
        continue;
      }

      const consecutive = this.site.findConsecutiveSlots(teeTimes, windowStart, windowEnd, slotsNeeded);
      if (consecutive.length > 0) {
        const result = await this._bookSlots(consecutive, slots, date, dayLabel, course.name);
        if (result.booked === slotsNeeded) {
          notify.alertSuccess({ date, dayLabel, slots: result.booked, course: course.name });
        } else if (result.booked > 0) {
          notify.alertPartialBooking({ date, dayLabel, bookedSlots: result.booked, totalSlots: slotsNeeded });
        }
        return result;
      }
      logger.warn(`No ${slotsNeeded} consecutive slots in ${windowStart}-${windowEnd} on ${course.name}`);
    }

    // Pass 2: Fallback — book any available individual slots in window across both courses
    logger.info(`No consecutive slots found — falling back to individual slot booking for ${date}`);
    const remainingSlots = [...slots];
    const result = { booked: 0, failed: 0, partial: 0 };

    for (const course of coursesToTry) {
      if (remainingSlots.length === 0) break;

      logger.info(`Trying individual slots on ${course.name} for ${date}...`);
      await this.site.navigateToBooking(course.id, date);
      await this.site.selectCourse();
      await this.site.selectDate(date);

      const teeTimes = await this.site.getAvailableTeeTimes();
      const available = this.site.findSlotsInWindow(teeTimes, windowStart, windowEnd, remainingSlots.length);

      if (available.length === 0) {
        logger.warn(`No slots in ${windowStart}-${windowEnd} on ${course.name}`);
        continue;
      }

      logger.info(`Found ${available.length} individual slots on ${course.name}: ${available.map(t => t.time).join(', ')}`);

      const booked = await this._bookSlots(available, remainingSlots.splice(0, available.length), date, dayLabel, course.name);
      result.booked += booked.booked;
      result.failed += booked.failed;
      result.partial += booked.partial;
    }

    // Mark any remaining unbooked slots as failed
    for (const slot of remainingSlots) {
      await db.markFailed(slot.id, `No available slots in ${windowStart}-${windowEnd} on either course`);
      result.failed++;
    }

    if (result.booked > 0 && result.booked < slotsNeeded) {
      notify.alertPartialBooking({ date, dayLabel, bookedSlots: result.booked, totalSlots: slotsNeeded });
    } else if (result.booked === 0) {
      notify.alertFailure({ date, dayLabel, error: `No slots in ${windowStart}-${windowEnd} on either course` });
    }

    return result;
  }

  async _bookSlots(consecutive, slots, date, dayLabel, courseName) {
    const result = { booked: 0, failed: 0, partial: 0 };
    const slotsNeeded = slots.length;
    const courseId = courseName === 'Oaks' ? config.site.courses.oaks.id : config.site.courses.pines.id;

    // Store the times we want to book (element refs go stale after navigation)
    const timesToBook = consecutive.map(t => t.time);
    logger.info(`Will book ${timesToBook.length} slots individually: ${timesToBook.join(', ')}`);

    let bookedCount = 0;
    for (let i = 0; i < timesToBook.length; i++) {
      const targetTime = timesToBook[i];
      const dbSlot = slots[i];

      logger.info(`Booking slot ${i}: ${targetTime} for ${dbSlot.players} players`);

      // Re-scan tee times to get fresh element references
      if (i > 0) {
        await this.site.navigateToBooking(courseId, date);
        await this.site.selectCourse();
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
        const confirmation = checkoutResult.confirmationNumber || bookResult.confirmationNumber || 'CONFIRMED';
        logger.info(`Slot ${i} (${targetTime}) checkout complete! Confirmation: ${confirmation}`);

        await db.markSuccess(dbSlot.id, {
          actualTime: targetTime,
          course: courseName,
          confirmationNumber: confirmation,
          screenshotPath: checkoutResult.screenshotPath || bookResult.screenshotPath,
        });
        bookedCount++;
        result.booked++;
      } else {
        await db.markFailed(dbSlot.id, bookResult.error);
        result.failed++;
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    return result;
  }
}

module.exports = BookingEngine;
