# GolfScheduler — Product Requirements Document (PRD)

**Version:** 1.0

This PRD captures the authoritative requirements for the GolfScheduler system. It uses `booking.md` as the primary requirements source, cross-referenced against the implemented codebase. Where the implementation diverges from the original spec, this document reflects the implemented behavior and calls out the delta explicitly.

---

## Section 1: Purpose

This document serves as the single source of truth for the GolfScheduler system. Requirements are drawn from `booking.md` (primary), `Prompt.md` (secondary), and the implemented codebase. Deviations between spec and implementation are explicitly noted in Section 19.

---

## Section 2: System Overview

- **Purpose:** Automated tee-time booking bot for Fort Walton Beach Golf (TeeItUp/Kenna Golf platform)
- **Target site:** `https://fort-walton-member.book.teeitup.golf`
- **Platform:** Windows primary, Git Bash, raw Node.js (no build step, no tests, no linter)
- **Tech stack:** Node.js, Playwright Chromium, sql.js SQLite, Commander.js, Express (port 3009), Winston
- **High-level modes:**
  - On-demand booking: `npm run book`
  - Daily scheduled daemon: `npm run scheduler`
  - Web calendar: `npm run web`
  - Sync reconciliation: `npm run sync`

---

## Section 3: Critical Booking Rules

### 3.1 Mandatory 4-Golfer Rule

Every tee time slot **MUST** be booked for exactly 4 players. The relationship is:

- 1 slot = 4 players
- 2 slots = 8 players
- 3 slots = 12 players

Never book fewer than 4 players unless configuration is explicitly changed.

**Current implementation:** `site.js` `bookSlot()` has `preferenceOrder = [4]`. If the 4-player option is not available or is disabled (`Mui-disabled` or opacity < 0.4), the tee time is **skipped entirely** — `selectedCount < 4` triggers an early return with a warning. The engine never books fewer than 4 players.

### 3.2 Multi-Batch Booking Constraint

The site allows at most **3 tee time slots per booking transaction**.

- If `slots <= 3`: complete in a single batch.
- If `slots > 3`: split into batches of at most 3 slots each.

**Example:** 4 slots = batch 1 (3 slots) + batch 2 (1 slot).

**Implementation status: PARTIAL GAP** — The current `_bookSlots()` in `booking.js` iterates slots sequentially with individual cart/checkout cycles per slot, which effectively avoids the site's 3-slot limit in practice. However, explicit batch-splitting logic enforcing a ceiling of 3 slots per checkout transaction is not coded. The current schedule maximum (3 slots/day) means this gap has never been triggered in production.

---

## Section 4: Booking Schedule

Full schedule as defined in `schedule.json`:

| Day | Window Start | Window End | Players | Slots | Course |
|-----|-------------|-----------|---------|-------|--------|
| Monday | 12:00 | 13:00 | 12 | 3 | Pines |
| Tuesday | 12:00 | 13:00 | 8 | 2 | Pines |
| Friday | 12:00 | 13:00 | 12 | 3 | Pines |
| Saturday | 08:00 | 13:00 | 12 | 3 | Pines |
| Sunday | 08:00 | 10:00 | 12 | 3 | alternating |

**Additional facts:**

- `"alternating"` resolves via ISO 8601 week number parity: even week = Pines, odd week = Oaks (via `config.js` `resolveAlternatingCourse()`)
  - Examples: Week 10 = Pines, Week 11 = Oaks, Week 12 = Pines
- Consecutive slots are spaced **10 minutes apart** from window start (e.g., Monday: 12:00, 12:10, 12:20)
- `players` = total players for the day; each slot always books exactly 4
- Booking horizon: **30 days** ahead (configurable via `BOOKING_HORIZON_DAYS`)

---

## Section 5: Multi-Golfer Rotation

This is an **implemented extension** — not present in `booking.md`.

- Up to 3 golfer accounts, configured via:
  - `GOLF_EMAIL` / `GOLF_PASSWORD` (primary)
  - `GOLF_EMAIL2` / `GOLF_PASSWORD2` (second)
  - `GOLF_EMAIL3` / `GOLF_PASSWORD3` (third)
- `config.js` exports a `golfers` array — only entries where **both** email AND password are present are included
- `scheduler.js` assigns `golferIndex` **round-robin by unique booking date** — all slots on the same date share one golfer account
- `booking.js` groups pending bookings by `golfer_index`, then creates a **separate `SiteAutomation({ email, password })` session** per golfer
- Each per-golfer session lifecycle: `init()` → `navigateToBooking()` → `login()` → `clearCart()` → process dates → `close()`
- DB column: `golfer_index INTEGER NOT NULL DEFAULT 0` (added via `ALTER TABLE` with `try/catch` for backward compatibility)
- Web UI detail modal displays: `"Booked by: Golfer N (email)"`

---

## Section 6: Architecture and Module Map

### 6.1 Orchestration Flow

```
index.js (Commander CLI)
  └─> BookingEngine (booking.js)
        ├─> SiteAutomation (site.js)
        ├─> db.js
        └─> scheduler.js
```

### 6.2 Sync Flow

```
index.js sync
  └─> runSync() (sync.js)
        ├─> SiteAutomation.scrapeReservationHistory()
        ├─> SiteAutomation.fetchReservationById()
        └─> reconcileDate() (reconcile.js)
              └─> db.updateBookingSync()
```

### 6.3 Module Descriptions

| Module | Description |
|--------|-------------|
| `src/index.js` | Commander CLI entry point; wires all commands |
| `src/booking.js` | `BookingEngine` class; `run()`, `_processGroup()`, `_tryCourse()`, `_bookSlots()`, `_filterAlreadyBooked()` |
| `src/site.js` | `SiteAutomation` class; all Playwright browser automation |
| `src/scheduler.js` | `computeBookingSlots()`, `groupByDateAndTime()`; pure computation, no I/O |
| `src/db.js` | sql.js SQLite wrapper; all DB methods |
| `src/config.js` | dotenv loader; exports config object and `resolveAlternatingCourse()` |
| `src/web.js` | Express server on port 3009; calendar, admin, API endpoints |
| `src/sync.js` | `runSync()`; reservation history reconciliation orchestrator |
| `src/reconcile.js` | `reconcileDate()`; pure positional pairing logic for sync |
| `src/notify.js` | `alertSuccess`, `alertFailure`, `alertPartialBooking`, `alertBlocked` |
| `src/logger.js` | Winston logger with 5MB rotation, 3 files |

---

## Section 7: Database Schema

### 7.1 `bookings` Table

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | |
| `date` | TEXT | NOT NULL | YYYY-MM-DD |
| `day_label` | TEXT | NOT NULL | e.g. `"Monday 12 PM-1 PM"` |
| `target_time` | TEXT | NOT NULL | HH:MM scheduled |
| `actual_time` | TEXT | | HH:MM booked from site |
| `window_start` | TEXT | | HH:MM |
| `window_end` | TEXT | | HH:MM |
| `course` | TEXT | NOT NULL | `'Pines'` or `'Oaks'` |
| `slot_index` | INTEGER | NOT NULL | 0-based within the day |
| `players` | INTEGER | NOT NULL | Always 4 |
| `golfer_index` | INTEGER | NOT NULL DEFAULT 0 | Round-robin assignment |
| `confirmation_number` | TEXT | | Real numeric ID or placeholder |
| `screenshot_path` | TEXT | | PNG path |
| `status` | TEXT | NOT NULL DEFAULT `'pending'` | See status values below |
| `attempts` | INTEGER | NOT NULL DEFAULT 0 | Max 3 |
| `last_attempt_at` | TEXT | | ISO datetime |
| `error_message` | TEXT | | |
| `created_at` | TEXT | NOT NULL DEFAULT `datetime('now')` | |
| `updated_at` | TEXT | NOT NULL DEFAULT `datetime('now')` | |
| UNIQUE | — | `(date, target_time, slot_index)` | Prevents double-insert |

**Status values:** `pending`, `confirmed`, `failed`, `partial`, `skipped`, `cancelled`

**Indexes:**
- `idx_bookings_date` on `(date)`
- `idx_bookings_status` on `(status)`

### 7.2 Placeholder Confirmation Sentinels

These are not real site IDs — they are internal markers:

| Sentinel | Meaning |
|----------|---------|
| `EXISTING_RESERVATION` | Slot was pre-existing when engine ran |
| `CONFIRMED` | Checkout page found but no numeric ID extracted |
| `access` | Legacy placeholder |

### 7.3 Auxiliary Storage

- `./data/sync-meta.json` — `{ "lastSyncAt": "<ISO string>" }`
- `./data/access-log.json` — array of external visitor entries (max 500)

---

## Section 8: CLI Commands

| Command | npm script | Description |
|---------|-----------|-------------|
| `book` (default) | `npm run book` | Run booking engine once |
| `book --dry-run` | `npm run dry-run` | Show what would be booked, no site calls |
| `status` | `npm run status` | Print table of all upcoming bookings |
| `init` | `npm run init` | Populate DB with computed slots (no booking) |
| `scheduler` | `npm run scheduler` | Run daily at `SCHEDULER_HOUR`: sync then book |
| `web` | `npm run web` | Start calendar at http://localhost:3009 |
| `cancel <date>` | `npm run cancel -- <date>` | Cancel all reservations for a date |
| `sync` | `npm run sync` | Sync DB with site reservation history |

**Date formats accepted by `cancel`:** `YYYY-MM-DD`, `MM/DD`, `MM-DD`

---

## Section 9: Booking Engine Logic

### 9.1 Run Flow

1. `computeBookingSlots()` — generate all needed slots for the booking horizon
2. `ensureBookings()` — `INSERT OR IGNORE` to DB
3. `getPendingBookings()` — fetch `pending`/`failed` rows under max retries
4. `groupByDateAndTime()` — group by date + `day_label`
5. Group by `golfer_index`, create per-golfer sessions
6. For each golfer: `init()` session → for each date group: `_processGroup()`

### 9.2 10-Attempt Fallback Order

| Attempt | Course | Time Offset |
|---------|--------|-------------|
| 1 | Preferred | 0 |
| 2 | Preferred | -1 hr |
| 3 | Preferred | +1 hr |
| 4 | Preferred | -2 hr |
| 5 | Preferred | +2 hr |
| 6 | Other | 0 |
| 7 | Other | -1 hr |
| 8 | Other | +1 hr |
| 9 | Other | -2 hr |
| 10 | Other | +2 hr |

**Rules:**
- Once any slot is booked, `lockedCourse` is set; subsequent attempts skip the other course
- Each attempt tries consecutive slots first (`findConsecutiveSlots`), then individual slots (`findSlotsInWindow`)
- A `BLOCKED` error immediately stops the entire run and calls `alertBlocked()`

### 9.3 Pre-Booking Reservation Check

Before booking any group: `getExistingReservations(date)` is called. Existing site reservations within window ±2 hr are marked `confirmed` in the DB with confirmation number `EXISTING_RESERVATION`. Matched slots are removed from the to-book list.

### 9.4 Post-Checkout Behavior (Deviation from booking.md)

`booking.md` requires `verifyBookingOnSite(date, time)` after each checkout; if not found on the Reservations page, the slot should be marked `failed`.

**Current implementation** trusts the checkout confirmation page: if a real numeric reservation number is extracted, the slot is immediately marked `confirmed`. `verifyBookingOnSite()` exists in `site.js` but is **not currently called** in `_bookSlots()`.

**Rationale:** The site's Reservations page may have a caching delay after checkout, causing false negatives.

---

## Section 10: Site Automation Details

### 10.1 Platform

`https://fort-walton-member.book.teeitup.golf` — Next.js React SPA with MUI components.

### 10.2 Critical Click Rule

All clicks **MUST** use:

```js
element.evaluate(el => el.click())
```

**Never** use Playwright `.click()`. Reason: `MuiBackdrop-root` intercepts pointer events and causes clicks to land on the wrong element.

### 10.3 Navigation Rule

All `page.goto()` calls **MUST** use `waitUntil: 'domcontentloaded'`. Never use `'networkidle'` — the SPA keeps long-polling connections open indefinitely.

### 10.4 Login Sequence

1. Click "Login" button
2. Find GolfID OAuth iframe
3. Fill email and password
4. Submit form
5. Dismiss email verification prompt via `[aria-label="Close"]`
6. Dismiss MUI backdrop
7. Call `clearCart()`

### 10.5 clearCart()

Called after every login. Navigates to the cart page and removes all existing items. Prevents "cart limit" errors that would block subsequent `ADD TO CART` actions.

### 10.6 Golfer Count Selection

`bookSlot()` finds the "Select Number of Golfers" radio group and tries **only `[4]`**. If 4 is not available or is disabled (has `Mui-disabled` class or opacity < 0.4), the tee time is **skipped entirely** with a warning. The engine never books fewer than 4 players.

### 10.7 Tee Time Discovery

Finds all `button:has-text("Book Now")`, walks up the DOM a maximum of 3 levels, and extracts the time via regex from the parent element's text content (capped at 300 characters to avoid noise).

### 10.8 Consecutive Slot Matching

`findConsecutiveSlots()` searches ±`fallbackMinutes` (default 30) from the target time for `count` consecutive slots with gaps of 5–15 minutes between them.

### 10.9 Reservation History Scraping

`getExistingReservations(date)`:
1. Navigates to `/reservation/history`
2. Paginates via NEXT button up to 20 pages
3. Clicks VIEW DETAILS one card at a time (SPA navigation — URL may not change)
4. Extracts data via full body text scan

**Confirmation number regex patterns:**
- `Reservation #NUMBER`
- `Confirmation #Name|NUMBER`

**Site limitation:** Only shows reservations within approximately 7 days in the Upcoming section.

### 10.10 Screenshots

Captured at each major booking step to `./screenshots/` with timestamp and step name in the filename (PNG format).

### 10.11 Course Selection

`selectCourse('Pines')` or `selectCourse('Oaks')` — dynamically selects the requested course via dropdown or filter buttons on the booking page.

### 10.12 cancelReservations(bookings)

Used by the `cancel` CLI command and `POST /api/cancel/:id`.

- Only cancels bookings with **real numeric** confirmation numbers (regex `^\d+$`)
- Navigates to `/reservation/history/{resNum}/cancel`
- Selects players and reason dropdowns, then submits

---

## Section 11: Sync Engine

This is an **implemented extension** — not present in `booking.md`.

### 11.1 Purpose

Reconcile the local DB with site reservation history to recover real confirmation numbers, correct actual times, and flag missing or unexpected bookings.

### 11.2 Two-Phase Algorithm

**Phase 1:** `scrapeReservationHistory()` — scrape all visible upcoming reservations from the site. Group results by date.

**Phase 2:** For DB rows that still carry placeholder confirmation numbers and are not covered by Phase 1, probe by ID via `fetchReservationById()` (±10 IDs around each known numeric ID).

**Reconciliation:** `reconcileDate()` positionally pairs DB slots (sorted by `slot_index`) to site slots (sorted by time). Updates `actual_time`, `course`, and `confirmation_number` in the DB where mismatched.

### 11.3 Session Management

`runSync(siteInstance?)` — reuses a provided, already-authenticated `SiteAutomation` session, or creates its own (closed in `finally`).

### 11.4 Persistence

Writes `lastSyncAt` to `./data/sync-meta.json` after each sync run completes.

### 11.5 Return Value

```js
{ checked, updated, warnings, errors }
```

### 11.6 FR-012: Missing Confirmed Booking Warning

If a confirmed DB booking with a real numeric confirmation number was visible in Phase 1 history but is no longer found on the site, a `WARN` log line is emitted for manual review. The DB row is not automatically cancelled.

---

## Section 12: Daily Scheduler

- Forces `HEADLESS=true` for the browser
- Uses a pure `setTimeout` loop (not `setInterval` or cron)
- Fires daily at `SCHEDULER_HOUR:00` local time (default `06:00`)
- **FR-023:** If the process starts after today's fire hour, it runs immediately rather than waiting until tomorrow

**Each daily cycle:**

1. **Sync phase:** Create primary-golfer `SiteAutomation` instance, call `init()` + `login()`, call `runSync(site)`, close session in `finally`
2. **Book phase:** `new BookingEngine()` (no shared site instance), call `engine.run()` — manages per-golfer sessions internally
3. **Schedule next fire:** `setTimeout` for next `SCHEDULER_HOUR:00`

A sync failure is caught and logged; the booking engine still runs regardless.

All log lines from this module use the `[SCHEDULER]` prefix.

---

## Section 13: Web UI

Express server on **port 3009**.

### 13.1 Routes

| Route | Access | Description |
|-------|--------|-------------|
| `GET /` | Public | Server-rendered HTML calendar (current + next month) |
| `GET /api/bookings` | Public | Returns `{ bookings, lastSyncAt }` JSON |
| `POST /api/book-month` | Public | Spawns detached booking process, returns immediately |
| `POST /api/book-day` | Local IP only | Insert custom day booking slots and spawn engine |
| `POST /api/cancel/:id` | Public | Cancel booking by ID (DB + optional site cancellation) |
| `GET /admin` | Local IP only (403 for external IPs) | Access log dashboard |
| `GET /api/ping` | Public | Tracking endpoint |

### 13.2 Calendar View

- **Chip colors:**
  - Green = `confirmed`
  - Amber = `pending`
  - Red = `failed` / `partial`
  - Grey + strikethrough = `cancelled`
  - Hidden (`display:none`) = `skipped`
- **Detail modal fields:** date, day, confirmed time, target time, course, players (always 4), booked-by golfer (`Golfer N (email)`), status, confirmation number
  - Real numeric IDs are shown as-is
  - Placeholder sentinels (`EXISTING_RESERVATION`, `access`, `CONFIRMED`) display as `—`
- **Admin buttons** ("Schedule Month" for current month, "Book Now" for next month): rendered only for local IP requests
- **Auto-refresh:** Client polls `/api/bookings` every 60 seconds via `refreshChips()` (paused while a modal is open)
- **"Last synced" timestamp** displayed in the page header

### 13.3 Admin Dashboard (`/admin`, localhost only)

- Returns HTTP 403 for all external IPs
- **Stats cards:** total visits, unique IPs, mobile count, countries
- **Visit table columns:** time (CST), IP, location (country + flag), ISP, device, browser, OS, path, user agent
- **Geo enrichment:** async lookup via `ip-api.com` after response is sent
- **Access log:** `./data/access-log.json` (max 500 entries), auto-refreshes every 30 seconds

### 13.4 Design

- **Fonts:** Inter (body) + Manrope (headings) from Google Fonts CDN
- **Accessibility:** WCAG AA contrast on all text
- **Mobile responsive:** `< 640px` collapses to `.mobile-booking-list` card view
- **Floating zoom widget:** hidden on mobile viewports
- **Local IP detection covers:** `::1`, `127.0.0.1`, `192.168.*`, `10.*`, `172.*`

### 13.5 HTTPS

When `HTTPS_ENABLED=true`, the server loads `data/certs/cert.pem` and `data/certs/key.pem` and creates an `https.Server`. Default behavior is plain HTTP.

---

## Section 14: Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOLF_EMAIL` | Yes | — | Primary GolfID email |
| `GOLF_PASSWORD` | Yes | — | Primary GolfID password |
| `GOLF_EMAIL2` | No | — | Second golfer email |
| `GOLF_PASSWORD2` | No | — | Second golfer password |
| `GOLF_EMAIL3` | No | — | Third golfer email |
| `GOLF_PASSWORD3` | No | — | Third golfer password |
| `TIMEZONE` | No | `America/Chicago` | dayjs timezone identifier |
| `BOOKING_HORIZON_DAYS` | No | `30` | Days ahead to compute slots |
| `FALLBACK_MINUTES` | No | `30` | Max window deviation for slot search |
| `DB_PATH` | No | `./data/bookings.db` | SQLite file path |
| `SCREENSHOT_DIR` | No | `./screenshots` | Screenshot output directory |
| `LOG_LEVEL` | No | `info` | Winston log level |
| `HEADLESS` | No | `false` | Set `true` for daemon/scheduler runs |
| `SCHEDULER_HOUR` | No | `6` | Daily fire hour (0–23) |
| `HTTPS_ENABLED` | No | `false` | Enable HTTPS server |
| `DUCKDNS_TOKEN` | No | — | DuckDNS API token for Let's Encrypt DNS challenge |
| `DUCKDNS_DOMAIN` | No | — | DuckDNS subdomain (without `.duckdns.org`) |
| `PORT` | No | `3009` | Web server port |

---

## Section 15: Edge Cases and Error Handling

### From booking.md / Prompt.md (original 14)

1. **BLOCKED error:** Stop all booking attempts immediately, call `alertBlocked()`
2. **Cart limit:** `clearCart()` called after every login
3. **MUI backdrop:** All clicks via `el.evaluate(el => el.click())`
4. **SPA navigation:** `waitUntil: 'domcontentloaded'` on every `page.goto()`
5. **Reservation already exists:** Pre-check via `getExistingReservations()`, skip slot, mark `EXISTING_RESERVATION`
6. **Post-checkout verification:** *(Current implementation trusts checkout confirmation page — see Section 9.4)*
7. **Consecutive slots unavailable:** Fall back to individual slot booking
8. **Preferred course unavailable:** Switch to other course after 5 failed attempts
9. **Duplicate DB insert:** `UNIQUE(date, target_time, slot_index)` constraint with `INSERT OR IGNORE`
10. **Slot at max retries:** Filtered by `getPendingBookings()` (`attempts < maxRetries`)
11. **Email verification prompt:** Dismissed via `[aria-label="Close"]` after login
12. **Multi-page reservation history:** Paginate NEXT button up to 20 pages
13. **Cancel date format flexibility:** Accept `YYYY-MM-DD`, `MM/DD`, `MM-DD`
14. **`POST /api/book-month` non-blocking:** Spawn detached child process, return HTTP 200 immediately

### Additional Implemented Cases

15. **Course locking:** Once any slot on a date is successfully booked, `lockedCourse` is set to prevent cross-course splits within the same date group
16. **Incomplete golfer credentials:** Golfer entries missing either email or password are filtered from `config.golfers` and never used
17. **Negative time after offset:** If applying a negative time offset would result in a start time < 0, the attempt is skipped
18. **DB file updated externally:** `getAllUpcoming()` detects file `mtime` change and re-reads from disk
19. **FR-012 — Confirmed booking gone missing:** Confirmed booking visible in Phase 1 but absent on site → `WARN` log emitted for manual review
20. **Slot unavailable after first slot booked:** Logged, slot marked `failed`
21. **Scheduler FR-023 — Late start:** If process starts after today's `SCHEDULER_HOUR`, runs immediately instead of waiting until tomorrow
22. **4-golfer unavailable:** Tee time skipped entirely; engine never books fewer than 4 players

---

## Section 16: Data Persistence and File Layout

```
./data/bookings.db              SQLite database (sql.js)
./data/sync-meta.json           { "lastSyncAt": "<ISO string>" }
./data/access-log.json          External visitor log (max 500 entries)
./data/certs/cert.pem           TLS certificate (Let's Encrypt via get-cert.js)
./data/certs/key.pem            TLS private key
./data/certs/account-key.pem    ACME account key (cached)
./screenshots/                  PNG booking step captures
./golf-scheduler.log            Winston rotating log (5MB max, 3 files)
./schedule.json                 Recurring schedule definition
./.env                          Credentials and configuration values
```

---

## Section 17: Utility Scripts

| Script | Description |
|--------|-------------|
| `cancel-and-rebook.js` | One-time batch cancel: logs in as primary golfer, cancels all site-confirmed bookings from a `FROM_DATE` onward, purges DB rows, then runs `BookingEngine()` to re-book using the alternating golfer rotation |
| `fix-confirmations.js` | Visits the Reservations page for confirmed DB rows that carry placeholder confirmation numbers; updates the DB with real numeric confirmation numbers. Limited by the ~7-day site window for upcoming reservations |
| `get-cert.js` | Obtains a trusted Let's Encrypt certificate via DuckDNS DNS-01 challenge. Requires `DUCKDNS_TOKEN` and `DUCKDNS_DOMAIN` in `.env`. Saves cert to `data/certs/cert.pem` and private key to `data/certs/key.pem`. Account key cached at `data/certs/account-key.pem`. Re-run every ~60 days before the 90-day expiry |

---

## Section 18: Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `playwright` | ^1.49.1 | Chromium browser automation |
| `sql.js` | ^1.11.0 | Pure-JS SQLite (no native build required on Windows) |
| `express` | ^5.2.1 | Web server |
| `commander` | ^12.1.0 | CLI argument parsing |
| `dayjs` | ^1.11.13 | Date/time manipulation with timezone support |
| `dotenv` | ^16.4.7 | `.env` file loading |
| `winston` | ^3.17.0 | Structured logging with rotation |
| `acme-client` | ^5.4.0 | Let's Encrypt certificate management |

**Post-install required:**

```bash
npx playwright install chromium
```

---

## Section 19: Requirements vs. Implementation Delta Summary

| Requirement Source | Requirement | Status | Notes |
|-------------------|-------------|--------|-------|
| `booking.md` | Always 4 golfers per slot | IMPLEMENTED | `preferenceOrder = [4]`; tee time skipped entirely if 4-player option unavailable |
| `booking.md` | Multi-batch split at > 3 slots | PARTIAL GAP | Max is 3 slots/day currently; no explicit batch-split code exists; gap untriggered in production |
| `booking.md` / `Prompt.md` | `verifyBookingOnSite` after checkout | DEVIATED | Trusts confirmation page numeric ID; Reservations page not re-polled after checkout |
| `Prompt.md` | Scheduler every 6 hours | DEVIATED | Daily at configurable hour via `setTimeout`; not every 6 hours |
| `Prompt.md` | Notify function names (e.g. `notifySuccess`) | RENAMED | Implemented as `alertSuccess`, `alertFailure`, `alertPartialBooking`, `alertBlocked` |
| Neither doc | Multi-golfer rotation | EXTENSION | Up to 3 golfers, round-robin by date; per-golfer `SiteAutomation` sessions |
| Neither doc | Sync engine | EXTENSION | Two-phase scrape + ID probing; `reconcileDate()` positional pairing |
| Neither doc | Admin dashboard | EXTENSION | Access log with geo lookup, stats cards, visit table |
| Neither doc | HTTPS support | EXTENSION | Let's Encrypt / DuckDNS DNS-01 challenge via `get-cert.js` |
| Neither doc | `POST /api/book-day` | EXTENSION | Custom day booking from web UI (local IP only) |
| Neither doc | Alternating Sunday course | EXTENSION | ISO 8601 week parity: even = Pines, odd = Oaks |
| Neither doc | `golfer_index` DB column | EXTENSION | Backward-compatible via `ALTER TABLE` with `try/catch` |
