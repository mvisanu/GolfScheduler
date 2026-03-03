# TASKS.md

> Generated from: PRD.md
> Generated on: 2026-03-03
> Total tasks: 22

---

## Assumptions & Clarifications

**A1 — Time display root cause.** The `actual_time` column is populated correctly by `db.markSuccess()` for freshly-booked slots, but many existing slots carry placeholder confirmation numbers (`EXISTING_RESERVATION`, `CONFIRMED`, `access`) and a matching placeholder `actual_time` or no `actual_time` at all. `web.js` already uses `b.actual_time || b.target_time` in the chip template (line 399), so the display expression itself is correct. The M1 fix is therefore a data-accuracy problem solved by the sync engine (M2), not a template change. A targeted display-layer fix (TASK-001) is still warranted to ensure the modal label accurately distinguishes "Confirmed Time" from "Target Time".

**A2 — `lastSyncAt` storage.** Stored in `./data/sync-meta.json` (plain JSON, no schema change required). This is the simpler option and avoids adding a config table to the SQLite schema.

**A3 — Headless mode.** Controlled by a new `HEADLESS` environment variable. `HEADLESS=true` is set for the `scheduler` daemon command; the interactive `book` and `sync` commands default to `false` (visible browser) matching current behaviour. This is documented in the `.env.example`.

**A4 — Cron implementation.** Pure `setTimeout` loop calculating the next 06:00 firing time using `dayjs`; no new npm package required (dayjs is already a dependency).

**A5 — `npm run sync` wires to `src/sync.js`.** The existing `sync-reservations.js` root-level script and its `npm run sync` entry in `package.json` are superseded by the new `src/sync.js` module. The root script is deleted after TASK-007 is complete.

**A6 — Unmatched site reservations.** Log-and-ignore as specified in PRD Section 4.3 Non-Goals. The sync will log them at INFO level with a `[SYNC] Unmatched site reservation` prefix but will not create new DB records.

**A7 — Session sharing between sync and booking.** `sync.js` accepts an optional `SiteAutomation` instance argument so the daily job can reuse the already-authenticated browser session. When called standalone (`npm run sync`), it creates its own session.

**A8 — Mobile breakpoint for list view.** `< 640px` collapses calendar to a vertical booking-card list showing only days with bookings, exactly as specified in PRD Section 12.

**A9 — Auto-refresh.** Implemented as a client-side `setInterval` polling `GET /api/bookings` every 60 seconds and re-rendering the chip area without a full page reload (FR-038, P2).

---

## Parallel Work Waves

**Wave 1 (no blockers):** TASK-001, TASK-002, TASK-003, TASK-004

**Wave 2 (needs Wave 1 foundations):** TASK-005, TASK-006, TASK-007, TASK-008

**Wave 3:** TASK-009, TASK-010, TASK-011, TASK-012

**Wave 4:** TASK-013, TASK-014, TASK-015

**Wave 5:** TASK-016, TASK-017, TASK-018

**Wave 6:** TASK-019, TASK-020

**Wave 7:** TASK-021, TASK-022

---

## Tasks

---

### TASK-001 · Fix booking detail modal to label time correctly (Confirmed vs Target)

| Field | Value |
|---|---|
| **Owner** | frontend-developer |
| **Effort** | S |
| **Priority** | P0 |
| **Blocked by** | none |

**Context.**
`web.js` line 399 already renders `b.actual_time || b.target_time` on calendar chips. The modal (`openModal`) currently shows a single "Time" label regardless of whether the value is `actual_time` or `target_time`. The fix adds a secondary "Target Time" row to the modal grid and changes the primary "Time" label to "Confirmed Time" when `actual_time` is present.

**Changes required.**
- In `generateCalendarHTML`, add `data-target-time` and `data-actual-time` attributes to each chip element.
- In the table row HTML, add `data-target-time` and `data-actual-time` attributes.
- In the modal HTML, split the single "Time" row into two rows: "Confirmed Time" (shows `actual_time` or "—") and "Target Time" (shows `target_time`).
- Update `openModal(data)` JS function to populate both new modal fields.

**Acceptance Criteria:**
- [ ] When a confirmed booking with `actual_time` set is clicked, the modal shows "Confirmed Time: HH:MM" and "Target Time: HH:MM" as separate rows.
- [ ] When a pending/failed booking with null `actual_time` is clicked, the modal shows "Confirmed Time: —" and "Target Time: HH:MM".
- [ ] The calendar chip still displays `actual_time` when present, `target_time` otherwise — no regression.
- [ ] The "All Bookings" table already has separate Target Time and Actual Time columns — verify no change is needed and both columns render correctly.
- [ ] All time values display in 24-hour HH:MM format (no 12-hour format introduced).

---

### TASK-002 · Add `updateBookingSync` method to `db.js`

| Field | Value |
|---|---|
| **Owner** | backend-architect |
| **Effort** | S |
| **Priority** | P0 |
| **Blocked by** | none |

**Context.**
The sync engine needs a DB write path that sets `actual_time`, `confirmation_number`, and `course` without touching `status` (unlike `markSuccess` which always sets `status = 'confirmed'`). It also needs to preserve `status = 'cancelled'` records that match a site reservation — the sync should correct the data and restore them to `confirmed`.

**Changes required.**
- Add `async updateBookingSync(id, { actualTime, course, confirmationNumber, restoreConfirmed })` to `db.js`.
- When `restoreConfirmed = true`, set `status = 'confirmed'`; otherwise preserve the existing status.
- Always update `actual_time`, `course` (if provided and not `'Unknown'`), `confirmation_number`, and `updated_at`.
- Call `save()` after the update.

**Acceptance Criteria:**
- [ ] Calling `updateBookingSync(id, { actualTime: '08:10', confirmationNumber: '418947571', restoreConfirmed: true })` sets `status = 'confirmed'`, `actual_time = '08:10'`, `confirmation_number = '418947571'`.
- [ ] Calling `updateBookingSync(id, { actualTime: '08:10', confirmationNumber: '418947571', restoreConfirmed: false })` updates the time and confirmation number but leaves `status` unchanged.
- [ ] `updated_at` is set to the current datetime after every call.
- [ ] `save()` is called and the DB file is persisted after the update.
- [ ] Passing `course = 'Unknown'` does not overwrite the existing course value.

---

### TASK-003 · Create `./data/sync-meta.json` schema and read/write helpers in `db.js`

| Field | Value |
|---|---|
| **Owner** | backend-architect |
| **Effort** | XS |
| **Priority** | P1 |
| **Blocked by** | none |

**Context.**
`lastSyncAt` needs to persist across process restarts. A small JSON file at `./data/sync-meta.json` is simpler than a new DB table. Two helper functions belong in `db.js` so both `sync.js` and `web.js` can access them consistently.

**Changes required.**
- Add `getLastSyncAt()` — reads `./data/sync-meta.json`, returns the `lastSyncAt` ISO string or `null` if file doesn't exist.
- Add `setLastSyncAt(isoString)` — writes `{ lastSyncAt: isoString }` to `./data/sync-meta.json`, creating the file if absent.
- The `./data/` directory is guaranteed to exist by the time `db.js` runs (it is created in `getDb()`), so no extra directory creation is needed.

**Acceptance Criteria:**
- [ ] `setLastSyncAt('2026-03-03T06:02:00.000Z')` creates `./data/sync-meta.json` with `{ "lastSyncAt": "2026-03-03T06:02:00.000Z" }`.
- [ ] `getLastSyncAt()` returns the previously written ISO string.
- [ ] `getLastSyncAt()` returns `null` when the file does not exist (no thrown error).
- [ ] Overwriting an existing file with a new `setLastSyncAt` call replaces the full file contents.

---

### TASK-004 · Add `HEADLESS` env var support to `site.js`

| Field | Value |
|---|---|
| **Owner** | backend-architect |
| **Effort** | XS |
| **Priority** | P1 |
| **Blocked by** | none |

**Context.**
The daily 06:00 automated job should run headless (no visible browser window) to avoid popping a Chromium window while the machine is in use. Interactive commands (`book`, `sync`, `cancel`) should default to visible for debugging. The toggle must be env-var-driven so no code change is needed to switch modes.

**Changes required.**
- In `site.js`, read `process.env.HEADLESS` when constructing the Playwright browser launch options.
- Default to `headless: false` when `HEADLESS` is unset or any value other than `'true'`.
- Set `headless: true` when `HEADLESS === 'true'`.
- Document the variable in `.env.example` (add a commented line `# HEADLESS=true`).

**Acceptance Criteria:**
- [ ] When `HEADLESS=true` is set in the environment, `chromium.launch()` is called with `{ headless: true }`.
- [ ] When `HEADLESS` is unset, `chromium.launch()` is called with `{ headless: false }`.
- [ ] `.env.example` contains a commented `# HEADLESS=true` line with a brief explanation.
- [ ] No other behaviour in `site.js` changes — only the `headless` launch option is affected.

---

### TASK-005 · Extract reservation-scraping logic into `SiteAutomation.scrapeReservationHistory()`

| Field | Value |
|---|---|
| **Owner** | backend-architect |
| **Effort** | M |
| **Priority** | P0 |
| **Blocked by** | TASK-004 |

**Context.**
`sync-reservations.js` contains standalone functions (`scrapeVisibleCards`, `fetchReservationById`, `extractDetailPage`) that implement the two-pronged scrape strategy. These must be moved into `site.js` as a method on `SiteAutomation` so `sync.js` can call them without duplicating browser logic. The root-level utility script will be superseded and removed after TASK-007.

**Changes required.**
- Move `extractDetailPage(page, fallbackId)` logic into a private `_extractDetailPage()` instance method on `SiteAutomation`.
- Move `scrapeVisibleCards(page)` logic into `async scrapeReservationHistory()` public instance method — returns `Array<{ date, time, course, confirmationNumber }>`.
- Move `fetchReservationById(page, id)` logic into `async fetchReservationById(id)` public instance method.
- Both public methods use `this.page` rather than accepting a `page` parameter.
- All `console.log` calls inside the moved methods are replaced with `this.logger.info(...)` / `this.logger.warn(...)` calls (consistent with how `site.js` handles logging elsewhere — check whether it uses a passed-in logger or `require('./logger')` directly).
- The method signatures must be backwards-compatible with how `sync-reservations.js` called the standalone functions (same return shapes).

**Acceptance Criteria:**
- [ ] `site.scrapeReservationHistory()` returns an array of `{ date, time, course, confirmationNumber }` objects matching what the visible reservation list contains.
- [ ] `site.fetchReservationById(id)` returns `{ date, time, course, confirmationNumber }` or `null` if the ID 404s.
- [ ] Both methods require an active Playwright session (`this.page` must be initialised); calling them before `site.init()` throws a clear error.
- [ ] Log output uses the existing Winston logger (not `console.log`).
- [ ] The existing `getExistingReservations(date)` method in `site.js` is unchanged.

---

### TASK-006 · Add `applyToDate` reconciliation logic to `db.js` as `reconcileDate()`

| Field | Value |
|---|---|
| **Owner** | backend-architect |
| **Effort** | S |
| **Priority** | P0 |
| **Blocked by** | TASK-002 |

**Context.**
`sync-reservations.js` contains an `applyToDate(date, siteSlots, dbSlots, stats)` function that performs the order-based matching (site slots sorted by time, DB slots sorted by `slot_index`). This logic must be promoted into a proper module-level function accessible to `sync.js`, and must use the new `updateBookingSync` DB method and the Winston logger rather than `console.log`.

**Changes required.**
- Create a standalone exported async function `reconcileDate(date, siteSlots, dbSlots, logger)` in a new file `src/reconcile.js` (or alternatively add it directly to `sync.js` — agent's choice based on clarity).
- The function signature: `(date: string, siteSlots: Array<{time, course, confirmationNumber}>, dbSlots: Array<booking_row>, logger) => Promise<{ updated: number, notFound: number, warnings: string[] }>`.
- Matching logic: sort `siteSlots` ascending by time, sort `dbSlots` ascending by `slot_index`, pair positionally (slot 0 → earliest site reservation, etc.).
- For each pair: if `actual_time` or `confirmation_number` differ from site data, call `db.updateBookingSync(id, { actualTime, course, confirmationNumber, restoreConfirmed: true })` and log at INFO with `[SYNC]` prefix: `"[SYNC] TASK-006 Updated booking #ID date DATE slot SLOT: actual_time OLD → NEW, confirmation_number OLD → NEW"`.
- If a placeholder confirmation number (`EXISTING_RESERVATION`, `CONFIRMED`, `access`) is present in DB and the site provides a real numeric value, treat this as a needed update (FR-015).
- If a DB slot has no corresponding site slot at that position, log a warning (FR-012) but do not change DB status.
- Return `{ updated, notFound, warnings }`.

**Acceptance Criteria:**
- [ ] A DB slot with `actual_time = '08:00'` and `confirmation_number = 'EXISTING_RESERVATION'` is updated to `actual_time = '08:10'` and `confirmation_number = '418947571'` when the site slot at position 0 shows `{ time: '08:10', confirmationNumber: '418947571' }`.
- [ ] A DB slot already matching the site data (same `actual_time`, same `confirmation_number`) is not written to the DB (no unnecessary update call).
- [ ] A DB slot at position 2 with no corresponding site slot at position 2 is not modified; a warning string is added to the return `warnings` array.
- [ ] All log entries include the `[SYNC]` prefix.
- [ ] The function returns correct `{ updated, notFound, warnings }` counts.

---

### TASK-007 · Build `src/sync.js` — `runSync()` orchestrator

| Field | Value |
|---|---|
| **Owner** | backend-architect |
| **Effort** | M |
| **Priority** | P0 |
| **Blocked by** | TASK-003, TASK-005, TASK-006 |

**Context.**
This is the central sync module. It orchestrates: login (or reuse an existing session), scrape visible reservation list, group by date, apply `reconcileDate` for each date, run Step 2 direct-ID probes for dates still needing a real confirmation number, persist `lastSyncAt`, and return a summary object.

**Changes required.**
- Create `src/sync.js` exporting `async runSync(siteInstance = null)`.
- If `siteInstance` is null, create a new `SiteAutomation()`, call `init()`, navigate to booking page, `login()`, and close when done (wrapped in try/finally).
- If `siteInstance` is provided (for daily-job session reuse), skip `init()`/`login()`/`close()`.
- Step 1: call `siteInstance.scrapeReservationHistory()` to get all visible upcoming reservations.
- Step 2: identify DB bookings still carrying placeholder confirmation numbers. Collect any known numeric confirmation numbers from other DB records. For each known ID, call `siteInstance.fetchReservationById(id)` for IDs `± PROBE_RADIUS` (default 10, same as existing `sync-reservations.js` Step 2 logic). Apply results to dates still needing sync.
- Apply `reconcileDate()` for each date found in Steps 1 and 2.
- Log a `[SYNC]` WARNING per FR-012 for any `confirmed` DB booking with a real numeric confirmation number where the date was visible to the sync but no matching site reservation was found.
- After all reconciliation, call `db.setLastSyncAt(new Date().toISOString())`.
- Return `{ checked: N, updated: N, warnings: N, errors: N }` per FR-016.
- Log start time, completion time, and summary at INFO level with `[SYNC]` prefix per FR-013.

**Acceptance Criteria:**
- [ ] `runSync()` called with no arguments completes without error when called against a live site with valid credentials.
- [ ] After `runSync()`, all DB bookings for dates visible in the site's history window have correct `actual_time` and `confirmation_number` values matching the site.
- [ ] `./data/sync-meta.json` is updated with the current ISO timestamp after a successful run.
- [ ] The return value is an object with exactly `{ checked, updated, warnings, errors }` numeric keys.
- [ ] Passing an existing authenticated `SiteAutomation` instance reuses it without calling `init()` or `login()` again.
- [ ] All log lines include `[SYNC]` prefix.
- [ ] A booking with `status = 'confirmed'`, a real numeric confirmation number, and a date within the site's visible window that is not found on the site triggers a `WARN` log (not a DB update).

---

### TASK-008 · Wire `npm run sync` CLI command to `src/sync.js`

| Field | Value |
|---|---|
| **Owner** | backend-architect |
| **Effort** | S |
| **Priority** | P1 |
| **Blocked by** | TASK-007 |

**Context.**
Currently `npm run sync` points to the root-level `sync-reservations.js`. After TASK-007, the canonical sync entry point is `src/sync.js`. The CLI command needs updating and the root-level script needs to be removed to avoid confusion.

**Changes required.**
- Add a `sync` command to `src/index.js` (Commander program): `program.command('sync').description('Sync DB with FWB site reservation history').action(async () => { const { runSync } = require('./sync'); const result = await runSync(); console.log('Sync complete:', JSON.stringify(result, null, 2)); process.exit(0); })`.
- Update `package.json` `scripts.sync` from `"node sync-reservations.js"` to `"node src/index.js sync"`.
- Delete `sync-reservations.js` from the project root.
- Delete `update-saturdays.js` and `find-saturdays.js` from the project root (superseded by the new automated sync).

**Acceptance Criteria:**
- [ ] `npm run sync` runs `src/index.js sync` and prints the summary JSON to stdout.
- [ ] `node src/index.js sync` produces `[SYNC]` log output in `golf-scheduler.log`.
- [ ] `sync-reservations.js` no longer exists in the project root.
- [ ] `update-saturdays.js` and `find-saturdays.js` no longer exist in the project root.
- [ ] `npm run book`, `npm run scheduler`, `npm run status`, `npm run web`, `npm run cancel` all continue to work (no regressions in other commands).

---

### TASK-009 · Replace 6-hour interval scheduler with daily 06:00 cron using `setTimeout`

| Field | Value |
|---|---|
| **Owner** | backend-architect |
| **Effort** | M |
| **Priority** | P0 |
| **Blocked by** | TASK-007, TASK-008 |

**Context.**
`src/index.js` `scheduler` command uses `setInterval(runOnce, 6 * 60 * 60 * 1000)`. This must be replaced with a `setTimeout`-based loop that always fires at 06:00 local time (or `SCHEDULER_HOUR` if set). The daily job sequence is: sync → book. If the startup time is already past today's fire time, it must run immediately and then schedule tomorrow's 06:00 fire.

**Changes required.**
- Add `SCHEDULER_HOUR` env var reading in `config.js` (default `6`).
- Rewrite the `scheduler` command's `action` handler in `src/index.js`:
  - Compute `msUntilNextFire(hour)`: using `dayjs().tz(config.timezone)`, find next occurrence of HH:00 that is in the future. If 0 ms remain (past today's fire time and we haven't run yet today), return 0 (run immediately).
  - On each fire: log `[SCHEDULER] Daily job starting at ${now.format()}`, call `runSync()` then `BookingEngine.run()` (sharing the `SiteAutomation` session if possible — see TASK-010), log summary, then schedule next fire with `setTimeout(runOnce, msUntilNextFire)`.
  - Set `HEADLESS=true` for the environment before launching the daily job processes (or pass as option).
- The "run immediately on startup if past fire time" logic implements FR-023.

**Acceptance Criteria:**
- [ ] `npm run scheduler` starts without error and logs `[SCHEDULER] Daily job starting` at the correct 06:00 local time.
- [ ] If the process starts at 07:00, the job runs immediately (not waiting until next-day 06:00).
- [ ] If the process starts at 05:00, the job waits until 06:00 before running.
- [ ] After a run completes, the next fire is scheduled for 06:00 the following day.
- [ ] `SCHEDULER_HOUR=8` in `.env` changes the fire time to 08:00 without any code change.
- [ ] Both sync and booking engine run in sequence; a sync failure is caught, logged, and the booking engine still runs.

---

### TASK-010 · Share `SiteAutomation` session between sync and booking engine in daily job

| Field | Value |
|---|---|
| **Owner** | backend-architect |
| **Effort** | S |
| **Priority** | P0 |
| **Blocked by** | TASK-009 |

**Context.**
FR-021 requires that sync and booking run in the same Playwright session "where possible to reduce overhead and login round-trips." `runSync(siteInstance)` already accepts an optional instance (TASK-007). `BookingEngine` currently creates its own `SiteAutomation` internally. The daily job must create one shared session, pass it to both.

**Changes required.**
- Add an optional `site` parameter to `BookingEngine` constructor: `constructor({ dryRun = false, site = null } = {})`. When `site` is provided, use it instead of creating a new `SiteAutomation()`. Skip `site.init()` and `site.login()` in `BookingEngine.run()` — assume already authenticated.
- In the daily job's `runOnce()` function (TASK-009), create `const site = new SiteAutomation()`, call `site.init()` and `site.login()`, then pass to `runSync(site)` and `new BookingEngine({ site }).run()`. Call `site.close()` in a `finally` block.
- Ensure `BookingEngine.run()` does NOT call `site.close()` when a shared site instance is provided.

**Acceptance Criteria:**
- [ ] The daily job creates exactly one Playwright browser instance per run (verified by checking that only one Chromium window/process is spawned).
- [ ] `BookingEngine` constructed with a `site` instance does not call `site.init()`, `site.login()`, or `site.close()`.
- [ ] `BookingEngine` constructed without a `site` instance behaves identically to current behaviour (creates its own session, closes it).
- [ ] If `runSync()` throws, the shared `site` is still closed cleanly in the `finally` block.

---

### TASK-011 · Log daily job start/completion summary at INFO level

| Field | Value |
|---|---|
| **Owner** | backend-architect |
| **Effort** | XS |
| **Priority** | P0 |
| **Blocked by** | TASK-010 |

**Context.**
FR-022 requires the daily job to log its start time, completion time, and a combined sync + booking summary. This is a small addition to the daily job's `runOnce()` function once TASK-010 is in place.

**Changes required.**
- At the start of `runOnce()`, log: `[SCHEDULER] === Daily job started at ${startTime.format('YYYY-MM-DD HH:mm:ss z')} ===`.
- After sync completes, log: `[SCHEDULER] Sync result: checked=${r.checked} updated=${r.updated} warnings=${r.warnings} errors=${r.errors}`.
- After booking engine completes, log: `[SCHEDULER] Booking result: total=${s.total} booked=${s.booked} failed=${s.failed}`.
- At the end, log: `[SCHEDULER] === Daily job completed in ${elapsed}ms ===`.

**Acceptance Criteria:**
- [ ] `golf-scheduler.log` contains all four log lines after a daily job run.
- [ ] Elapsed time in milliseconds is accurately computed (end - start timestamps).
- [ ] Log lines use the `[SCHEDULER]` prefix consistently.
- [ ] If sync throws, the start/completion log lines still appear (surrounding the error log).

---

### TASK-012 · Add `SCHEDULER_HOUR` to `config.js` and `.env.example`

| Field | Value |
|---|---|
| **Owner** | backend-architect |
| **Effort** | XS |
| **Priority** | P2 |
| **Blocked by** | TASK-009 |

**Context.**
FR-025 specifies a `SCHEDULER_HOUR` env var. TASK-009 reads it but this task ensures it is properly defined in `config.js` (parsed, validated, defaulted) and documented in `.env.example`.

**Changes required.**
- In `config.js`, add `schedulerHour: parseInt(process.env.SCHEDULER_HOUR || '6', 10)` to the exported config object.
- Validate: if `schedulerHour < 0 || schedulerHour > 23`, log an error and default to 6.
- Update TASK-009's implementation to read `config.schedulerHour` rather than directly reading `process.env.SCHEDULER_HOUR`.
- Add `# SCHEDULER_HOUR=6` with a comment to `.env.example`.

**Acceptance Criteria:**
- [ ] `config.schedulerHour` is `6` when `SCHEDULER_HOUR` is not set.
- [ ] `SCHEDULER_HOUR=8` in `.env` results in `config.schedulerHour === 8`.
- [ ] An out-of-range value (e.g., `SCHEDULER_HOUR=25`) is caught and defaults to `6` with a warning log.
- [ ] `.env.example` includes the new variable with a description comment.

---

### TASK-013 · Implement new CSS design tokens and global mobile-first base styles

| Field | Value |
|---|---|
| **Owner** | frontend-developer |
| **Effort** | M |
| **Priority** | P0 |
| **Blocked by** | TASK-001 |

**Context.**
FR-030, FR-032. The current palette is built around `#cb6301` (burnt orange). All CSS lives inline in `web.js` as a template string. This task replaces the colour values with the PRD-specified tokens and ensures the base layout has no horizontal scroll at 375px. No structural HTML changes yet — those come in later tasks.

**Design tokens to apply (replace existing colour values):**
| Token | Value |
|---|---|
| `--bg-page` | `#F8F9FA` |
| `--bg-card` | `#FFFFFF` |
| `--bg-header` | `#1B3A2D` |
| `--text-primary` | `#1A1A1A` |
| `--text-secondary` | `#6B7280` |
| `--accent-confirmed` | `#2D6A4F` |
| `--accent-pending` | `#B45309` |
| `--accent-failed` | `#DC2626` |
| `--accent-cancelled` | `#9CA3AF` |
| `--accent-action` | `#1B3A2D` |
| `--border` | `#E5E7EB` |

**Changes required:**
- Declare all tokens as CSS custom properties on `:root`.
- Replace every hardcoded `#cb6301`, `#a84f00` etc. with the corresponding token reference.
- Set `body { max-width: 100%; overflow-x: hidden; }`.
- Set `img, table, .calendar { max-width: 100%; }`.
- Verify WCAG AA contrast for all text-on-background pairs (can be spot-checked manually using the values above — confirmed-on-white is `#2D6A4F` which is 5.8:1, pending-on-white `#B45309` is 4.6:1, header text white-on-`#1B3A2D` is 9.8:1).

**Acceptance Criteria:**
- [ ] No `#cb6301` or `#a84f00` values remain anywhere in the CSS.
- [ ] The page header background is `#1B3A2D` (dark green).
- [ ] Confirmed chips are `#2D6A4F` (muted green).
- [ ] Pending chips are `#B45309` (amber).
- [ ] The page renders without a horizontal scrollbar at 375px viewport width in browser DevTools mobile simulation.
- [ ] All status colour pairs pass WCAG AA (4.5:1) when checked with a contrast tool.

---

### TASK-014 · Add mobile list view (< 640px): collapse calendar grid to booking-card list

| Field | Value |
|---|---|
| **Owner** | frontend-developer |
| **Effort** | M |
| **Priority** | P0 |
| **Blocked by** | TASK-013 |

**Context.**
FR-031. On narrow screens the 7-column grid becomes unreadable. Below 640px, the calendar must switch to a vertical list showing only days that have bookings, each as a card with: date, day name, time, course, and status badge.

**Changes required in `web.js`:**
- In `generateCalendarHTML()`, add a `mobile-list` div alongside the existing `.calendar` grid. The mobile list is a `<div class="mobile-booking-list">` containing one `<div class="mobile-booking-card">` per day that has bookings. Each card shows: date header (e.g., "Saturday, March 7"), then per-booking chips (same `booking-chip` elements reused).
- Add CSS:
  ```css
  @media (max-width: 639px) {
    .calendar { display: none; }
    .mobile-booking-list { display: block; }
  }
  @media (min-width: 640px) {
    .mobile-booking-list { display: none; }
  }
  ```
- Mobile booking card styling: `padding: 12px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-card); margin-bottom: 8px;`.
- Date header within card: `font-family: 'Manrope'; font-weight: 700; font-size: 1rem; color: var(--text-primary); margin-bottom: 8px;`.
- Booking chips in mobile list must meet the 44px minimum touch target height (FR-033): `min-height: 44px; display: flex; align-items: center; padding: 10px 12px;`.

**Acceptance Criteria:**
- [ ] At 375px viewport, the 7-column grid is hidden and the mobile list is visible.
- [ ] At 640px and above, the mobile list is hidden and the grid is visible.
- [ ] Each mobile booking card shows the full date + day name as a heading and one chip per booking.
- [ ] Booking chips in the mobile list have a minimum height of 44px and are tappable.
- [ ] Days with no bookings do not appear in the mobile list (only booked days shown).
- [ ] Tapping a chip on mobile opens the booking detail modal correctly.

---

### TASK-015 · Ensure 44px touch targets on all interactive elements (mobile)

| Field | Value |
|---|---|
| **Owner** | frontend-developer |
| **Effort** | S |
| **Priority** | P0 |
| **Blocked by** | TASK-014 |

**Context.**
FR-033. Beyond the chips addressed in TASK-014, the month navigation buttons, "Schedule Month" / "Book Now" buttons, and the Cancel buttons in the table must all meet the 44px minimum touch target on mobile.

**Changes required:**
- Add `@media (max-width: 639px)` rules for `.month-nav button`, `.btn-schedule-month`, `.btn-cancel-row`: `min-height: 44px; padding: 10px 16px;`.
- Modal action buttons (`.btn`) already have `padding: 9px 18px` — verify total height reaches 44px when Inter 0.9rem is applied; add `min-height: 44px` if not.
- Add `aria-label` attributes to all icon-only or ambiguous buttons: the zoom widget buttons (`aria-label="Decrease text size"` / `aria-label="Increase text size"`), the "Close" modal button.

**Acceptance Criteria:**
- [ ] All tappable elements measure >= 44px in height at 375px viewport in DevTools.
- [ ] Month navigation and schedule/book buttons have visible focus outlines on keyboard tab.
- [ ] Zoom buttons have descriptive `aria-label` attributes.
- [ ] Close and Cancel modal buttons have `aria-label` or contain sufficient visible text.
- [ ] No regressions on desktop layout (buttons are not made unnecessarily large above 640px).

---

### TASK-016 · Hide zoom widget on mobile viewports

| Field | Value |
|---|---|
| **Owner** | frontend-developer |
| **Effort** | XS |
| **Priority** | P1 |
| **Blocked by** | TASK-013 |

**Context.**
FR-034. The floating zoom widget at bottom-right is irrelevant on touch devices (users pinch-to-zoom) and wastes screen space. It should be hidden below 640px.

**Changes required:**
- Add `@media (max-width: 639px) { #zoom-control { display: none !important; } }` to the CSS block in `web.js`.

**Acceptance Criteria:**
- [ ] The zoom widget is not visible at 375px viewport width.
- [ ] The zoom widget is still visible and functional at 640px and above.
- [ ] The `localStorage` zoom preference saved on desktop does not interfere with mobile rendering.

---

### TASK-017 · Add `overflow-x: auto` wrapper to the "All Bookings" table on mobile

| Field | Value |
|---|---|
| **Owner** | frontend-developer |
| **Effort** | XS |
| **Priority** | P1 |
| **Blocked by** | TASK-013 |

**Context.**
FR-035. The 10-column detail table overflows on 375px screens. The simplest compliant fix is wrapping it in a scrollable container so layout is not broken.

**Changes required:**
- Wrap the `<table class="detail-table">` in a `<div class="table-scroll-wrapper">`.
- Add CSS: `.table-scroll-wrapper { overflow-x: auto; -webkit-overflow-scrolling: touch; }`.
- Add a minimum width to each `th`/`td` so columns don't collapse illegibly: `th, td { min-width: 80px; white-space: nowrap; }` scoped inside `.detail-table`.

**Acceptance Criteria:**
- [ ] At 375px viewport, the table is horizontally scrollable without causing a page-level horizontal scrollbar.
- [ ] All 10 columns remain visible and correctly labelled at any viewport width (no columns hidden).
- [ ] Table still renders normally at desktop widths.

---

### TASK-018 · Add "Last synced" timestamp to page header

| Field | Value |
|---|---|
| **Owner** | frontend-developer |
| **Effort** | S |
| **Priority** | P1 |
| **Blocked by** | TASK-003, TASK-013 |

**Context.**
FR-036. The header must show when the data was last synced so group members know how fresh the information is. The value is read from `./data/sync-meta.json` by `db.getLastSyncAt()`.

**Changes required in `web.js`:**
- In the `GET /` handler, call `const lastSyncAt = db.getLastSyncAt()` (sync/non-async function per TASK-003).
- Format it as `"Last synced: YYYY-MM-DD HH:mm"` in the configured timezone using `dayjs`. If `lastSyncAt` is null, display `"Last synced: Never"`.
- Add the formatted string to the header HTML: replace the existing `.stats` div or add a second line below it. Example: `<div class="last-sync">Last synced: ${formattedSync}</div>`.
- Style `.last-sync { font-size: 0.8rem; opacity: 0.75; margin-top: 2px; }`.

**Acceptance Criteria:**
- [ ] The header shows "Last synced: YYYY-MM-DD HH:mm" after a successful `runSync()` call updates `sync-meta.json`.
- [ ] When `sync-meta.json` does not exist (fresh install), the header shows "Last synced: Never".
- [ ] The timestamp is shown in the configured timezone (not UTC), formatted as local time.
- [ ] The display is readable on both desktop and 375px mobile without layout overflow.

---

### TASK-019 · Implement modal keyboard accessibility (focus trap + Escape)

| Field | Value |
|---|---|
| **Owner** | frontend-developer |
| **Effort** | S |
| **Priority** | P1 |
| **Blocked by** | TASK-015 |

**Context.**
PRD Section 6.3 Accessibility requires the modal to be keyboard-navigable: focusable, closeable with Escape (already partially implemented in current code), and must trap focus while open. The current code handles Escape via `document.keydown` but does not trap focus (Tab key can exit the modal).

**Changes required:**
- When `openModal()` is called, set `document.getElementById('modal-overlay').setAttribute('tabindex', '-1')` and call `.focus()` on the first focusable element inside the modal.
- Add a `keydown` listener inside the modal that intercepts Tab: if Tab is pressed while the last focusable element has focus, move focus to the first focusable element (and vice versa for Shift+Tab). Focusable elements: `btn-close-modal`, `btn-cancel-res` (when visible).
- When `closeModal()` is called, restore focus to the element that triggered the modal open (save a reference in `openModal`).
- Verify Escape to close still works (already present).
- Add `role="dialog"`, `aria-modal="true"`, and `aria-labelledby="modal-title-id"` to `.modal-box`. Add `id="modal-title-id"` to `.modal-title`.

**Acceptance Criteria:**
- [ ] Opening a modal via keyboard (Enter on a chip) moves focus to the first focusable button inside the modal.
- [ ] Pressing Tab cycles focus only within the modal (does not escape to page content).
- [ ] Pressing Escape closes the modal and returns focus to the element that opened it.
- [ ] `.modal-box` has `role="dialog"` and `aria-modal="true"`.
- [ ] Screen reader can announce the modal title via `aria-labelledby`.

---

### TASK-020 · Add admin action buttons to mobile view and style Cancel as destructive

| Field | Value |
|---|---|
| **Owner** | frontend-developer |
| **Effort** | S |
| **Priority** | P1 |
| **Blocked by** | TASK-014, TASK-015 |

**Context.**
FR-037. The "Schedule Month" and "Book Now" buttons are in the `month-nav` div which is visible in both the grid and mobile list views (the `month-nav` div is rendered outside the `.calendar` div). Verify they are visible on mobile and properly sized. The Cancel buttons in the table are accessible via the modal on mobile (the table itself scrolls per TASK-017). Confirm Cancel button styling is clearly destructive (red, labelled).

**Changes required:**
- Verify `.month-nav` is not inside `.calendar` grid (it is currently outside — confirm no change needed).
- Ensure the "Schedule Month" / "Book Now" buttons use `var(--accent-action)` background (dark green per new palette).
- Add `aria-label="Cancel reservation for [date]"` to each `.btn-cancel-row` button. The `[date]` can be populated server-side.
- Confirm `.btn-cancel-res` in the modal has red background `var(--accent-failed)` and text "Cancel Reservation" (already present — verify unchanged).
- On mobile, the Cancel column of the table may be hard to reach. Add a "Cancel" button to the mobile booking card (in the mobile list view from TASK-014) that calls `openModal(chip.dataset)` for the booking.

**Acceptance Criteria:**
- [ ] "Schedule Month" and "Book Now" buttons are visible and tappable (44px height) on 375px viewport.
- [ ] Buttons use the dark green `#1B3A2D` colour (no orange).
- [ ] Cancel buttons in both table and mobile card are red and labelled "Cancel".
- [ ] Each Cancel button in the table has a descriptive `aria-label` including the booking date.
- [ ] Tapping a Cancel button on mobile opens the modal correctly.

---

### TASK-021 · Add auto-refresh (60-second polling) to web page

| Field | Value |
|---|---|
| **Owner** | frontend-developer |
| **Effort** | S |
| **Priority** | P2 |
| **Blocked by** | TASK-014, TASK-018 |

**Context.**
FR-038. Group members viewing the calendar on their phones should see updated booking status without manually reloading. A 60-second `setInterval` polls `GET /api/bookings` and updates only the booking chip areas (not a full page reload) to avoid disrupting any open modal.

**Changes required:**
- In the client-side `<script>` block, add a function `refreshChips()` that:
  - Fetches `GET /api/bookings`.
  - For each returned booking, finds the existing chip with matching `data-id` and updates its class and text content if the status or time has changed.
  - Adds new chips for any bookings not yet in the DOM (edge case: newly created slots).
  - Updates the header stats line (Confirmed / Pending / Failed counts).
  - Updates the "Last synced" text if the API response includes a `lastSyncAt` field.
- Add `GET /api/bookings` to include `lastSyncAt` in its response: `res.json({ bookings, lastSyncAt: db.getLastSyncAt() })` — update the existing endpoint in `web.js`.
- Call `setInterval(refreshChips, 60000)` after page load.
- Do NOT refresh if a modal is currently open (`activeId !== null`) — prevent disruptive re-renders.

**Acceptance Criteria:**
- [ ] Without manual reload, booking chips update within 60 seconds of a DB status change.
- [ ] The header stats (Confirmed / Pending counts) update automatically.
- [ ] When a modal is open, the auto-refresh is paused (no chip update while modal is visible).
- [ ] `GET /api/bookings` returns `{ bookings: [...], lastSyncAt: "..." }` (or `null` if never synced).
- [ ] No full page reload occurs during auto-refresh (no `location.reload()` call in `refreshChips`).

---

### TASK-022 · End-to-end manual verification and cleanup of root-level utility scripts

| Field | Value |
|---|---|
| **Owner** | backend-architect |
| **Effort** | S |
| **Priority** | P1 |
| **Blocked by** | TASK-008, TASK-011, TASK-020, TASK-021 |

**Context.**
All five feature areas are implemented. This task covers the final integration check, documentation updates, and removal of any remaining root-level scripts that have been superseded.

**Changes required:**
- Run `npm run sync` and verify `golf-scheduler.log` contains correct `[SYNC]` entries.
- Run `npm run status` and verify `actual_time` values are correctly populated for confirmed bookings.
- Run `npm run web` and verify: (a) chips show `actual_time`, (b) modal shows "Confirmed Time" / "Target Time" labels, (c) header shows "Last synced" timestamp, (d) mobile view at 375px works correctly.
- Start `npm run scheduler` and verify the first-run-immediately logic and 06:00 scheduling log.
- Confirm `find-saturdays.js`, `update-saturdays.js`, and `sync-reservations.js` are absent from the project root (should have been removed in TASK-008).
- Update `CLAUDE.md` to reflect: new `npm run sync` command wired to `src/sync.js`; `npm run scheduler` now runs daily at 06:00; `HEADLESS` and `SCHEDULER_HOUR` env vars.

**Acceptance Criteria:**
- [ ] `npm run sync` completes without error and updates at least one booking record (or logs "nothing to update" if all data is current).
- [ ] The web UI at `http://localhost:3002` renders correctly on Chrome desktop and Chrome mobile DevTools (375px iPhone SE preset).
- [ ] The modal correctly labels "Confirmed Time" and "Target Time" for a booking that has `actual_time` set.
- [ ] `CLAUDE.md` contains accurate descriptions of `src/sync.js`, the new scheduler behaviour, and the new env vars.
- [ ] No root-level utility scripts remain that duplicate functionality now provided by `src/sync.js`.

---

## Dependency Graph (summary)

```
TASK-001 ──────────────────────────────────────────────────────→ TASK-013
TASK-002 ──────────────────────────────────────────────────────→ TASK-006
TASK-003 ──────────────────────────────────────────────────────→ TASK-007, TASK-018
TASK-004 ──────────────────────────────────────────────────────→ TASK-005

TASK-005 ──────────────────────────────────────────────────────→ TASK-007
TASK-006 ──────────────────────────────────────────────────────→ TASK-007

TASK-007 ──────────────────────────────────────────────────────→ TASK-008, TASK-009
TASK-008 ──────────────────────────────────────────────────────→ TASK-009, TASK-022

TASK-009 ──────────────────────────────────────────────────────→ TASK-010, TASK-012
TASK-010 ──────────────────────────────────────────────────────→ TASK-011
TASK-011 ──────────────────────────────────────────────────────→ TASK-022

TASK-013 ──────────────────────────────────────────────────────→ TASK-014, TASK-016, TASK-017, TASK-018
TASK-014 ──────────────────────────────────────────────────────→ TASK-015, TASK-020, TASK-021
TASK-015 ──────────────────────────────────────────────────────→ TASK-019, TASK-020
TASK-018 ──────────────────────────────────────────────────────→ TASK-021

TASK-019 → TASK-022 (via TASK-020 → TASK-022)
TASK-020 → TASK-022
TASK-021 → TASK-022
```

## Critical Path

The longest dependency chain (critical path) runs through the sync engine and mobile UI streams:

```
TASK-002 → TASK-006 → TASK-007 → TASK-008 → TASK-009 → TASK-010 → TASK-011
TASK-001 → TASK-013 → TASK-014 → TASK-015 → TASK-020 → TASK-022
```

Both chains converge at TASK-022. Total depth: **8 tasks**.
