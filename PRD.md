# GolfScheduler — Product Requirements Document

**Version**: 1.0
**Date**: 2026-03-03
**Status**: Draft

---

## 1. Executive Summary

GolfScheduler is a Node.js automation system that reserves tee times at Fort Walton Beach Golf (FWB) for a recurring group of golfers. The system logs into the TeeItUp/Kenna Golf platform via Playwright browser automation, books tee times according to a fixed weekly schedule, and persists all booking data in a local SQLite database.

The current system reliably books tee times but has three outstanding gaps: (1) the web calendar displays the pre-booking target time rather than the confirmed booked time, giving the group inaccurate schedule information; (2) the local database is not reliably synchronised with the FWB site's authoritative reservation history, meaning cancelled or missed bookings can appear as confirmed and vice versa; and (3) the web interface's visual design and mobile layout are not suitable for casual viewing by group members on phones.

This document defines the requirements for the next phase of development, covering the time-display bug fix, a robust automated sync engine, a daily scheduling cadence, and a clean mobile-friendly web UI redesign.

---

## 2. Goals & Success Metrics

### 2.1 Business Goals

- Ensure the group always has tee times booked for the full one-month window allowed by FWB.
- Eliminate manual reconciliation between the database and the FWB site.
- Give all group members reliable, accurate visibility into the upcoming tee time schedule from any device.

### 2.2 User Goals

- **Admin (owner)**: Trust that the database reflects reality; trigger or monitor bookings with minimal friction.
- **Group members**: Quickly check what tee times are booked from a phone without needing an account or login.

### 2.3 Success Metrics (KPIs)

| Metric | Target |
|--------|--------|
| Time-display accuracy | 100% of confirmed chips show `actual_time`; zero chips show a `target_time` when `actual_time` exists |
| DB/site sync accuracy | After each daily sync, 0 confirmed bookings in DB that do not exist on FWB site |
| Daily run reliability | Booking + sync job completes without error on >= 95% of scheduled days |
| Mobile usability | Calendar renders correctly on viewport widths >= 375px with no horizontal scroll |
| Page load time | Web calendar loads in under 3 seconds on a local network connection |

---

## 3. Target Users

### 3.1 Primary Persona

**Bruce (Admin / Owner)**
- Runs the system on a Windows machine.
- Needs to monitor booking status, trigger manual booking runs, and cancel reservations.
- Comfortable with the CLI and web UI.
- Sole user with write/action access.

### 3.2 Secondary Personas

**Golf Group Members (Read-Only Viewers)**
- 8–12 people who play on Mon/Tue/Fri/Sat.
- Access the web calendar via a shared URL, typically on a mobile phone.
- Only need to see what tee times are booked — no ability to modify anything.
- Varying technical comfort; must require zero setup or login.

### 3.3 Out of Scope Users

- General public (no public marketing or discovery).
- Other golf facilities or booking platforms.

---

## 4. Scope

### 4.1 In Scope — v1 (This Phase)

- Fix web calendar to display confirmed `actual_time` instead of `target_time` on booking chips and in the detail modal.
- Build an automated daily sync job that scrapes FWB reservation history and reconciles the local database.
- Auto-correct mismatches (wrong time, wrong confirmation number, orphaned DB records) and log all corrections.
- Change the scheduler from a 6-hour interval to a daily run at 06:00 local time, combining the booking engine and sync into a single daily job.
- Redesign the web UI with a clean, minimal colour palette and full mobile responsiveness (>= 375px viewport).
- Maintain open (no-login) access to the web view for group members.
- Keep all existing admin actions (book, cancel) accessible in the web UI, visible only to the admin (by convention — no auth gate, relies on URL obscurity).

### 4.2 Out of Scope — Future Versions

- User authentication or role-based access control.
- Push notifications (SMS/email/push) to group members when bookings are confirmed or cancelled.
- Support for golf courses other than Fort Walton Beach Pines and Oaks.
- Mobile native app.
- Multi-facility or multi-group support.

### 4.3 Explicit Non-Goals

- The system will not support online payment processing.
- The system will not expose a public API beyond the existing `/api/bookings` and action endpoints.
- The sync will not create new DB booking records for reservations that do not match any existing DB slot (it will log unmatched site reservations but take no action on them).

---

## 5. Functional Requirements

### 5.1 Web Calendar — Time Display Fix

- **FR-001** (P0): Every booking chip in the monthly calendar grid must display `actual_time` when `actual_time` is non-null. When `actual_time` is null (e.g., status is `pending` or `failed`), display `target_time`. The current code at `web.js:399` already uses `b.actual_time || b.target_time` — this requirement mandates verifying that `actual_time` is being populated correctly by the booking engine and sync, not just that the display expression is correct.
- **FR-002** (P0): The booking detail modal (opened by clicking a chip or table row) must show the same corrected time — `actual_time` when available, otherwise `target_time` — with a clear label distinguishing "Confirmed Time" from "Target Time".
- **FR-003** (P0): The "All Bookings" detail table at the bottom of the page must show both `target_time` and `actual_time` as separate columns, as currently implemented. No change required here beyond ensuring data accuracy.
- **FR-004** (P1): All times must be displayed in 24-hour (HH:MM) format, consistent with the existing convention.

### 5.2 DB / Site Sync Engine

- **FR-010** (P0): A sync module (`src/sync.js`) must scrape the FWB reservation history page (using the existing `SiteAutomation` Playwright session) and return a list of all currently visible upcoming reservations with their date, confirmed time, course, and confirmation number.
- **FR-011** (P0): The sync must use the FWB site as the source of truth. For each DB booking with status `confirmed`, `pending`, or `cancelled` that has a corresponding date visible on the FWB history page, the sync must compare `actual_time` and `confirmation_number`. If either differs from the site data, the DB record must be updated to match the site and the correction logged at INFO level with the before/after values.
- **FR-012** (P0): If a DB booking is `confirmed` with a real numeric confirmation number, and the sync cannot find that date's reservation on the FWB site, the sync must log a WARNING: `"[DATE] slot [INDEX]: DB shows confirmed Res#[NUM] but not found on site — manual review required"`. It must NOT automatically mark such records as cancelled, because the FWB site only shows reservations within approximately 7 days (CLAUDE.md confirmed limitation).
- **FR-013** (P0): All sync corrections must be written to the application log (`golf-scheduler.log`) at INFO or WARN level with a `[SYNC]` prefix, including: field changed, old value, new value, booking ID, date.
- **FR-014** (P1): The sync module must expose a function `runSync()` that can be called programmatically (for integration into the daily job) and also invoked directly via a new CLI command `npm run sync`.
- **FR-015** (P1): The sync must handle the case where placeholder confirmation numbers (`EXISTING_RESERVATION`, `CONFIRMED`, `access`) are present in the DB. These must be treated as "needs real confirmation number" and updated when the site provides the real numeric value.
- **FR-016** (P1): After the sync completes, it must return a summary object: `{ checked, updated, warnings, errors }` with counts for logging and future notification use.

### 5.3 Daily Scheduler

- **FR-020** (P0): Replace the existing 6-hour interval scheduler (`src/index.js` `scheduler` command, `INTERVAL_MS = 6 * 60 * 60 * 1000`) with a daily cron-style job that fires at 06:00 in the configured timezone (`config.timezone`, default `America/Chicago`).
- **FR-021** (P0): The daily job sequence must be: (1) run sync (`runSync()`) to pull latest site state, then (2) run the booking engine (`BookingEngine.run()`) to book any newly pending slots. Both steps must run in the same Playwright session where possible to reduce overhead and login round-trips.
- **FR-022** (P0): The daily job must log its start time, completion time, and a summary of sync results and booking results at INFO level.
- **FR-023** (P1): If the 06:00 fire time is missed (e.g., machine was off), the scheduler must run immediately on next startup rather than waiting for the next 06:00 window.
- **FR-024** (P1): The `npm run scheduler` command must continue to work as the entry point for the always-on daemon mode, now using the daily cadence instead of 6-hourly.
- **FR-025** (P2): A new environment variable `SCHEDULER_HOUR` (default: `6`) must allow the daily fire time to be overridden without code changes.

### 5.4 Web UI Redesign

- **FR-030** (P0): The web UI must render correctly on viewport widths from 375px (iPhone SE) up to 1440px desktop with no horizontal scroll bar at any breakpoint.
- **FR-031** (P0): The calendar grid must adapt on small screens: on viewports < 640px, display a single-column list of booked dates and times rather than a 7-column grid (which becomes unreadable on phones).
- **FR-032** (P0): Replace the current burnt-orange (`#cb6301`) primary colour scheme with a clean, minimal palette. Suggested: white/light-grey backgrounds (`#FFFFFF`, `#F8F9FA`), dark slate text (`#1A1A2E` or similar), and a muted green accent (`#2D6A4F` or similar) for confirmed bookings — reflecting golf without being garish. All status colours must maintain WCAG AA contrast ratio (>= 4.5:1 against their background).
- **FR-033** (P0): Booking chips must be large enough to tap on a phone: minimum 44px touch target height on mobile viewports.
- **FR-034** (P1): The floating zoom widget (currently bottom-right fixed) is a desktop-only concern. On mobile viewports (< 640px), hide the zoom widget.
- **FR-035** (P1): The "All Bookings" detail table must either be replaced with a card-based list on mobile or use `overflow-x: auto` with a minimum column width so it does not break layout on small screens.
- **FR-036** (P1): The page header must include a last-synced timestamp (e.g., "Last synced: 2026-03-03 06:02") sourced from a new DB or in-memory field updated by the sync job.
- **FR-037** (P1): Admin action buttons ("Schedule Month", "Book Now", "Cancel") must remain visible and functional on mobile. Cancel buttons in the table/modal must be clearly styled as destructive actions (red, labelled).
- **FR-038** (P2): Add a "Refresh" button or auto-refresh (every 60 seconds via `setInterval`) to the web page so group members get updated status without manually reloading.

### 5.5 Access Control (Unchanged Convention)

- **FR-040** (P0): The web view remains open access — no authentication required. Any visitor with the URL can see the calendar.
- **FR-041** (P0): Admin actions (Book Now, Schedule Month, Cancel) remain present in the UI. There is no technical access control; the convention is that only the admin knows the URL and uses these actions.
- **FR-042** (P1): No new authentication mechanisms are to be introduced in this phase.

---

## 6. Non-Functional Requirements

### 6.1 Performance

- The `GET /` web page must render the server-side HTML and respond within 500ms under normal DB load (< 200 bookings).
- The sync job must complete within 5 minutes for a typical month of bookings (up to 20 upcoming reservation cards on the FWB history page).
- The daily booking engine run must complete within 15 minutes when all slots are already booked (no-op path).

### 6.2 Security & Compliance

- GolfID credentials (`GOLF_EMAIL`, `GOLF_PASSWORD`) remain in `.env` and must never be logged or exposed in HTTP responses.
- No credentials, confirmation numbers, or PII must appear in URL query parameters.
- The application continues to run on the local machine (Windows) with no internet-facing exposure required.

### 6.3 Accessibility

- All new UI elements must meet WCAG 2.1 AA contrast requirements (>= 4.5:1 for normal text, >= 3:1 for large text and UI components).
- Booking chips and buttons must have descriptive `title` or `aria-label` attributes for screen reader compatibility.
- The modal must be keyboard-navigable: focusable, closeable with Escape, and trap focus while open.

### 6.4 Reliability & Availability

- The system runs as a local process on Windows; no uptime SLA applies.
- The daily job must not crash the entire process on a single sync or booking failure — errors must be caught, logged, and the job must continue to the next step.
- The DB auto-persist (`db.save()`) after every mutation must be preserved to prevent data loss on unexpected process termination.
- Winston log rotation (5MB, 3 files) must be maintained for the `golf-scheduler.log`.

---

## 7. Platform & Technical Constraints

### 7.1 Target Platforms

- **Runtime**: Windows (primary), Git Bash shell
- **Node.js**: >= 20 (currently Node 24 per CLAUDE.md)
- **Web client**: Modern mobile browsers (Chrome/Safari on iOS and Android) and desktop browsers

### 7.2 Technology Preferences / Constraints

- No build step, no TypeScript compilation, no test runner — raw Node.js execution
- sql.js (pure-JS SQLite) must be retained — not replaced with better-sqlite3 — due to Windows/Node 24 native build constraints
- Playwright (Chromium) for all browser automation — no other automation library
- Express for the web server — no framework change
- dayjs for date/time manipulation — already a dependency
- No new npm dependencies should be introduced unless strictly necessary; prefer using existing dependencies

### 7.3 Infrastructure & Deployment

- Single process on a local Windows machine
- Database: `./data/bookings.db` (sql.js SQLite)
- Logs: `./golf-scheduler.log` (Winston, 5MB rotation, 3 files)
- Screenshots: `./screenshots/` (PNG, existing convention)
- No containerisation, no CI/CD pipeline, no cloud deployment

---

## 8. Authentication & Authorisation

### 8.1 Auth Methods

- **FWB site login**: GolfID OAuth iframe — email/password credentials from `.env`. No change to existing `site.js` login flow.
- **Web UI access**: No authentication. Open HTTP on `localhost:3002`. Access is by URL knowledge only.

### 8.2 Roles & Permissions

| Role | Access |
|------|--------|
| Admin (owner) | Full: view calendar, trigger booking run, cancel reservations, run sync |
| Group member | Read-only: view calendar and booking status |

No technical enforcement of this distinction in v1. Admin actions are in the UI for any visitor.

---

## 9. Data Architecture

### 9.1 Core Entities

**bookings** table (existing schema, no structural changes required):

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `date` | TEXT | YYYY-MM-DD |
| `day_label` | TEXT | e.g., "Saturday 8 AM-1 PM" |
| `target_time` | TEXT | HH:MM — the time the engine requested |
| `actual_time` | TEXT | HH:MM — the confirmed booked time from the site |
| `window_start` | TEXT | Start of acceptable booking window |
| `window_end` | TEXT | End of acceptable booking window |
| `course` | TEXT | "Pines" or "Oaks" |
| `slot_index` | INTEGER | 0-indexed within the day's group |
| `players` | INTEGER | Always 4 |
| `confirmation_number` | TEXT | Numeric string from FWB site, or placeholder |
| `screenshot_path` | TEXT | Path to booking screenshot |
| `status` | TEXT | `pending`, `confirmed`, `failed`, `partial`, `skipped`, `cancelled` |
| `attempts` | INTEGER | Retry count |
| `last_attempt_at` | TEXT | ISO datetime |
| `error_message` | TEXT | Last error, max 500 chars |
| `created_at` | TEXT | ISO datetime |
| `updated_at` | TEXT | ISO datetime |

**New metadata** (no schema change required — use in-memory or a simple JSON file):
- `lastSyncAt`: ISO datetime of the most recent successful sync run, for display in the web UI header (FR-036). Can be stored as a single-row config table or a `./data/sync-meta.json` file.

### 9.2 Data Flow

```
schedule.json
    ↓
config.js (loads schedule, maps days to numbers)
    ↓
scheduler.js computeBookingSlots()
    ↓
db.ensureBookings()  ←──────────────── bookings.db
    ↓
BookingEngine._processGroup()
    ↓
SiteAutomation (Playwright → FWB site)
    ↓
db.markSuccess() / markFailed()
    ↓
sync.runSync()  ──→  SiteAutomation.scrapeReservationHistory()
    ↓
db.markSuccess() (update actual_time + confirmation_number)
    ↓
web.js GET /  ──→  db.getAllUpcoming()  ──→  HTML calendar
```

### 9.3 Offline & Sync Strategy

The system requires an active internet connection to run the booking engine and sync. There is no offline mode.

Sync conflict resolution: FWB site always wins. When site data contradicts DB data for a date within the site's visible window (~7 days), the DB is updated to match the site. For dates beyond the site's window, the DB record is preserved as-is and a warning is logged.

---

## 10. Integrations

| Integration | Purpose | Priority | Notes |
|-------------|---------|----------|-------|
| FWB TeeItUp/Kenna Golf (`fort-walton-member.book.teeitup.golf`) | Primary booking and reservation history | P0 | Playwright automation; GolfID OAuth login; site layout changes may break automation |
| GolfID OAuth (`my.golfid.io`) | Authentication for FWB platform | P0 | Handled within existing `site.js` login flow |
| Google Fonts (Inter + Manrope) | Web UI typography | P1 | CDN link in HTML head; no API key needed |

No new integrations are introduced in this phase.

---

## 11. Monetisation Model

Not applicable. This is a private-use automation tool for a personal golf group. No monetisation, no subscriptions, no payments.

---

## 12. UX & Design Principles

### Core Principles

1. **Clarity over cleverness**: Group members should see what they need (date, time, course, status) at a glance with no explanation needed.
2. **Mobile first**: Design for a 375px phone screen first; enhance for desktop.
3. **Clean and calm**: Minimal colour use. White backgrounds, subtle borders, muted accent colours. No gradients, no shadows except for modals.
4. **Status at a glance**: Booking status (confirmed/pending/failed/cancelled) must be immediately distinguishable by colour and label without requiring the user to tap into a detail view.

### Colour Palette (Proposed)

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-page` | `#F8F9FA` | Page background |
| `--bg-card` | `#FFFFFF` | Calendar cells, cards |
| `--bg-header` | `#1B3A2D` | Site header, calendar day headers |
| `--text-primary` | `#1A1A1A` | Body text |
| `--text-secondary` | `#6B7280` | Subtext, labels |
| `--accent-confirmed` | `#2D6A4F` | Confirmed bookings |
| `--accent-pending` | `#B45309` | Pending bookings (amber) |
| `--accent-failed` | `#DC2626` | Failed bookings (red) |
| `--accent-cancelled` | `#9CA3AF` | Cancelled (grey, strikethrough) |
| `--accent-action` | `#1B3A2D` | Primary action buttons |
| `--border` | `#E5E7EB` | Dividers, cell borders |

All colour pairs must achieve >= 4.5:1 contrast ratio (WCAG AA).

### Mobile Layout

- Viewport < 640px: calendar collapses to a vertical list grouped by week, showing only days with bookings. Each booking is a card showing date, day name, time, course, and status badge.
- Viewport >= 640px: standard 7-column grid calendar, current behaviour retained but with updated colours and chip sizing.
- Typography: Inter for body; Manrope for headings (existing fonts, no change).

### Accessibility Targets

- WCAG 2.1 AA for all text and interactive elements.
- Minimum 44px touch targets on all interactive elements.
- Keyboard navigation for modal (focus trap, Escape to close).

---

## 13. Milestones & Phasing

| Phase | Scope | Target |
|-------|-------|--------|
| **M1: Bug Fix** | FR-001, FR-002 — Fix time display on chips and modal. Verify `actual_time` is populated correctly end-to-end. | First available dev session |
| **M2: Sync Engine** | FR-010 through FR-016 — Build `src/sync.js`, add `npm run sync` command, integrate logging. | After M1 |
| **M3: Daily Scheduler** | FR-020 through FR-025 — Replace 6-hour interval with 06:00 daily cron combining sync + booking. | After M2 |
| **M4: UI Redesign** | FR-030 through FR-038 — Mobile-responsive layout, clean colour palette, last-synced timestamp, auto-refresh. | After M3 (can be done in parallel with M3) |

Each milestone should be verified manually by running the system and checking the web UI before proceeding.

---

## 14. Open Questions

1. **Unmatched site reservations**: If the FWB site shows a reservation for a date/time that does not match any DB booking slot (e.g., a manually-made booking outside the automated schedule), should the sync log it and ignore it, or create a new DB record? Current requirement (Section 5, Non-Goal) says log-and-ignore — confirm this is correct before implementing.

2. **Cancelled-on-site but confirmed-in-DB**: If a booking was confirmed in the DB but cancelled directly on the FWB website (outside the app), the sync's 7-day visibility window will detect the absence. For dates beyond 7 days, should there be a probing strategy (like the existing `update-saturdays.js` approach) as part of the automated sync, or is manual `node sync-reservations.js` sufficient for those cases?

3. **`lastSyncAt` storage**: Should the last-sync timestamp be stored in a new `./data/sync-meta.json` file (simple, no schema change), or as a new single-row config table in the SQLite DB? Either works — needs a decision before implementing FR-036.

4. **Headless mode**: The system currently runs Playwright non-headless (`headless: false`) for debugging visibility. The daily 06:00 automated job should likely run headless. Should `headless` be controlled by an environment variable (e.g., `HEADLESS=true`), or hardcoded to `false` for the interactive `book` command and `true` for the `scheduler` daemon?

---

## 15. Assumptions

| # | Assumption | Impact if Wrong |
|---|-----------|----------------|
| A1 | The root cause of the time display bug is that `actual_time` is null or contains a placeholder at the time the calendar is rendered, not that the display expression itself is wrong. The fix involves ensuring sync populates `actual_time` correctly rather than changing the HTML template expression. | If the template is actually wrong, M1 is simpler (template-only fix) — but M2 is still needed for data accuracy. |
| A2 | The FWB site's reservation history page continues to show all upcoming reservations within approximately 7 days, as described in CLAUDE.md. The sync strategy depends on this window. | If the window shrinks, sync coverage decreases and more manual intervention is required. |
| A3 | The daily 06:00 run time is appropriate for the booking horizon. FWB opens exactly 30 days ahead, so a daily morning run will capture newly-openable dates within 24 hours of them becoming bookable. | If FWB opens dates at midnight local time and slots fill within hours, the 06:00 run may miss peak availability. In that case, an earlier run time (e.g., 00:05) should be considered. |
| A4 | No new npm dependencies are needed for the daily cron scheduling. `setTimeout` with next-fire-time calculation (or the `node-cron` package if already available) will be used. If `node-cron` is not present, the implementation will use a pure `setTimeout` loop calculating the next 06:00 firing time. | Minimal impact either way. |
| A5 | The "clean minimal" colour direction described in Section 12 (dark green header, white cards) is acceptable to the admin. No formal design approval process exists. | The palette can be adjusted by editing CSS variables in `web.js` — low rework cost. |
| A6 | Group members access the web view from the same local network or via a VPN/tunnel — the server does not need to be internet-exposed. | If remote access is needed, a tunnelling solution (e.g., ngrok) would need to be added outside this PRD's scope. |
| A7 | The existing `sync-reservations.js` utility script (two-pronged: list-page scrape + direct detail-page probe) represents the correct sync strategy and should be refactored into `src/sync.js` rather than replaced with a different approach. | If the probe-by-ID approach is too fragile for automated use, the sync may need to fall back to list-scrape-only for the automated daily job. |
