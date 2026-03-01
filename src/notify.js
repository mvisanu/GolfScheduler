const logger = require('./logger');

/**
 * Notification module — logs alerts to console and log file.
 * Can be extended with email/SMS/Slack integrations.
 */

function alertPartialBooking({ date, dayLabel, bookedSlots, totalSlots, screenshotPath }) {
  const msg = [
    '========== PARTIAL BOOKING ALERT ==========',
    `Date: ${date} (${dayLabel})`,
    `Booked: ${bookedSlots}/${totalSlots} slots`,
    `Screenshot: ${screenshotPath || 'N/A'}`,
    'Action required: Complete remaining slots manually.',
    `Phone: 850-833-9664 | Email: jhill2@fwb.org`,
    '============================================',
  ].join('\n');

  logger.warn(msg);
  console.log('\n' + msg + '\n');
}

function alertBlocked({ screenshotPath, error }) {
  const msg = [
    '!!!!!!!!!! SECURITY BLOCK DETECTED !!!!!!!!!!',
    `Error: ${error}`,
    `Screenshot: ${screenshotPath || 'N/A'}`,
    'Bot has stopped. Manual intervention required.',
    'Do NOT retry automatically — check the site first.',
    '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
  ].join('\n');

  logger.error(msg);
  console.error('\n' + msg + '\n');
}

function alertSuccess({ date, dayLabel, slots, course }) {
  logger.info(`BOOKED: ${date} (${dayLabel}) — ${slots} slots on ${course}`);
}

function alertFailure({ date, dayLabel, error }) {
  logger.error(`FAILED: ${date} (${dayLabel}) — ${error}`);
}

module.exports = { alertPartialBooking, alertBlocked, alertSuccess, alertFailure };
