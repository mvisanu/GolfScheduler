const express = require('express');
const path = require('path');
const db = require('./db');
const config = require('./config');
const logger = require('./logger');

const app = express();
const PORT = process.env.PORT || 3002;

app.get('/api/bookings', async (req, res) => {
  const bookings = await db.getAllUpcoming();
  res.json(bookings);
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
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; }
    .header { background: #cb6301; color: white; padding: 20px 30px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 1.5rem; }
    .header .stats { font-size: 0.9rem; opacity: 0.9; }
    .container { max-width: 1200px; margin: 20px auto; padding: 0 20px; }
    .legend { display: flex; gap: 20px; margin-bottom: 20px; flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.85rem; }
    .legend-dot { width: 12px; height: 12px; border-radius: 3px; }
    .dot-confirmed { background: #22c55e; }
    .dot-pending { background: #f59e0b; }
    .dot-failed { background: #ef4444; }
    .dot-partial { background: #f97316; }
    .dot-empty { background: #e5e7eb; }
    .calendar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; background: #ddd; border-radius: 8px; overflow: hidden; }
    .cal-header { background: #cb6301; color: white; padding: 10px; text-align: center; font-weight: 600; font-size: 0.85rem; }
    .cal-day { background: white; min-height: 120px; padding: 8px; position: relative; }
    .cal-day.empty { background: #f9fafb; }
    .cal-day.today { box-shadow: inset 0 0 0 2px #cb6301; }
    .day-num { font-weight: 600; font-size: 0.9rem; color: #666; margin-bottom: 6px; }
    .booking-chip { display: block; padding: 3px 6px; margin-bottom: 3px; border-radius: 4px; font-size: 0.7rem; color: white; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chip-confirmed { background: #22c55e; }
    .chip-pending { background: #f59e0b; }
    .chip-failed { background: #ef4444; }
    .chip-partial { background: #f97316; }
    .chip-skipped { background: #9ca3af; display: none; }
    .chip-cancelled { background: #6b7280; text-decoration: line-through; }
    .month-nav { display: flex; align-items: center; gap: 15px; margin-bottom: 15px; }
    .month-nav h2 { font-size: 1.3rem; }
    .month-nav button { background: #cb6301; color: white; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 0.9rem; }
    .month-nav button:hover { background: #a84f00; }
    .detail-table { width: 100%; border-collapse: collapse; margin-top: 20px; background: white; border-radius: 8px; overflow: hidden; }
    .detail-table th { background: #cb6301; color: white; padding: 10px 12px; text-align: left; font-size: 0.85rem; }
    .detail-table td { padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 0.85rem; }
    .detail-table tr:hover { background: #fff7ed; }
    .status-badge { padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; color: white; }
    .badge-confirmed { background: #22c55e; }
    .badge-pending { background: #f59e0b; }
    .badge-failed { background: #ef4444; }
    .badge-partial { background: #f97316; }
    .badge-cancelled { background: #6b7280; }
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
    ${generateCalendarHTML(month === 11 ? year + 1 : year, month === 11 ? 0 : month + 1, byDate)}

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
        </tr>
      </thead>
      <tbody>
        ${bookings.map(b => `
          <tr>
            <td>${b.date}</td>
            <td>${b.day_label}</td>
            <td>${b.target_time}</td>
            <td>${b.actual_time || '-'}</td>
            <td>${b.slot_index}</td>
            <td>${b.course}</td>
            <td><span class="status-badge badge-${b.status}">${b.status}</span></td>
            <td>${b.confirmation_number || '-'}</td>
            <td>${b.attempts}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>
</body>
</html>`);
});

function generateCalendarHTML(year, month, byDate) {
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                       'July', 'August', 'September', 'October', 'November', 'December'];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  let html = `<div class="month-nav"><h2>${monthNames[month]} ${year}</h2></div>`;
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
          html += `<div class="booking-chip chip-${s.status}" title="${label} — ${course}${resNum}">${displayTime} ${course}</div>`;
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
