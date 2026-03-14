You are a senior browser automation engineer working in Claude Code.

Before making any code changes:
1. Inspect the existing project/codebase and understand how the browser automation is structured.
2. Create a short execution plan.
3. Then execute the plan.

Objective:
Fix and validate the tee time reservation flow so it only books 4-player tee times, and clean up any existing bad reservations that were mistakenly booked for only 1 player.

Primary goals:
1. End-to-end test the reservation flow to confirm new bookings are made only as 4-player tee times.
2. Find and cancel all existing active reservations that were booked for exactly 1 person.
3. Make the automation reliable, rerunnable, and safe.

Context:
There is a known bug in the scheduling flow that created tee time reservations for only 1 player instead of 4 players.
We need:
- a cleanup flow for existing bad reservations
- an end-to-end verification flow that confirms future bookings use 4 players only

Site behavior for cancellation:
On the reservation cancellation page:
- Set "Number of Players to Cancel" = 1
- Set "Reason for Cancellation" = "Want a different date"
- Click "SUBMIT CANCELLATION"

Required workflow

Phase 1: Inspect and reuse existing project structure
- Inspect the current codebase first.
- Reuse the existing login/session/auth flow if already implemented.
- Reuse existing helpers, config, environment variables, selectors, page objects, and retry utilities if present.
- Follow the project’s existing style, naming, folder structure, and framework patterns.
- If Playwright is already used, use Playwright.
- If another browser automation stack is already present, stay within that stack unless there is a very strong reason not to.

Phase 2: Cleanup existing bad 1-person reservations
- Navigate to the member tee times / reservations area.
- Find all active reservations.
- Determine the booked player count for each reservation.
- Only cancel reservations when the player count is clearly and confidently exactly 1.
- Skip any reservation that is not exactly 1 player.
- If the player count cannot be determined confidently, do not cancel it; log it for manual review.

For each confirmed 1-person reservation:
- Open the cancellation flow.
- Set number of players to cancel = 1.
- Set reason for cancellation = "Want a different date".
- Submit the cancellation.
- Confirm success if the UI provides confirmation text, status change, disappearance from active reservations, or another reliable signal.
- Continue until all confirmed 1-person reservations have been processed.

Phase 3: End-to-end validation for correct booking behavior
- Inspect the existing booking flow.
- Identify where player count is selected or derived.
- Update or add automation so the reservation flow explicitly books for 4 players only.
- Add an end-to-end test that:
  - logs in
  - navigates to booking
  - selects a tee time in a safe/non-destructive way if a test path already exists
  - verifies the player count selection is 4 before final submission
  - verifies the resulting reservation is recorded as 4 players after booking, if the environment/project supports safe validation
- If real booking in the live environment is risky, add a guardrail and use the safest validation approach possible already supported by the repo, such as:
  - dry-run mode
  - pre-submit verification only
  - mocked test
  - staging/test environment flow
- Do not create accidental live bookings unless the existing project already has an approved safe test flow for this.

Safety constraints
- Do not cancel any reservation unless it is clearly exactly a 1-person booking.
- If uncertain, skip and log for manual review.
- Do not cancel 2-player, 3-player, or 4-player bookings.
- Do not rely on brittle selectors if better stable selectors are available.
- Prefer accessible roles, labels, visible text, form names, data-testid, or stable app hooks over fragile CSS/XPath.
- Add defensive waits and retries for slow page loads, stale elements, popups, and intermittent failures.
- Make the script safe to rerun.
- Avoid duplicate cancellations and duplicate booking attempts.
- Add screenshots and structured logs on failure if the project patterns support it.

Implementation requirements
- Refactor repeated logic into helper functions where appropriate.
- Keep code production-safe, readable, and maintainable.
- Add clear logging for both cleanup and validation flows.
- Add retry handling for transient browser/UI issues.
- Add timeout handling with useful error messages.
- Preserve existing conventions and patterns in the repo.
- If config values are needed, place them in the project’s normal config/env location.

Logging requirements
For reservation cleanup, log:
- reservation found
- date
- time
- course
- detected player count
- whether count was confidently determined
- cancellation attempted
- cancellation success/failure
- failure reason if any

For booking validation, log:
- booking flow started
- selected course/date/time if applicable
- detected selected player count before submission
- booking submission attempted or intentionally skipped
- validation result
- any mismatch between expected and actual player count

Required output at the end
Print a final summary with:
Cleanup summary:
- total reservations scanned
- total 1-person reservations found
- total successfully cancelled
- total failed cancellations
- total skipped for manual review
- detailed list of failures/skips

Booking validation summary:
- whether booking flow was inspected
- whether player count selection was updated/fixed
- whether end-to-end validation was added
- whether validation passed
- any remaining risks or blockers

Execution behavior
- First show a short execution plan.
- Then inspect the codebase and implement the changes.
- Then explain exactly what files were created or updated.
- Then explain how to run the cleanup flow.
- Then explain how to run the end-to-end booking validation.
- Then list assumptions, manual inputs, environment variables, and any places where a human must verify behavior.

Additional guidance
- Be explicit and cautious.
- Prefer confidence-based branching:
  - confidently 1 player => cancel
  - not confidently 1 player => do not cancel
- If the UI structure is unclear, inspect before coding.
- Do not invent selectors without verifying them from the codebase/runtime.
- If you need to choose between speed and safety, choose safety.
