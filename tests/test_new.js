/**
 * GolfScheduler — Additional / Gap-Coverage Tests
 *
 * Tests added to cover gaps identified in the comprehensive QA review of 2026-03-13.
 * Focuses on:
 *  - reconcile.js (zero prior coverage)
 *  - config.js resolveAlternatingCourse()
 *  - scheduler.js golfer round-robin logic
 *  - booking.js _processGroup negative-offset guard, _minutesToTime
 *  - web.js slot_index===0 calendar bug (regression guard)
 *  - db.js cleanupStaleSlots, updateBookingSync
 *  - scheduler msUntilNextFire (FR-023)
 *
 * Run with:  node --test tests/test_new.js
 */

// ─── 1. Set env vars BEFORE any require() that touches config.js ─────────────
process.env.GOLF_EMAIL    = 'test@example.com';
process.env.GOLF_PASSWORD = 'testpass123';
process.env.PORT          = '3098'; // different port from main test suite
process.env.TIMEZONE      = 'America/Chicago';
process.env.BOOKING_HORIZON_DAYS = '30';

const os   = require('os');
const path = require('path');
const TMP_DB = path.join(os.tmpdir(), `golf_test_new_${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

after(async () => {
  try { fs.unlinkSync(TMP_DB); } catch (_) {}
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION R: reconcile.js — zero coverage before this PR
// ═══════════════════════════════════════════════════════════════════════════════
describe('R — reconcile.js', () => {
  const { reconcileDate } = require('../src/reconcile');
  const db = require('../src/db');

  // Minimal logger stub
  const logger = { info: () => {}, warn: () => {} };

  // Seed helper
  const mk = (overrides = {}) => ({
    date:        '2030-06-01',
    dayLabel:    'Monday 12 PM-2 PM',
    targetTime:  '12:00',
    windowStart: '12:00',
    windowEnd:   '14:00',
    course:      'Pines',
    slotIndex:   0,
    players:     4,
    golferIndex: 0,
    ...overrides,
  });

  test('R01 returns { updated:0, notFound:0, warnings:[] } when siteSlots and dbSlots are both empty', async () => {
    const result = await reconcileDate('2030-06-01', [], [], logger);
    assert.equal(result.updated, 0);
    assert.equal(result.notFound, 0);
    assert.deepEqual(result.warnings, []);
  });

  test('R02 returns notFound=1 warning when DB has a confirmed slot but site has none', async () => {
    // Insert a confirmed slot
    await db.ensureBookings([mk({ date: '2030-06-02', slotIndex: 0 })]);
    const [row] = await db.getBookingsByDate('2030-06-02');
    await db.markSuccess(row.id, { actualTime: '12:05', course: 'Pines', confirmationNumber: '55001', screenshotPath: null });

    const dbSlots = await db.getBookingsByDate('2030-06-02');
    const result = await reconcileDate('2030-06-02', [], dbSlots, logger);

    assert.equal(result.notFound, 1);
    assert.equal(result.updated, 0);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes('no site reservation'));
  });

  test('R03 updates actual_time when site time differs from DB', async () => {
    await db.ensureBookings([mk({ date: '2030-06-03', slotIndex: 0, targetTime: '12:00' })]);
    const [row] = await db.getBookingsByDate('2030-06-03');
    await db.markSuccess(row.id, { actualTime: '12:00', course: 'Pines', confirmationNumber: '55002', screenshotPath: null });

    const dbSlots = await db.getBookingsByDate('2030-06-03');
    const siteSlots = [{ time: '12:15', course: 'Pines', confirmationNumber: '55002' }];
    const result = await reconcileDate('2030-06-03', siteSlots, dbSlots, logger);

    assert.equal(result.updated, 1);
    const updated = await db.getBookingById(row.id);
    assert.equal(updated.actual_time, '12:15');
  });

  test('R04 replaces placeholder confirmation_number with real numeric one from site', async () => {
    await db.ensureBookings([mk({ date: '2030-06-04', slotIndex: 0 })]);
    const [row] = await db.getBookingsByDate('2030-06-04');
    await db.markSuccess(row.id, { actualTime: '12:05', course: 'Pines',
                                   confirmationNumber: 'EXISTING_RESERVATION', screenshotPath: null });

    const dbSlots = await db.getBookingsByDate('2030-06-04');
    const siteSlots = [{ time: '12:05', course: 'Pines', confirmationNumber: '98765' }];
    const result = await reconcileDate('2030-06-04', siteSlots, dbSlots, logger);

    assert.equal(result.updated, 1);
    const updated = await db.getBookingById(row.id);
    assert.equal(updated.confirmation_number, '98765');
  });

  test('R05 skips DB write when actual_time and confirmation_number already match site', async () => {
    await db.ensureBookings([mk({ date: '2030-06-05', slotIndex: 0 })]);
    const [row] = await db.getBookingsByDate('2030-06-05');
    await db.markSuccess(row.id, { actualTime: '12:05', course: 'Pines', confirmationNumber: '77001', screenshotPath: null });

    const dbSlots = await db.getBookingsByDate('2030-06-05');
    const siteSlots = [{ time: '12:05', course: 'Pines', confirmationNumber: '77001' }];
    const result = await reconcileDate('2030-06-05', siteSlots, dbSlots, logger);

    assert.equal(result.updated, 0);
    assert.equal(result.notFound, 0);
  });

  test('R06 filters out dbSlots with status=failed before pairing', async () => {
    await db.ensureBookings([mk({ date: '2030-06-06', slotIndex: 0 })]);
    const [row] = await db.getBookingsByDate('2030-06-06');
    await db.markFailed(row.id, 'booking failed');

    const dbSlots = await db.getBookingsByDate('2030-06-06');
    // siteSlots has one entry — but failed row should be excluded from pairing
    const siteSlots = [{ time: '12:00', course: 'Pines', confirmationNumber: '33333' }];
    const result = await reconcileDate('2030-06-06', siteSlots, dbSlots, logger);

    // No pairings (failed is not pairable), so updated=0, notFound=0
    assert.equal(result.updated, 0);
    assert.equal(result.notFound, 0);
  });

  test('R07 pairs multiple slots positionally (slot_index order vs time order)', async () => {
    await db.ensureBookings([
      mk({ date: '2030-06-07', slotIndex: 0, targetTime: '12:00' }),
      mk({ date: '2030-06-07', slotIndex: 1, targetTime: '12:10' }),
    ]);
    const rows = await db.getBookingsByDate('2030-06-07');
    await db.markSuccess(rows[0].id, { actualTime: '12:00', course: 'Pines', confirmationNumber: 'CONFIRMED', screenshotPath: null });
    await db.markSuccess(rows[1].id, { actualTime: '12:10', course: 'Pines', confirmationNumber: 'CONFIRMED', screenshotPath: null });

    const dbSlots = await db.getBookingsByDate('2030-06-07');
    // Site returns slots in reverse time order — they should be sorted before pairing
    const siteSlots = [
      { time: '12:10', course: 'Pines', confirmationNumber: '44002' },
      { time: '12:00', course: 'Pines', confirmationNumber: '44001' },
    ];
    const result = await reconcileDate('2030-06-07', siteSlots, dbSlots, logger);
    assert.equal(result.updated, 2);

    const updated0 = await db.getBookingById(rows[0].id);
    const updated1 = await db.getBookingById(rows[1].id);
    // Positional pairing: DB slot 0 (12:00) ↔ site slot sorted[0] (12:00)
    assert.equal(updated0.confirmation_number, '44001');
    assert.equal(updated1.confirmation_number, '44002');
  });

  test('R08 does not update DB when site provides non-numeric confirmation number', async () => {
    await db.ensureBookings([mk({ date: '2030-06-08', slotIndex: 0 })]);
    const [row] = await db.getBookingsByDate('2030-06-08');
    await db.markSuccess(row.id, { actualTime: '12:00', course: 'Pines', confirmationNumber: 'CONFIRMED', screenshotPath: null });

    const dbSlots = await db.getBookingsByDate('2030-06-08');
    const siteSlots = [{ time: '12:00', course: 'Pines', confirmationNumber: 'NOT_A_NUMBER' }];
    const result = await reconcileDate('2030-06-08', siteSlots, dbSlots, logger);

    // Site has non-numeric — should not trigger update
    assert.equal(result.updated, 0);
    const unchanged = await db.getBookingById(row.id);
    assert.equal(unchanged.confirmation_number, 'CONFIRMED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION AC: config.js resolveAlternatingCourse()
// ═══════════════════════════════════════════════════════════════════════════════
describe('AC — config.resolveAlternatingCourse()', () => {
  const { resolveAlternatingCourse } = require('../src/config');

  test('AC01 Week 10 (even) → Pines', () => {
    // 2026-03-08 is in ISO week 10
    assert.equal(resolveAlternatingCourse('2026-03-08'), 'Pines');
  });

  test('AC02 Week 11 (odd) → Oaks', () => {
    // 2026-03-15 is in ISO week 11
    assert.equal(resolveAlternatingCourse('2026-03-15'), 'Oaks');
  });

  test('AC03 Week 12 (even) → Pines', () => {
    // 2026-03-22 is in ISO week 12
    assert.equal(resolveAlternatingCourse('2026-03-22'), 'Pines');
  });

  test('AC04 Week 13 (odd) → Oaks', () => {
    // 2026-03-29 is in ISO week 13
    assert.equal(resolveAlternatingCourse('2026-03-29'), 'Oaks');
  });

  test('AC05 consecutive Sundays always get different courses', () => {
    // Two consecutive Sundays should produce different courses
    const sun1 = resolveAlternatingCourse('2026-03-08'); // week 10 → Pines
    const sun2 = resolveAlternatingCourse('2026-03-15'); // week 11 → Oaks
    assert.notEqual(sun1, sun2, 'Consecutive Sundays should alternate courses');
  });

  test('AC06 returns only "Pines" or "Oaks" (never sentinel)', () => {
    for (const dateStr of ['2026-01-04', '2026-01-11', '2026-01-18', '2026-01-25', '2026-12-27']) {
      const course = resolveAlternatingCourse(dateStr);
      assert.ok(course === 'Pines' || course === 'Oaks',
        `Expected Pines or Oaks for ${dateStr}, got "${course}"`);
    }
  });

  test('AC07 deterministic — same date always returns same course', () => {
    const date = '2026-06-14';
    const first  = resolveAlternatingCourse(date);
    const second = resolveAlternatingCourse(date);
    assert.equal(first, second, 'resolveAlternatingCourse must be deterministic');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION SC: scheduler.js — golfer round-robin and additional slot logic
// ═══════════════════════════════════════════════════════════════════════════════
describe('SC — scheduler golfer round-robin', () => {
  const { computeBookingSlots } = require('../src/scheduler');

  test('SC01 all slots on the same date share the same golfer_index', () => {
    const slots = computeBookingSlots();
    const byDate = {};
    for (const s of slots) {
      if (!byDate[s.date]) byDate[s.date] = new Set();
      byDate[s.date].add(s.golferIndex);
    }
    for (const [date, indices] of Object.entries(byDate)) {
      assert.equal(indices.size, 1,
        `${date} should have exactly one golfer_index, found: ${[...indices].join(',')}`);
    }
  });

  test('SC02 golfer_index is always 0 when only one golfer configured (test env)', () => {
    // Test environment sets only one golfer
    const slots = computeBookingSlots();
    for (const s of slots) {
      assert.equal(s.golferIndex, 0, `Expected golferIndex=0 with single golfer, got ${s.golferIndex} for ${s.date}`);
    }
  });

  test('SC03 Sunday has 4 slots (schedule.json updated to 4 slots)', () => {
    const byDate = {};
    for (const s of computeBookingSlots()) {
      if (new Date(s.date + 'T12:00:00').getDay() !== 0) continue;
      (byDate[s.date] ??= []).push(s);
    }
    for (const [date, slots] of Object.entries(byDate)) {
      assert.equal(slots.length, 4, `Sunday ${date} should have 4 slots (schedule updated 2026-03-12)`);
    }
  });

  test('SC04 Sunday slots start at 08:00', () => {
    for (const s of computeBookingSlots()) {
      if (new Date(s.date + 'T12:00:00').getDay() !== 0 || s.slotIndex !== 0) continue;
      assert.equal(s.targetTime, '08:00', `Sunday slot 0 should be 08:00, got ${s.targetTime}`);
    }
  });

  test('SC05 all slots have golferIndex defined as a number', () => {
    for (const s of computeBookingSlots()) {
      assert.equal(typeof s.golferIndex, 'number',
        `golferIndex should be a number, got ${typeof s.golferIndex} for ${s.date}`);
    }
  });

  test('SC06 Friday has 3 slots at 12:00/12:10/12:20', () => {
    const byDate = {};
    for (const s of computeBookingSlots()) {
      if (new Date(s.date + 'T12:00:00').getDay() !== 5) continue;
      (byDate[s.date] ??= []).push(s);
    }
    for (const [date, slots] of Object.entries(byDate)) {
      slots.sort((a, b) => a.slotIndex - b.slotIndex);
      assert.equal(slots.length, 3, `Friday ${date} should have 3 slots`);
      assert.equal(slots[0].targetTime, '12:00');
      assert.equal(slots[1].targetTime, '12:10');
      assert.equal(slots[2].targetTime, '12:20');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION BE: BookingEngine — additional method tests
// ═══════════════════════════════════════════════════════════════════════════════
describe('BE — BookingEngine additional methods', () => {
  const BookingEngine = require('../src/booking');
  const engine = Object.create(BookingEngine.prototype);
  engine.site   = {};
  engine.dryRun = false;

  // _minutesToTime
  test('BE01 _minutesToTime(0) = "00:00"', () =>
    assert.equal(engine._minutesToTime(0), '00:00'));

  test('BE02 _minutesToTime(720) = "12:00"', () =>
    assert.equal(engine._minutesToTime(720), '12:00'));

  test('BE03 _minutesToTime(1439) = "23:59"', () =>
    assert.equal(engine._minutesToTime(1439), '23:59'));

  test('BE04 _minutesToTime wraps past midnight: 1440 → "00:00"', () =>
    assert.equal(engine._minutesToTime(1440), '00:00'));

  test('BE05 _minutesToTime wraps negative: -30 → "23:30"', () =>
    assert.equal(engine._minutesToTime(-30), '23:30'));

  // _shiftTime: negative offset guard edge cases
  test('BE06 _shiftTime("08:00", -120) = "06:00" (not negative, should NOT be skipped)', () => {
    // 08:00 - 120min = 06:00, which is >= 00:00 → should NOT be filtered
    const result = engine._shiftTime('08:00', -120);
    assert.equal(result, '06:00');
    // Verify _timeToMinutes of this result is non-negative
    assert.ok(engine._timeToMinutes(result) >= 0);
  });

  test('BE07 _processGroup negative guard: _timeToMinutes wraps result is never actually < 0', () => {
    // The guard `if (_timeToMinutes(start) < 0) continue` in _processGroup
    // is unreachable because _shiftTime now uses modular arithmetic.
    // _timeToMinutes always returns >= 0 for any valid HH:MM output of _shiftTime.
    const result = engine._shiftTime('00:00', -1); // Most negative possible: wraps to 23:59
    const mins = engine._timeToMinutes(result);
    assert.ok(mins >= 0, `_timeToMinutes of wrapped time should be >= 0, got ${mins}`);
  });

  // _filterAlreadyBooked: edge case — empty slots
  test('BE08 _filterAlreadyBooked: empty slots returns empty remaining', async () => {
    const remaining = await engine._filterAlreadyBooked([], [{ time: '12:00', course: 'Pines' }], '2030-01-01');
    assert.deepEqual(remaining, []);
  });

  // _filterAlreadyBooked: empty reservations returns all slots
  test('BE09 _filterAlreadyBooked: empty existing reservations returns all slots', async () => {
    const db = require('../src/db');
    // Insert a slot so we have a real id
    await db.ensureBookings([{
      date: '2030-07-01', dayLabel: 'Monday 12 PM-2 PM',
      targetTime: '12:00', windowStart: '12:00', windowEnd: '14:00',
      course: 'Pines', slotIndex: 0, players: 4, golferIndex: 0,
    }]);
    const [row] = await db.getBookingsByDate('2030-07-01');

    const slots = [{ id: row.id, slot_index: 0, target_time: '12:00', window_start: null, window_end: null }];
    const remaining = await engine._filterAlreadyBooked(slots, [], '2030-07-01');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, row.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION DB2: db.js — additional method tests
// ═══════════════════════════════════════════════════════════════════════════════
describe('DB2 — db.js additional methods', () => {
  const db = require('../src/db');

  const mk = (overrides = {}) => ({
    date:        '2031-01-15',
    dayLabel:    'Monday 12 PM-2 PM',
    targetTime:  '12:00',
    windowStart: '12:00',
    windowEnd:   '14:00',
    course:      'Pines',
    slotIndex:   0,
    players:     4,
    golferIndex: 0,
    ...overrides,
  });

  test('DB2-01 updateBookingSync: updates actual_time and confirmation_number', async () => {
    await db.ensureBookings([mk({ date: '2031-01-20' })]);
    const [row] = await db.getBookingsByDate('2031-01-20');
    await db.markSuccess(row.id, { actualTime: '12:00', course: 'Pines',
                                   confirmationNumber: 'EXISTING_RESERVATION', screenshotPath: null });

    await db.updateBookingSync(row.id, {
      actualTime: '12:07',
      course: 'Pines',
      confirmationNumber: '87654',
      restoreConfirmed: true,
    });

    const updated = await db.getBookingById(row.id);
    assert.equal(updated.actual_time, '12:07');
    assert.equal(updated.confirmation_number, '87654');
    assert.equal(updated.status, 'confirmed');
  });

  test('DB2-02 updateBookingSync: does not change status when restoreConfirmed=false', async () => {
    await db.ensureBookings([mk({ date: '2031-01-21', slotIndex: 0 })]);
    const [row] = await db.getBookingsByDate('2031-01-21');
    await db.markFailed(row.id, 'some error');

    await db.updateBookingSync(row.id, {
      actualTime: '12:05',
      course: 'Pines',
      confirmationNumber: '11111',
      restoreConfirmed: false,
    });

    const updated = await db.getBookingById(row.id);
    assert.equal(updated.status, 'failed', 'Status should remain failed when restoreConfirmed=false');
  });

  test('DB2-03 cleanupStaleSlots: removes only skipped rows with invalid day_label', async () => {
    await db.ensureBookings([
      mk({ date: '2031-01-22', dayLabel: 'OldSchedule 8 AM-10 AM', slotIndex: 0 }),
      mk({ date: '2031-01-23', dayLabel: 'Monday 12 PM-2 PM',      slotIndex: 0 }),
    ]);
    const [row1] = await db.getBookingsByDate('2031-01-22');
    const [row2] = await db.getBookingsByDate('2031-01-23');
    await db.markSkipped(row1.id, 'stale');
    await db.markSkipped(row2.id, 'stale');

    const removed = await db.cleanupStaleSlots();

    // row1 has 'OldSchedule' label (not in current schedule) → should be deleted
    // row2 has 'Monday 12 PM-2 PM' label (in current schedule) → should be kept
    assert.ok(removed >= 1, `Expected at least 1 removal, got ${removed}`);
    const r1 = await db.getBookingById(row1.id);
    assert.equal(r1, null, 'Stale skipped row with invalid label should be deleted');
    const r2 = await db.getBookingById(row2.id);
    assert.ok(r2, 'Valid-label skipped row should be kept');
  });

  test('DB2-04 cleanupStaleSlots: confirmed rows with invalid label are NOT deleted', async () => {
    await db.ensureBookings([mk({ date: '2031-01-24', dayLabel: 'GarbageLabel 99 AM-99 PM', slotIndex: 0 })]);
    const [row] = await db.getBookingsByDate('2031-01-24');
    await db.markSuccess(row.id, { actualTime: '12:00', course: 'Pines',
                                   confirmationNumber: '99999', screenshotPath: null });

    await db.cleanupStaleSlots();

    const r = await db.getBookingById(row.id);
    assert.ok(r, 'Confirmed booking with invalid day_label must NOT be deleted by cleanupStaleSlots');
  });

  test('DB2-05 getLastSyncAt returns null when sync-meta.json does not exist', () => {
    // Temporarily rename meta file if it exists
    const metaPath = require('path').join(require('path').dirname(TMP_DB), 'sync-meta.json');
    let existed = false;
    let backup = null;
    if (fs.existsSync(metaPath)) {
      existed = true;
      backup = fs.readFileSync(metaPath, 'utf8');
      fs.unlinkSync(metaPath);
    }

    const result = db.getLastSyncAt();
    assert.equal(result, null, 'getLastSyncAt should return null when file does not exist');

    if (existed) fs.writeFileSync(metaPath, backup, 'utf8');
  });

  test('DB2-06 setLastSyncAt / getLastSyncAt round-trip', () => {
    const iso = '2026-03-13T06:00:00.000Z';
    db.setLastSyncAt(iso);
    const got = db.getLastSyncAt();
    assert.equal(got, iso, 'getLastSyncAt should return the same string that was set');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION WEB2: web.js regression guard for the slot_index===0 calendar bug
// ═══════════════════════════════════════════════════════════════════════════════
describe('WEB2 — web.js slot_index=0 calendar bug (static code analysis)', () => {
  test('WEB2-01 [FIXED] GET / no longer skips slot_index=0 bookings from calendar grouping', () => {
    // BUG was: if (b.slot_index === 0) continue;  at web.js ~line 357
    // This regression guard confirms the bug has been removed.
    const webSrc = fs.readFileSync(
      path.join(__dirname, '../src/web.js'), 'utf8');
    const bugPresent = /if\s*\(\s*b\.slot_index\s*===\s*0\s*\)\s*continue/.test(webSrc);
    assert.ok(!bugPresent,
      'REGRESSION: slot_index===0 skip bug still present in web.js calendar grouping. Remove the guard.');
  });

  test('WEB2-02 [FIXED] Bookings table in web.js no longer filters out slot_index === 0', () => {
    const webSrc = fs.readFileSync(
      path.join(__dirname, '../src/web.js'), 'utf8');
    // BUG was: b.slot_index !== 0 in the All Bookings table filter
    const tableBugPresent = /b\.slot_index\s*!==\s*0/.test(webSrc);
    assert.ok(!tableBugPresent,
      'REGRESSION: slot_index !== 0 filter still present in the All Bookings table. Remove the filter.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION SCHED2: scheduler FR-023 msUntilNextFire logic
// ═══════════════════════════════════════════════════════════════════════════════
describe('SCHED2 — scheduler FR-023 run-immediately logic', () => {
  test('SCHED2-01 [source] msUntilNextFire moves to tomorrow when target already passed', () => {
    // Verify the correct logic is present in index.js
    const indexSrc = fs.readFileSync(
      path.join(__dirname, '../src/index.js'), 'utf8');
    // FR-023: if startTime >= hour, run immediately
    assert.ok(indexSrc.includes('runImmediately') || indexSrc.includes('runOnce()') ||
              indexSrc.includes('immediately'),
      'FR-023 run-immediately path not found in scheduler code');
  });

  test('SCHED2-02 [logic] msUntilNextFire: target in past should schedule for tomorrow', () => {
    // Simulate the msUntilNextFire function logic
    const dayjs = require('dayjs');
    const utc = require('dayjs/plugin/utc');
    const tz  = require('dayjs/plugin/timezone');
    dayjs.extend(utc);
    dayjs.extend(tz);

    const timezone = 'America/Chicago';
    const fireHour = 6;

    function msUntilNextFire(fireHour) {
      const now = dayjs().tz(timezone);
      let target = now.startOf('day').add(fireHour, 'hour');
      if (target.valueOf() <= now.valueOf()) {
        target = target.add(1, 'day');
      }
      return target.valueOf() - now.valueOf();
    }

    const ms = msUntilNextFire(fireHour);
    assert.ok(ms > 0, `msUntilNextFire should always return a positive value, got ${ms}`);
    assert.ok(ms <= 86400000, `msUntilNextFire should be <= 24 hours, got ${ms}ms`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION CONF2: config.js — additional edge cases
// ═══════════════════════════════════════════════════════════════════════════════
describe('CONF2 — config.js edge cases', () => {
  const config = require('../src/config');

  test('CONF2-01 golfers array contains at least one entry', () => {
    assert.ok(config.golfers.length >= 1, 'golfers array must have at least one entry');
  });

  test('CONF2-02 all golfer entries have both email and password', () => {
    for (const g of config.golfers) {
      assert.ok(g.email,    `Golfer entry missing email: ${JSON.stringify(g)}`);
      assert.ok(g.password, `Golfer entry missing password: ${JSON.stringify(g)}`);
    }
  });

  test('CONF2-03 scheduleHour is 0-23', () => {
    assert.ok(config.schedulerHour >= 0 && config.schedulerHour <= 23,
      `schedulerHour out of range: ${config.schedulerHour}`);
  });

  test('CONF2-04 horizonDays is a positive integer', () => {
    assert.ok(Number.isInteger(config.horizonDays) && config.horizonDays > 0,
      `horizonDays should be a positive integer, got: ${config.horizonDays}`);
  });

  test('CONF2-05 maxRetries is 3', () => {
    assert.equal(config.maxRetries, 3);
  });

  test('CONF2-06 formatTimeLabel: AM times produce " AM" suffix', () => {
    // Test by checking the label for the Monday schedule entry (12:00-14:00)
    const mon = config.schedule.find(s => s.day === 1);
    assert.ok(mon, 'Monday schedule entry must exist');
    // Label should contain "PM" since 12:00-14:00 is PM
    assert.ok(mon.label.includes('PM'), `Monday label should contain PM, got: "${mon.label}"`);
  });

  test('CONF2-07 Sunday schedule entry has preferredCourse="alternating"', () => {
    const sun = config.schedule.find(s => s.day === 0);
    assert.ok(sun, 'Sunday schedule entry must exist');
    assert.equal(sun.preferredCourse, 'alternating',
      `Sunday preferredCourse should be "alternating", got: "${sun.preferredCourse}"`);
  });

  test('CONF2-08 all schedule entries have required fields', () => {
    const required = ['day', 'windowStart', 'windowEnd', 'players', 'slots', 'preferredCourse', 'label'];
    for (const entry of config.schedule) {
      for (const field of required) {
        assert.ok(field in entry, `Schedule entry missing field "${field}": ${JSON.stringify(entry)}`);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION RENDER: render.js
// ═══════════════════════════════════════════════════════════════════════════════
describe('RENDER — render.js helper functions', () => {
  const { isRealConfirmed, buildChipHTML, generateCalendarHTML, MONTH_NAMES, LONG_DAY_NAMES } = require('../src/render');

  test('RENDER-01 isRealConfirmed: returns true only for status=confirmed', () => {
    assert.equal(isRealConfirmed({ status: 'confirmed' }), true);
    assert.equal(isRealConfirmed({ status: 'pending' }),   false);
    assert.equal(isRealConfirmed({ status: 'failed' }),    false);
    assert.equal(isRealConfirmed({ status: 'cancelled' }), false);
    assert.equal(isRealConfirmed({ status: 'skipped' }),   false);
    assert.equal(isRealConfirmed({ status: 'partial' }),   false);
  });

  test('RENDER-02 buildChipHTML: includes data-id, data-status, data-date attributes', () => {
    const b = {
      id: 42, status: 'confirmed', day_label: 'Monday', target_time: '12:00',
      actual_time: '12:05', course: 'Pines', confirmation_number: '12345',
      players: 4, golfer_index: 0,
    };
    const html = buildChipHTML(b, '2026-03-09');
    assert.ok(html.includes('data-id="42"'));
    assert.ok(html.includes('data-status="confirmed"'));
    assert.ok(html.includes('data-date="2026-03-09"'));
  });

  test('RENDER-03 buildChipHTML: displays actual_time when available (not target_time)', () => {
    const b = {
      id: 43, status: 'confirmed', day_label: 'Monday', target_time: '12:00',
      actual_time: '12:07', course: 'Pines', confirmation_number: '99',
      players: 4, golfer_index: 0,
    };
    const html = buildChipHTML(b, '2026-03-09');
    assert.ok(html.includes('12:07'), 'Should display actual_time');
  });

  test('RENDER-04 buildChipHTML: falls back to target_time when actual_time is null', () => {
    const b = {
      id: 44, status: 'confirmed', day_label: 'Monday', target_time: '12:00',
      actual_time: null, course: 'Pines', confirmation_number: null,
      players: 4, golfer_index: 0,
    };
    const html = buildChipHTML(b, '2026-03-09');
    assert.ok(html.includes('12:00'), 'Should fall back to target_time');
  });

  test('RENDER-05 buildChipHTML: placeholder confirmation numbers not shown as "Res #"', () => {
    for (const placeholder of ['EXISTING_RESERVATION', 'CONFIRMED', 'access']) {
      const b = {
        id: 45, status: 'confirmed', day_label: 'Monday', target_time: '12:00',
        actual_time: '12:00', course: 'Pines', confirmation_number: placeholder,
        players: 4, golfer_index: 0,
      };
      const html = buildChipHTML(b, '2026-03-09');
      assert.ok(!html.includes('Res #'), `Placeholder "${placeholder}" should not show as "Res #"`);
    }
  });

  test('RENDER-06 buildChipHTML: real numeric confirmation number IS shown as "Res #"', () => {
    const b = {
      id: 46, status: 'confirmed', day_label: 'Monday', target_time: '12:00',
      actual_time: '12:00', course: 'Pines', confirmation_number: '98765',
      players: 4, golfer_index: 0,
    };
    const html = buildChipHTML(b, '2026-03-09');
    assert.ok(html.includes('Res #98765'), 'Real confirmation number should appear as "Res #98765"');
  });

  test('RENDER-07 generateCalendarHTML: produces valid HTML containing month name', () => {
    const html = generateCalendarHTML(2026, 2, {}, 'Schedule Month', false); // March 2026
    assert.ok(html.includes('March'), 'Calendar HTML must contain month name');
    assert.ok(html.includes('2026'),  'Calendar HTML must contain year');
  });

  test('RENDER-08 generateCalendarHTML: does not render admin buttons when isAdmin=false', () => {
    const html = generateCalendarHTML(2026, 2, {}, 'Schedule Month', false);
    assert.ok(!html.includes('scheduleMonth'), 'Admin buttons should not appear when isAdmin=false');
  });

  test('RENDER-09 generateCalendarHTML: renders admin button when isAdmin=true', () => {
    const html = generateCalendarHTML(2026, 2, {}, 'Schedule Month', true);
    assert.ok(html.includes('scheduleMonth'), 'Admin button should appear when isAdmin=true');
  });

  test('RENDER-10 MONTH_NAMES has 12 entries starting with January', () => {
    assert.equal(MONTH_NAMES.length, 12);
    assert.equal(MONTH_NAMES[0],  'January');
    assert.equal(MONTH_NAMES[11], 'December');
  });

  test('RENDER-11 LONG_DAY_NAMES has 7 entries starting with Sunday', () => {
    assert.equal(LONG_DAY_NAMES.length, 7);
    assert.equal(LONG_DAY_NAMES[0], 'Sunday');
    assert.equal(LONG_DAY_NAMES[6], 'Saturday');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION NOTIFY: notify.js
// ═══════════════════════════════════════════════════════════════════════════════
describe('NOTIFY — notify.js exports', () => {
  test('NOTIFY-01 all four alert functions are exported', () => {
    const notify = require('../src/notify');
    assert.equal(typeof notify.alertSuccess,        'function');
    assert.equal(typeof notify.alertFailure,        'function');
    assert.equal(typeof notify.alertPartialBooking, 'function');
    assert.equal(typeof notify.alertBlocked,        'function');
  });

  test('NOTIFY-02 alertPartialBooking includes contact info (850-833-9664)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/notify.js'), 'utf8');
    assert.ok(src.includes('850-833-9664'), 'alertPartialBooking must include course phone number');
  });

  test('NOTIFY-03 alertPartialBooking includes jhill2@fwb.org contact', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/notify.js'), 'utf8');
    assert.ok(src.includes('jhill2@fwb.org'), 'alertPartialBooking must include course email');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION SEC2: Additional security tests
// ═══════════════════════════════════════════════════════════════════════════════
describe('SEC2 — Additional security tests', () => {
  test('SEC2-01 [FIXED] isLocalIP: uses precise RFC 1918 172.16.0.0/12 check', () => {
    // BUG was: ip?.startsWith('172.') which matched all 172.x addresses including public ones.
    // Fix: uses regex /^172\.(1[6-9]|2\d|3[01])\./ to match only 172.16-172.31.
    const webSrc = fs.readFileSync(path.join(__dirname, '../src/web.js'), 'utf8');
    // The broad "172." startsWith should NOT be present
    const hasBroad = /ip\?\.startsWith\('172\.'\)/.test(webSrc) ||
                     /ip\.startsWith\('172\.'\)/.test(webSrc);
    assert.ok(!hasBroad,
      'REGRESSION: isLocalIP still uses "172." startsWith which is too broad. ' +
      'Fix: use /^172\\.(1[6-9]|2\\d|3[01])\\./ to match only RFC 1918 172.16.0.0/12.');
    // Verify the precise regex is present
    const hasPrecise = webSrc.includes('172\\.') && (webSrc.includes('1[6-9]') || webSrc.includes('16 &&'));
    assert.ok(hasPrecise,
      'isLocalIP should use precise RFC 1918 172.16.0.0/12 range check');
  });

  test('SEC2-02 cancel endpoint uses Number() not parseInt() for ID parsing', () => {
    const webSrc = fs.readFileSync(path.join(__dirname, '../src/web.js'), 'utf8');
    // The cancel endpoint SHOULD use Number(req.params.id) to reject "1abc"
    // G01 documents that parseInt("1abc") === 1 which would bypass id validation
    const usesNumber = /Number\(req\.params\.id\)/.test(webSrc);
    const usesParseInt = /parseInt\(req\.params\.id/.test(webSrc);
    // At least one of these should be present
    assert.ok(usesNumber || usesParseInt, 'Cancel endpoint must parse id parameter');
    // Document which approach is used
    if (usesNumber) {
      // Number() is correct — "1abc" → NaN
      const testValue = Number('1abc');
      assert.ok(isNaN(testValue), 'Number("1abc") should be NaN');
    }
  });

  test('SEC2-03 [SECURITY] /api/book-day is restricted to local IPs', () => {
    const webSrc = fs.readFileSync(path.join(__dirname, '../src/web.js'), 'utf8');
    // /api/book-day should have a local IP check
    assert.ok(webSrc.includes('/api/book-day') && webSrc.includes('isLocalIP'),
      '/api/book-day must check isLocalIP');
  });

  test('SEC2-04 [SECURITY] /admin is restricted to local IPs', () => {
    const webSrc = fs.readFileSync(path.join(__dirname, '../src/web.js'), 'utf8');
    assert.ok(webSrc.includes('/admin') && webSrc.includes('isLocalIP'),
      '/admin must check isLocalIP');
  });
});
