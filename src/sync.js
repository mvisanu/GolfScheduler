'use strict';

/**
 * sync.js
 *
 * Exports runSync(siteInstance?) — the central sync orchestrator.
 *
 * Orchestration flow:
 *   1. Obtain an authenticated SiteAutomation session (create one if none provided).
 *   2. Step 1 — Scrape the visible upcoming reservation list via
 *      site.scrapeReservationHistory(). Build a date-keyed map of site slots.
 *   3. Step 2 — Identify DB bookings still carrying placeholder confirmation
 *      numbers. Collect known real numeric IDs from other DB records. For each
 *      known ID, probe ±PROBE_RADIUS IDs via site.fetchReservationById(). Add
 *      any results for dates not already covered by Step 1 into the map.
 *   4. For each date in the combined map, load the matching DB rows and call
 *      reconcileDate() from src/reconcile.js.
 *   5. FR-012 WARN — for any confirmed DB booking with a real numeric
 *      confirmation number whose date was visible to Step 1 but no matching
 *      site reservation was found, emit a WARN log.
 *   6. Persist db.setLastSyncAt() with the current ISO timestamp.
 *   7. Return { checked, updated, warnings, errors }.
 *
 * Session sharing:
 *   - If siteInstance is null, creates a new SiteAutomation, calls init() and
 *     login(), and closes the browser in a finally block.
 *   - If siteInstance is provided (e.g. from the daily scheduler), assumes the
 *     session is already authenticated and skips init/login/close.
 */

const db = require('./db');
const SiteAutomation = require('./site');
const { reconcileDate } = require('./reconcile');
const logger = require('./logger');
const config = require('./config');

/**
 * How many IDs above and below a known confirmation number to probe when
 * searching for reservations not visible in the list view.
 */
const PROBE_RADIUS = 10;

/**
 * Placeholder confirmation numbers that indicate a DB row still needs a real
 * confirmation number from the site.  Mirrors the set in reconcile.js.
 */
const PLACEHOLDER_CONFIRMATION_NUMBERS = new Set([
  'EXISTING_RESERVATION',
  'CONFIRMED',
  'access',
]);

/**
 * Returns true when a confirmation number is a known placeholder or is
 * otherwise not a real numeric reservation ID.
 *
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
function isPlaceholder(value) {
  if (!value) return true;
  if (PLACEHOLDER_CONFIRMATION_NUMBERS.has(value)) return true;
  // Any non-numeric string is also treated as a placeholder.
  return !/^\d+$/.test(value);
}

/**
 * Main sync orchestrator.
 *
 * @param {SiteAutomation|null} [siteInstance=null]
 *   An already-authenticated SiteAutomation instance to reuse, or null to have
 *   runSync() create and manage its own browser session.
 *
 * @returns {Promise<{ checked: number, updated: number, warnings: number, errors: number }>}
 */
async function runSync(siteInstance = null) {
  const startTime = new Date();
  logger.info(`[SYNC] Starting sync at ${startTime.toISOString()}`);

  const ownsSession = siteInstance === null;
  /** @type {SiteAutomation} */
  let site = siteInstance;

  // Counters for the summary object.
  let totalUpdated = 0;
  let totalWarnings = 0;
  let totalErrors = 0;
  /** @type {Set<string>} dates examined (Step 1 + Step 2 combined) */
  const checkedDates = new Set();

  try {
    if (!ownsSession) {
      logger.info('[SYNC] Reusing provided SiteAutomation session');
    }

    // ── Load all upcoming DB bookings once (avoids repeated queries) ─────────
    await db.getDb();
    const allUpcoming = await db.getAllUpcoming();
    logger.info(`[SYNC] Loaded ${allUpcoming.length} upcoming DB booking(s)`);

    // Build a date-keyed index of DB rows for fast lookup during reconciliation.
    /** @type {Map<string, object[]>} date → DB booking rows */
    const dbByDate = new Map();
    for (const booking of allUpcoming) {
      if (!dbByDate.has(booking.date)) dbByDate.set(booking.date, []);
      dbByDate.get(booking.date).push(booking);
    }

    // ── Step 1: Scrape visible reservation list ───────────────────────────────
    // When ownsSession=true, scrape every configured golfer account so that
    // reservations booked under any golfer (round-robin rotation) are captured.
    // When a session is provided (scheduler path), scrape only that session.
    /** @type {Array<{ date: string, time: string, course: string, confirmationNumber: string }>} */
    let listReservations = [];

    if (ownsSession) {
      const today = new Date().toISOString().slice(0, 10);
      logger.info(`[SYNC] Step 1: Scraping reservations for ${config.golfers.length} golfer account(s)...`);

      for (let gi = 0; gi < config.golfers.length; gi++) {
        const golfer = config.golfers[gi];
        const gSite = new SiteAutomation({ email: golfer.email, password: golfer.password });
        try {
          await gSite.init();
          await gSite.navigateToBooking(config.site.courses.pines.id, today);
          await gSite.login();
          logger.info(`[SYNC] Step 1: Logged in as golfer ${gi} (${golfer.email})`);

          const golferRes = await gSite.scrapeReservationHistory();
          logger.info(`[SYNC] Step 1: Golfer ${gi} — ${golferRes.length} reservation(s) found`);

          for (const r of golferRes) {
            // Deduplicate by confirmation number across accounts.
            if (!listReservations.some(x => x.confirmationNumber === r.confirmationNumber)) {
              listReservations.push(r);
            }
          }
        } catch (err) {
          logger.error(`[SYNC] Step 1: Golfer ${gi} (${golfer.email}) failed: ${err.message}`);
          totalErrors++;
        } finally {
          try { await gSite.close(); } catch {}
        }
      }
    } else {
      // Shared session provided — scrape as that account only.
      try {
        listReservations = await site.scrapeReservationHistory();
      } catch (err) {
        logger.error(`[SYNC] Step 1 scrape failed: ${err.message}`);
        totalErrors++;
      }
    }

    logger.info(`[SYNC] Step 1: Found ${listReservations.length} reservation(s) total across all accounts`);

    // Group Step 1 results by date.
    /** @type {Map<string, Array<{ date, time, course, confirmationNumber }>>} */
    const siteByDate = new Map();
    for (const r of listReservations) {
      if (!r.date) continue;
      if (!siteByDate.has(r.date)) siteByDate.set(r.date, []);
      siteByDate.get(r.date).push(r);
    }

    // Track which dates were visible in Step 1 for FR-012 WARN logic below.
    /** @type {Set<string>} */
    const step1VisibleDates = new Set(siteByDate.keys());

    // ── Step 2: Direct ID probing for dates still missing real confirmation numbers ──
    //
    // Identify DB rows that still carry a placeholder confirmation number.
    const placeholderRows = allUpcoming.filter(
      b =>
        ['confirmed', 'pending', 'cancelled'].includes(b.status) &&
        isPlaceholder(b.confirmation_number)
    );
    const datesToProbe = new Set(
      placeholderRows
        .map(b => b.date)
        .filter(d => !siteByDate.has(d)) // only dates NOT already covered by Step 1
    );

    if (datesToProbe.size > 0) {
      logger.info(
        `[SYNC] Step 2: ${datesToProbe.size} date(s) still need probing: ${[...datesToProbe].sort().join(', ')}`
      );

      // Collect all known real numeric confirmation numbers from DB records.
      const knownIds = allUpcoming
        .filter(b => b.confirmation_number && /^\d+$/.test(b.confirmation_number))
        .map(b => parseInt(b.confirmation_number, 10));

      if (knownIds.length === 0) {
        logger.info('[SYNC] Step 2: No known numeric confirmation IDs to probe around — skipping');
      } else {
        // Map of date → reservations found via direct probe.
        /** @type {Map<string, Array<{ date, time, course, confirmationNumber }>>} */
        const probeByDate = new Map();
        let totalProbeHits = 0;

        if (ownsSession) {
          // When running standalone, probe per-golfer so each account can only
          // see its own reservation detail pages.
          const today = new Date().toISOString().slice(0, 10);

          for (let gi = 0; gi < config.golfers.length; gi++) {
            const golfer = config.golfers[gi];

            // Only probe for dates that have at least one DB row assigned to this golfer.
            const golferDatesToProbe = [...datesToProbe].filter(d => {
              const rows = dbByDate.get(d) || [];
              return rows.some(b => (b.golfer_index || 0) === gi);
            });
            if (golferDatesToProbe.length === 0) continue;

            // Collect known IDs from THIS golfer's confirmed bookings.
            const golferKnownIds = allUpcoming
              .filter(b => (b.golfer_index || 0) === gi && b.confirmation_number && /^\d+$/.test(b.confirmation_number))
              .map(b => parseInt(b.confirmation_number, 10));

            if (golferKnownIds.length === 0) {
              logger.info(`[SYNC] Step 2: Golfer ${gi} — no known IDs to probe around`);
              continue;
            }

            const probeIdSet = new Set();
            for (const id of golferKnownIds) {
              for (let delta = -PROBE_RADIUS; delta <= PROBE_RADIUS; delta++) {
                const candidate = id + delta;
                if (candidate > 0) probeIdSet.add(candidate);
              }
            }
            const sortedProbeIds = [...probeIdSet].sort((a, b) => a - b);

            logger.info(
              `[SYNC] Step 2: Golfer ${gi} (${golfer.email}) — probing ${sortedProbeIds.length} ID(s) for dates: ${golferDatesToProbe.sort().join(', ')}`
            );

            const gSite = new SiteAutomation({ email: golfer.email, password: golfer.password });
            try {
              await gSite.init();
              await gSite.navigateToBooking(config.site.courses.pines.id, today);
              await gSite.login();

              let golferHits = 0;
              for (const id of sortedProbeIds) {
                let res = null;
                try {
                  res = await gSite.fetchReservationById(id);
                } catch (err) {
                  logger.warn(`[SYNC] Step 2: Golfer ${gi} fetchReservationById(${id}) threw: ${err.message}`);
                  totalErrors++;
                  continue;
                }

                if (!res || !res.date || !res.time) continue;
                if (!datesToProbe.has(res.date)) continue;

                if (!probeByDate.has(res.date)) probeByDate.set(res.date, []);
                const existing = probeByDate.get(res.date);
                if (!existing.some(r => r.confirmationNumber === res.confirmationNumber)) {
                  logger.info(
                    `[SYNC] Step 2: Golfer ${gi} found ID ${id}: ${res.date} ${res.time} ${res.course} Res#${res.confirmationNumber}`
                  );
                  existing.push(res);
                  golferHits++;
                  totalProbeHits++;
                }
              }
              logger.info(`[SYNC] Step 2: Golfer ${gi} probe complete — ${golferHits} new reservation(s)`);
            } catch (err) {
              logger.error(`[SYNC] Step 2: Golfer ${gi} session failed: ${err.message}`);
              totalErrors++;
            } finally {
              try { await gSite.close(); } catch {}
            }
          }
        } else {
          // Shared session provided — probe using that single session.
          const probeIdSet = new Set();
          for (const id of knownIds) {
            for (let delta = -PROBE_RADIUS; delta <= PROBE_RADIUS; delta++) {
              const candidate = id + delta;
              if (candidate > 0) probeIdSet.add(candidate);
            }
          }
          const sortedProbeIds = [...probeIdSet].sort((a, b) => a - b);

          logger.info(
            `[SYNC] Step 2: Probing ${sortedProbeIds.length} ID(s) around ${knownIds.length} known confirmation number(s)...`
          );

          for (const id of sortedProbeIds) {
            let res = null;
            try {
              res = await site.fetchReservationById(id);
            } catch (err) {
              logger.warn(`[SYNC] Step 2: fetchReservationById(${id}) threw: ${err.message}`);
              totalErrors++;
              continue;
            }

            if (!res || !res.date || !res.time) continue;
            if (!datesToProbe.has(res.date)) continue;

            if (!probeByDate.has(res.date)) probeByDate.set(res.date, []);
            const existing = probeByDate.get(res.date);
            if (!existing.some(r => r.confirmationNumber === res.confirmationNumber)) {
              logger.info(
                `[SYNC] Step 2: Found ID ${id}: ${res.date} ${res.time} ${res.course} Res#${res.confirmationNumber}`
              );
              existing.push(res);
              totalProbeHits++;
            }
          }
        }

        logger.info(`[SYNC] Step 2: Probe complete — ${totalProbeHits} new reservation(s) found`);

        // Merge probe results into the combined siteByDate map.
        for (const [date, slots] of probeByDate.entries()) {
          if (!siteByDate.has(date)) {
            siteByDate.set(date, slots);
          } else {
            const current = siteByDate.get(date);
            for (const s of slots) {
              if (!current.some(r => r.confirmationNumber === s.confirmationNumber)) {
                current.push(s);
              }
            }
          }
        }

        // Log dates that probing could not resolve.
        const stillMissing = [...datesToProbe].filter(d => !probeByDate.has(d));
        if (stillMissing.length > 0) {
          logger.info(
            `[SYNC] Step 2: Could not find site data for: ${stillMissing.sort().join(', ')} ` +
            `(may be beyond the site display window or use unknown reservation IDs)`
          );
        }
      }
    } else {
      logger.info('[SYNC] Step 2: No dates need direct probing');
    }

    // ── Reconcile each date ───────────────────────────────────────────────────
    logger.info(`[SYNC] Reconciling ${siteByDate.size} date(s)...`);

    for (const [date, siteSlots] of siteByDate.entries()) {
      checkedDates.add(date);
      const dbSlots = dbByDate.get(date) || [];

      let result;
      try {
        result = await reconcileDate(date, siteSlots, dbSlots, logger);
      } catch (err) {
        logger.error(`[SYNC] reconcileDate(${date}) threw: ${err.message}`);
        totalErrors++;
        continue;
      }

      totalUpdated += result.updated;
      totalWarnings += result.warnings.length;

      if (result.notFound > 0) {
        logger.warn(
          `[SYNC] date=${date}: ${result.notFound} DB slot(s) had no matching site reservation at their position`
        );
      }
    }

    // ── FR-012: Warn about confirmed bookings with real numeric confirmation
    //    numbers that were visible to Step 1 but not found on the site ─────────
    //
    // A booking qualifies for this warning when ALL of:
    //   a) status = 'confirmed'
    //   b) confirmation_number is a real numeric ID
    //   c) the booking's date appeared in the Step 1 visible window
    //   d) the site returned ZERO slots for that date (i.e. no entry in siteByDate
    //      for that date), OR the positional reconciliation left this booking
    //      unmatched (notFound path — already warned inside reconcileDate, but we
    //      emit an additional higher-visibility WARN here per FR-012).
    //
    // We focus on the "date was visible but site had NO reservations at all" case
    // since the positional-mismatch case is already warned inside reconcileDate().
    const fr012Candidates = allUpcoming.filter(
      b =>
        b.status === 'confirmed' &&
        b.confirmation_number &&
        /^\d+$/.test(b.confirmation_number) &&
        step1VisibleDates.has(b.date) &&
        !siteByDate.has(b.date)
    );

    for (const booking of fr012Candidates) {
      const msg =
        `[SYNC] WARN: booking #${booking.id} date ${booking.date} slot ${booking.slot_index}: ` +
        `DB shows confirmed Res#${booking.confirmation_number} but not found on site — manual review required`;
      logger.warn(msg);
      totalWarnings++;
    }

  } finally {
    // When ownsSession=true, each per-golfer session is opened and closed
    // inside the Step 1 / Step 2 loops above — nothing to close here.
    // When a shared session was provided, the caller owns its lifecycle.
    if (!ownsSession && site) {
      // (caller closes the shared session — no action needed)
    }
  }

  // ── Persist last sync timestamp ──────────────────────────────────────────
  try {
    db.setLastSyncAt(new Date().toISOString());
  } catch (err) {
    logger.error(`[SYNC] Failed to write sync-meta.json: ${err.message}`);
    totalErrors++;
  }

  const endTime = new Date();
  const elapsedMs = endTime - startTime;
  const summary = {
    checked: checkedDates.size,
    updated: totalUpdated,
    warnings: totalWarnings,
    errors: totalErrors,
  };

  logger.info(
    `[SYNC] Completed in ${elapsedMs}ms — ` +
    `checked=${summary.checked} updated=${summary.updated} warnings=${summary.warnings} errors=${summary.errors}`
  );

  return summary;
}

module.exports = { runSync };
