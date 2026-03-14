# GolfScheduler Sync Guide

A step-by-step reference for keeping the local SQLite database, local web UI, and GitHub Pages
calendar in sync with what is actually booked on fort-walton-member.book.teeitup.golf.

---

## Table of Contents

1. [Prerequisites Check](#1-prerequisites-check)
2. [Step-by-Step Sync Sequence](#2-step-by-step-sync-sequence)
3. [Diagnosing Common Sync Issues](#3-diagnosing-common-sync-issues)
4. [Manual DB Inspection Commands](#4-manual-db-inspection-commands)
5. [Full Reset and Resync Procedure](#5-full-reset-and-resync-procedure)
6. [Verification Checklist](#6-verification-checklist)

---

## 1. Prerequisites Check

### 1.1 Verify `.env` credentials

Open `.env` in the project root and confirm:

```
GOLF_EMAIL=mvisanu@gmail.com
GOLF_PASSWORD=<password>
```

Only **one** golfer account is active. Make sure these are not present (or are commented out):

```
# GOLF_EMAIL2=...  <-- must be absent or empty
# GOLF_EMAIL3=...  <-- must be absent or empty
```

`config.js` filters the `golfers` array to entries where **both** email and password are non-empty.
If `GOLF_EMAIL2`/`GOLF_PASSWORD2` are set, `npm run sync` will also open a browser session for
that account. Remove or blank out any inactive credentials to avoid wasted sessions.

Also confirm the required variables are set:

```
TIMEZONE=America/Chicago
BOOKING_HORIZON_DAYS=30
HEADLESS=true          # required for unattended sync
```

### 1.2 Check for stale or failed DB rows

Run this one-liner to see the current status breakdown:

```bash
node -e "
const db = require('./src/db');
db.getAllUpcoming().then(rows => {
  const counts = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status]||0)+1; return acc; }, {});
  console.table(counts);
  process.exit(0);
});
"
```

Expected before a sync run:
- `confirmed` rows should be the majority
- Some `pending` rows are normal (future unbooked slots)
- `failed` rows with `attempts >= 3` will not be retried until manually reset
- `EXISTING_RESERVATION` / `access` / `CONFIRMED` as `confirmation_number` values = placeholders
  that need resolution

If you see many `failed` rows, run the reset script described in Section 2 before syncing.

### 1.3 Check `sync-meta.json` for last sync time

```bash
node -e "const db=require('./src/db'); console.log('Last sync:', db.getLastSyncAt());"
```

If `lastSyncAt` is `null` or more than 24 hours ago, a full sync is overdue.

---

## 2. Step-by-Step Sync Sequence

Run all commands from the project root (`C:\Users\Bruce\source\repos\GolfScheduler`) in Git Bash.

### Step 2.1 — Optional: Reset failed rows

**When to run:** you have `failed` rows with `attempts >= 3` that represent real schedule slots
you want the engine to retry, or you have `confirmed` rows still carrying the
`EXISTING_RESERVATION` placeholder that you want to re-verify.

```bash
node reset-failed.js
```

What it does:
- Resets all `status='failed'` rows from `2026-03-16` onward back to `pending` with `attempts=0`
- Resets `confirmed` rows whose `confirmation_number='EXISTING_RESERVATION'` back to `pending`
- Saves the DB to `./data/bookings.db`

Note: the hardcoded date `2026-03-16` is in the script. Edit it if you need a different cutoff.

### Step 2.2 — Populate missing scheduled slots

**When to run:** after a schedule change, or after running `reset-failed.js`, to make sure
the DB has a pending row for every scheduled slot in the booking horizon.

```bash
npm run init
```

What it does: calls `computeBookingSlots()` in `scheduler.js` for the next `BOOKING_HORIZON_DAYS`
days and inserts any missing `pending` rows via `db.ensureBookings()`. Existing rows are left
untouched (uses `INSERT OR IGNORE`).

### Step 2.3 — Run the site sync

```bash
HEADLESS=true npm run sync
```

What it does (in order):

1. Opens a Chromium browser session for `mvisanu@gmail.com` (all accounts in `config.golfers`).
2. **Step 1** — Calls `site.scrapeReservationHistory()` to fetch all upcoming reservations visible
   on the site's Reservations page (typically within ~7 days). Deduplicates across accounts.
3. **Step 2** — For any DB row still carrying a placeholder confirmation number on a date NOT
   already covered by Step 1, probes nearby numeric reservation IDs via
   `site.fetchReservationById()` (±10 around known real IDs) to find the real confirmation number.
4. For each date that has site data, calls `reconcileDate()` which:
   - Pairs site reservations to DB rows positionally (by time sort order)
   - Updates `actual_time`, `course`, and `confirmation_number` in the DB where they differ
   - Marks the DB row `confirmed` if it was previously in another pairable status
5. Emits `[SYNC] WARN` for any confirmed DB row with a real numeric confirmation number whose
   date was visible to the site but the site returned no reservation for that date — this
   means the booking may have been cancelled externally.
6. Writes the current timestamp to `./data/sync-meta.json`.

**What to expect in output:**

```
[SYNC] Starting sync at 2026-03-13T...
[SYNC] Step 1: Scraping reservations for 1 golfer account(s)...
[SYNC] Step 1: Logged in as golfer 0 (mvisanu@gmail.com)
[SYNC] Step 1: Golfer 0 — N reservation(s) found
[SYNC] Step 2: M date(s) still need probing: 2026-03-22, ...
[SYNC] Step 2: Golfer 0 — probing X ID(s) ...
[SYNC] Updated booking #ID date YYYY-MM-DD slot N: actual_time ... → HH:MM, confirmation_number ... → NNNNNN
[SYNC] Completed in Xms — checked=N updated=M warnings=W errors=0
```

Zero errors and zero warnings is the clean state. Warnings require manual review (see Section 3).

### Step 2.4 — Resolve remaining placeholder confirmation numbers

**When to run:** after sync, if any `confirmed` rows still carry `EXISTING_RESERVATION`, `access`,
or `CONFIRMED` as their `confirmation_number`. These are typically bookings beyond the ~7-day site
display window that Step 2 ID probing could not reach.

```bash
HEADLESS=true node fix-confirmations.js
```

What it does:
- Loads all `confirmed` rows where `confirmation_number` is missing or a placeholder
- Opens a browser session per golfer (only Golfer 1 / `mvisanu@gmail.com` when it is the only
  active account)
- Calls `site.getExistingReservations(date)` for each affected date
- Matches each DB slot to a site reservation within ±20 minutes and writes the real reservation
  number via `db.markSuccess()`

Expected output:

```
Found N booking(s) needing real confirmation numbers.
Golfer 1 (mvisanu@gmail.com): N booking(s) across M date(s)
  2026-03-22: 12:00, 12:10, 12:20
  Checking reservations for 2026-03-22...
    Found 3 reservation(s) on site:
    ✓ Slot 12:02 → Res #NNNNNN
    ✓ Slot 12:12 → Res #NNNNNN
    ...
Done. Updated: X | Not found: Y
```

If `Not found: Y > 0`, those dates are likely beyond the ~7-day site window. The daily
6 AM scheduler will pick them up automatically as the dates come within range.

### Step 2.5 — Refresh the local web UI

The local web UI at `http://localhost:3009` auto-refreshes its data every 60 seconds by polling
`GET /api/bookings`. If the server is already running, the calendar will update on its own.

To start the server if it is not running:

```bash
npm run web
```

Then open `http://localhost:3009` in a browser.

To force an immediate data refresh without waiting for the 60-second poll, reload the page.

### Step 2.6 — Regenerate and push the GitHub Pages static site

```bash
node generate-static.js
```

What it does:
- Reads all upcoming bookings from `./data/bookings.db`
- Reads `lastSyncAt` from `./data/sync-meta.json`
- Renders a static HTML calendar into `docs/index.html`
- Runs `git add docs/index.html` and, if the file changed, commits with the message
  `"Update schedule"` and pushes to `origin master`

Expected output when the schedule changed:

```
Generated docs/index.html (52 confirmed, 2 pending, 17 failed)
Pushed updated schedule to GitHub Pages.
```

Expected output when nothing changed since the last push:

```
Generated docs/index.html (52 confirmed, 2 pending, 17 failed)
No changes to push — schedule unchanged.
```

GitHub Pages CDN may take 1–5 minutes to propagate after a push. Force a browser hard-refresh
(`Ctrl+Shift+R`) to bypass any local cache.

---

## 3. Diagnosing Common Sync Issues

### 3.1 Confirmation numbers still show as placeholders after sync

**Symptom:** `confirmation_number` in the DB is still `EXISTING_RESERVATION`, `access`, or
`CONFIRMED` after running `npm run sync`.

**Cause:** These bookings fall beyond the ~7-day site display window. Step 1 cannot see them
in the upcoming list, and Step 2 ID probing requires at least one known real numeric ID from
the same golfer to probe around — if all nearby IDs are also outside the window, probing finds
nothing.

**Fix options:**

1. **Wait for the date to approach.** The daily 6 AM scheduler automatically runs sync+fix every
   morning. Placeholders resolve automatically as dates come within the 7-day window.

2. **Run `fix-confirmations.js` manually** once the dates are within ~7 days:

   ```bash
   HEADLESS=true node fix-confirmations.js
   ```

3. **No action needed if the booking is real.** Placeholder-confirmed rows display in the web UI
   calendar as confirmed (green chip) since the booking is known to exist — only the confirmation
   number is unresolved.

### 3.2 A booking appears on the site but is missing from the DB

**Symptom:** You can see a reservation on fort-walton-member.book.teeitup.golf but there is no
corresponding row in the DB (or the row has `status='failed'`).

**Cause:** The booking engine marked the slot `failed` due to a post-checkout verification
error, but the booking actually went through.

**Fix:**

1. Run sync — `reconcileDate()` will find the site reservation, write the real time and
   confirmation number, and set `status='confirmed'`.

   ```bash
   HEADLESS=true npm run sync
   ```

2. If sync does not pick it up (date outside the display window), insert a DB row manually:

   ```bash
   node -e "
   const db = require('./src/db');
   db.getDb().then(sqlDb => {
     // Adjust values to match the real booking
     sqlDb.run(\`
       INSERT OR IGNORE INTO bookings
         (date, day_label, target_time, actual_time, course, slot_index, players,
          golfer_index, confirmation_number, status, attempts)
       VALUES
         ('2026-03-22','Monday 12 PM-2 PM','12:00','12:02','Pines',1,4,0,'NNNNNN','confirmed',1)
     \`);
     const data = sqlDb.export();
     require('fs').writeFileSync('./data/bookings.db', Buffer.from(data));
     console.log('Row inserted.');
     process.exit(0);
   });
   "
   ```

   Replace the values with the actual date, time, course, slot_index, and real confirmation number.

### 3.3 A booking is in the DB as `confirmed` but has been cancelled on the site

**Symptom:** The DB shows `status='confirmed'` with a real confirmation number, but the
booking no longer appears on the site. Sync emits a `[SYNC] WARN` line for it.

**What the log looks like:**

```
[SYNC] WARN: booking #ID date YYYY-MM-DD slot N: DB shows confirmed Res#NNNNNN but not found on site — manual review required
```

**Fix:** Manually mark the DB row as cancelled:

```bash
node -e "
const db = require('./src/db');
db.getDb().then(async () => {
  await db.markCancelled(ID_HERE);   // replace ID_HERE with the booking id
  console.log('Marked cancelled.');
  process.exit(0);
});
"
```

Then run `npm run init` to re-create a pending slot for that date/time if you want the engine
to try to rebook it, followed by `HEADLESS=true npm run book`.

### 3.4 The static GitHub Pages site is stale vs the local DB

**Symptom:** `https://mvisanu.github.io/GolfScheduler/` shows old data.

**Fix options:**

1. Run `node generate-static.js` manually to regenerate and push.
2. Check whether the push succeeded:

   ```bash
   git log --oneline -5
   ```

   The latest commit should say `"Update schedule"`.

3. If the push failed (e.g. the working tree had unstaged changes), resolve the conflict and
   re-run:

   ```bash
   git status
   node generate-static.js
   ```

4. CDN lag: GitHub Pages can take up to 5 minutes after a push. Wait and hard-refresh the
   browser (`Ctrl+Shift+R`).

### 3.5 `npm run sync` exits with errors

**Symptom:** The sync log shows `errors=N` at the end.

**Common causes:**

- **Login failure** — credentials in `.env` are wrong or the site is down. Verify with a manual
  browser login to `https://fort-walton-member.book.teeitup.golf`.
- **Playwright not installed** — run `npx playwright install chromium` once after `npm install`.
- **Browser crash** — try running once with `HEADLESS=false npm run sync` to watch the browser
  and identify the failure step.
- **Network timeout** — the site uses `waitUntil: 'domcontentloaded'` but some pages are slow.
  Re-run sync; transient timeouts usually clear on a second attempt.

---

## 4. Manual DB Inspection Commands

All of the following are Node.js one-liners that load the DB via `sql.js` directly.
Run them from the project root in Git Bash.

### 4.1 List all upcoming confirmed bookings

```bash
node -e "
const db = require('./src/db');
db.getAllUpcoming().then(rows => {
  const confirmed = rows.filter(r => r.status === 'confirmed');
  console.log('Confirmed bookings (' + confirmed.length + '):');
  for (const r of confirmed) {
    console.log(\`  \${r.date} \${r.actual_time||r.target_time} \${r.course} slot\${r.slot_index} golfer\${r.golfer_index} Res#\${r.confirmation_number||'(none)'}\`);
  }
  process.exit(0);
});
"
```

### 4.2 Find rows with placeholder confirmation numbers

```bash
node -e "
const db = require('./src/db');
const PLACEHOLDERS = ['EXISTING_RESERVATION', 'access', 'CONFIRMED'];
db.getAllUpcoming().then(rows => {
  const placeholders = rows.filter(r =>
    r.status === 'confirmed' &&
    (!r.confirmation_number || PLACEHOLDERS.includes(r.confirmation_number) || !/^\d+$/.test(r.confirmation_number))
  );
  if (placeholders.length === 0) {
    console.log('No placeholder confirmation numbers found.');
  } else {
    console.log('Rows with placeholder confirmation numbers (' + placeholders.length + '):');
    for (const r of placeholders)
      console.log(\`  id=\${r.id} \${r.date} \${r.actual_time||r.target_time} \${r.course} conf=\${r.confirmation_number||'(null)'}\`);
  }
  process.exit(0);
});
"
```

### 4.3 Find failed rows that have exceeded max retries (3 attempts)

```bash
node -e "
const db = require('./src/db');
db.getAllUpcoming().then(rows => {
  const stuck = rows.filter(r => r.status === 'failed' && r.attempts >= 3);
  console.log('Stuck failed rows (' + stuck.length + '):');
  for (const r of stuck)
    console.log(\`  id=\${r.id} \${r.date} \${r.target_time} \${r.course} attempts=\${r.attempts} error=\${(r.error_message||'').slice(0,80)}\`);
  process.exit(0);
});
"
```

### 4.4 Summarize DB status counts

```bash
node -e "
const db = require('./src/db');
db.getAllUpcoming().then(rows => {
  const counts = rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status]||0) + 1;
    return acc;
  }, {});
  console.log('Status summary for upcoming rows:');
  for (const [status, count] of Object.entries(counts).sort())
    console.log(\`  \${status}: \${count}\`);
  console.log('  TOTAL:', rows.length);
  process.exit(0);
});
"
```

### 4.5 Find rows where actual_time differs significantly from target_time

```bash
node -e "
const db = require('./src/db');
db.getAllUpcoming().then(rows => {
  const toMin = t => { if (!t) return -1; const [h,m]=t.split(':').map(Number); return h*60+m; };
  const drifted = rows.filter(r => {
    if (r.status !== 'confirmed' || !r.actual_time) return false;
    return Math.abs(toMin(r.actual_time) - toMin(r.target_time)) > 60;
  });
  if (!drifted.length) { console.log('No large time drift found.'); }
  else for (const r of drifted)
    console.log(\`  id=\${r.id} \${r.date} target=\${r.target_time} actual=\${r.actual_time} diff=\${toMin(r.actual_time)-toMin(r.target_time)}min\`);
  process.exit(0);
});
"
```

### 4.6 Show last sync timestamp

```bash
node -e "const db=require('./src/db'); console.log('Last sync:', db.getLastSyncAt()); process.exit(0);"
```

### 4.7 Query the raw SQLite file directly (advanced)

The DB is a standard SQLite file at `./data/bookings.db`. You can open it with any SQLite
browser (e.g. DB Browser for SQLite) or with the `sqlite3` CLI if installed:

```bash
sqlite3 ./data/bookings.db "SELECT date, actual_time, course, slot_index, status, confirmation_number FROM bookings WHERE date >= date('now') ORDER BY date, slot_index;"
```

---

## 5. Full Reset and Resync Procedure

Use this procedure when things are badly out of sync — for example, after a bulk manual
cancellation on the site, after an account switch, or after the DB has become corrupted.

**Warning:** Steps 5.2 and 5.3 are destructive. Back up the DB first.

```bash
cp ./data/bookings.db ./data/bookings.db.bak
```

### Step 5.1 — Cancel site reservations that should not exist

If there are bookings on the site that you want to cancel (e.g. they were made under the wrong
account, or the schedule has changed), use `cancel-and-rebook.js` which cancels all confirmed
bookings from a given date onward and purges the corresponding DB rows:

```bash
# Edit FROM_DATE inside cancel-and-rebook.js first if needed (default: 2026-03-16)
HEADLESS=true node cancel-and-rebook.js
```

What it does:
1. Reads all `confirmed` rows with real numeric confirmation numbers from `FROM_DATE` onward.
2. Opens a browser, logs in as the primary golfer (`mvisanu@gmail.com`), and calls
   `site.cancelReservations()` for each.
3. Marks successfully cancelled rows as `cancelled` in the DB.
4. Purges **all** DB rows from `FROM_DATE` onward (including pending, failed, skipped rows).
5. Prints instructions to run `npm run init && npm run book`.

### Step 5.2 — Repopulate the DB with fresh pending slots

```bash
npm run init
```

This recomputes all scheduled slots for the next `BOOKING_HORIZON_DAYS` days and inserts
`pending` rows for any that do not already exist.

### Step 5.3 — Run a full sync to pull in anything already booked on the site

```bash
HEADLESS=true npm run sync
```

Sync will find any reservations that exist on the site and update the newly-created pending
rows with their real confirmation numbers and actual times.

### Step 5.4 — Book remaining pending slots

```bash
HEADLESS=true npm run book
```

The booking engine will attempt to book all `pending` slots (and retry `failed` slots with
`attempts < 3`).

### Step 5.5 — Resolve remaining placeholders

```bash
HEADLESS=true node fix-confirmations.js
```

### Step 5.6 — Regenerate GitHub Pages

```bash
node generate-static.js
```

---

## 6. Verification Checklist

Run through each item after completing a sync cycle to confirm everything is in sync.

### Database

- [ ] `npm run status` shows the expected upcoming bookings with `confirmed` status
- [ ] No `confirmed` rows have placeholder confirmation numbers (`EXISTING_RESERVATION`,
      `access`, `CONFIRMED`) for dates within the next 7 days
- [ ] No `failed` rows with `attempts >= 3` that represent real bookings you expect to hold
- [ ] `node -e "const db=require('./src/db'); console.log(db.getLastSyncAt()); process.exit(0);"` shows
      a timestamp from today

### Local Web UI (`http://localhost:3009`)

- [ ] Green chips appear on calendar days that have confirmed bookings
- [ ] Clicking a chip shows real numeric confirmation numbers (not `—`) for bookings within
      the last 7 days
- [ ] "Last synced" timestamp in the page header matches today's date
- [ ] "All Bookings" table at the bottom of the page reflects the expected status breakdown
- [ ] No red (failed) chips for dates that you know are booked on the site

### GitHub Pages (`https://mvisanu.github.io/GolfScheduler/`)

- [ ] The page header shows today's "Last synced" timestamp (or at most 24 hours old)
- [ ] Confirmed booking count in the header matches what `npm run status` reports
- [ ] Calendar shows green chips on all expected booking dates
- [ ] `git log --oneline -3` shows an `"Update schedule"` commit that post-dates the last
      sync run

### Site Cross-Check (manual spot check)

- [ ] Log in to `https://fort-walton-member.book.teeitup.golf` as `mvisanu@gmail.com`
- [ ] Navigate to Reservations / Upcoming
- [ ] Confirm that every booking listed on the site has a corresponding `confirmed` row in
      the DB with a matching confirmation number
- [ ] Confirm that no extra bookings appear on the site that are not in the DB

---

## Quick Reference: Command Summary

| Goal | Command |
|---|---|
| Full routine sync | `HEADLESS=true npm run sync` |
| Resolve placeholder conf numbers | `HEADLESS=true node fix-confirmations.js` |
| Reset stuck failed rows | `node reset-failed.js` |
| Populate scheduled slots | `npm run init` |
| Book pending slots | `HEADLESS=true npm run book` |
| Push GitHub Pages | `node generate-static.js` |
| Show booking status table | `npm run status` |
| Start local web UI | `npm run web` |
| Run daily scheduler manually | `HEADLESS=true npm run scheduler` |
| Nuclear reset + rebook | `HEADLESS=true node cancel-and-rebook.js` then `npm run init` then `HEADLESS=true npm run book` |

---

## Sync Data Flow Diagram

```
fort-walton-member.book.teeitup.golf
          |
          | scrapeReservationHistory()    (Step 1 — ~7 day window)
          | fetchReservationById()        (Step 2 — ID probing ±10)
          v
     src/sync.js  ──►  src/reconcile.js
          |                    |
          |          updateBookingSync()
          v                    v
   data/bookings.db   ◄────────┘
          |
          |─────────────────────────────► http://localhost:3009  (npm run web)
          |                                 (60-second auto-refresh via /api/bookings)
          |
          └──── node generate-static.js ──► docs/index.html
                                                   |
                                            git push origin master
                                                   |
                                                   v
                                    mvisanu.github.io/GolfScheduler/
```
