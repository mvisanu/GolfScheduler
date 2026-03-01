#!/usr/bin/env node
const { program } = require('commander');

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
  .description('Run continuously, checking every 6 hours')
  .action(async () => {
    const BookingEngine = require('./booking');
    const logger = require('./logger');
    const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

    logger.info('Scheduler mode started — will run every 6 hours');
    logger.info('Press Ctrl+C to stop');

    const runOnce = async () => {
      try {
        const engine = new BookingEngine();
        await engine.run();
      } catch (err) {
        logger.error(`Scheduler run error: ${err.message}`);
      }
    };

    // Run immediately
    await runOnce();

    // Then repeat
    setInterval(runOnce, INTERVAL_MS);
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
  .command('web')
  .description('Start the calendar web view')
  .action(async () => {
    const { startServer } = require('./web');
    await startServer();
  });

program.parse();
