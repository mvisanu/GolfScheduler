#!/usr/bin/env node
/**
 * check-reservation.js
 *
 * Checks if reservation #230352 exists/is accessible under each golfer account
 * by navigating to its detail page and checking the content.
 */

const SiteAutomation = require('./src/site');
const config         = require('./src/config');
const logger         = require('./src/logger');

async function checkForGolfer(golfer, golferIndex) {
  const site = new SiteAutomation({ email: golfer.email, password: golfer.password });
  logger.info(`\n=== Checking as Golfer ${golferIndex} (${golfer.email}) ===`);

  try {
    await site.init();
    await site.navigateToBooking(config.site.courses.pines.id, '2026-03-15');
    await site.login();

    // Try to navigate to the reservation detail page
    const detailUrl = `${config.site.memberUrl}/reservation/history/230352`;
    logger.info(`Navigating to: ${detailUrl}`);
    await site.page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await site.page.waitForTimeout(3000);

    const pageText = await site.page.evaluate(() => document.body.innerText.slice(0, 2000));
    const finalUrl = site.page.url();
    logger.info(`Final URL: ${finalUrl}`);
    logger.info(`Page text preview: ${pageText.slice(0, 300)}`);

    const found = /230352|11:20|March 15/i.test(pageText);
    const isCancelable = /cancellation request|cancel.*reservation/i.test(pageText);
    logger.info(`Reservation found: ${found}, Cancelable: ${isCancelable}`);

    return { golferIndex, email: golfer.email, found, isCancelable };
  } finally {
    await site.close();
  }
}

async function main() {
  for (let i = 0; i < config.golfers.length; i++) {
    const result = await checkForGolfer(config.golfers[i], i);
    console.log(`Golfer ${result.golferIndex} (${result.email}): found=${result.found}, cancelable=${result.isCancelable}`);
  }
}

main().catch(err => {
  logger.error('check-reservation.js error: ' + err.message);
  console.error(err);
  process.exit(1);
});
