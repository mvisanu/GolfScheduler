# GolfScheduler — Implementation Task List

**Generated:** 2026-03-09
**Source documents:** `booking.md`, `prd.md`, `CLAUDE.md`
**Codebase state:** Substantially implemented. Tasks reflect what needs to be built,
verified, fixed, or gap-closed relative to the full PRD.

---

## Phase 1: Foundation — Config, DB, and Core Utilities

### TASK-001: Establish project structure and package dependencies
- **Owner:** backend-architect
- **Effort:** S
- **Blocked by:** none
- **Acceptance criteria:**
  - `package.json` declares all eight required dependencies: `playwright`, `sql.js`, `express`, `commander`, `dayjs`, `dotenv`, `winston`, `acme-client`
  - All npm scripts defined: `book`, `dry-run`, `status`, `init`, `scheduler`, `web`, `cancel`, `sync`, `generate`
  - `npx playwright install chromium` documented in README and setup instructions
  - `.env.example` file present with all fourteen env var keys and inline comments

### TASK-002: Implement `src/logger.js` — Winston structured logger
- **Owner:** backend-architect
- **Effort:** XS
- **Blocked by:** TASK-001
- **Acceptance criteria:**
  - Exports a configured Winston logger instance
  - Log level controlled by `LOG_LEVEL` env var (default `info`)
  - Console transport active; file transport writes to `./golf-scheduler.log`
  - File rotation: 5 MB max size, 3 files kept
  - Logger usable via `require('./logger')` from any src module

### TASK-003: Implement `src/config.js` — centralised configuration
- **Owner:** backend-architect
- **Effort:** S
- **Blocked by:** TASK-001
- **Acceptance criteria:**
  - Loads `.env` via `dotenv`
  - Reads `schedule.json` from project root; exits with a clear error if missing or if any entry has an invalid `day` value
  - Exports: `email`, `password`, `golfers` array (filtered to complete credential pairs only), `timezone`, `horizonDays`, `maxRetries`, `screenshotDir`, `dbPath`, `schedulerHour` (validated 0–23, defaults to 6), `site` object with `memberUrl`, `courses.pines.id`, `courses.oaks.id`
  - Exports `resolveAlternatingCourse(dateStr)` — even ISO week → `'Pines'`, odd ISO week → `'Oaks'`
  - `schedule` array maps raw JSON entries to internal shape: `{ day (0–6), windowStart, windowEnd, players, slots, preferredCourse, label }`
  - Process exits with readable error message if `GOLF_EMAIL` or `GOLF_PASSWORD` are missing

### TASK-004: Implement `src/db.js` — SQLite persistence layer (sql.js)
- **Owner:** backend-architect
- **Effort:** M
- **Blocked by:** TASK-002, TASK-003
- **Acceptance criteria:**
  - Uses `sql.js` (pure-JS, no native build)
  - Auto-creates `./data/` directory if absent
  - `bookings` table schema matches PRD Section 7: all 19 columns including `golfer_index INTEGER NOT NULL DEFAULT 0`, `window_start`, `window_end`
  - `UNIQUE(date, target_time, slot_index)` constraint present
  - Indexes on `date` and `status`
  - `ALTER TABLE … ADD COLUMN` migrations wrapped in try/catch for backward compatibility with existing databases
  - Exports async methods: `getDb`, `ensureBookings`, `getPendingBookings`, `getBookingsByDate`, `getAllUpcoming`, `markSuccess`, `markFailed`, `markPartial`, `markSkipped`, `markCancelled`, `getBookingById`, `getConfirmedByDate`, `updateBookingSync`
  - `getAllUpcoming()` detects file `mtime` change and re-reads from disk without replacing the in-flight in-memory instance mid-write
  - `getLastSyncAt()` / `setLastSyncAt()` read/write `./data/sync-meta.json` synchronously
  - `save()` persists binary export to `config.dbPath` after every mutation
  - `getPendingBookings()` filters `status IN ('pending','failed')` and `attempts < maxRetries`

### TASK-005: Implement `schedule.json` — recurring booking schedule definition
- **Owner:** backend-architect
- **Effort:** XS
- **Blocked by:** none
- **Acceptance criteria:**
  - Five entries: Monday, Tuesday, Friday, Saturday, Sunday
  - Fields per entry: `day`, `windowStart`, `windowEnd`, `players`, `slots`, `course`
  - Sunday `course` value is `"alternating"`
  - Player counts and slot counts match PRD Section 4 (Mon 12/3, Tue 8/2, Fri 12/3, Sat 12/3, Sun 12/3)

### TASK-006: Implement `src/scheduler.js` — slot computation
- **Owner:** backend-architect
- **Effort:** S
- **Blocked by:** TASK-003, TASK-005
- **Acceptance criteria:**
  - `computeBookingSlots()` iterates `config.horizonDays` days from today using `dayjs` in `config.timezone`
  - Assigns `golferIndex` round-robin per unique booking date — all slots on the same date share one golfer index
  - Each slot target time spaced 10 min apart from `windowStart`
  - `"alternating"` sentinel resolved via `resolveAlternatingCourse(dateStr)` before inserting
  - Always sets `players: 4` per slot
  - Returns flat array of slot objects with: `{ date, dayLabel, targetTime, windowStart, windowEnd, course, slotIndex, players, golferIndex }`
  - `groupByDateAndTime(bookings)` groups DB rows by `date|day_label` key, sorts each group's slots by `slot_index`

---

## Phase 2: Browser Automation — SiteAutomation Class

### TASK-007: Implement `SiteAutomation` skeleton — browser lifecycle
- **Owner:** backend-architect
- **Effort:** S
- **Blocked by:** TASK-002, TASK-003
- **Acceptance criteria:**
  - Constructor accepts `{ email, password }`, defaults to `config.email` / `config.password`
  - `init()` launches Chromium via Playwright; `headless` controlled by `HEADLESS` env var; viewport 1280×900; timezone set from `config.timezone`
  - Default page timeout set to 30 000 ms
  - `close()` closes browser and nulls internal refs
  - `screenshot(name)` saves to `config.screenshotDir` with timestamp suffix, returns path
  - All page navigations use `{ waitUntil: 'domcontentloaded' }`

### TASK-008: Implement `login()` and session helpers
- **Owner:** backend-architect
- **Effort:** M
- **Blocked by:** TASK-007
- **Acceptance criteria:**
  - `navigateToBooking(courseId, date)` navigates to `{memberUrl}/teetimes?course={courseId}&date={date}`
  - `login()` clicks Login button → finds GolfID iframe or embedded form → fills email/password → submits
  - Dismisses email-verification interstitial via `[aria-label="Close"]` and body-click fallback
  - `_checkForBlocks()` throws `BLOCKED: …` if CAPTCHA or Access Denied indicators found on page
  - `_verifyLoggedIn()` checks for post-login DOM indicators; logs warning (does not throw) if uncertain
  - All element clicks use `el.evaluate(el => el.click())`, never Playwright `.click()`
  - `_dismissModals()` clicks `.MuiBackdrop-root` and presses Escape

### TASK-009: Implement `clearCart()`
- **Owner:** backend-architect
- **Effort:** S
- **Blocked by:** TASK-008
- **Acceptance criteria:**
  - `clearCart()` opens cart panel and removes all items
  - Called after every successful `login()` to prevent "cart limit" errors
  - Handles empty cart gracefully — no error thrown
  - `_clickCartIcon()` tries: aria-label selectors → MuiBadge in header → rightmost header element

### TASK-010: Implement tee time discovery
- **Owner:** backend-architect
- **Effort:** M
- **Blocked by:** TASK-008
- **Acceptance criteria:**
  - `selectCourse(courseName)` accepts `'Pines'` or `'Oaks'`, uses dropdown or filter buttons
  - `selectDate(dateStr)` sets date via URL param first, then optionally clicks date picker
  - `getAvailableTeeTimes()` finds all `button:has-text("Book Now")`, walks DOM up max 3 levels (text < 300 chars), extracts time via regex
  - Returns `Array<{ time, text, element }>` with times in 24 h `HH:MM` format
  - `findConsecutiveSlots(teeTimes, windowStart, windowEnd, slotsNeeded)` searches within window, verifies 5–15 min gaps between each consecutive slot
  - `findSlotsInWindow(teeTimes, windowStart, windowEnd, maxSlots)` fallback — returns up to `maxSlots` sorted slots in window
  - `_extractTime(text)` converts `h:mm AM/PM` strings to `HH:MM` 24 h

### TASK-011: Implement `bookSlot()` — 4-player-only booking
- **Owner:** backend-architect
- **Effort:** M
- **Blocked by:** TASK-010
- **Acceptance criteria:**
  - `bookSlot(element, slotIndex)` clicks the Book Now button for the given element
  - Tries golfer count **4 only** (`preferenceOrder = [4]`)
  - If 4-player option is not selectable (disabled or absent), returns `{ success: false, error: '4-player option unavailable' }` without booking fewer players
  - Adds to cart on success; returns `{ success: true, screenshotPath }`
  - Screenshots taken at key steps

### TASK-012: Implement `completeCheckout()`
- **Owner:** backend-architect
- **Effort:** M
- **Blocked by:** TASK-011
- **Acceptance criteria:**
  - Navigates the checkout flow: accept terms → Complete Your Purchase
  - Extracts confirmation number from success page using regex matching both `Reservation #NUMBER` and `Confirmation #Name|NUMBER` formats
  - Returns `{ success: true, confirmationNumber, screenshotPath }` on success
  - Returns `{ success: false, error }` on failure
  - Screenshot taken at checkout completion step

### TASK-013: Implement `getExistingReservations(date)`
- **Owner:** backend-architect
- **Effort:** M
- **Blocked by:** TASK-008
- **Acceptance criteria:**
  - Navigates to `/reservation/history`
  - Paginates via NEXT button up to 20 pages
  - For each card, clicks VIEW DETAILS (handles SPA navigation where URL may not change), extracts date/time/course/confirmation via full body text scan
  - Confirmation number regex matches both `Reservation #NUMBER` and `Confirmation #Name|NUMBER` formats
  - Returns `Array<{ date, time, course, confirmationNumber }>` filtered to the requested date
  - Uses `goBack()` after each detail page; falls back to re-navigating the history URL if `goBack()` fails

### TASK-014: Implement `cancelReservations(bookings)`
- **Owner:** backend-architect
- **Effort:** M
- **Blocked by:** TASK-013
- **Acceptance criteria:**
  - Accepts array of booking objects with `confirmation_number`, `actual_time`, `course`
  - Only attempts cancellation when `confirmation_number` matches `/^\d+$/`
  - Navigates to `/reservation/history/{id}/cancel` for each
  - Returns `{ cancelled, failed, details: [{ resNum, time, course, success, error? }] }`

### TASK-015: Implement `scrapeReservationHistory()` and `fetchReservationById(id)`
- **Owner:** backend-architect
- **Effort:** M
- **Blocked by:** TASK-013
- **Acceptance criteria:**
  - `scrapeReservationHistory()` returns all visible upcoming reservations as `Array<{ date, time, course, confirmationNumber }>`
  - `fetchReservationById(id)` navigates directly to `/reservation/history/{id}`, extracts `{ date, time, course, confirmationNumber }`, returns `null` if not found or access denied
  - Both methods require an active authenticated session; neither calls `init()` or `login()`

---

## Phase 3: Booking Engine

### TASK-016: Implement `BookingEngine.run()` — main orchestration
- **Owner:** backend-architect
- **Effort:** M
- **Blocked by:** TASK-004, TASK-006, TASK-011, TASK-012, TASK-013
- **Acceptance criteria:**
  - Flow: `computeBookingSlots()` → `db.ensureBookings()` → `db.getPendingBookings()` → `groupByDateAndTime()` → group by `golferIndex` → per-golfer session loop
  - Per-golfer mode: `new SiteAutomation({ email, password })` → `init()` → `navigateToBooking()` → `login()` → `clearCart()` → process all this golfer's date groups → `close()` in `finally`
  - Shared-site mode (when `opts.site` provided): reuses session, calls `clearCart()` before processing all groups
  - BLOCKED error breaks the entire run and calls `notify.alertBlocked()`
  - Dry-run mode: logs what would be booked with golfer assignments; returns `{ total, booked:0, failed:0, partial:0, dryRun:true }`; no browser launched
  - Returns `{ total, booked, failed, partial }` stats

### TASK-017: Implement `BookingEngine._processGroup()` — date-level booking with fallback
- **Owner:** backend-architect
- **Effort:** M
- **Blocked by:** TASK-016
- **Acceptance criteria:**
  - Pre-checks existing reservations via `getExistingReservations(date)`; matched slots marked `EXISTING_RESERVATION` confirmed and removed from pending list; unmatched slots proceed to booking
  - Builds 10 attempts: preferred course × 5 time offsets `[0, -60, +60, -120, +120]` min, then other course × 5 offsets
  - Skips any attempt where the shifted `windowStart` would fall below `00:00`
  - `lockedCourse` set after first successful booking; subsequent attempts for the other course are skipped
  - Calls `notify.alertSuccess`, `notify.alertPartialBooking`, or `notify.alertFailure` at end of group
  - BLOCKED error propagated up to `run()`

### TASK-018: Implement `BookingEngine._bookSlots()` — individual slot booking loop
- **Owner:** backend-architect
- **Effort:** M
- **Blocked by:** TASK-017
- **Acceptance criteria:**
  - Re-navigates, re-selects course, and re-scans tee times before each slot (element refs go stale after navigation)
  - Calls `bookSlot()` then `completeCheckout()`
  - Marks DB `confirmed` on success with `actualTime`, `course`, `confirmationNumber`, `screenshotPath`
  - Marks DB `failed` on booking or checkout failure with error message
  - Uses `'CONFIRMED'` as placeholder `confirmationNumber` only when checkout page provides no numeric ID
  - 2-second wait between slots
  - Tracks `_bookedSlotIds` set so caller can filter out already-booked slots after partial success

### TASK-019: Gap fix — multi-batch split for > 3 slots per transaction (Section 19)
- **Owner:** backend-architect
- **Effort:** M
- **Blocked by:** TASK-018
- **Acceptance criteria:**
  - `_bookSlots()` or a wrapper detects when `slots.length > 3`
  - Splits into batches of at most 3 slots each
  - Each batch completes its own full checkout flow before the next batch begins
  - All batches book exactly 4 players per slot
  - Log line emitted when a batch split is triggered: how many batches, how many slots each
  - Single-batch path (≤ 3 slots) unchanged

### TASK-020: Gap fix — `verifyBookingOnSite` post-checkout verification (Section 19)
- **Owner:** backend-architect
- **Effort:** M
- **Blocked by:** TASK-013, TASK-018
- **Acceptance criteria:**
  - `SiteAutomation.verifyBookingOnSite(date, time)` navigates to the Reservations page and checks for a reservation matching date and time (±15 min tolerance)
  - Called from `_bookSlots()` after `completeCheckout()` returns a numeric confirmation number
  - If verification fails: slot marked `failed` instead of `confirmed`; `WARN` log emitted
  - If Reservations page is unreachable or times out: verification skipped with a warning; slot remains `confirmed`
  - Existing trust-confirmation-page behaviour is retained as the fallback when `verifyBookingOnSite` is skipped

---

## Phase 4: Sync Engine

### TASK-021: Implement `src/reconcile.js` — positional pairing logic
- **Owner:** backend-architect
- **Effort:** S
- **Blocked by:** TASK-004
- **Acceptance criteria:**
  - Exports `reconcileDate(date, siteSlots, dbSlots, logger)` as async function
  - Filters `dbSlots` to `PAIRABLE_STATUSES` (`confirmed`, `pending`, `cancelled`), sorts by `slot_index`
  - Sorts `siteSlots` ascending by time
  - Pairs positionally; calls `db.updateBookingSync()` when `actual_time` differs or DB has a placeholder confirmation and site has a real numeric ID
  - No DB write when pair is already in sync
  - Returns `{ updated, notFound, warnings[] }`
  - Contains no browser or site I/O

### TASK-022: Implement `src/sync.js` — two-phase sync orchestrator
- **Owner:** backend-architect
- **Effort:** M
- **Blocked by:** TASK-015, TASK-021
- **Acceptance criteria:**
  - `runSync(siteInstance?)` accepts an optional pre-authenticated session; creates and owns its own session when null
  - Phase 1: `scrapeReservationHistory()` → builds `siteByDate` map; records `step1VisibleDates`
  - Phase 2: identifies DB rows with placeholder confirmation numbers; collects known numeric IDs; probes ±`PROBE_RADIUS` (10) IDs via `fetchReservationById()`; merges hits into `siteByDate`
  - Phase 3: calls `reconcileDate()` for each date in `siteByDate`
  - FR-012: emits `[SYNC] WARN` for any confirmed booking with a real numeric confirmation whose date was in `step1VisibleDates` but has zero matching site slots
  - Writes `lastSyncAt` to `sync-meta.json` via `db.setLastSyncAt()`
  - Returns `{ checked, updated, warnings, errors }`
  - All log lines prefixed `[SYNC]`
  - Phase 1 failure is caught and logged; Phase 2 and Phase 3 still execute

---

## Phase 5: CLI and Daily Scheduler

### TASK-023: Implement `src/index.js` — Commander CLI
- **Owner:** backend-architect
- **Effort:** S
- **Blocked by:** TASK-016, TASK-022
- **Acceptance criteria:**
  - Commands: `book` (default, with `--dry-run` option), `status`, `init`, `scheduler`, `web`, `cancel <date>`, `sync`
  - `status` prints aligned table: date, day_label, target_time, slot_index, status, confirmation_number, attempts; summary line with confirmed/pending/failed counts
  - `init` calls `computeBookingSlots()` then `db.ensureBookings()`
  - `cancel <date>` accepts `YYYY-MM-DD`, `MM/DD`, `MM-DD`; normalises to `YYYY-MM-DD`; cancels site reservations with real numeric confirmation numbers via `site.cancelReservations()`; marks DB cancelled on success
  - `sync` calls `runSync()`, prints JSON result, exits 0
  - `book` exits code 1 if any slots failed, 0 otherwise (non-dry-run)

### TASK-024: Implement daily scheduler in `scheduler` CLI command
- **Owner:** backend-architect
- **Effort:** S
- **Blocked by:** TASK-023
- **Acceptance criteria:**
  - Forces `HEADLESS=true` on startup
  - `msUntilNextFire(hour)` calculates ms until next `SCHEDULER_HOUR:00` in `config.timezone` — returns positive ms for a future target, moves to tomorrow if target has already passed today
  - FR-023: if startup time is at or past today's fire hour, `runOnce()` fires immediately; otherwise schedules with `setTimeout`
  - Each cycle: creates primary `SiteAutomation` → `init()` → `navigateToBooking()` → `login()` → `runSync(site)` → `site.close()` in `finally` → `new BookingEngine().run()` → `setTimeout(runOnce, delay)` for next cycle
  - Sync failure logged but does not prevent booking phase from running
  - All log lines prefixed `[SCHEDULER]`
  - Pure `setTimeout` chain — no `setInterval`

---

## Phase 6: Web UI

### TASK-025: Implement Express server skeleton — `src/web.js`
- **Owner:** frontend-developer
- **Effort:** S
- **Blocked by:** TASK-004
- **Acceptance criteria:**
  - Express app on `PORT` env var (default 3002)
  - HTTPS: when `HTTPS_ENABLED=true`, loads `data/certs/cert.pem` and `data/certs/key.pem` and creates `https.Server`; otherwise plain HTTP
  - `isLocalIP(ip)` returns true for `::1`, `127.0.0.1`, `192.168.*`, `10.*`, `172.*`
  - `startServer()` exported and called by the `web` CLI command
  - Missing cert files with `HTTPS_ENABLED=true` produce a clear startup error before exit

### TASK-026: Implement access logging middleware and geo enrichment
- **Owner:** frontend-developer
- **Effort:** S
- **Blocked by:** TASK-025
- **Acceptance criteria:**
  - Middleware records all external (non-local) requests: timestamp, IP, method, path, browser, OS, device, UA, referrer
  - `parseUA(ua)` extracts browser/OS/device from User-Agent string
  - `geoLookup(ip, entry)` calls `http://ip-api.com/json/{ip}` asynchronously; updates entry with country, city, ISP, geoTz; saves log after update
  - `ACCESS_LOG` in-memory array (max 500 entries); loaded from `data/access-log.json` on startup; saved after each new entry
  - `GET /api/ping` endpoint: `Access-Control-Allow-Origin: *`, logs external hits with `ref` and `page` query params, returns 204

### TASK-027: Implement `GET /api/bookings` and booking trigger endpoints
- **Owner:** frontend-developer
- **Effort:** XS
- **Blocked by:** TASK-025, TASK-004
- **Acceptance criteria:**
  - `GET /api/bookings` returns `{ bookings, lastSyncAt }` JSON with no auth requirement
  - `POST /api/book-month` spawns `node src/index.js book` as a detached child process; returns `{ success: true, message }` immediately without waiting for completion
  - `POST /api/book-day` (local IP only): accepts `{ date, targetTime, course, slots }`; inserts custom booking slots via `db.ensureBookings()`; spawns detached booking process; returns 403 for external IPs

### TASK-028: Implement `POST /api/cancel/:id`
- **Owner:** frontend-developer
- **Effort:** S
- **Blocked by:** TASK-025, TASK-014
- **Acceptance criteria:**
  - Validates `id` is a positive integer; returns 400 otherwise
  - Returns 404 if booking not found
  - If `confirmation_number` is not a real numeric ID: marks DB cancelled, returns `{ success: true }`
  - If real numeric ID: creates `SiteAutomation`, logs in, calls `cancelReservations([booking])`; marks DB cancelled on success; returns `{ success: false, error }` on site failure
  - Browser session always closed in `finally`

### TASK-029: Implement calendar HTML page — `GET /`
- **Owner:** frontend-developer
- **Effort:** L
- **Blocked by:** TASK-027, TASK-028
- **Acceptance criteria:**
  - Server-rendered HTML showing current month and next month
  - Chip colours: `chip-confirmed` green (`#2D6A4F`), `chip-pending` amber (`#B45309`), `chip-failed`/`chip-partial` red (`#DC2626`), `chip-cancelled` grey + line-through, `chip-skipped` hidden (`display:none`)
  - Clicking a chip opens a detail modal with: date, day, confirmed time, target time, course, players, booked-by golfer (`Golfer N (email)`), status, confirmation number (sentinel values `EXISTING_RESERVATION`/`CONFIRMED`/`access` displayed as `—`)
  - Admin controls (Schedule Month, Book Now) rendered only for local IPs
  - `GOLFERS` JSON array embedded in page script for client-side golfer label lookup
  - "Last synced" timestamp in header formatted in `config.timezone`; shows `Never` when `lastSyncAt` is null
  - Fonts: Inter + Manrope from Google Fonts
  - WCAG AA contrast ratios met for all text/background pairs

### TASK-030: Implement mobile-responsive layout
- **Owner:** frontend-developer
- **Effort:** S
- **Blocked by:** TASK-029
- **Acceptance criteria:**
  - At viewport < 640 px, calendar grid collapses to `.mobile-booking-list` card view
  - No horizontal overflow at 375 px viewport width; `overflow-x: hidden` on body; `max-width: 100%` on images and calendar
  - Floating zoom widget hidden on mobile (`display:none` at < 640 px)
  - Modal box uses `width: 90%` on small screens
  - Touch targets meet 44×44 px minimum

### TASK-031: Implement auto-refresh and modal keyboard handling
- **Owner:** frontend-developer
- **Effort:** S
- **Blocked by:** TASK-029
- **Acceptance criteria:**
  - Client-side `refreshChips()` polls `GET /api/bookings` every 60 seconds and updates chip DOM without a full page reload
  - Polling paused while any modal is open; resumes on modal close
  - Modal closes on Escape key and on overlay click
  - Modal has ARIA roles: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`
  - Focus trapped inside modal while open; returns to trigger element on close

### TASK-032: Implement `GET /admin` — access log dashboard
- **Owner:** frontend-developer
- **Effort:** S
- **Blocked by:** TASK-026, TASK-025
- **Acceptance criteria:**
  - Returns 403 for any non-local IP
  - Stats cards: Total Visits, Unique IPs, Mobile count, Countries count
  - Visit table columns: Time (in `config.timezone`), IP, Location (flag + city/region/country), ISP, Device badge (Mobile/Tablet/Desktop), Browser, OS, Request (method + path), User-Agent (truncated at 60 chars with `title` tooltip)
  - Auto-refreshes every 30 seconds via `setTimeout(location.reload, 30000)`
  - Consistent design tokens with main calendar page (Inter/Manrope fonts, `#1B3A2D` header background)

---

## Phase 7: Utility Scripts

### TASK-033: Implement `cancel-rebook.js` — batch cancel and re-book
- **Owner:** backend-architect
- **Effort:** M
- **Blocked by:** TASK-014, TASK-016
- **Acceptance criteria:**
  - `FROM_DATE` constant configurable at top of file
  - Phase 1: logs in as `golfers[0]`; scrapes all upcoming site reservations using scroll + VIEW DETAILS iteration; filters to `date >= FROM_DATE` with real numeric confirmation numbers; cancels each via `cancelReservations()`
  - Phase 2: runs `new BookingEngine().run()` — uses per-golfer rotation for re-booking
  - Prints cancellation and booking stats to console
  - Fatal errors caught at top level; process exits with code 1

### TASK-034: Implement `fix-confirmations.js` — placeholder confirmation number repair
- **Owner:** backend-architect
- **Effort:** S
- **Blocked by:** TASK-013
- **Acceptance criteria:**
  - Queries DB for `status='confirmed'` rows with placeholder confirmation numbers (`EXISTING_RESERVATION`, `access`, `CONFIRMED`, or any non-numeric value)
  - Groups by date; navigates Reservations page for each date
  - Matches site reservation to DB slot by time proximity (±15 min)
  - Updates DB with real numeric confirmation number via `db.updateBookingSync()`
  - Prints updated/not-found counts to console
  - Dates beyond the ~7-day site display window handled gracefully with a logged warning

### TASK-035: Implement `get-cert.js` — Let's Encrypt TLS certificate via DuckDNS
- **Owner:** deployment-engineer
- **Effort:** M
- **Blocked by:** TASK-001
- **Acceptance criteria:**
  - Requires `DUCKDNS_TOKEN`, `DUCKDNS_DOMAIN`, `GOLF_EMAIL` in `.env`; exits with clear error if any are missing
  - Uses `acme-client` with Let's Encrypt production directory
  - DNS-01 challenge: sets `_acme-challenge.{domain}` TXT record via DuckDNS API; polls Google resolver (8.8.8.8) for propagation with 3-minute timeout
  - Saves `cert.pem` and `key.pem` to `data/certs/`; caches ACME account key at `data/certs/account-key.pem`
  - Clears TXT record in a `finally` block regardless of success or failure
  - Re-runnable for renewal

---

## Phase 8: Deployment and Infrastructure

### TASK-036: Implement `Dockerfile` — containerised deployment image
- **Owner:** deployment-engineer
- **Effort:** S
- **Blocked by:** TASK-001
- **Acceptance criteria:**
  - Base image is a Node.js LTS variant
  - `npm install` layer cached before copying source
  - `npx playwright install --with-deps chromium` run during image build
  - `data/` directory created as a volume mount point
  - Default `CMD` runs `npm run scheduler` with `HEADLESS=true`
  - No dev dependencies in final layer

### TASK-037: Implement `docker-compose.yml` — local and production compose config
- **Owner:** deployment-engineer
- **Effort:** S
- **Blocked by:** TASK-036
- **Acceptance criteria:**
  - Service `golf-scheduler` built from local `Dockerfile`
  - `./data` bind-mounted to `/app/data` for DB, sync metadata, and cert persistence
  - `./screenshots` bind-mounted for screenshot persistence
  - Port 3002 exposed (and 443 when HTTPS enabled)
  - `.env` file referenced for secrets — no hard-coded credentials
  - `restart: unless-stopped` policy set

### TASK-038: Implement `setup-scheduler.ps1` — Windows startup registration
- **Owner:** deployment-engineer
- **Effort:** S
- **Blocked by:** TASK-024
- **Acceptance criteria:**
  - PowerShell script registers the scheduler as a Windows Task Scheduler task or NSSM service
  - Sets `HEADLESS=true` in the task environment
  - Sets working directory to the repo root
  - Documents how to check task status and view logs
  - Re-running the script updates (not duplicates) an existing task registration

---

## Phase 9: Gap Closure and Edge-Case Hardening

### TASK-039: Verify and harden BLOCKED error short-circuit
- **Owner:** backend-architect
- **Effort:** S
- **Blocked by:** TASK-017
- **Acceptance criteria:**
  - Any error whose `.message` starts with `'BLOCKED'` immediately stops the entire booking run
  - `notify.alertBlocked()` called exactly once per BLOCKED event
  - The current golfer session is closed before the error propagates
  - Remaining golfer sessions are not started after a BLOCKED event

### TASK-040: Verify course-locking within a date group
- **Owner:** backend-architect
- **Effort:** XS
- **Blocked by:** TASK-017
- **Acceptance criteria:**
  - Once any slot in a date group is booked, `lockedCourse` is set to the course that was used
  - All subsequent attempts in that group skip the other course
  - No booking for a given date spans both Pines and Oaks

### TASK-041: Verify negative-offset guard in `_processGroup`
- **Owner:** backend-architect
- **Effort:** XS
- **Blocked by:** TASK-017
- **Acceptance criteria:**
  - If applying a negative time offset produces a `windowStart` before `00:00` (negative minutes), that attempt is skipped
  - No exception is thrown; the attempt is silently omitted with a debug log

### TASK-042: Verify `INSERT OR IGNORE` duplicate-insert guard
- **Owner:** backend-architect
- **Effort:** XS
- **Blocked by:** TASK-004
- **Acceptance criteria:**
  - `ensureBookings()` uses `INSERT OR IGNORE` so repeated calls for the same `(date, target_time, slot_index)` tuple do not error or overwrite existing rows
  - Confirmed bookings are never reset to `pending` by a subsequent `ensureBookings()` call

### TASK-043: Verify max-retries filter
- **Owner:** backend-architect
- **Effort:** XS
- **Blocked by:** TASK-004
- **Acceptance criteria:**
  - `getPendingBookings()` excludes rows where `attempts >= config.maxRetries` (default 3)
  - A slot that has failed 3 times is never returned to the booking engine

### TASK-044: Verify incomplete golfer credentials filter
- **Owner:** backend-architect
- **Effort:** XS
- **Blocked by:** TASK-003
- **Acceptance criteria:**
  - `config.golfers` excludes any entry where `email` or `password` is falsy
  - System operates correctly with 1, 2, or 3 complete golfer credential pairs
  - If `GOLF_EMAIL2` is set but `GOLF_PASSWORD2` is not (or vice versa), that entry is silently excluded

### TASK-045: Verify FR-012 — missing confirmed booking warning in sync
- **Owner:** backend-architect
- **Effort:** XS
- **Blocked by:** TASK-022
- **Acceptance criteria:**
  - After Phase 1 scrape, any confirmed booking with a real numeric confirmation whose date was in `step1VisibleDates` but has zero site reservations emits a `[SYNC] WARN` log
  - Warning includes booking `id`, `date`, `slot_index`, and confirmation number
  - Warning count is incremented in the `warnings` field of the return value

### TASK-046: Verify `getAllUpcoming()` external-write detection
- **Owner:** backend-architect
- **Effort:** XS
- **Blocked by:** TASK-004
- **Acceptance criteria:**
  - `getAllUpcoming()` checks file `mtime` on each call
  - When `mtime` has advanced since last load, reads a fresh copy from disk
  - Race guard: if `mtime` advances again between the two `statSync` calls, module-level `db` is not replaced (but query still uses the fresh instance)
  - Returns data from the fresh instance regardless of whether module-level `db` was replaced

### TASK-047: Verify cancel date format normalisation
- **Owner:** backend-architect
- **Effort:** XS
- **Blocked by:** TASK-023
- **Acceptance criteria:**
  - `cancel <date>` accepts `YYYY-MM-DD`, `MM/DD`, `MM-DD` input formats
  - Short formats normalise to `YYYY-MM-DD` using the current calendar year
  - Invalid format produces a clear error message and `process.exit(1)`

---

## Phase 10: Notifications Module

### TASK-048: Implement `src/notify.js` — booking outcome alerts
- **Owner:** backend-architect
- **Effort:** XS
- **Blocked by:** TASK-002
- **Acceptance criteria:**
  - Exports: `alertSuccess({ date, dayLabel, slots, course })`, `alertFailure({ date, dayLabel, error })`, `alertPartialBooking({ date, dayLabel, bookedSlots, totalSlots, screenshotPath })`, `alertBlocked({ screenshotPath, error })`
  - All four functions log via `logger`
  - `alertBlocked` and `alertPartialBooking` also write directly to `console.error` / `console.log` for high visibility in interactive runs
  - `alertPartialBooking` includes contact info: `850-833-9664`, `jhill2@fwb.org`

---

## Phase 11: End-to-End Verification

### TASK-049: Dry-run smoke test — full booking engine
- **Owner:** backend-architect
- **Effort:** S
- **Blocked by:** TASK-016, TASK-023
- **Acceptance criteria:**
  - `npm run dry-run` completes without error
  - Output lists all pending slots with golfer assignments and target times
  - No browser launched, no DB mutations made
  - Exit code 0

### TASK-050: `npm run status` output verification
- **Owner:** backend-architect
- **Effort:** XS
- **Blocked by:** TASK-023, TASK-049
- **Acceptance criteria:**
  - Command prints aligned table of all upcoming bookings
  - Summary line shows confirmed/pending/failed counts
  - Handles empty DB gracefully with message "No upcoming bookings"

### TASK-051: `npm run web` end-to-end calendar verification
- **Owner:** frontend-developer
- **Effort:** S
- **Blocked by:** TASK-029, TASK-031
- **Acceptance criteria:**
  - Server starts and `GET /` returns 200 with valid HTML
  - `GET /api/bookings` returns `{ bookings: [], lastSyncAt: null }` on a fresh DB
  - Calendar renders current and next month without JS errors in console
  - "Last synced: Never" shown when no sync has run
  - `GET /admin` returns 200 for localhost; returns 403 when `X-Forwarded-For` is set to an external IP

### TASK-052: HTTPS server startup verification
- **Owner:** deployment-engineer
- **Effort:** S
- **Blocked by:** TASK-025, TASK-035
- **Acceptance criteria:**
  - With `HTTPS_ENABLED=true` and valid cert/key in `data/certs/`, server starts on HTTPS without error
  - With `HTTPS_ENABLED=false` or unset, plain HTTP server starts regardless of cert file presence
  - Missing cert files with `HTTPS_ENABLED=true` produce a clear error message before process exit

### TASK-053: Multi-golfer rotation integration verification
- **Owner:** backend-architect
- **Effort:** S
- **Blocked by:** TASK-016, TASK-006
- **Acceptance criteria:**
  - With two or three complete golfer credential pairs in `.env`, `npm run dry-run` shows different golfer indices assigned to different booking dates
  - All slots on the same date share the same golfer index
  - Round-robin counter advances with each unique booking date in the horizon window
  - When computed `golferIndex` exceeds `golfers.length - 1`, falls back to `golfers[0]`

### TASK-054: Sync engine integration verification
- **Owner:** backend-architect
- **Effort:** S
- **Blocked by:** TASK-022, TASK-023
- **Acceptance criteria:**
  - `npm run sync` completes without unhandled exception
  - `data/sync-meta.json` created/updated with current ISO timestamp after run
  - Console output includes `checked`, `updated`, `warnings`, `errors` count fields
  - All sync log lines carry the `[SYNC]` prefix

---

## Phase 12: Documentation and Maintenance

### TASK-055: Document environment variables and setup in README
- **Owner:** deployment-engineer
- **Effort:** S
- **Blocked by:** TASK-001
- **Acceptance criteria:**
  - README lists all 14 env vars with required/optional status, default value, and one-line description
  - Setup steps: clone → `npm install` → `npx playwright install chromium` → copy `.env.example` to `.env` → fill credentials → `npm run init` → `npm run web`
  - Scheduler daemon setup referenced (Docker compose or `setup-scheduler.ps1`)
  - Platform note present: Windows primary; use Unix shell syntax in Git Bash

### TASK-056: Document cert renewal process
- **Owner:** deployment-engineer
- **Effort:** XS
- **Blocked by:** TASK-035
- **Acceptance criteria:**
  - README or inline `get-cert.js` comment explains the 90-day Let's Encrypt expiry
  - Instructions to re-run `node get-cert.js` before day 60
  - `DUCKDNS_TOKEN` and `DUCKDNS_DOMAIN` requirements explained

### TASK-057: Update agent memory with observed requirement patterns
- **Owner:** backend-architect
- **Effort:** XS
- **Blocked by:** none
- **Acceptance criteria:**
  - `C:\Users\Bruce\source\repos\GolfScheduler\.claude\agent-memory\project-planner\MEMORY.md` updated with any new stable patterns or recurring ambiguities surfaced during this session
  - No session-specific or unverified information recorded
  - Existing entries corrected if contradicted by code review findings in this session
