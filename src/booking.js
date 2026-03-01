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

    const result = { booked: 0, failed: 0, partial: 0 };

    let courseId = config.site.courses.pines.id;
    await this.site.navigateToBooking(courseId, date);
    const selectedCourse = await this.site.selectCourse();

    if (selectedCourse === config.site.courses.oaks.id) {
      courseId = selectedCourse;
      await this.site.navigateToBooking(courseId, date);
    }

    await this.site.selectDate(date);

    const teeTimes = await this.site.getAvailableTeeTimes();
    if (teeTimes.length === 0) {
      logger.warn(`No tee times available for ${date}`);
      if (courseId === config.site.courses.pines.id) {
        logger.info('Trying Oaks course as fallback...');
        courseId = config.site.courses.oaks.id;
        await this.site.navigateToBooking(courseId, date);
        await this.site.selectDate(date);
        const oaksTimes = await this.site.getAvailableTeeTimes();
        if (oaksTimes.length === 0) {
          for (const slot of slots) {
            await db.markFailed(slot.id, 'No tee times available on either course');
          }
          result.failed = slots.length;
          notify.alertFailure({ date, dayLabel, error: 'No tee times on either course' });
          return result;
        }
        return this._bookSlots(oaksTimes, slots, date, dayLabel, 'Oaks');
      }
      for (const slot of slots) {
        await db.markFailed(slot.id, 'No tee times available');
      }
      result.failed = slots.length;
      return result;
    }

    return this._bookSlots(teeTimes, slots, date, dayLabel, courseId === config.site.courses.oaks.id ? 'Oaks' : 'Pines');
  }

  async _bookSlots(teeTimes, slots, date, dayLabel, courseName) {
    const result = { booked: 0, failed: 0, partial: 0 };
    const windowStart = slots[0].window_start || slots[0].target_time;
    const windowEnd = slots[0].window_end || slots[0].target_time;
    const slotsNeeded = slots.length;

    const consecutive = this.site.findConsecutiveSlots(teeTimes, windowStart, windowEnd, slotsNeeded);

    if (consecutive.length === 0) {
      logger.warn(`Cannot find ${slotsNeeded} consecutive slots in window ${windowStart}-${windowEnd}`);
      for (const slot of slots) {
        await db.markFailed(slot.id, `No ${slotsNeeded} consecutive slots in ${windowStart}-${windowEnd}`);
      }
      result.failed = slotsNeeded;
      notify.alertFailure({ date, dayLabel, error: `No consecutive slots in ${windowStart}-${windowEnd}` });
      return result;
    }

    let bookedCount = 0;
    for (let i = 0; i < consecutive.length; i++) {
      const teeTime = consecutive[i];
      const dbSlot = slots[i];

      logger.info(`Booking slot ${i}: ${teeTime.time} for ${dbSlot.players} players`);

      const bookResult = await this.site.bookSlot(teeTime.element, i);

      if (bookResult.success) {
        await db.markSuccess(dbSlot.id, {
          actualTime: teeTime.time,
          confirmationNumber: bookResult.confirmationNumber || 'CONFIRMED',
          screenshotPath: bookResult.screenshotPath,
        });
        bookedCount++;
        result.booked++;
      } else {
        await db.markFailed(dbSlot.id, bookResult.error);
        result.failed++;
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    // Complete checkout if items were added to cart
    if (bookedCount > 0) {
      const checkoutResult = await this.site.completeCheckout();
      if (checkoutResult.confirmationNumber) {
        logger.info(`Checkout complete! Confirmation: ${checkoutResult.confirmationNumber}`);
      }
      if (checkoutResult.screenshotPath) {
        logger.info(`Checkout screenshot: ${checkoutResult.screenshotPath}`);
      }
    }

    if (bookedCount > 0 && bookedCount < slotsNeeded) {
      result.partial++;
      const screenshotPath = await this.site.screenshot(`partial-${date}`);
      notify.alertPartialBooking({
        date,
        dayLabel,
        bookedSlots: bookedCount,
        totalSlots: slotsNeeded,
        screenshotPath,
      });
    } else if (bookedCount === slotsNeeded) {
      notify.alertSuccess({ date, dayLabel, slots: bookedCount, course: courseName });
    }

    return result;
  }
}

module.exports = BookingEngine;
