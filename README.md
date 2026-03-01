# Golf Scheduler

Automated tee time booking bot for [Fort Walton Beach Golf](https://www.fwbgolf.com/) (TeeItUp platform).

Keeps the schedule filled for the next 30 days with configurable recurring bookings:

| Day       | Time Window  | Players | Tee Times |
|-----------|-------------|---------|-----------|
| Monday    | 12:00–1:00 PM | 12      | 3 consecutive |
| Tuesday   | 12:00–1:00 PM | 8       | 2 consecutive |
| Friday    | 12:00–1:00 PM | 12      | 3 consecutive |
| Saturday  | 9:00–10:00 AM | 12      | 3 consecutive |

Time windows are configurable in `src/config.js` — the bot finds the earliest available consecutive slots within each window.

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

### 4. Run

```bash
# Dry run — see what would be booked (no actual bookings)
npm run dry-run

# Book all pending tee times (single run)
npm run book

# Check booking status
npm run status

# Run continuously (every 6 hours)
npm run scheduler

# Initialize database without booking
npm run init

# Calendar web view
npm run web
```

### Web Calendar View

Run `npm run web` to start a local web server at http://localhost:3000 showing a calendar with all booked tee times, color-coded by status (confirmed, pending, failed). Each slot displays the booked time and course name (Pines/Oaks).

---

## Scheduling (Automated Runs)

### Windows Task Scheduler

1. Open **Task Scheduler** (search "Task Scheduler" in Start menu)
2. Click **Create Basic Task**
3. Name: `Golf Scheduler`
4. Trigger: **Daily**, start at `6:00 AM`
5. Action: **Start a program**
   - Program: `C:\Program Files\nodejs\node.exe`
   - Arguments: `src/index.js book`
   - Start in: `C:\Users\Bruce\source\repos\GolfScheduler`
6. Finish

To run twice daily, edit the trigger and add a second schedule at `6:00 PM`.

**Alternative — PowerShell one-liner to create the task:**

```powershell
$action = New-ScheduledTaskAction -Execute "node" -Argument "src/index.js book" -WorkingDirectory "C:\Users\Bruce\source\repos\GolfScheduler"
$trigger = New-ScheduledTaskTrigger -Daily -At 6:00AM
Register-ScheduledTask -TaskName "GolfScheduler" -Action $action -Trigger $trigger -Description "Auto-book golf tee times"
```

### Mac/Linux (cron)

```bash
# Run daily at 6 AM Central
0 6 * * * cd /path/to/GolfScheduler && /usr/bin/node src/index.js book >> /tmp/golf-scheduler.log 2>&1
```

### Docker

```bash
docker-compose up -d
```

The container runs the scheduler loop (every 6 hours) automatically.

---

## Project Structure

```
GolfScheduler/
├── src/
│   ├── index.js       # CLI entry point (commander)
│   ├── config.js      # Environment config loader
│   ├── db.js          # SQLite state tracking
│   ├── scheduler.js   # Date/slot computation
│   ├── booking.js     # Booking orchestrator (retry logic)
│   ├── site.js        # Playwright browser automation
│   ├── web.js         # Express calendar web view
│   ├── notify.js      # Alert/notification module
│   └── logger.js      # Winston logging
├── screenshots/       # Booking confirmation screenshots
├── data/              # SQLite database (auto-created)
├── .env.example       # Template for credentials
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```

---

## How to Test

### 1. Dry run (safest)

```bash
npm run dry-run
```

Shows all dates/times that would be booked without touching the site.

### 2. Init + Status

```bash
npm run init
npm run status
```

Creates the database with all upcoming slots and shows the schedule.

### 3. Single booking test

Edit `.env` to reduce `BOOKING_HORIZON_DAYS=1`, then:

```bash
npm run book
```

Watch the console output. Check `screenshots/` for captured pages.

### 4. Verify in browser

After a booking run, log into https://fort-walton-member.book.teeitup.golf manually and verify your tee times appear.

---

## What to Change If the UI Changes

The TeeItUp booking platform (Kenna Golf) may update its UI. Here's where to adjust:

### Login form changed?

Edit `src/site.js` → `login()` method:
- Update `emailSelectors` array with new input field selectors
- Update `passwordSelectors` array
- Update `submitSelectors` array
- Check `_findLoginFrame()` if login moves into/out of an iframe

### Course selector changed?

Edit `src/site.js` → `selectCourse()` method:
- Update `courseSelectors` for dropdown-style selectors
- Update the tab/button selectors for tab-style UI

### Tee time display changed?

Edit `src/site.js` → `getAvailableTeeTimes()` method:
- Update `teeTimeSelectors` array with new CSS classes
- Check `_extractTime()` if time format changes

### Booking button changed?

Edit `src/site.js` → `bookSlot()` method:
- Update `bookSelectors` array
- Update `_handleCheckout()` selectors if checkout flow changes

### Course IDs changed?

Edit `src/config.js` → `site.courses`:
- Update Pines and Oaks IDs

### API base URL changed?

Edit `src/config.js` → `site.apiBase` and `site.memberUrl`

### Player count control changed?

Edit `src/site.js` → `_setPlayerCount()` method

---

## Safety

- Credentials are **never hardcoded** — always loaded from `.env`
- CAPTCHA and security blocks are **detected, not bypassed** — the bot stops and alerts
- Double-bookings are **prevented by SQLite** (unique constraint on date + time + slot)
- Retry limit is **3 attempts** per slot (configurable in config.js)

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `GOLF_EMAIL and GOLF_PASSWORD required` | Copy `.env.example` to `.env` and fill in credentials |
| Login fails | Check credentials; site may have changed login flow — see "What to Change" |
| No tee times found | Check screenshots in `./screenshots/`; the date may not have slots open yet |
| `sql.js` issues | Uses pure-JS SQLite — no native build needed |
| Playwright browser missing | Run `npx playwright install chromium` |
| BLOCKED alert | Stop the bot, check the site manually, do not retry automatically |
