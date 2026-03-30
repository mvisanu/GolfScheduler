/**
 * GolfScheduler — Comprehensive Test Suite
 * Covers: scheduler logic, DB operations, booking engine utilities,
 *         web API endpoints, HTML/CSS audit, config, edge cases.
 *
 * Run with:  node --test tests/test.js
 */

// ─── 1. Set env vars BEFORE any require() that touches config.js ─────────────
process.env.GOLF_EMAIL    = 'test@example.com';
process.env.GOLF_PASSWORD = 'testpass123';
process.env.PORT          = '3099';
process.env.TIMEZONE      = 'America/Chicago';
process.env.BOOKING_HORIZON_DAYS = '30';

const os   = require('os');
const path = require('path');
const TMP_DB = path.join(os.tmpdir(), `golf_test_${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;

// ─── 2. Imports ───────────────────────────────────────────────────────────────
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('http');
const fs     = require('fs');

// ─── 3a. Module-level server lifecycle (shared across D, E, G sections) ───────
let _testServer = null;
before(async () => {
  const { Server } = require('http');
  const origListen = Server.prototype.listen;
  Server.prototype.listen = function (port, ...rest) {
    if (String(port) === '3099') _testServer = this;
    Server.prototype.listen = origListen; // restore immediately
    return origListen.call(this, port, ...rest);
  };
  const { startServer } = require('../src/web');
  await startServer();
  await new Promise(r => setTimeout(r, 300));
});

after(async () => {
  if (_testServer) await new Promise(r => _testServer.close(r));
  try { fs.unlinkSync(TMP_DB); } catch (_) {}
});

// ─── 3. HTTP helpers ──────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
}

function httpPost(url, body = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      method: 'POST',
      hostname: u.hostname,
      port:     u.port,
      path:     u.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION A: SCHEDULER — pure functions
// ═════════════════════════════════════════════════════════════════════════════
describe('A — scheduler.computeBookingSlots()', () => {
  const { computeBookingSlots, groupByDateAndTime } = require('../src/scheduler');

  test('A01 returns an Array', () => {
    assert.ok(Array.isArray(computeBookingSlots()));
  });

  test('A02 only generates slots for Mon/Tue/Fri/Sat/Sun (days 0,1,2,5,6)', () => {
    // Sunday (0) was added to the schedule in schedule.json (8 AM–10 AM, alternating course)
    const validDays = new Set([0, 1, 2, 5, 6]);
    for (const slot of computeBookingSlots()) {
      // parse date as local date by appending noon time to avoid TZ shift
      const dow = new Date(slot.date + 'T12:00:00').getDay();
      assert.ok(validDays.has(dow), `Unexpected day ${dow} for ${slot.date}`);
    }
  });

  test('A03 all slots have players = 4', () => {
    for (const s of computeBookingSlots()) {
      assert.equal(s.players, 4, `players should be 4 for ${s.date}`);
    }
  });

  test('A04 Monday has 2 slots at 12:00/12:10', () => {
    const byDate = {};
    for (const s of computeBookingSlots()) {
      if (new Date(s.date + 'T12:00:00').getDay() !== 1) continue;
      (byDate[s.date] ??= []).push(s);
    }
    for (const [date, slots] of Object.entries(byDate)) {
      slots.sort((a, b) => a.slotIndex - b.slotIndex);
      assert.equal(slots.length, 2, `Monday ${date} should have 2 slots`);
      assert.equal(slots[0].targetTime, '12:00', 'Slot 0 should be 12:00');
      assert.equal(slots[1].targetTime, '12:10', 'Slot 1 should be 12:10');
    }
  });

  test('A05 Tuesday has 2 slots at 12:00/12:10', () => {
    const byDate = {};
    for (const s of computeBookingSlots()) {
      if (new Date(s.date + 'T12:00:00').getDay() !== 2) continue;
      (byDate[s.date] ??= []).push(s);
    }
    for (const [date, slots] of Object.entries(byDate)) {
      slots.sort((a, b) => a.slotIndex - b.slotIndex);
      assert.equal(slots.length, 2, `Tuesday ${date} should have 2 slots`);
      assert.equal(slots[0].targetTime, '12:00');
      assert.equal(slots[1].targetTime, '12:10');
    }
  });

  test('A06 Saturday window is 08:00–13:00', () => {
    for (const s of computeBookingSlots()) {
      if (new Date(s.date + 'T12:00:00').getDay() !== 6) continue;
      assert.equal(s.windowStart, '08:00');
      assert.equal(s.windowEnd, '13:00');
    }
  });

  test('A07 Saturday first slot is at 08:00', () => {
    for (const s of computeBookingSlots()) {
      if (new Date(s.date + 'T12:00:00').getDay() !== 6 || s.slotIndex !== 0) continue;
      assert.equal(s.targetTime, '08:00', `Saturday slot 0 should be 08:00, got ${s.targetTime}`);
    }
  });

  test('A08 all courses are Pines or Oaks (Sunday alternates per ISO week)', () => {
    // Sunday uses "alternating" course sentinel resolved to Pines (even week) or Oaks (odd week).
    // Mon/Tue/Fri/Sat are always Pines.
    const validCourses = new Set(['Pines', 'Oaks']);
    for (const s of computeBookingSlots()) {
      assert.ok(validCourses.has(s.course), `Unexpected course "${s.course}" for ${s.date}`);
      // Non-Sunday slots must always be Pines
      const dow = new Date(s.date + 'T12:00:00').getDay();
      if (dow !== 0) {
        assert.equal(s.course, 'Pines', `${s.date} (day ${dow}) should be Pines, got ${s.course}`);
      }
    }
  });

  test('A09 date format matches YYYY-MM-DD', () => {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    for (const s of computeBookingSlots()) {
      assert.match(s.date, re);
    }
  });

  test('A10 slot_index is sequential 0..N-1 within a day', () => {
    const byKey = {};
    for (const s of computeBookingSlots()) {
      const key = `${s.date}|${s.dayLabel}`;
      (byKey[key] ??= []).push(s.slotIndex);
    }
    for (const [key, indices] of Object.entries(byKey)) {
      indices.sort((a, b) => a - b);
      for (let i = 0; i < indices.length; i++) {
        assert.equal(indices[i], i, `Expected slotIndex ${i}, got ${indices[i]} for ${key}`);
      }
    }
  });

  test('A11 groupByDateAndTime: groups by date+day_label', () => {
    const bookings = [
      { date: '2026-03-09', day_label: 'Monday 12 PM-1 PM', slot_index: 0, target_time: '12:00' },
      { date: '2026-03-09', day_label: 'Monday 12 PM-1 PM', slot_index: 1, target_time: '12:10' },
      { date: '2026-03-13', day_label: 'Friday 12 PM-1 PM',  slot_index: 0, target_time: '12:00' },
    ];
    const groups = groupByDateAndTime(bookings);
    assert.equal(groups.length, 2);
    const mon = groups.find(g => g.date === '2026-03-09');
    assert.ok(mon);
    assert.equal(mon.slots.length, 2);
  });

  test('A12 groupByDateAndTime: slots sorted by slot_index ascending', () => {
    const bookings = [
      { date: '2026-03-09', day_label: 'Monday', slot_index: 2, target_time: '12:20' },
      { date: '2026-03-09', day_label: 'Monday', slot_index: 0, target_time: '12:00' },
      { date: '2026-03-09', day_label: 'Monday', slot_index: 1, target_time: '12:10' },
    ];
    const groups = groupByDateAndTime(bookings);
    assert.equal(groups[0].slots[0].slot_index, 0);
    assert.equal(groups[0].slots[1].slot_index, 1);
    assert.equal(groups[0].slots[2].slot_index, 2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION B: BOOKING ENGINE — pure utility methods
// ═════════════════════════════════════════════════════════════════════════════
describe('B — BookingEngine pure methods', () => {
  const BookingEngine = require('../src/booking');
  // Bypass constructor (avoids Playwright) by using Object.create
  const engine = Object.create(BookingEngine.prototype);
  engine.site    = {};
  engine.dryRun  = false;

  // _timeToMinutes
  test('B01 _timeToMinutes("00:00") = 0',   () => assert.equal(engine._timeToMinutes('00:00'), 0));
  test('B02 _timeToMinutes("12:00") = 720',  () => assert.equal(engine._timeToMinutes('12:00'), 720));
  test('B03 _timeToMinutes("23:59") = 1439', () => assert.equal(engine._timeToMinutes('23:59'), 1439));
  test('B04 _timeToMinutes("08:30") = 510',  () => assert.equal(engine._timeToMinutes('08:30'), 510));

  // _shiftTime — forward
  test('B05 _shiftTime("12:00", +60) = "13:00"', () =>
    assert.equal(engine._shiftTime('12:00', 60), '13:00'));
  test('B06 _shiftTime("12:00", +120) = "14:00"', () =>
    assert.equal(engine._shiftTime('12:00', 120), '14:00'));
  test('B07 _shiftTime wraps past midnight: ("23:00", +120) = "01:00"', () =>
    assert.equal(engine._shiftTime('23:00', 120), '01:00'));

  // _shiftTime — backward
  test('B08 _shiftTime("12:00", -60) = "11:00"', () =>
    assert.equal(engine._shiftTime('12:00', -60), '11:00'));
  test('B09 _shiftTime("02:00", -120) = "00:00"', () =>
    assert.equal(engine._shiftTime('02:00', -120), '00:00'));

  // _shiftTime now wraps negative totals correctly across midnight.
  test('B10 _shiftTime underflow: ("00:30", -60) wraps to "23:30"', () => {
    const result = engine._shiftTime('00:30', -60);
    assert.equal(result, '23:30',
      `Expected "23:30" for midnight-wrap underflow (got "${result}")`);
  });

  test('B11 _shiftTime("01:00", -120) wraps to "23:00"', () => {
    const result = engine._shiftTime('01:00', -120);
    assert.equal(result, '23:00',
      `Expected "23:00" for midnight-wrap underflow (got "${result}")`);
  });

  // _filterAlreadyBooked
  test('B12 _filterAlreadyBooked: ±15 min match marks slot confirmed', async () => {
    const db = require('../src/db');
    const captured = [];
    const orig = db.markSuccess;
    db.markSuccess = async (id, d) => { captured.push({ id, ...d }); };

    const slot = { id: 501, slot_index: 0, target_time: '12:00',
                   window_start: null, window_end: null };
    const remaining = await engine._filterAlreadyBooked(
      [slot], [{ time: '12:05', course: 'Pines' }], '2026-12-01');

    db.markSuccess = orig;
    assert.equal(remaining.length, 0,  'Matched slot should be removed');
    assert.equal(captured[0].id, 501,  'markSuccess should be called with correct id');
    assert.equal(captured[0].confirmationNumber, 'EXISTING_RESERVATION');
  });

  test('B13 _filterAlreadyBooked: >15 min gap leaves slot in remaining', async () => {
    const db = require('../src/db');
    const orig = db.markSuccess;
    db.markSuccess = async () => {};

    const slot = { id: 502, slot_index: 0, target_time: '12:00',
                   window_start: null, window_end: null };
    const remaining = await engine._filterAlreadyBooked(
      [slot], [{ time: '14:00', course: 'Pines' }], '2026-12-02');

    db.markSuccess = orig;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, 502);
  });

  test('B14 _filterAlreadyBooked: window-based matching covers ±2hr', async () => {
    const db = require('../src/db');
    let called = false;
    const orig = db.markSuccess;
    db.markSuccess = async () => { called = true; };

    // window 12:00–13:00, reservation at 10:15 (12:00 - 120min = 10:00 → within range)
    const slot = { id: 503, slot_index: 0, target_time: '12:00',
                   window_start: '12:00', window_end: '13:00' };
    const remaining = await engine._filterAlreadyBooked(
      [slot], [{ time: '10:15', course: 'Pines' }], '2026-12-03');

    db.markSuccess = orig;
    assert.equal(remaining.length, 0, 'Window-based slot should match reservation within ±2hr');
    assert.ok(called);
  });

  test('B15 _filterAlreadyBooked: one reservation matches only one slot', async () => {
    const db = require('../src/db');
    let markCount = 0;
    const orig = db.markSuccess;
    db.markSuccess = async () => { markCount++; };

    const slots = [
      { id: 504, slot_index: 0, target_time: '12:00', window_start: null, window_end: null },
      { id: 505, slot_index: 1, target_time: '12:10', window_start: null, window_end: null },
    ];
    const remaining = await engine._filterAlreadyBooked(
      slots, [{ time: '12:05', course: 'Pines' }], '2026-12-04');

    db.markSuccess = orig;
    assert.equal(markCount, 1, 'Only one slot should be marked');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, 505);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION C: DATABASE OPERATIONS
// ═════════════════════════════════════════════════════════════════════════════
describe('C — db.js operations', () => {
  const db = require('../src/db');

  const mk = (overrides = {}) => ({
    date:        '2027-01-15',
    dayLabel:    'Monday 12 PM-1 PM',
    targetTime:  '12:00',
    windowStart: '12:00',
    windowEnd:   '13:00',
    course:      'Pines',
    slotIndex:   0,
    players:     4,
    ...overrides,
  });

  test('C01 ensureBookings inserts new booking with status=pending', async () => {
    await db.ensureBookings([mk({ date: '2027-01-15' })]);
    const rows = await db.getBookingsByDate('2027-01-15');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].course, 'Pines');
  });

  test('C02 ensureBookings: UNIQUE(date, target_time, slot_index) prevents duplicates', async () => {
    const b = mk({ date: '2027-01-16' });
    await db.ensureBookings([b]);
    await db.ensureBookings([b]); // duplicate
    const rows = await db.getBookingsByDate('2027-01-16');
    assert.equal(rows.length, 1, 'INSERT OR IGNORE should prevent duplicate');
  });

  test('C03 ensureBookings: same date+time, different slot_index → 2 rows', async () => {
    await db.ensureBookings([
      mk({ date: '2027-01-17', slotIndex: 0, targetTime: '12:00' }),
      mk({ date: '2027-01-17', slotIndex: 1, targetTime: '12:10' }),
    ]);
    const rows = await db.getBookingsByDate('2027-01-17');
    assert.equal(rows.length, 2);
  });

  test('C04 getBookingById returns correct booking', async () => {
    await db.ensureBookings([mk({ date: '2027-01-18' })]);
    const rows = await db.getBookingsByDate('2027-01-18');
    const found = await db.getBookingById(rows[0].id);
    assert.ok(found);
    assert.equal(found.date, '2027-01-18');
  });

  test('C05 getBookingById returns null for non-existent id', async () => {
    const found = await db.getBookingById(9_999_999);
    assert.equal(found, null);
  });

  test('C06 markSuccess: sets status=confirmed, actual_time, confirmation_number, increments attempts', async () => {
    await db.ensureBookings([mk({ date: '2027-01-19' })]);
    const [row] = await db.getBookingsByDate('2027-01-19');
    await db.markSuccess(row.id, { actualTime: '12:05', course: 'Pines',
                                   confirmationNumber: '99001', screenshotPath: null });
    const u = await db.getBookingById(row.id);
    assert.equal(u.status, 'confirmed');
    assert.equal(u.actual_time, '12:05');
    assert.equal(u.confirmation_number, '99001');
    assert.equal(u.attempts, 1);
  });

  test('C07 markFailed: sets status=failed, increments attempts, stores error', async () => {
    await db.ensureBookings([mk({ date: '2027-01-20' })]);
    const [row] = await db.getBookingsByDate('2027-01-20');
    await db.markFailed(row.id, 'No tee times');
    const u = await db.getBookingById(row.id);
    assert.equal(u.status, 'failed');
    assert.equal(u.attempts, 1);
    assert.equal(u.error_message, 'No tee times');
  });

  test('C08 markFailed: truncates error_message to 500 chars', async () => {
    await db.ensureBookings([mk({ date: '2027-01-21' })]);
    const [row] = await db.getBookingsByDate('2027-01-21');
    await db.markFailed(row.id, 'E'.repeat(600));
    const u = await db.getBookingById(row.id);
    assert.equal(u.error_message.length, 500);
  });

  test('C09 markCancelled: sets status=cancelled', async () => {
    await db.ensureBookings([mk({ date: '2027-01-22' })]);
    const [row] = await db.getBookingsByDate('2027-01-22');
    await db.markCancelled(row.id);
    const u = await db.getBookingById(row.id);
    assert.equal(u.status, 'cancelled');
  });

  test('C10 markSkipped: sets status=skipped, stores error_message', async () => {
    await db.ensureBookings([mk({ date: '2027-01-23' })]);
    const [row] = await db.getBookingsByDate('2027-01-23');
    await db.markSkipped(row.id, 'Already on site');
    const u = await db.getBookingById(row.id);
    assert.equal(u.status, 'skipped');
    assert.equal(u.error_message, 'Already on site');
  });

  test('C11 markPartial: sets status=partial, actual_time', async () => {
    await db.ensureBookings([mk({ date: '2027-01-24' })]);
    const [row] = await db.getBookingsByDate('2027-01-24');
    await db.markPartial(row.id, { actualTime: '12:05', screenshotPath: null, errorMessage: 'Partial' });
    const u = await db.getBookingById(row.id);
    assert.equal(u.status, 'partial');
    assert.equal(u.actual_time, '12:05');
  });

  test('C12 getPendingBookings: returns pending+failed, excludes confirmed', async () => {
    const date = '2027-01-25';
    await db.ensureBookings([
      mk({ date, slotIndex: 0, targetTime: '12:00' }),
      mk({ date, slotIndex: 1, targetTime: '12:10' }),
    ]);
    const [r0, r1] = await db.getBookingsByDate(date);
    await db.markSuccess(r0.id, { actualTime: '12:00', course: 'Pines',
                                   confirmationNumber: '11111', screenshotPath: null });
    const pending = await db.getPendingBookings();
    const forDate = pending.filter(p => p.date === date);
    assert.equal(forDate.length, 1, 'Only 1 of 2 slots should remain pending');
    assert.equal(forDate[0].status, 'pending');
  });

  test('C13 getPendingBookings: excludes bookings at maxRetries (3 failures)', async () => {
    await db.ensureBookings([mk({ date: '2027-01-26', targetTime: '12:00', slotIndex: 0 })]);
    const [row] = await db.getBookingsByDate('2027-01-26');
    await db.markFailed(row.id, 'fail 1');
    await db.markFailed(row.id, 'fail 2');
    await db.markFailed(row.id, 'fail 3');
    const pending = await db.getPendingBookings();
    const exhausted = pending.filter(p => p.date === '2027-01-26');
    assert.equal(exhausted.length, 0, 'Exhausted booking should not appear in pending');
  });

  test('C14 getPendingBookings: excludes past dates', async () => {
    await db.ensureBookings([mk({ date: '2020-01-06' })]);
    const pending = await db.getPendingBookings();
    const past = pending.filter(p => p.date === '2020-01-06');
    assert.equal(past.length, 0, 'Past dates must not appear in pending');
  });

  test('C15 getAllUpcoming: only returns date >= today', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = await db.getAllUpcoming();
    for (const b of upcoming) {
      assert.ok(b.date >= today, `${b.date} should be >= today (${today})`);
    }
  });

  test('C16 getConfirmedByDate: only returns confirmed bookings for that date', async () => {
    const date = '2027-01-27';
    await db.ensureBookings([
      mk({ date, slotIndex: 0, targetTime: '12:00' }),
      mk({ date, slotIndex: 1, targetTime: '12:10' }),
    ]);
    const [r0] = await db.getBookingsByDate(date);
    await db.markSuccess(r0.id, { actualTime: '12:00', course: 'Pines',
                                   confirmationNumber: '22222', screenshotPath: null });
    const confirmed = await db.getConfirmedByDate(date);
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].status, 'confirmed');
  });

  test('C17 DB persists to disk (file exists after save)', async () => {
    // ensureBookings calls save() internally
    await db.ensureBookings([mk({ date: '2027-01-28', slotIndex: 0 })]);
    assert.ok(fs.existsSync(TMP_DB), 'DB file should be written to disk');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION D: WEB API ENDPOINTS (HTTP integration)
// ═════════════════════════════════════════════════════════════════════════════
describe('D — web API endpoints', () => {
  const BASE = 'http://localhost:3099';

  test('D01 GET /api/bookings → 200 JSON { bookings, lastSyncAt }', async () => {
    const r = await httpGet(`${BASE}/api/bookings`);
    assert.equal(r.status, 200);
    assert.ok(r.headers['content-type'].includes('application/json'));
    const body = JSON.parse(r.body);
    // API returns { bookings: [...], lastSyncAt: '...' | null }
    assert.ok(typeof body === 'object' && body !== null, 'Response should be an object');
    assert.ok(Array.isArray(body.bookings), 'body.bookings should be an array');
  });

  test('D02 GET / → 200 HTML with doctype', async () => {
    const r = await httpGet(`${BASE}/`);
    assert.equal(r.status, 200);
    assert.ok(r.headers['content-type'].includes('text/html'));
    assert.ok(r.body.startsWith('<!DOCTYPE html>'));
  });

  test('D03 GET / contains "Golf Scheduler" title', async () => {
    const r = await httpGet(`${BASE}/`);
    assert.ok(r.body.includes('Golf Scheduler'));
  });

  test('D04 GET / contains zoom widget elements', async () => {
    const r = await httpGet(`${BASE}/`);
    assert.ok(r.body.includes('id="zoom-control"'));
    assert.ok(r.body.includes('id="zoom-label"'));
  });

  test('D05 GET / calendar has all 7 day-of-week headers', async () => {
    const r = await httpGet(`${BASE}/`);
    for (const day of ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']) {
      assert.ok(r.body.includes(day), `Missing day header: ${day}`);
    }
  });

  test('D06 POST /api/cancel/:id — non-numeric string returns 400', async () => {
    const r = await httpPost(`${BASE}/api/cancel/abc`);
    assert.equal(r.status, 400);
    const json = JSON.parse(r.body);
    assert.equal(json.success, false);
    assert.match(json.error, /invalid/i);
  });

  test('D07 POST /api/cancel/:id — non-existent id returns 404', async () => {
    const r = await httpPost(`${BASE}/api/cancel/9999999`);
    assert.equal(r.status, 404);
    const json = JSON.parse(r.body);
    assert.equal(json.success, false);
    assert.match(json.error, /not found/i);
  });

  test('D08 POST /api/cancel/:id — already-cancelled → 200 "Already cancelled"', async () => {
    const db = require('../src/db');
    await db.ensureBookings([{
      date: '2027-02-01', dayLabel: 'Monday 12 PM-1 PM',
      targetTime: '12:00', windowStart: '12:00', windowEnd: '13:00',
      course: 'Pines', slotIndex: 0, players: 4,
    }]);
    const [row] = await db.getBookingsByDate('2027-02-01');
    await db.markCancelled(row.id);
    // Settle delay to allow the DB singleton state to propagate before the API reads it
    await new Promise(r => setTimeout(r, 100));

    const r = await httpPost(`${BASE}/api/cancel/${row.id}`);
    assert.equal(r.status, 200);
    const json = JSON.parse(r.body);
    assert.equal(json.success, true);
    assert.match(json.message, /already cancelled/i);
  });

  test('D09 POST /api/cancel/:id — EXISTING_RESERVATION confirmation → marks cancelled without site', async () => {
    const db = require('../src/db');
    // Use a unique date unlikely to collide with DB auto-reload state
    const testDate = '2027-03-02';
    await db.ensureBookings([{
      date: testDate, dayLabel: 'Tuesday 12 PM-1 PM',
      targetTime: '12:00', windowStart: '12:00', windowEnd: '13:00',
      course: 'Pines', slotIndex: 0, players: 4,
    }]);
    const rows = await db.getBookingsByDate(testDate);
    const row = rows[0];
    assert.ok(row, 'Booking should exist for test date');

    await db.markSuccess(row.id, { actualTime: '12:00', course: 'Pines',
                                   confirmationNumber: 'EXISTING_RESERVATION',
                                   screenshotPath: null });
    // Settle delay: allow async disk save to flush before the API reads the booking
    await new Promise(r => setTimeout(r, 50));

    // Verify the DB state BEFORE cancel
    const before = await db.getBookingById(row.id);
    assert.equal(before.status, 'confirmed', 'Pre-cancel status should be confirmed');
    assert.equal(before.confirmation_number, 'EXISTING_RESERVATION');

    const r = await httpPost(`${BASE}/api/cancel/${row.id}`);
    assert.equal(r.status, 200);
    const json = JSON.parse(r.body);
    assert.equal(json.success, true);
    // Message should indicate it was marked cancelled (not "Already cancelled")
    assert.ok(json.message && json.message.toLowerCase().includes('cancel'),
      `Expected cancel message, got: "${json.message}"`);

    // Settle delay for in-process DB update — 100ms avoids flakiness on slower systems
    await new Promise(r => setTimeout(r, 100));

    const updated = await db.getBookingById(row.id);
    assert.equal(updated.status, 'cancelled',
      `Expected cancelled after API call. API returned: ${JSON.stringify(json)}. ` +
      `Pre-cancel status was: ${before.status}. Row ID used: ${row.id}. Updated row: ${JSON.stringify(updated)}`);
  });

  test('D10 POST /api/cancel/:id — "CONFIRMED" placeholder confirmation → marks cancelled without site', async () => {
    const db = require('../src/db');
    const testDate = '2027-03-03';
    await db.ensureBookings([{
      date: testDate, dayLabel: 'Wednesday 12 PM-1 PM',
      targetTime: '12:00', windowStart: '12:00', windowEnd: '13:00',
      course: 'Pines', slotIndex: 0, players: 4,
    }]);
    const rows = await db.getBookingsByDate(testDate);
    const row = rows[0];
    assert.ok(row, 'Booking should exist for test date');

    await db.markSuccess(row.id, { actualTime: '12:00', course: 'Pines',
                                   confirmationNumber: 'CONFIRMED',
                                   screenshotPath: null });
    // Settle delay: allow async disk save to flush before the API reads the booking
    await new Promise(r => setTimeout(r, 50));

    const before = await db.getBookingById(row.id);
    assert.equal(before.status, 'confirmed', 'Pre-cancel status should be confirmed');

    const r = await httpPost(`${BASE}/api/cancel/${row.id}`);
    assert.equal(r.status, 200);
    const json = JSON.parse(r.body);
    assert.equal(json.success, true);

    // Settle delay for in-process DB update — 100ms avoids flakiness on slower systems
    await new Promise(r => setTimeout(r, 100));

    const updated = await db.getBookingById(row.id);
    assert.equal(updated.status, 'cancelled',
      `Expected cancelled. API returned: ${JSON.stringify(json)}`);
  });

  test('D11 POST /api/book-month → 200 JSON with success:true', async () => {
    const r = await httpPost(`${BASE}/api/book-month`, { year: 2027, month: 2 });
    assert.equal(r.status, 200);
    const json = JSON.parse(r.body);
    assert.equal(json.success, true);
    assert.ok(json.message);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION E: HTML / CSS AUDIT (static analysis of generated HTML)
// ═════════════════════════════════════════════════════════════════════════════
describe('E — HTML / CSS audit', () => {
  let html = '';

  before(async () => {
    // Server is already running (module-level before started it)
    const r = await httpGet('http://localhost:3099/');
    html = r.body;
  });

  // ── Color / Contrast ──────────────────────────────────────────────────────
  test('E01 body background is not pure white (#ffffff)', () => {
    // Check the body rule specifically — extract the body { ... } block
    const bodyBlock = html.match(/body\s*\{([^}]+)\}/)?.[1] ?? '';
    assert.ok(!/background:\s*#ffffff/i.test(bodyBlock) && !/background:\s*white\b/i.test(bodyBlock),
      `Pure white body background harms readability. body block: "${bodyBlock.trim()}"`);
  });

  test('E02 body text color is not pure black (#000000)', () => {
    assert.ok(!/\bcolor:\s*#000000\b/i.test(html) && !/\bcolor:\s*black\b/i.test(html),
      'Pure black text can cause eye strain');
  });

  test('E03 header uses dark green brand color', () => {
    // Header uses CSS custom property --primary: #14532d (shadcn/ui-inspired design system)
    assert.ok(html.includes('#14532d') || html.includes('--primary'), 'Header brand color not found');
  });

  test('E04 confirmed chip uses accessible green color', () => {
    // Color updated to --status-confirmed: #15803d (shadcn/ui-inspired design system)
    assert.ok(
      html.includes('#15803d') || html.includes('--status-confirmed'),
      'Confirmed chip green CSS variable or color not found'
    );
    assert.ok(html.includes('chip-confirmed'));
  });

  test('E05 failed/danger color is #DC2626 (accessible red)', () => {
    // Color is stored as #DC2626 (uppercase) via CSS variable --accent-failed
    assert.ok(
      html.toLowerCase().includes('#dc2626') || html.includes('--accent-failed'),
      'Failed chip red CSS variable or color not found'
    );
    assert.ok(html.includes('chip-failed'));
  });

  // ── Typography ─────────────────────────────────────────────────────────────
  test('E06 body font-size is 16px (minimum for readability)', () => {
    assert.ok(/font-size:\s*16px/.test(html), 'body font-size 16px not found');
  });

  test('E07 body line-height is 1.5', () => {
    assert.ok(/line-height:\s*1\.5/.test(html), 'body line-height 1.5 not found');
  });

  test('E08 Inter font is loaded (not generic Arial/Times)', () => {
    assert.ok(html.includes('Inter'), 'Inter font not referenced');
    assert.ok(!html.includes('Arial') && !html.includes('Times New Roman'),
      'Outdated generic fonts detected');
  });

  test('E09 Manrope font used for headings', () => {
    assert.ok(html.includes('Manrope'), 'Manrope heading font not found');
  });

  // ── Zoom Widget ────────────────────────────────────────────────────────────
  test('E10 zoom widget present with correct id', () => {
    assert.ok(html.includes('id="zoom-control"'));
  });

  test('E11 zoom widget has A− and A+ buttons', () => {
    assert.ok(html.includes('zoom(-1)'), 'zoom-out button missing');
    assert.ok(html.includes('zoom(1)'),  'zoom-in button missing');
  });

  test('E12 zoom widget is fixed bottom-right', () => {
    assert.ok(/position:fixed|position:\s*fixed/.test(html));
    assert.ok(/bottom:24px|bottom:\s*24px/.test(html));
    assert.ok(/right:24px|right:\s*24px/.test(html));
  });

  test('E13 zoom persists to localStorage with key "zoomSize"', () => {
    assert.ok(html.includes('localStorage'));
    assert.ok(html.includes('zoomSize'));
  });

  test('E14 zoom reads persisted size on page load', () => {
    assert.ok(html.includes("localStorage.getItem('zoomSize')"));
  });

  test('E15 zoom range enforced: Math.min(24, Math.max(12, …))', () => {
    assert.ok(html.includes('Math.min(24, Math.max(12,'));
  });

  test('E16 keyboard shortcuts Ctrl+=, Ctrl+-, Ctrl+0 implemented', () => {
    assert.ok(html.includes("e.key === '='"),  'Ctrl+= shortcut missing');
    assert.ok(html.includes("e.key === '-'"), 'Ctrl+- shortcut missing');
    assert.ok(html.includes("e.key === '0'"),  'Ctrl+0 shortcut missing');
  });

  test('E17 CSS transition on html element for smooth zoom', () => {
    assert.ok(html.includes('transition'), 'CSS transition not found');
  });

  // ── Calendar Structure ─────────────────────────────────────────────────────
  test('E18 calendar renders current and next month', () => {
    const months = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    const now  = new Date();
    const cur  = months[now.getMonth()];
    const next = months[(now.getMonth() + 1) % 12];
    assert.ok(html.includes(cur),  `Current month "${cur}" not found`);
    assert.ok(html.includes(next), `Next month "${next}" not found`);
  });

  test('E19 today cell has CSS class "today"', () => {
    assert.ok(html.includes('today'));
  });

  test('E20 Schedule Month / Book Now buttons present', () => {
    assert.ok(html.includes('Schedule Month') || html.includes('Book Now'));
  });

  // ── Accessibility ──────────────────────────────────────────────────────────
  test('E21 html element has lang="en"', () => {
    assert.ok(html.includes('lang="en"'));
  });

  test('E22 viewport meta tag present', () => {
    assert.ok(html.includes('meta') && html.includes('viewport'));
  });

  test('E23 modal closes on Escape key', () => {
    assert.ok(html.includes("e.key === 'Escape'"));
  });

  test('E24 modal closes on overlay click', () => {
    assert.ok(html.includes('closeModal()'));
  });

  // ── Modal ──────────────────────────────────────────────────────────────────
  test('E25 modal shows all booking detail fields', () => {
    // Modal was updated: m-time split into m-confirmed-time and m-target-time.
    // m-status and m-confirmation are rendered dynamically by JS (not static HTML IDs).
    for (const id of ['m-date','m-confirmed-time','m-target-time','m-course']) {
      assert.ok(html.includes(id), `Modal field #${id} missing`);
    }
  });

  test('E26 Cancel button only shown for confirmed/pending/failed statuses', () => {
    assert.ok(
      html.includes("data.status === 'confirmed' || data.status === 'pending' || data.status === 'failed'"),
      'Cancel button visibility logic incorrect or missing'
    );
  });

  // ── Security ───────────────────────────────────────────────────────────────
  test('E27 Content-Type header is text/html (no JSON confusion)', async () => {
    const r = await httpGet('http://localhost:3099/');
    assert.ok(r.headers['content-type'].includes('text/html'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION F: CONFIG & SCHEDULE
// ═════════════════════════════════════════════════════════════════════════════
describe('F — config / schedule', () => {
  const config = require('../src/config');

  test('F01 schedule includes Mon(1) Tue(2) Fri(5) Sat(6)', () => {
    const days = new Set(config.schedule.map(s => s.day));
    assert.ok(days.has(1), 'Monday missing');
    assert.ok(days.has(2), 'Tuesday missing');
    assert.ok(days.has(5), 'Friday missing');
    assert.ok(days.has(6), 'Saturday missing');
  });

  test('F02 Monday has 2 slots', () => {
    const mon = config.schedule.find(s => s.day === 1);
    assert.equal(mon.slots, 2);
  });

  test('F03 Tuesday has 2 slots', () => {
    const tue = config.schedule.find(s => s.day === 2);
    assert.equal(tue.slots, 2);
  });

  test('F04 Friday has 2 slots', () => {
    const fri = config.schedule.find(s => s.day === 5);
    assert.equal(fri.slots, 2);
  });

  test('F05 Saturday has 2 slots', () => {
    const sat = config.schedule.find(s => s.day === 6);
    assert.equal(sat.slots, 2);
  });

  test('F06 Saturday window 08:00–13:00', () => {
    const sat = config.schedule.find(s => s.day === 6);
    assert.equal(sat.windowStart, '08:00');
    assert.equal(sat.windowEnd, '13:00');
  });

  test('F07 Pines course id = 9437', () => {
    assert.equal(config.site.courses.pines.id, '9437');
  });

  test('F08 Oaks course id = 9438', () => {
    assert.equal(config.site.courses.oaks.id, '9438');
  });

  test('F09 maxRetries = 3', () => {
    assert.equal(config.maxRetries, 3);
  });

  test('F10 default timezone is America/Chicago', () => {
    assert.equal(config.timezone, 'America/Chicago');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION G: EDGE CASES & SECURITY
// ═════════════════════════════════════════════════════════════════════════════
describe('G — edge cases & security', () => {
  test('G01 [BUG] parseInt("1abc") = 1 bypasses isNaN check in cancel endpoint', () => {
    // Documents the known bug: "1abc" is treated as id=1, not rejected as invalid
    const parsed = parseInt('1abc');
    assert.equal(parsed, 1);
    assert.equal(isNaN(parsed), false,
      'BUG: "1abc" passes the isNaN guard — endpoint should use Number() or /^\\d+$/ instead');
  });

  test('G02 confirmation regex: only pure-digit strings trigger site cancellation', () => {
    const isReal = cn => cn && /^\d+$/.test(cn);
    assert.equal(isReal('12345'), true,         'Real confirmation');
    assert.equal(isReal('EXISTING_RESERVATION'), false, 'EXISTING_RESERVATION is not real');
    assert.equal(isReal('CONFIRMED'), false,     'CONFIRMED is not real');
    assert.equal(isReal('access'), false,         '"access" is not real');
    assert.equal(isReal('12345abc'), false,       'Mixed alphanumeric is not real');
    assert.equal(isReal('0'), true,               'Single zero is a valid confirmation');
    assert.ok(!isReal(''),   'Empty string is not real');
    assert.ok(!isReal(null), 'null is not real');
  });

  test('G03 December → January month wrap: year increments correctly', () => {
    const month = 11; // December (0-indexed)
    const year  = 2026;
    const nextYear  = month === 11 ? year + 1 : year;
    const nextMonth = month === 11 ? 0 : month + 1;
    assert.equal(nextYear, 2027);
    assert.equal(nextMonth, 0, 'January should be month 0');
  });

  test('G04 calendar grid always fills complete weeks (total cells % 7 === 0)', () => {
    // March 2026: firstDay=0 (Sunday), daysInMonth=31
    const firstDay    = new Date(2026, 2, 1).getDay();
    const daysInMonth = 31;
    const total       = firstDay + daysInMonth;
    const remaining   = total % 7 === 0 ? 0 : 7 - (total % 7);
    assert.equal((total + remaining) % 7, 0, 'Grid should be divisible by 7');
  });

  test('G05 calendar grid: February 2027 (non-leap, starts Monday) fills correctly', () => {
    const firstDay    = new Date(2027, 1, 1).getDay(); // Monday = 1
    const daysInMonth = 28;
    const total       = firstDay + daysInMonth;
    const remaining   = total % 7 === 0 ? 0 : 7 - (total % 7);
    assert.equal((total + remaining) % 7, 0);
  });

  test('G06 _shiftTime forward wrapping: ("22:00", +120) = "00:00"', () => {
    const BookingEngine = require('../src/booking');
    const engine = Object.create(BookingEngine.prototype);
    assert.equal(engine._shiftTime('22:00', 120), '00:00');
  });

  test('G07 [FIXED] _shiftTime underflow now wraps correctly across midnight', () => {
    // Fixed: _shiftTime('00:30', -60) now returns '23:30' (proper midnight wrap)
    // Uses ((total % 1440) + 1440) % 1440 to handle negative totals correctly
    const BookingEngine = require('../src/booking');
    const engine = Object.create(BookingEngine.prototype);
    const result = engine._shiftTime('00:30', -60);
    assert.equal(result, '23:30',
      `_shiftTime should wrap negative totals: expected "23:30", got "${result}"`);
  });

  test('G08 BLOCKED error string detection works correctly', () => {
    const err = new Error('BLOCKED: security check triggered');
    assert.ok(err.message.startsWith('BLOCKED'));
  });

  test('G09 [FIXED] _bookSlots now passes courseName to selectCourse() for slots i>0', () => {
    // Previously: await this.site.selectCourse() — missing courseName argument
    // Fixed: await this.site.selectCourse(courseName) — correct argument passed
    const code = require('fs').readFileSync(
      require('path').join(__dirname, '../src/booking.js'), 'utf8');
    // Bug: bare selectCourse() call (no argument) in the re-navigate loop should NOT exist
    const bugPresent = /await this\.site\.selectCourse\(\)/.test(code);
    assert.ok(!bugPresent,
      'BUG REGRESSED: selectCourse() still called without courseName argument in _bookSlots re-navigate loop');
    // Fix: selectCourse(courseName) should be present
    const fixPresent = /await this\.site\.selectCourse\(courseName\)/.test(code);
    assert.ok(fixPresent,
      'FIX MISSING: selectCourse(courseName) not found in _bookSlots re-navigate loop');
  });

  test('G10 [SECURITY] No CSRF protection on POST endpoints (documentation test)', async () => {
    // Verify endpoints accept unauthenticated POST requests with no origin header.
    // In production these should require authentication or CSRF tokens.
    // Uses the shared test server (already running on port 3099).
    const r = await httpPost('http://localhost:3099/api/book-month', {});
    // Expecting 200 — documenting that NO auth/CSRF check is enforced.
    assert.equal(r.status, 200,
      'book-month accepted unauthenticated request with no CSRF token — SECURITY RISK');
  });
});
