# GolfScheduler — Bug Fix Report

**Date:** 2026-03-13
**Engineer:** Claude (bug-fixer role)
**Test results after fixes:** 168/168 pass (102 in test.js + 66 in test_new.js)

---

## Executive Summary

Eight bugs were fixed, spanning P1 (critical), P2 (high), and P3 (medium/low) severities.

The most impactful fix was discovering and removing a leftover debug line in `src/web.js` that was writing to `C:\debug-cancel.log` inside the cancel endpoint. This debug line was throwing `EPERM` on Windows (can't write to C:\ root), corrupting HTTP responses and masking the true root cause of D09/D10 test failures. A stale server on port 3099 compounded the issue by routing HTTP requests to an old process with stale DB state.

Two pre-existing fixes were confirmed already applied (E03/E04 CSS tests, `isLocalIP()` RFC 1918). Three test assertions in test_new.js were corrected from "bug-present" guards to proper "bug-absent" regression guards.

**All 168 tests pass after fixes.**

---

## Fix 1 — P1: Remove `slot_index !== 0` filter from All Bookings table

**Bug:** `src/web.js` line 979 filtered out all slot_index=0 bookings from the All Bookings table, making the primary (first) tee time of every booking group invisible.

**File:Line:** `src/web.js:979`

**Before:**
```js
${bookings.filter(b => b.status === 'confirmed' && b.slot_index !== 0).map(b => `
```

**After:**
```js
${bookings.filter(b => b.status === 'confirmed').map(b => `
```

**Verified:** WEB2-02 test (updated to assert bug is absent) passes. All 168 tests pass.

---

## Fix 2 — P1: Remove leftover debug `appendFileSync` from cancel endpoint

**Bug:** `src/web.js` line 152 had an abandoned debug statement that wrote to `C:\debug-cancel.log`. On Windows, writing to the C:\ root requires elevation — without it, `appendFileSync` throws `EPERM`, causing Express to return a 500 HTML error page instead of JSON. This caused all D09/D10 test assertions on the JSON response to fail.

**File:Line:** `src/web.js:152`

**Before:**
```js
const booking = await db.getBookingById(id);
if (!booking) return res.status(404).json({ success: false, error: 'Booking not found' });
require('fs').appendFileSync('C:/debug-cancel.log', `[CANCEL_DEBUG] id=${id} status=${booking.status} conf=${booking.confirmation_number}\n`);
if (booking.status === 'cancelled') return res.json({ success: true, message: 'Already cancelled' });
```

**After:**
```js
const booking = await db.getBookingById(id);
if (!booking) return res.status(404).json({ success: false, error: 'Booking not found' });
if (booking.status === 'cancelled') return res.json({ success: true, message: 'Already cancelled' });
```

**Verified:** D09 and D10 now pass. Cancel endpoint returns correct JSON responses.

---

## Fix 3 — P1 (supporting): Fix inline `isAdmin` IP check in GET / route

**Bug:** `src/web.js` line 359 had an inline IP check using `ip?.startsWith('172.')` (too broad) instead of using the correctly-implemented `isLocalIP()` function.

**File:Line:** `src/web.js:359`

**Before:**
```js
const isAdmin = ip === '::1' || ip === '127.0.0.1' || ip?.startsWith('192.168.') || ip?.startsWith('10.') || ip?.startsWith('172.');
```

**After:**
```js
const isAdmin = isLocalIP(ip);
```

**Verified:** SEC2-01 test confirms RFC 1918-precise check is used. All 168 tests pass.

---

## Fix 4 — P3: Remove dead code — unreachable negative-time guard in `_processGroup`

**Bug:** `src/booking.js` line 183 had an unreachable guard. After the `_shiftTime()` midnight-wrap fix (`((total % 1440) + 1440) % 1440`), the result is always in `[0, 1439]`, so `_timeToMinutes()` can never return negative.

**File:Line:** `src/booking.js:183`

**Before:**
```js
// Don't add windows with negative times (before midnight)
if (this._timeToMinutes(start) < 0 || this._timeToMinutes(end) < 0) continue;
attempts.push({ course, start, end, offset });
```

**After:**
```js
// Note: _shiftTime uses ((total % 1440) + 1440) % 1440 which always produces [0,1439].
// The previous negative-time guard was unreachable and has been removed.
attempts.push({ course, start, end, offset });
```

**Verified:** BE07 (negative offset test) still passes.

---

## Fix 5 — P3: Log error when `generate-static.js` fails

**Bug:** `src/index.js` `generateAndPush()` always called `resolve()` silently swallowing any error.

**File:Line:** `src/index.js:11`

**Before:**
```js
execFile(process.execPath, [...], (err, stdout, stderr) => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  resolve();
});
```

**After:**
```js
execFile(process.execPath, [...], (err, stdout, stderr) => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (err) {
    console.warn(`[WARN] generate-static.js failed (exit ${err.code}): ${err.message}`);
  }
  resolve();
});
```

**Verified:** Code change confirmed. Function continues to resolve (non-fatal) but now logs the failure.

---

## Fix 6 — P3: Update port 3002 to 3009 in documentation

**Bug:** `PRD.md` and `Prompt.md` referenced port 3002. The actual server runs on port 3009.

**Files:** `PRD.md`, `Prompt.md`

All occurrences of `3002` replaced with `3009`.

---

## Fix 7 — P2: Correct backwards test assertions in test_new.js

Three tests in `tests/test_new.js` were "bug-presence detectors" — they passed when bugs were present and failed when bugs were fixed.

**File:** `tests/test_new.js`

**WEB2-01:** Changed `assert.ok(bugPresent, ...)` to `assert.ok(!bugPresent, ...)`
**WEB2-02:** Changed `assert.ok(tableBugPresent, ...)` to `assert.ok(!tableBugPresent, ...)`
**SEC2-01:** Changed to assert broad `172.` check is absent AND precise RFC 1918 check is present

**Verified:** All 66 tests in test_new.js pass.

---

## Root Cause Analysis for D09/D10 Failures

The D09/D10 failures had a compound root cause:

1. **Primary:** Debug line `appendFileSync('C:/debug-cancel.log', ...)` in the cancel endpoint threw `EPERM` on Windows, returning a 500 HTML response instead of JSON.

2. **Secondary:** A stale Node.js server was listening on port 3099 from a previous interrupted test run. HTTP requests were routed to this stale process, which had an old in-memory DB with different row state. The stale DB had `2027-03-02` row as `cancelled` (from D08 of a previous run), causing "Already cancelled" responses.

**This dual failure made BUG-008 appear to be a DB singleton isolation bug, when the actual root cause was a leftover debug artifact.**

---

## Test Results After All Fixes

```
node --test tests/test.js      →  102/102 pass
node --test tests/test_new.js  →   66/66  pass
node --test tests/test_new.js tests/test.js  →  168/168 pass
```

---

## Remaining Known Issues (operational notes, not code bugs)

1. **Stale port 3099 server:** If a test run is interrupted, the Express server on port 3099 remains alive. Always verify before running tests: `netstat -an | grep 3099 | grep LISTEN` and kill if found.

2. **CSRF on POST endpoints:** Documented risk in G10. Not mitigated — acceptable for local-network-only deployment.

3. **Sunday slots spec delta (P3):** `schedule.json` has 4 slots/Sunday; original `booking.md` specified 3. Current schedule intentional.
