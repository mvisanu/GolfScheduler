#!/usr/bin/env node
/**
 * fix-confirmations.js
 * Visits the golf site's Reservations page for each confirmed booking with a
 * missing or placeholder confirmation number and updates the DB with the real
 * reservation number.  Loops through ALL golfer accounts so that G2/G3
 * reservations are also resolved.
 */
const SiteAutomation = require('./src/site');
const db = require('./src/db');
const config = require('./src/config');

const PLACEHOLDER = ['EXISTING_RESERVATION', 'access', 'CONFIRMED'];

function isMissing(n) {
  return !n || PLACEHOLDER.includes(n) || !/^\d+$/.test(n);
}

function toMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

async function fixForGolfer(golferIndex, golfer, bookings) {
  const slots = bookings.filter(b => (b.golfer_index || 0) === golferIndex);
  if (slots.length === 0) {
    console.log(`\nGolfer ${golferIndex + 1} (${golfer.email}): no bookings needing fix — skipping`);
    return { updated: 0, notFound: 0 };
  }

  // Group by date
  const byDate = {};
  for (const b of slots) {
    if (!byDate[b.date]) byDate[b.date] = [];
    byDate[b.date].push(b);
  }

  console.log(`\nGolfer ${golferIndex + 1} (${golfer.email}): ${slots.length} booking(s) across ${Object.keys(byDate).length} date(s)`);
  for (const [date, s] of Object.entries(byDate)) {
    console.log(`  ${date}: ${s.map(b => b.actual_time || b.target_time).join(', ')}`);
  }

  const site = new SiteAutomation({ email: golfer.email, password: golfer.password });
  let updated = 0;
  let notFound = 0;

  try {
    await site.init();
    const firstDate = Object.keys(byDate)[0];
    await site.navigateToBooking(config.site.courses.pines.id, firstDate);
    await site.login();

    for (const [date, dateSlots] of Object.entries(byDate)) {
      console.log(`\n  Checking reservations for ${date}...`);
      try {
        const reservations = await site.getExistingReservations(date);
        console.log(`    Found ${reservations.length} reservation(s) on site:`);
        for (const r of reservations) {
          console.log(`      ${r.time} ${r.course} — res#${r.reservationNumber || 'N/A'}`);
        }

        for (const slot of dateSlots) {
          const slotMin = toMinutes(slot.actual_time || slot.target_time);
          const match = reservations.find(r => Math.abs(toMinutes(r.time) - slotMin) <= 20);
          if (match && match.reservationNumber && /^\d+$/.test(match.reservationNumber)) {
            console.log(`    ✓ Slot ${slot.actual_time || slot.target_time} → Res #${match.reservationNumber}`);
            await db.markSuccess(slot.id, {
              actualTime: match.time,
              course: match.course || slot.course,
              confirmationNumber: match.reservationNumber,
              screenshotPath: slot.screenshot_path,
            });
            updated++;
          } else {
            console.log(`    ✗ No match for slot ${slot.actual_time || slot.target_time}`);
            notFound++;
          }
        }
      } catch (err) {
        console.error(`    Error checking ${date}: ${err.message}`);
        notFound += dateSlots.length;
      }
    }
  } finally {
    await site.close();
  }

  return { updated, notFound };
}

async function main() {
  await db.getDb();
  const all = await db.getAllUpcoming();

  const needsFix = all.filter(b => b.status === 'confirmed' && isMissing(b.confirmation_number));
  if (needsFix.length === 0) {
    console.log('All confirmed bookings already have real confirmation numbers.');
    return;
  }

  console.log(`Found ${needsFix.length} booking(s) needing real confirmation numbers.\n`);

  let totalUpdated = 0;
  let totalNotFound = 0;

  for (let i = 0; i < config.golfers.length; i++) {
    const { updated, notFound } = await fixForGolfer(i, config.golfers[i], needsFix);
    totalUpdated += updated;
    totalNotFound += notFound;
  }

  console.log(`\nDone. Updated: ${totalUpdated} | Not found: ${totalNotFound}`);
  if (totalNotFound > 0) {
    console.log('(Not-found slots may be beyond the ~7-day site display window — the daily sync will pick them up as dates approach.)');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
