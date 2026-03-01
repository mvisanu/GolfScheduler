const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const config = require('./config');

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Compute all booking slots needed for the next N days.
 * Returns flat array of { date, dayLabel, targetTime, course, slotIndex, players }
 */
function computeBookingSlots() {
  const now = dayjs().tz(config.timezone);
  const slots = [];

  for (let offset = 0; offset <= config.horizonDays; offset++) {
    const date = now.add(offset, 'day');
    const dayOfWeek = date.day();

    for (const entry of config.schedule) {
      if (entry.day !== dayOfWeek) continue;

      for (let i = 0; i < entry.slots; i++) {
        // Target time offsets from window start (each slot ~10 min apart)
        const [hours, mins] = entry.windowStart.split(':').map(Number);
        const slotTime = dayjs()
          .hour(hours)
          .minute(mins + i * 10)
          .second(0)
          .format('HH:mm');

        slots.push({
          date: date.format('YYYY-MM-DD'),
          dayLabel: entry.label,
          targetTime: slotTime,
          windowStart: entry.windowStart,
          windowEnd: entry.windowEnd,
          course: config.site.courses.pines.name,
          slotIndex: i,
          players: 4, // always 4 per slot
        });
      }
    }
  }

  return slots;
}

/**
 * Group pending bookings by date + target time block for batch processing.
 */
function groupByDateAndTime(bookings) {
  const groups = {};
  for (const b of bookings) {
    const key = `${b.date}|${b.day_label}`;
    if (!groups[key]) {
      groups[key] = { date: b.date, dayLabel: b.day_label, slots: [] };
    }
    groups[key].slots.push(b);
  }
  // Sort slots within each group
  for (const g of Object.values(groups)) {
    g.slots.sort((a, b) => a.slot_index - b.slot_index);
  }
  return Object.values(groups);
}

module.exports = { computeBookingSlots, groupByDateAndTime };
