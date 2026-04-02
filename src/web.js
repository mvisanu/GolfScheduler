const express = require('express');
const path = require('path');
const db = require('./db');
const config = require('./config');
const logger = require('./logger');
const { LONG_DAY_NAMES, MONTH_NAMES, isRealConfirmed, buildChipHTML, generateCalendarHTML } = require('./render');
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
const PORT = process.env.PORT || 3009;

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
  if (!ip) return false;
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
  // RFC 1918: 172.16.0.0/12 covers 172.16.x.x through 172.31.x.x only
  const m = ip.match(/^172\.(\d+)\./);
  if (m) {
    const second = parseInt(m[1], 10);
    return second >= 16 && second <= 31;
  }
  return false;
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
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: 'Invalid ID' });

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

app.post('/api/book-day', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (!isLocalIP(ip)) return res.status(403).json({ success: false, error: 'Forbidden' });

  const { date, targetTime, course, slots } = req.body;
  if (!date || !targetTime || !course) return res.status(400).json({ success: false, error: 'Missing fields' });

  const numSlots = Math.max(1, Math.min(5, parseInt(slots) || 1));
  const [h, m] = targetTime.split(':').map(Number);

  const toTime = (totalMin) => {
    const hh = Math.floor(Math.abs(totalMin) / 60).toString().padStart(2, '0');
    const mm = (Math.abs(totalMin) % 60).toString().padStart(2, '0');
    return `${hh}:${mm}`;
  };

  const dayOfWeek = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const windowStart = toTime(h * 60 + m - 30);
  const windowEnd = toTime(h * 60 + m + 60);

  const bookingsList = [];
  for (let i = 0; i < numSlots; i++) {
    const slotMin = h * 60 + m + i * 10;
    bookingsList.push({
      date,
      dayLabel: `${dayOfWeek} Custom`,
      targetTime: toTime(slotMin),
      windowStart,
      windowEnd,
      course,
      slotIndex: i,
      players: 4,
    });
  }

  try {
    await db.ensureBookings(bookingsList);
  } catch (err) {
    logger.error(`book-day DB error: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }

  const { spawn } = require('child_process');
  const child = spawn('node', ['src/index.js', 'book'], {
    detached: true,
    stdio: 'ignore',
    cwd: path.join(__dirname, '..')
  });
  child.unref();

  logger.info(`[WEB] book-day: ${date} ${targetTime} ${course} x${numSlots}`);
  res.json({ success: true, message: `${numSlots} slot(s) queued for ${date} — booking started` });
});

// ── Admin access log page (localhost only) ───────────────────────────────────
app.get('/admin', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (!isLocalIP(ip)) return res.status(403).send('Forbidden');

  const rows = ACCESS_LOG.map(e => `
    <tr>
      <td>${dayjs(e.ts).tz(config.timezone).format('YYYY-MM-DD HH:mm:ss')}</td>
      <td><span class="ip-chip">${e.ip}</span></td>
      <td>${e.countryCode ? `<img src="https://flagcdn.com/16x12/${e.countryCode.toLowerCase()}.png" alt="${e.countryCode}" title="${e.country}"> ` : ''}${e.city || '…'}${e.region ? ', ' + e.region : ''}, ${e.country || '…'}</td>
      <td>${e.isp || '…'}</td>
      <td><span class="badge badge-device-${e.device.toLowerCase()}">${e.device}</span></td>
      <td>${e.browser}</td>
      <td>${e.os}</td>
      <td><span class="badge badge-method-${e.method.toLowerCase()}">${e.method}</span> ${e.path}</td>
      <td class="ua-cell" title="${e.ua.replace(/"/g, '&quot;')}">${e.ua.substring(0, 60)}${e.ua.length > 60 ? '…' : ''}</td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Access Log — GolfScheduler Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Manrope:wght@700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --background: #f9fafb;
    --card: #ffffff;
    --card-foreground: #111827;
    --primary: #14532d;
    --primary-foreground: #ffffff;
    --secondary: #f3f4f6;
    --secondary-foreground: #374151;
    --muted: #f3f4f6;
    --muted-foreground: #6b7280;
    --border: #e5e7eb;
    --ring: #14532d;
    --radius: 0.625rem;
    --destructive: #dc2626;
    --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    --font-display: 'Manrope', sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--font-sans);background:var(--background);color:var(--card-foreground);font-size:0.875rem;line-height:1.5}
  /* Header */
  .site-header{background:var(--primary);color:var(--primary-foreground);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px}
  .site-header h1{font-family:var(--font-display);font-size:1.25rem;font-weight:800;letter-spacing:-0.02em}
  .site-header .header-meta{font-size:0.78rem;opacity:0.75;text-align:right}
  /* Container */
  .container{padding:24px;max-width:1400px;margin:0 auto}
  /* Stats grid */
  .stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:20px}
  .stat-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px;box-shadow:0 1px 3px rgba(0,0,0,0.06)}
  .stat-label{font-size:0.72rem;font-weight:600;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
  .stat-value{font-size:1.75rem;font-weight:800;font-family:var(--font-display);color:var(--primary);line-height:1}
  /* Refresh notice */
  .refresh-notice{font-size:0.78rem;color:var(--muted-foreground);margin-bottom:14px;padding:8px 12px;background:var(--muted);border-radius:calc(var(--radius) - 2px);display:inline-block}
  /* Table card */
  .table-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06)}
  .table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
  table{width:100%;border-collapse:collapse;min-width:900px}
  thead tr{background:var(--primary)}
  thead th{color:var(--primary-foreground);padding:10px 14px;text-align:left;font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;border-bottom:1px solid rgba(255,255,255,0.1)}
  tbody tr{border-bottom:1px solid var(--border);transition:background 0.1s}
  tbody tr:last-child{border-bottom:none}
  tbody tr:hover{background:#f0fdf4}
  td{padding:9px 14px;vertical-align:middle;white-space:nowrap;font-size:0.82rem}
  /* Inline badges */
  .badge{display:inline-flex;align-items:center;padding:2px 9px;border-radius:9999px;font-size:0.72rem;font-weight:600;white-space:nowrap}
  .badge-device-mobile{background:#f3e8ff;color:#6b21a8}
  .badge-device-tablet{background:#e0f2fe;color:#0369a1}
  .badge-device-desktop{background:#dcfce7;color:#15803d}
  .badge-method-get{background:#dcfce7;color:#166534;font-family:monospace}
  .badge-method-post{background:#dbeafe;color:#1e40af;font-family:monospace}
  .badge-method-other{background:var(--muted);color:var(--muted-foreground);font-family:monospace}
  /* IP chip */
  .ip-chip{font-family:monospace;font-size:0.8rem;background:var(--secondary);color:var(--secondary-foreground);padding:2px 7px;border-radius:4px;border:1px solid var(--border)}
  /* UA truncated */
  .ua-cell{max-width:200px;overflow:hidden;text-overflow:ellipsis;color:var(--muted-foreground);font-size:0.75rem}
  .empty-row td{text-align:center;padding:48px;color:var(--muted-foreground);font-size:0.9rem}
</style>
<script>setTimeout(()=>location.reload(),30000)</script>
</head><body>
<header class="site-header">
  <h1>Access Log</h1>
  <div class="header-meta">fwbgaggle-schedule.duckdns.org &mdash; Admin Only</div>
</header>
<div class="container">
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-label">Total Visits</div><div class="stat-value">${ACCESS_LOG.length}</div></div>
    <div class="stat-card"><div class="stat-label">Unique IPs</div><div class="stat-value">${new Set(ACCESS_LOG.map(e=>e.ip)).size}</div></div>
    <div class="stat-card"><div class="stat-label">Mobile</div><div class="stat-value">${ACCESS_LOG.filter(e=>e.device==='Mobile').length}</div></div>
    <div class="stat-card"><div class="stat-label">Countries</div><div class="stat-value">${new Set(ACCESS_LOG.map(e=>e.countryCode).filter(Boolean)).size}</div></div>
  </div>
  <div class="refresh-notice">Auto-refreshes every 30 s &nbsp;&middot;&nbsp; Showing last ${ACCESS_LOG.length} of max ${ACCESS_LOG_MAX} entries</div>
  <div class="table-card">
    <div class="table-scroll">
      <table>
        <thead><tr>
          <th>Time (CST)</th><th>IP Address</th><th>Location</th><th>ISP</th>
          <th>Device</th><th>Browser</th><th>OS</th><th>Request</th><th>User Agent</th>
        </tr></thead>
        <tbody>${rows || '<tr class="empty-row"><td colspan="9">No external visits yet</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</div>
</body></html>`);
});

app.get('/', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const isAdmin = isLocalIP(ip);

  const bookings = await db.getAllUpcoming();

  // Group bookings by date — all slot_index values included (slot 0 is a valid tee time)
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
    /* shadcn Button — default variant */
    .btn-schedule-month {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--primary);
      color: var(--primary-foreground);
      border: none;
      padding: 7px 16px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 600;
      font-family: var(--font-sans);
      line-height: 1;
      transition: background 0.15s;
      box-shadow: var(--shadow-sm);
    }
    .btn-schedule-month:hover:not(:disabled) { background: var(--primary-hover); }
    .btn-schedule-month:disabled { opacity: 0.6; cursor: not-allowed; }
    .btn-schedule-month:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }

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
    .cal-day:not(.empty) { cursor: pointer; }
    .cal-day:not(.empty):hover { background: var(--accent); }
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

    /* ── All Bookings section heading ───────────────────────────── */
    .section-heading {
      font-family: var(--font-display);
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--card-foreground);
      margin: 28px 0 12px;
    }

    /* ── Detail table (shadcn Table) ────────────────────────────── */
    .table-scroll-wrapper { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .detail-table-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: var(--shadow-sm);
    }
    .detail-table {
      width: 100%;
      table-layout: fixed;
      border-collapse: collapse;
    }
    .detail-table thead tr { background: var(--secondary); border-bottom: 1px solid var(--border); }
    .detail-table th {
      padding: 10px 12px;
      text-align: left;
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .detail-table td {
      padding: 9px 12px;
      border-bottom: 1px solid var(--border);
      font-size: 0.8rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--card-foreground);
    }
    .detail-table tbody tr:last-child td { border-bottom: none; }
    .detail-table tr[data-id] { cursor: pointer; transition: background 0.1s; }
    .detail-table tr[data-id]:hover { background: var(--accent); }

    /* Status badges */
    .status-badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 9999px;
      font-size: 0.72rem;
      font-weight: 600;
      white-space: nowrap;
    }
    .badge-confirmed { background: var(--status-confirmed-bg); color: var(--status-confirmed); }
    .badge-pending   { background: var(--status-pending-bg);   color: var(--status-pending); }
    .badge-failed    { background: var(--status-failed-bg);    color: var(--status-failed); }
    .badge-partial   { background: var(--status-partial-bg);   color: var(--status-partial); }
    .badge-cancelled { background: var(--status-cancelled-bg); color: var(--status-cancelled); }
    .badge-skipped   { background: var(--status-cancelled-bg); color: var(--status-cancelled); }

    /* Cancel row button — destructive variant */
    .btn-cancel-row {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      color: var(--status-failed);
      border: 1px solid var(--status-failed);
      padding: 3px 10px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 0.75rem;
      font-weight: 600;
      font-family: var(--font-sans);
      transition: background 0.12s, color 0.12s;
    }
    .btn-cancel-row:hover {
      background: var(--status-failed);
      color: white;
    }

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
    .modal-msg {
      font-size: 0.82rem;
      min-height: 20px;
      margin-bottom: 16px;
      padding: 8px 12px;
      border-radius: var(--radius-sm);
      background: transparent;
    }
    .modal-msg:not(:empty) { background: var(--muted); }
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
    /* Destructive */
    .btn-cancel-res {
      background: var(--status-failed);
      color: white;
    }
    .btn-cancel-res:hover:not(:disabled) { background: #b91c1c; }
    .btn-cancel-res:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }

    /* ── Book-day modal form ─────────────────────────────────────── */
    .bd-form-row { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
    .bd-label {
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--card-foreground);
    }
    /* shadcn Input/Select look */
    .bd-select {
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 0.875rem;
      font-family: var(--font-sans);
      background: var(--card);
      color: var(--card-foreground);
      width: 100%;
      outline: none;
      transition: border-color 0.12s, box-shadow 0.12s;
    }
    .bd-select:focus {
      border-color: var(--ring);
      box-shadow: 0 0 0 2px rgba(20,83,45,0.12);
    }
    .bd-date-display {
      font-size: 0.95rem;
      font-weight: 700;
      color: var(--card-foreground);
      padding: 6px 0 10px;
    }
    .bd-book-btn {
      background: var(--primary);
      color: var(--primary-foreground);
    }
    .bd-book-btn:hover:not(:disabled) { background: var(--primary-hover); }
    .bd-book-btn:disabled { opacity: 0.5; cursor: not-allowed; }

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
    .mobile-cancel-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      margin-top: 8px;
      background: var(--status-failed);
      color: white;
      border: none;
      border-radius: var(--radius-sm);
      padding: 10px 16px;
      font-size: 0.875rem;
      font-weight: 600;
      font-family: var(--font-sans);
      cursor: pointer;
      min-height: 44px;
      width: 100%;
      transition: background 0.12s;
    }
    .mobile-cancel-btn:hover { background: #b91c1c; }

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
  <header class="site-header">
    <h1>Golf Scheduler &mdash; Fort Walton Beach</h1>
    <div class="header-right">
      <div class="header-stats" id="header-stats">
        ${bookings.filter(b => b.status === 'confirmed').length} Confirmed
      </div>
      <div class="header-sync" id="last-sync-display">Last synced: ${formattedSync}</div>
    </div>
  </header>
  <div class="container">
    <div class="legend">
      <div class="legend-item"><div class="legend-dot dot-confirmed"></div> Confirmed</div>
    </div>

    <div class="calendar-section">${generateCalendarHTML(year, month, byDate, 'Schedule Month', isAdmin)}</div>
    <div class="calendar-section">${generateCalendarHTML(month === 11 ? year + 1 : year, month === 11 ? 0 : month + 1, byDate, 'Book Now', isAdmin)}</div>

    <h2 class="section-heading">All Bookings</h2>
    <div class="table-scroll-wrapper">
      <div class="detail-table-card">
      <table class="detail-table">
        <thead>
          <tr>
            <th style="width:90px">Date</th>
            <th style="width:90px">Day</th>
            <th style="width:62px">Target</th>
            <th style="width:62px">Actual</th>
            <th style="width:36px">Slot</th>
            <th style="width:36px">Plyrs</th>
            <th style="width:52px">Course</th>
            <th style="width:72px">Status</th>
            <th style="width:90px">Confirm#</th>
            <th style="width:28px">By</th>
            <th style="width:62px">Action</th>
          </tr>
        </thead>
        <tbody>
          ${bookings.filter(b => b.status === 'confirmed').map(b => `
            <tr data-id="${b.id}" data-status="${b.status}" data-date="${b.date}" data-label="${b.day_label}"
                data-time="${b.actual_time || b.target_time}" data-course="${b.course}"
                data-confirmation="${b.confirmation_number || ''}"
                data-target-time="${b.target_time}" data-actual-time="${b.actual_time || ''}"
                data-players="${b.players || 4}" data-golfer="${b.golfer_index || 0}">
              <td>${b.date}</td>
              <td>${b.day_label}</td>
              <td>${b.target_time}</td>
              <td>${b.actual_time || '-'}</td>
              <td>${b.slot_index}</td>
              <td>${b.players || 4}</td>
              <td>${b.course}</td>
              <td><span class="status-badge badge-${b.status}">${b.status}</span></td>
              <td>${b.confirmation_number || '-'}</td>
              <td>${config.golfers[b.golfer_index || 0]?.email || `G${(b.golfer_index || 0) + 1}`}</td>
              <td>${isAdmin && ['confirmed','pending','failed'].includes(b.status) ? `<button class="btn-cancel-row" aria-label="Cancel reservation for ${b.date}" onclick="event.stopPropagation();openModal(this.closest('tr').dataset)">Cancel</button>` : ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
    </div>
  </div>

  <!-- Zoom widget; hidden on mobile via CSS -->
  <div id="zoom-control">
    <button onclick="zoom(-1)" aria-label="Decrease text size">A&minus;</button>
    <span id="zoom-label">100%</span>
    <button onclick="zoom(1)" aria-label="Increase text size">A+</button>
  </div>

  <!-- Book-day modal (admin only) -->
  ${isAdmin ? `
  <div class="modal-overlay" id="book-day-overlay" onclick="if(event.target===this)closeBookDayModal()">
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="bd-title">
      <div class="modal-header">
        <div class="modal-title" id="bd-title">Book a Tee Time</div>
        <button class="modal-close-x" onclick="closeBookDayModal()" aria-label="Close">&times;</button>
      </div>
      <div class="modal-separator"></div>
      <div class="bd-date-display" id="bd-date-display"></div>
      <input type="hidden" id="bd-date-input">
      <div class="bd-form-row">
        <label class="bd-label" for="bd-time">Target Time</label>
        <select class="bd-select" id="bd-time">
          ${(() => {
            const opts = [];
            for (let min = 7*60; min <= 15*60; min += 30) {
              const hh = Math.floor(min/60).toString().padStart(2,'0');
              const mm = (min%60).toString().padStart(2,'0');
              const val = hh+':'+mm;
              const h = Math.floor(min/60);
              const label = (h%12||12)+':'+(min%60).toString().padStart(2,'0')+' '+(h<12?'AM':'PM');
              const sel = min===12*60 ? ' selected' : '';
              opts.push('<option value="'+val+'"'+sel+'>'+label+'</option>');
            }
            return opts.join('');
          })()}
        </select>
      </div>
      <div class="bd-form-row">
        <label class="bd-label" for="bd-course">Course</label>
        <select class="bd-select" id="bd-course">
          <option value="Pines">Pines</option>
          <option value="Oaks">Oaks</option>
        </select>
      </div>
      <div class="bd-form-row">
        <label class="bd-label" for="bd-slots">Tee Time Slots (4 players each)</label>
        <select class="bd-select" id="bd-slots">
          <option value="1">1 slot — 4 players</option>
          <option value="2">2 slots — 8 players</option>
          <option value="3" selected>3 slots — 12 players</option>
        </select>
      </div>
      <div class="modal-msg" id="bd-msg"></div>
      <div class="modal-actions">
        <button class="btn btn-close-modal" onclick="closeBookDayModal()">Close</button>
        <button class="btn bd-book-btn" id="bd-book-btn" onclick="submitBookDay()">Book</button>
      </div>
    </div>
  </div>` : ''}

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
      <div class="modal-msg" id="m-msg"></div>
      <div class="modal-actions">
        <button class="btn btn-close-modal" id="btn-close-modal" aria-label="Close booking details" onclick="closeModal()">Close</button>
        ${isAdmin ? `<button class="btn btn-cancel-res" id="m-cancel-btn" onclick="cancelBooking()">Cancel Reservation</button>` : ''}
      </div>
    </div>
  </div>

  <script>
    const GOLFERS = ${JSON.stringify(config.golfers.map((g, i) => ({ index: i, label: `Golfer ${i + 1}`, email: g.email })))};
    function golferLabel(idx) {
      const g = GOLFERS[parseInt(idx) || 0];
      return g ? \`\${g.label} (\${g.email})\` : \`Golfer \${(parseInt(idx) || 0) + 1}\`;
    }

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
      document.getElementById('m-players').textContent = data.players ? (data.players + ' players') : '4 players';
      document.getElementById('m-golfer').textContent = golferLabel(data.golfer);
      document.getElementById('m-status').textContent = data.status;
      const conf = data.confirmation;
      const isReal = conf && /^\d+$/.test(conf);
      document.getElementById('m-confirmation').textContent = isReal ? conf : '—';
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

    // Calendar chips — stop propagation so day-cell click doesn't also fire
    document.querySelectorAll('.booking-chip').forEach(chip => {
      chip.addEventListener('click', (e) => { e.stopPropagation(); openModal(chip.dataset, chip); });
    });

    // Detail table rows — pass row element as trigger
    document.querySelectorAll('.detail-table tr[data-id]').forEach(row => {
      row.addEventListener('click', () => openModal(row.dataset, row));
    });

    // Keyboard handling
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeModal(); closeBookDayModal(); }
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
        chip.textContent = displayTime + ' ' + course + ' · ' + (b.players || 4) + 'p';

        // Update dataset
        chip.dataset.status = newStatus;
        chip.dataset.time = displayTime;
        chip.dataset.actualTime = b.actual_time || '';
        chip.dataset.targetTime = b.target_time;

        // Only show confirmed chips
        chip.style.display = newStatus === 'confirmed' ? '' : 'none';
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

    // ── Book-day modal (admin only) ─────────────────────────────────────────
    const IS_ADMIN = ${isAdmin};
    let bookDayTrigger = null;

    function openBookDayModal(dateStr, triggerEl) {
      const overlay = document.getElementById('book-day-overlay');
      if (!overlay) return;
      document.getElementById('bd-date-display').textContent = dateStr;
      document.getElementById('bd-date-input').value = dateStr;
      document.getElementById('bd-msg').textContent = '';
      document.getElementById('bd-msg').style.color = '#555';
      const btn = document.getElementById('bd-book-btn');
      btn.disabled = false;
      btn.textContent = 'Book';
      overlay.classList.add('open');
      bookDayTrigger = triggerEl || null;
      requestAnimationFrame(() => document.getElementById('bd-time').focus());
    }

    function closeBookDayModal() {
      const overlay = document.getElementById('book-day-overlay');
      if (overlay) overlay.classList.remove('open');
      if (bookDayTrigger && typeof bookDayTrigger.focus === 'function') bookDayTrigger.focus();
      bookDayTrigger = null;
    }

    async function submitBookDay() {
      const date = document.getElementById('bd-date-input').value;
      const targetTime = document.getElementById('bd-time').value;
      const course = document.getElementById('bd-course').value;
      const slots = document.getElementById('bd-slots').value;
      const btn = document.getElementById('bd-book-btn');
      const msg = document.getElementById('bd-msg');
      btn.disabled = true;
      btn.textContent = 'Booking...';
      msg.textContent = 'Submitting — this will open a browser window...';
      msg.style.color = '#888';
      try {
        const res = await fetch('/api/book-day', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date, targetTime, course, slots })
        });
        const json = await res.json();
        if (json.success) {
          msg.textContent = json.message + ' — reloading...';
          msg.style.color = '#22c55e';
          setTimeout(() => location.reload(), 2500);
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

    // Click on a calendar day cell to open book-day modal (admin only)
    if (IS_ADMIN) {
      document.querySelectorAll('.cal-day:not(.empty)').forEach(cell => {
        cell.addEventListener('click', () => {
          const dateStr = cell.dataset.date;
          if (dateStr) openBookDayModal(dateStr, cell);
        });
      });
    }

  </script>
</body>
</html>`);
});

// LONG_DAY_NAMES, MONTH_NAMES, isRealConfirmed, buildChipHTML, generateCalendarHTML
// are now imported from ./render at the top of this file.

async function startServer() {
  await db.getDb(); // Initialize DB

  const certPath = path.join(__dirname, '../data/certs/cert.pem');
  const keyPath  = path.join(__dirname, '../data/certs/key.pem');

  const useHttps = process.env.HTTPS_ENABLED === 'true' && fs.existsSync(certPath) && fs.existsSync(keyPath);

  return new Promise((resolve, reject) => {
    let server;
    if (useHttps) {
      const creds = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
      server = https.createServer(creds, app);
      server.on('error', reject);
      server.listen(PORT, () => {
        logger.info(`Web view running at https://localhost:${PORT}`);
        console.log(`\nCalendar view: https://localhost:${PORT}\n`);
        resolve(server);
      });
    } else {
      server = app.listen(PORT, () => {
        logger.info(`Web view running at http://localhost:${PORT}`);
        console.log(`\nCalendar view: http://localhost:${PORT}\n`);
        resolve(server);
      });
      server.on('error', reject);
    }
  });
}

module.exports = { startServer };
