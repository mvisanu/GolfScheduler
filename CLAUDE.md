# CLAUDE.md

## Commands

```bash
npm run book          # Run booking engine once
npm run dry-run       # Show what would be booked without booking
npm run status        # Print table of all upcoming bookings
npm run init          # Populate DB with computed slots (no booking)
npm run sync          # Sync DB with FWB site reservation history
npm run scheduler     # Run daily at 06:00: sync then book
npm run web           # Start calendar web view at http://localhost:3009
npm run cancel -- <date>  # Cancel all reservations for a date (YYYY-MM-DD, MM/DD, MM-DD)
```

No build step, no linter. Raw Node.js.  
**Tests:** `node --test tests/test.js` — 102 tests (sections A–G).

## Architecture

**Booking flow:** `index.js` (Commander CLI) → `BookingEngine` (booking.js) → `SiteAutomation` (site.js) + `db.js` + `scheduler.js`  
**Sync flow:** `index.js sync` → `runSync()` (sync.js) → `SiteAutomation.scrapeReservationHistory()` + `fetchReservationById()` → `reconcileDate()` (reconcile.js) → `db.updateBookingSync()`

## Core Modules

**booking.js** — `BookingEngine` class. `new BookingEngine({ dryRun, site })`. When `site` is null (default), groups pending bookings by `golfer_index` and creates a separate `SiteAutomation` session per golfer account. Uses 10-attempt course/time fallback (preferred→other course, each with 5 time offsets `[0, -1hr, +1hr, -2hr, +2hr]`). `_shiftTime()` uses `((total % 1440) + 1440) % 1440` for correct midnight wrapping. After successful checkout with a real numeric confirmation, calls `verifyBookingOnSite(date, time)` — if booking not found on Reservations page it's marked `failed`; caching delays skip verification. **Tee time caching:** `_processGroup()` fetches `getAvailableTeeTimes()` once per course per date and passes the cached array to `_tryCourse()`; all 5 time-offset attempts for the same course filter in memory without re-navigating (eliminates up to 8 redundant page loads per date group).

**site.js** — `SiteAutomation` class. Playwright (Chromium) automation against `https://fort-walton-member.book.teeitup.golf` (Next.js/MUI SPA). **Golfer count: tries 4 only** (`preferenceOrder = [4]`) — skips the tee time entirely if 4-player option is unavailable; never books fewer than 4. Pre-filters tee time cards by player capacity (skips cards where max < 4) before opening modal. Uses `el.evaluate(el => el.click())` to bypass MUI backdrop overlays. `selectCourse(courseName)` accepts `'Pines'` or `'Oaks'`. Headless mode via `HEADLESS` env var. Screenshot dir existence is checked once per process (module-level flag) rather than on every `screenshot()` call.

**scheduler.js** — Pure computation. `computeBookingSlots()` generates slots for next N days from config schedule. `"alternating"` course sentinel resolved via `resolveAlternatingCourse(dateStr)` (ISO week parity: even=Pines, odd=Oaks). Assigns `golferIndex` per date using round-robin (`dateCounter % numGolfers`). Consecutive slots spaced 10 min apart.

**db.js** — sql.js (pure-JS SQLite). Auto-persists to `./data/bookings.db`. Table `bookings` with `UNIQUE(date, target_time, slot_index)`. Status values: `pending`, `confirmed`, `failed`, `partial`, `skipped`, `cancelled`. `getAllUpcoming()` reads from a local `freshDb` instance — does NOT replace the module-level singleton. `cleanupStaleSlots()` removes stale `skipped` rows after schedule changes.

**sync.js** — `runSync(siteInstance?)`. Scrapes reservation history, probes by ID for placeholder confirmation numbers, applies `reconcileDate()` per date. Writes `lastSyncAt` to `./data/sync-meta.json`.

**config.js** — Loads `.env`, defines schedule (Mon/Tue/Fri/Sat/Sun), course IDs (Pines=9437, Oaks=9438). `golfers` array built from up to 3 `GOLF_EMAIL`/`GOLF_PASSWORD` pairs. Exports `resolveAlternatingCourse()`.

**web.js** — Express on port 3009. Calendar view (current + next month) showing `confirmed` bookings. Detail modal shows date, time, course, players, golfer, status, confirmation number. Admin controls (Schedule Month, Book Now, Cancel) rendered only for local IPs. `GET /api/bookings` returns JSON; client polls every 60s. `POST /api/book-month` spawns booking engine as background process. `POST /api/cancel/:id` validates positive integer ID. `GET /admin` (localhost only) shows access log dashboard. HTTPS via `HTTPS_ENABLED=true` + `data/certs/`.

**reconcile.js** — `reconcileDate(date, siteSlots, dbSlots, logger)`. Pairs site reservations to DB rows positionally. Calls `db.updateBookingSync()` per mismatch.

**notify.js** — Console/log alerts for booking outcomes.

## Booking Schedule (schedule.json)

| Day      | Window       | Players | Slots | Course      |
|----------|-------------|---------|-------|-------------|
| Monday   | 12:00-14:00 | 8       | 2     | Pines       |
| Tuesday  | 12:00-14:00 | 8       | 2     | Pines       |
| Friday   | 12:00-14:00 | 8       | 2     | Pines       |
| Saturday | 08:00-13:00 | 8       | 2     | Pines       |
| Sunday   | 08:00-10:00 | 16      | 4     | alternating |

Each slot = 4 players. Tee times spaced ~10 min apart. Falls back to other course and ±1hr/±2hr windows if preferred unavailable. Sunday alternates Pines (even ISO week) / Oaks (odd ISO week).

## Daily Scheduler

Pure `setTimeout` loop (not `setInterval`), fires at `SCHEDULER_HOUR:00` local time (default 06:00):
1. Dedicated `SiteAutomation` session logs in as primary golfer → `runSync(site)` → session closed.
2. `new BookingEngine()` runs (per-golfer sessions created internally).
3. Next 06:00 `setTimeout` scheduled.

If process starts after today's `SCHEDULER_HOUR`, runs immediately (FR-023).

## Data & Persistence

| Path | Contents |
|------|----------|
| `./data/bookings.db` | SQLite database |
| `./data/sync-meta.json` | `{ "lastSyncAt": "<ISO>" }` |
| `./data/access-log.json` | External visitor log (max 500) |
| `./data/certs/` | TLS cert/key/account-key |
| `./screenshots/` | PNG captures per booking step |
| `./golf-scheduler.log` | Winston, 5MB rotation, 3 files |

## Utility Scripts (project root, run with `node <script>`)

- **cancel-rebook.js** — Cancel all site reservations from `FROM_DATE` then re-book via `BookingEngine`.
- **cancel-and-rebook.js** — Variant: reads DB confirmed bookings, cancels on site, purges DB rows ≥ `FROM_DATE`, prints instructions to re-init.
- **fix-confirmations.js** — Loops all 3 golfer accounts, updates DB with real confirmation numbers for placeholder rows.
- **reset-failed.js** — Resets over-retried failed/placeholder-confirmed slots back to `pending`.
- **cancel-1player.js** — Cancels any site reservation showing only 1 player booked. (`HEADLESS=true node cancel-1player.js`)
- **get-cert.js** — Obtains Let's Encrypt cert via DuckDNS DNS-01. Requires `DUCKDNS_TOKEN`/`DUCKDNS_DOMAIN`. Renew every ~60 days.

## Environment Variables (.env)

```
GOLF_EMAIL, GOLF_PASSWORD        # Required — primary GolfID credentials
GOLF_EMAIL2, GOLF_PASSWORD2      # Optional — second golfer account
GOLF_EMAIL3, GOLF_PASSWORD3      # Optional — third golfer account
TIMEZONE                         # Default: America/Chicago
BOOKING_HORIZON_DAYS             # Default: 30
FALLBACK_MINUTES                 # Default: 30
DB_PATH                          # Default: ./data/bookings.db
SCREENSHOT_DIR                   # Default: ./screenshots
LOG_LEVEL                        # Default: info
HEADLESS                         # Default: false (set true for scheduler daemon)
SCHEDULER_HOUR                   # Default: 6
HTTPS_ENABLED                    # Default: false
DUCKDNS_TOKEN / DUCKDNS_DOMAIN   # Used by get-cert.js only
```

## Platform Notes

- Primary: Windows. Use Unix shell syntax in Git Bash.
- sql.js chosen over better-sqlite3 (avoids native build issues on Windows/Node 24).
- Run `npx playwright install chromium` after `npm install`.
- Run scheduler with `HEADLESS=true` to suppress Chromium window.

## Known Open Issues

- **Test D09/D10 flakiness**: zombie process holds port 3099 if prior test killed before `after()`. Fix: `netstat -ano | grep 3099` then `taskkill /PID <pid> /F`.
- **`reconcileDate()` zero test coverage** (P3): `src/reconcile.js` — high-value unit test target.
- **`generate-static.js` errors swallowed** (P3): invoked silently after booking/sync/scheduler runs; not in specs.