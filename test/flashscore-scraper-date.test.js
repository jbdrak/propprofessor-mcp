'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Requiring the scraper must not execute main() (guarded by `require.main ===
// module`), so no Python/Playwright scrape is launched by this test.
const { defaultScrapeDate } = require('../scripts/flashscore-scraper');

describe('flashscore-scraper default date', () => {
  it('uses the America/Chicago calendar date when UTC is already the next day', () => {
    // 2026-07-13T02:30:00Z = 2026-07-12 21:30 CDT (UTC-5). The UTC date is
    // 07-13 (tomorrow); the Austin calendar date is still 07-12.
    const ms = Date.parse('2026-07-13T02:30:00Z');
    assert.equal(defaultScrapeDate(new Date(ms)), '2026-07-12');
  });

  it('keeps the same local date before local midnight', () => {
    // 2026-07-12T23:30:00Z = 2026-07-12 18:30 CDT — same calendar day.
    const ms = Date.parse('2026-07-12T23:30:00Z');
    assert.equal(defaultScrapeDate(new Date(ms)), '2026-07-12');
  });

  it('returns a YYYY-MM-DD key', () => {
    const ms = Date.parse('2026-07-13T02:30:00Z');
    assert.match(defaultScrapeDate(new Date(ms)), /^\d{4}-\d{2}-\d{2}$/);
  });
});
