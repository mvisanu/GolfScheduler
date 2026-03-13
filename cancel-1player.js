/**
 * cancel-1player.js
 * One-time script: finds all upcoming reservations with only 1 player booked,
 * cancels them on the golf site, and marks them cancelled in the DB.
 *
 * Checks all golfer accounts configured in .env.
 *
 * Usage:  node cancel-1player.js
 */

require('dotenv').config();
const { execFile } = require('child_process');
const path = require('path');

const db = require('./src/db');
const SiteAutomation = require('./src/site');
const config = require('./src/config');

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[cancel-1player] ${msg}`);
}

/**
 * Navigate to reservation history, click each VIEW DETAILS card,
 * read the page body to extract player count, and return a list of
 * all reservations with their player count.
 *
 * Returns Array<{ date, time, course, confirmationNumber, players }>
 */
async function scrapeWithPlayerCount(site) {
  const baseUrl = config.site.memberUrl;
  const reservations = [];

  log('Navigating to /reservation/history ...');
  await site.page.goto(`${baseUrl}/reservation/history`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await site.page.waitForTimeout(3000);

  // Scroll to trigger any lazy-loaded cards
  await site.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await site.page.waitForTimeout(1500);
  await site.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await site.page.waitForTimeout(1000);

  // Wait for VIEW DETAILS buttons to appear
  try {
    await site.page.waitForFunction(
      () => /VIEW DETAILS|View Details/i.test(document.body.innerText || ''),
      { timeout: 10000, polling: 300 }
    );
  } catch {
    log('No VIEW DETAILS buttons found — no upcoming reservations');
    return reservations;
  }

  // Count cards
  const cardCount = await site.page.evaluate(() =>
    [...document.querySelectorAll('button')].filter(b => /view details/i.test(b.textContent || '')).length
  ).catch(() => 0);

  log(`Found ${cardCount} reservation card(s)`);

  for (let idx = 0; idx < cardCount; idx++) {
    // Click the Nth VIEW DETAILS button (idx-th, since each click navigates away and we go back)
    const clicked = await site.page.evaluate((skip) => {
      const btns = [...document.querySelectorAll('button')].filter(
        b => /view details/i.test(b.textContent || '')
      );
      if (btns.length <= skip) return false;
      btns[skip].click();
      return true;
    }, idx).catch(() => false);

    if (!clicked) {
      log(`Card ${idx + 1}: could not click VIEW DETAILS — skipping`);
      break;
    }

    await site.page.waitForTimeout(2000);

    // Wait for detail page to fully render before reading
    await site.page.waitForTimeout(1000);

    // Extract all relevant data from the detail page body
    const res = await site.page.evaluate((fb) => {
      const body = document.body.innerText || '';

      // Confirmation number from URL
      const urlMatch = window.location.href.match(/\/reservation\/history\/(\d+)/);
      const confirmationNumber = urlMatch ? urlMatch[1] : fb;

      // Time
      const timeMatch = body.match(/(\d{1,2}:\d{2})\s*(AM|PM)/i);
      let time24 = null;
      if (timeMatch) {
        let [, t, period] = timeMatch;
        let [h, m] = t.split(':').map(Number);
        if (period.toUpperCase() === 'PM' && h !== 12) h += 12;
        if (period.toUpperCase() === 'AM' && h === 12) h = 0;
        time24 = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      }

      // Date — look for YYYY-MM-DD, MM/DD/YYYY, or "Month Day, Year" etc.
      let dateStr = null;
      const isoMatch = body.match(/(\d{4}-\d{2}-\d{2})/);
      if (isoMatch) {
        dateStr = isoMatch[1];
      } else {
        // Try "Month DD, YYYY" or "Month D, YYYY"
        const months = { january:1, february:2, march:3, april:4, may:5, june:6,
                         july:7, august:8, september:9, october:10, november:11, december:12,
                         jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
        const longMatch = body.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2}),?\s+(\d{4})/i);
        if (longMatch) {
          const mon = months[longMatch[1].toLowerCase()];
          dateStr = `${longMatch[3]}-${String(mon).padStart(2,'0')}-${String(parseInt(longMatch[2])).padStart(2,'0')}`;
        }
      }

      // Course
      let course = 'Unknown';
      if (/pines/i.test(body)) course = 'Pines';
      else if (/oaks/i.test(body)) course = 'Oaks';

      // Player count — various patterns the site might use.
      // The TeeItUp detail page shows: "GOLFERS  1" (label + whitespace + count)
      let players = null;
      let playerSource = null;
      const playerPatterns = [
        // TeeItUp detail page: "GOLFERS  N" (N spaces, then digit)
        { re: /\bGOLFERS\s+(\d+)\b/,                                src: 'GOLFERS label' },
        // General: "N golfer(s)", "N player(s)"
        { re: /(\d+)\s*(?:player|golfer|person|spot)s?\b/i,          src: 'player/golfer' },
        { re: /\b(\d+)\s*x\s*(?:player|golfer)/i,                   src: 'NxPlayer' },
        { re: /qty[:\s]+(\d+)/i,                                     src: 'qty' },
        { re: /quantity[:\s]+(\d+)/i,                                src: 'quantity' },
        { re: /guests?[:\s]+(\d+)/i,                                 src: 'guests' },
        { re: /\bfor\s+(\d+)\s+(?:player|golfer|person)/i,          src: 'for N player' },
        { re: /\btickets?[:\s]+(\d+)/i,                              src: 'tickets' },
        { re: /(?:golfer|player|person)\s+count[:\s]+(\d+)/i,       src: 'count' },
        { re: /number\s+of\s+(?:golfers?|players?)[:\s]+(\d+)/i,    src: 'number of' },
        // Line like "1\nGolfer" or "4\nPlayers" in table format
        { re: /^(\d+)\s*\n\s*(?:golfer|player)/im,                  src: 'table-cell' },
      ];
      for (const { re, src } of playerPatterns) {
        const m = body.match(re);
        if (m) {
          players = parseInt(m[1], 10);
          playerSource = src;
          break;
        }
      }

      // Check if already cancelled on site
      const alreadyCancelled = /this reservation has been cancelled/i.test(body);

      return {
        date: dateStr,
        time: time24,
        course,
        confirmationNumber,
        players,
        playerSource,
        alreadyCancelled,
        bodySnippet: body.slice(0, 2000),
      };
    }, null);

    const cancelledTag = res.alreadyCancelled ? ' [ALREADY CANCELLED]' : '';
    const playerInfo = res.players !== null ? `${res.players} player(s) [via ${res.playerSource}]` : 'player count unknown';
    log(`  Card ${idx + 1}: ${res.date} ${res.time} ${res.course} Res#${res.confirmationNumber} — ${playerInfo}${cancelledTag}`);
    if (res.players === null && !res.alreadyCancelled) {
      log(`    [debug] Body (first 1000 chars): ${res.bodySnippet.replace(/\n/g, ' ').slice(0, 1000)}`);
    }

    if (res.date && res.time) {
      reservations.push({
        date: res.date,
        time: res.time,
        course: res.course,
        confirmationNumber: res.confirmationNumber,
        players: res.players,
        playerSource: res.playerSource,
        alreadyCancelled: res.alreadyCancelled,
        bodySnippet: res.bodySnippet,
      });
    } else {
      log(`  Card ${idx + 1}: could not extract date/time — skipping`);
    }

    // Go back to the list page
    await site.page.goBack({ waitUntil: 'domcontentloaded' }).catch(async () => {
      await site.page.goto(`${baseUrl}/reservation/history`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    });
    await site.page.waitForTimeout(1500);
    try {
      await site.page.waitForFunction(
        () => /VIEW DETAILS/i.test(document.body.innerText || ''),
        { timeout: 8000, polling: 300 }
      );
    } catch { /* ok if no more cards */ }
  }

  return reservations;
}

/**
 * Look up DB row(s) that match a given date+time (or confirmation number).
 * Returns all matching rows so the caller can mark them cancelled.
 */
async function findDbRows(date, time, confirmationNumber) {
  const sqlDb = await db.getDb();

  // Try by confirmation number first (most specific)
  if (confirmationNumber) {
    const byConf = await db.getDb().then(d => {
      const stmt = d.prepare(`SELECT * FROM bookings WHERE confirmation_number = $cn`);
      stmt.bind({ $cn: confirmationNumber });
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    });
    if (byConf.length > 0) return byConf;
  }

  // Fallback: match by date + time (actual_time or target_time)
  const stmt = sqlDb.prepare(`
    SELECT * FROM bookings
    WHERE date = $date AND (actual_time = $time OR target_time = $time)
  `);
  stmt.bind({ $date: date, $time: time });
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────

async function processGolfer(golfer, golferLabel) {
  log(`\n=== Processing ${golferLabel} (${golfer.email}) ===`);

  const site = new SiteAutomation({ email: golfer.email, password: golfer.password });
  const onePlayers = [];

  try {
    await site.init();

    // Navigate to booking page to trigger login
    await site.navigateToBooking(config.site.courses.pines.id, new Date().toISOString().slice(0, 10));
    await site.login();
    log('Logged in successfully');

    // Scrape all upcoming reservations with player counts
    const allReservations = await scrapeWithPlayerCount(site);

    log(`\nFound ${allReservations.length} total reservation(s) for ${golferLabel}`);

    if (allReservations.length === 0) {
      log('No reservations found — nothing to do');
      return { found: 0, cancelled: 0, dbUpdated: 0 };
    }

    // Show summary of all found
    for (const r of allReservations) {
      const cancelledTag = r.alreadyCancelled ? ' [ALREADY CANCELLED ON SITE]' : '';
      const playerStr = r.players !== null ? `${r.players} player(s) [via ${r.playerSource}]` : 'player count unknown';
      log(`  ${r.date} ${r.time} ${r.course} Res#${r.confirmationNumber} — ${playerStr}${cancelledTag}`);
    }

    // Find 1-player reservations (skip already-cancelled ones)
    for (const r of allReservations) {
      if (r.alreadyCancelled) continue;

      let is1Player = false;

      if (r.players === 1) {
        is1Player = true;
      } else if (r.players === null) {
        // Try harder: look for patterns in the body snippet that indicate 1 player
        const snip = r.bodySnippet || '';
        if (/\bGOLFERS\s+1\b/.test(snip) ||
            /\b1\s+(?:golfer|player|person|guest|spot|ticket)/i.test(snip) ||
            /(?:golfer|player|person|guest|qty|quantity)[:\s]+1\b/i.test(snip)) {
          is1Player = true;
          log(`  ** ${r.date} ${r.time}: inferred 1-player from body text`);
        }
      }

      if (is1Player) {
        log(`  ** 1-PLAYER RESERVATION: ${r.date} ${r.time} ${r.course} Res#${r.confirmationNumber}`);
        onePlayers.push(r);
      }
    }

    log(`\nFound ${onePlayers.length} 1-player reservation(s) to cancel`);

    if (onePlayers.length === 0) {
      log('No 1-player reservations found — nothing to cancel');
      return { found: allReservations.length, cancelled: 0, dbUpdated: 0 };
    }

    // Cancel each 1-player reservation on the site
    // Build booking-shaped objects that cancelReservations() expects
    const toCancel = onePlayers.map(r => ({
      confirmation_number: r.confirmationNumber,
      actual_time: r.time,
      target_time: r.time,
      course: r.course,
      date: r.date,
    }));

    log('\nCancelling on site...');
    const cancelResult = await site.cancelReservations(toCancel);

    log(`\nCancellation results:`);
    log(`  Cancelled: ${cancelResult.cancelled}`);
    log(`  Failed:    ${cancelResult.failed}`);
    for (const d of cancelResult.details) {
      const status = d.success ? 'CANCELLED' : `FAILED (${d.error})`;
      log(`  ${d.time} ${d.course} Res#${d.resNum} — ${status}`);
    }

    // Update DB for successfully cancelled bookings
    let dbUpdated = 0;
    for (const detail of cancelResult.details) {
      if (!detail.success) continue;

      // Find corresponding DB row(s)
      const origRes = onePlayers.find(r => r.confirmationNumber === detail.resNum);
      if (!origRes) continue;

      const rows = await findDbRows(origRes.date, origRes.time, origRes.confirmationNumber);
      if (rows.length === 0) {
        log(`  DB: no row found for ${origRes.date} ${origRes.time} Res#${origRes.confirmationNumber}`);
        continue;
      }

      for (const row of rows) {
        await db.markCancelled(row.id);
        log(`  DB: marked row ${row.id} (${origRes.date} ${origRes.time}) as cancelled`);
        dbUpdated++;
      }
    }

    return {
      found: allReservations.length,
      onePlayer: onePlayers.length,
      cancelled: cancelResult.cancelled,
      dbUpdated,
    };
  } finally {
    await site.close();
  }
}

async function main() {
  console.log('\n=== cancel-1player.js ===');
  console.log('Looking for 1-player tee time reservations to cancel...\n');

  const golfers = config.golfers;
  if (golfers.length === 0) {
    console.error('No golfer credentials configured. Check .env file.');
    process.exit(1);
  }

  log(`Configured golfers: ${golfers.length}`);
  for (let i = 0; i < golfers.length; i++) {
    log(`  Golfer ${i + 1}: ${golfers[i].email}`);
  }

  const summary = [];

  for (let i = 0; i < golfers.length; i++) {
    const result = await processGolfer(golfers[i], `Golfer ${i + 1}`);
    summary.push({ golfer: golfers[i].email, ...result });
  }

  console.log('\n=== SUMMARY ===');
  let totalCancelled = 0;
  let totalDbUpdated = 0;
  for (const s of summary) {
    console.log(`\n${s.golfer}:`);
    console.log(`  Reservations found:       ${s.found}`);
    console.log(`  1-player reservations:    ${s.onePlayer ?? 0}`);
    console.log(`  Cancelled on site:        ${s.cancelled ?? 0}`);
    console.log(`  DB rows marked cancelled: ${s.dbUpdated ?? 0}`);
    totalCancelled += s.cancelled ?? 0;
    totalDbUpdated += s.dbUpdated ?? 0;
  }
  console.log(`\nTotal cancelled: ${totalCancelled}`);
  console.log(`Total DB rows updated: ${totalDbUpdated}`);

  // Regenerate static site
  if (totalCancelled > 0) {
    console.log('\nRegenerating static site...');
    await new Promise((resolve) => {
      execFile(process.execPath, [path.join(__dirname, 'generate-static.js')], (err, stdout, stderr) => {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        if (err) console.error('generate-static.js error:', err.message);
        resolve();
      });
    });
    console.log('Done.');
  }

  console.log('\n=== cancel-1player.js complete ===\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
