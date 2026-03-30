# End-to-End Scheduler Test Results

**Run date:** 2026-03-29
**Test runner:** `node --test tests/test.js`
**Total tests:** 102 | **Pass:** 98 | **Fail:** 4 | **Skipped:** 0

---

## Summary

| Suite | Tests | Pass | Fail |
|-------|-------|------|------|
| A — scheduler.computeBookingSlots() | 12 | 11 | 1 |
| B — BookingEngine pure methods | 15 | 15 | 0 |
| C — db.js operations | 17 | 17 | 0 |
| D — web API endpoints | 11 | 11 | 0 |
| E — HTML / CSS audit | 27 | 27 | 0 |
| F — config / schedule | ~10 | ~7 | 3 |
| G — edge cases & security | ~10 | ~10 | 0 |

---

## Failing Tests

### A04 — Monday has 3 slots at 12:00/12:10/12:20
- **Expected:** 3 slots for Monday 2026-03-30
- **Actual:** 2
- **Root cause:** `schedule.json` has `"slots": 2` for Monday. Tests were written when Monday had 3 slots.

### F02 — Monday has 3 slots
- **Expected:** `mon.slots === 3`
- **Actual:** 2
- **Root cause:** Same as A04 — `schedule.json` Monday entry has `"slots": 2`.

### F04 — Friday has 3 slots
- **Expected:** `fri.slots === 3`
- **Actual:** 2
- **Root cause:** `schedule.json` Friday entry has `"slots": 2`.

### F05 — Saturday has 3 slots
- **Expected:** `sat.slots === 3`
- **Actual:** 2
- **Root cause:** `schedule.json` Saturday entry has `"slots": 2`.

---

## Root Cause Analysis

All 4 failures share the same root cause: **`schedule.json` was updated to 2 slots** for Monday, Tuesday, Friday, and Saturday, but the test suite (`tests/test.js`) was not updated to reflect this change.

### Current `schedule.json` (actual state)
| Day | Slots | Window |
|-----|-------|--------|
| Monday | **2** | 12:00–14:00 |
| Tuesday | 2 | 12:00–14:00 |
| Friday | **2** | 12:00–14:00 |
| Saturday | **2** | 08:00–13:00 |
| Sunday | 4 | 08:00–10:00 |

### Tests expect (stale)
| Day | Expected slots |
|-----|---------------|
| Monday | 3 |
| Friday | 3 |
| Saturday | 3 |

---

## Passing Highlights

- **B — BookingEngine pure methods (15/15):** All `_timeToMinutes`, `_shiftTime` (including midnight wrap/underflow edge cases), and `_filterAlreadyBooked` logic is correct.
- **C — db.js operations (17/17):** All CRUD operations, UNIQUE constraint enforcement, status transitions (`confirmed`, `failed`, `partial`, `skipped`, `cancelled`), retry ceiling, and disk persistence pass.
- **D — web API endpoints (11/11):** `/api/bookings`, GET `/`, POST `/api/cancel/:id` (400/404/200 paths), and POST `/api/book-month` all pass.
- **E — HTML/CSS audit (27/27):** Design system, fonts (Inter/Manrope), zoom widget, modal behavior, WCAG color contrast, mobile responsiveness, and keyboard shortcuts all pass.
- **G — edge cases & security (10/10):** SQL injection guards, XSS protection, HEADLESS toggle, and other security checks pass.

---

## Recommendations

### Option A — Update tests to match current schedule (recommended if 2-slot schedule is intentional)
Update `tests/test.js` lines 836–853 and line 105–113:
- A04: change expected slots from 3 to 2 for Monday
- F02: change `assert.equal(mon.slots, 3)` → `assert.equal(mon.slots, 2)`
- F04: change `assert.equal(fri.slots, 3)` → `assert.equal(fri.slots, 2)`
- F05: change `assert.equal(sat.slots, 3)` → `assert.equal(sat.slots, 2)`

### Option B — Restore schedule.json to 3 slots (if the change was unintentional)
Update `schedule.json` Monday/Friday/Saturday entries back to `"slots": 3`.

---

## Previously Known Open Issues (not tested here)

| ID | Severity | Description |
|----|----------|-------------|
| P3 | Low | `index.js` opens browser at port 3000 but server runs on 3009 |
| P3 | Low | `reconcileDate()` has zero test coverage |
| P3 | Low | Sunday slots: schedule.json has 4 slots, booking.md specifies 4 — now aligned |
