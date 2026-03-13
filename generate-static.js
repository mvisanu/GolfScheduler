/**
 * generate-static.js
 * Reads the local DB and generates docs/index.html for GitHub Pages deployment.
 *
 * Usage:
 *   node generate-static.js
 *
 * The output matches the local Express server design (src/web.js) but is a
 * static snapshot: no admin buttons, no cancel, no auto-refresh.
 * Golfer identity is anonymised (Golfer 1 / Golfer 2, no email addresses).
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const db   = require('./src/db');
const dayjs = require('dayjs');
const utc  = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { generateCalendarHTML, MONTH_NAMES } = require('./src/render');

dayjs.extend(utc);
dayjs.extend(timezone);

const { execSync } = require('child_process');

const TZ       = process.env.TIMEZONE || 'America/Chicago';
const PING_URL = process.env.PING_URL || ''; // e.g. https://fwbgaggle-schedule.duckdns.org/api/ping

async function main() {
  await db.getDb();
  const bookings   = await db.getAllUpcoming();
  const lastSyncAt = db.getLastSyncAt();
  const now        = dayjs().tz(TZ);

  const formattedSync    = lastSyncAt ? dayjs(lastSyncAt).tz(TZ).format('YYYY-MM-DD HH:mm') : 'Never';
  const formattedUpdated = now.format('MMM D, YYYY h:mm A');

  // Group by date (skip slot_index 0 to match the Express server)
  const byDate = {};
  for (const b of bookings) {
    if (b.slot_index === 0) continue;
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

  // Determine max golfer_index from bookings to build anonymised GOLFERS array
  const maxGolferIdx = bookings.reduce((mx, b) => Math.max(mx, b.golfer_index || 0), 0);
  const golfersJson = JSON.stringify(
    Array.from({ length: maxGolferIdx + 1 }, (_, i) => ({ index: i, label: `Golfer ${i + 1}`, email: '' }))
  );

  const trackingSnippet = PING_URL ? `
  <script>
    try {
      fetch(${JSON.stringify(PING_URL)} + '?ref=github&page=' + encodeURIComponent(location.href), { mode: 'no-cors' });
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
    /* shadcn/ui-inspired design tokens */
    :root {
      --background:         #f9fafb;
      --card:               #ffffff;
      --card-foreground:    #111827;
      --primary:            #14532d;
      --primary-hover:      #0f3d21;
      --primary-foreground: #ffffff;
      --secondary:          #f3f4f6;
      --secondary-foreground:#374151;
      --muted:              #f3f4f6;
      --muted-foreground:   #6b7280;
      --accent:             #f0fdf4;
      --border:             #e5e7eb;
      --ring:               #14532d;
      --radius:             0.625rem;
      --radius-sm:          0.375rem;
      --shadow-sm:          0 1px 3px rgba(0,0,0,0.07), 0 1px 2px rgba(0,0,0,0.05);
      --shadow-md:          0 4px 6px rgba(0,0,0,0.07), 0 2px 4px rgba(0,0,0,0.05);
      --shadow-xl:          0 20px 48px rgba(0,0,0,0.18), 0 8px 16px rgba(0,0,0,0.08);

      /* Status colours */
      --status-confirmed:   #15803d;
      --status-confirmed-bg:#dcfce7;
      --status-pending:     #b45309;
      --status-pending-bg:  #fef3c7;
      --status-failed:      #dc2626;
      --status-failed-bg:   #fee2e2;
      --status-cancelled:   #6b7280;
      --status-cancelled-bg:#f3f4f6;
      --status-partial:     #dc2626;
      --status-partial-bg:  #fee2e2;

      --font-sans:    'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-display: 'Manrope', sans-serif;
    }

    /* Reset */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { transition: font-size 0.15s ease; }
    body {
      font-family: var(--font-sans);
      background: var(--background);
      color: var(--card-foreground);
      line-height: 1.5;
      font-size: 16px;
      max-width: 100%;
      overflow-x: hidden;
    }

    /* ── Site header ─────────────────────────────────────────────── */
    .site-header {
      background: var(--primary);
      color: var(--primary-foreground);
      padding: 18px 28px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      box-shadow: var(--shadow-md);
    }
    .site-header h1 {
      font-family: var(--font-display);
      font-size: 1.45rem;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .header-right { text-align: right; }
    .header-stats {
      font-size: 0.875rem;
      font-weight: 500;
      opacity: 0.92;
    }
    .header-sync {
      font-size: 0.75rem;
      opacity: 0.68;
      margin-top: 3px;
    }

    /* ── Page container ─────────────────────────────────────────── */
    .container { max-width: 1200px; margin: 24px auto; padding: 0 20px; }

    /* ── Legend ─────────────────────────────────────────────────── */
    .legend {
      display: flex;
      gap: 16px;
      margin-bottom: 20px;
      flex-wrap: wrap;
      align-items: center;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.8rem;
      color: var(--muted-foreground);
      font-weight: 500;
    }
    .legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 3px;
    }
    .dot-confirmed { background: var(--status-confirmed); }

    /* ── Month navigation ───────────────────────────────────────── */
    .month-nav {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .month-nav h2 {
      font-family: var(--font-display);
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--card-foreground);
    }

    /* ── Calendar grid ──────────────────────────────────────────── */
    .calendar-section { margin-bottom: 32px; }
    .calendar {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: var(--shadow-sm);
      background: var(--border); /* gap colour */
      gap: 1px;
    }
    .cal-header {
      background: var(--primary);
      color: var(--primary-foreground);
      padding: 8px 4px;
      text-align: center;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .cal-day {
      background: var(--card);
      min-height: 110px;
      padding: 8px;
      position: relative;
      transition: background 0.1s;
    }
    .cal-day.empty { background: var(--muted); }
    .cal-day.today { box-shadow: inset 0 0 0 2px var(--primary); }
    .day-num {
      font-weight: 600;
      font-size: 0.82rem;
      color: var(--muted-foreground);
      margin-bottom: 5px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
    }
    .cal-day.today .day-num {
      background: var(--primary);
      color: var(--primary-foreground);
    }

    /* ── Booking chips (shadcn Badge-inspired) ──────────────────── */
    .booking-chip {
      display: block;
      padding: 3px 8px;
      margin-bottom: 3px;
      border-radius: 9999px;
      font-size: 0.72rem;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;
      transition: filter 0.12s, opacity 0.12s;
    }
    .booking-chip:hover { filter: brightness(0.9); }
    .chip-confirmed  { background: var(--status-confirmed-bg);  color: var(--status-confirmed); }
    .chip-pending    { background: var(--status-pending-bg);    color: var(--status-pending); }
    .chip-failed     { background: var(--status-failed-bg);     color: var(--status-failed); }
    .chip-partial    { background: var(--status-partial-bg);    color: var(--status-partial); }
    .chip-skipped    { display: none; }
    .chip-cancelled  { background: var(--status-cancelled-bg);  color: var(--status-cancelled); text-decoration: line-through; }

    /* ── Modal (shadcn Dialog) ──────────────────────────────────── */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.45);
      backdrop-filter: blur(2px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 16px;
    }
    .modal-overlay.open { display: flex; }
    .modal-box {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 28px;
      max-width: 440px;
      width: 100%;
      box-shadow: var(--shadow-xl);
      position: relative;
    }
    .modal-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 20px;
      gap: 12px;
    }
    .modal-title {
      font-family: var(--font-display);
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--card-foreground);
      letter-spacing: -0.01em;
      line-height: 1.3;
    }
    .modal-close-x {
      flex-shrink: 0;
      background: none;
      border: none;
      cursor: pointer;
      color: var(--muted-foreground);
      font-size: 1.1rem;
      line-height: 1;
      padding: 2px;
      border-radius: var(--radius-sm);
      transition: color 0.1s, background 0.1s;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
    }
    .modal-close-x:hover { color: var(--card-foreground); background: var(--secondary); }
    /* Separator line under modal header */
    .modal-separator {
      height: 1px;
      background: var(--border);
      margin: 0 -28px 20px;
    }
    .modal-grid {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 8px 12px;
      font-size: 0.875rem;
      margin-bottom: 20px;
    }
    .modal-label { color: var(--muted-foreground); font-weight: 500; }
    .modal-value { color: var(--card-foreground); font-weight: 600; }
    .modal-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      padding-top: 4px;
    }
    /* shadcn Button variants */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      padding: 9px 20px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 600;
      font-family: var(--font-sans);
      min-height: 44px;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
    }
    /* Secondary/outline */
    .btn-close-modal {
      background: var(--secondary);
      color: var(--secondary-foreground);
      border: 1px solid var(--border);
    }
    .btn-close-modal:hover { background: var(--border); }
    .btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }

    /* ── Mobile booking list ────────────────────────────────────── */
    .mobile-booking-list { display: none; }
    .mobile-booking-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 16px;
      margin-bottom: 10px;
      box-shadow: var(--shadow-sm);
    }
    .mobile-booking-card-date {
      font-family: var(--font-display);
      font-weight: 700;
      font-size: 0.95rem;
      color: var(--card-foreground);
      margin-bottom: 10px;
    }
    .mobile-booking-list .booking-chip {
      min-height: 44px;
      display: flex;
      align-items: center;
      padding: 10px 14px;
      border-radius: var(--radius-sm);
    }

    /* ── Zoom widget ────────────────────────────────────────────── */
    #zoom-control {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 9999;
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--card-foreground);
      color: var(--primary-foreground);
      border-radius: 9999px;
      padding: 8px 16px;
      font-family: monospace;
      font-size: 13px;
      box-shadow: var(--shadow-xl);
      user-select: none;
      border: 1px solid rgba(255,255,255,0.08);
    }
    #zoom-control button {
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      font-size: 15px;
      padding: 2px 4px;
      border-radius: 4px;
      transition: background 0.1s;
    }
    #zoom-control button:hover { background: rgba(255,255,255,0.12); }

    /* ── Responsive ─────────────────────────────────────────────── */
    @media (max-width: 639px) {
      .calendar { display: none; }
      .mobile-booking-list { display: block; }
      #zoom-control { display: none !important; }
    }
    @media (min-width: 640px) {
      .mobile-booking-list { display: none; }
    }
  </style>
</head>
<body>
  <header class="site-header">
    <h1>&#9971; FWB Golf Schedule</h1>
    <div class="header-right">
      <div class="header-stats">${confirmed} Confirmed</div>
      <div class="header-sync">Last synced: ${formattedSync}</div>
    </div>
  </header>
  <div class="container">
    <div class="legend">
      <div class="legend-item"><div class="legend-dot dot-confirmed"></div> Confirmed</div>
    </div>

    <div class="calendar-section">${generateCalendarHTML(year, month, byDate, '', false)}</div>
    <div class="calendar-section">${generateCalendarHTML(nextYear, nextMonth, byDate, '', false)}</div>

  </div>
  <div style="text-align:center;padding:20px;color:var(--muted-foreground);font-size:0.8rem;margin-top:4px;">
    Updated ${formattedUpdated} CST &nbsp;&middot;&nbsp; Fort Walton Beach Golf
  </div>

  <!-- Zoom widget; hidden on mobile via CSS -->
  <div id="zoom-control">
    <button onclick="zoom(-1)" aria-label="Decrease text size">A&minus;</button>
    <span id="zoom-label">100%</span>
    <button onclick="zoom(1)" aria-label="Increase text size">A+</button>
  </div>

  <!-- Booking detail modal -->
  <div class="modal-overlay" id="modal-overlay" onclick="if(event.target===this)closeModal()">
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="modal-title-id">
      <div class="modal-header">
        <div class="modal-title" id="modal-title-id">Booking Details</div>
        <button class="modal-close-x" onclick="closeModal()" aria-label="Close booking details">&times;</button>
      </div>
      <div class="modal-separator"></div>
      <div class="modal-grid">
        <span class="modal-label">Date</span>            <span class="modal-value" id="m-date"></span>
        <span class="modal-label">Day</span>             <span class="modal-value" id="m-label"></span>
        <span class="modal-label">Confirmed Time</span>  <span class="modal-value" id="m-confirmed-time"></span>
        <span class="modal-label">Target Time</span>     <span class="modal-value" id="m-target-time"></span>
        <span class="modal-label">Course</span>          <span class="modal-value" id="m-course"></span>
        <span class="modal-label">Players</span>         <span class="modal-value" id="m-players"></span>
        <span class="modal-label">Booked by</span>       <span class="modal-value" id="m-golfer"></span>
        <span class="modal-label">Status</span>          <span class="modal-value" id="m-status"></span>
        <span class="modal-label">Confirmation</span>    <span class="modal-value" id="m-confirmation"></span>
      </div>
      <div class="modal-actions">
        <button class="btn btn-close-modal" id="btn-close-modal" aria-label="Close booking details" onclick="closeModal()">Close</button>
      </div>
    </div>
  </div>

  <script>
    // Anonymised golfer list — no email addresses in the public static page
    const GOLFERS = ${golfersJson};
    function golferLabel(idx) {
      const g = GOLFERS[parseInt(idx) || 0];
      return g ? g.label : ('Golfer ' + ((parseInt(idx) || 0) + 1));
    }

    let activeId = null;
    let modalTriggerEl = null;

    function openModal(data, triggerEl) {
      activeId = data.id;
      modalTriggerEl = triggerEl || document.activeElement || null;

      document.getElementById('m-date').textContent = data.date;
      document.getElementById('m-label').textContent = data.label;
      document.getElementById('m-confirmed-time').textContent = data.actualTime || '\u2014';
      document.getElementById('m-target-time').textContent = data.targetTime;
      document.getElementById('m-course').textContent = data.course;
      document.getElementById('m-players').textContent = data.players ? (data.players + ' players') : '4 players';
      document.getElementById('m-golfer').textContent = golferLabel(data.golfer);
      document.getElementById('m-status').textContent = data.status;
      const conf = data.confirmation;
      const isReal = conf && /^\d+$/.test(conf);
      document.getElementById('m-confirmation').textContent = isReal ? conf : '\u2014';

      document.getElementById('modal-overlay').classList.add('open');

      requestAnimationFrame(() => {
        const closeBtn = document.getElementById('btn-close-modal');
        if (closeBtn) closeBtn.focus();
      });
    }

    function closeModal() {
      document.getElementById('modal-overlay').classList.remove('open');
      activeId = null;
      if (modalTriggerEl && typeof modalTriggerEl.focus === 'function') {
        modalTriggerEl.focus();
      }
      modalTriggerEl = null;
    }

    // Calendar chips
    document.querySelectorAll('.booking-chip').forEach(chip => {
      chip.addEventListener('click', (e) => { e.stopPropagation(); openModal(chip.dataset, chip); });
    });

    // Keyboard handling
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
      if (e.ctrlKey && e.key === '=') { e.preventDefault(); zoom(1); }
      if (e.ctrlKey && e.key === '-') { e.preventDefault(); zoom(-1); }
      if (e.ctrlKey && e.key === '0') { e.preventDefault(); baseSize = 16; applyZoom(); }

      // Tab trap inside modal
      if (e.key === 'Tab' && activeId !== null) {
        const closeBtn = document.getElementById('btn-close-modal');
        if (closeBtn) {
          e.preventDefault();
          closeBtn.focus();
        }
      }
    });

    // Zoom widget
    let baseSize = parseInt(localStorage.getItem('zoomSize') || 16);
    function applyZoom() {
      document.documentElement.style.fontSize = baseSize + 'px';
      document.getElementById('zoom-label').textContent = Math.round((baseSize / 16) * 100) + '%';
      localStorage.setItem('zoomSize', baseSize);
    }
    function zoom(dir) {
      baseSize = Math.min(24, Math.max(12, baseSize + dir * 2));
      applyZoom();
    }
    applyZoom();
  </script>
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
