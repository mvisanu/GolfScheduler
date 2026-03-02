# Golf Scheduler

Automated tee time booking bot for [Fort Walton Beach Golf](https://www.fwbgolf.com/) (TeeItUp platform).

Keeps the schedule filled for the next 30 days with configurable recurring bookings. Tries the preferred course first, then falls back to the other course. If consecutive slots aren't available, books any individual slots in the time window to maximize golfers booked.

---

## Features

- **Configurable schedule** via `schedule.json` — set day, time window, players, slots, and preferred course
- **Existing reservation check** — checks the site's Reservations page before booking; paginates through all pages, clicks VIEW DETAILS per card, and skips slots already booked (prevents double-booking across runs or manual bookings)
- **10-attempt course/time fallback:** 5 time offsets (0, ±1hr, ±2hr) on preferred course, then 5 on the other — locks to the first course that gets a booking
- **Two-pass slot strategy:** consecutive slots first, then individual fallback
- **Individual checkout per slot:** Book Now → 4 golfers → Add to Cart → Agree to Terms → Complete Your Purchase
- **Cart cleanup** — clears stale cart items after login to avoid "cart limit" errors
- **Calendar web view** at http://localhost:3002 with color-coded booking status, zoom widget, and one-click booking buttons
- **SQLite state tracking** prevents double-bookings (unique constraint on date + time + slot)
- **Screenshot capture** at every booking step for verification
- **Retry logic** — failed slots retry up to 3 times across runs
- **Cancel command** — cancels reservations on the site and marks them in the database

---

## Quick Start (Windows)

### 1. Install prerequisites

- [Node.js 18+](https://nodejs.org/) (LTS recommended)
- Git (optional)

### 2. Setup

```bash
cd GolfScheduler
npm install
npx playwright install chromium
```

### 3. Configure credentials

```bash
cp .env.example .env
```

Edit `.env` and set your `GOLF_EMAIL` and `GOLF_PASSWORD`.

### 4. Configure schedule

Edit `schedule.json` in the project root:

```json
[
  {
    "day": "Monday",
    "windowStart": "12:00",
    "windowEnd": "13:00",
    "players": 12,
    "slots": 3,
    "course": "Pines"
  },
  {
    "day": "Saturday",
    "windowStart": "08:00",
    "windowEnd": "13:00",
    "players": 12,
    "slots": 3,
    "course": "Pines"
  }
]
```

Each entry:
- **day** — day of week (Monday, Tuesday, ..., Saturday, Sunday)
- **windowStart / windowEnd** — acceptable time range in 24h format
- **players** — total golfers needed
- **slots** — number of tee times (each holds 4 golfers)
- **course** — preferred course: `"Pines"` or `"Oaks"` (falls back to the other if unavailable)

### 5. Run

```bash
# Dry run — see what would be booked (no actual bookings)
npm run dry-run

# Book all pending tee times (single run)
npm run book

# Check booking status in terminal
npm run status

# Calendar web view (http://localhost:3002)
npm run web

# Initialize database without booking
npm run init

# Run continuously (every 6 hours)
npm run scheduler

# Cancel all reservations for a date
npm run cancel -- 2026-03-15
```

---

## Viewing Your Schedule

### Terminal

```bash
npm run status
```

Shows a table of all upcoming bookings with date, day, time, slot, course, status, confirmation number, and attempt count.

### Web Calendar

```bash
npm run web
```

Opens a calendar view at **http://localhost:3002** showing:
- Current and next month calendars
- Each booked tee time as a color-coded chip (green = confirmed, amber = pending, red = failed)
- **Schedule Month** button (current month) and **Book Now** button (next month) — trigger the booking engine in the background
- Click any chip or table row to open a detail modal with cancel option
- **Floating zoom widget** (bottom-right) — A−/A+ buttons or Ctrl+=/−/0, persists across sessions
- Detail table below with all booking information
- API endpoint at `GET /api/bookings` for JSON data

---

## Booking Strategy

### Pre-booking check

Before booking, the bot navigates to the site's **Reservations** page and checks for existing tee times on the target date. It paginates through all pages (up to 20), and for each page that shows the target date, clicks VIEW DETAILS one card at a time (each navigates to a detail page in the SPA), extracts the reservation details, then goes back to the list.

Any slot that matches an existing reservation is marked as `confirmed` and skipped. Match logic: slots with a booking window (all current schedules) match within `window ±2hr`; fixed-time slots match within `±15 min`. This prevents double-booking when the bot runs multiple times or when tee times were booked manually.

> **Site limitation:** The Upcoming Reservations section only shows reservations within approximately 7 days of today. Dates further out cannot be pre-checked.

### 10-attempt course and time fallback

For each scheduled day, the bot tries up to 10 combinations in order — 5 time offsets on the preferred course, then 5 on the other:

| Attempt | Course | Time Offset |
|---------|--------|-------------|
| 1–5 | Preferred (from schedule) | 0, −1hr, +1hr, −2hr, +2hr |
| 6–10 | Other course | 0, −1hr, +1hr, −2hr, +2hr |

At each attempt, the bot first looks for **consecutive** tee times (ideal for group play). If not enough consecutive slots exist, it falls back to **individual** slots within the window.

Once a slot is booked on a course, the engine **locks to that course** for all remaining slots on that day (no splitting across Pines/Oaks). Remaining attempts are skipped once all slots are filled.

### Per-slot checkout

Each tee time is checked out individually:
- Click **Book Now** on the tee time
- Select **4 golfers**
- Click **Add to Cart**
- Check **I agree to Terms and Conditions**
- Click **Complete Your Purchase**
- Navigate back and book the next slot

---

## Scheduling (Automated Runs)

### Windows Task Scheduler (recommended: twice weekly)

Run this in PowerShell as administrator:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\Bruce\source\repos\GolfScheduler\setup-scheduler.ps1
```

This creates a task that runs every **Monday and Thursday at 6:00 AM** to keep the next 30 days booked.

**Manual setup:**

1. Open **Task Scheduler** (search "Task Scheduler" in Start menu)
2. Click **Create Basic Task**
3. Name: `Golf Scheduler`
4. Trigger: **Weekly**, Monday and Thursday at `6:00 AM`
5. Action: **Start a program**
   - Program: `C:\Program Files\nodejs\node.exe`
   - Arguments: `src/index.js book`
   - Start in: `C:\Users\Bruce\source\repos\GolfScheduler`
6. Finish

### Mac/Linux (cron)

```bash
# Run Monday and Thursday at 6 AM Central
0 6 * * 1,4 cd /path/to/GolfScheduler && /usr/bin/node src/index.js book >> /tmp/golf-scheduler.log 2>&1
```

### Docker

```bash
docker-compose up -d
```

---

## Project Structure

```
GolfScheduler/
├── schedule.json         # Configurable booking schedule
├── src/
│   ├── index.js          # CLI entry point (commander)
│   ├── config.js         # Environment + schedule config loader
│   ├── db.js             # SQLite state tracking (sql.js)
│   ├── scheduler.js      # Date/slot computation
│   ├── booking.js        # Booking orchestrator (10-attempt fallback)
│   ├── site.js           # Playwright browser automation
│   ├── web.js            # Express calendar web view (port 3002)
│   ├── notify.js         # Alert/notification module
│   └── logger.js         # Winston logging
├── fix-confirmations.js  # Utility: backfill real confirmation numbers from site
├── setup-scheduler.ps1   # Windows Task Scheduler setup script
├── screenshots/          # Booking confirmation screenshots
├── data/                 # SQLite database (auto-created)
├── .env.example          # Template for credentials
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## What to Change If the UI Changes

The TeeItUp booking platform (Kenna Golf) may update its UI. Here's where to adjust:

| What changed | Where to fix |
|-------------|-------------|
| Login form | `src/site.js` → `login()` — update email/password/submit selectors |
| Login iframe | `src/site.js` → `_findLoginFrame()` |
| Course selector | `src/site.js` → `selectCourse()` |
| Tee time display | `src/site.js` → `getAvailableTeeTimes()` and `_extractTime()` |
| Booking modal | `src/site.js` → `bookSlot()` and `_setPlayerCount()` |
| Checkout flow | `src/site.js` → `completeCheckout()` — terms checkbox and purchase button |
| Reservations page | `src/site.js` → `getExistingReservations()` — card selectors, VIEW DETAILS, pagination |
| Course IDs | `src/config.js` → `site.courses` |
| Site URLs | `src/config.js` → `site.memberUrl` and `site.apiBase` |

---

## Safety

- Credentials are **never hardcoded** — always loaded from `.env`
- CAPTCHA and security blocks are **detected, not bypassed** — the bot stops and alerts
- Double-bookings are **prevented** by SQLite unique constraints AND pre-booking reservation check
- Retry limit is **3 attempts** per slot (configurable in config.js)

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `GOLF_EMAIL and GOLF_PASSWORD required` | Copy `.env.example` to `.env` and fill in credentials |
| `schedule.json not found` | Create `schedule.json` in the project root (see Configure schedule above) |
| Login fails | Check credentials; site may have changed login flow — see table above |
| No tee times found | Check screenshots in `./screenshots/`; the date may not have slots open yet |
| `sql.js` issues | Uses pure-JS SQLite — no native build needed |
| Playwright browser missing | Run `npx playwright install chromium` |
| BLOCKED alert | Stop the bot, check the site manually, do not retry automatically |
| Reservation check finds nothing | Site only shows upcoming reservations within ~7 days; dates further out cannot be pre-checked |
