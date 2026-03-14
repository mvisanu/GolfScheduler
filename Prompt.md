# Original Requirements (booking.md — superseded by the detailed prompt below)

You are a senior automation engineer. Build a reliable program that automatically books golf tee times from a club website.

Before writing any code, first create a short implementation plan that includes:
1. assumptions
2. booking workflow
3. data/config needed
4. failure cases
5. retry strategy
6. how you will prevent duplicate bookings

Then execute the build.

## Goal

Build a tee time booking bot that can log into the golf booking website, search for target tee times, and reserve them automatically. The bot must support recurring booking rules and keep future dates booked based on the configured schedule.

## Critical Booking Rules

For **every tee time slot booked**, the bot must book for **4 people**. This is mandatory.

- 1 tee time = 4 players / 2 tee times = 8 players / 3 tee times = 12 players / 4 tee times = 16 players

The program must never book a slot for fewer than 4 players unless explicitly changed in configuration.

The golf course website only allows booking **up to 3 tee time slots in one booking flow / one transaction**. If `slots > 3`, split into batches of at most 3 slots each.

## Required Schedule Format (`schedule.json`)

Mon 12:00–13:00 12 players 3 slots Pines / Tue 12:00–13:00 8 players 2 slots Pines / Fri 12:00–13:00 12 players 3 slots Pines / Sat 08:00–13:00 12 players 3 slots Pines / Sun 08:00–10:00 16 players 4 slots alternating

---

# Claude Code Prompt - Golf Tee Time Booking Scheduler

You are a senior Node.js automation engineer building a production-ready automated tee time booking system for a golf club membership platform.

## MANDATORY: OUTPUT A PLAN FIRST

Before writing any code, output:
1. A phased implementation plan with a checklist
2. Full module dependency map
3. Database schema with all fields and status values
4. All edge cases and failure modes to handle
5. Fallback strategy for unavailable tee times

Then proceed step-by-step in the defined implementation order.
Do NOT skip steps. Do NOT leave TODOs in any core flow.

## PROJECT OVERVIEW

Build a Node.js CLI plus web dashboard that automatically books recurring golf tee times on the TeeItUp/Kenna Golf platform at https://fort-walton-member.book.teeitup.golf using Playwright browser automation. The system runs on a schedule, handles failures with 10-attempt fallback logic, and exposes a web calendar UI at port 3009.

## TECH STACK

- Node.js raw execution, no build step, no tests, no linter
- Playwright Chromium for browser automation
- sql.js pure-JS SQLite, avoids native build issues on Windows and Node 24
- Commander.js for CLI
- Express for web UI on port 3009
- Winston for logging with 5MB rotation and 3 files
- node-cron or setInterval running every 6 hours

Platform is Windows primary using Git Bash. Run headless false for debugging visibility.
Always use waitUntil domcontentloaded, NEVER networkidle - the SPA keeps long-polling connections open.

## PROJECT STRUCTURE

index.js             Commander CLI entry point
booking.js           BookingEngine class
site.js              SiteAutomation class using Playwright
scheduler.js         Pure computation for slot generation only
db.js                sql.js SQLite wrapper
config.js            dotenv loader and all constants
web.js               Express calendar UI server
notify.js            Winston-based outcome alerts
schedule.json        Recurring schedule definition
fix-confirmations.js One-off utility to backfill real confirmation numbers
data/bookings.db     Auto-created SQLite database file
screenshots/         PNG captures at each booking step
golf-scheduler.log   Winston rotating log file
.env                 Credentials and config values

## CLI COMMANDS

All implemented via Commander.js in index.js:

npm run book               Run booking engine once
npm run dry-run            Show what would be booked without making any bookings
npm run status             Print table of all upcoming bookings
npm run init               Populate DB with computed slots without booking
npm run scheduler          Run booking engine continuously every 6 hours
npm run web                Start web calendar at http://localhost:3009
npm run cancel -- DATE     Cancel all reservations for a date, accepts YYYY-MM-DD, MM/DD, or MM-DD

## BOOKING SCHEDULE (schedule.json)

Monday    window 12:00-13:00  12 players  3 slots  preferredCourse Pines
Tuesday   window 12:00-13:00   8 players  2 slots  preferredCourse Pines
Friday    window 12:00-13:00  12 players  3 slots  preferredCourse Pines
Saturday  window 08:00-13:00  12 players  3 slots  preferredCourse Pines

Each slot holds 4 players. Consecutive tee times are spaced 10 minutes apart.
Example: 12:00, 12:10, 12:20 for a 3-slot Monday booking.
Falls back to the other course and time offsets of +/-1hr and +/-2hr when preferred is unavailable.

## DATABASE (db.js)

Use sql.js SQLite. Auto-persist the database to ./data/bookings.db after every mutation.

Table bookings with columns:
  id INTEGER PRIMARY KEY AUTOINCREMENT
  date TEXT NOT NULL
  target_time TEXT NOT NULL
  slot_index INTEGER NOT NULL
  course TEXT
  status TEXT DEFAULT pending
  confirmation_number TEXT
  attempts INTEGER DEFAULT 0
  booked_time TEXT
  error_message TEXT
  created_at TEXT DEFAULT datetime now
  updated_at TEXT DEFAULT datetime now
  UNIQUE constraint on date, target_time, slot_index combined

Status values are: pending, confirmed, failed, partial, skipped, cancelled
Maximum 3 retry attempts per slot. Do not attempt beyond this.

Required methods:
  ensureBookings(slots) - insert or ignore based on unique constraint
  getPendingBookings() - return pending and failed slots under max attempts
  markSuccess(id, confirmationNumber, bookedTime)
  markFailed(id, errorMessage)
  markCancelled(id)
  getBookingById(id)
  getAllUpcoming() - used by status command and web UI

## config.js

Load .env via dotenv and export:
  email from GOLF_EMAIL
  password from GOLF_PASSWORD
  timezone defaulting to America/Chicago
  bookingHorizonDays defaulting to 30
  fallbackMinutes defaulting to 30
  dbPath defaulting to ./data/bookings.db
  screenshotDir defaulting to ./screenshots
  logLevel defaulting to info
  siteUrl as https://fort-walton-member.book.teeitup.golf
  courses object with Pines mapped to 9437 and Oaks mapped to 9438
  schedule loaded from schedule.json

## scheduler.js - pure computation, no side effects, no DB or browser calls

computeBookingSlots(horizonDays):
  Iterate the next horizonDays days.
  For each day that matches a schedule entry by weekday name:
    Generate the required number of tee time slots.
    First slot starts at window start time.
    Each subsequent slot is offset 10 minutes from the previous.
    Return array of objects with fields: date, target_time, slot_index, course, players.

groupByDateAndTime(pendingBookings):
  Group DB rows by the combination of date and target_time.
  Return an array of groups for batch processing.

## booking.js - BookingEngine class

Orchestration flow:
  1. computeBookingSlots() to get what needs booking
  2. ensureBookings() to write slots to DB
  3. getExistingReservations() to pre-check the site
  4. Skip any slots that are already booked on site
  5. groupByDateAndTime() to group pending slots
  6. For each group call _processGroup()

_processGroup() must try attempts in this exact order:

  Attempt 1:  Preferred course  no time offset
  Attempt 2:  Preferred course  minus 1 hour
  Attempt 3:  Preferred course  plus 1 hour
  Attempt 4:  Preferred course  minus 2 hours
  Attempt 5:  Preferred course  plus 2 hours
  Attempt 6:  Other course      no time offset
  Attempt 7:  Other course      minus 1 hour
  Attempt 8:  Other course      plus 1 hour
  Attempt 9:  Other course      minus 2 hours
  Attempt 10: Other course      plus 2 hours

For each attempt: try consecutive slots first, then fall back to individual slots.
Once any slot is successfully booked: lock to that course for all remaining slots in the group.
If a BLOCKED error is encountered: immediately stop all further attempts for the entire run.

After every checkout: call verifyBookingOnSite(date, time).
If the booking is not found on the Reservations page: mark the slot as failed, NOT confirmed.

## site.js - SiteAutomation class

Target site: https://fort-walton-member.book.teeitup.golf which is a Next.js React SPA using MUI components.

CRITICAL RULE FOR ALL CLICKS:
Always use JavaScript evaluation for every click operation:
  await element.evaluate(el => el.click());
Never use Playwright native .click() method.
Reason: MUI MuiBackdrop-root elements intercept pointer events and break Playwright clicks.

_dismissModals() must be called before every major interaction:
  Try clicking any elements with class MuiBackdrop-root
  Press the Escape key
  Wait briefly for animations to complete

Navigation rule: always pass waitUntil domcontentloaded to all page.goto calls. Never use networkidle.

Login sequence:
  1. Click the Login button on the homepage
  2. Locate the GolfID OAuth iframe
  3. Switch to iframe context and fill email and password fields
  4. Submit the login form
  5. Dismiss the email verification prompt using selector [aria-label="Close"]
  6. Dismiss any remaining MUI backdrop overlay
  7. Call clearCart() to remove any stale cart items and prevent cart limit errors

clearCart():
  Navigate to the cart page.
  Remove all items present.
  This must be called after every login before any booking attempt.

selectCourse(courseName):
  Accepts the string Pines or the string Oaks.
  Dynamically select the requested course using a dropdown or filter buttons on the booking page.

Tee time discovery:
  Find all buttons matching selector button:has-text("Book Now").
  For each button, walk up the parent DOM tree a maximum of 3 levels.
  Only consider parent elements with text content shorter than 300 characters.
  Extract the tee time from the parent text using a regex pattern.

findConsecutiveSlots(availableTimes, targetTime, count, gapMinutes):
  Search within plus or minus fallbackMinutes from the target time.
  Find count number of consecutive slots where each gap is between 5 and 15 minutes.
  Return the matched slots as an array or return null if not found.

Full booking sequence for a single slot:
  1. Click the Book Now button for the selected time using JS evaluation
  2. Select 4 golfers from the player selection interface
  3. Click the ADD TO CART button using JS evaluation
  4. Complete the checkout flow
  5. Call verifyBookingOnSite(date, time) - if it returns false, mark the slot as failed

getExistingReservations(date):
  1. Navigate to /reservation/history
  2. Paginate through results by clicking the NEXT button up to 20 pages maximum
  3. For each reservation card click VIEW DETAILS one at a time
  4. The SPA may not change the URL when navigating to detail view
  5. Extract reservation data by scanning the full page body text
  6. Navigate back to the list view after reading each detail
  7. Match confirmation numbers using these regex patterns:
     Reservation #NUMBER or Confirmation #Name|NUMBER
  Important: the site only shows reservations within approximately 7 days in the Upcoming section.

verifyBookingOnSite(date, time):
  Navigate to the Reservations page.
  Search the page for an entry matching both the date and time.
  Return true if found, false if not found.

Screenshots:
  Capture a PNG screenshot at each major step in the booking process.
  Save each screenshot to ./screenshots/ with a filename containing the timestamp and step name.

## web.js - Express server on port 3009

GET / route:
  Serve a server-rendered HTML page showing the current month and next month as calendars.
  Each day that has bookings shows color-coded chips:
    Green chip for confirmed status
    Red chip for failed status
    Yellow chip for pending status
    Grey chip for cancelled status
  Use Inter and Manrope fonts loaded from Google Fonts CDN.
  All text must meet WCAG AA contrast ratio requirements.
  Include a floating zoom widget for the calendar.
  Show a Schedule Month button for the current month that triggers booking for that month.
  Show a Book Now button for the next month that triggers booking for that month.

GET /api/bookings:
  Return all bookings from the database as a JSON array.

POST /api/book-month:
  Spawn the booking engine as a completely detached background process.
  This route must return a response immediately and must not block the Express server.
  Return JSON with { started: true }.

POST /api/cancel/:id:
  Mark the booking as cancelled in the database.
  Optionally cancel the booking on the site if its status is confirmed.

## notify.js

Configure Winston with a console transport and a rotating file transport.
Log file is golf-scheduler.log with maximum 5MB size and 3 rotating files.

Define these outcome alert functions:
  notifySuccess(date, time, confirmationNumber) - logs at info level
  notifyFailed(date, time) - logs at error level
  notifyPartial(bookedCount, totalCount, date) - logs at warn level
  notifyBlocked() - logs at error level, indicates all attempts aborted
  notifySkipped(date, time) - logs at info level

## fix-confirmations.js - utility script

Purpose: backfill real confirmation numbers for bookings that were confirmed but stored with placeholder values.

Steps:
  1. Query the database for confirmed bookings where confirmation_number is one of:
     EXISTING_RESERVATION, access, or CONFIRMED
  2. For each such booking, navigate to the site Reservations page
  3. Extract the real confirmation number
  4. Update the database record with the real number
  5. Log the results

Note: limited by the site only showing reservations within approximately 7 days.

## .env.example file contents

GOLF_EMAIL=your_golf_id_email
GOLF_PASSWORD=your_golf_id_password
TIMEZONE=America/Chicago
BOOKING_HORIZON_DAYS=30
FALLBACK_MINUTES=30
DB_PATH=./data/bookings.db
SCREENSHOT_DIR=./screenshots
LOG_LEVEL=info

## 14 EDGE CASES - ALL MUST BE HANDLED

1.  BLOCKED error received from site: immediately stop the entire booking run
2.  Cart limit error: clearCart() must be called after every login
3.  MUI backdrop intercepting clicks: always use el.evaluate(el => el.click())
4.  SPA navigation issues: use waitUntil domcontentloaded on every page.goto
5.  Reservation already exists on site: pre-check and skip to avoid duplicate booking
6.  Post-checkout verification returns false: mark as failed, never mark as confirmed
7.  Consecutive slots not available: fall back to booking individual slots instead
8.  Preferred course fully unavailable: switch to other course after exhausting 5 attempts
9.  Duplicate DB insert attempt: UNIQUE constraint handles this silently with insert or ignore
10. Slot has reached maximum retries: skip it entirely, do not attempt again
11. Email verification prompt appears after login: dismiss using [aria-label="Close"]
12. Reservations history spans multiple pages: paginate through NEXT button up to 20 pages
13. Cancel command date format: accept YYYY-MM-DD and MM/DD and MM-DD formats
14. POST /api/book-month must spawn a detached process and return immediately without blocking

## IMPLEMENTATION ORDER - MANDATORY - DO NOT REORDER

Step 1:  Create package.json with all dependencies, create folder structure, create .env.example
Step 2:  Implement config.js and create schedule.json
Step 3:  Implement db.js with all 7 required methods
Step 4:  Implement scheduler.js with computeBookingSlots and groupByDateAndTime
Step 5:  Implement notify.js with Winston setup and all 5 outcome functions
Step 6:  Implement site.js SiteAutomation class skeleton and complete login flow
Step 7:  Add clearCart, selectCourse, and tee time discovery to site.js
Step 8:  Add findConsecutiveSlots and full booking sequence to site.js
Step 9:  Add getExistingReservations and verifyBookingOnSite to site.js
Step 10: Implement booking.js BookingEngine with full orchestration and 10-attempt _processGroup
Step 11: Implement index.js with Commander CLI wiring all 7 commands
Step 12: Implement web.js with Express server, calendar HTML renderer, and all 4 routes
Step 13: Implement fix-confirmations.js utility script
Step 14: Run npm run dry-run and confirm it completes without errors
Step 15: Write README.md with full documentation

## README.md MUST INCLUDE

Section 1: Prerequisites including Node.js version requirement and the command npx playwright install chromium
Section 2: Setup steps - clone the repo, run npm install, copy .env.example to .env, fill in credentials
Section 3: All npm run commands listed with clear descriptions of what each does
Section 4: How the 10-attempt fallback logic works, which courses and time offsets are tried in order
Section 5: Database status values explained with what each means
Section 6: How to view the web calendar at http://localhost:3009
Section 7: Troubleshooting covering MUI overlay click issues, cart limit errors, BLOCKED errors, and the 7-day reservation window limitation

## FINAL INSTRUCTION

Build the complete system. Every module must be fully functional with no placeholder implementations.
All 14 edge cases must be handled. npm run dry-run must complete without errors before the build is considered done.

---

# Frontend / UX Audit Prompt

You are a senior frontend engineer and UX expert specializing in accessibility,
readability, and visual design. Audit all HTML/CSS pages in this project and
produce a detailed report + fixes.

## Tasks:

### 1. COLOR & CONTRAST AUDIT
- Check every text/background color combination
- Flag any with contrast ratio below 4.5:1 (WCAG AA)
- Flag pure black (#000000) on pure white (#ffffff) as "harsh"
- Suggest replacements using these approved palettes:
  * Light: bg #FAFAF9, text #1C1C1E, accent #2563EB
  * Dark: bg #0F172A, text #E2E8F0, accent #38BDF8
  * Warm: bg #FDF6EC, text #2D2A26, accent #D97706

### 2. READABILITY AUDIT
- Check font sizes (body should be min 16px, never below 14px)
- Check line-height (ideal: 1.5–1.7 for body text)
- Check line length (max 65–75 characters per line)
- Check letter-spacing on headings (slightly loose = more readable)
- Flag walls of text with no visual breaks
- Check font choices — flag Arial, Times New Roman, generic system fonts

### 3. ZOOM FUNCTIONALITY
Add a floating zoom control widget to every HTML page:
- A small pill-shaped control (bottom-right corner, fixed position)
- Buttons: [ A- ] [ 100% ] [ A+ ]
- Font size range: 12px to 24px base, in 2px steps
- Persist zoom level in localStorage
- Smooth CSS transition on zoom change
- Keyboard shortcuts: Ctrl+= to zoom in, Ctrl+- to zoom out, Ctrl+0 to reset
- Code:
```javascript
// Inject this zoom widget into every page
const zoomWidget = `
<div id="zoom-control" style="
  position: fixed; bottom: 24px; right: 24px; z-index: 9999;
  display: flex; align-items: center; gap: 8px;
  background: #1C1C1E; color: #FAFAF9; border-radius: 999px;
  padding: 8px 16px; font-family: monospace; font-size: 14px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.3); user-select: none;
">
  <button onclick="zoom(-1)" style="background:none;border:none;color:inherit;cursor:pointer;font-size:16px;">A−</button>
  <span id="zoom-label">100%</span>
  <button onclick="zoom(1)" style="background:none;border:none;color:inherit;cursor:pointer;font-size:18px;">A+</button>
</div>`;

let baseSize = parseInt(localStorage.getItem('zoomSize') || 16);
document.documentElement.style.fontSize = baseSize + 'px';
document.body.insertAdjacentHTML('beforeend', zoomWidget);
document.getElementById('zoom-label').textContent =
  Math.round((baseSize/16)*100) + '%';

function zoom(dir) {
  baseSize = Math.min(24, Math.max(12, baseSize + dir * 2));
  document.documentElement.style.fontSize = baseSize + 'px';
  document.getElementById('zoom-label').textContent =
    Math.round((baseSize/16)*100) + '%';
  localStorage.setItem('zoomSize', baseSize);
}

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === '=') { e.preventDefault(); zoom(1); }
  if (e.ctrlKey && e.key === '-') { e.preventDefault(); zoom(-1); }
  if (e.ctrlKey && e.key === '0') { e.preventDefault(); baseSize=16; zoom(0); }
});
```

### 4. OUTPUT FORMAT
For each page file found:
- File name
- Issues found (color, readability, missing zoom)
- Specific CSS fixes with before/after values
- Overall score: A / B / C / F

### 5. AUTO-FIX
After reporting, ask: "Apply all fixes automatically? (yes/no)"
If yes — edit the files directly with the corrections.

Start by scanning all .html, .css, and .jsx/.tsx files in the project root and subdirectories.