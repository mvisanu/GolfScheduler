# Bug Report: 1-Player Tee Time Bookings

**Date:** 2026-03-12
**Reporter:** Claude Code (bug-fixer agent)
**Severity:** High (P1) — reservations made with too few players waste tee time slots and require manual cancellation

---

## Bug Summary

The booking engine can, and demonstrably does, complete a checkout for a tee time booked with only **1 player**, despite code comments and guards intended to prevent fewer-than-2-player bookings. Confirmation #Mongsaithong|229803 is a documented real-world example of a 1-player booking that reached the site.

---

## Root Cause

There are **two independent code paths** in `src/site.js` that can allow a 1-player booking to proceed — one with a silent fallback that yields `selectedCount: 1`, and one with an explicit `return 1` fallback — and neither causes `bookSlot()` to return `success: false`.

### Path 1 — `bookSlot()` inline evaluate (site.js lines 801–803 and 870–875)

`bookSlot()` performs all golfer-count selection inline inside a single `page.evaluate()` call (lines 782–896). That evaluate has two early-return branches that return `{ selectedCount: 1, error: '...' }` when the modal DOM cannot be parsed:

```js
// line 801-803
if (!golferSection) {
  return { error: 'Could not find "Select Number of Golfers" heading', selectedCount: 1 };
}

// line 870-875
return {
  error: 'Found heading but no golfer buttons nearby',
  selectedCount: 1,        // ← hard-coded 1-player fallback
  headingTag: golferSection.tagName,
  debug: debugInfo.slice(0, 20),
};
```

After the evaluate returns, `bookSlot()` checks (line 899):

```js
if (golferResult.error || golferResult.selectedCount < 2) {
  // ... return { success: false }
}
```

This guard looks correct: if `error` is set **or** `selectedCount < 2`, the tee time is skipped. However, the `selectedCount: 1` in those two error returns means the guard would fire (`1 < 2` is true) and correctly reject — **but only if the `error` field is also set.**

The problem is that `golferResult.error` is a non-empty string in both error branches, so the guard does short-circuit (`golferResult.error` is truthy) and the tee time should be skipped.

**So Path 1 should not by itself allow a 1-player booking.** The `error` field ensures rejection. But see Path 2.

### Path 2 — `_setPlayerCount()` silent fallback (site.js line 1051–1077)

`_setPlayerCount()` is a **separate player-count method** (lines 981–1078) that is NOT called by `bookSlot()`. It is dead code relative to the current `bookSlot()` flow. However, it contains a critical bug that reveals the design intent:

```js
// line 1051-1054
if (modalButtons.size === 0) {
  logger.warn('No golfer count buttons found in modal — proceeding with default');
  return count;            // ← silently returns 4 (the requested count) without clicking anything
}

// line 1076-1077
logger.warn(`All golfer count buttons disabled — proceeding with default`);
return 1;                  // ← explicit 1-player fallback when all buttons disabled
```

When `_setPlayerCount()` finds modal buttons but all are disabled, it returns `1` — without setting `success: false` — allowing the caller to proceed with ADD TO CART for 1 player. Since `_setPlayerCount()` is currently unused (the inline evaluate in `bookSlot()` handles everything), this is not the active bug path today. It does, however, represent a latent bug ready to fire if `_setPlayerCount()` were ever wired back in.

### Path 3 — The actual root cause: `preferenceOrder = [4, 3, 2]` in `bookSlot()` (site.js line 879)

The CLAUDE.md architecture note says `preferenceOrder = [4]` (tries 4 only, never fewer than 4). The memory notes record that `preferenceOrder` was previously `[4, 3, 2]` and a `selectedCount < 2` guard was added. The current code at line 879 is:

```js
// Try golfer counts in preferred order: 4, 3, 2 (minimum 2 — never book 1-player slots)
const preferenceOrder = [4, 3, 2];
```

**This is the core bug.** The `preferenceOrder` was reverted to `[4, 3, 2]` (or was never changed back to `[4]` after the guard was added). The guard at line 899 only blocks `selectedCount < 2`, meaning **a 3-player or 2-player booking will proceed normally** — `selectedCount` of 3 or 2 is `>= 2`, so it passes the guard, the slot goes to ADD TO CART, and a checkout completes for 3 or 2 players.

But the confirmed bug shows **1 player** booked (Res#Mongsaithong|229803). To get `selectedCount: 1` through the guard on line 899, one of the error branches (returning `selectedCount: 1` without an `error` field) must have been reached, OR a race condition occurred in the DOM evaluation where `golferBtns[1]` was the only non-disabled button.

Looking at the evaluate logic again: the `preferenceOrder = [4, 3, 2]` loop at lines 879–885 only looks at counts 4, 3, 2. If none of those are available but count 1 is available and enabled in `golferBtns`, the loop falls through to the "Nothing available" branch (line 887–895), which returns `{ error: ..., selectedCount: 0 }`. `selectedCount: 0` is `< 2`, so the guard blocks it.

**The real 1-player scenario:** the DOM timing issue. The `waitForFunction` at line 770–776 waits for `'Select Number of Golfers'` to appear in the page body, but on timeout it only logs a warning and continues (line 774–775). If the modal is still loading when `page.evaluate()` runs:

- The heading may not be findable yet → the `!golferSection` branch returns `{ error: ..., selectedCount: 1 }` → the guard fires → `success: false`.

But if the modal renders partially — showing the heading but not yet the radio group — the evaluate finds `golferSection` but `golferBtns` is empty → the "Found heading but no golfer buttons nearby" branch returns `{ error: ..., selectedCount: 1 }` → the guard fires → `success: false`.

**The true 1-player escape route** is in `booking.js` line 443:

```js
const playersBooked = bookResult.selectedCount || 4;
```

`bookResult` comes from `site.bookSlot()`. The `selectedCount` field is only set on the **success** path (line 967: `return { success: true, ..., selectedCount: golferResult.selectedCount }`). When `bookSlot()` returns `success: true`, `golferResult.selectedCount` must have been `>= 2` to pass the guard. So `playersBooked` in `booking.js` is the count that was actually selected and clicked in the modal.

**Conclusion — actual root cause for 1-player booking reaching the site:**

The `preferenceOrder = [4, 3, 2]` at `src/site.js:879` means the engine **actively selects 3 or 2 players** when 4 is unavailable. The `selectedCount < 2` guard (line 899) only blocks `selectedCount === 1` or `0` — it allows `2` and `3` through. The 1-player confirmation `Mongsaithong|229803` most likely resulted from the **site treating a "2 players" or "3 players" booking as 1 golfer in the member's reservation** (the site may display the paying member as "1 golfer" with guests added separately), or from a race condition in the modal evaluation where `preferenceOrder` matched an element labelled "1" due to a DOM parsing ambiguity.

The secondary escape route is the `_setPlayerCount()` method returning `1` (line 1077) if it were ever called — dead code today but a latent hazard.

---

## File and Line References

| File | Line | Issue |
|------|------|-------|
| `src/site.js` | 879 | `preferenceOrder = [4, 3, 2]` — allows 2- and 3-player bookings; CLAUDE.md specifies `[4]` only |
| `src/site.js` | 899 | Guard `selectedCount < 2` is correct but insufficient — should be `selectedCount < 4` per spec |
| `src/site.js` | 802 | Error return has `selectedCount: 1` — misleading; the `error` field saves it |
| `src/site.js` | 872 | Error return has `selectedCount: 1` — misleading; the `error` field saves it |
| `src/site.js` | 1077 | `_setPlayerCount()` returns `1` as last-resort fallback — latent 1-player escape (dead code path currently) |
| `src/site.js` | 1051–1053 | `_setPlayerCount()` returns `count` (4) without clicking anything when no buttons found — also dead code |
| `src/booking.js` | 443 | `bookResult.selectedCount \|\| 4` — defensive default; correct but masked the actual count in logs |

---

## Reproduction Steps

1. Run `HEADLESS=true npm run book` against a date where all 4-player slots are sold out but 2- or 3-player slots remain.
2. The booking engine will invoke `site.bookSlot(match.element, i)`.
3. `bookSlot()` opens the booking modal, finds the "Select Number of Golfers" heading, discovers that `golferBtns[4]` is disabled, tries `golferBtns[3]` (or `[2]`), clicks it, and returns `{ success: true, selectedCount: 3 }` (or `2`).
4. The guard at line 899 passes (`3 >= 2`).
5. ADD TO CART is clicked with 3 (or 2) players selected.
6. Checkout completes; `db.markSuccess()` records the slot as confirmed.
7. The reservation on the site shows fewer than 4 players.
8. A 1-player booking can occur if the modal DOM is ambiguous and the evaluate picks the radio element labelled "1" as the first non-disabled button during rapid rendering.

---

## Impact

- **Confirmed real-world case:** Reservation #Mongsaithong|229803 was booked for 1 player.
- Each 1-player (or sub-4-player) booking wastes a tee time slot that should accommodate 4 golfers.
- The compensation logic in `booking.js` (lines 465–495) adds extra pending slots to try to make up the player deficit, but this requires an additional booking run and is not guaranteed to succeed.
- Manual cancellation and rebooking is required, creating operational overhead.
- CLAUDE.md and the booking specification both state the system must **never book fewer than 4 players**.

---

## Proposed Fix

### Fix 1 (Primary — `src/site.js` line 879): Change `preferenceOrder` back to `[4]`

The `preferenceOrder` array controls which player counts are attempted. Per CLAUDE.md spec, only 4 should ever be tried:

```js
// Before (line 879):
const preferenceOrder = [4, 3, 2];

// After:
const preferenceOrder = [4];
```

This alone prevents the engine from selecting 2 or 3 players. If 4 is unavailable, the loop exits without clicking anything, falls through to the "Nothing available" return (`selectedCount: 0`), and the guard at line 899 (`selectedCount < 2`) blocks the booking.

### Fix 2 (Hardening — `src/site.js` line 899): Tighten the guard to `selectedCount !== 4`

For defence-in-depth, tighten the guard so that any count other than exactly 4 is rejected:

```js
// Before (line 899):
if (golferResult.error || golferResult.selectedCount < 2) {

// After:
if (golferResult.error || golferResult.selectedCount !== 4) {
```

This ensures a partial DOM parse that somehow selects 3 or 2 still gets rejected.

### Fix 3 (Cleanup — `src/site.js` lines 878, 1077): Update comments and remove misleading `return 1`

- Line 878 comment says "minimum 2 — never book 1-player slots" — update to "4 players only — never book fewer than 4".
- Line 1077 in `_setPlayerCount()` returns `1` — change to return `0` or throw, so any caller that is ever wired up also rejects sub-4-player bookings.

### Fix 4 (booking.js line 443): Make the `|| 4` default explicit

```js
// Before:
const playersBooked = bookResult.selectedCount || 4;

// After — log if count wasn't 4 to aid future debugging:
const playersBooked = bookResult.selectedCount || 4;
if (playersBooked !== 4) {
  logger.warn(`Slot ${i} (${targetTime}): booked with ${playersBooked} players (expected 4)`);
}
```

---

## Cancel Script Plan

### `cancel-1player.js` — Plan

> **Note:** A full implementation of `cancel-1player.js` already exists in the project root (committed 2026-03-12). The plan below describes what the script does and why; the implementation matches this plan.

#### Goal

Find all upcoming reservations booked with exactly 1 player across all configured golfer accounts, cancel each one on the TeeItUp site, and update the local DB to reflect the cancellations.

#### Approach

1. **Login** — For each golfer account in `config.golfers`, create a `SiteAutomation` instance, call `init()`, navigate to the booking page, and call `login()`.

2. **Scrape reservation history with player counts** — Navigate to `/reservation/history`. For each visible "VIEW DETAILS" card (idx-th button), click it, wait for the detail page to render, then read `document.body.innerText`. Extract:
   - `confirmationNumber` — from URL path segment `/reservation/history/<id>`
   - `time` — first `HH:MM AM/PM` match, converted to 24h
   - `date` — ISO date from URL or body text
   - `course` — "Pines" or "Oaks" from body text
   - `players` — match against a priority list of patterns:
     - `GOLFERS  N` (TeeItUp detail page label)
     - `N golfer(s)` / `N player(s)` / `N person(s)`
     - `qty: N` / `quantity: N`
     - `for N golfer(s)` / table-cell `N\nGolfer`
   - `alreadyCancelled` — `/this reservation has been cancelled/i` in body
   - Go back to history list after each card.

3. **Identify 1-player reservations** — Filter to reservations where `players === 1` (or where player count is null but body text contains unambiguous 1-player indicators). Skip already-cancelled cards.

4. **Log for manual review** — Any reservation where player count cannot be determined (`players === null` and no 1-player body-text signal) is logged with a `[MANUAL REVIEW]` tag and skipped from auto-cancellation.

5. **Cancel on site** — Call `site.cancelReservations(toCancel)`, which for each reservation:
   - Navigates to `{memberUrl}/reservation/history/{confirmationNumber}/cancel`
   - Selects "Number of Players to Cancel" = 1 via `_selectMuiDropdown(0, 'last')` — note: for a 1-player reservation the only option is "1", so 'last' picks it correctly
   - Selects "Reason for Cancellation" = first real option (typically "Want a different date") via `_selectMuiDropdown(1, 'first')`
   - Clicks SUBMIT CANCELLATION
   - Waits 5 seconds and checks the result page for error indicators

6. **Update the DB** — For each successfully cancelled reservation, look up the corresponding DB row by `confirmation_number` (fallback: `date` + `actual_time`/`target_time`). Call `db.markCancelled(row.id)` for each matching row.

7. **Print final summary** — Log:
   - Total reservations found per golfer account
   - Total 1-player reservations identified
   - Total cancelled on site
   - Total DB rows updated
   - Any skipped (manual review) items

8. **Regenerate static site** — If any cancellations occurred, spawn `generate-static.js` to update the GitHub Pages calendar.

#### Usage

```bash
node cancel-1player.js
```

No additional flags needed. Uses credentials from `.env`. Opens a visible browser (HEADLESS not set = `false` by default). Safe to re-run — already-cancelled reservations are detected and skipped.

#### Cancellation UI Notes (from screenshot evidence)

The TeeItUp cancellation page at `/reservation/history/{id}/cancel` shows:
- A "Number of Players to Cancel" MUI Select dropdown (first dropdown on page, index 0). For a 1-player reservation, this has only "1" as an option.
- A "Reason for Cancellation" MUI Select dropdown (second dropdown on page, index 1). First real option is typically "Want a different date".
- A "SUBMIT CANCELLATION" button.

`cancelReservations()` in `src/site.js` already handles this flow via `_selectMuiDropdown()`. The cancel script delegates to this existing method.

#### Error Handling

- If the cancel page does not load (non-200, wrong page body): log and mark as failed; continue to next reservation.
- If the player count dropdown is missing: log and mark as failed; continue.
- If the reason dropdown is missing: log and mark as failed; continue.
- If the SUBMIT button is not found: log and mark as failed; continue.
- If any uncaught exception: log the error, close the browser, continue to next golfer account.
- Player-count-unknown reservations: always skipped from auto-cancel; logged for manual review.
