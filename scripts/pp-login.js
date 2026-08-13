#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_AUTH_DIR = path.join(os.homedir(), '.propprofessor');
const DEFAULT_AUTH_FILE = path.join(DEFAULT_AUTH_DIR, 'auth.json');
const LOGIN_URL = 'https://app.propprofessor.com/login';
const DASHBOARD_URL_PATTERN = '**/dashboard**';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for user to log in

/**
 * Launch a headed Chromium browser, navigate to the PropProfessor login page,
 * wait for the user to log in (detected by navigation to /dashboard), then
 * export storage state (cookies + localStorage) and save it to auth.json.
 *
 * @param {object} [options]
 * @param {string} [options.authFile] - Destination path for auth.json
 * @param {number} [options.timeoutMs] - Max ms to wait for login (default 5 min)
 * @param {object} [options.logger] - Logger with .log() method (default console)
 * @returns {Promise<{ok: boolean, authFile: string}>}
 */
async function loginAndSaveAuth(options = {}) {
  const authFile = options.authFile || DEFAULT_AUTH_FILE;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const logger = options.logger || console;

  let chromium;
  try {
    const playwright = require('playwright');
    chromium = playwright.chromium;
  } catch (err) {
    throw new Error(
      'Playwright is required for automated login. Install it with:\n' +
        '  npm install --save-optional playwright\n' +
        '  npx playwright install chromium\n' +
        `\nOriginal error: ${err.message}`,
      { cause: err }
    );
  }

  logger.log('Launching browser...');
  // PP_LOGIN_HEADLESS=true forces headless mode (no visible browser window).
  // The CLAUDE.md taste rule says: "Don't open Chrome during propprofessor-mcp
  // work; if a browser step is required, run it headless instead of launching
  // a visible window." Headless is the default in CI; set the env var to
  // opt out only when the user explicitly wants to log in via a visible
  // browser tab.
  const headless = process.env.PP_LOGIN_HEADLESS !== 'false';
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    logger.log(`Navigating to ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    logger.log('');
    logger.log('Please log in to PropProfessor in the browser window.');
    logger.log('The browser will close automatically once login is detected.');
    logger.log(`Timeout: ${Math.round(timeoutMs / 60000)} minutes`);
    logger.log('');

    // Wait for navigation to dashboard (or any URL containing /dashboard)
    await page.waitForURL(DASHBOARD_URL_PATTERN, { timeout: timeoutMs });

    logger.log('Login detected! Saving auth...');

    // Export storage state (cookies + localStorage)
    const storageState = await context.storageState();

    // Ensure directory exists
    const authDir = path.dirname(authFile);
    fs.mkdirSync(authDir, { recursive: true });

    // Write auth file. 0o600 — owner read/write only. The auth file holds
    // the full cookie jar (June 8 SEC-003): any other local user on the box
    // being able to read these cookies means full account impersonation
    // against PropProfessor. mkdirSync above may have created the parent dir
    // with the default 0o755, which is fine — the file itself is the
    // sensitive artifact and must be locked down.
    fs.writeFileSync(authFile, JSON.stringify(storageState, null, 2), { mode: 0o600, encoding: 'utf8' });
    // Explicit chmod to cover the case where the file pre-exists from a
    // prior install with looser permissions. Idempotent.
    try {
      fs.chmodSync(authFile, 0o600);
    } catch {
      // Best effort — chmod failures on read-only volumes are non-fatal
    }

    logger.log('');
    logger.log(`Auth saved to ${authFile}`);
    logger.log('You can now use pp-query commands without manual cookie export.');

    return { ok: true, authFile };
  } finally {
    await browser.close();
  }
}

/**
 * CLI entry point for `pp-query login`.
 */
async function loginCli(options = {}) {
  const logger = options.logger || console;

  logger.log('PropProfessor Automated Login');
  logger.log('=============================');
  logger.log('');

  try {
    const result = await loginAndSaveAuth(options);
    if (options.json) {
      logger.log(JSON.stringify(result, null, 2));
    }
    return result;
  } catch (err) {
    logger.error(`Login failed: ${err.message}`);
    throw err;
  }
}

module.exports = {
  loginAndSaveAuth,
  loginCli,
  DEFAULT_AUTH_FILE,
  DEFAULT_AUTH_DIR,
  LOGIN_URL
};
