require('dotenv').config();
const path = require('path');
const fs = require('fs');

// Load schedule from schedule.json
const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const schedulePath = path.join(__dirname, '..', 'schedule.json');
let rawSchedule = [];
if (fs.existsSync(schedulePath)) {
  rawSchedule = JSON.parse(fs.readFileSync(schedulePath, 'utf8'));
} else {
  console.error('ERROR: schedule.json not found in project root.');
  process.exit(1);
}

function formatTimeLabel(start, end) {
  const fmt = (t) => {
    const [h, m] = t.split(':').map(Number);
    const hour = h % 12 || 12;
    const ampm = h < 12 ? 'AM' : 'PM';
    return m === 0 ? `${hour} ${ampm}` : `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
  };
  return `${fmt(start)}-${fmt(end)}`;
}

const schedule = rawSchedule.map(entry => {
  const dayNum = dayMap[entry.day.toLowerCase()];
  if (dayNum === undefined) {
    console.error(`ERROR: Invalid day "${entry.day}" in schedule.json. Use: Sunday, Monday, ..., Saturday`);
    process.exit(1);
  }
  return {
    day: dayNum,
    windowStart: entry.windowStart,
    windowEnd: entry.windowEnd,
    players: entry.players,
    slots: entry.slots,
    preferredCourse: entry.course || 'Pines',
    label: `${entry.day} ${formatTimeLabel(entry.windowStart, entry.windowEnd)}`,
  };
});

const config = {
  // Credentials
  email: process.env.GOLF_EMAIL,
  password: process.env.GOLF_PASSWORD,

  // Timezone
  timezone: process.env.TIMEZONE || 'America/Chicago',

  // Booking horizon
  horizonDays: parseInt(process.env.BOOKING_HORIZON_DAYS || '30', 10),

  // Max retry attempts per booking
  maxRetries: 3,

  // Paths
  screenshotDir: process.env.SCREENSHOT_DIR || './screenshots',
  dbPath: process.env.DB_PATH || './data/bookings.db',

  // Log level
  logLevel: process.env.LOG_LEVEL || 'info',

  // Site URLs and IDs (TeeItUp / Kenna Golf platform)
  site: {
    memberUrl: 'https://fort-walton-member.book.teeitup.golf',
    apiBase: 'https://phx-api-be-east-1b.kenna.io',
    golfIdHost: 'https://my.golfid.io',
    golfIdClientId: 'VYvYEb6eIdfMvxxz',
    entityId: '615c8bd29f92380015e2d984',
    alias: 'fort-walton-member',
    courses: {
      pines: { id: '9437', name: 'Pines' },
      oaks: { id: '9438', name: 'Oaks' },
    },
  },

  // Recurring schedule (loaded from schedule.json)
  schedule,
};

// Validate required config
if (!config.email || !config.password) {
  console.error('ERROR: GOLF_EMAIL and GOLF_PASSWORD environment variables are required.');
  console.error('Copy .env.example to .env and fill in your credentials.');
  process.exit(1);
}

module.exports = config;
