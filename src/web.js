const express = require('express');
const path = require('path');
const db = require('./db');
const config = require('./config');
const logger = require('./logger');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3002;

app.get('/api/bookings', async (req, res) => {
  const bookings = await db.getAllUpcoming();
  res.json(bookings);
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

app.get('/', async (req, res) => {
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

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Golf Scheduler - Calendar</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #2D2A26; line-height: 1.5; font-size: 16px; }
    .header { background: #cb6301; color: white; padding: 20px 30px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 1.5rem; letter-spacing: 0.01em; }
    .header .stats { font-size: 0.9rem; opacity: 0.9; }
    .container { max-width: 1200px; margin: 20px auto; padding: 0 20px; }
    .legend { display: flex; gap: 20px; margin-bottom: 20px; flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.875rem; }
    .legend-dot { width: 12px; height: 12px; border-radius: 3px; }
    .dot-confirmed { background: #166534; }
    .dot-pending { background: #b45309; }
    .dot-failed { background: #dc2626; }
    .dot-partial { background: #c2410c; }
    .dot-empty { background: #e5e7eb; }
    .calendar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; background: #ddd; border-radius: 8px; overflow: hidden; }
    .cal-header { background: #cb6301; color: white; padding: 10px; text-align: center; font-weight: 600; font-size: 0.875rem; }
    .cal-day { background: white; min-height: 120px; padding: 8px; position: relative; }
    .cal-day.empty { background: #f9fafb; }
    .cal-day.today { box-shadow: inset 0 0 0 2px #cb6301; }
    .day-num { font-weight: 600; font-size: 0.9rem; color: #555; margin-bottom: 6px; }
    .booking-chip { display: block; padding: 3px 6px; margin-bottom: 3px; border-radius: 4px; font-size: 0.8rem; color: white; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
    .chip-confirmed { background: #166534; }
    .chip-pending { background: #b45309; }
    .chip-failed { background: #dc2626; }
    .chip-partial { background: #c2410c; }
    .chip-skipped { background: #9ca3af; display: none; }
    .chip-cancelled { background: #6b7280; text-decoration: line-through; }
    .month-nav { display: flex; align-items: center; gap: 15px; margin-bottom: 15px; }
    .month-nav h2 { font-size: 1.3rem; letter-spacing: 0.01em; }
    .month-nav button { background: #cb6301; color: white; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 0.9rem; }
    .month-nav button:hover:not(:disabled) { background: #a84f00; }
    .month-nav button:disabled { opacity: 0.7; cursor: not-allowed; }
    .btn-schedule-month { margin-left: 8px; }
    .detail-table { width: 100%; border-collapse: collapse; margin-top: 20px; background: white; border-radius: 8px; overflow: hidden; }
    .detail-table th { background: #cb6301; color: white; padding: 10px 12px; text-align: left; font-size: 0.875rem; }
    .detail-table td { padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 0.875rem; }
    .detail-table tr[data-id] { cursor: pointer; }
    .detail-table tr[data-id]:hover { background: #fff7ed; }
    .status-badge { padding: 2px 8px; border-radius: 10px; font-size: 0.8rem; color: white; }
    .badge-confirmed { background: #166534; }
    .badge-pending { background: #b45309; }
    .badge-failed { background: #dc2626; }
    .badge-partial { background: #c2410c; }
    .badge-cancelled { background: #6b7280; }
    /* Modal */
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; z-index: 1000; }
    .modal-overlay.open { display: flex; }
    .modal-box { background: white; border-radius: 10px; padding: 28px; max-width: 420px; width: 90%; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
    .modal-title { font-size: 1.1rem; font-weight: 700; margin-bottom: 16px; color: #111; letter-spacing: 0.01em; }
    .modal-grid { display: grid; grid-template-columns: 110px 1fr; gap: 6px 8px; font-size: 0.9rem; margin-bottom: 18px; }
    .modal-label { color: #666; font-weight: 500; }
    .modal-value { color: #222; font-weight: 600; }
    .modal-msg { font-size: 0.875rem; min-height: 20px; margin-bottom: 14px; }
    .modal-actions { display: flex; gap: 10px; justify-content: flex-end; }
    .btn { border: none; padding: 9px 18px; border-radius: 5px; cursor: pointer; font-size: 0.9rem; font-weight: 600; }
    .btn-cancel-res { background: #dc2626; color: white; }
    .btn-cancel-res:hover:not(:disabled) { background: #b91c1c; }
    .btn-cancel-res:disabled { background: #9ca3af; cursor: not-allowed; }
    .btn-close-modal { background: #e5e7eb; color: #333; }
    .btn-close-modal:hover { background: #d1d5db; }
    .btn-cancel-row { background: #dc2626; color: white; border: none; padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 0.8rem; font-weight: 600; }
    .btn-cancel-row:hover { background: #b91c1c; }
    /* Zoom widget transition */
    html { transition: font-size 0.15s ease; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Golf Scheduler - Fort Walton Beach</h1>
    <div class="stats">
      ${bookings.filter(b => b.status === 'confirmed').length} Confirmed |
      ${bookings.filter(b => b.status === 'pending').length} Pending |
      ${bookings.filter(b => b.status === 'failed').length} Failed |
      ${bookings.length} Total
    </div>
  </div>
  <div class="container">
    <div class="legend">
      <div class="legend-item"><div class="legend-dot dot-confirmed"></div> Confirmed</div>
      <div class="legend-item"><div class="legend-dot dot-pending"></div> Pending</div>
      <div class="legend-item"><div class="legend-dot dot-failed"></div> Failed</div>
      <div class="legend-item"><div class="legend-dot dot-partial"></div> Partial</div>
    </div>

    ${generateCalendarHTML(year, month, byDate)}
    ${generateCalendarHTML(month === 11 ? year + 1 : year, month === 11 ? 0 : month + 1, byDate, 'Book Now')}

    <h2 style="margin-top:30px; margin-bottom:10px;">All Bookings</h2>
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
              data-confirmation="${b.confirmation_number || ''}">
            <td>${b.date}</td>
            <td>${b.day_label}</td>
            <td>${b.target_time}</td>
            <td>${b.actual_time || '-'}</td>
            <td>${b.slot_index}</td>
            <td>${b.course}</td>
            <td><span class="status-badge badge-${b.status}">${b.status}</span></td>
            <td>${b.confirmation_number || '-'}</td>
            <td>${b.attempts}</td>
            <td>${['confirmed','pending','failed'].includes(b.status) ? `<button class="btn-cancel-row" onclick="event.stopPropagation();openModal(this.closest('tr').dataset)">Cancel</button>` : ''}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>

  <!-- Zoom widget -->
  <div id="zoom-control" style="position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;align-items:center;gap:8px;background:#1C1C1E;color:#FAFAF9;border-radius:999px;padding:8px 16px;font-family:monospace;font-size:14px;box-shadow:0 4px 24px rgba(0,0,0,0.3);user-select:none;">
    <button onclick="zoom(-1)" style="background:none;border:none;color:inherit;cursor:pointer;font-size:16px;">A−</button>
    <span id="zoom-label">100%</span>
    <button onclick="zoom(1)" style="background:none;border:none;color:inherit;cursor:pointer;font-size:18px;">A+</button>
  </div>

  <!-- Cancel modal -->
  <div class="modal-overlay" id="modal-overlay" onclick="if(event.target===this)closeModal()">
    <div class="modal-box">
      <div class="modal-title">Booking Details</div>
      <div class="modal-grid">
        <span class="modal-label">Date</span>       <span class="modal-value" id="m-date"></span>
        <span class="modal-label">Day</span>        <span class="modal-value" id="m-label"></span>
        <span class="modal-label">Time</span>       <span class="modal-value" id="m-time"></span>
        <span class="modal-label">Course</span>     <span class="modal-value" id="m-course"></span>
        <span class="modal-label">Status</span>     <span class="modal-value" id="m-status"></span>
        <span class="modal-label">Confirmation</span><span class="modal-value" id="m-confirmation"></span>
      </div>
      <div class="modal-msg" id="m-msg"></div>
      <div class="modal-actions">
        <button class="btn btn-close-modal" onclick="closeModal()">Close</button>
        <button class="btn btn-cancel-res" id="m-cancel-btn" onclick="cancelBooking()">Cancel Reservation</button>
      </div>
    </div>
  </div>

  <script>
    let activeId = null;

    function openModal(data) {
      activeId = data.id;
      document.getElementById('m-date').textContent = data.date;
      document.getElementById('m-label').textContent = data.label;
      document.getElementById('m-time').textContent = data.time;
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
    }

    function closeModal() {
      document.getElementById('modal-overlay').classList.remove('open');
      activeId = null;
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

    // Calendar chips
    document.querySelectorAll('.booking-chip').forEach(chip => {
      chip.addEventListener('click', () => openModal(chip.dataset));
    });

    // Detail table rows
    document.querySelectorAll('.detail-table tr[data-id]').forEach(row => {
      row.addEventListener('click', () => openModal(row.dataset));
    });

    // Keyboard close
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
      if (e.ctrlKey && e.key === '=') { e.preventDefault(); zoom(1); }
      if (e.ctrlKey && e.key === '-') { e.preventDefault(); zoom(-1); }
      if (e.ctrlKey && e.key === '0') { e.preventDefault(); baseSize = 16; applyZoom(); }
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
  </script>
</body>
</html>`);
});

function generateCalendarHTML(year, month, byDate, buttonLabel = 'Schedule Month') {
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                       'July', 'August', 'September', 'October', 'November', 'December'];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  let html = `<div class="month-nav"><h2>${monthNames[month]} ${year}</h2><button class="btn-schedule-month" data-year="${year}" data-month="${month}" onclick="scheduleMonth(this)">${buttonLabel}</button></div>`;
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

    if (dayBookings.length > 0) {
      // Group by day_label
      const groups = {};
      for (const b of dayBookings) {
        if (!groups[b.day_label]) groups[b.day_label] = [];
        groups[b.day_label].push(b);
      }
      for (const [label, slots] of Object.entries(groups)) {
        for (const s of slots) {
          const displayTime = s.actual_time || s.target_time;
          const course = s.course || 'Pines';
          const resNum = s.confirmation_number && s.confirmation_number !== 'EXISTING_RESERVATION' ? ` — Res #${s.confirmation_number}` : '';
          html += `<div class="booking-chip chip-${s.status}"
            data-id="${s.id}" data-status="${s.status}" data-date="${dateStr}"
            data-label="${label}" data-time="${displayTime}" data-course="${course}"
            data-confirmation="${s.confirmation_number || ''}"
            title="${label} — ${course}${resNum}">${displayTime} ${course}</div>`;
        }
      }
    }

    html += '</div>';
  }

  // Fill remaining cells
  const totalCells = firstDay + daysInMonth;
  const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let i = 0; i < remaining; i++) {
    html += '<div class="cal-day empty"></div>';
  }

  html += '</div>';
  return html;
}

async function startServer() {
  await db.getDb(); // Initialize DB
  app.listen(PORT, () => {
    logger.info(`Web view running at http://localhost:${PORT}`);
    console.log(`\nCalendar view: http://localhost:${PORT}\n`);
  });
}

module.exports = { startServer };
