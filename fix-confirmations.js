#!/usr/bin/env node
/**
 * fix-confirmations.js
 * Visits the golf site's Reservations page for each date with a missing or
 * placeholder confirmation number (EXISTING_RESERVATION, "access", etc.) and
 * updates the DB with the real reservation number.
 */
const SiteAutomation = require('./src/site');
const db = require('./src/db');
const config = require('./src/config');
const logger = require('./src/logger');

const PLACEHOLDER = ['EXISTING_RESERVATION', 'access', 'CONFIRMED'];

function isMissing(n) {
  return !n || PLACEHOLDER.includes(n) || !/^\d+$/.test(n);
}

function toMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

async function main() {
  await db.getDb();
  const all = await db.getAllUpcoming();

  // Find confirmed bookings with placeholder/missing confirmation numbers
  const needsFix = all.filter(b => b.status === 'confirmed' && isMissing(b.confirmation_number));
  if (needsFix.length === 0) {
    console.log('All confirmed bookings already have real confirmation numbers.');
    return;
  }

  // Group by date
  const byDate = {};
  for (const b of needsFix) {
    if (!byDate[b.date]) byDate[b.date] = [];
    byDate[b.date].push(b);
  }

  console.log(`Found ${needsFix.length} booking(s) across ${Object.keys(byDate).length} date(s) needing confirmation numbers:\n`);
  for (const [date, slots] of Object.entries(byDate)) {
    console.log(`  ${date}: ${slots.map(s => s.actual_time || s.target_time).join(', ')}`);
  }
  console.log('');

  const site = new SiteAutomation();
  let updated = 0;
  let notFound = 0;

  try {
    await site.init();

    // Login once
    const firstDate = Object.keys(byDate)[0];
    await site.navigateToBooking(config.site.courses.pines.id, firstDate);
    await site.login();

    for (const [date, slots] of Object.entries(byDate)) {
      console.log(`\nChecking reservations for ${date}...`);
      try {
        const reservations = await site.getExistingReservations(date);
        console.log(`  Found ${reservations.length} reservation(s) on site for ${date}:`);
        for (const r of reservations) {
          console.log(`    ${r.time} ${r.course} — res#${r.reservationNumber || 'N/A'}`);
        }

        for (const slot of slots) {
          const slotMin = toMinutes(slot.actual_time || slot.target_time);
          // Match by time ±20 min
          const match = reservations.find(r => Math.abs(toMinutes(r.time) - slotMin) <= 20);
          if (match && match.reservationNumber && /^\d+$/.test(match.reservationNumber)) {
            console.log(`  ✓ Slot ${slot.actual_time || slot.target_time} → Res #${match.reservationNumber}`);
            await db.markSuccess(slot.id, {
              actualTime: match.time,
              course: match.course || slot.course,
              confirmationNumber: match.reservationNumber,
              screenshotPath: slot.screenshot_path,
            });
            updated++;
          } else {
            console.log(`  ✗ No match found for slot ${slot.actual_time || slot.target_time}`);
            notFound++;
          }
        }
      } catch (err) {
        console.error(`  Error checking ${date}: ${err.message}`);
        notFound += slots.length;
      }
    }
  } finally {
    await site.close();
  }

  console.log(`\nDone. Updated: ${updated} | Not found: ${notFound}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
