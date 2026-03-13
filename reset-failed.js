#!/usr/bin/env node
/**
 * reset-failed.js
 *
 * Resets over-retried failed slots (attempts > maxRetries=3) so the booking
 * engine can retry them.  Also resets EXISTING_RESERVATION placeholder
 * "confirmed" rows so they get re-verified / re-booked.
 *
 * Affected date range: 2026-03-16 onward (current and future dates only).
 */

const db     = require('./src/db');
const config = require('./src/config');
const fs     = require('fs');
const initSqlJs = require('sql.js');

async function main() {
  // Load the DB
  const sqlDb = await db.getDb();

  // ── Reset 1: failed rows from 2026-03-16 onward ──────────────────────────
  sqlDb.run(`
    UPDATE bookings
    SET status = 'pending',
        attempts = 0,
        error_message = NULL,
        updated_at = datetime('now')
    WHERE status = 'failed'
      AND date >= '2026-03-16'
  `);
  const failedChanges = sqlDb.getRowsModified();
  console.log(`Reset ${failedChanges} failed row(s) → pending`);

  // ── Reset 2: confirmed rows with EXISTING_RESERVATION placeholder ─────────
  // These were never properly verified and should be re-booked.
  sqlDb.run(`
    UPDATE bookings
    SET status = 'pending',
        attempts = 0,
        confirmation_number = NULL,
        error_message = NULL,
        updated_at = datetime('now')
    WHERE status = 'confirmed'
      AND confirmation_number = 'EXISTING_RESERVATION'
      AND date >= '2026-03-16'
  `);
  const existingChanges = sqlDb.getRowsModified();
  console.log(`Reset ${existingChanges} EXISTING_RESERVATION confirmed row(s) → pending`);

  // ── Persist to disk ───────────────────────────────────────────────────────
  const data   = sqlDb.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(config.dbPath, buffer);
  console.log(`Database persisted to ${config.dbPath}`);

  const totalReset = failedChanges + existingChanges;
  console.log(`\nTotal rows reset: ${totalReset}`);
}

main().catch(err => {
  console.error('reset-failed.js error:', err);
  process.exit(1);
});
