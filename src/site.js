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

  /**
   * Click the shopping cart icon in the header to open the cart panel.
   * The cart icon is the RIGHTMOST element in the header (to the right of the user name).
   * Must distinguish it from the user name/avatar which is just to its left.
   * Returns true if the cart panel was opened.
   */
  async _clickCartIcon() {
    // First dismiss any open dropdowns (like user menu) that could interfere
    await this._dismissModals();

    // Strategy 1: Find cart by aria-label or data-testid
    const cartSelectors = [
      'header [aria-label*="cart" i]',
      'header button[aria-label*="cart" i]',
      'nav [aria-label*="cart" i]',
      '[class*="header"] [aria-label*="cart" i]',
      'button[aria-label="cart"]',
      'button[aria-label="Cart"]',
      '[data-testid="ShoppingCartIcon"]',
      'svg[data-testid="ShoppingCartIcon"]',
    ];

    for (const sel of cartSelectors) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible()) {
          const clickTarget = await el.evaluate(e => {
            const btn = e.closest('button') || e.closest('a') || e;
            btn.click();
            return btn.tagName;
          });
          logger.info(`Clicked cart icon via: ${sel} (${clickTarget})`);
          await this.page.waitForTimeout(2000);
          return true;
        }
      } catch { /* try next */ }
    }

    // Strategy 2: Find the MuiBadge (cart count indicator) — this is unique to the cart icon
    try {
      const badgeClicked = await this.page.evaluate(() => {
        // The cart icon has a MuiBadge showing the item count
        const badges = document.querySelectorAll('.MuiBadge-root, [class*="Badge"]');
        for (const badge of badges) {
          const rect = badge.getBoundingClientRect();
          // Must be in the header area (top of page, right side)
          if (rect.top < 60 && rect.left > window.innerWidth * 0.8 && rect.width > 0) {
            const clickTarget = badge.closest('button') || badge.closest('a') || badge;
            clickTarget.click();
            return true;
          }
        }
        return false;
      });
      if (badgeClicked) {
        logger.info('Clicked cart icon via MuiBadge in header');
        await this.page.waitForTimeout(2000);
        return true;
      }
    } catch { /* ignore */ }

    // Strategy 3: Find the RIGHTMOST clickable element in the header
    // The cart icon is always the last icon in the header bar, after the user name
    try {
      const clicked = await this.page.evaluate(() => {
        // Get all clickable elements in the top header bar
        const headerEls = document.querySelectorAll('header button, header a, header svg, nav button, nav a');
        let rightmost = null;
        let maxRight = 0;

        for (const el of headerEls) {
          const rect = el.getBoundingClientRect();
          if (rect.top < 60 && rect.height > 0 && rect.width > 0 && rect.width < 80) {
            // The cart icon is a small button/svg, not the wide user name button
            if (rect.right > maxRight) {
              maxRight = rect.right;
              rightmost = el;
            }
          }
        }

        if (rightmost) {
          const clickTarget = rightmost.closest('button') || rightmost.closest('a') || rightmost;
          clickTarget.click();
          return true;
        }
        return false;
      });
      if (clicked) {
        logger.info('Clicked rightmost header element (cart icon)');
        await this.page.waitForTimeout(2000);
        return true;
      }
    } catch { /* ignore */ }

    logger.warn('Could not find cart icon in header');
    return false;
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

      // Wait for the booking modal to fully load — it first shows "Select Rate"
      // (with a spinner), then after AJAX loads it shows "Select Number of Golfers"
      try {
        await this.page.waitForFunction(() => {
          return document.body.innerText.includes('Select Number of Golfers');
        }, { timeout: 10000 });
        logger.info('Booking modal fully loaded');
      } catch {
        logger.warn('Timed out waiting for golfer selection to appear in modal');
      }
      await this.screenshot(`slot-${slotIndex}-after-click`);

      // Step 1: Select golfer count in the modal
      // Strategy: Find the "Select Number of Golfers" heading, then look for
      // numbered clickable elements (1-4) in the same parent container.
      const golferResult = await this.page.evaluate((desiredCount) => {
        // Find the heading/label that says "Select Number of Golfers"
        const allEls = document.querySelectorAll('*');
        let golferSection = null;
        for (const el of allEls) {
          const ownText = Array.from(el.childNodes)
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => n.textContent.trim())
            .join(' ');
          if (/Select Number of Golfers/i.test(ownText)) {
            golferSection = el;
            break;
          }
          if (el.children.length === 0 && /Select Number of Golfers/i.test(el.textContent.trim())) {
            golferSection = el;
            break;
          }
        }

        if (!golferSection) {
          return { error: 'Could not find "Select Number of Golfers" heading', selectedCount: 1 };
        }

        // From the heading, walk UP to find the container with golfer count controls.
        // TeeItUp uses MUI Radio buttons — SPAN.MuiRadio-root elements inside a
        // [role="radiogroup"] div. Each radio has a sibling DIV.MuiBox-root label
        // showing "1", "2", "3", "4". There are NO <label> or <button> wrappers.
        const golferBtns = {};
        let container = golferSection.parentElement;
        for (let depth = 0; depth < 6 && container; depth++, container = container.parentElement) {
          const radioGroup = container.querySelector('[role="radiogroup"]');
          if (radioGroup) {
            // Scan ALL descendants for elements whose text is exactly a single digit 1-4.
            // Prefer MuiButtonBase-root/MuiRadio-root spans (the clickable radio controls).
            const allDescendants = radioGroup.querySelectorAll('*');
            for (const el of allDescendants) {
              // Only match leaf-ish elements (those with 0-2 children to avoid containers)
              if (el.children.length > 2) continue;
              const text = el.textContent.trim();
              if (text.length > 3) continue;
              const num = parseInt(text, 10);
              if (num >= 1 && num <= 4 && String(num) === text) {
                const isMuiRadio = el.classList.contains('MuiButtonBase-root') ||
                  el.classList.contains('MuiRadio-root');
                const isDisabled = el.classList.contains('Mui-disabled') ||
                  (el.closest && el.closest('.Mui-disabled') !== null) ||
                  parseFloat(getComputedStyle(el).opacity) < 0.4;
                // Prefer clickable MuiRadio-root spans over label divs
                if (!golferBtns[num] || isMuiRadio) {
                  golferBtns[num] = { el, disabled: isDisabled };
                }
              }
            }
            if (Object.keys(golferBtns).length >= 2) break;
          }
          // Fallback: regular buttons or role=button
          const buttons = container.querySelectorAll('button, [role="button"]');
          for (const el of buttons) {
            const text = el.textContent.trim().replace(/[\s\u200b\u00a0]+/g, '');
            const num = parseInt(text, 10);
            if (num >= 1 && num <= 4 && text.length <= 3 && !golferBtns[num]) {
              const isDisabled = el.disabled ||
                el.getAttribute('aria-disabled') === 'true' ||
                parseFloat(getComputedStyle(el).opacity) < 0.4;
              golferBtns[num] = { el, disabled: isDisabled };
            }
          }
          if (Object.keys(golferBtns).length >= 2) break;
        }

        // Debug: if no buttons found, log what elements exist near the heading
        if (Object.keys(golferBtns).length === 0) {
          let debugContainer = golferSection.parentElement;
          const debugInfo = [];
          for (let d = 0; d < 4 && debugContainer; d++, debugContainer = debugContainer.parentElement) {
            const children = debugContainer.querySelectorAll('*');
            for (const child of children) {
              const text = child.textContent.trim();
              if (text.length <= 5 && /^\d+$/.test(text.replace(/\s/g, ''))) {
                debugInfo.push({
                  tag: child.tagName,
                  text,
                  classes: (child.className && typeof child.className === 'string') ? child.className.substring(0, 100) : '',
                  role: child.getAttribute('role') || '',
                });
              }
            }
          }
          return {
            error: 'Found heading but no golfer buttons nearby',
            selectedCount: 1,
            headingTag: golferSection.tagName,
            debug: debugInfo.slice(0, 20),
          };
        }

        // Try desired count, then fall back to lower
        for (let n = desiredCount; n >= 1; n--) {
          if (golferBtns[n] && !golferBtns[n].disabled) {
            golferBtns[n].el.click();
            return { selectedCount: n, found: Object.keys(golferBtns).map(Number) };
          }
        }
        return { error: 'All golfer buttons disabled', selectedCount: 1 };
      }, 4);

      if (golferResult.error) {
        logger.warn(`Golfer selection: ${golferResult.error}`);
        if (golferResult.debug) {
          logger.warn(`Debug — nearby numeric elements: ${JSON.stringify(golferResult.debug)}`);
        }
      } else {
        logger.info(`Selected ${golferResult.selectedCount} golfers in modal (buttons found: ${golferResult.found})`);
      }

      // Wait for React to process the golfer selection
      await this.page.waitForTimeout(1500);
      await this.screenshot(`slot-${slotIndex}-players-set`);

      // Step 2: Click "ADD TO CART" button
      let addedToCart = false;
      const addResult = await this.page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.offsetParent === null) continue; // skip hidden
          const text = btn.textContent.trim().replace(/[\s\u200b]+/g, ' ').toUpperCase();
          if (text === 'ADD TO CART') {
            btn.click();
            return { found: true, text: btn.textContent.trim() };
          }
        }
        return { found: false };
      });

      if (addResult.found) {
        addedToCart = true;
        logger.info(`Clicked "ADD TO CART" button`);
        await this.page.waitForTimeout(3000);
        await this.screenshot(`slot-${slotIndex}-after-add-to-cart`);
      }

      if (!addedToCart) {
        logger.warn('ADD TO CART button not found after golfer selection');
        const screenshotPath = await this.screenshot(`slot-${slotIndex}-no-add-to-cart`);
        return { success: false, error: 'ADD TO CART button not found', screenshotPath };
      }

      // Check for "Cart items limit exceeded" error toast
      const cartError = await this.page.evaluate(() => {
        const text = document.body.innerText;
        if (/cart items limit exceeded/i.test(text) || /cart.*limit/i.test(text) || /cart.*full/i.test(text)) {
          return 'Cart items limit exceeded';
        }
        return null;
      });
      if (cartError) {
        logger.warn(`Cart error after ADD TO CART: ${cartError}`);
        await this.screenshot(`slot-${slotIndex}-cart-limit`);
        return { success: false, error: cartError, screenshotPath: null };
      }

      logger.info(`Slot ${slotIndex} added to cart successfully`);
      const screenshotPath = await this.screenshot(`slot-${slotIndex}-in-cart`);
      return { success: true, confirmationNumber: 'ADDED_TO_CART', error: null, screenshotPath };

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
    // Strategy: Find the heading first, then locate buttons in its container
    const modalButtons = new Map();

    const buttonInfos = await this.page.evaluate(() => {
      // Find the "Select Number of Golfers" heading
      const allEls = document.querySelectorAll('*');
      let golferSection = null;
      for (const el of allEls) {
        const ownText = Array.from(el.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent.trim())
          .join(' ');
        if (/Select Number of Golfers/i.test(ownText)) { golferSection = el; break; }
        if (el.children.length === 0 && /Select Number of Golfers/i.test(el.textContent.trim())) { golferSection = el; break; }
      }
      if (!golferSection) return [];

      // Walk up from heading to find container with buttons
      let container = golferSection.parentElement;
      const results = [];
      for (let depth = 0; depth < 4 && container; depth++, container = container.parentElement) {
        const btns = container.querySelectorAll('button');
        for (const btn of btns) {
          const text = btn.textContent.trim();
          const num = parseInt(text, 10);
          if (num >= 1 && num <= 4 && String(num) === text) {
            const isDisabled = btn.disabled ||
              btn.getAttribute('aria-disabled') === 'true' ||
              getComputedStyle(btn).pointerEvents === 'none' ||
              parseFloat(getComputedStyle(btn).opacity) < 0.5;
            results.push({ num, disabled: isDisabled });
          }
        }
        if (results.length >= 2) break;
      }
      return results;
    });

    // Now get Playwright handles for the buttons
    const allButtons = await this.page.$$('button');
    const handledNums = new Set();
    for (const btn of allButtons) {
      const info = await btn.evaluate(el => {
        const text = el.textContent.trim();
        const num = parseInt(text, 10);
        if (num >= 1 && num <= 4 && String(num) === text) return num;
        return null;
      }).catch(() => null);
      if (info !== null && buttonInfos.some(bi => bi.num === info) && !handledNums.has(info)) {
        // Verify this is the same button by checking it's near "Select Number of Golfers"
        const isInSection = await btn.evaluate(el => {
          let node = el.parentElement;
          for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
            const text = Array.from(node.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent.trim()).join('');
            if (node.querySelector && Array.from(node.querySelectorAll('*')).some(child =>
              child.children.length === 0 && /Select Number of Golfers/i.test(child.textContent.trim())
            )) return true;
          }
          return false;
        }).catch(() => false);
        if (isInSection) {
          const bi = buttonInfos.find(b => b.num === info);
          modalButtons.set(info, { handle: btn, disabled: bi?.disabled || false });
          handledNums.add(info);
        }
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
    // The confirmation page at /confirmation shows "Reservation #XXXXXXXXX"
    // Extract that reservation number
    try {
      const confirmation = await this.page.evaluate(() => {
        const text = document.body.innerText;

        // Primary: "Reservation #418929401" format (the TeeItUp confirmation page)
        const resMatch = text.match(/Reservation\s*#\s*(\d+)/i);
        if (resMatch) return resMatch[1];

        // Fallback patterns for other confirmation formats
        const patterns = [
          /confirmation\s*(?:#|number|:)\s*([A-Z0-9-]{6,})/i,
          /booking\s*(?:#|number|:)\s*([A-Z0-9-]{6,})/i,
          /order\s*(?:#|number|:)\s*([A-Z0-9-]{6,})/i,
          /receipt\s*(?:#|number|:)\s*([A-Z0-9-]{6,})/i,
        ];
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match) return match[1];
        }
        return null;
      });
      if (confirmation) {
        logger.info(`Extracted reservation number: ${confirmation}`);
        return confirmation;
      }
    } catch (e) {
      logger.warn(`Error extracting confirmation: ${e.message}`);
    }

    logger.warn('Could not extract reservation number from confirmation page');
    return null;
  }

  /**
   * Clear any stale items from the shopping cart to avoid "Cart items limit exceeded" errors.
   * Should be called once after login, before processing any booking groups.
   */
  async clearCart() {
    logger.info('Clearing stale cart items...');

    // Click the cart icon to open the cart panel
    let cartOpened = await this._clickCartIcon();

    if (!cartOpened) {
      logger.info('Could not find cart icon — cart likely empty');
      return;
    }

    await this.screenshot('clear-cart-opened');

    // Step 1: Click "EDIT CART" button to enter edit mode (shows delete icons)
    let editCartClicked = false;
    const editCartSelectors = [
      'button:has-text("EDIT CART")',
      'button:has-text("Edit Cart")',
      'a:has-text("EDIT CART")',
      'a:has-text("Edit Cart")',
    ];
    for (const sel of editCartSelectors) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible()) {
          await el.evaluate(e => e.click());
          logger.info(`Clicked "${sel}" to enter edit mode`);
          editCartClicked = true;
          await this.page.waitForTimeout(2000);
          break;
        }
      } catch { /* try next */ }
    }

    if (!editCartClicked) {
      logger.info('No "EDIT CART" button found — cart may be empty or already in edit mode');
    }

    await this.screenshot('clear-cart-edit-mode');

    // Step 2: Click delete/remove/trash icons to remove each item
    let itemsRemoved = 0;
    const maxItems = 10; // safety limit

    for (let attempt = 0; attempt < maxItems; attempt++) {
      const removed = await this.page.evaluate(() => {
        // Look for delete/trash/remove icons or buttons
        const deleteSelectors = [
          '[aria-label*="delete" i]',
          '[aria-label*="remove" i]',
          '[aria-label*="trash" i]',
          '[class*="delete" i]',
          '[class*="remove" i]',
          '[class*="trash" i]',
          'button svg[data-testid="DeleteIcon"]',
          'button svg[data-testid="DeleteOutlineIcon"]',
          'button svg[data-testid="CloseIcon"]',
        ];

        for (const sel of deleteSelectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (el.offsetParent !== null) {
              const clickTarget = el.closest('button') || el.closest('a') || el;
              clickTarget.click();
              return `clicked-delete: ${sel}`;
            }
          }
        }

        // Fallback: look for any small icon button (likely delete) in the cart area
        // These are typically SVG icons inside buttons with no text
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.textContent.trim().toUpperCase();
          if ((text === '' || text === 'REMOVE' || text === 'DELETE' || text === '×' || text === 'X') && btn.offsetParent !== null) {
            // Check if it's in a cart/shopping area
            const parent = btn.closest('[class*="cart" i], [class*="Cart" i], [class*="Shopping" i], [class*="drawer" i], [class*="Drawer" i], [class*="panel" i]');
            if (parent) {
              btn.click();
              return 'clicked-cart-button';
            }
          }
        }

        return null;
      });

      if (!removed) {
        // No more delete buttons found
        break;
      }

      logger.info(`Cart item removal: ${removed}`);
      await this.page.waitForTimeout(2000);
      await this.screenshot(`clear-cart-removed-${itemsRemoved}`);
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

    // Dismiss any open dropdown menus or modals that may block interaction
    await this._dismissModals();
    await this.screenshot('checkout-before-cart');

    // Step 1: Open cart panel and click CHECKOUT
    let navigatedToCheckout = false;

    const checkoutBtnSelectors = [
      'button:has-text("Checkout")',
      'a:has-text("Checkout")',
      'button:has-text("CHECKOUT")',
      'a:has-text("CHECKOUT")',
      'button:has-text("Proceed to Checkout")',
      'a:has-text("Proceed to Checkout")',
    ];

    // Check if CHECKOUT button is already visible (cart panel may be open after ADD TO CART)
    for (const sel of checkoutBtnSelectors) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible()) {
          await el.evaluate(e => e.click());
          logger.info(`CHECKOUT button already visible — clicked: ${sel}`);
          navigatedToCheckout = true;
          await this.page.waitForTimeout(3000);
          break;
        }
      } catch { /* try next */ }
    }

    // If CHECKOUT not visible, open the cart panel using _clickCartIcon()
    if (!navigatedToCheckout) {
      const cartOpened = await this._clickCartIcon();
      await this.screenshot('checkout-after-cart-icon');

      if (cartOpened) {
        // Look for CHECKOUT button in the cart panel
        for (const sel of checkoutBtnSelectors) {
          try {
            const el = await this.page.$(sel);
            if (el && await el.isVisible()) {
              await el.evaluate(e => e.click());
              logger.info(`Clicked checkout button: ${sel}`);
              navigatedToCheckout = true;
              await this.page.waitForTimeout(3000);
              break;
            }
          } catch { /* try next */ }
        }

        // If not found, cart click may have closed an already-open panel — try once more
        if (!navigatedToCheckout) {
          logger.warn('CHECKOUT not found after cart click — retrying');
          await this._clickCartIcon();
          await this.page.waitForTimeout(1000);
          for (const sel of checkoutBtnSelectors) {
            try {
              const el = await this.page.$(sel);
              if (el && await el.isVisible()) {
                await el.evaluate(e => e.click());
                logger.info(`Clicked checkout on retry: ${sel}`);
                navigatedToCheckout = true;
                await this.page.waitForTimeout(3000);
                break;
              }
            } catch { /* try next */ }
          }
        }
      }
    }

    if (!navigatedToCheckout) {
      logger.warn('Could not navigate to checkout — CHECKOUT button never found');
      await this.screenshot('checkout-not-found');
      return { success: false, error: 'Could not reach checkout page', screenshotPath: null };
    }

    // Verify we're on the checkout page (not still on tee times)
    await this.page.waitForTimeout(1000);
    const onCheckoutPage = await this.page.evaluate(() => {
      const text = document.body.innerText;
      return text.includes('CHECKOUT') && (text.includes('Review Items') || text.includes('Summary') || text.includes('Terms and Conditions') || text.includes('Complete your purchase'));
    });
    if (!onCheckoutPage) {
      logger.warn('Not on checkout page after clicking CHECKOUT');
      await this.screenshot('checkout-wrong-page');
      return { success: false, error: 'Did not reach checkout page', screenshotPath: null };
    }

    logger.info('On checkout page');
    await this.screenshot('checkout-page');

    // Step 3: Check "I agree to the Terms and Conditions" checkbox
    // Dismiss any dropdowns that may have opened during navigation
    await this._dismissModals();
    await this.page.waitForTimeout(1000);

    let termsChecked = false;

    // Strategy 1: Find the specific "I agree" checkbox using targeted search
    // The checkout page has multiple checkboxes (Transactional SMS, Marketing, Terms).
    // We need the one specifically labeled "I agree to the Terms and Conditions".
    const termsResult = await this.page.evaluate(() => {
      // Find all labels/containers that specifically contain "I agree" (not just "terms")
      const allElements = document.querySelectorAll('label, span, div, p');
      for (const el of allElements) {
        const text = (el.textContent || '').trim();
        // Must contain "I agree" — this distinguishes the terms checkbox from the
        // terms dropdown ("Tee Times Terms and Conditions for Fort Walton Beach...")
        if (!/i agree/i.test(text) || text.length > 200) continue;

        // Look for a checkbox input within or near this element
        let checkbox = el.querySelector('input[type="checkbox"]');
        if (!checkbox) {
          // Try the closest label's checkbox
          const label = el.closest('label');
          if (label) checkbox = label.querySelector('input[type="checkbox"]');
        }
        if (!checkbox) {
          // Try sibling or parent containers
          const parent = el.parentElement;
          if (parent) checkbox = parent.querySelector('input[type="checkbox"]');
        }

        if (checkbox) {
          if (!checkbox.checked) {
            // Click the checkbox and dispatch events for React state updates
            checkbox.click();
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            checkbox.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return { method: 'checkbox-near-i-agree', checked: checkbox.checked };
        }

        // If element is a label, clicking it should toggle its associated checkbox
        if (el.tagName === 'LABEL' || el.closest('label')) {
          const labelEl = el.tagName === 'LABEL' ? el : el.closest('label');
          labelEl.click();
          // Re-check if a checkbox got toggled
          const cb = labelEl.querySelector('input[type="checkbox"]');
          return { method: 'clicked-i-agree-label', checked: cb ? cb.checked : 'unknown' };
        }
      }

      // Strategy 2: Find the LAST unchecked checkbox on the page — on the checkout page,
      // the Terms checkbox is typically the last one after transactional/marketing checkboxes
      const checkboxes = [...document.querySelectorAll('input[type="checkbox"]')];
      const unchecked = checkboxes.filter(cb => !cb.checked);
      if (unchecked.length > 0) {
        // Take the last unchecked checkbox (Terms is at the bottom of the form)
        const lastUnchecked = unchecked[unchecked.length - 1];
        lastUnchecked.click();
        lastUnchecked.dispatchEvent(new Event('change', { bubbles: true }));
        lastUnchecked.dispatchEvent(new Event('input', { bubbles: true }));
        return { method: 'last-unchecked-checkbox', checked: lastUnchecked.checked };
      }

      // All checkboxes already checked
      const allChecked = checkboxes.every(cb => cb.checked);
      if (checkboxes.length > 0 && allChecked) {
        return { method: 'all-already-checked', checked: true };
      }

      return null;
    });

    if (termsResult) {
      logger.info(`Terms and Conditions: ${termsResult.method} (checked: ${termsResult.checked})`);
      termsChecked = termsResult.checked === true || termsResult.checked === 'unknown';
      await this.page.waitForTimeout(1000);

      // Verify the terms checkbox is actually checked
      if (!termsChecked) {
        logger.warn('Terms checkbox click did not register — trying Playwright locator approach');
        try {
          // Try using Playwright's locator to find and check the terms checkbox
          const agreeLocator = this.page.locator('text=I agree to the Terms').locator('xpath=ancestor::label[1]//input[@type="checkbox"]');
          if (await agreeLocator.count() > 0) {
            await agreeLocator.first().check({ force: true });
            termsChecked = true;
            logger.info('Terms checkbox checked via Playwright locator');
          }
        } catch (e) {
          logger.warn(`Playwright locator approach failed: ${e.message}`);
        }
      }
    } else {
      logger.warn('Could not find Terms and Conditions checkbox');
    }

    // Wait for React to process the checkbox state change
    await this.page.waitForTimeout(2000);
    await this.screenshot('checkout-terms');

    // Step 4: Click "COMPLETE YOUR PURCHASE" button
    // First, log all visible buttons on the page for debugging
    const visibleButtons = await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button, input[type="submit"], a.btn, a.button');
      return [...buttons].filter(b => b.offsetParent !== null).map(b => {
        const clone = b.cloneNode(true);
        clone.querySelectorAll('svg, [aria-hidden="true"], [class*="Icon"]').forEach(n => n.remove());
        return { text: clone.textContent.trim(), disabled: b.disabled || b.getAttribute('aria-disabled') === 'true' };
      }).filter(b => b.text.length > 0 && b.text.length < 100);
    });
    logger.info(`Visible buttons on checkout page: ${JSON.stringify(visibleButtons)}`);

    const urlBeforePurchase = this.page.url();

    const purchaseResult = await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button, input[type="submit"], a.btn, a.button');
      const purchaseTexts = [
        'COMPLETE YOUR PURCHASE',
        'COMPLETE PURCHASE',
        'COMPLETE BOOKING',
        'PLACE ORDER',
        'CONFIRM PURCHASE',
        'CONFIRM RESERVATION',
        'COMPLETE RESERVATION',
        'SUBMIT',
        'RESERVE',
      ];
      for (const btn of buttons) {
        if (btn.offsetParent === null) continue; // skip hidden buttons
        const clone = btn.cloneNode(true);
        clone.querySelectorAll('svg, [aria-hidden="true"], [class*="Icon"]').forEach(n => n.remove());
        const text = clone.textContent.trim().toUpperCase();
        for (const target of purchaseTexts) {
          if (text.includes(target)) {
            const isDisabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
            if (!isDisabled) {
              btn.click();
              return { text: clone.textContent.trim(), disabled: false };
            } else {
              return { text: clone.textContent.trim(), disabled: true };
            }
          }
        }
      }
      return null;
    });

    if (purchaseResult && !purchaseResult.disabled) {
      logger.info(`Clicked purchase button: "${purchaseResult.text}"`);

      // After clicking "Complete your purchase", the site redirects to:
      // https://fort-walton-member.book.teeitup.golf/confirmation
      // That page shows "Reservation #XXXXXXXXX"
      let purchaseSucceeded = false;
      let confirmationUrl = null;

      // Wait for redirect to /confirmation page (up to 20 seconds)
      for (let wait = 0; wait < 7; wait++) {
        await this.page.waitForTimeout(3000);
        const currentUrl = this.page.url();
        if (currentUrl.includes('/confirmation')) {
          logger.info(`Redirected to confirmation page: ${currentUrl}`);
          confirmationUrl = currentUrl;
          purchaseSucceeded = true;
          break;
        }
        if (currentUrl !== urlBeforePurchase) {
          logger.info(`Page navigated to: ${currentUrl}`);
          // Check if this is a success page even if URL is different
          const hasConfirmation = await this.page.evaluate(() => {
            const text = document.body.innerText;
            return /reservation\s*#/i.test(text) || /confirmation/i.test(text);
          });
          if (hasConfirmation) {
            purchaseSucceeded = true;
            break;
          }
        }
      }

      if (!purchaseSucceeded) {
        logger.warn('Purchase button was clicked but page did NOT redirect to /confirmation — checkout FAILED');
        logger.warn('This usually means the Terms checkbox was not properly checked');
        await this.screenshot('checkout-no-redirect');
        return { success: false, error: 'Checkout did not redirect to confirmation page (terms may not be checked)', screenshotPath: null };
      }

      // We're on the confirmation page — wait for it to fully load
      await this.page.waitForTimeout(2000);
      const screenshotPath = await this.screenshot('checkout-confirmation');

      // Extract Reservation # from the confirmation page
      const confirmation = await this._extractConfirmation();
      logger.info(`Reservation confirmed! Number: ${confirmation || 'unknown'}`);

      return {
        success: true,
        confirmationNumber: confirmation,
        screenshotPath,
      };
    } else if (purchaseResult && purchaseResult.disabled) {
      logger.warn(`Purchase button "${purchaseResult.text}" is DISABLED — terms checkbox likely not checked`);
      await this.screenshot('checkout-button-disabled');
      return { success: false, error: 'Purchase button is disabled (terms not agreed)', screenshotPath: null };
    } else {
      logger.warn('Could not find "COMPLETE YOUR PURCHASE" button');
      await this.screenshot('checkout-no-purchase-btn');
      return { success: false, error: 'Purchase button not found', screenshotPath: null };
    }
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
            // Verify we're not still on the checkout page
            if (this.page.url().includes('/checkout')) {
              logger.warn(`"${label}" menu item stayed on /checkout — trying next`);
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

    // Increase page length to 50 so we see more reservations per page
    try {
      await this.page.evaluate(() => {
        // Find the Page Length select/dropdown and change it to 50
        const selects = document.querySelectorAll('select');
        for (const sel of selects) {
          for (const opt of sel.options) {
            if (opt.value === '50' || opt.text === '50') {
              sel.value = '50';
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }
        }
        return false;
      });
      await this.page.waitForTimeout(1500);
    } catch { /* dropdown may not support 50 */ }

    // Build date patterns once (passed into page context as plain array)
    const [resYear, resMonth, resDay] = date.split('-').map(Number);
    const _monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                         'July', 'August', 'September', 'October', 'November', 'December'];
    const _shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                          'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const datePatterns = [
      date,
      `${resMonth}/${resDay}/${resYear}`,
      `${String(resMonth).padStart(2,'0')}/${String(resDay).padStart(2,'0')}/${resYear}`,
      `${_monthNames[resMonth-1]} ${resDay}`,
      `${_shortMonths[resMonth-1]} ${resDay}`,
      `${_monthNames[resMonth-1]} ${String(resDay).padStart(2,'0')}`,
      `${_shortMonths[resMonth-1]} ${String(resDay).padStart(2,'0')}`,
    ];

    // Extract reservation details from the current page.
    // Works on the list page (card selectors) and the detail page (full-body scan fallback).
    const extractFromCurrentPage = async () => {
      return await this.page.evaluate(({ targetDate, patterns }) => {
        const results = [];
        const seen = new Set();

        function extractFromText(text) {
          if (!patterns.some(p => text.includes(p))) return;
          const timeMatch = text.match(/(\d{1,2}:\d{2})\s*(AM|PM|am|pm)/i);
          if (!timeMatch) return;
          let [, t, period] = timeMatch;
          let [h, m] = t.split(':').map(Number);
          if (period.toUpperCase() === 'PM' && h !== 12) h += 12;
          if (period.toUpperCase() === 'AM' && h === 12) h = 0;
          const time24 = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          const key = `${time24}-${text.slice(0, 30)}`;
          if (seen.has(key)) return;
          seen.add(key);
          let course = 'Unknown';
          if (/pines/i.test(text)) course = 'Pines';
          else if (/oaks/i.test(text)) course = 'Oaks';
          const playerMatch = text.match(/(\d)\s*(?:player|golfer)/i);
          const players = playerMatch ? parseInt(playerMatch[1]) : 4;
          // Match "Confirmation #Name|NUMBER" or "Reservation #NUMBER"
          const resMatch = text.match(/(?:Confirmation|Reservation)\s*#\s*(?:[^|\n]+\|)?(\d+)/i);
          const reservationNumber = resMatch ? resMatch[1] : null;
          results.push({ time: time24, course, players, date: targetDate, reservationNumber });
        }

        // Scan card-like elements (list page)
        const selectors = [
          '[role="dialog"]', '[class*="modal" i]',
          '[class*="card" i]', '[class*="reservation" i]', '[class*="booking" i]',
          '[class*="tee-time" i]', '[class*="teeTime" i]',
          'tr', 'li', '[role="listitem"]', '[class*="Card"]',
        ];
        for (const sel of selectors) {
          for (const el of document.querySelectorAll(sel)) {
            const text = el.textContent || '';
            if (text.length < 10 || text.length > 6000) continue;
            extractFromText(text);
          }
        }

        // Fallback: full body scan (for detail page after VIEW DETAILS navigation)
        if (results.length === 0) {
          const bodyText = document.body.innerText || '';
          if (patterns.some(p => bodyText.includes(p))) {
            extractFromText(bodyText);
          }
        }

        // Deduplicate by time+course
        const deduped = new Set();
        return results.filter(r => {
          const k = `${r.time}-${r.course}`;
          if (deduped.has(k)) return false;
          deduped.add(k);
          return true;
        });
      }, { targetDate: date, patterns: datePatterns });
    };

    // Wait for reservation cards to finish loading (not just the page chrome/spinner)
    try {
      await this.page.waitForFunction(
        () => /VIEW DETAILS|View Details/i.test(document.body.innerText || ''),
        { timeout: 12000, polling: 300 }
      );
    } catch { /* might be empty list or different page structure */ }
    await this.page.waitForTimeout(300);

    const MAX_PAGES = 20;
    const reservations = [];
    let lastPageHadDate = false;

    for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
      // Check if the target date is visible anywhere on this page (collapsed cards)
      const dateOnPage = await this.page.evaluate(
        (patterns) => patterns.some(p => (document.body.innerText || '').includes(p)),
        datePatterns
      );

      if (dateOnPage) {
        lastPageHadDate = true;
        logger.info(`Page ${pageNum + 1}: found date ${date} — processing matching cards`);

        // Process each matching card one at a time using a skip counter.
        // Each VIEW DETAILS click navigates to a detail page (SPA), so we
        // can only click one at a time, go back, then click the next one.
        let processed = 0;
        while (true) {
          const clicked = await this.page.evaluate(({ patterns, skip }) => {
            const cards = [...document.querySelectorAll('[class*="Card"], [class*="card"], li, [role="listitem"]')];
            const matching = cards.filter(c => {
              const t = c.textContent || '';
              return t.length > 10 && t.length < 3000 && patterns.some(p => t.includes(p));
            });
            if (matching.length <= skip) return false;
            const btn = [...matching[skip].querySelectorAll('button')].find(
              b => /view details/i.test(b.textContent || '')
            );
            if (btn) { btn.click(); return true; }
            return false;
          }, { patterns: datePatterns, skip: processed }).catch(() => false);

          if (!clicked) break;
          await this.page.waitForTimeout(2000);

          const onDetailPage = await this.page.evaluate(
            () => /CANCEL OR MODIFY|Reservation Details/i.test(document.body.innerText || '')
          );
          if (onDetailPage) {
            await this.page.waitForTimeout(500);
          }

          const found = await extractFromCurrentPage();
          for (const r of found) {
            if (!reservations.some(e => e.time === r.time && e.course === r.course)) {
              reservations.push(r);
            }
          }
          processed++;

          if (onDetailPage) {
            logger.debug(`Card ${processed}: extracted ${found.length} reservation(s) — going back`);
            await this.page.goBack({ waitUntil: 'domcontentloaded' }).catch(async () => {
              await this.page.evaluate(() => window.history.back());
            });
            await this.page.waitForTimeout(1500);
            try {
              await this.page.waitForFunction(
                () => /VIEW DETAILS/i.test(document.body.innerText || ''),
                { timeout: 8000, polling: 300 }
              );
            } catch { /* list may be empty */ }
          }
        }
      } else if (lastPageHadDate) {
        // We've advanced past the target date — all cards collected
        break;
      }

      // Advance to next page
      const advanced = await this._tryAdvanceReservationsPage();
      if (!advanced) {
        logger.debug(`No more reservation pages after page ${pageNum + 1}`);
        break;
      }
      logger.info(`Advancing to reservation page ${pageNum + 2}...`);
      // Wait for new page cards to render
      try {
        await this.page.waitForFunction(
          () => /VIEW DETAILS|View Details/i.test(document.body.innerText || ''),
          { timeout: 8000, polling: 300 }
        );
      } catch { /* last/empty page */ }
      await this.page.waitForTimeout(300);
    }

    if (reservations.length > 0) {
      const details = reservations.map(r => `${r.time} (${r.course})${r.reservationNumber ? ' Res#' + r.reservationNumber : ''}`).join(', ');
      logger.info(`Found ${reservations.length} existing reservations for ${date}: ${details}`);
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

  /**
   * Try to advance to the next page of reservations.
   * Handles "Load More" buttons, standard pagination Next buttons,
   * and infinite-scroll (detects page height growth after scrolling).
   * Returns true if the page content likely changed, false if exhausted.
   */
  async _tryAdvanceReservationsPage() {
    const nextSelectors = [
      'button:has-text("NEXT")',
      'button:has-text("Next")',
      'a:has-text("NEXT")',
      'a:has-text("Next")',
      'button:has-text("Load More")',
      'button:has-text("Show More")',
      'button:has-text("View More")',
      '[aria-label="Next page"]',
      '[aria-label="next"]',
      '[aria-label="Go to next page"]',
      'li[class*="next"] a',
      '[class*="pagination"] [class*="next"]:not([class*="disabled"])',
    ];

    for (const sel of nextSelectors) {
      try {
        const btn = await this.page.$(sel);
        if (!btn || !(await btn.isVisible())) continue;
        const disabled = await btn.evaluate(el =>
          el.disabled ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.classList.contains('disabled') ||
          el.closest('[class*="disabled"]') !== null
        );
        if (disabled) continue;
        await btn.evaluate(el => el.click());
        await this.page.waitForTimeout(2000);
        logger.debug(`Advanced reservations page via: ${sel}`);
        return true;
      } catch { /* try next selector */ }
    }

    // Infinite scroll fallback: scroll to bottom and check if page grew
    const prevHeight = await this.page.evaluate(() => document.body.scrollHeight);
    await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await this.page.waitForTimeout(1500);
    const newHeight = await this.page.evaluate(() => document.body.scrollHeight);
    if (newHeight > prevHeight) {
      logger.debug('Scrolled down to trigger infinite-scroll reservation load');
      return true;
    }

    return false;
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

  /**
   * Navigate to the reservation history page.
   */
  async navigateToReservationHistory() {
    const url = `${config.site.memberUrl}/reservation/history`;
    logger.info(`Navigating to reservation history: ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.page.waitForTimeout(3000);

    // Verify we landed on the history page (not redirected to login or 404)
    const pageUrl = this.page.url();
    const pageText = await this.page.evaluate(() => document.body.innerText.slice(0, 2000));

    if (/page not found|404/i.test(pageText)) {
      logger.warn(`Reservation history page returned 404, trying alternate URLs...`);
      const alternates = [
        `${config.site.memberUrl}/reservations`,
        `${config.site.memberUrl}/my-tee-times`,
        `${config.site.memberUrl}/reservation`,
      ];
      for (const alt of alternates) {
        try {
          await this.page.goto(alt, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await this.page.waitForTimeout(3000);
          const text = await this.page.evaluate(() => document.body.innerText.slice(0, 2000));
          if (!/page not found|404/i.test(text)) {
            logger.info(`Found reservation page at: ${alt}`);
            return true;
          }
        } catch { /* try next */ }
      }
      throw new Error('Could not find reservation history page');
    }

    logger.info(`On reservation history page: ${pageUrl}`);

    // Wait for the loading spinner to disappear and reservations to load
    try {
      await this.page.waitForFunction(() => {
        // Check that loading spinner is gone and some content appeared
        const spinners = document.querySelectorAll('[class*="CircularProgress"], [class*="spinner"], [role="progressbar"]');
        const visibleSpinner = Array.from(spinners).some(s => s.offsetParent !== null);
        return !visibleSpinner;
      }, { timeout: 15000 });
      logger.info('Reservation page finished loading');
    } catch {
      logger.warn('Timed out waiting for reservation page to finish loading — proceeding anyway');
    }
    await this.page.waitForTimeout(2000);

    // Increase "Page Length" to show all reservations
    try {
      // The MUI NativeSelect renders as a <select> inside a wrapper, OR
      // as a clickable div. Try multiple approaches.
      let pageLengthChanged = false;

      // Approach 1: Click the MUI Select area near "Page Length" text via Playwright
      try {
        // The select might be rendered as native <select> inside MUI wrapper
        const selectEl = await this.page.$('select');
        if (selectEl) {
          const options = await selectEl.evaluate(sel => Array.from(sel.options).map(o => ({ value: o.value, text: o.text })));
          logger.info(`Found native select with options: ${options.map(o => o.text).join(', ')}`);
          // Pick highest value
          const sorted = options.filter(o => !isNaN(parseInt(o.value))).sort((a, b) => parseInt(b.value) - parseInt(a.value));
          if (sorted.length > 0) {
            await selectEl.selectOption(sorted[0].value);
            logger.info(`Set page length to: ${sorted[0].text}`);
            pageLengthChanged = true;
          }
        }
      } catch (e) {
        logger.debug(`Native select approach failed: ${e.message}`);
      }

      // Approach 2: Click the element showing "5" near "Page Length" and pick from dropdown
      if (!pageLengthChanged) {
        try {
          const clicked = await this.page.evaluate(() => {
            const allEls = document.querySelectorAll('*');
            for (const el of allEls) {
              const text = el.textContent.trim();
              if (text.length > 50) continue;
              if (/^page\s*length$/i.test(text)) {
                // Found the label — look for a clickable sibling/adjacent element
                const parent = el.parentElement;
                if (!parent) continue;
                // Try all children and siblings
                for (const child of parent.querySelectorAll('*')) {
                  const ct = child.textContent.trim();
                  if (/^\d+$/.test(ct) && parseInt(ct) <= 50) {
                    child.click();
                    return 'clicked-number';
                  }
                  if (child.getAttribute('role') === 'button' || child.classList.toString().includes('Select')) {
                    child.click();
                    return 'clicked-mui';
                  }
                }
              }
            }
            return null;
          });
          if (clicked) {
            logger.info(`Opened page length dropdown via: ${clicked}`);
            await this.page.waitForTimeout(1000);
            // Select highest option
            const selected = await this.page.evaluate(() => {
              const items = document.querySelectorAll('[role="option"], [role="listbox"] li, ul[role="listbox"] li, [class*="MuiMenuItem"]');
              if (items.length === 0) return null;
              let best = null, bestVal = 0;
              for (const item of items) {
                const n = parseInt(item.textContent.trim());
                if (!isNaN(n) && n > bestVal) { bestVal = n; best = item; }
              }
              if (best) { best.click(); return bestVal; }
              return null;
            });
            if (selected) {
              logger.info(`Set page length to: ${selected}`);
              pageLengthChanged = true;
            }
          }
        } catch (e) {
          logger.debug(`MUI click approach failed: ${e.message}`);
        }
      }

      // Approach 3: Just click NEXT repeatedly to load all pages
      if (!pageLengthChanged) {
        logger.info('Could not increase page length — will paginate with NEXT button');
      } else {
        await this.page.waitForTimeout(3000);
      }
    } catch {
      logger.debug('Could not change page length');
    }

    await this.screenshot('reservation-history');
    return true;
  }

  /**
   * Cancel reservations by navigating directly to the cancel URL.
   * URL pattern: {memberUrl}/reservation/history/{confirmationNumber}/cancel
   * @param {Array} bookings - Array of booking objects with confirmation_number
   * @returns {{ cancelled: number, failed: number, details: Array }}
   */
  async cancelReservations(bookings) {
    const results = { cancelled: 0, failed: 0, details: [] };

    for (let i = 0; i < bookings.length; i++) {
      const booking = bookings[i];
      const resNum = booking.confirmation_number;
      const time = booking.actual_time || booking.target_time;
      const label = `${time} ${booking.course} (Res#${resNum})`;

      logger.info(`Cancelling ${i + 1}/${bookings.length}: ${label}...`);

      try {
        // Navigate directly to the cancel page
        const cancelUrl = `${config.site.memberUrl}/reservation/history/${resNum}/cancel`;
        logger.info(`Navigating to: ${cancelUrl}`);
        await this.page.goto(cancelUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.page.waitForTimeout(3000);
        await this.screenshot(`cancel-page-${i}`);

        // Verify we're on the cancellation page
        const pageText = await this.page.evaluate(() => document.body.innerText.slice(0, 3000));
        if (!/cancellation request/i.test(pageText)) {
          logger.warn(`Cancel page did not load for ${label}. Text: ${pageText.slice(0, 200)}`);
          results.failed++;
          results.details.push({ resNum, time, course: booking.course, success: false, error: 'Cancel page did not load' });
          continue;
        }

        // Select number of players to cancel (first MUI dropdown — pick highest)
        const playersSelected = await this._selectMuiDropdown(0, 'last');
        if (!playersSelected) {
          logger.warn('Could not select number of players to cancel');
          results.failed++;
          results.details.push({ resNum, time, course: booking.course, success: false, error: 'Could not select players' });
          continue;
        }
        logger.info(`Selected players to cancel: "${playersSelected}"`);
        await this.page.waitForTimeout(500);

        // Select reason for cancellation (second MUI dropdown — pick first real option)
        const reasonSelected = await this._selectMuiDropdown(1, 'first');
        if (!reasonSelected) {
          logger.warn('Could not select cancellation reason');
          results.failed++;
          results.details.push({ resNum, time, course: booking.course, success: false, error: 'Could not select reason' });
          continue;
        }
        logger.info(`Selected cancellation reason: "${reasonSelected}"`);
        await this.page.waitForTimeout(500);

        await this.screenshot(`cancel-form-filled-${i}`);

        // Click "SUBMIT CANCELLATION"
        const submitted = await this.page.evaluate(() => {
          const buttons = document.querySelectorAll('button, [role="button"]');
          for (const btn of buttons) {
            if (btn.offsetParent === null) continue;
            if (/submit.*cancel/i.test(btn.textContent.trim())) {
              btn.click();
              return btn.textContent.trim();
            }
          }
          return null;
        });

        if (!submitted) {
          logger.warn('Could not find SUBMIT CANCELLATION button');
          results.failed++;
          results.details.push({ resNum, time, course: booking.course, success: false, error: 'Submit button not found' });
          continue;
        }
        logger.info(`Clicked: "${submitted}"`);

        await this.page.waitForTimeout(5000);
        await this.screenshot(`cancel-result-${i}`);

        // Check result
        const resultText = await this.page.evaluate(() => document.body.innerText.slice(0, 3000));
        const hasError = /error|failed|could not cancel|unable/i.test(resultText) && !/cancel.*success/i.test(resultText);

        if (hasError) {
          logger.warn(`Cancellation may have failed for ${label}`);
          results.failed++;
          results.details.push({ resNum, time, course: booking.course, success: false, error: 'Page showed error' });
        } else {
          logger.info(`Cancellation submitted for ${label}`);
          results.cancelled++;
          results.details.push({ resNum, time, course: booking.course, success: true });
        }
      } catch (error) {
        logger.error(`Error cancelling ${label}: ${error.message}`);
        await this.screenshot(`cancel-error-${i}`);
        results.failed++;
        results.details.push({ resNum, time, course: booking.course, success: false, error: error.message });
      }
    }

    return results;
  }

  /**
   * Select an option from the Nth MUI Select dropdown on the cancel page.
   * Uses Playwright locators (not page.evaluate) since MUI class selectors
   * don't work reliably inside evaluate.
   * @param {number} dropdownIndex - 0-based index of the dropdown on the page
   * @param {string} pickStrategy - 'last' for highest value, 'first' for first real option
   * @returns {string|null} Selected option text, or null on failure
   */
  async _selectMuiDropdown(dropdownIndex, pickStrategy) {
    // Click the MUI Select trigger using Playwright locators
    const selectLocator = this.page.locator('div.MuiSelect-select');
    const count = await selectLocator.count();

    if (count <= dropdownIndex) {
      logger.warn(`Only ${count} MUI Select(s) found, need index ${dropdownIndex}`);
      return null;
    }

    await selectLocator.nth(dropdownIndex).click();
    await this.page.waitForTimeout(1000);

    // Read available options from the dropdown popover
    const optionLocator = this.page.locator('[role="option"], li.MuiMenuItem-root');
    const optionTexts = await optionLocator.allTextContents();

    if (optionTexts.length === 0) {
      logger.warn(`No options found in dropdown ${dropdownIndex}`);
      return null;
    }

    // Pick the option based on strategy
    const targetIdx = pickStrategy === 'last' ? optionTexts.length - 1 : 0;
    await optionLocator.nth(targetIdx).click();
    await this.page.waitForTimeout(500);

    return optionTexts[targetIdx];
  }
}

module.exports = SiteAutomation;
