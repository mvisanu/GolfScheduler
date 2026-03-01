const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('./config');

let db = null;

async function getDb() {
  if (db) return db;

  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  const SQL = await initSqlJs();

  if (fs.existsSync(config.dbPath)) {
    const buffer = fs.readFileSync(config.dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      day_label TEXT NOT NULL,
      target_time TEXT NOT NULL,
      actual_time TEXT,
      window_start TEXT,
      window_end TEXT,
      course TEXT NOT NULL,
      slot_index INTEGER NOT NULL,
      players INTEGER NOT NULL,
      confirmation_number TEXT,
      screenshot_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(date, target_time, slot_index)
    )
  `);

  // Add window columns to existing databases
  try { db.run(`ALTER TABLE bookings ADD COLUMN window_start TEXT`); } catch (e) { /* column exists */ }
  try { db.run(`ALTER TABLE bookings ADD COLUMN window_end TEXT`); } catch (e) { /* column exists */ }

  db.run(`CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status)`);

  return db;
}

function save() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(config.dbPath, buffer);
}

function queryAll(sql, params = {}) {
  const stmt = db.prepare(sql);
  if (Object.keys(params).length > 0) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function run(sql, params = {}) {
  db.run(sql, params);
}

module.exports = {
  getDb,

  async ensureBookings(bookingsList) {
    await getDb();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO bookings (date, day_label, target_time, window_start, window_end, course, slot_index, players, status)
      VALUES ($date, $dayLabel, $targetTime, $windowStart, $windowEnd, $course, $slotIndex, $players, 'pending')
    `);
    for (const b of bookingsList) {
      stmt.bind({
        $date: b.date,
        $dayLabel: b.dayLabel,
        $targetTime: b.targetTime,
        $windowStart: b.windowStart || null,
        $windowEnd: b.windowEnd || null,
        $course: b.course,
        $slotIndex: b.slotIndex,
        $players: b.players,
      });
      stmt.step();
      stmt.reset();
    }
    stmt.free();
    save();
  },

  async getPendingBookings() {
    await getDb();
    return queryAll(`
      SELECT * FROM bookings
      WHERE status IN ('pending', 'failed')
        AND attempts < $maxRetries
        AND date >= date('now')
      ORDER BY date, target_time, slot_index
    `, { $maxRetries: config.maxRetries });
  },

  async getBookingsByDate(date) {
    await getDb();
    return queryAll(`SELECT * FROM bookings WHERE date = $date ORDER BY target_time, slot_index`, { $date: date });
  },

  async getAllUpcoming() {
    await getDb();
    return queryAll(`SELECT * FROM bookings WHERE date >= date('now') ORDER BY date, target_time, slot_index`);
  },

  async markSuccess(id, { actualTime, course, confirmationNumber, screenshotPath }) {
    await getDb();
    run(`
      UPDATE bookings
      SET status = 'confirmed',
          actual_time = $actualTime,
          course = COALESCE($course, course),
          confirmation_number = $confirmationNumber,
          screenshot_path = $screenshotPath,
          attempts = attempts + 1,
          last_attempt_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = $id
    `, { $id: id, $actualTime: actualTime, $course: course || null, $confirmationNumber: confirmationNumber, $screenshotPath: screenshotPath });
    save();
  },

  async markFailed(id, errorMessage) {
    await getDb();
    run(`
      UPDATE bookings
      SET status = 'failed',
          attempts = attempts + 1,
          last_attempt_at = datetime('now'),
          error_message = $errorMessage,
          updated_at = datetime('now')
      WHERE id = $id
    `, { $id: id, $errorMessage: String(errorMessage).slice(0, 500) });
    save();
  },

  async markPartial(id, { actualTime, screenshotPath, errorMessage }) {
    await getDb();
    run(`
      UPDATE bookings
      SET status = 'partial',
          actual_time = $actualTime,
          screenshot_path = $screenshotPath,
          attempts = attempts + 1,
          last_attempt_at = datetime('now'),
          error_message = $errorMessage,
          updated_at = datetime('now')
      WHERE id = $id
    `, { $id: id, $actualTime: actualTime, $screenshotPath: screenshotPath, $errorMessage: errorMessage });
    save();
  },

  async markSkipped(id, errorMessage) {
    await getDb();
    run(`
      UPDATE bookings
      SET status = 'skipped',
          error_message = $errorMessage,
          updated_at = datetime('now')
      WHERE id = $id
    `, { $id: id, $errorMessage: errorMessage });
    save();
  },
};
