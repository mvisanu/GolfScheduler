# Golf Scheduler

Automated tee time booking bot for [Fort Walton Beach Golf](https://www.fwbgolf.com/) (TeeItUp platform).

Keeps the schedule filled for the next 30 days with configurable recurring bookings. Tries the preferred course first, then falls back to the other course. If consecutive slots aren't available, books any individual slots in the time window to maximize golfers booked.

---

## Features

- **Configurable schedule** via `schedule.json` — set day, time window, players, slots, and preferred course
- **Existing reservation check** — checks the site's Reservations page before booking; skips slots already booked (prevents double-booking across runs or manual bookings)
- **4-step course/time fallback:** Preferred course → Other course → Preferred +1hr → Other +1hr
- **Two-pass slot strategy:** consecutive slots first, then individual fallback
- **Individual checkout per slot:** Book Now → 4 golfers → Add to Cart → Agree to Terms → Complete Your Purchase
- **Cart cleanup** — clears stale cart items after login to avoid "cart limit" errors
- **Calendar web view** at http://localhost:3000 with color-coded booking status
- **SQLite state tracking** prevents double-bookings (unique constraint on date + time + slot)
- **Screenshot capture** at every booking step for verification
- **Retry logic** — failed slots retry up to 3 times across runs

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
    "windowStart": "09:00",
    "windowEnd": "10:00",
    "players": 12,
    "slots": 3,
    "course": "Oaks"
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

# Calendar web view (http://localhost:3000)
npm run web

# Initialize database without booking
npm run init

# Run continuously (every 6 hours)
npm run scheduler
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

Opens a calendar view at **http://localhost:3000** showing:
- Current and next month calendars
- Each booked tee time with course name (Pines/Oaks)
- Color-coded status: green (confirmed), amber (pending), red (failed)
- Detail table below with all booking information
- API endpoint at `GET /api/bookings` for JSON data

---

## Booking Strategy

### Pre-booking check

Before booking, the bot navigates to the site's **Reservations** page and checks for existing tee times on the target date. Any slot that matches an existing reservation (within ±15 minutes) is marked as `confirmed` and skipped. This prevents double-booking when the bot runs multiple times or when tee times were booked manually.

### 4-step course and time fallback

For each scheduled day, the bot tries up to 4 combinations in order:

| Step | Course | Time Window |
|------|--------|-------------|
| 1 | Preferred (from schedule) | Original window |
| 2 | Other course | Original window |
| 3 | Preferred | +1 hour |
| 4 | Other course | +1 hour |

At each step, the bot first looks for **consecutive** tee times (ideal for group play). If not enough consecutive slots exist, it falls back to **individual** slots within the window.

Once all needed slots are booked, remaining steps are skipped. If some slots are booked but not all, only the remaining slots carry forward to the next step.

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
│   ├── booking.js        # Booking orchestrator (4-step fallback)
│   ├── site.js           # Playwright browser automation
│   ├── web.js            # Express calendar web view
│   ├── notify.js         # Alert/notification module
│   └── logger.js         # Winston logging
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
