#!/usr/bin/env node
/**
 * reset-to-golfer1.js
 *
 * After cancel-1player.js runs, this script:
 *  1. Resets all `cancelled` and `failed` rows from 2026-03-16 onward back to
 *     `pending` so the booking engine will rebook them.
 *  2. Forces golfer_index=0 on all pending rows from 2026-03-16 onward so that
 *     every rebooking is made under Golfer 1 (mvisanu@gmail.com).
 *  3. Persists the updated DB to disk.
 *
 * Usage:  node reset-to-golfer1.js
 */

require('dotenv').config();
const fs = require('fs');
const db = require('./src/db');
const config = require('./src/config');

const FROM_DATE = '2026-03-16';

async function main() {
  const sqlDb = await db.getDb();

  // 1. Reset cancelled rows → pending (so they get rebooked)
  sqlDb.run(`
    UPDATE bookings
    SET status        = 'pending',
        attempts      = 0,
        error_message = NULL,
        golfer_index  = 0,
        updated_at    = datetime('now')
    WHERE status = 'cancelled'
      AND date >= ?
  `, [FROM_DATE]);
  const cancelledReset = sqlDb.getRowsModified();
  console.log(`Cancelled → pending: ${cancelledReset} row(s)`);

  // 2. Reset failed rows → pending
  sqlDb.run(`
    UPDATE bookings
    SET status        = 'pending',
        attempts      = 0,
        error_message = NULL,
        golfer_index  = 0,
        updated_at    = datetime('now')
    WHERE status = 'failed'
      AND date >= ?
  `, [FROM_DATE]);
  const failedReset = sqlDb.getRowsModified();
  console.log(`Failed → pending: ${failedReset} row(s)`);

  // 3. Reassign all remaining pending rows to golfer 1
  sqlDb.run(`
    UPDATE bookings
    SET golfer_index = 0,
        updated_at   = datetime('now')
    WHERE status = 'pending'
      AND date >= ?
  `, [FROM_DATE]);
  const pendingReassigned = sqlDb.getRowsModified();
  console.log(`Pending rows reassigned to golfer_index=0: ${pendingReassigned} row(s)`);

  // Persist
  const data = sqlDb.export();
  fs.writeFileSync(config.dbPath, Buffer.from(data));
  console.log(`\nDB saved to ${config.dbPath}`);
  console.log(`Total rows modified: ${cancelledReset + failedReset + pendingReassigned}`);
}

main().catch(err => {
  console.error('reset-to-golfer1.js error:', err);
  process.exit(1);
});
