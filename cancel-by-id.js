// One-time script: cancel specific reservation IDs and reset DB rows for those dates.
// Uses site.cancelReservations() — the same MUI-aware flow used by cancel-1player.js.
require('dotenv').config();
const SiteAutomation = require('./src/site.js');
const config = require('./src/config.js');
const db = require('./src/db.js');

// Reservation IDs to cancel on the site
// Apr 4: 420241162 (already cancelled via cancel-1player.js, skip)
// Apr 12: 420247377, Apr 19: 420247538+420247606, Apr 26: 420247897 — all booked as 1-player before fix
const IDS_TO_CANCEL = [420247377, 420247538, 420247606, 420247897];

// DB dates to mark cancelled (all confirmed/pending rows on these dates)
const DATES_TO_RESET = ['2026-04-04', '2026-04-12', '2026-04-19', '2026-04-26'];

async function main() {
  const golfer = config.golfers[0];
  if (!golfer) {
    console.error('No golfer credentials configured. Check .env file.');
    process.exit(1);
  }

  console.log(`\n=== cancel-by-id.js ===`);
  console.log(`Golfer: ${golfer.email}`);
  console.log(`IDs to cancel: ${IDS_TO_CANCEL.join(', ')}`);

  const site = new SiteAutomation({ email: golfer.email, password: golfer.password });
  await site.init();

  // Login via booking page (required before cancelReservations can navigate)
  await site.navigateToBooking(config.site.courses.pines.id, new Date().toISOString().slice(0, 10));
  await site.login();
  console.log('Logged in.');

  // Build booking-shaped objects for cancelReservations()
  // Time and course are best-guesses from the known dates; the cancel page doesn't
  // use them for anything other than log labels.
  const toCancel = IDS_TO_CANCEL.map(id => ({
    confirmation_number: String(id),
    actual_time: '12:00',
    target_time: '12:00',
    course: 'Pines',
    date: null,
  }));

  console.log('\nCancelling on site via cancelReservations()...');
  const cancelResult = await site.cancelReservations(toCancel);

  await site.close();

  console.log(`\nCancellation results:`);
  console.log(`  Cancelled: ${cancelResult.cancelled}`);
  console.log(`  Failed:    ${cancelResult.failed}`);
  for (const d of cancelResult.details) {
    const status = d.success ? 'CANCELLED' : `FAILED (${d.error})`;
    console.log(`  Res#${d.resNum} — ${status}`);
  }

  // Mark DB rows as cancelled for the affected dates
  console.log('\nResetting DB rows for dates:', DATES_TO_RESET);
  const allDb = await db.getAllUpcoming();
  let dbUpdated = 0;
  for (const row of allDb) {
    if (DATES_TO_RESET.includes(row.date) && ['confirmed', 'pending'].includes(row.status)) {
      await db.markCancelled(row.id);
      console.log(`  DB: marked row ${row.id} (${row.date} slot ${row.slot_index}) as cancelled`);
      dbUpdated++;
    }
  }
  console.log(`DB rows updated: ${dbUpdated}`);

  if (cancelResult.cancelled > 0 || dbUpdated > 0) {
    console.log('\nRun "npm run init && HEADLESS=true npm run book" to rebook with 4 players.');
  }

  console.log('\n=== cancel-by-id.js complete ===\n');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
