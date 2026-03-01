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
   * Select a specific course by name. Returns the courseId actually selected.
   * @param {string} courseName - 'Pines' or 'Oaks'
   */
  async selectCourse(courseName = 'Pines') {
    const target = courseName === 'Oaks' ? COURSES.oaks : COURSES.pines;
    const targetRegex = new RegExp(courseName, 'i');
    logger.info(`Selecting course: ${courseName}...`);

    // Look for course selector dropdown
    const courseSelectors = [
      'select[name*="course" i]',
      'select[id*="course" i]',
      '[class*="course-select" i]',
      '[class*="courseSelect" i]',
      '[data-testid*="course" i]',
    ];

    for (const sel of courseSelectors) {
      try {
        const dropdown = await this.page.$(sel);
        if (dropdown) {
          try {
            await dropdown.selectOption({ label: targetRegex });
            logger.info(`Selected ${courseName} course via dropdown`);
            return target.id;
          } catch {
            try {
              await dropdown.selectOption(target.id);
              logger.info(`Selected ${courseName} course via dropdown (by value)`);
              return target.id;
            } catch {
              logger.warn(`${courseName} not available in dropdown`);
            }
          }
        }
      } catch {
        // Try next selector
      }
    }

    // Try filter button-based course selector (sidebar checkboxes/buttons)
    const filterSel = `button:has-text("${courseName} Course"), button:has-text("${courseName}"), a:has-text("${courseName}"), [class*="tab"]:has-text("${courseName}")`;
    const filter = await this.page.$(filterSel);
    if (filter && await filter.isVisible()) {
      const isActive = await filter.evaluate(el => el.classList.contains('active') || el.getAttribute('aria-pressed') === 'true' || el.style.backgroundColor !== '');
      if (!isActive) {
        await filter.click();
        await this.page.waitForTimeout(2000);
      }
      logger.info(`Selected ${courseName} course via filter`);
      return target.id;
    }

    // Course may already be selected via URL parameter
    logger.info(`No course selector found — ${courseName} may be set via URL`);
    return target.id;
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

  /**
   * Find any available slots within the time window (not necessarily consecutive).
   * Returns up to `maxSlots` slots sorted by time.
   */
  findSlotsInWindow(teeTimes, windowStart, windowEnd, maxSlots) {
    const winStartMin = this._timeToMinutes(windowStart);
    const winEndMin = this._timeToMinutes(windowEnd);

    const sorted = [...teeTimes].sort(
      (a, b) => this._timeToMinutes(a.time) - this._timeToMinutes(b.time)
    );

    const inWindow = sorted.filter(t => {
      const mins = this._timeToMinutes(t.time);
      return mins >= winStartMin && mins <= winEndMin;
    });

    return inWindow.slice(0, maxSlots);
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

      // Step 2: Click "ADD TO CART" — find it specifically within the booking modal
      let addedToCart = false;
      const cartBtns = await this.page.$$('button');
      for (const btn of cartBtns) {
        try {
          const text = await btn.evaluate(el => {
            const clone = el.cloneNode(true);
            clone.querySelectorAll('svg, [aria-hidden="true"], [class*="Icon"]').forEach(n => n.remove());
            return clone.textContent.trim().toUpperCase();
          });
          if (text === 'ADD TO CART') {
            await btn.evaluate(el => el.click());
            logger.info('Clicked "ADD TO CART"');
            addedToCart = true;
            await this.page.waitForTimeout(3000);
            break;
          }
        } catch { /* skip */ }
      }

      if (!addedToCart) {
        logger.warn('No "ADD TO CART" button found');
        await this.screenshot(`slot-${slotIndex}-no-add-to-cart`);
      }

      await this.screenshot(`slot-${slotIndex}-added-to-cart`);

      // The item should now be in the cart
      logger.info(`Slot ${slotIndex} added to cart`);
      const screenshotPath = await this.screenshot(`slot-${slotIndex}-in-cart`);
      return { success: addedToCart, confirmationNumber: addedToCart ? 'ADDED_TO_CART' : null, error: addedToCart ? null : 'ADD TO CART button not found', screenshotPath };

    } catch (error) {
      const screenshotPath = await this.screenshot(`slot-${slotIndex}-error`);
      logger.error(`Error booking slot ${slotIndex}: ${error.message}`);
      return { success: false, error: error.message, screenshotPath };
    }
  }

  /**
   * Set the player count in the booking modal. Tries the requested count first,
   * then falls back to lower counts if the button is disabled (e.g. limited spots).
   * Returns the actual count selected.
   */
  async _setPlayerCount(count) {
    // TeeItUp uses numbered buttons (1, 2, 3, 4) under "Select Number of Golfers"
    // IMPORTANT: Must scope to the booking modal to avoid clicking calendar day buttons

    // Build a map of modal golfer buttons keyed by their number
    const allButtons = await this.page.$$('button');
    const modalButtons = new Map(); // number → button handle

    for (const btn of allButtons) {
      try {
        const info = await btn.evaluate(el => {
          const text = el.textContent.trim();
          const num = parseInt(text, 10);
          if (isNaN(num) || num < 1 || num > 4 || String(num) !== text) return null;

          // Walk up to check if this button is inside the booking modal
          let node = el.parentElement;
          for (let i = 0; i < 10; i++) {
            if (!node) break;
            const parentText = node.textContent || '';
            if (parentText.includes('Select Number of Golfers') ||
                parentText.includes('Select Rate') ||
                parentText.includes('ADD TO CART')) {
              const isDisabled = el.disabled ||
                el.getAttribute('aria-disabled') === 'true' ||
                getComputedStyle(el).pointerEvents === 'none' ||
                parseFloat(getComputedStyle(el).opacity) < 0.5;
              return { num, inModal: true, disabled: isDisabled };
            }
            node = node.parentElement;
          }
          return null;
        });

        if (info && info.inModal) {
          modalButtons.set(info.num, { handle: btn, disabled: info.disabled });
        }
      } catch {
        // Skip
      }
    }

    if (modalButtons.size === 0) {
      logger.warn('No golfer count buttons found in modal — proceeding with default');
      return count;
    }

    // Try requested count, then fall back to lower counts
    const tryOrder = [];
    for (let n = count; n >= 1; n--) tryOrder.push(n);

    for (const n of tryOrder) {
      const entry = modalButtons.get(n);
      if (!entry) continue;
      if (entry.disabled) {
        logger.info(`Golfer button ${n} is disabled — trying lower count`);
        continue;
      }
      await entry.handle.evaluate(el => el.click());
      if (n < count) {
        logger.warn(`Set ${n} golfers (wanted ${count} but higher counts disabled)`);
      } else {
        logger.info(`Set ${count} golfers via modal button`);
      }
      return n;
    }

    logger.warn(`All golfer count buttons disabled — proceeding with default`);
    return 1;
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
   * Clear any stale items from the shopping cart to avoid "Cart items limit exceeded" errors.
   * Should be called once after login, before processing any booking groups.
   */
  async clearCart() {
    logger.info('Clearing stale cart items...');

    // Click the cart icon to open the cart panel
    let cartOpened = false;
    const cartSelectors = [
      'header [aria-label*="cart" i]',
      'header button[aria-label*="cart" i]',
      'nav [aria-label*="cart" i]',
      '[class*="header"] [aria-label*="cart" i]',
      'button[aria-label="cart"]',
      'button[aria-label="Cart"]',
    ];

    for (const sel of cartSelectors) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible()) {
          await el.evaluate(e => e.click());
          logger.info(`Opened cart via: ${sel}`);
          cartOpened = true;
          await this.page.waitForTimeout(2000);
          break;
        }
      } catch { /* try next */ }
    }

    if (!cartOpened) {
      // Positional scan for cart icon in top-right
      cartOpened = await this.page.evaluate(() => {
        const candidates = document.querySelectorAll('svg, [class*="cart" i], [class*="Cart" i], [class*="badge" i]');
        for (const el of candidates) {
          const rect = el.getBoundingClientRect();
          if (rect.left > window.innerWidth * 0.6 && rect.top < window.innerHeight * 0.15 && rect.width > 0) {
            const clickTarget = el.closest('button') || el.closest('a') || el;
            clickTarget.click();
            return true;
          }
        }
        return false;
      });
      if (cartOpened) {
        logger.info('Opened cart via positional scan');
        await this.page.waitForTimeout(2000);
      }
    }

    if (!cartOpened) {
      logger.info('Could not find cart icon — cart likely empty');
      return;
    }

    await this.screenshot('clear-cart-opened');

    // Remove items one at a time — look for delete/remove buttons or three-dot menus
    let itemsRemoved = 0;
    const maxItems = 10; // safety limit

    for (let attempt = 0; attempt < maxItems; attempt++) {
      // Try clicking a delete/remove/trash icon on a cart item
      const removed = await this.page.evaluate(() => {
        // Look for three-dot/more menus (⋮) inside the cart panel
        const moreButtons = document.querySelectorAll(
          '[aria-label*="more" i], [aria-label*="delete" i], [aria-label*="remove" i], ' +
          '[class*="delete" i], [class*="remove" i], [class*="trash" i], ' +
          'button[aria-label*="More" i]'
        );
        for (const btn of moreButtons) {
          if (btn.offsetParent !== null) { // visible
            btn.click();
            return 'clicked-action-button';
          }
        }

        // Look for an "EDIT CART" or "Remove" link/button
        const buttons = document.querySelectorAll('button, a');
        for (const btn of buttons) {
          const text = btn.textContent.trim().toUpperCase();
          if ((text === 'REMOVE' || text === 'DELETE' || text.includes('REMOVE ITEM')) && btn.offsetParent !== null) {
            btn.click();
            return 'clicked-remove';
          }
        }
        return null;
      });

      if (!removed) {
        // No more removable items found
        break;
      }

      logger.info(`Cart item action: ${removed}`);
      await this.page.waitForTimeout(1500);

      // If we clicked a three-dot menu, a dropdown appears — click Remove/Delete in the dropdown
      if (removed === 'clicked-action-button') {
        const dropdownRemoved = await this.page.evaluate(() => {
          // MUI menu items or popover buttons
          const menuItems = document.querySelectorAll(
            '[role="menuitem"], [class*="MenuItem"], [class*="menuItem"], ' +
            '.MuiMenuItem-root, [role="menu"] button, [class*="popover"] button'
          );
          for (const item of menuItems) {
            const text = item.textContent.trim().toUpperCase();
            if (text === 'REMOVE' || text === 'DELETE' || text.includes('REMOVE')) {
              item.click();
              return true;
            }
          }
          return false;
        });
        if (dropdownRemoved) {
          logger.info('Clicked Remove in dropdown menu');
          await this.page.waitForTimeout(1500);
        } else {
          // Dismiss the menu and try the next item
          await this.page.keyboard.press('Escape');
          await this.page.waitForTimeout(500);
        }
      }

      itemsRemoved++;
    }

    if (itemsRemoved > 0) {
      logger.info(`Removed ${itemsRemoved} stale cart item(s)`);
      await this.screenshot('clear-cart-done');
    } else {
      logger.info('Cart was empty — nothing to clear');
    }

    // Close the cart panel
    await this._dismissModals();
    await this.page.waitForTimeout(500);
  }

  /**
   * Complete checkout after a tee time has been added to the cart.
   * Flow: Cart icon (top-right) → Checkout button → Terms checkbox → COMPLETE YOUR PURCHASE
   */
  async completeCheckout() {
    logger.info('Completing checkout...');
    await this.page.waitForTimeout(2000);
    await this.screenshot('checkout-before-cart');

    // Step 1: Click the cart icon in the top-right header (next to the user's name)
    let cartClicked = false;

    // Try labeled/aria cart buttons in the header first
    const headerCartSelectors = [
      'header [aria-label*="cart" i]',
      'header button[aria-label*="cart" i]',
      'nav [aria-label*="cart" i]',
      '[class*="header"] [aria-label*="cart" i]',
      '[class*="navbar"] [aria-label*="cart" i]',
      'header button svg[data-testid="ShoppingCartIcon"]',
      '[class*="MuiBadge-root"] button',
      'button[aria-label="cart"]',
      'button[aria-label="Cart"]',
      'a[href*="cart"]',
      'a[href*="checkout"]',
    ];

    for (const sel of headerCartSelectors) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible()) {
          await el.evaluate(e => e.click());
          logger.info(`Clicked cart icon via: ${sel}`);
          cartClicked = true;
          await this.page.waitForTimeout(2000);
          break;
        }
      } catch { /* try next */ }
    }

    if (!cartClicked) {
      // Positional scan: find any SVG or cart-related element in the top-right area of the viewport
      cartClicked = await this.page.evaluate(() => {
        const candidates = document.querySelectorAll('svg, [class*="cart" i], [class*="Cart" i], [class*="badge" i]');
        for (const el of candidates) {
          const rect = el.getBoundingClientRect();
          if (rect.left > window.innerWidth * 0.6 && rect.top < window.innerHeight * 0.15 && rect.width > 0) {
            const clickTarget = el.closest('button') || el.closest('a') || el;
            clickTarget.click();
            return true;
          }
        }
        return false;
      });
      if (cartClicked) {
        logger.info('Clicked cart icon via top-right positional scan');
        await this.page.waitForTimeout(2000);
      } else {
        logger.warn('Could not find cart icon — proceeding to look for Checkout button anyway');
      }
    }

    await this.screenshot('checkout-after-cart-icon');

    // Step 2: Click "Checkout" button that appears in the cart dropdown/panel
    let navigatedToCheckout = false;
    const checkoutBtnSelectors = [
      'button:has-text("Checkout")',
      'a:has-text("Checkout")',
      'button:has-text("CHECKOUT")',
      'a:has-text("CHECKOUT")',
      'button:has-text("Proceed to Checkout")',
      'a:has-text("Proceed to Checkout")',
    ];

    for (const sel of checkoutBtnSelectors) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible()) {
          await el.evaluate(e => e.click());
          logger.info(`Clicked checkout button via: ${sel}`);
          navigatedToCheckout = true;
          await this.page.waitForTimeout(3000);
          break;
        }
      } catch { /* try next */ }
    }

    if (!navigatedToCheckout) {
      // Fallback: navigate to /checkout directly
      try {
        const baseUrl = new URL(this.page.url()).origin;
        await this.page.goto(`${baseUrl}/checkout`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await this.page.waitForTimeout(3000);
        logger.info('Navigated to /checkout directly');
        navigatedToCheckout = true;
      } catch {
        logger.warn('Could not navigate to checkout page');
      }
    }

    await this.screenshot('checkout-page');

    // Step 3: Check "I agree to the Terms and Conditions" checkbox
    let termsChecked = false;
    await this.page.waitForTimeout(1000);

    const termsResult = await this.page.evaluate(() => {
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const text = el.textContent || '';
        if ((text.toLowerCase().includes('terms') || text.toLowerCase().includes('i agree')) && text.length < 300) {
          const checkbox = el.querySelector('input[type="checkbox"]') ||
                          el.closest('label')?.querySelector('input[type="checkbox"]');
          if (checkbox && !checkbox.checked) {
            checkbox.click();
            return 'clicked-terms-checkbox';
          }
          if (el.tagName === 'LABEL') {
            el.click();
            return 'clicked-terms-label';
          }
        }
      }
      // Fallback: any unchecked checkbox on the page
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      for (const cb of checkboxes) {
        if (!cb.checked) {
          cb.click();
          return 'clicked-fallback-checkbox';
        }
      }
      return null;
    });

    if (termsResult) {
      logger.info(`Terms and Conditions: ${termsResult}`);
      termsChecked = true;
      await this.page.waitForTimeout(1000);
    } else {
      logger.warn('Could not find Terms and Conditions checkbox');
    }

    await this.screenshot('checkout-terms');

    // Step 4: Click "COMPLETE YOUR PURCHASE" button
    const purchaseResult = await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button, input[type="submit"], a.btn, a.button');
      const purchaseTexts = [
        'COMPLETE YOUR PURCHASE',
        'COMPLETE PURCHASE',
        'COMPLETE BOOKING',
        'PLACE ORDER',
        'CONFIRM PURCHASE',
      ];
      for (const btn of buttons) {
        const clone = btn.cloneNode(true);
        clone.querySelectorAll('svg, [aria-hidden="true"], [class*="Icon"]').forEach(n => n.remove());
        const text = clone.textContent.trim().toUpperCase();
        for (const target of purchaseTexts) {
          if (text.includes(target)) {
            btn.click();
            return clone.textContent.trim();
          }
        }
      }
      return null;
    });

    if (purchaseResult) {
      logger.info(`Clicked purchase button: "${purchaseResult}"`);
      await this.page.waitForTimeout(5000);
    } else {
      logger.warn('Could not find "COMPLETE YOUR PURCHASE" button');
    }

    const screenshotPath = await this.screenshot('checkout-complete');
    const confirmation = await this._extractConfirmation();

    return {
      success: !!purchaseResult,
      confirmationNumber: confirmation || (purchaseResult ? 'CHECKOUT_COMPLETE' : null),
      screenshotPath,
    };
  }

  /**
   * Check existing reservations on the site for a given date.
   * Navigates to the reservations/my-tee-times page, extracts bookings
   * matching the target date, and returns them.
   * Returns array of { time, course, players, date }
   */
  async getExistingReservations(date) {
    logger.info(`Checking existing reservations for ${date}...`);

    const baseUrl = config.site.memberUrl;
    let foundPage = false;

    // Try clicking nav links in the header
    const navLabels = ['Reservations', 'My Tee Times', 'My Bookings', 'Upcoming', 'My Reservations'];
    for (const label of navLabels) {
      try {
        const link = await this.page.$(`a:has-text("${label}"), button:has-text("${label}")`);
        if (link && await link.isVisible()) {
          await link.click();
          await this.page.waitForTimeout(3000);
          // Verify we didn't land on a "PAGE NOT FOUND" page
          const pageText = await this.page.evaluate(() => document.body.innerText.slice(0, 2000));
          if (/page not found|404|not found/i.test(pageText)) {
            logger.warn(`"${label}" nav link led to a 404 page — trying next`);
            continue;
          }
          logger.info(`Clicked nav link: "${label}" → ${this.page.url()}`);
          foundPage = true;
          break;
        }
      } catch {
        // Try next
      }
    }

    // Try user dropdown menu items (Account, Dashboard, Tee Time Alerts)
    if (!foundPage) {
      // Open user menu by clicking on the user name/icon area
      const userMenuSelectors = [
        '[class*="user"] button', '[class*="User"] button',
        'header button:has-text("Visanu")', 'header a:has-text("Visanu")',
        '[class*="account" i]', '[aria-label*="account" i]',
        'header svg[data-testid="PersonIcon"]',
      ];
      for (const sel of userMenuSelectors) {
        try {
          const el = await this.page.$(sel);
          if (el && await el.isVisible()) {
            await el.evaluate(e => e.click());
            await this.page.waitForTimeout(1500);
            logger.info(`Opened user menu via: ${sel}`);
            break;
          }
        } catch { /* try next */ }
      }

      // Also try clicking the user name text directly
      try {
        const userNameEl = await this.page.evaluate(() => {
          const els = document.querySelectorAll('header span, header a, header button, header p');
          for (const el of els) {
            if (el.textContent.trim().length > 3 && el.textContent.trim().length < 40 &&
                !['Tee Times', 'Course Info', 'Reservations'].includes(el.textContent.trim())) {
              const rect = el.getBoundingClientRect();
              if (rect.left > window.innerWidth * 0.5 && rect.top < 50) {
                el.click();
                return el.textContent.trim();
              }
            }
          }
          return null;
        });
        if (userNameEl) {
          logger.info(`Clicked user name: "${userNameEl}"`);
          await this.page.waitForTimeout(1500);
        }
      } catch { /* ignore */ }

      // Now look for menu items
      const menuLabels = ['Dashboard', 'Tee Time Alerts', 'Account', 'My Reservations', 'My Bookings'];
      for (const label of menuLabels) {
        try {
          const item = await this.page.$(`a:has-text("${label}"), button:has-text("${label}"), [role="menuitem"]:has-text("${label}")`);
          if (item && await item.isVisible()) {
            await item.click();
            await this.page.waitForTimeout(3000);
            const pageText = await this.page.evaluate(() => document.body.innerText.slice(0, 2000));
            if (/page not found|404/i.test(pageText)) {
              logger.warn(`"${label}" menu item led to a 404 — trying next`);
              continue;
            }
            logger.info(`Clicked user menu item: "${label}" → ${this.page.url()}`);
            foundPage = true;
            break;
          }
        } catch {
          // Try next
        }
      }
    }

    // Fallback: try direct URL patterns
    if (!foundPage) {
      const urlPatterns = [
        `${baseUrl}/my-tee-times`,
        `${baseUrl}/my-bookings`,
        `${baseUrl}/upcoming`,
      ];

      for (const url of urlPatterns) {
        try {
          const response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          if (response && response.status() < 400) {
            await this.page.waitForTimeout(3000);
            const pageText = await this.page.evaluate(() => document.body.innerText.slice(0, 2000));
            if (/page not found|404/i.test(pageText)) continue;
            if (/reservat|my tee|my book|upcoming|booked/i.test(pageText)) {
              logger.info(`Found reservations page at: ${url}`);
              foundPage = true;
              break;
            }
          }
        } catch {
          // Try next URL
        }
      }
    }

    if (!foundPage) {
      logger.warn('Could not find reservations page — skipping reservation check');
      return [];
    }

    await this.screenshot('reservations-page');

    // Extract reservations from the page
    const reservations = await this.page.evaluate((targetDate) => {
      const results = [];
      const body = document.body.innerText;

      // Parse the target date for matching
      const [year, month, day] = targetDate.split('-').map(Number);
      const targetDateObj = new Date(year, month - 1, day);
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                          'July', 'August', 'September', 'October', 'November', 'December'];
      const shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                           'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

      // Build date patterns to match on the page
      const datePatterns = [
        targetDate,                                                    // 2026-03-15
        `${month}/${day}/${year}`,                                     // 3/15/2026
        `${String(month).padStart(2,'0')}/${String(day).padStart(2,'0')}/${year}`, // 03/15/2026
        `${monthNames[month-1]} ${day}`,                               // March 15
        `${shortMonths[month-1]} ${day}`,                              // Mar 15
        `${monthNames[month-1]} ${String(day).padStart(2,'0')}`,       // March 15
        `${shortMonths[month-1]} ${String(day).padStart(2,'0')}`,      // Mar 15
      ];

      // Find card-like containers that represent individual reservations
      // Look for elements containing both a time and a date reference
      const cards = document.querySelectorAll(
        '[class*="card" i], [class*="reservation" i], [class*="booking" i], ' +
        '[class*="tee-time" i], [class*="teeTime" i], [class*="item" i], ' +
        'tr, li, [role="listitem"], [class*="Card"]'
      );

      for (const card of cards) {
        const text = card.textContent || '';
        if (text.length > 1000 || text.length < 10) continue;

        // Check if this card matches the target date
        const matchesDate = datePatterns.some(p => text.includes(p));
        if (!matchesDate) continue;

        // Extract time
        const timeMatch = text.match(/(\d{1,2}:\d{2})\s*(AM|PM|am|pm)/);
        if (!timeMatch) continue;

        let [, time, period] = timeMatch;
        let [h, m] = time.split(':').map(Number);
        if (period.toUpperCase() === 'PM' && h !== 12) h += 12;
        if (period.toUpperCase() === 'AM' && h === 12) h = 0;
        const time24 = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

        // Extract course name
        let course = 'Unknown';
        if (/pines/i.test(text)) course = 'Pines';
        else if (/oaks/i.test(text)) course = 'Oaks';

        // Extract player count
        const playerMatch = text.match(/(\d)\s*(?:player|golfer)/i);
        const players = playerMatch ? parseInt(playerMatch[1]) : 4;

        results.push({ time: time24, course, players, date: targetDate });
      }

      // Deduplicate by time
      const seen = new Set();
      return results.filter(r => {
        const key = `${r.time}-${r.course}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }, date);

    if (reservations.length > 0) {
      const times = reservations.map(r => `${r.time} (${r.course})`).join(', ');
      logger.info(`Found ${reservations.length} existing reservations for ${date}: ${times}`);
    } else {
      logger.info(`No existing reservations found for ${date}`);
    }

    return reservations;
  }

  /**
   * Verify that a specific booking exists on the Reservations page.
   * Called after checkout to confirm the booking actually went through.
   * @param {string} date - YYYY-MM-DD
   * @param {string} time - 24h format HH:MM (±15 min tolerance)
   * @returns {{ verified: boolean, reservations: Array }}
   */
  async verifyBookingOnSite(date, time) {
    logger.info(`Verifying booking on Reservations page: ${date} ${time}...`);

    try {
      const reservations = await this.getExistingReservations(date);

      if (reservations.length === 0) {
        logger.warn(`Verification: no reservations found for ${date}`);
        await this.screenshot('verify-no-reservations');
        return { verified: false, reservations };
      }

      // Check if any reservation matches the booked time (±15 min)
      const bookedMinutes = this._timeToMinutes(time);
      const match = reservations.find(r => {
        const resMinutes = this._timeToMinutes(r.time);
        return Math.abs(resMinutes - bookedMinutes) <= 15;
      });

      if (match) {
        logger.info(`Verification SUCCESS: found reservation at ${match.time} (${match.course}) matching booked time ${time}`);
        return { verified: true, reservations };
      }

      logger.warn(`Verification FAILED: no reservation near ${time} found on ${date}. Found: ${reservations.map(r => r.time).join(', ')}`);
      await this.screenshot('verify-mismatch');
      return { verified: false, reservations };
    } catch (error) {
      logger.warn(`Verification error: ${error.message}`);
      return { verified: false, reservations: [] };
    }
  }

  _timeToMinutes(time) {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
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
