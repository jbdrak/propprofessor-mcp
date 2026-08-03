#!/usr/bin/env node
'use strict';

/**
 * flashscore-scraper.js — Node.js wrapper for the Flashscore tennis scraper.
 *
 * Calls the Python Playwright script and writes the JSON cache.
 *
 * Usage:
 *   node scripts/flashscore-scraper.js                    # scrape today
 *   node scripts/flashscore-scraper.js --date 2026-07-30  # specific date
 *   node scripts/flashscore-scraper.js --dry-run          # show without writing
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PYTHON_SCRIPT = path.join(__dirname, 'flashscore_tennis.py');
const CACHE_DIR = path.join(__dirname, '..', 'lib', 'tennis-schedule-data');
const CACHE_PATH = path.join(CACHE_DIR, 'flashscore-cache.json');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const dateIdx = args.indexOf('--date');

/**
 * Default scrape date: the current America/Chicago (Austin) calendar date as
 * YYYY-MM-DD. The UTC date can roll over to the next day after 7 PM CDT, so
 * it must not be used for the local calendar date.
 * @param {Date|number} [now] - instant to evaluate (defaults to now)
 * @returns {string} YYYY-MM-DD in the America/Chicago timezone
 */
function defaultScrapeDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

const targetDate = dateIdx >= 0 ? args[dateIdx + 1] : defaultScrapeDate();

function main() {
  process.stderr.write(`[flashscore] Scraping Flashscore tennis for ${targetDate}...\n`);

  const pyArgs = [PYTHON_SCRIPT, '--date', targetDate];
  let stdout;
  try {
    stdout = execFileSync('python3', pyArgs, {
      encoding: 'utf-8',
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    // execFileSync throws on non-zero exit — still parse stdout
    stdout = err.stdout || '';
    const stderr = err.stderr || '';
    if (stderr) process.stderr.write(`[flashscore] python stderr: ${stderr}\n`);
    if (!stdout) {
      process.stderr.write(`[flashscore] ERROR: Python script failed with no output\n`);
      process.exit(1);
    }
  }

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    process.stderr.write(`[flashscore] ERROR: Invalid JSON from Python: ${stdout.slice(0, 200)}\n`);
    process.exit(1);
  }

  if (data.error) {
    process.stderr.write(`[flashscore] ERROR: ${data.error}\n`);
    process.exit(1);
  }

  process.stderr.write(`[flashscore] Found ${data.totalMatches} matches (${data.scheduled} scheduled)\n`);

  if (DRY_RUN) {
    const tournaments = {};
    for (const m of data.matches) {
      const key = `${m.category}: ${m.tournament}`;
      tournaments[key] = (tournaments[key] || 0) + 1;
    }
    process.stderr.write('\nTournaments:\n');
    for (const [t, count] of Object.entries(tournaments).sort()) {
      process.stderr.write(`  ${t}: ${count}\n`);
    }
    const scheduled = data.matches.filter((m) => m.status === 'scheduled').slice(0, 5);
    if (scheduled.length) {
      process.stderr.write('\nSample scheduled:\n');
      for (const m of scheduled) {
        process.stderr.write(`  ${m.time} | ${m.home} vs ${m.away} | ${m.tournament}\n`);
      }
    }
    return;
  }

  // Write cache
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
  process.stderr.write(`[flashscore] Wrote cache to ${CACHE_PATH}\n`);
}

if (require.main === module) {
  main();
}

module.exports = { defaultScrapeDate };
