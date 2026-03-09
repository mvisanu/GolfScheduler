#!/usr/bin/env node
/**
 * cancel-rebook.js
 *
 * 1. Logs into the golf site as the primary account (golfer 0 — all existing
 *    reservations were made under this account).
 * 2. Scrapes ALL upcoming reservations from 2026-03-16 onward.
 * 3. Cancels each one on the site.
 * 4. Closes the primary session.
 * 5. Runs BookingEngine, which creates per-golfer sessions and re-books
 *    every pending slot using the alternating golfer rotation.
 */

const SiteAutomation = require('./src/site');
const BookingEngine  = require('./src/booking');
const config         = require('./src/config');
const logger         = require('./src/logger');

const FROM_DATE = '2026-03-16';

async function scrapeAllReservations(site) {
  logger.info('Scraping all upcoming reservations from site...');
  const baseUrl = config.site.memberUrl;

  await site.page.goto(`${baseUrl}/reservation/history`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await site.page.waitForTimeout(3000);

  // Scroll several times to trigger lazy-loading of all cards
  for (let s = 0; s < 4; s++) {
    await site.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await site.page.waitForTimeout(1000);
  }

  // Wait for VIEW DETAILS buttons to appear
  try {
    await site.page.waitForFunction(
      () => /VIEW DETAILS|View Details/i.test(document.body.innerText || ''),
      { timeout: 10000, polling: 300 }
    );
  } catch { /* no cards */ }

  const reservations = [];
  const seen = new Set(); // dedup by confirmation number

  const cardCount = await site.page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .filter(b => /view details/i.test(b.textContent || '')).length
  ).catch(() => 0);

  logger.info(`Found ${cardCount} reservation card(s) on history page`);

  for (let idx = 0; idx < cardCount; idx++) {
    const clicked = await site.page.evaluate((skip) => {
      const btns = [...document.querySelectorAll('button')]
        .filter(b => /view details/i.test(b.textContent || ''));
      if (btns.length <= skip) return false;
      btns[skip].click();
      return true;
    }, idx).catch(() => false);

    if (!clicked) break;
    await site.page.waitForTimeout(2000);

    // Extract from detail page
    const res = await site.page.evaluate(() => {
      const body = document.body.innerText || '';
      const urlMatch = window.location.href.match(/\/reservation\/history\/(\d+)/);
      const confirmationNumber = urlMatch ? urlMatch[1] : null;

      const timeMatch = body.match(/(\d{1,2}:\d{2})\s*(AM|PM)/i);
      let time24 = null;
      if (timeMatch) {
        let [, t, period] = timeMatch;
        let [h, m] = t.split(':').map(Number);
        if (period.toUpperCase() === 'PM' && h !== 12) h += 12;
        if (period.toUpperCase() === 'AM' && h === 12) h = 0;
        time24 = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      }

      const dateMatch = body.match(
        /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(\w+)\s+(\d{1,2})(?:,?\s+(\d{4}))?/i
      );
      let dateStr = null;
      if (dateMatch) {
        const months = {
          January:1, February:2, March:3, April:4, May:5, June:6,
          July:7, August:8, September:9, October:10, November:11, December:12,
        };
        const month = months[dateMatch[1]];
        const day   = parseInt(dateMatch[2]);
        const year  = dateMatch[3] ? parseInt(dateMatch[3]) : new Date().getFullYear();
        if (month) {
          dateStr = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        }
      }

      let course = 'Unknown';
      if (/pines/i.test(body)) course = 'Pines';
      else if (/oaks/i.test(body)) course = 'Oaks';

      return { date: dateStr, time: time24, course, confirmationNumber };
    });

    if (res.date && res.time && res.confirmationNumber && !seen.has(res.confirmationNumber)) {
      seen.add(res.confirmationNumber);
      logger.info(`  [${idx + 1}/${cardCount}] ${res.date} ${res.time} ${res.course} Res#${res.confirmationNumber}`);
      reservations.push(res);
    } else if (seen.has(res.confirmationNumber)) {
      logger.debug(`  [${idx + 1}] Duplicate Res#${res.confirmationNumber} — skipping`);
    } else {
      logger.warn(`  [${idx + 1}] Could not extract (url=${site.page.url()})`);
    }

    // Return to list
    await site.page.goBack({ waitUntil: 'domcontentloaded' }).catch(async () => {
      await site.page.goto(`${baseUrl}/reservation/history`, {
        waitUntil: 'domcontentloaded', timeout: 20000,
      });
    });
    await site.page.waitForTimeout(1500);
    try {
      await site.page.waitForFunction(
        () => /VIEW DETAILS/i.test(document.body.innerText || ''),
        { timeout: 8000, polling: 300 }
      );
    } catch { /* ok */ }
  }

  return reservations;
}

async function main() {
  // ── Phase 1: Cancel all site reservations >= FROM_DATE (under golfer 0) ──
  logger.info(`=== Cancelling all reservations from ${FROM_DATE} onward ===`);

  const site = new SiteAutomation({ email: config.golfers[0].email, password: config.golfers[0].password });
  let cancelCount = 0;

  try {
    await site.init();
    await site.navigateToBooking(config.site.courses.pines.id, FROM_DATE);
    await site.login();

    const all = await scrapeAllReservations(site);
    const toCancel = all.filter(r =>
      r.date >= FROM_DATE && /^\d+$/.test(r.confirmationNumber)
    );

    console.log(`\nFound ${toCancel.length} reservation(s) to cancel from ${FROM_DATE}:`);
    for (const r of toCancel) {
      console.log(`  ${r.date} ${r.time} ${r.course}  Res#${r.confirmationNumber}`);
    }

    if (toCancel.length === 0) {
      console.log('Nothing to cancel — proceeding to booking.');
    } else {
      // Map to the format cancelReservations() expects
      const bookingsToCancel = toCancel.map(r => ({
        confirmation_number: r.confirmationNumber,
        actual_time: r.time,
        target_time: r.time,
        course: r.course,
      }));

      const result = await site.cancelReservations(bookingsToCancel);
      cancelCount = result.cancelled;
      console.log(`\nCancellation complete: ${result.cancelled} cancelled, ${result.failed} failed`);
      for (const d of result.details) {
        const status = d.success ? 'CANCELLED' : `FAILED (${d.error})`;
        console.log(`  ${d.time} ${d.course} Res#${d.resNum} — ${status}`);
      }
    }
  } finally {
    await site.close();
  }

  console.log(`\n=== Phase 1 done: ${cancelCount} reservation(s) cancelled ===\n`);

  // ── Phase 2: Re-book with alternating golfer rotation ─────────────────────
  console.log('=== Phase 2: Booking with alternating golfer rotation ===\n');
  const golfers = config.golfers;
  console.log('Golfer rotation:');
  for (let i = 0; i < golfers.length; i++) {
    console.log(`  Golfer ${i + 1}: ${golfers[i].email}`);
  }
  console.log();

  const engine = new BookingEngine();
  const stats  = await engine.run();

  console.log(`\n=== Booking complete ===`);
  console.log(`Total: ${stats.total}  Booked: ${stats.booked}  Failed: ${stats.failed}  Partial: ${stats.partial}`);
}

main().catch(err => {
  logger.error('cancel-rebook.js fatal error: ' + err.message);
  console.error(err);
  process.exit(1);
});
