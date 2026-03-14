/**
 * cancel-and-rebook.js
 * One-time script: cancels all site-confirmed bookings from 2026-03-16 onwards
 * on the golf site, then purges those DB rows so the booking engine can
 * pick them up fresh (with the 4-golfer-only requirement).
 *
 * Usage:  node cancel-and-rebook.js
 * Then:   npm run init && npm run book
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./src/db');
const SiteAutomation = require('./src/site');
const config = require('./src/config');

const FROM_DATE = '2026-03-16';

async function main() {
  console.log(`\n=== Batch cancel + DB purge from ${FROM_DATE} onwards ===\n`);

  // 1. Collect all confirmed bookings from FROM_DATE+ with real numeric confirmation numbers
  const allUpcoming = await db.getAllUpcoming();
  const toCancel = allUpcoming.filter(b =>
    b.date >= FROM_DATE &&
    b.status === 'confirmed' &&
    b.confirmation_number &&
    /^\d+$/.test(b.confirmation_number)
  );

  console.log(`Found ${toCancel.length} site-confirmed booking(s) to cancel:`);
  for (const b of toCancel) {
    console.log(`  ${b.date} ${b.actual_time || b.target_time} ${b.course} — Res#${b.confirmation_number}`);
  }

  if (toCancel.length > 0) {
    const site = new SiteAutomation();
    try {
      await site.init();
      // Login
      await site.navigateToBooking(config.site.courses.pines.id, FROM_DATE);
      await site.login();

      const result = await site.cancelReservations(toCancel);

      console.log(`\nCancellation results:`);
      console.log(`  Cancelled: ${result.cancelled}`);
      console.log(`  Failed:    ${result.failed}`);
      for (const d of result.details) {
        const status = d.success ? 'CANCELLED' : `FAILED (${d.error})`;
        console.log(`  ${d.time} ${d.course} Res#${d.resNum} — ${status}`);
      }

      // Mark cancelled in DB
      for (const detail of result.details) {
        if (!detail.success) continue;
        const match = toCancel.find(b => b.confirmation_number === detail.resNum);
        if (match) await db.markCancelled(match.id);
      }
    } finally {
      await site.close();
    }
  }

  // 2. Purge ALL rows from FROM_DATE onwards from the DB (pending, failed, skipped, cancelled, placeholder-confirmed)
  console.log(`\nPurging all DB rows for ${FROM_DATE}+ ...`);
  const sqlDb = await db.getDb();
  sqlDb.run(`DELETE FROM bookings WHERE date >= '${FROM_DATE}'`);

  // Persist the DB to disk
  const data = sqlDb.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(config.dbPath, buffer);
  console.log('DB purge complete.');

  console.log('\nDone. Now run:');
  console.log('  npm run init   — repopulate DB with fresh pending slots');
  console.log('  npm run book   — book with 4-golfer requirement\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
