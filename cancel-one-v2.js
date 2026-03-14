#!/usr/bin/env node
/**
 * cancel-one-v2.js
 *
 * Cancels reservation #230352 (Sunday March 15, 11:20 AM, Pines, 1 golfer)
 * by navigating to the reservations history page, finding the card, and
 * using the UI to cancel it.
 *
 * The direct /reservation/history/230352/cancel URL doesn't work (redirects
 * to list) — so we find the reservation card by pagination and use the site
 * UI to cancel it.
 */

const SiteAutomation = require('./src/site');
const config         = require('./src/config');
const logger         = require('./src/logger');

async function main() {
  const golfer = config.golfers[0];
  logger.info(`Logging in as ${golfer.email}`);

  const site = new SiteAutomation({ email: golfer.email, password: golfer.password });

  try {
    await site.init();
    await site.navigateToBooking(config.site.courses.pines.id, '2026-03-15');
    await site.login();

    const baseUrl = config.site.memberUrl;

    // Navigate to reservation history
    logger.info('Navigating to reservation history...');
    await site.page.goto(`${baseUrl}/reservation/history`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await site.page.waitForTimeout(3000);

    // Search through pages to find March 15 card
    logger.info('Searching for March 15 reservation (Res#230352)...');
    let found = false;
    for (let pageNum = 1; pageNum <= 25 && !found; pageNum++) {
      // Check current page for date mention
      const pageText = await site.page.evaluate(() => document.body.innerText || '');
      if (/march\s+15|mar\s+15/i.test(pageText) || /230352/.test(pageText)) {
        logger.info(`Found March 15 content on page ${pageNum}`);
        found = true;
        break;
      }

      // Try to click NEXT
      const hasNext = await site.page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const nextBtn = btns.find(b => /^next$/i.test((b.textContent || '').trim()) && !b.disabled);
        if (nextBtn) { nextBtn.click(); return true; }
        return false;
      });

      if (!hasNext) {
        logger.info(`No more pages after page ${pageNum}`);
        break;
      }
      await site.page.waitForTimeout(2000);
      logger.info(`Moved to page ${pageNum + 1}`);
    }

    if (!found) {
      logger.warn('Could not find March 15 reservation in upcoming list. It may be in Past.');
      // Try switching to Past view
      await site.page.evaluate(() => {
        const toggle = document.querySelector('input[type="checkbox"]') ||
                       document.querySelector('[role="switch"]');
        if (toggle) toggle.click();
      });
      await site.page.waitForTimeout(2000);
    }

    // Try to find VIEW DETAILS buttons and look for the right one
    const cardCount = await site.page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .filter(b => /view details/i.test(b.textContent || '')).length
    ).catch(() => 0);
    logger.info(`Found ${cardCount} VIEW DETAILS button(s) on current page`);

    for (let idx = 0; idx < cardCount; idx++) {
      const clicked = await site.page.evaluate((skip) => {
        const btns = [...document.querySelectorAll('button')]
          .filter(b => /view details/i.test(b.textContent || ''));
        if (btns[skip]) { btns[skip].click(); return true; }
        return false;
      }, idx);

      if (!clicked) break;
      await site.page.waitForTimeout(2000);

      const detailText = await site.page.evaluate(() => document.body.innerText || '');
      const urlStr = site.page.url();
      logger.info(`Detail page ${idx + 1}: URL=${urlStr}`);

      if (/230352/.test(urlStr) || /11:20|11:20\s*AM/i.test(detailText)) {
        logger.info('Found reservation #230352! Page text preview:');
        logger.info(detailText.slice(0, 500));

        // Try to find a Cancel button on this page
        const cancelClicked = await site.page.evaluate(() => {
          const allBtns = [...document.querySelectorAll('button, [role="button"], a')];
          for (const btn of allBtns) {
            const text = (btn.textContent || '').trim();
            if (/cancel/i.test(text) && !/cancellation/i.test(text)) {
              btn.click();
              return text;
            }
          }
          return null;
        });

        if (cancelClicked) {
          logger.info(`Clicked: "${cancelClicked}"`);
          await site.page.waitForTimeout(3000);
          await site.screenshot('cancel-230352-after-click');
          const afterText = await site.page.evaluate(() => document.body.innerText.slice(0, 1000));
          logger.info(`After cancel click: ${afterText.slice(0, 300)}`);

          // Try to find "Submit Cancellation" or confirm button
          const submitClicked = await site.page.evaluate(() => {
            const btns = [...document.querySelectorAll('button, [role="button"]')];
            for (const btn of btns) {
              if (/submit.*cancel|confirm.*cancel|yes.*cancel/i.test(btn.textContent || '')) {
                btn.click();
                return btn.textContent.trim();
              }
            }
            return null;
          });
          if (submitClicked) {
            logger.info(`Submitted cancellation: "${submitClicked}"`);
            await site.page.waitForTimeout(5000);
            await site.screenshot('cancel-230352-submitted');
          }
        } else {
          logger.warn('No Cancel button found on detail page');
          await site.screenshot('cancel-230352-no-button');
        }
        break;
      }

      // Go back to list
      await site.page.goBack({ waitUntil: 'domcontentloaded' }).catch(async () => {
        await site.page.goto(`${baseUrl}/reservation/history`, {
          waitUntil: 'domcontentloaded', timeout: 20000,
        });
      });
      await site.page.waitForTimeout(1500);
    }

    logger.info('Done.');
  } finally {
    await site.close();
  }
}

main().catch(err => {
  logger.error('cancel-one-v2.js error: ' + err.message);
  console.error(err);
  process.exit(1);
});
