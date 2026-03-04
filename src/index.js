#!/usr/bin/env node
const { program } = require('commander');
const { execFile } = require('child_process');
const path = require('path');

function generateAndPush() {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, '../generate-static.js')], (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      resolve();
    });
  });
}

program
  .name('golf-scheduler')
  .description('Automated tee time booking for Fort Walton Beach Golf')
  .version('1.0.0');

program
  .command('book', { isDefault: true })
  .description('Run the booking engine once (book all pending tee times)')
  .option('--dry-run', 'Show what would be booked without actually booking')
  .action(async (opts) => {
    const BookingEngine = require('./booking');
    const engine = new BookingEngine({ dryRun: opts.dryRun });
    const stats = await engine.run();
    console.log('\nResults:', JSON.stringify(stats, null, 2));
    if (!opts.dryRun) await generateAndPush();

    // After a real booking run, launch the web calendar view
    if (!opts.dryRun && stats.total > 0) {
      console.log('\nStarting calendar web view...');
      const { startServer } = require('./web');
      const server = await startServer();
      // Open browser to the calendar
      const { exec } = require('child_process');
      const url = 'http://localhost:3000';
      const openCmd = process.platform === 'win32' ? `start ${url}` :
                      process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
      exec(openCmd);
      console.log(`Calendar view open at ${url} — press Ctrl+C to stop`);
    } else {
      process.exit(stats.failed > 0 ? 1 : 0);
    }
  });

program
  .command('status')
  .description('Show current booking status')
  .action(async () => {
    const db = require('./db');
    const bookings = await db.getAllUpcoming();
    if (bookings.length === 0) {
      console.log('No upcoming bookings. Run "npm run book" to start.');
      return;
    }
    console.log(`\n${'Date'.padEnd(12)} ${'Day'.padEnd(20)} ${'Time'.padEnd(7)} ${'Slot'.padEnd(5)} ${'Status'.padEnd(12)} ${'Confirmation'.padEnd(20)} Attempts`);
    console.log('-'.repeat(90));
    for (const b of bookings) {
      console.log(
        `${b.date.padEnd(12)} ${b.day_label.padEnd(20)} ${b.target_time.padEnd(7)} ${String(b.slot_index).padEnd(5)} ${b.status.padEnd(12)} ${(b.confirmation_number || '-').padEnd(20)} ${b.attempts}`
      );
    }
    console.log(`\nTotal: ${bookings.length} bookings`);
    const confirmed = bookings.filter(b => b.status === 'confirmed').length;
    const pending = bookings.filter(b => b.status === 'pending').length;
    const failed = bookings.filter(b => b.status === 'failed').length;
    console.log(`Confirmed: ${confirmed} | Pending: ${pending} | Failed: ${failed}`);
  });

program
  .command('scheduler')
  .description('Run daily at SCHEDULER_HOUR (default 06:00): sync then book')
  .action(async () => {
    // Force headless mode for the automated daily job so no browser window pops up.
    process.env.HEADLESS = 'true';

    const BookingEngine = require('./booking');
    const SiteAutomation = require('./site');
    const { runSync } = require('./sync');
    const logger = require('./logger');
    const config = require('./config');
    const dayjs = require('dayjs');
    const utc = require('dayjs/plugin/utc');
    const timezone = require('dayjs/plugin/timezone');
    dayjs.extend(utc);
    dayjs.extend(timezone);

    const hour = config.schedulerHour;
    logger.info(`[SCHEDULER] Scheduler mode started — daily job fires at ${String(hour).padStart(2, '0')}:00 ${config.timezone}`);
    logger.info('[SCHEDULER] Press Ctrl+C to stop');

    /**
     * Returns the number of milliseconds until the next occurrence of `hour:00`
     * in the configured timezone. Returns 0 if that time has already passed today
     * (so the job runs immediately on startup).
     *
     * @param {number} fireHour  0–23
     * @returns {number}
     */
    function msUntilNextFire(fireHour) {
      const now = dayjs().tz(config.timezone);
      // Target: today at fireHour:00:00
      let target = now.startOf('day').add(fireHour, 'hour');
      // If target is in the past (or right now), move to tomorrow.
      if (target.valueOf() <= now.valueOf()) {
        target = target.add(1, 'day');
      }
      return target.valueOf() - now.valueOf();
    }

    /**
     * Execute one full daily job cycle: sync → book.
     * Creates a single shared SiteAutomation session for both phases.
     */
    const runOnce = async () => {
      const startTime = dayjs().tz(config.timezone);
      logger.info(`[SCHEDULER] === Daily job started at ${startTime.format('YYYY-MM-DD HH:mm:ss z')} ===`);

      const site = new SiteAutomation();
      let syncResult = { checked: 0, updated: 0, warnings: 0, errors: 0 };
      let bookingResult = { total: 0, booked: 0, failed: 0, partial: 0 };

      try {
        await site.init();
        await site.navigateToBooking(
          config.site.courses.pines.id,
          new Date().toISOString().slice(0, 10)
        );
        await site.login();

        // ── Phase 1: Sync ────────────────────────────────────────────────────
        try {
          syncResult = await runSync(site);
        } catch (syncErr) {
          logger.error(`[SCHEDULER] Sync phase error: ${syncErr.message}`);
          syncResult.errors = (syncResult.errors || 0) + 1;
        }
        logger.info(
          `[SCHEDULER] Sync result: checked=${syncResult.checked} updated=${syncResult.updated} ` +
          `warnings=${syncResult.warnings} errors=${syncResult.errors}`
        );

        // ── Phase 2: Book ────────────────────────────────────────────────────
        try {
          const engine = new BookingEngine({ site });
          bookingResult = await engine.run();
        } catch (bookErr) {
          logger.error(`[SCHEDULER] Booking phase error: ${bookErr.message}`);
          bookingResult.failed = (bookingResult.failed || 0) + 1;
        }
        logger.info(
          `[SCHEDULER] Booking result: total=${bookingResult.total} booked=${bookingResult.booked} failed=${bookingResult.failed}`
        );

      } finally {
        try {
          await site.close();
        } catch (closeErr) {
          logger.error(`[SCHEDULER] Error closing browser session: ${closeErr.message}`);
        }
      }

      await generateAndPush();

      const elapsed = Date.now() - startTime.valueOf();
      logger.info(`[SCHEDULER] === Daily job completed in ${elapsed}ms ===`);

      // Schedule the next fire.
      const delay = msUntilNextFire(hour);
      const nextFire = dayjs().tz(config.timezone).add(delay, 'millisecond');
      logger.info(`[SCHEDULER] Next run scheduled for ${nextFire.format('YYYY-MM-DD HH:mm:ss z')} (in ${Math.round(delay / 1000)}s)`);
      setTimeout(runOnce, delay);
    };

    // FR-023: Run immediately if the startup time is past today's fire time;
    // otherwise wait until the next fire time.
    const initialDelay = msUntilNextFire(hour);
    if (initialDelay === 0 || dayjs().tz(config.timezone).hour() >= hour) {
      // Past today's fire time — run immediately.
      logger.info('[SCHEDULER] Startup is past today\'s fire time — running immediately');
      await runOnce();
    } else {
      const nextFire = dayjs().tz(config.timezone).add(initialDelay, 'millisecond');
      logger.info(`[SCHEDULER] Waiting until ${nextFire.format('YYYY-MM-DD HH:mm:ss z')} for first run`);
      setTimeout(runOnce, initialDelay);
    }
  });

program
  .command('init')
  .description('Initialize the database and compute upcoming slots (no booking)')
  .action(async () => {
    const db = require('./db');
    const { computeBookingSlots } = require('./scheduler');
    const slots = computeBookingSlots();
    await db.ensureBookings(slots);
    console.log(`Initialized ${slots.length} booking slots in database.`);
    console.log('Run "npm run status" to see them, or "npm run book" to start booking.');
  });

program
  .command('cancel <date>')
  .description('Cancel all reservations for a specific date (YYYY-MM-DD)')
  .action(async (date) => {
    // Accept flexible date formats: YYYY-MM-DD, MM/DD, MM-DD
    const db = require('./db');
    const logger = require('./logger');
    const SiteAutomation = require('./site');
    const config = require('./config');

    // Normalize date input
    let normalizedDate = date;
    if (/^\d{1,2}[/-]\d{1,2}$/.test(date)) {
      // MM/DD or MM-DD — add current year
      const [m, d] = date.split(/[/-]/);
      const year = new Date().getFullYear();
      normalizedDate = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    } else if (/^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(date)) {
      // MM/DD/YYYY or MM-DD-YYYY
      const [m, d, y] = date.split(/[/-]/);
      normalizedDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
      console.error(`Invalid date format: "${date}". Use YYYY-MM-DD, MM/DD, or MM-DD.`);
      process.exit(1);
    }

    // Show what we're about to cancel
    const bookings = await db.getConfirmedByDate(normalizedDate);
    if (bookings.length === 0) {
      console.log(`No confirmed bookings in database for ${normalizedDate}.`);
      console.log('Will still check the golf site for reservations...\n');
    } else {
      console.log(`\nFound ${bookings.length} confirmed booking(s) for ${normalizedDate}:`);
      for (const b of bookings) {
        const time = b.actual_time || b.target_time;
        console.log(`  ${time} ${b.course} — Slot ${b.slot_index} (Res#${b.confirmation_number || '?'})`);
      }
      console.log('');
    }

    console.log(`Cancelling all reservations for ${normalizedDate}...\n`);

    const site = new SiteAutomation();
    try {
      await site.init();

      // Navigate to booking page first to trigger login
      await site.navigateToBooking(config.site.courses.pines.id, normalizedDate);
      await site.login();

      // Cancel reservations using their confirmation numbers
      // Filter to only bookings with real confirmation numbers (not "access", "EXISTING_RESERVATION", etc.)
      const cancelable = bookings.filter(b => b.confirmation_number && /^\d+$/.test(b.confirmation_number));
      if (cancelable.length === 0) {
        console.log('No bookings with valid confirmation numbers to cancel.');
        console.log('Bookings without proper reservation numbers cannot be cancelled automatically.');
        await site.close();
        return;
      }
      console.log(`${cancelable.length} booking(s) with valid confirmation numbers to cancel.\n`);

      const result = await site.cancelReservations(cancelable);

      console.log(`\nCancellation Results:`);
      console.log(`  Cancelled: ${result.cancelled}`);
      console.log(`  Failed: ${result.failed}`);
      for (const d of result.details) {
        const status = d.success ? 'CANCELLED' : `FAILED (${d.error})`;
        console.log(`  ${d.time} ${d.course} — ${status}`);
      }

      // Update DB for successfully cancelled bookings
      if (result.cancelled > 0) {
        let dbUpdated = 0;
        for (const detail of result.details) {
          if (!detail.success) continue;
          const match = bookings.find(b => b.confirmation_number === detail.resNum);
          if (match) {
            await db.markCancelled(match.id);
            dbUpdated++;
          }
        }
        if (dbUpdated > 0) {
          console.log(`\nUpdated ${dbUpdated} booking(s) in database to "cancelled".`);
        }
      }
    } catch (error) {
      console.error(`\nCancellation error: ${error.message}`);
      logger.error(`Cancel command error: ${error.message}`);
    } finally {
      await site.close();
    }
  });

program
  .command('web')
  .description('Start the calendar web view')
  .action(async () => {
    const { startServer } = require('./web');
    await startServer();
  });

program
  .command('sync')
  .description('Sync DB with FWB site reservation history')
  .action(async () => {
    const { runSync } = require('./sync');
    const result = await runSync();
    console.log('Sync complete:', JSON.stringify(result, null, 2));
    await generateAndPush();
    process.exit(0);
  });

program.parse();
