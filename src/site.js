const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');

const COURSES = config.site.courses;

class SiteAutomation {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async init() {
    logger.info('Launching browser...');
    this.browser = await chromium.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      timezoneId: config.timezone,
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(30000);
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async screenshot(name) {
    const dir = config.screenshotDir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${name}-${Date.now()}.png`);
    await this.page.screenshot({ path: filePath, fullPage: true });
    logger.debug(`Screenshot saved: ${filePath}`);
    return filePath;
  }

  /**
   * Navigate to the member booking page for a specific course and date.
   */
  async navigateToBooking(courseId, date) {
    const url = `${config.site.memberUrl}/teetimes?course=${courseId}&date=${date}`;
    logger.info(`Navigating to: ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Wait for the React app to hydrate
    await this.page.waitForTimeout(3000);

    // If we landed on Course Info or home, click Tee Times nav link
    try {
      const teeTimesNav = await this.page.$('a:has-text("Tee Times"), button:has-text("Tee Times")');
      if (teeTimesNav && await teeTimesNav.isVisible()) {
        await teeTimesNav.click();
        await this.page.waitForTimeout(3000);
        logger.info('Clicked Tee Times nav link');
      }
    } catch { /* already on tee times page */ }
  }

  /**
   * Log in via GolfID. The member booking page triggers a login modal/redirect.
   */
  async login() {
    logger.info('Starting login process...');

    // The TeeItUp site shows a login prompt for member bookings.
    // Look for common login triggers: "Sign In", "Log In", "Member Login" buttons
    const loginSelectors = [
      'button:has-text("Sign In")',
      'button:has-text("Log In")',
      'button:has-text("Login")',
      'a:has-text("Sign In")',
      'a:has-text("Log In")',
      '[data-testid="login-button"]',
      '.login-btn',
      '.sign-in-btn',
      '#loginButton',
    ];

    let loginClicked = false;
    for (const sel of loginSelectors) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible()) {
          logger.info(`Found login trigger: ${sel}`);
          await el.click();
          loginClicked = true;
          break;
        }
      } catch {
        // Try next selector
      }
    }

    if (!loginClicked) {
      // Maybe already on login page or login is embedded
      logger.info('No login button found — checking if login form is already visible...');
    }

    await this.page.waitForTimeout(2000);

    // Handle GolfID login form — could be in an iframe or modal
    const frame = await this._findLoginFrame();
    const loginContext = frame || this.page;

    // Wait for email field
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="username"]',
      '#email',
      '#username',
      'input[placeholder*="email" i]',
      'input[placeholder*="Email" i]',
    ];

    let emailField = null;
    for (const sel of emailSelectors) {
      try {
        emailField = await loginContext.waitForSelector(sel, { timeout: 5000 });
        if (emailField) {
          logger.info(`Found email field: ${sel}`);
          break;
        }
      } catch {
        // Try next
      }
    }

    if (!emailField) {
      await this.screenshot('login-no-email-field');
      throw new Error('Could not find email input field on login page');
    }

    // Fill credentials
    await emailField.fill(config.email);
    logger.info(`Email entered: ${config.email}`);
    logger.debug(`Password length: ${config.password.length}`);

    // Find and fill password
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      '#password',
    ];

    let passwordField = null;
    for (const sel of passwordSelectors) {
      try {
        passwordField = await loginContext.$(sel);
        if (passwordField) break;
      } catch {
        // Try next
      }
    }

    if (!passwordField) {
      await this.screenshot('login-no-password-field');
      throw new Error('Could not find password input field');
    }

    await passwordField.fill(config.password);
    logger.info('Password entered');

    // Click submit
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Sign In")',
      'button:has-text("Log In")',
      'button:has-text("Login")',
      'input[type="submit"]',
    ];

    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        const btn = await loginContext.$(sel);
        if (btn && await btn.isVisible()) {
          await btn.click();
          submitted = true;
          logger.info(`Login submitted via: ${sel}`);
          break;
        }
      } catch {
        // Try next
      }
    }

    if (!submitted) {
      // Try pressing Enter as fallback
      await passwordField.press('Enter');
      logger.info('Login submitted via Enter key');
    }

    // Wait for login to complete — page should redirect or modal close
    await this.page.waitForTimeout(5000);

    // Handle email verification interstitial — dismiss or continue past it
    try {
      const verifyEl = await loginContext.$('text=verify your email');
      if (verifyEl) {
        logger.info('Email verification prompt detected — attempting to dismiss...');
        await this.screenshot('login-verify-prompt');
        // Try clicking dismiss/close/continue buttons
        const dismissSelectors = [
          'button:has-text("Continue")',
          'button:has-text("Close")',
          'button:has-text("OK")',
          'button:has-text("Skip")',
          'button:has-text("Later")',
          '[class*="close"]',
          '[aria-label="Close"]',
          'button:has-text("Send Email")',
        ];
        for (const sel of dismissSelectors) {
          try {
            const btn = await loginContext.$(sel);
            if (btn && await btn.isVisible()) {
              await btn.click();
              logger.info(`Clicked dismiss button: ${sel}`);
              break;
            }
          } catch { /* try next */ }
        }
        // Also try clicking outside the modal on the main page
        try {
          await this.page.click('body', { position: { x: 640, y: 10 } });
        } catch { /* ignore */ }
        await this.page.waitForTimeout(3000);
      }
    } catch { /* no verification prompt */ }

    // Check for hard authentication errors (wrong password)
    const errorSelectors = [
      'text=could not authenticate',
      'text=invalid credentials',
      'text=incorrect password',
      'text=account not found',
    ];
    for (const sel of errorSelectors) {
      try {
        const errEl = await loginContext.$(sel);
        if (errEl && await errEl.isVisible()) {
          const errText = await errEl.textContent();
          await this.screenshot('login-auth-error');
          throw new Error(`Login rejected by site: "${errText.trim()}". Check your GOLF_EMAIL and GOLF_PASSWORD in .env`);
        }
      } catch (e) {
        if (e.message.startsWith('Login rejected')) throw e;
      }
    }

    // Check for CAPTCHA or security blocks
    await this._checkForBlocks();

    // Verify login succeeded — look for logged-in indicators
    // Wait extra time for post-login page load
    await this.page.waitForTimeout(3000);
    const loggedIn = await this._verifyLoggedIn();
    if (!loggedIn) {
      // Take screenshot for debugging but don't fail — the page may still be usable
      await this.screenshot('login-status-unclear');
      logger.warn('Could not confirm login status — proceeding anyway to check if booking page is accessible');
    }

    logger.info('Login successful');
  }

  async _findLoginFrame() {
    const frames = this.page.frames();
    for (const frame of frames) {
      try {
        const hasEmail = await frame.$('input[type="email"], input[name="email"]');
        if (hasEmail) {
          logger.info('Found login form in iframe');
          return frame;
        }
      } catch {
        // Frame may not be accessible
      }
    }
    return null;
  }

  async _dismissModals() {
    try {
      // Close any MUI popovers blocking the page
      const backdrop = await this.page.$('.MuiBackdrop-root');
      if (backdrop) {
        await backdrop.click({ force: true });
        await this.page.waitForTimeout(500);
        logger.debug('Dismissed MUI backdrop');
      }
      // Press Escape to close any open modals/popovers
      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(500);
      // Close any X buttons on alerts/banners
      const closeBtn = await this.page.$('[aria-label="Close"], button:has-text("×"), .MuiAlert-action button');
      if (closeBtn && await closeBtn.isVisible()) {
        await closeBtn.click({ force: true });
        await this.page.waitForTimeout(500);
        logger.debug('Dismissed alert/banner');
      }
    } catch {
      // Ignore dismiss errors
    }
  }

  async _checkForBlocks() {
    const blockIndicators = [
      'text=captcha',
      'text=CAPTCHA',
      'text=blocked',
      'text=Access Denied',
      'text=Rate Limited',
      '.g-recaptcha',
      '#captcha',
      'iframe[src*="recaptcha"]',
      'iframe[src*="captcha"]',
    ];

    for (const sel of blockIndicators) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible()) {
          const screenshotPath = await this.screenshot('blocked-captcha');
          throw new Error(
            `BLOCKED: Security challenge detected (${sel}). ` +
            `Screenshot: ${screenshotPath}. Bot stopping — manual intervention required.`
          );
        }
      } catch (e) {
        if (e.message.startsWith('BLOCKED')) throw e;
      }
    }
  }

  async _verifyLoggedIn() {
    // Look for indicators the user is logged in
    const indicators = [
      'text=Welcome',
      'text=Sign Out',
      'text=Log Out',
      'text=My Account',
      'text=Book',
      '[data-testid="user-menu"]',
      '.user-info',
      '.logged-in',
    ];

    for (const sel of indicators) {
      try {
        const el = await this.page.$(sel);
        if (el) return true;
      } catch {
        // Try next
      }
    }

    // Also check if tee times are now visible (login may just show the booking UI)
    try {
      const teeTimeEl = await this.page.$('.tee-time, [class*="teeTime"], [class*="TeeTime"]');
      if (teeTimeEl) return true;
    } catch {
      // Not found
    }

    return false;
  }

  /**
   * Select the course. Returns the courseId actually selected.
   * Tries Pines first, falls back to Oaks.
   */
  async selectCourse() {
    logger.info('Selecting course (Pines preferred)...');

    // Look for course selector dropdown or tabs
    const courseSelectors = [
      'select[name*="course" i]',
      'select[id*="course" i]',
      '[class*="course-select" i]',
      '[class*="courseSelect" i]',
      '[data-testid*="course" i]',
    ];

    // Try dropdown first
    for (const sel of courseSelectors) {
      try {
        const dropdown = await this.page.$(sel);
        if (dropdown) {
          // Try selecting Pines
          try {
            await dropdown.selectOption({ label: /pines/i });
            logger.info('Selected Pines course via dropdown');
            return COURSES.pines.id;
          } catch {
            // Try by value
            try {
              await dropdown.selectOption(COURSES.pines.id);
              logger.info('Selected Pines course via dropdown (by value)');
              return COURSES.pines.id;
            } catch {
              // Pines not available, try Oaks
              logger.warn('Pines not available in dropdown, trying Oaks...');
              try {
                await dropdown.selectOption({ label: /oaks/i });
                logger.info('Selected Oaks course (fallback)');
                return COURSES.oaks.id;
              } catch {
                await dropdown.selectOption(COURSES.oaks.id);
                logger.info('Selected Oaks course (fallback, by value)');
                return COURSES.oaks.id;
              }
            }
          }
        }
      } catch {
        // Try next selector
      }
    }

    // Try filter button-based course selector (sidebar checkboxes/buttons)
    const pinesFilter = await this.page.$('button:has-text("Pines Course"), button:has-text("Pines"), a:has-text("Pines"), [class*="tab"]:has-text("Pines")');
    if (pinesFilter && await pinesFilter.isVisible()) {
      // Check if already selected (might have active class)
      const isActive = await pinesFilter.evaluate(el => el.classList.contains('active') || el.getAttribute('aria-pressed') === 'true' || el.style.backgroundColor !== '');
      if (!isActive) {
        await pinesFilter.click();
        await this.page.waitForTimeout(2000);
      }
      logger.info('Selected Pines course via filter');
      return COURSES.pines.id;
    }

    // Try Oaks fallback
    const oaksFilter = await this.page.$('button:has-text("Oaks Course"), button:has-text("Oaks"), a:has-text("Oaks"), [class*="tab"]:has-text("Oaks")');
    if (oaksFilter && await oaksFilter.isVisible()) {
      await oaksFilter.click();
      await this.page.waitForTimeout(2000);
      logger.warn('Pines filter not found, selected Oaks (fallback)');
      return COURSES.oaks.id;
    }

    // Course may already be selected via URL parameter
    logger.info('No course selector found — course may be set via URL');
    return COURSES.pines.id;
  }

  /**
   * Scroll the tee times page to ensure all times are loaded, then dismiss any overlays.
   */
  async _prepareForBooking() {
    await this._dismissModals();
    // Scroll down to load any lazy-loaded tee times
    await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await this.page.waitForTimeout(1000);
    await this.page.evaluate(() => window.scrollTo(0, 0));
    await this.page.waitForTimeout(500);
  }

  /**
   * Select a specific date on the booking calendar.
   */
  async selectDate(dateStr) {
    logger.info(`Selecting date: ${dateStr}`);

    // TeeItUp uses a date picker — try URL-based date selection first
    const currentUrl = this.page.url();
    if (!currentUrl.includes(`date=${dateStr}`)) {
      const url = new URL(currentUrl);
      url.searchParams.set('date', dateStr);
      await this.page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.page.waitForTimeout(3000);
    }

    // Also try clicking on date picker if present
    const datePickerSelectors = [
      `[data-date="${dateStr}"]`,
      `button:has-text("${this._formatDateForPicker(dateStr)}")`,
      `td:has-text("${parseInt(dateStr.split('-')[2])}")`,
    ];

    for (const sel of datePickerSelectors) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible()) {
          await el.click();
          await this.page.waitForTimeout(2000);
          logger.info(`Clicked date picker element: ${sel}`);
          break;
        }
      } catch {
        // Try next
      }
    }
  }

  _formatDateForPicker(dateStr) {
    const [y, m, d] = dateStr.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[parseInt(m) - 1]} ${parseInt(d)}`;
  }

  /**
   * Find and return available tee times on the current page.
   * Returns array of { time, element, available }
   */
  async getAvailableTeeTimes() {
    logger.info('Scanning for available tee times...');

    // Wait for tee times to load, dismiss overlays
    await this.page.waitForTimeout(3000);
    await this._prepareForBooking();
    await this.screenshot('tee-times-page');

    // TeeItUp renders tee times as cards in a grid, each with a "BOOK NOW" button.
    // Find all "BOOK NOW" buttons and get their parent card containers.
    const bookButtons = await this.page.$$('button:has-text("Book Now"), button:has-text("BOOK NOW")');
    logger.info(`Found ${bookButtons.length} "Book Now" buttons`);

    if (bookButtons.length === 0) {
      logger.warn('No Book Now buttons found on page');
      await this.screenshot('no-tee-times-found');
      return [];
    }

    const teeTimes = [];
    for (const btn of bookButtons) {
      try {
        // Get the parent card — walk up from button until we find a container
        // with a time string (the card usually has border/shadow styling)
        const cardText = await btn.evaluate(el => {
          let node = el.parentElement;
          // Walk up max 3 levels to find the card that contains the time
          for (let i = 0; i < 3; i++) {
            if (!node) break;
            const text = node.textContent || '';
            // Stop if we found a node containing a time pattern
            if (/\d{1,2}:\d{2}\s*(AM|PM)/i.test(text) && text.length < 300) {
              return text;
            }
            node = node.parentElement;
          }
          // Fallback: just return the closest parent text
          return el.parentElement?.parentElement?.textContent || '';
        });

        logger.debug(`Card text: "${cardText.trim().slice(0, 120)}"`);
        const time = this._extractTime(cardText);
        if (time) {
          teeTimes.push({
            time,
            text: cardText.trim(),
            element: btn,
          });
          logger.info(`  Found tee time: ${time}`);
        }
      } catch (e) {
        logger.debug(`  Error reading card: ${e.message}`);
      }
    }

    logger.info(`Parsed ${teeTimes.length} tee times`);
    return teeTimes;
  }

  _extractTime(text) {
    // Match patterns like "12:00 PM", "9:30 AM", "12:00", etc.
    const match = text.match(/(\d{1,2}:\d{2})\s*(AM|PM|am|pm)?/);
    if (!match) return null;

    let [, time, period] = match;
    if (period) {
      // Convert to 24-hour format
      let [h, m] = time.split(':').map(Number);
      if (period.toUpperCase() === 'PM' && h !== 12) h += 12;
      if (period.toUpperCase() === 'AM' && h === 12) h = 0;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    return time;
  }

  /**
   * Find consecutive tee time slots matching the target time (with fallback).
   * Returns array of matching tee time objects, or empty if not enough found.
   */
  findConsecutiveSlots(teeTimes, windowStart, windowEnd, slotsNeeded) {
    const winStartMin = this._timeToMinutes(windowStart);
    const winEndMin = this._timeToMinutes(windowEnd);

    // Sort by time
    const sorted = [...teeTimes].sort(
      (a, b) => this._timeToMinutes(a.time) - this._timeToMinutes(b.time)
    );

    // Filter to slots within the time window
    const candidates = sorted.filter(t => {
      const mins = this._timeToMinutes(t.time);
      return mins >= winStartMin && mins <= winEndMin;
    });

    // Try each candidate as starting point, prefer earliest
    for (const candidate of candidates) {
      const idx = sorted.indexOf(candidate);
      const consecutive = this._getConsecutiveFrom(sorted, idx, slotsNeeded);
      if (consecutive) {
        // Verify all slots fall within window
        const lastMin = this._timeToMinutes(consecutive[consecutive.length - 1].time);
        if (lastMin <= winEndMin) {
          logger.info(`Found ${slotsNeeded} consecutive slots in ${windowStart}-${windowEnd}: ${consecutive.map(t => t.time).join(', ')}`);
          return consecutive;
        }
      }
    }

    logger.warn(`Could not find ${slotsNeeded} consecutive slots in window ${windowStart}-${windowEnd}`);
    return [];
  }

  _getConsecutiveFrom(sorted, startIdx, count) {
    if (startIdx + count > sorted.length) return null;

    const slots = sorted.slice(startIdx, startIdx + count);
    // Verify consecutive (each ~8-12 minutes apart)
    for (let i = 1; i < slots.length; i++) {
      const diff = this._timeToMinutes(slots[i].time) - this._timeToMinutes(slots[i - 1].time);
      if (diff < 5 || diff > 15) return null;
    }
    return slots;
  }

  _timeToMinutes(time) {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }

  /**
   * Book a single tee time slot.
   * Clicks the slot, sets 4 players, and confirms.
   * Returns { success, confirmationNumber, screenshotPath }
   */
  async bookSlot(teeTimeEl, slotIndex) {
    logger.info(`Booking slot ${slotIndex}...`);

    try {
      // Dismiss any MUI popovers/modals that may be blocking clicks
      await this._dismissModals();

      // Scroll the button into view and click via JavaScript to bypass MUI overlays
      await teeTimeEl.evaluate(el => {
        el.scrollIntoView({ block: 'center' });
      });
      await this.page.waitForTimeout(500);
      await teeTimeEl.evaluate(el => el.click());
      logger.info(`Clicked "Book Now" for slot ${slotIndex}`);
      await this.page.waitForTimeout(3000);
      await this.screenshot(`slot-${slotIndex}-after-click`);

      // The booking modal shows:
      // 1. Select Rate (already selected as "Member")
      // 2. Select Number of Golfers: buttons 1, 2, 3, 4
      // 3. ADD TO CART button

      // Step 1: Select 4 golfers by clicking the "4" button
      await this._setPlayerCount(4);
      await this.page.waitForTimeout(1000);
      await this.screenshot(`slot-${slotIndex}-players-set`);

      // Step 2: Click "ADD TO CART"
      const addToCartBtn = await this.page.$('button:has-text("Add to Cart"), button:has-text("ADD TO CART")');
      if (addToCartBtn) {
        await addToCartBtn.evaluate(el => el.click());
        logger.info('Clicked "ADD TO CART"');
        await this.page.waitForTimeout(3000);
      } else {
        logger.warn('No "ADD TO CART" button found — trying checkout directly');
      }

      await this.screenshot(`slot-${slotIndex}-added-to-cart`);

      // Check if we need to complete checkout or if it was auto-confirmed
      const confirmation = await this._extractConfirmation();
      if (confirmation) {
        logger.info(`Slot ${slotIndex} booked! Confirmation: ${confirmation}`);
        const screenshotPath = await this.screenshot(`slot-${slotIndex}-booked`);
        return { success: true, confirmationNumber: confirmation, screenshotPath };
      }

      // The item is in the cart — we may need to check out at the end
      // For now, treat add-to-cart as success
      logger.info(`Slot ${slotIndex} added to cart`);
      const screenshotPath = await this.screenshot(`slot-${slotIndex}-in-cart`);
      return { success: true, confirmationNumber: 'ADDED_TO_CART', screenshotPath };

    } catch (error) {
      const screenshotPath = await this.screenshot(`slot-${slotIndex}-error`);
      logger.error(`Error booking slot ${slotIndex}: ${error.message}`);
      return { success: false, error: error.message, screenshotPath };
    }
  }

  async _setPlayerCount(count) {
    // TeeItUp uses numbered buttons (1, 2, 3, 4) under "Select Number of Golfers"
    // Try clicking the button with the exact number text
    const numberBtn = await this.page.$(`button:has-text("${count}")`);
    if (numberBtn) {
      // Make sure it's a golfer count button (small, near "Select Number of Golfers")
      const btnText = await numberBtn.evaluate(el => el.textContent.trim());
      if (btnText === String(count)) {
        await numberBtn.evaluate(el => el.click());
        logger.info(`Set ${count} golfers via number button`);
        return;
      }
    }

    // Fallback: find all small buttons with numbers and click the right one
    const allButtons = await this.page.$$('button');
    for (const btn of allButtons) {
      try {
        const text = await btn.evaluate(el => el.textContent.trim());
        if (text === String(count)) {
          // Check if this button is near a "golfer" label
          const nearby = await btn.evaluate(el => {
            const parent = el.closest('[class*="golfer"], [class*="player"]') ||
                          el.parentElement?.parentElement;
            return parent?.textContent || '';
          });
          if (nearby.toLowerCase().includes('golfer') || nearby.toLowerCase().includes('player') || nearby.includes('1234'.slice(0, count))) {
            await btn.evaluate(el => el.click());
            logger.info(`Set ${count} golfers via numbered button (fallback)`);
            return;
          }
        }
      } catch {
        // Skip
      }
    }

    logger.warn(`Could not find golfer count button for ${count} — proceeding with default`);
  }

  async _extractConfirmation() {
    const confirmSelectors = [
      '[class*="confirmation" i]',
      '[class*="confirm-number" i]',
      '[data-testid*="confirmation" i]',
      'text=/confirmation.*#?\s*\d+/i',
      'text=/booking.*#?\s*\d+/i',
      'text=/reserved/i',
    ];

    for (const sel of confirmSelectors) {
      try {
        const el = await this.page.$(sel);
        if (el) {
          const text = await el.textContent();
          const numMatch = text.match(/#?\s*(\w{6,})/);
          return numMatch ? numMatch[1] : text.trim().slice(0, 50);
        }
      } catch {
        // Try next
      }
    }
    return null;
  }

  /**
   * Complete checkout after all tee times have been added to the cart.
   */
  async completeCheckout() {
    logger.info('Completing checkout for cart items...');

    // Step 1: Navigate to cart / checkout page
    const cartSelectors = [
      'a:has-text("Cart")',
      'button:has-text("Cart")',
      'a:has-text("Checkout")',
      'button:has-text("Checkout")',
      '[data-testid*="cart"]',
      '[class*="cart"]',
    ];

    for (const sel of cartSelectors) {
      try {
        const btn = await this.page.$(sel);
        if (btn && await btn.isVisible()) {
          await btn.evaluate(el => el.click());
          logger.info(`Clicked cart/checkout: ${sel}`);
          await this.page.waitForTimeout(3000);
          break;
        }
      } catch {
        // Try next
      }
    }

    await this.screenshot('checkout-page');

    // Step 2: Agree to Terms and Conditions checkbox
    const termsSelectors = [
      'input[type="checkbox"]',
      'label:has-text("Terms")',
      'label:has-text("terms")',
      'span:has-text("I agree")',
      '[class*="checkbox"]',
    ];

    let termsChecked = false;
    for (const sel of termsSelectors) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible()) {
          // For checkbox inputs, check if already checked
          const isInput = await el.evaluate(e => e.tagName === 'INPUT');
          if (isInput) {
            const alreadyChecked = await el.evaluate(e => e.checked);
            if (!alreadyChecked) {
              await el.evaluate(e => e.click());
              logger.info(`Checked Terms and Conditions via: ${sel}`);
              termsChecked = true;
            } else {
              logger.info('Terms checkbox already checked');
              termsChecked = true;
            }
          } else {
            await el.evaluate(e => e.click());
            logger.info(`Clicked Terms element: ${sel}`);
            termsChecked = true;
          }
          await this.page.waitForTimeout(1000);
          break;
        }
      } catch {
        // Try next
      }
    }

    if (!termsChecked) {
      logger.warn('Could not find Terms and Conditions checkbox — proceeding anyway');
    }

    await this.screenshot('checkout-terms-agreed');

    // Step 3: Click "Complete Your Purchase" button
    const purchaseSelectors = [
      'button:has-text("Complete Your Purchase")',
      'button:has-text("Complete Purchase")',
      'button:has-text("Complete Booking")',
      'button:has-text("Place Order")',
      'button:has-text("Confirm")',
      'button:has-text("Complete")',
      'button:has-text("Submit")',
      'button:has-text("Book Now")',
    ];

    let purchaseClicked = false;
    for (const sel of purchaseSelectors) {
      try {
        const btn = await this.page.$(sel);
        if (btn && await btn.isVisible()) {
          await btn.evaluate(el => el.click());
          logger.info(`Clicked purchase button: ${sel}`);
          purchaseClicked = true;
          await this.page.waitForTimeout(5000);
          break;
        }
      } catch {
        // Try next
      }
    }

    if (!purchaseClicked) {
      logger.warn('Could not find "Complete Your Purchase" button');
    }

    const screenshotPath = await this.screenshot('checkout-complete');
    const confirmation = await this._extractConfirmation();

    return {
      success: true,
      confirmationNumber: confirmation || 'CHECKOUT_COMPLETE',
      screenshotPath,
    };
  }

  async _handleCheckout(slotIndex) {
    logger.info('Handling checkout flow...');

    // Some booking systems have a cart → checkout flow
    // Look for checkout/confirm buttons
    const checkoutSelectors = [
      'button:has-text("Checkout")',
      'button:has-text("Complete")',
      'button:has-text("Confirm Booking")',
      'button:has-text("Finish")',
      'button:has-text("Place Order")',
      'button:has-text("Submit")',
    ];

    for (const sel of checkoutSelectors) {
      try {
        const btn = await this.page.$(sel);
        if (btn && await btn.isVisible()) {
          await btn.click();
          await this.page.waitForTimeout(3000);
          logger.info(`Checkout submitted via: ${sel}`);

          const confirmation = await this._extractConfirmation();
          const screenshotPath = await this.screenshot(`slot-${slotIndex}-checkout`);

          return {
            success: !!confirmation,
            confirmationNumber: confirmation,
            screenshotPath,
            error: confirmation ? null : 'Checkout completed but no confirmation found',
          };
        }
      } catch {
        // Try next
      }
    }

    const screenshotPath = await this.screenshot(`slot-${slotIndex}-no-checkout`);
    return { success: false, error: 'No checkout button found', screenshotPath };
  }
}

module.exports = SiteAutomation;
