# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run book          # Run booking engine once (default command)
npm run dry-run       # Show what would be booked without booking
npm run status        # Print table of all upcoming bookings
npm run init          # Populate DB with computed slots (no booking)
npm run sync          # Sync DB with FWB site reservation history (src/sync.js)
npm run scheduler     # Run daily at 06:00: sync then book (setTimeout-based, not interval)
npm run web           # Start calendar web view at http://localhost:3002
npm run cancel -- <date>  # Cancel all reservations for a date (YYYY-MM-DD, MM/DD, MM-DD)
```

No build step, no tests, no linter. Raw Node.js execution.

## Architecture

**Orchestration flow:** `index.js` (Commander CLI) → `BookingEngine` (booking.js) → `SiteAutomation` (site.js) + `db.js` + `scheduler.js`

**Sync flow:** `index.js sync` → `runSync()` (sync.js) → `SiteAutomation.scrapeReservationHistory()` + `fetchReservationById()` → `reconcileDate()` (reconcile.js) → `db.updateBookingSync()`

### Core modules

- **booking.js** — `BookingEngine` class. Constructor: `new BookingEngine({ dryRun = false, site = null })`. When `site` is provided (shared-site/legacy mode for sync), the engine reuses that session for all groups. When `site` is null (default), the engine groups pending bookings by `golfer_index` and creates a separate `SiteAutomation({ email, password })` session per golfer account — each session does `init()` / `login()` / process dates / `close()`. Orchestrates a full booking run: computes slots, ensures DB entries, groups pending bookings by date/time, then iterates each group through site automation. Pre-checks existing reservations to skip already-booked slots. Uses 10-attempt course/time fallback (preferred→other, each with 5 time offsets). Verifies each booking on Reservations page after checkout. Handles BLOCKED error short-circuiting.
- **site.js** — `SiteAutomation` class. Constructor accepts `{ email, password }` — defaults to `config.email`/`config.password` if not provided, allowing per-golfer sessions. Playwright (Chromium) browser automation against the TeeItUp/Kenna Golf platform. Handles login (GolfID OAuth iframe), course/date selection (`selectCourse(courseName)` accepts 'Pines' or 'Oaks'), tee time discovery via "Book Now" buttons, **strict 4-golfer selection** (returns error and skips the tee time if fewer than 4 spots are available — no fallback to smaller groups), add-to-cart, checkout, cart cleanup, reservation checking (`getExistingReservations(date)`), and post-checkout verification (`verifyBookingOnSite(date, time)`). Uses JavaScript `el.click()` (not Playwright `.click()`) to bypass MUI backdrop overlays. Dismisses modals/popovers before interactions. Also provides `scrapeReservationHistory()` and `fetchReservationById(id)` for the sync engine. Headless mode controlled by `HEADLESS` env var.
- **scheduler.js** — Pure computation. `computeBookingSlots()` generates all needed tee time slots for the next N days based on the recurring schedule in config. When a schedule entry has `course: "alternating"`, it calls `resolveAlternatingCourse(dateStr)` to assign a concrete `'Pines'` or `'Oaks'` value per-date before inserting into the DB. Assigns `golferIndex` per unique booking date using a round-robin counter (`dateCounter % numGolfers`) so all slots on the same date share one golfer account. `groupByDateAndTime()` groups pending DB rows for batch processing. Each consecutive slot is offset by 10 minutes (e.g., 12:00, 12:10, 12:20).
- **db.js** — sql.js (pure-JS SQLite, no native build). Async API. Auto-persists to `./data/bookings.db` after mutations. Single `bookings` table with `UNIQUE(date, target_time, slot_index)` to prevent double-booking; includes `golfer_index INTEGER NOT NULL DEFAULT 0` column (added via `ALTER TABLE` with try/catch for backward compat). Key methods: `ensureBookings`, `getPendingBookings`, `markSuccess`, `markFailed`, `markCancelled`, `getBookingById`, `getAllUpcoming`, `updateBookingSync`, `getLastSyncAt`, `setLastSyncAt`.
- **sync.js** — `runSync(siteInstance?)` orchestrator. Accepts an optional already-authenticated `SiteAutomation` instance for session sharing; creates its own session when called standalone. Step 1: scrapes visible reservation history. Step 2: probes by ID for dates still carrying placeholder confirmation numbers. Applies `reconcileDate()` per date. Writes `lastSyncAt` to `./data/sync-meta.json` via `db.setLastSyncAt()`. Returns `{ checked, updated, warnings, errors }`. All log lines prefixed `[SYNC]`.
- **reconcile.js** — `reconcileDate(date, siteSlots, dbSlots, logger)` exported function. Pairs site reservations to DB booking rows positionally (sorted by time / slot_index). Calls `db.updateBookingSync()` for each mismatched pair. Returns `{ updated, notFound, warnings }`. All log lines prefixed `[SYNC]`.
- **config.js** — Loads `.env`. Defines recurring schedule (Mon/Tue/Fri/Sat/Sun), site URLs, course IDs (Pines=9437, Oaks=9438), credentials, tuning params, `schedulerHour` (default 6), and other settings. Exports `resolveAlternatingCourse(dateStr)` which converts the sentinel `"alternating"` course value to `'Pines'` (even ISO week) or `'Oaks'` (odd ISO week) using ISO 8601 week number parity. Exports `golfers` array built from `GOLF_EMAIL`/`GOLF_PASSWORD`, `GOLF_EMAIL2`/`GOLF_PASSWORD2`, `GOLF_EMAIL3`/`GOLF_PASSWORD3` — filtered to only entries where both email and password are present.
- **web.js** — Express server on port 3002. `GET /` serves server-rendered HTML calendar (current + next month) showing only `status === 'confirmed'` bookings as green chips. Clicking a chip opens a detail modal showing date, day, confirmed time, target time, course, **players**, **booked-by golfer** (`Golfer N (email)`), status, and confirmation number (only real numeric IDs shown — placeholders like `access`/`EXISTING_RESERVATION` display as `—`). Embeds `GOLFERS` JSON array in the page script for client-side golfer label lookup. Inter + Manrope fonts, WCAG AA contrast, mobile-responsive layout (< 640px collapses to `.mobile-booking-list` card view), floating zoom widget (hidden on mobile), and "Last synced" timestamp in header. `GET /api/bookings` returns `{ bookings, lastSyncAt }` JSON. Client-side auto-refresh polls `GET /api/bookings` every 60s via `refreshChips()` (paused while a modal is open). `POST /api/book-month` spawns the booking engine as a detached background process. `POST /api/cancel/:id` cancels a booking (marks DB + optionally cancels on site). Calendar headings have "Schedule Month" (current month) and "Book Now" (next month) buttons. Admin controls (Schedule Month, Book Now, Cancel) are only rendered in HTML when the request comes from a local IP (`isLocalIP()`). `GET /admin` (localhost only, 403 for external IPs) renders a full access log dashboard with stats cards and a table of all visits (time, IP, country+flag, ISP, device, browser, OS, path, user-agent). Access log is persisted to `./data/access-log.json` (loaded on startup, saved after each new entry and after geo enrichment). HTTPS is controlled by `HTTPS_ENABLED=true` env var — when set, loads `data/certs/cert.pem` and `data/certs/key.pem` and creates an `https.Server`; otherwise plain HTTP.
- **notify.js** — Console/log-based alerts for booking outcomes (success, failure, partial, blocked).

### Booking schedule (defined in schedule.json, loaded by config.js)

| Day       | Window       | Players | Slots | Preferred Course |
|-----------|-------------|---------|-------|-----------------|
| Monday    | 12:00-13:00 | 12      | 3     | Pines            |
| Tuesday   | 12:00-13:00 | 8       | 2     | Pines            |
| Friday    | 12:00-13:00 | 12      | 3     | Pines            |
| Saturday  | 08:00-13:00 | 12      | 3     | Pines            |
| Sunday    | 08:00-10:00 | 12      | 3     | alternating      |

Each slot = 4 players. Consecutive tee times spaced ~10 min apart. Falls back to other course and ±1hr/±2hr windows if preferred is unavailable.

**Alternating Sunday course**: the `"alternating"` sentinel in `schedule.json` is resolved at slot-computation time using ISO 8601 week number parity — even week → Pines, odd week → Oaks. Week 10=Pines, 11=Oaks, 12=Pines, etc.

### Key site automation details (site.js)

- **Target platform**: `https://fort-walton-member.book.teeitup.golf` (Next.js React SPA with MUI)
- **Login**: Clicks "Login" button → finds GolfID iframe → fills email/password → submits → dismisses email verification prompt via `[aria-label="Close"]` → dismisses MUI backdrop
- **Tee time discovery**: Finds all `button:has-text("Book Now")`, walks up parent DOM (max 3 levels, text < 300 chars) to extract time via regex
- **MUI overlay workaround**: `_dismissModals()` clicks backdrops, presses Escape; all clicks use `el.evaluate(el => el.click())` to bypass `MuiBackdrop-root` pointer interception
- **Consecutive slot matching**: `findConsecutiveSlots()` searches ±fallbackMinutes (default 30) for N slots with 5-15 min gaps
- **Course selection**: `selectCourse(courseName)` takes 'Pines' or 'Oaks' — dynamically selects the requested course via dropdown or filter buttons
- **Pre-booking reservation check**: `getExistingReservations(date)` navigates to `/reservation/history`, paginates through NEXT buttons (up to 20 pages), clicks VIEW DETAILS one card at a time (SPA navigation — URL may not change), extracts via full-body text scan (handles detail page layout), then goes back to list. Confirmation number regex matches both `Reservation #NUMBER` and `Confirmation #Name|NUMBER` formats. Site limitation: only shows reservations within ~7 days in the Upcoming section.
- **Reservation history scraping**: `scrapeReservationHistory()` returns all visible upcoming reservations as `Array<{ date, time, course, confirmationNumber }>`. `fetchReservationById(id)` navigates directly to a reservation by numeric ID. Both methods require an active session (call after `init()` + `login()`).
- **10-attempt course/time fallback** (in booking.js `_processGroup`): tries offsets `[0, -1hr, +1hr, -2hr, +2hr]` on preferred course first, then all 5 on the other course (10 total). Each attempt tries consecutive slots first, then individual. Once any slot is booked, the engine locks to that course for the remaining slots.
- **Booking flow**: Book Now → select 4 golfers → ADD TO CART → complete checkout → verify on Reservations page
- **Post-checkout verification**: `verifyBookingOnSite(date, time)` checks the Reservations page after each checkout. If the booking is not found, it's marked failed instead of confirmed.
- **Cart cleanup**: `clearCart()` removes stale cart items after login to avoid "cart limit" errors
- Use `waitUntil: 'domcontentloaded'` (not `networkidle`) — the SPA keeps long-polling connections

### Daily scheduler (`npm run scheduler`)

The `scheduler` command uses a pure `setTimeout` loop (not `setInterval`) that always fires at `SCHEDULER_HOUR:00` local time (default 06:00). On each fire:

1. A dedicated `SiteAutomation` session is created, logged in as the primary golfer, and used for sync.
2. `runSync(site)` is called first (syncs DB with site reservation history); session closed in `finally`.
3. `new BookingEngine()` (no shared site) is called next — it creates per-golfer sessions internally.
4. The next 06:00 fire is scheduled with `setTimeout`.

**FR-023 run-immediately logic**: if the process starts after today's `SCHEDULER_HOUR`, it runs immediately rather than waiting until tomorrow. Start logs use `[SCHEDULER]` prefix. A sync failure is caught and logged; the booking engine still runs.

### Database

SQLite via sql.js. Schema in `db.js`. Status values: `pending`, `confirmed`, `failed`, `partial`, `skipped`, `cancelled`. Max 3 retry attempts per slot.

`lastSyncAt` is stored in `./data/sync-meta.json` (plain JSON). `db.getLastSyncAt()` / `db.setLastSyncAt(isoString)` are synchronous helpers that read/write that file.

### Data persistence

- Database: `./data/bookings.db`
- Sync metadata: `./data/sync-meta.json` — `{ "lastSyncAt": "<ISO string>" }`
- Access log: `./data/access-log.json` — persisted array of external visitor entries (max 500)
- TLS certs: `./data/certs/cert.pem`, `./data/certs/key.pem`, `./data/certs/account-key.pem`
- Screenshots: `./screenshots/` (PNG captures at each booking step)
- Logs: `./golf-scheduler.log` (Winston, 5MB rotation, 3 files)

### Utility scripts

- **cancel-rebook.js** — One-time script (project root). Logs in as golfer 0, scrapes all site reservations from a given `FROM_DATE` onward, cancels them, then runs `BookingEngine()` to re-book using the alternating golfer rotation.
- **fix-confirmations.js** — One-off script that visits the site's Reservations page for each confirmed booking with a placeholder confirmation number (EXISTING_RESERVATION, "access", CONFIRMED) and updates the DB with the real number. Limited by the ~7-day site window for upcoming reservations.
- **get-cert.js** — Obtains a trusted Let's Encrypt certificate via DuckDNS DNS-01 challenge. Requires `DUCKDNS_TOKEN` and `DUCKDNS_DOMAIN` in `.env`. Saves cert to `data/certs/cert.pem` and `data/certs/key.pem`. Re-run every ~60 days to renew before 90-day expiry. Account key cached at `data/certs/account-key.pem`.

Note: `sync-reservations.js`, `update-saturdays.js`, and `find-saturdays.js` have been removed from the project root. Their functionality is now provided by `npm run sync` (`src/sync.js`).

## Environment variables (.env)

```
GOLF_EMAIL, GOLF_PASSWORD       # Required - primary GolfID credentials
GOLF_EMAIL2, GOLF_PASSWORD2     # Optional - second golfer account (rotation)
GOLF_EMAIL3, GOLF_PASSWORD3     # Optional - third golfer account (rotation)
TIMEZONE                        # Default: America/Chicago
BOOKING_HORIZON_DAYS           # Default: 30
FALLBACK_MINUTES               # Default: 30 (max deviation from target time)
DB_PATH                        # Default: ./data/bookings.db
SCREENSHOT_DIR                 # Default: ./screenshots
LOG_LEVEL                      # Default: info
HEADLESS                       # Default: false. Set to true for daemon/scheduler (no browser window)
SCHEDULER_HOUR                 # Default: 6. Hour (0-23) for the daily scheduler fire time
HTTPS_ENABLED                  # Default: false. Set to true to serve HTTPS using data/certs/ files
DUCKDNS_TOKEN                  # DuckDNS API token — used by get-cert.js for Let's Encrypt DNS challenge
DUCKDNS_DOMAIN                 # DuckDNS subdomain (without .duckdns.org) — used by get-cert.js
```

## Platform notes

- Runs on Windows (primary). Use Unix shell syntax in Git Bash.
- sql.js chosen over better-sqlite3 to avoid native build issues on Windows/Node 24.
- Playwright requires `npx playwright install chromium` after `npm install`.
- Interactive commands (`book`, `sync`, `cancel`) default to visible browser (`headless: false`).
- The `scheduler` daemon should be run with `HEADLESS=true` in `.env` to avoid a Chromium window popping up during automated runs.
