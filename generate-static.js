/**
 * generate-static.js
 * Reads the local DB and generates public/index.html for GitLab Pages deployment.
 *
 * Usage:
 *   npm run generate           # generates public/index.html
 *   git add public/index.html && git commit -m "Update schedule" && git push
 *
 * Visitor tracking: set PING_URL in .env to your Express server's /api/ping
 * endpoint (must be HTTPS). Visits will appear in http://localhost:3002/admin
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const db   = require('./src/db');
const dayjs = require('dayjs');
const utc  = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const { execSync } = require('child_process');

const TZ       = process.env.TIMEZONE || 'America/Chicago';
const PING_URL = process.env.PING_URL || ''; // e.g. https://fwbgaggle-schedule.duckdns.org:3002/api/ping

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
const DAY_SHORT   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DAY_LONG    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function buildChip(b) {
  if (b.status === 'cancelled' || b.status === 'skipped') return '';
  const time   = b.actual_time || b.target_time;
  const course = b.course || 'Pines';
  return `<div class="booking-chip chip-${b.status}" title="${b.day_label}">${time} ${course}</div>`;
}

function calendarGrid(year, month, byDate) {
  const today    = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const first    = new Date(year, month, 1).getDay();
  const days     = new Date(year, month+1, 0).getDate();

  let html = `
<div class="month-section">
  <div class="month-nav"><h2>${MONTH_NAMES[month]} ${year}</h2></div>
  <div class="calendar">`;

  DAY_SHORT.forEach(d => { html += `<div class="cal-header">${d}</div>`; });

  for (let i = 0; i < first; i++) html += `<div class="cal-day empty"></div>`;

  for (let d = 1; d <= days; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = dateStr === todayStr;
    const slots   = (byDate[dateStr] || []).filter(b => b.status !== 'cancelled' && b.status !== 'skipped');
    html += `<div class="cal-day${isToday ? ' today' : ''}"><div class="day-num">${d}</div>`;
    slots.forEach(b => { html += buildChip(b); });
    html += `</div>`;
  }

  html += `</div></div>`;
  return html;
}

function mobileList(year, month, byDate) {
  const days = new Date(year, month+1, 0).getDate();
  let html = `<div class="mobile-booking-list">`;
  for (let d = 1; d <= days; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const slots   = (byDate[dateStr] || []).filter(b => b.status !== 'cancelled' && b.status !== 'skipped');
    if (!slots.length) continue;
    const dow = new Date(year, month, d).getDay();
    html += `<div class="mobile-booking-card">
      <div class="mobile-booking-card-date">${DAY_LONG[dow]}, ${MONTH_NAMES[month]} ${d}</div>`;
    slots.forEach(b => { html += buildChip(b); });
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

async function main() {
  await db.getDb();
  const bookings   = await db.getAllUpcoming();
  const lastSyncAt = db.getLastSyncAt();
  const now        = dayjs().tz(TZ);

  const formattedSync    = lastSyncAt ? dayjs(lastSyncAt).tz(TZ).format('MMM D, YYYY h:mm A') : 'Never';
  const formattedUpdated = now.format('MMM D, YYYY h:mm A');

  const byDate = {};
  for (const b of bookings) {
    if (!byDate[b.date]) byDate[b.date] = [];
    byDate[b.date].push(b);
  }

  const year  = now.year();
  const month = now.month(); // 0-indexed
  const nextYear  = month === 11 ? year + 1 : year;
  const nextMonth = month === 11 ? 0 : month + 1;

  const confirmed = bookings.filter(b => b.status === 'confirmed').length;
  const pending   = bookings.filter(b => b.status === 'pending').length;
  const failed    = bookings.filter(b => b.status === 'failed').length;

  const trackingSnippet = PING_URL ? `
  <script>
    try {
      fetch(${JSON.stringify(PING_URL)} + '?ref=gitlab&page=' + encodeURIComponent(location.href), { mode: 'no-cors' });
    } catch(e) {}
  </script>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FWB Golf Schedule</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Manrope:wght@600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-page: #F8F9FA;
      --bg-card: #FFFFFF;
      --bg-header: #1B3A2D;
      --text-primary: #1A1A1A;
      --text-secondary: #6B7280;
      --accent-confirmed: #2D6A4F;
      --accent-pending: #B45309;
      --accent-failed: #DC2626;
      --accent-cancelled: #9CA3AF;
      --accent-action: #1B3A2D;
      --border: #E5E7EB;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', -apple-system, sans-serif; background: var(--bg-page); color: var(--text-primary); line-height: 1.5; font-size: 16px; overflow-x: hidden; }
    .header { background: var(--bg-header); color: white; padding: 20px 30px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
    .header h1 { font-family: 'Manrope', sans-serif; font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; }
    .header .stats { font-size: 0.9rem; opacity: 0.9; }
    .last-sync { font-size: 0.8rem; opacity: 0.75; margin-top: 2px; }
    .container { max-width: 1200px; margin: 20px auto; padding: 0 20px; }
    .legend { display: flex; gap: 20px; margin-bottom: 20px; flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.875rem; }
    .legend-dot { width: 12px; height: 12px; border-radius: 3px; }
    .dot-confirmed { background: var(--accent-confirmed); }
    .dot-pending { background: var(--accent-pending); }
    .dot-failed { background: var(--accent-failed); }
    .month-section { margin-bottom: 30px; }
    .month-nav { margin-bottom: 15px; }
    .month-nav h2 { font-family: 'Manrope', sans-serif; font-size: 1.3rem; font-weight: 700; letter-spacing: -0.02em; }
    .calendar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; background: #ddd; border-radius: 8px; overflow: hidden; }
    .cal-header { background: var(--bg-header); color: white; padding: 10px; text-align: center; font-weight: 600; font-size: 0.875rem; }
    .cal-day { background: var(--bg-card); min-height: 120px; padding: 8px; }
    .cal-day.empty { background: #f9fafb; }
    .cal-day.today { box-shadow: inset 0 0 0 2px var(--accent-action); }
    .day-num { font-weight: 600; font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 6px; }
    .booking-chip { display: block; padding: 3px 6px; margin-bottom: 3px; border-radius: 4px; font-size: 0.8rem; color: white; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chip-confirmed { background: var(--accent-confirmed); }
    .chip-pending { background: var(--accent-pending); }
    .chip-failed { background: var(--accent-failed); }
    .chip-partial { background: var(--accent-failed); }
    .mobile-booking-list { display: none; }
    .mobile-booking-card { padding: 12px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-card); margin-bottom: 8px; }
    .mobile-booking-card-date { font-family: 'Manrope', sans-serif; font-weight: 700; font-size: 1rem; margin-bottom: 8px; }
    .mobile-booking-list .booking-chip { min-height: 44px; display: flex; align-items: center; padding: 10px 12px; }
    .footer { text-align: center; padding: 20px; color: var(--text-secondary); font-size: 0.8rem; margin-top: 20px; }
    @media (max-width: 639px) {
      .calendar { display: none; }
      .mobile-booking-list { display: block; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>⛳ FWB Golf Schedule</h1>
    <div>
      <div class="stats">${confirmed} Confirmed &nbsp;|&nbsp; ${pending} Pending &nbsp;|&nbsp; ${failed} Failed</div>
      <div class="last-sync">Last synced: ${formattedSync}</div>
    </div>
  </div>
  <div class="container">
    <div class="legend">
      <div class="legend-item"><div class="legend-dot dot-confirmed"></div> Confirmed</div>
      <div class="legend-item"><div class="legend-dot dot-pending"></div> Pending</div>
      <div class="legend-item"><div class="legend-dot dot-failed"></div> Failed</div>
    </div>

    ${calendarGrid(year, month, byDate)}
    ${mobileList(year, month, byDate)}

    ${calendarGrid(nextYear, nextMonth, byDate)}
    ${mobileList(nextYear, nextMonth, byDate)}

  </div>
  <div class="footer">Updated ${formattedUpdated} CST &nbsp;·&nbsp; Fort Walton Beach Golf</div>
  ${trackingSnippet}
</body>
</html>`;

  fs.mkdirSync(path.join(__dirname, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'docs/index.html'), html);
  console.log(`Generated docs/index.html (${confirmed} confirmed, ${pending} pending, ${failed} failed)`);

  // Auto-push to GitHub Pages
  try {
    execSync('git add docs/index.html', { cwd: __dirname, stdio: 'pipe' });
    execSync('git diff --cached --quiet docs/index.html', { cwd: __dirname, stdio: 'pipe' });
    console.log('No changes to push — schedule unchanged.');
  } catch {
    // diff returned non-zero = there are staged changes, commit and push
    try {
      execSync('git commit -m "Update schedule"', { cwd: __dirname, stdio: 'pipe' });
      execSync('git push origin master', { cwd: __dirname, stdio: 'pipe' });
      console.log('Pushed updated schedule to GitHub Pages.');
    } catch (pushErr) {
      console.warn('Warning: could not push to GitHub:', pushErr.message);
    }
  }

  setTimeout(() => process.exit(0), 200);
}

main().catch(err => { console.error(err); setTimeout(() => process.exit(1), 200); });
