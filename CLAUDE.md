# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run book          # Run booking engine once (default command)
npm run dry-run       # Show what would be booked without booking
npm run status        # Print table of all upcoming bookings
npm run init          # Populate DB with computed slots (no booking)
npm run scheduler     # Run continuously, booking every 6 hours
npm run web           # Start calendar web view at http://localhost:3000
```

No build step, no tests, no linter. Raw Node.js execution.

## Architecture

**Orchestration flow:** `index.js` (Commander CLI) → `BookingEngine` (booking.js) → `SiteAutomation` (site.js) + `db.js` + `scheduler.js`

### Core modules

- **booking.js** — `BookingEngine` class. Orchestrates a full booking run: computes slots, ensures DB entries, groups pending bookings by date/time, then iterates each group through site automation. Pre-checks existing reservations to skip already-booked slots. Uses 4-step course/time fallback (preferred→other→preferred+1hr→other+1hr). Verifies each booking on Reservations page after checkout. Handles BLOCKED error short-circuiting.
- **site.js** — `SiteAutomation` class. Playwright (Chromium) browser automation against the TeeItUp/Kenna Golf platform. Handles login (GolfID OAuth iframe), course/date selection (`selectCourse(courseName)` accepts 'Pines' or 'Oaks'), tee time discovery via "Book Now" buttons, 4-golfer selection, add-to-cart, checkout, cart cleanup, reservation checking (`getExistingReservations(date)`), and post-checkout verification (`verifyBookingOnSite(date, time)`). Uses JavaScript `el.click()` (not Playwright `.click()`) to bypass MUI backdrop overlays. Dismisses modals/popovers before interactions.
- **scheduler.js** — Pure computation. `computeBookingSlots()` generates all needed tee time slots for the next N days based on the recurring schedule in config. `groupByDateAndTime()` groups pending DB rows for batch processing. Each consecutive slot is offset by 10 minutes (e.g., 12:00, 12:10, 12:20).
- **db.js** — sql.js (pure-JS SQLite, no native build). Async API. Auto-persists to `./data/bookings.db` after mutations. Single `bookings` table with `UNIQUE(date, target_time, slot_index)` to prevent double-booking.
- **config.js** — Loads `.env`. Defines recurring schedule (Mon/Tue/Fri/Sat), site URLs, course IDs (Pines=9437, Oaks=9438), credentials, and tuning params.
- **web.js** — Express server. `GET /` serves server-rendered HTML calendar (current + next month) with color-coded booking chips. `GET /api/bookings` returns JSON.
- **notify.js** — Console/log-based alerts for booking outcomes (success, failure, partial, blocked).

### Booking schedule (defined in schedule.json, loaded by config.js)

| Day       | Window       | Players | Slots | Preferred Course |
|-----------|-------------|---------|-------|-----------------|
| Monday    | 12:00-13:00 | 12      | 3     | Pines            |
| Tuesday   | 12:00-13:00 | 8       | 2     | Pines            |
| Friday    | 12:00-13:00 | 12      | 3     | Pines            |
| Saturday  | 09:00-10:00 | 12      | 3     | Pines            |

Each slot = 4 players. Consecutive tee times spaced ~10 min apart. Falls back to other course and +1hr window if preferred is unavailable.

### Key site automation details (site.js)

- **Target platform**: `https://fort-walton-member.book.teeitup.golf` (Next.js React SPA with MUI)
- **Login**: Clicks "Login" button → finds GolfID iframe → fills email/password → submits → dismisses email verification prompt via `[aria-label="Close"]` → dismisses MUI backdrop
- **Tee time discovery**: Finds all `button:has-text("Book Now")`, walks up parent DOM (max 3 levels, text < 300 chars) to extract time via regex
- **MUI overlay workaround**: `_dismissModals()` clicks backdrops, presses Escape; all clicks use `el.evaluate(el => el.click())` to bypass `MuiBackdrop-root` pointer interception
- **Consecutive slot matching**: `findConsecutiveSlots()` searches ±fallbackMinutes (default 30) for N slots with 5-15 min gaps
- **Course selection**: `selectCourse(courseName)` takes 'Pines' or 'Oaks' — dynamically selects the requested course via dropdown or filter buttons
- **Pre-booking reservation check**: `getExistingReservations(date)` navigates to `/reservations` page, extracts existing bookings for the target date (time, course, players). Slots matching existing reservations (±15 min) are marked confirmed and skipped.
- **4-step course/time fallback** (in booking.js `_processGroup`): 1) Preferred course at original window → 2) Other course at original window → 3) Preferred course +1hr → 4) Other course +1hr. Each step tries consecutive slots first, then individual. Booked slots are filtered between steps.
- **Booking flow**: Book Now → select 4 golfers → ADD TO CART → complete checkout → verify on Reservations page
- **Post-checkout verification**: `verifyBookingOnSite(date, time)` checks the Reservations page after each checkout. If the booking is not found, it's marked failed instead of confirmed.
- **Cart cleanup**: `clearCart()` removes stale cart items after login to avoid "cart limit" errors
- Use `waitUntil: 'domcontentloaded'` (not `networkidle`) — the SPA keeps long-polling connections

### Database

SQLite via sql.js. Schema in `db.js`. Status values: `pending`, `confirmed`, `failed`, `partial`, `skipped`. Max 3 retry attempts per slot.

### Data persistence

- Database: `./data/bookings.db`
- Screenshots: `./screenshots/` (PNG captures at each booking step)
- Logs: `./golf-scheduler.log` (Winston, 5MB rotation, 3 files)

## Environment variables (.env)

```
GOLF_EMAIL, GOLF_PASSWORD     # Required - GolfID credentials
TIMEZONE                      # Default: America/Chicago
BOOKING_HORIZON_DAYS           # Default: 30
FALLBACK_MINUTES               # Default: 30 (max deviation from target time)
DB_PATH                        # Default: ./data/bookings.db
SCREENSHOT_DIR                 # Default: ./screenshots
LOG_LEVEL                      # Default: info
```

## Platform notes

- Runs on Windows (primary). Use Unix shell syntax in Git Bash.
- sql.js chosen over better-sqlite3 to avoid native build issues on Windows/Node 24.
- Playwright requires `npx playwright install chromium` after `npm install`.
- Currently runs non-headless (`headless: false`) for debugging visibility.
