'use strict';

/**
 * render.js — shared HTML rendering helpers used by both the local Express
 * server (web.js) and the static-site generator (generate-static.js).
 *
 * Exported:
 *   LONG_DAY_NAMES         — full weekday name array (index = getDay())
 *   MONTH_NAMES            — full month name array (index = 0-based month)
 *   isRealConfirmed(b)     — true when a booking should appear on the calendar
 *   buildChipHTML(b, dateStr) — returns HTML string for one booking chip
 *   generateCalendarHTML(year, month, byDate, buttonLabel, isAdmin)
 */

// Long day names for mobile list headings
const LONG_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];

// Helper: only show confirmed bookings
function isRealConfirmed(b) {
  return b.status === 'confirmed';
}

// Helper: build a booking chip HTML string (shared by calendar and mobile list)
function buildChipHTML(b, dateStr) {
  const displayTime = b.actual_time || b.target_time;
  const course = b.course || 'Pines';
  const gi = b.golfer_index || 0;
  const resNum = b.confirmation_number && !/^(EXISTING_RESERVATION|CONFIRMED|access)$/.test(b.confirmation_number) ? ` — Res #${b.confirmation_number}` : '';
  return `<div class="booking-chip chip-${b.status}"
      data-id="${b.id}" data-status="${b.status}" data-date="${dateStr}"
      data-label="${b.day_label}" data-time="${displayTime}" data-course="${course}"
      data-confirmation="${b.confirmation_number || ''}"
      data-target-time="${b.target_time}" data-actual-time="${b.actual_time || ''}"
      data-players="${b.players || 4}" data-golfer="${gi}"
      title="${b.day_label} — ${course} — G${gi + 1}${resNum}">${displayTime} ${course} · ${b.players || 4}p</div>`;
}

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

    html += `<div class="cal-day${isToday ? ' today' : ''}" data-date="${dateStr}">`;
    html += `<div class="day-num">${d}</div>`;

    for (const b of dayBookings) {
      if (!isRealConfirmed(b)) continue;
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

  // Mobile booking list — only days with bookings
  html += '<div class="mobile-booking-list">';
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayBookings = (byDate[dateStr] || []).filter(isRealConfirmed);
    if (dayBookings.length === 0) continue;

    const dayOfWeek = new Date(year, month, d).getDay();
    const longDayName = LONG_DAY_NAMES[dayOfWeek];
    const dateHeading = `${longDayName}, ${MONTH_NAMES[month]} ${d}`;

    html += '<div class="mobile-booking-card">';
    html += `<div class="mobile-booking-card-date">${dateHeading}</div>`;

    for (const b of dayBookings) {
      html += buildChipHTML(b, dateStr);
    }

    // Cancel buttons for admin mobile view
    const cancellableBookings = isAdmin ? dayBookings.filter(b => ['confirmed','pending','failed'].includes(b.status)) : [];
    for (const b of cancellableBookings) {
      const displayTime = b.actual_time || b.target_time;
      const course = b.course || 'Pines';
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

module.exports = { LONG_DAY_NAMES, MONTH_NAMES, isRealConfirmed, buildChipHTML, generateCalendarHTML };
