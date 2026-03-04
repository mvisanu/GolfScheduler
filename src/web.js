const express = require('express');
const path = require('path');
const db = require('./db');
const config = require('./config');
const logger = require('./logger');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const http = require('http');
const https = require('https');
const fs = require('fs');
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3002;

// ── Access log store (persisted to data/access-log.json) ─────────────────────
const ACCESS_LOG_PATH = path.join(__dirname, '../data/access-log.json');
const ACCESS_LOG_MAX = 500;
let ACCESS_LOG = [];

// Load existing log from disk
try {
  if (fs.existsSync(ACCESS_LOG_PATH)) {
    ACCESS_LOG = JSON.parse(fs.readFileSync(ACCESS_LOG_PATH, 'utf8'));
  }
} catch { ACCESS_LOG = []; }

function saveAccessLog() {
  try { fs.writeFileSync(ACCESS_LOG_PATH, JSON.stringify(ACCESS_LOG, null, 2)); } catch {}
}

function parseUA(ua = '') {
  let browser = 'Unknown', os = 'Unknown', device = 'Desktop';
  if (/Mobile|Android|iPhone|iPad/.test(ua)) device = /iPad/.test(ua) ? 'Tablet' : 'Mobile';
  if (/Chrome\//.test(ua) && !/Chromium|Edg\/|OPR\//.test(ua)) browser = 'Chrome';
  else if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/MSIE|Trident/.test(ua)) browser = 'IE';
  if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return { browser, os, device };
}

function geoLookup(ip, entry) {
  http.get(`http://ip-api.com/json/${ip}?fields=country,countryCode,regionName,city,isp,org,timezone`, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try {
        const geo = JSON.parse(data);
        if (geo.country) {
          entry.country = geo.country;
          entry.countryCode = geo.countryCode;
          entry.region = geo.regionName;
          entry.city = geo.city;
          entry.isp = geo.isp;
          entry.org = geo.org;
          entry.geoTz = geo.timezone;
          saveAccessLog();
        }
      } catch {}
    });
  }).on('error', () => {});
}

function isLocalIP(ip) {
  return ip === '::1' || ip === '127.0.0.1' || ip?.startsWith('192.168.') || ip?.startsWith('10.') || ip?.startsWith('172.');
}

// Log all incoming external requests with full detail
app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (!isLocalIP(ip)) {
    const ua = req.headers['user-agent'] || '';
    const { browser, os, device } = parseUA(ua);
    const entry = {
      ts: new Date().toISOString(),
      ip,
      method: req.method,
      path: req.path,
      browser,
      os,
      device,
      ua,
      referrer: req.headers['referer'] || req.headers['referrer'] || '',
      country: '…', countryCode: '', region: '', city: '', isp: '', org: '', geoTz: '',
    };
    ACCESS_LOG.unshift(entry);
    if (ACCESS_LOG.length > ACCESS_LOG_MAX) ACCESS_LOG.pop();
    saveAccessLog();
    geoLookup(ip, entry);
    logger.info(`[ACCESS] ${ip} ${req.method} ${req.path} ${browser}/${os} ${device}`);
  }
  next();
});

// ── Tracking ping from GitLab Pages static site ──────────────────────────────
app.get('/api/ping', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '';
  const ref = req.query.ref || 'unknown';
  const page = req.query.page || '';
  if (!isLocalIP(ip)) {
    const { browser, os, device } = parseUA(ua);
    const entry = {
      ts: new Date().toISOString(), ip, method: 'GET', path: `/ping?ref=${ref}`,
      browser, os, device, ua, referrer: page,
      country: '…', countryCode: '', region: '', city: '', isp: '', org: '', geoTz: '',
    };
    ACCESS_LOG.unshift(entry);
    if (ACCESS_LOG.length > ACCESS_LOG_MAX) ACCESS_LOG.pop();
    saveAccessLog();
    geoLookup(ip, entry);
    logger.info(`[PING] ${ip} ref=${ref} ${browser}/${os} ${device}`);
  }
  res.status(204).end();
});

// TASK-021: Updated to return { bookings, lastSyncAt }
app.get('/api/bookings', async (req, res) => {
  const bookings = await db.getAllUpcoming();
  const lastSyncAt = db.getLastSyncAt();
  res.json({ bookings, lastSyncAt });
});

app.post('/api/cancel/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid ID' });

  const booking = await db.getBookingById(id);
  if (!booking) return res.status(404).json({ success: false, error: 'Booking not found' });
  if (booking.status === 'cancelled') return res.json({ success: true, message: 'Already cancelled' });

  const hasRealConfirmation = booking.confirmation_number && /^\d+$/.test(booking.confirmation_number);

  if (!hasRealConfirmation) {
    await db.markCancelled(id);
    return res.json({ success: true, message: 'Marked as cancelled' });
  }

  const SiteAutomation = require('./site');
  const site = new SiteAutomation();
  try {
    await site.init();
    await site.navigateToBooking(config.site.courses.pines.id, booking.date);
    await site.login();
    const result = await site.cancelReservations([booking]);
    if (result.cancelled > 0) {
      await db.markCancelled(id);
      res.json({ success: true, message: 'Cancelled on site' });
    } else {
      const detail = result.details[0];
      res.json({ success: false, error: detail?.error || 'Cancellation failed on site' });
    }
  } catch (error) {
    logger.error(`Cancel endpoint error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    await site.close();
  }
});

app.post('/api/book-month', (req, res) => {
  const { spawn } = require('child_process');
  const child = spawn('node', ['src/index.js', 'book'], {
    detached: true,
    stdio: 'ignore',
    cwd: path.join(__dirname, '..')
  });
  child.unref();
  res.json({ success: true, message: 'Booking run started' });
});

// ── Admin access log page (localhost only) ───────────────────────────────────
app.get('/admin', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (!isLocalIP(ip)) return res.status(403).send('Forbidden');

  const rows = ACCESS_LOG.map(e => `
    <tr>
      <td>${dayjs(e.ts).tz(config.timezone).format('YYYY-MM-DD HH:mm:ss')}</td>
      <td><span class="ip">${e.ip}</span></td>
      <td>${e.countryCode ? `<img src="https://flagcdn.com/16x12/${e.countryCode.toLowerCase()}.png" alt="${e.countryCode}" title="${e.country}"> ` : ''}${e.city || '…'}${e.region ? ', ' + e.region : ''}, ${e.country || '…'}</td>
      <td>${e.isp || '…'}</td>
      <td><span class="badge badge-${e.device.toLowerCase()}">${e.device}</span></td>
      <td>${e.browser}</td>
      <td>${e.os}</td>
      <td><span class="method method-${e.method}">${e.method}</span> ${e.path}</td>
      <td class="ua" title="${e.ua.replace(/"/g, '&quot;')}">${e.ua.substring(0, 60)}${e.ua.length > 60 ? '…' : ''}</td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Access Log — GolfScheduler Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Manrope:wght@700;800&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;background:#F8F9FA;color:#1A1A1A;font-size:0.88rem}
  header{background:#1B3A2D;color:#fff;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}
  header h1{font-family:'Manrope',sans-serif;font-size:1.3rem;font-weight:800}
  header span{font-size:0.8rem;opacity:0.75}
  .container{padding:20px 24px}
  .stats{display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap}
  .stat{background:#fff;border:1px solid #E5E7EB;border-radius:8px;padding:12px 20px;min-width:120px}
  .stat-label{font-size:0.75rem;color:#6B7280;text-transform:uppercase;letter-spacing:.04em}
  .stat-value{font-size:1.6rem;font-weight:700;font-family:'Manrope',sans-serif;color:#1B3A2D}
  .table-wrap{overflow-x:auto;background:#fff;border:1px solid #E5E7EB;border-radius:8px}
  table{width:100%;border-collapse:collapse;min-width:900px}
  th{background:#1B3A2D;color:#fff;padding:10px 12px;text-align:left;font-size:0.78rem;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
  td{padding:8px 12px;border-bottom:1px solid #F3F4F6;vertical-align:middle;white-space:nowrap}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#F0FDF4}
  .ip{font-family:monospace;font-size:0.85rem;background:#F3F4F6;padding:2px 6px;border-radius:4px}
  .badge{padding:2px 8px;border-radius:10px;font-size:0.75rem;font-weight:600;color:#fff}
  .badge-mobile{background:#7C3AED}
  .badge-tablet{background:#0891B2}
  .badge-desktop{background:#2D6A4F}
  .method{padding:2px 6px;border-radius:4px;font-size:0.75rem;font-weight:700;font-family:monospace}
  .method-GET{background:#DCFCE7;color:#166534}
  .method-POST{background:#DBEAFE;color:#1E40AF}
  .ua{max-width:200px;overflow:hidden;text-overflow:ellipsis;color:#6B7280;font-size:0.78rem}
  .empty{text-align:center;padding:40px;color:#6B7280}
  .refresh{font-size:0.8rem;color:#6B7280;margin-bottom:10px}
</style>
<script>setTimeout(()=>location.reload(),30000)</script>
</head><body>
<header>
  <h1>Access Log</h1>
  <span>fwbgaggle-schedule.duckdns.org — Admin Only</span>
</header>
<div class="container">
  <div class="stats">
    <div class="stat"><div class="stat-label">Total Visits</div><div class="stat-value">${ACCESS_LOG.length}</div></div>
    <div class="stat"><div class="stat-label">Unique IPs</div><div class="stat-value">${new Set(ACCESS_LOG.map(e=>e.ip)).size}</div></div>
    <div class="stat"><div class="stat-label">Mobile</div><div class="stat-value">${ACCESS_LOG.filter(e=>e.device==='Mobile').length}</div></div>
    <div class="stat"><div class="stat-label">Countries</div><div class="stat-value">${new Set(ACCESS_LOG.map(e=>e.countryCode).filter(Boolean)).size}</div></div>
  </div>
  <div class="refresh">Auto-refreshes every 30 seconds &nbsp;·&nbsp; Showing last ${ACCESS_LOG.length} of max ${ACCESS_LOG_MAX} entries</div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Time (CST)</th><th>IP Address</th><th>Location</th><th>ISP</th>
        <th>Device</th><th>Browser</th><th>OS</th><th>Request</th><th>User Agent</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="9" class="empty">No external visits yet</td></tr>'}</tbody>
    </table>
  </div>
</div>
</body></html>`);
});

app.get('/', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const isAdmin = ip === '::1' || ip === '127.0.0.1' || ip?.startsWith('192.168.') || ip?.startsWith('10.') || ip?.startsWith('172.');

  const bookings = await db.getAllUpcoming();

  // Group bookings by date
  const byDate = {};
  for (const b of bookings) {
    if (!byDate[b.date]) byDate[b.date] = [];
    byDate[b.date].push(b);
  }

  // Get current month info
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  // TASK-018: Format last sync timestamp
  const lastSyncAt = db.getLastSyncAt();
  let formattedSync = 'Never';
  if (lastSyncAt) {
    formattedSync = dayjs(lastSyncAt).tz(config.timezone).format('YYYY-MM-DD HH:mm');
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Golf Scheduler - Calendar</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Manrope:wght@600;700;800&display=swap" rel="stylesheet">
  <style>
    /* TASK-013: Design tokens */
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
    /* TASK-013: No horizontal overflow at 375px */
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg-page); color: var(--text-primary); line-height: 1.5; font-size: 16px; max-width: 100%; overflow-x: hidden; }
    img, table, .calendar { max-width: 100%; }

    .header { background: var(--bg-header); color: white; padding: 20px 30px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
    .header h1 { font-family: 'Manrope', sans-serif; font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; }
    .header .stats { font-size: 0.9rem; opacity: 0.9; }
    /* TASK-018: Last synced style */
    .last-sync { font-size: 0.8rem; opacity: 0.75; margin-top: 2px; }
    .container { max-width: 1200px; margin: 20px auto; padding: 0 20px; }
    .legend { display: flex; gap: 20px; margin-bottom: 20px; flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.875rem; }
    .legend-dot { width: 12px; height: 12px; border-radius: 3px; }
    .dot-confirmed { background: var(--accent-confirmed); }
    .dot-pending { background: var(--accent-pending); }
    .dot-failed { background: var(--accent-failed); }
    .dot-partial { background: var(--accent-failed); }
    .dot-empty { background: var(--border); }
    .calendar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; background: #ddd; border-radius: 8px; overflow: hidden; }
    .cal-header { background: var(--bg-header); color: white; padding: 10px; text-align: center; font-weight: 600; font-size: 0.875rem; }
    .cal-day { background: var(--bg-card); min-height: 120px; padding: 8px; position: relative; }
    .cal-day.empty { background: #f9fafb; }
    .cal-day.today { box-shadow: inset 0 0 0 2px var(--accent-action); }
    .day-num { font-weight: 600; font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 6px; }
    .booking-chip { display: block; padding: 3px 6px; margin-bottom: 3px; border-radius: 4px; font-size: 0.8rem; color: white; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
    .chip-confirmed { background: var(--accent-confirmed); }
    .chip-pending { background: var(--accent-pending); }
    .chip-failed { background: var(--accent-failed); }
    .chip-partial { background: var(--accent-failed); }
    .chip-skipped { background: var(--accent-cancelled); display: none; }
    .chip-cancelled { background: var(--text-secondary); text-decoration: line-through; }
    .month-nav { display: flex; align-items: center; gap: 15px; margin-bottom: 15px; flex-wrap: wrap; }
    .month-nav h2 { font-family: 'Manrope', sans-serif; font-size: 1.3rem; font-weight: 700; letter-spacing: -0.02em; }
    /* TASK-020: Use var(--accent-action) for nav buttons */
    .month-nav button { background: var(--accent-action); color: white; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 0.9rem; }
    .month-nav button:hover:not(:disabled) { background: #14291f; }
    .month-nav button:disabled { opacity: 0.7; cursor: not-allowed; }
    .month-nav button:focus-visible { outline: 2px solid var(--accent-confirmed); outline-offset: 2px; }
    .btn-schedule-month { margin-left: 8px; }
    /* TASK-017: Scrollable table wrapper */
    .table-scroll-wrapper { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .detail-table { width: 100%; border-collapse: collapse; margin-top: 20px; background: var(--bg-card); border-radius: 8px; overflow: hidden; }
    .detail-table th { background: var(--bg-header); color: white; padding: 10px 12px; text-align: left; font-size: 0.875rem; min-width: 80px; white-space: nowrap; }
    .detail-table td { padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 0.875rem; min-width: 80px; white-space: nowrap; }
    .detail-table tr[data-id] { cursor: pointer; }
    .detail-table tr[data-id]:hover { background: #f0fdf4; }
    .status-badge { padding: 2px 8px; border-radius: 10px; font-size: 0.8rem; color: white; }
    .badge-confirmed { background: var(--accent-confirmed); }
    .badge-pending { background: var(--accent-pending); }
    .badge-failed { background: var(--accent-failed); }
    .badge-partial { background: var(--accent-failed); }
    .badge-cancelled { background: var(--text-secondary); }
    /* Modal */
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; z-index: 1000; }
    .modal-overlay.open { display: flex; }
    /* TASK-019: ARIA roles added in HTML below */
    .modal-box { background: var(--bg-card); border-radius: 10px; padding: 28px; max-width: 420px; width: 90%; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
    .modal-title { font-family: 'Manrope', sans-serif; font-size: 1.1rem; font-weight: 700; margin-bottom: 16px; color: #111; letter-spacing: -0.01em; }
    .modal-grid { display: grid; grid-template-columns: 110px 1fr; gap: 6px 8px; font-size: 0.9rem; margin-bottom: 18px; }
    .modal-label { color: #666; font-weight: 500; }
    .modal-value { color: #222; font-weight: 600; }
    .modal-msg { font-size: 0.875rem; min-height: 20px; margin-bottom: 14px; }
    .modal-actions { display: flex; gap: 10px; justify-content: flex-end; }
    /* TASK-015: min-height 44px on modal buttons */
    .btn { border: none; padding: 9px 18px; border-radius: 5px; cursor: pointer; font-size: 0.9rem; font-weight: 600; min-height: 44px; }
    .btn-cancel-res { background: var(--accent-failed); color: white; }
    .btn-cancel-res:hover:not(:disabled) { background: #b91c1c; }
    .btn-cancel-res:disabled { background: var(--accent-cancelled); cursor: not-allowed; }
    .btn-close-modal { background: var(--border); color: #333; }
    .btn-close-modal:hover { background: #d1d5db; }
    .btn-cancel-row { background: var(--accent-failed); color: white; border: none; padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 0.8rem; font-weight: 600; }
    .btn-cancel-row:hover { background: #b91c1c; }
    /* Zoom widget transition */
    html { transition: font-size 0.15s ease; }

    /* TASK-014: Mobile booking list — hidden on desktop */
    .mobile-booking-list { display: none; }
    .mobile-booking-card {
      padding: 12px 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-card);
      margin-bottom: 8px;
    }
    .mobile-booking-card-date {
      font-family: 'Manrope', sans-serif;
      font-weight: 700;
      font-size: 1rem;
      color: var(--text-primary);
      margin-bottom: 8px;
    }
    /* TASK-014: 44px touch target on mobile chips */
    .mobile-booking-list .booking-chip {
      min-height: 44px;
      display: flex;
      align-items: center;
      padding: 10px 12px;
    }
    .mobile-cancel-btn {
      display: block;
      margin-top: 8px;
      background: var(--accent-failed);
      color: white;
      border: none;
      border-radius: 4px;
      padding: 10px 16px;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      min-height: 44px;
      width: 100%;
      text-align: center;
    }
    .mobile-cancel-btn:hover { background: #b91c1c; }

    /* TASK-014/016: Media queries */
    @media (max-width: 639px) {
      .calendar { display: none; }
      .mobile-booking-list { display: block; }
      /* TASK-016: Hide zoom widget on mobile */
      #zoom-control { display: none !important; }
      /* TASK-015: 44px touch targets on mobile interactive elements */
      .month-nav button,
      .btn-schedule-month,
      .btn-cancel-row {
        min-height: 44px;
        padding: 10px 16px;
      }
    }
    @media (min-width: 640px) {
      .mobile-booking-list { display: none; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Golf Scheduler - Fort Walton Beach</h1>
    <div>
      <div class="stats" id="header-stats">
        ${bookings.filter(b => b.status === 'confirmed').length} Confirmed |
        ${bookings.filter(b => b.status === 'pending').length} Pending |
        ${bookings.filter(b => b.status === 'failed').length} Failed |
        ${bookings.length} Total
      </div>
      <!-- TASK-018: Last synced timestamp -->
      <div class="last-sync" id="last-sync-display">Last synced: ${formattedSync}</div>
    </div>
  </div>
  <div class="container">
    <div class="legend">
      <div class="legend-item"><div class="legend-dot dot-confirmed"></div> Confirmed</div>
      <div class="legend-item"><div class="legend-dot dot-pending"></div> Pending</div>
      <div class="legend-item"><div class="legend-dot dot-failed"></div> Failed</div>
      <div class="legend-item"><div class="legend-dot dot-partial"></div> Partial</div>
    </div>

    ${generateCalendarHTML(year, month, byDate, 'Schedule Month', isAdmin)}
    ${generateCalendarHTML(month === 11 ? year + 1 : year, month === 11 ? 0 : month + 1, byDate, 'Book Now', isAdmin)}

    <h2 style="margin-top:30px; margin-bottom:10px; font-family:'Manrope',sans-serif; font-weight:700; letter-spacing:-0.02em;">All Bookings</h2>
    <!-- TASK-017: Wrap table in scroll wrapper -->
    <div class="table-scroll-wrapper">
      <table class="detail-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Day</th>
            <th>Target Time</th>
            <th>Actual Time</th>
            <th>Slot</th>
            <th>Course</th>
            <th>Status</th>
            <th>Confirmation</th>
            <th>Attempts</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${bookings.map(b => `
            <tr data-id="${b.id}" data-status="${b.status}" data-date="${b.date}" data-label="${b.day_label}"
                data-time="${b.actual_time || b.target_time}" data-course="${b.course}"
                data-confirmation="${b.confirmation_number || ''}"
                data-target-time="${b.target_time}" data-actual-time="${b.actual_time || ''}">
              <td>${b.date}</td>
              <td>${b.day_label}</td>
              <td>${b.target_time}</td>
              <td>${b.actual_time || '-'}</td>
              <td>${b.slot_index}</td>
              <td>${b.course}</td>
              <td><span class="status-badge badge-${b.status}">${b.status}</span></td>
              <td>${b.confirmation_number || '-'}</td>
              <td>${b.attempts}</td>
              <td>${isAdmin && ['confirmed','pending','failed'].includes(b.status) ? `<button class="btn-cancel-row" aria-label="Cancel reservation for ${b.date}" onclick="event.stopPropagation();openModal(this.closest('tr').dataset)">Cancel</button>` : ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  </div>

  <!-- TASK-015/016: Zoom widget with aria-labels; hidden on mobile via CSS -->
  <div id="zoom-control" style="position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;align-items:center;gap:8px;background:#1C1C1E;color:#FAFAF9;border-radius:999px;padding:8px 16px;font-family:monospace;font-size:14px;box-shadow:0 4px 24px rgba(0,0,0,0.3);user-select:none;">
    <button onclick="zoom(-1)" aria-label="Decrease text size" style="background:none;border:none;color:inherit;cursor:pointer;font-size:16px;">A−</button>
    <span id="zoom-label">100%</span>
    <button onclick="zoom(1)" aria-label="Increase text size" style="background:none;border:none;color:inherit;cursor:pointer;font-size:18px;">A+</button>
  </div>

  <!-- TASK-019: Modal with role="dialog", aria-modal, aria-labelledby -->
  <div class="modal-overlay" id="modal-overlay" onclick="if(event.target===this)closeModal()">
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="modal-title-id">
      <!-- TASK-019: id on modal title for aria-labelledby -->
      <div class="modal-title" id="modal-title-id">Booking Details</div>
      <div class="modal-grid">
        <span class="modal-label">Date</span>       <span class="modal-value" id="m-date"></span>
        <span class="modal-label">Day</span>        <span class="modal-value" id="m-label"></span>
        <span class="modal-label">Confirmed Time</span><span class="modal-value" id="m-confirmed-time"></span>
        <span class="modal-label">Target Time</span>  <span class="modal-value" id="m-target-time"></span>
        <span class="modal-label">Course</span>     <span class="modal-value" id="m-course"></span>
        <span class="modal-label">Status</span>     <span class="modal-value" id="m-status"></span>
        <span class="modal-label">Confirmation</span><span class="modal-value" id="m-confirmation"></span>
      </div>
      <div class="modal-msg" id="m-msg"></div>
      <div class="modal-actions">
        <!-- TASK-015: aria-label on close button -->
        <button class="btn btn-close-modal" id="btn-close-modal" aria-label="Close booking details" onclick="closeModal()">Close</button>
        ${isAdmin ? `<button class="btn btn-cancel-res" id="m-cancel-btn" onclick="cancelBooking()">Cancel Reservation</button>` : ''}
      </div>
    </div>
  </div>

  <script>
    let activeId = null;
    // TASK-019: Reference to element that triggered modal open
    let modalTriggerEl = null;

    function openModal(data, triggerEl) {
      activeId = data.id;
      // TASK-019: Save trigger element for focus restoration on close
      modalTriggerEl = triggerEl || document.activeElement || null;

      document.getElementById('m-date').textContent = data.date;
      document.getElementById('m-label').textContent = data.label;
      // TASK-019: data-actual-time maps to dataset.actualTime
      document.getElementById('m-confirmed-time').textContent = data.actualTime || '—';
      document.getElementById('m-target-time').textContent = data.targetTime;
      document.getElementById('m-course').textContent = data.course;
      document.getElementById('m-status').textContent = data.status;
      document.getElementById('m-confirmation').textContent = data.confirmation || '-';
      document.getElementById('m-msg').textContent = '';
      document.getElementById('m-msg').style.color = '#555';

      const canCancel = data.status === 'confirmed' || data.status === 'pending' || data.status === 'failed';
      const cancelBtn = document.getElementById('m-cancel-btn');
      cancelBtn.style.display = canCancel ? '' : 'none';
      cancelBtn.disabled = false;
      cancelBtn.textContent = 'Cancel Reservation';

      document.getElementById('modal-overlay').classList.add('open');

      // TASK-019: Move focus to first focusable element inside modal
      requestAnimationFrame(() => {
        const firstFocusable = getModalFocusables()[0];
        if (firstFocusable) firstFocusable.focus();
      });
    }

    function closeModal() {
      document.getElementById('modal-overlay').classList.remove('open');
      activeId = null;
      // TASK-019: Restore focus to trigger element
      if (modalTriggerEl && typeof modalTriggerEl.focus === 'function') {
        modalTriggerEl.focus();
      }
      modalTriggerEl = null;
    }

    // TASK-019: Get focusable elements inside modal in DOM order
    function getModalFocusables() {
      const modal = document.querySelector('.modal-box');
      const cancelBtn = document.getElementById('m-cancel-btn');
      const closeBtn = document.getElementById('btn-close-modal');
      const focusables = [];
      if (closeBtn) focusables.push(closeBtn);
      if (cancelBtn && cancelBtn.style.display !== 'none') focusables.push(cancelBtn);
      return focusables;
    }

    async function cancelBooking() {
      if (!activeId) return;
      const btn = document.getElementById('m-cancel-btn');
      const msg = document.getElementById('m-msg');
      btn.disabled = true;
      btn.textContent = 'Cancelling...';
      msg.textContent = 'Contacting golf site — this may take 30 seconds...';
      msg.style.color = '#888';

      try {
        const res = await fetch('/api/cancel/' + activeId, { method: 'POST' });
        const json = await res.json();
        if (json.success) {
          msg.textContent = 'Cancelled successfully. Reloading...';
          msg.style.color = '#22c55e';
          setTimeout(() => location.reload(), 1500);
        } else {
          msg.textContent = 'Error: ' + (json.error || 'Unknown error');
          msg.style.color = '#ef4444';
          btn.disabled = false;
          btn.textContent = 'Retry';
        }
      } catch (e) {
        msg.textContent = 'Network error — please try again.';
        msg.style.color = '#ef4444';
        btn.disabled = false;
        btn.textContent = 'Retry';
      }
    }

    // Calendar chips — pass chip element as trigger
    document.querySelectorAll('.booking-chip').forEach(chip => {
      chip.addEventListener('click', () => openModal(chip.dataset, chip));
    });

    // Detail table rows — pass row element as trigger
    document.querySelectorAll('.detail-table tr[data-id]').forEach(row => {
      row.addEventListener('click', () => openModal(row.dataset, row));
    });

    // Keyboard handling
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
      if (e.ctrlKey && e.key === '=') { e.preventDefault(); zoom(1); }
      if (e.ctrlKey && e.key === '-') { e.preventDefault(); zoom(-1); }
      if (e.ctrlKey && e.key === '0') { e.preventDefault(); baseSize = 16; applyZoom(); }

      // TASK-019: Tab trap inside modal
      if (e.key === 'Tab' && activeId !== null) {
        const focusables = getModalFocusables();
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
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

    async function scheduleMonth(btn) {
      const year = btn.dataset.year;
      const month = btn.dataset.month;
      const origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Starting...';
      try {
        const res = await fetch('/api/book-month', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ year, month })
        });
        const json = await res.json();
        if (json.success) {
          btn.textContent = 'Started!';
          btn.style.background = '#22c55e';
          setTimeout(() => {
            btn.textContent = origText;
            btn.style.background = '';
            btn.disabled = false;
          }, 4000);
        } else {
          btn.textContent = 'Error';
          btn.style.background = '#ef4444';
          setTimeout(() => { btn.textContent = origText; btn.style.background = ''; btn.disabled = false; }, 3000);
        }
      } catch (e) {
        btn.textContent = 'Error';
        btn.style.background = '#ef4444';
        setTimeout(() => { btn.textContent = origText; btn.style.background = ''; btn.disabled = false; }, 3000);
      }
    }

    // TASK-021: Auto-refresh every 60 seconds
    async function refreshChips() {
      // Do not refresh if a modal is open
      if (activeId !== null) return;

      let data;
      try {
        const res = await fetch('/api/bookings');
        data = await res.json();
      } catch (e) {
        return; // Network error — silently skip this cycle
      }

      const { bookings, lastSyncAt } = data;
      if (!Array.isArray(bookings)) return;

      // Build lookup by id
      const byId = {};
      for (const b of bookings) {
        byId[b.id] = b;
      }

      // Update existing chips in calendar and mobile list
      document.querySelectorAll('.booking-chip[data-id]').forEach(chip => {
        const id = chip.dataset.id;
        const b = byId[id];
        if (!b) return;
        const newStatus = b.status;
        const displayTime = b.actual_time || b.target_time;
        const course = b.course || 'Pines';

        // Update chip class if status changed
        const chipClasses = ['chip-confirmed','chip-pending','chip-failed','chip-partial','chip-skipped','chip-cancelled'];
        chipClasses.forEach(c => chip.classList.remove(c));
        chip.classList.add('chip-' + newStatus);

        // Update chip text
        chip.textContent = displayTime + ' ' + course;

        // Update dataset
        chip.dataset.status = newStatus;
        chip.dataset.time = displayTime;
        chip.dataset.actualTime = b.actual_time || '';
        chip.dataset.targetTime = b.target_time;

        // Show/hide skipped chips per original logic
        if (newStatus === 'skipped') {
          chip.style.display = 'none';
        } else {
          chip.style.display = '';
        }
      });

      // Update header stats
      const confirmed = bookings.filter(b => b.status === 'confirmed').length;
      const pending = bookings.filter(b => b.status === 'pending').length;
      const failed = bookings.filter(b => b.status === 'failed').length;
      const total = bookings.length;
      const statsEl = document.getElementById('header-stats');
      if (statsEl) {
        statsEl.textContent = confirmed + ' Confirmed | ' + pending + ' Pending | ' + failed + ' Failed | ' + total + ' Total';
      }

      // TASK-021: Update "Last synced" text if API returns lastSyncAt
      if (lastSyncAt) {
        const syncEl = document.getElementById('last-sync-display');
        if (syncEl) {
          // Format as YYYY-MM-DD HH:mm using local date string approximation
          const d = new Date(lastSyncAt);
          const formatted = d.toLocaleString('sv-SE', { timeZone: '${config.timezone}' }).replace('T', ' ').slice(0, 16);
          syncEl.textContent = 'Last synced: ' + formatted;
        }
      }
    }

    setInterval(refreshChips, 60000);
  </script>
</body>
</html>`);
});

// Long day names for mobile list headings
const LONG_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];

function generateCalendarHTML(year, month, byDate, buttonLabel = 'Schedule Month', isAdmin = false) {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  let html = `<div class="month-nav"><h2>${MONTH_NAMES[month]} ${year}</h2>${isAdmin ? `<button class="btn-schedule-month" data-year="${year}" data-month="${month}" onclick="scheduleMonth(this)">${buttonLabel}</button>` : ''}</div>`;

  // Desktop calendar grid
  html += '<div class="calendar">';

  // Day headers
  for (const day of dayNames) {
    html += `<div class="cal-header">${day}</div>`;
  }

  // Empty cells before first day
  for (let i = 0; i < firstDay; i++) {
    html += '<div class="cal-day empty"></div>';
  }

  // Days
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isToday = dateStr === todayStr;
    const dayBookings = byDate[dateStr] || [];

    html += `<div class="cal-day${isToday ? ' today' : ''}">`;
    html += `<div class="day-num">${d}</div>`;

    for (const b of dayBookings) {
      if (b.status === 'cancelled') continue;
      html += buildChipHTML(b, dateStr);
    }

    html += '</div>';
  }

  // Fill remaining cells
  const totalCells = firstDay + daysInMonth;
  const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let i = 0; i < remaining; i++) {
    html += '<div class="cal-day empty"></div>';
  }

  html += '</div>'; // end .calendar

  // TASK-014: Mobile booking list — only days with bookings
  html += '<div class="mobile-booking-list">';
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayBookings = (byDate[dateStr] || []).filter(b => b.status !== 'cancelled');
    if (dayBookings.length === 0) continue;

    const dayOfWeek = new Date(year, month, d).getDay();
    const longDayName = LONG_DAY_NAMES[dayOfWeek];
    const dateHeading = `${longDayName}, ${MONTH_NAMES[month]} ${d}`;

    html += '<div class="mobile-booking-card">';
    html += `<div class="mobile-booking-card-date">${dateHeading}</div>`;

    for (const b of dayBookings) {
      html += buildChipHTML(b, dateStr);
    }

    // TASK-020: Cancel button on mobile card for bookings that can be cancelled
    // Use the first cancellable booking on this day for the cancel action,
    // but render per-booking cancel buttons inline with each chip instead
    // (chips already have openModal via the click listener added in JS).
    // The spec says: "Add a Cancel button to each mobile booking card that calls openModal()
    // for that booking." Since there can be multiple bookings per card, we render one
    // cancel button per booking that is cancellable.
    const cancellableBookings = isAdmin ? dayBookings.filter(b => ['confirmed','pending','failed'].includes(b.status)) : [];
    for (const b of cancellableBookings) {
      const displayTime = b.actual_time || b.target_time;
      const course = b.course || 'Pines';
      // Build an inline data object string for openModal call
      const dataStr = JSON.stringify({
        id: String(b.id),
        status: b.status,
        date: dateStr,
        label: b.day_label,
        time: displayTime,
        course: course,
        confirmation: b.confirmation_number || '',
        targetTime: b.target_time,
        actualTime: b.actual_time || ''
      }).replace(/"/g, '&quot;');
      html += `<button class="mobile-cancel-btn" onclick="openModal(JSON.parse(this.dataset.booking), this)" data-booking="${dataStr}">Cancel ${displayTime} ${course}</button>`;
    }

    html += '</div>'; // end .mobile-booking-card
  }
  html += '</div>'; // end .mobile-booking-list

  return html;
}

// Helper: build a booking chip HTML string (shared by calendar and mobile list)
function buildChipHTML(b, dateStr) {
  const displayTime = b.actual_time || b.target_time;
  const course = b.course || 'Pines';
  const resNum = b.confirmation_number && !/^(EXISTING_RESERVATION|CONFIRMED|access)$/.test(b.confirmation_number) ? ` — Res #${b.confirmation_number}` : '';
  return `<div class="booking-chip chip-${b.status}"
      data-id="${b.id}" data-status="${b.status}" data-date="${dateStr}"
      data-label="${b.day_label}" data-time="${displayTime}" data-course="${course}"
      data-confirmation="${b.confirmation_number || ''}"
      data-target-time="${b.target_time}" data-actual-time="${b.actual_time || ''}"
      title="${b.day_label} — ${course}${resNum}">${displayTime} ${course}</div>`;
}

async function startServer() {
  await db.getDb(); // Initialize DB

  const certPath = path.join(__dirname, '../data/certs/cert.pem');
  const keyPath  = path.join(__dirname, '../data/certs/key.pem');

  const useHttps = process.env.HTTPS_ENABLED === 'true' && fs.existsSync(certPath) && fs.existsSync(keyPath);

  if (useHttps) {
    const creds = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    https.createServer(creds, app).listen(PORT, () => {
      logger.info(`Web view running at https://localhost:${PORT}`);
      console.log(`\nCalendar view: https://localhost:${PORT}\n`);
    });
  } else {
    app.listen(PORT, () => {
      logger.info(`Web view running at http://localhost:${PORT}`);
      console.log(`\nCalendar view: http://localhost:${PORT}\n`);
    });
  }
}

module.exports = { startServer };
