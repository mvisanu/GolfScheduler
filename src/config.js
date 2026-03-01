require('dotenv').config();

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

  // Recurring schedule: dayOfWeek (0=Sun, 1=Mon, ..., 6=Sat)
  // windowStart/windowEnd define the acceptable time range for booking
  schedule: [
    { day: 1, windowStart: '12:00', windowEnd: '13:00', players: 12, slots: 3, label: 'Monday 12-1 PM' },
    { day: 2, windowStart: '12:00', windowEnd: '13:00', players: 8, slots: 2, label: 'Tuesday 12-1 PM' },
    { day: 5, windowStart: '12:00', windowEnd: '13:00', players: 12, slots: 3, label: 'Friday 12-1 PM' },
    { day: 6, windowStart: '09:00', windowEnd: '10:00', players: 12, slots: 3, label: 'Saturday 9-10 AM' },
  ],
};

// Validate required config
if (!config.email || !config.password) {
  console.error('ERROR: GOLF_EMAIL and GOLF_PASSWORD environment variables are required.');
  console.error('Copy .env.example to .env and fill in your credentials.');
  process.exit(1);
}

module.exports = config;
