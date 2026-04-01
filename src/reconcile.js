'use strict';

/**
 * reconcile.js
 *
 * Exports reconcileDate() — pure reconciliation logic that pairs site reservation
 * data with DB booking rows for a single date and applies any needed updates via
 * db.updateBookingSync().
 *
 * Matching strategy: order-based positional pairing.
 *   - siteSlots sorted ascending by time  → slot at index 0 = earliest reservation
 *   - dbSlots   sorted ascending by slot_index → slot at index 0 = first booked slot
 *
 * This module contains NO site/browser I/O and NO scheduling logic.
 * All side-effects are limited to DB writes via db.updateBookingSync().
 */

const db = require('./db');

/**
 * Known placeholder confirmation numbers that should be replaced whenever
 * the site provides a real numeric value (FR-015).
 */
const PLACEHOLDER_CONFIRMATION_NUMBERS = new Set([
  'EXISTING_RESERVATION',
  'CONFIRMED',
  'access',
]);

/**
 * Returns true when a confirmation number string is a known placeholder
 * (i.e. not a real numeric confirmation from the site).
 *
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
function isPlaceholder(value) {
  if (!value) return true;
  if (PLACEHOLDER_CONFIRMATION_NUMBERS.has(value)) return true;
  return false;
}

/**
 * Returns true when a site-provided confirmation number is a real numeric
 * value (not a placeholder and not null/empty).
 *
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
function isRealConfirmationNumber(value) {
  return !!value && /^\d+$/.test(value);
}

/**
 * Convert an HH:MM time string to total minutes for sorting.
 * Returns -1 for null/undefined/unparseable values.
 *
 * @param {string|null|undefined} t
 * @returns {number}
 */
function toMinutes(t) {
  if (!t) return -1;
  const parts = t.split(':');
  if (parts.length < 2) return -1;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return -1;
  return h * 60 + m;
}

/**
 * Statuses that represent bookings which exist (or existed) on the site and
 * should be paired with site reservation data. Slots with status 'failed',
 * 'skipped', or 'partial' are not paired because they were never confirmed on
 * the site from the DB's perspective.
 */
const PAIRABLE_STATUSES = new Set(['confirmed', 'pending', 'cancelled']);

/**
 * Reconcile site reservation data against DB booking rows for a single date.
 *
 * Algorithm:
 *   1. Filter dbSlots to only pairable statuses (confirmed / pending / cancelled).
 *   2. Sort filtered dbSlots ascending by slot_index.
 *   3. Sort siteSlots ascending by time.
 *   4. Pair positionally: dbSlots[i] ↔ siteSlots[i].
 *   5. For each pair, determine whether a DB write is needed:
 *      - actual_time differs from site time, OR
 *      - DB has a placeholder confirmation number and site has a real numeric one, OR
 *      - confirmation_number simply differs from site value.
 *   6. If a DB slot has no corresponding site slot, log a warning and increment notFound.
 *   7. Return { updated, notFound, warnings }.
 *
 * @param {string} date
 *   ISO date string, e.g. '2026-03-07'.
 *
 * @param {Array<{time: string, course: string, confirmationNumber: string}>} siteSlots
 *   Reservations scraped from the site for this date.
 *   `time` must be in HH:MM 24-hour format.
 *   `confirmationNumber` is the site's numeric reservation ID string.
 *
 * @param {Array<object>} dbSlots
 *   Booking rows from the DB for this date (any status mix — will be filtered internally).
 *   Each row must have at minimum: id, slot_index, status, actual_time, confirmation_number,
 *   target_time, course.
 *
 * @param {object} logger
 *   Winston logger instance. Must expose .info() and .warn().
 *
 * @returns {Promise<{ updated: number, notFound: number, warnings: string[] }>}
 */
async function reconcileDate(date, siteSlots, dbSlots, logger) {
  const updated = { count: 0 };
  let notFound = 0;
  const warnings = [];

  // Filter to only slots that represent real (or formerly real) site bookings.
  const relevant = dbSlots
    .filter(b => PAIRABLE_STATUSES.has(b.status))
    .sort((a, b) => a.slot_index - b.slot_index);

  // Sort site slots ascending by time so positional pairing is deterministic.
  const sortedSite = [...siteSlots].sort((a, b) => toMinutes(a.time) - toMinutes(b.time));

  logger.info(
    `[SYNC] reconcileDate ${date}: ${relevant.length} DB slot(s) | ${sortedSite.length} site reservation(s)`
  );

  for (let i = 0; i < relevant.length; i++) {
    const slot = relevant[i];

    // No site reservation at this position — do not modify DB, emit a warning.
    if (i >= sortedSite.length) {
      const displayTime = slot.actual_time || slot.target_time;
      const warning =
        `[SYNC] date=${date} slot_index=${slot.slot_index} (${displayTime}): ` +
        `no site reservation at position ${i} — DB record unchanged`;
      logger.warn(warning);
      warnings.push(warning);
      notFound++;
      continue;
    }

    const site = sortedSite[i];

    // Rule 0: Warn if the site reservation has fewer than 4 players.
    // This indicates a bad booking that should be cancelled and rebooked.
    // We do not auto-cancel here — the operator should run cancel-1player.js.
    const sitePlayers = typeof site.players === 'number' ? site.players : null;
    if (sitePlayers !== null && sitePlayers < 4) {
      const warning =
        `[SYNC] WARN: date=${date} slot_index=${slot.slot_index} (${slot.actual_time || slot.target_time}): ` +
        `site reservation Res#${site.confirmationNumber} shows only ${sitePlayers} player(s) — ` +
        `expected 4. Run cancel-1player.js to fix.`;
      logger.warn(warning);
      warnings.push(warning);
    }

    // Determine whether an update is needed.
    //
    // Rule 1: actual_time differs from site time.
    const timeDiffers = slot.actual_time !== site.time;

    // Rule 2: DB has a placeholder and site provides a real numeric value (FR-015),
    //         OR the confirmation numbers simply differ for any other reason.
    const dbConfirmation = slot.confirmation_number;
    const siteConfirmation = site.confirmationNumber;
    const confirmationDiffers =
      isRealConfirmationNumber(siteConfirmation) &&
      (isPlaceholder(dbConfirmation) || dbConfirmation !== siteConfirmation);

    if (!timeDiffers && !confirmationDiffers) {
      // Already in sync — skip write.
      logger.info(
        `[SYNC] date=${date} slot_index=${slot.slot_index}: OK ` +
        `actual_time=${slot.actual_time} confirmation_number=${slot.confirmation_number}`
      );
      continue;
    }

    // Log the change before writing.
    logger.info(
      `[SYNC] Updated booking #${slot.id} date ${date} slot ${slot.slot_index}: ` +
      `actual_time ${slot.actual_time ?? 'null'} \u2192 ${site.time}, ` +
      `confirmation_number ${dbConfirmation ?? 'null'} \u2192 ${siteConfirmation}`
    );

    await db.updateBookingSync(slot.id, {
      actualTime: site.time,
      course: site.course,
      confirmationNumber: siteConfirmation,
      restoreConfirmed: true,
    });

    updated.count++;
  }

  return { updated: updated.count, notFound, warnings };
}

module.exports = { reconcileDate };
