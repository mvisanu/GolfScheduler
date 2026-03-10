# Golf Scheduler

Automated tee time booking bot for [Fort Walton Beach Golf](https://www.fwbgolf.com/) (TeeItUp platform).

Keeps the schedule filled for the next 30 days with configurable recurring bookings. Syncs with the FWB site daily to keep the database accurate, then books any pending slots.

---

## Features

- **Golfer rotation** — supports up to 3 GolfID accounts (`GOLF_EMAIL`, `GOLF_EMAIL2`, `GOLF_EMAIL3`); alternates which account books each day round-robin so no single account bears the full load
- **Configurable schedule** via `schedule.json` — set day, time window, players, slots, and preferred course; use `"alternating"` to rotate Pines/Oaks each week
- **Daily sync engine** — scrapes the FWB site reservation history and auto-corrects any mismatches (wrong times, confirmation numbers) in the database
- **Existing reservation check** — pre-checks the site before booking to skip already-booked slots and prevent double-booking
- **Strict 4-player enforcement** — skips any tee time that doesn't have 4 open spots rather than booking with fewer golfers
- **10-attempt course/time fallback** — 5 time offsets (0, ±1hr, ±2hr) on preferred course, then 5 on the other
- **Two-pass slot strategy** — consecutive slots first, then individual fallback
- **Calendar web view** at `http://localhost:3009` — shows confirmed bookings (slot_index ≥ 1); click any chip to see date, time, course, player count, **which golfer account booked it** (full email shown), and confirmation number
- **External access** — share the schedule with your golf group via a public URL (DuckDNS + optional HTTPS)
- **Admin page** at `/admin` (localhost only) — full access log with visitor IP, country, browser, device, ISP
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

Edit `.env` and set your GolfID credentials. You can add up to three accounts for golfer rotation:

```
GOLF_EMAIL=primary@example.com
GOLF_PASSWORD=secret1
GOLF_EMAIL2=second@example.com
GOLF_PASSWORD2=secret2
GOLF_EMAIL3=third@example.com
GOLF_PASSWORD3=secret3
```

Each unique booking date is assigned to one account round-robin (all slots for the same date use the same account). Only `GOLF_EMAIL` / `GOLF_PASSWORD` are required; add the others to enable rotation.

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
- **course** — preferred course: `"Pines"`, `"Oaks"`, or `"alternating"` (rotates Pines/Oaks each week by ISO week parity; falls back to the other course if unavailable)

### 5. Run

```bash
# Dry run — see what would be booked (no actual bookings)
npm run dry-run

# Sync DB with FWB site (corrects times, confirmation numbers)
npm run sync

# Book all pending tee times (single run)
npm run book

# Check booking status in terminal
npm run status

# Calendar web view (http://localhost:3009)
npm run web

# Initialize database without booking
npm run init

# Run daily scheduler (syncs then books at 06:00 every day)
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

Opens a calendar view at **http://localhost:3009** showing:
- Current and next month calendars
- Confirmed bookings as green chips (only confirmed entries are shown)
- **Last synced** timestamp in the header
- Mobile-responsive: collapses to a card list on small screens
- Click any chip to open a detail modal with date, time, course, **player count**, **which golfer account booked it**, status, and confirmation number
- API endpoint at `GET /api/bookings` returns `{ bookings, lastSyncAt }`

**Admin controls** (localhost only — hidden for external visitors):
- **Schedule Month** / **Book Now** buttons to trigger the booking engine
- **Cancel** button in booking detail modals
- `/admin` page with full visitor access log (IP, country, browser, device, ISP)

---

## Daily Sync

```bash
npm run sync
```

The sync engine keeps the database accurate when the FWB site is the source of truth:

1. **Step 1** — Scrapes the reservation history page (visible within ~7 days)
2. **Step 2** — Probes by ID around known confirmation numbers for dates beyond the 7-day window
3. **Reconcile** — Pairs site reservations to DB rows positionally; updates `actual_time`, `confirmation_number`, and `course` for any mismatches
4. Logs all changes with `[SYNC]` prefix; warns for confirmed bookings not found on site

Run automatically every day at 06:00 when using `npm run scheduler`.

---

## Daily Scheduler

```bash
npm run scheduler
```

Runs automatically at **06:00 local time** every day (configurable via `SCHEDULER_HOUR`):

1. Opens one shared browser session (headless)
2. Runs `npm run sync` to correct the database from the site
3. Runs `npm run book` to fill any pending slots
4. Closes the session

If started after 06:00, it runs immediately and then schedules the next fire for 06:00 tomorrow.

Set `HEADLESS=true` in `.env` for automated/background runs (no visible browser window).

---

## External Access (Share with Golf Group)

To let your golf group view the schedule from their phones:

1. **DuckDNS** — create a free subdomain at [duckdns.org](https://www.duckdns.org)
2. **Port forwarding** — forward TCP port `3002` on your router to your machine's local IP
3. Share the URL: `http://your-name.duckdns.org:3002`

External visitors see the read-only calendar — no admin buttons or cancel controls.

### Optional: HTTPS

Generate a self-signed certificate:

```bash
mkdir -p data/certs
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -keyout data/certs/key.pem -out data/certs/cert.pem -days 365 -nodes -subj "/CN=your-name.duckdns.org"
```

Then enable it in `.env`:

```
HTTPS_ENABLED=true
```

Visitors will see a one-time browser security warning (self-signed cert). Click **Advanced → Proceed** to continue.

For a fully trusted cert (no browser warning), run `node get-cert.js` which uses Let's Encrypt via DuckDNS DNS challenge (requires `DUCKDNS_TOKEN` and `DUCKDNS_DOMAIN` in `.env`).

---

## Booking Strategy

### 10-attempt course and time fallback

For each scheduled day, the bot tries up to 10 combinations in order:

| Attempt | Course | Time Offset |
|---------|--------|-------------|
| 1–5 | Preferred (from schedule) | 0, −1hr, +1hr, −2hr, +2hr |
| 6–10 | Other course | 0, −1hr, +1hr, −2hr, +2hr |

Once a slot is booked on a course, the engine locks to that course for all remaining slots on that day.

### Per-slot checkout

Each tee time is checked out individually:
- Click **Book Now** on the tee time
- Select **4 golfers**
- Click **Add to Cart**
- Check **I agree to Terms and Conditions**
- Click **Complete Your Purchase**

---

## Project Structure

```
GolfScheduler/
├── schedule.json         # Configurable booking schedule
├── fix-confirmations.js  # Fetch real confirmation numbers for all 3 golfer accounts
├── reset-failed.js       # Reset over-retried failed slots back to pending
├── delete-slot0.js       # One-time cleanup — remove slot_index=0 rows from DB
├── get-cert.js           # Let's Encrypt cert via DuckDNS DNS challenge
├── src/
│   ├── index.js          # CLI entry point (commander)
│   ├── config.js         # Environment + schedule config loader
│   ├── db.js             # SQLite state tracking (sql.js)
│   ├── scheduler.js      # Date/slot computation
│   ├── booking.js        # Booking orchestrator (10-attempt fallback)
│   ├── site.js           # Playwright browser automation
│   ├── sync.js           # DB/site sync engine
│   ├── reconcile.js      # Per-date reconciliation logic
│   ├── web.js            # Express calendar web view (port 3009)
│   ├── notify.js         # Alert/notification module
│   └── logger.js         # Winston logging
├── data/
│   ├── bookings.db       # SQLite database (auto-created)
│   ├── sync-meta.json    # Last sync timestamp
│   ├── access-log.json   # Visitor access log (persisted)
│   └── certs/            # TLS certificates (optional)
├── screenshots/          # Booking confirmation screenshots
├── .env.example          # Template for credentials
└── package.json
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GOLF_EMAIL` | required | Primary GolfID login email |
| `GOLF_PASSWORD` | required | Primary GolfID login password |
| `GOLF_EMAIL2` | — | Second GolfID email (golfer rotation) |
| `GOLF_PASSWORD2` | — | Second GolfID password |
| `GOLF_EMAIL3` | — | Third GolfID email (golfer rotation) |
| `GOLF_PASSWORD3` | — | Third GolfID password |
| `TIMEZONE` | `America/Chicago` | Local timezone for scheduling |
| `BOOKING_HORIZON_DAYS` | `30` | How many days ahead to book |
| `FALLBACK_MINUTES` | `30` | Max deviation from target tee time |
| `SCHEDULER_HOUR` | `6` | Hour (0–23) for the daily scheduler fire |
| `HEADLESS` | `false` | Set `true` for automated/daemon runs |
| `HTTPS_ENABLED` | `false` | Set `true` to serve HTTPS using `data/certs/` |
| `DUCKDNS_TOKEN` | — | DuckDNS API token (for `get-cert.js`) |
| `DUCKDNS_DOMAIN` | — | DuckDNS subdomain name (without `.duckdns.org`) |
| `LOG_LEVEL` | `info` | Winston log level |
| `DB_PATH` | `./data/bookings.db` | SQLite database path |
| `SCREENSHOT_DIR` | `./screenshots` | Screenshot output directory |

---

## What to Change If the UI Changes

| What changed | Where to fix |
|-------------|-------------|
| Login form | `src/site.js` → `login()` |
| Course selector | `src/site.js` → `selectCourse()` |
| Tee time display | `src/site.js` → `getAvailableTeeTimes()` |
| Golfer count buttons | `src/site.js` → `bookSlot()` (looks for 1/2/3/4 radio buttons) |
| Booking modal | `src/site.js` → `bookSlot()` |
| Checkout flow | `src/site.js` → `completeCheckout()` |
| Reservations page | `src/site.js` → `getExistingReservations()` |
| Course IDs | `src/config.js` → `site.courses` |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `GOLF_EMAIL and GOLF_PASSWORD required` | Copy `.env.example` to `.env` and fill in credentials |
| Login fails | Check credentials; see site.js login() for selector updates |
| No tee times found | Check `./screenshots/`; date may not have slots open yet |
| Playwright browser missing | Run `npx playwright install chromium` |
| BLOCKED alert | Stop the bot, check the site manually, do not retry automatically |
| Golfer login rejected | Verify `GOLF_EMAIL2`/`GOLF_PASSWORD2` credentials — account must be registered on teeitup.golf |
| Only 1–3 spots available | Bot skips those tee times (strict 4-player enforcement); try another time or run `npm run book` again later |
| Sync finds nothing beyond 7 days | Site only shows upcoming reservations within ~7 days |
| HTTPS cert warning | Self-signed cert — click Advanced → Proceed once per browser |
| `get-cert.js` fails with SERVFAIL | DuckDNS nameservers are flaky — try again later |
| External URL not reachable | Check router port forwarding points to correct local IP:3009 |
