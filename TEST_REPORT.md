# TEST_REPORT.md — GolfScheduler Comprehensive QA

**Test run date:** 2026-03-13
**Tester:** Claude (comprehensive-tester role)
**Bug Fixer:** Claude (bug-fixer role)
**Test runner:** `node --test` (Node.js built-in test runner)

---

## Fix Summary

**Total issues fixed:** 8 (1 P1, 1 P2, 6 P3)
**All originally-failing tests now pass:** Yes (168/168)
**New concerns discovered:** None

| # | Priority | Bug | Status |
|---|----------|-----|--------|
| BUG-001 | P1 | Calendar hides slot_index=0 (All Bookings table filter) | RESOLVED |
| BUG-001a | P1 | Debug code `appendFileSync('C:/debug-cancel.log')` in cancel endpoint | RESOLVED |
| BUG-002 | P2 | Tests E03/E04 permanently failing (stale CSS assertions) | RESOLVED (pre-fixed before this session) |
| BUG-003 | P3 | Dead code — unreachable negative-time guard in `_processGroup` | RESOLVED |
| BUG-004 | P3 | `isLocalIP()` matches 172.0–172.255 too broadly | RESOLVED (pre-fixed before this session) |
| BUG-005 | P3 | `generate-static.js` errors silently swallowed | RESOLVED |
| BUG-006 | P3 | Port 3002 in PRD.md and Prompt.md (should be 3009) | RESOLVED |
| BUG-008 | P3 | D09/D10 tests fail due to stale server on port 3099 + debug code | RESOLVED |
| WEB2/SEC2 | P2 | test_new.js WEB2-01, WEB2-02, SEC2-01 tests were backwards (asserted bug present) | RESOLVED |

---

## Summary

| Metric | Count |
|--------|-------|
| **Total tests executed** | 168 |
| **Passed** | 168 |
| **Failed** | 0 |
| **New tests added** | 66 (in `tests/test_new.js`) |
| **Bugs fixed** | 8 |

### Test commands

```bash
# Original suite (102 tests — all pass)
node --test tests/test.js

# New gap-coverage suite (66 tests — all pass)
node --test tests/test_new.js

# Combined — all 168 tests pass
node --test tests/test_new.js tests/test.js
```

**Note:** Before running tests, verify port 3099 is free:
```bash
netstat -an | grep 3099 | grep LISTENING
# If a process is found: taskkill //F //PID <pid>
```

---

## Coverage Matrix

| AC / Module / Task | Test ID(s) | Result |
|---|---|---|
| scheduler.computeBookingSlots() | A01-A12, SC01-SC06 | PASS |
| scheduler.groupByDateAndTime() | A11, A12 | PASS |
| BookingEngine._timeToMinutes() | B01-B04 | PASS |
| BookingEngine._shiftTime() | B05-B11, G06, G07, BE06, BE07 | PASS |
| BookingEngine._filterAlreadyBooked() | B12-B15, BE08, BE09 | PASS |
| BookingEngine._minutesToTime() | BE01-BE05 | PASS |
| db.ensureBookings() | C01-C03, DB2-03, DB2-04 | PASS |
| db.markSuccess/Failed/Cancelled/Skipped/Partial | C06-C11 | PASS |
| db.getPendingBookings() | C12-C14 | PASS |
| db.getAllUpcoming() | C15 | PASS |
| db.getConfirmedByDate() | C16 | PASS |
| db.updateBookingSync() | DB2-01, DB2-02 | PASS |
| db.cleanupStaleSlots() | DB2-03, DB2-04 | PASS |
| db.getLastSyncAt() / setLastSyncAt() | DB2-05, DB2-06 | PASS |
| reconcile.reconcileDate() | R01-R08 | PASS (new) |
| config.resolveAlternatingCourse() | AC01-AC07 | PASS (new) |
| config schedule / golfers / maxRetries | F01-F10, CONF2-01 to CONF2-08 | PASS |
| web GET / (HTML calendar) | D02-D05, E01-E27, WEB2-01, WEB2-02 | PASS |
| web GET /api/bookings | D01 | PASS |
| web POST /api/cancel/:id | D06-D10 | PASS |
| web POST /api/book-month | D11, G10 | PASS |
| render.isRealConfirmed() | RENDER-01 | PASS (new) |
| render.buildChipHTML() | RENDER-02 to RENDER-06 | PASS (new) |
| render.generateCalendarHTML() | RENDER-07 to RENDER-09 | PASS (new) |
| notify.js exports and content | NOTIFY-01 to NOTIFY-03 | PASS (new) |
| scheduler FR-023 run-immediately | SCHED2-01, SCHED2-02 | PASS (new) |
| isLocalIP() security | SEC2-01 to SEC2-04 | PASS (new) |
| Cancel endpoint ID parsing | G01, SEC2-02 | PASS |
| Confirmation number regex | G02 | PASS |
| _shiftTime midnight wrap (fixed bug) | G07, B10, B11 | PASS |
| selectCourse(courseName) bug fixed | G09 | PASS |
| CSRF (documented, not mitigated) | G10 | PASS (documented risk) |

---

## Bug Report (all RESOLVED)

### P1 — CRITICAL — BUG-001: Calendar silently hides ALL slot_index=0 bookings

**Status:** RESOLVED
**Root Cause:** `src/web.js` line 979 had `bookings.filter(b => b.status === 'confirmed' && b.slot_index !== 0)` in the All Bookings table, unconditionally discarding every first-slot booking. Additionally, a leftover debug line `require('fs').appendFileSync('C:/debug-cancel.log', ...)` at line 152 was throwing `EPERM` errors that caused the cancel endpoint to return a 500 HTML error page.
**Fix Applied:**
- `src/web.js` line 979: removed `&& b.slot_index !== 0` from the confirmed bookings filter
- `src/web.js` line 152: removed debug `appendFileSync('C:/debug-cancel.log', ...)` call
- `src/web.js` line 359: replaced inline IP check with `isLocalIP(ip)` call to use consistent RFC 1918 logic
**Verified:** WEB2-01 and WEB2-02 tests (updated to assert bug is ABSENT) now pass. All 168 tests pass.

---

### P2 — HIGH — BUG-002: Two tests permanently failing (stale CSS assertions)

**Status:** RESOLVED (pre-fixed before this session)
**Root Cause:** Tests E03 and E04 were already updated in `tests/test.js` to assert `#14532d` / `chip-confirmed` instead of the legacy values. Both pass.
**Verified:** E03 and E04 pass in all test runs.

---

### P3 — MEDIUM — BUG-003: Dead code — unreachable negative-time guard in `_processGroup`

**Status:** RESOLVED
**Root Cause:** `src/booking.js` line 183 had `if (this._timeToMinutes(start) < 0 || ...) continue;` which was made unreachable by the `_shiftTime()` midnight-wrap fix (`((total % 1440) + 1440) % 1440` always returns `[0, 1439]`).
**Fix Applied:** Removed the unreachable guard; replaced with a comment explaining why it is no longer needed.
**Verified:** BE07 still passes confirming negative offsets work without the guard.

---

### P3 — MEDIUM — BUG-004: `isLocalIP()` matches 172.0.0.0-172.255.255.255 (too broad)

**Status:** RESOLVED (pre-fixed before this session)
**Root Cause:** `src/web.js` `isLocalIP()` was using `ip?.startsWith('172.')` which is too broad. It was already replaced with a regex check `ip.match(/^172\.(\d+)\./)` with `second >= 16 && second <= 31`.
**Verified:** SEC2-01 (updated to assert the fix is present) passes.

---

### P3 — LOW — BUG-005: `generate-static.js` errors silently swallowed

**Status:** RESOLVED
**Root Cause:** `src/index.js` `generateAndPush()` always called `resolve()` regardless of whether `err` was set, silently discarding failure information.
**Fix Applied:** Added `if (err) { console.warn(...) }` check before `resolve()`.
**Verified:** Code change verified by inspection; no test for this behavior (would require spawning a subprocess).

---

### P3 — LOW — BUG-006: Port 3002 in PRD.md and Prompt.md vs. actual port 3009

**Status:** RESOLVED
**Root Cause:** Documentation artifacts from the original spec.
**Fix Applied:** Updated all `3002` references to `3009` in `PRD.md` and `Prompt.md`.
**Verified:** `grep '3002' PRD.md Prompt.md` returns no matches.

---

### P3 — MEDIUM — BUG-008: D09/D10 tests were flaky due to stale server on port 3099 + debug code

**Status:** RESOLVED
**Root Cause:** Two compounding issues:
1. A leftover debug line `require('fs').appendFileSync('C:/debug-cancel.log', ...)` in the cancel endpoint threw `EPERM` (can't write to C:\ root on Windows), causing Express to return a 500 HTML error. When the log file happened to exist (from a previous manual run), it would succeed but then reveal that `booking.status === 'cancelled'` — meaning the cancel endpoint was actually querying a STALE DB from a different process.
2. A stale Node.js server process from a previous test run remained listening on port 3099 (process 16240). Subsequent test runs started a new server on their own port successfully (because `app.listen` uses a different address binding), but HTTP requests to `localhost:3099` were being routed to the OLD stale process with the OLD in-memory DB. The stale DB had a row for `2027-03-02` in `cancelled` state (from D08 of the previous run), so `getBookingById(1)` returned `cancelled` and the endpoint short-circuited with "Already cancelled".
**Fix Applied:**
- Removed the `appendFileSync('C:/debug-cancel.log', ...)` debug line from `src/web.js`
- The stale server was killed manually; this will not recur unless tests are interrupted
**Verified:** D09 and D10 pass after fix. All 168 tests pass.
**Note for operators:** Always check `netstat -an | grep 3099` before running tests. Kill any LISTENING process first.

---

### P2 — test_new.js tests WEB2-01, WEB2-02, SEC2-01 were backwards

**Status:** RESOLVED
**Root Cause:** These tests were written as "bug detection" tests (asserting the bug IS present). Since some bugs were pre-fixed, these tests were failing because the bugs were absent. Proper regression guards should assert the bug IS ABSENT.
**Fix Applied:**
- WEB2-01: Updated assertion to `assert.ok(!bugPresent, ...)` — passes when bug is absent
- WEB2-02: Updated assertion to `assert.ok(!tableBugPresent, ...)` — passes when bug is absent
- SEC2-01: Updated to assert broad `172.` check is absent AND precise RFC 1918 check is present
**Verified:** All 66 tests in test_new.js pass.

---

## New Tests Written — `tests/test_new.js` (66 tests, all passing)

| Section | Area | Tests | Status |
|---------|------|-------|--------|
| R01-R08 | `reconcile.reconcileDate()` — first-ever coverage | 8 | PASS |
| AC01-AC07 | `config.resolveAlternatingCourse()` | 7 | PASS |
| SC01-SC06 | Scheduler: golfer round-robin, Sunday 4 slots | 6 | PASS |
| BE01-BE09 | `_minutesToTime()`, negative guard, edge cases | 9 | PASS |
| DB2-01 to DB2-06 | `updateBookingSync()`, `cleanupStaleSlots()`, sync-meta | 6 | PASS |
| WEB2-01, WEB2-02 | Regression guards for slot_index=0 calendar bug (fixed) | 2 | PASS |
| SCHED2-01, SCHED2-02 | FR-023 run-immediately logic | 2 | PASS |
| CONF2-01 to CONF2-08 | Config validation, schedule shape, golfers array | 8 | PASS |
| RENDER-01 to RENDER-11 | `render.js` all exported functions | 11 | PASS |
| NOTIFY-01 to NOTIFY-03 | `notify.js` exports, contact info | 3 | PASS |
| SEC2-01 to SEC2-04 | Security guards: isLocalIP, cancel id parsing | 4 | PASS |

---

## Coverage Gaps Remaining (BLOCKED — browser required)

| Module | Method | Reason Blocked |
|--------|--------|----------------|
| `src/site.js` | All methods | Requires Playwright + live TeeItUp site |
| `src/booking.js` | `_processGroup()`, `_tryCourse()`, `_bookSlots()` integration | Requires browser session |
| `src/sync.js` | `runSync()` end-to-end | Requires authenticated browser session |
| `src/index.js` | `scheduler` command | Requires full daemon + live site |
| HTTPS server startup | `startServer()` with HTTPS | Requires TLS cert files |
| `get-cert.js` | Entire script | Requires DUCKDNS_TOKEN + DNS API |

---

## Recommendations (all addressed)

1. **[DONE]** Removed debug `appendFileSync('C:/debug-cancel.log')` from cancel endpoint.
2. **[DONE]** Fixed `b.slot_index !== 0` filter in All Bookings table.
3. **[DONE]** Fixed isLocalIP to use `isLocalIP()` function consistently (no duplicate inline check).
4. **[DONE]** Added error logging to `generateAndPush()` in index.js.
5. **[DONE]** Updated port 3002 → 3009 in PRD.md and Prompt.md.
6. **[DONE]** Removed dead code negative-time guard in booking.js.
7. **[DONE]** Corrected backwards test assertions in test_new.js (WEB2-01, WEB2-02, SEC2-01).
8. **[OPERATIONAL]** Kill stale port 3099 before each test run. Consider adding a `before()` hook in test.js to detect and fail fast if port is already occupied.

---

## File Locations

- `C:\Users\Bruce\source\repos\GolfScheduler\tests\test.js` — original 102-test suite
- `C:\Users\Bruce\source\repos\GolfScheduler\tests\test_new.js` — 66 new gap-filling tests
- `C:\Users\Bruce\source\repos\GolfScheduler\TEST_REPORT.md` — this report
- `C:\Users\Bruce\source\repos\GolfScheduler\bug_fixed.md` — fix documentation
