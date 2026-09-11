'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectSteamMove,
  isSharpBook,
  parseTimestamp,
  getOddsDirection,
  isSupportiveDirection
} = require('../lib/ssb-steam-move');

describe('isSharpBook', () => {
  it('identifies known sharp books', () => {
    assert.equal(isSharpBook('Pinnacle'), true);
    assert.equal(isSharpBook('Circa'), true);
    assert.equal(isSharpBook('BookMaker'), true);
    assert.equal(isSharpBook('FanDuel'), true);
  });

  it('rejects non-sharp books', () => {
    assert.equal(isSharpBook('Fliff'), false);
    assert.equal(isSharpBook('NoVigApp'), false);
    assert.equal(isSharpBook('Bovada'), false);
  });
});

describe('parseTimestamp', () => {
  it('parses millisecond timestamps', () => {
    assert.equal(parseTimestamp(1717000000000), 1717000000000);
  });

  it('parses second timestamps', () => {
    assert.equal(parseTimestamp(1717000000), 1717000000000);
  });

  it('parses ISO strings', () => {
    assert.equal(parseTimestamp('2025-05-29T12:00:00Z'), Date.parse('2025-05-29T12:00:00Z'));
  });

  it('returns null for invalid', () => {
    assert.equal(parseTimestamp(null), null);
    assert.equal(parseTimestamp('invalid'), null);
    assert.equal(parseTimestamp(NaN), null);
  });
});

describe('getOddsDirection', () => {
  it('detects up movement', () => {
    assert.equal(getOddsDirection(-110, -105), 'up');
    assert.equal(getOddsDirection(+130, +140), 'up');
  });

  it('detects down movement', () => {
    assert.equal(getOddsDirection(-105, -110), 'down');
    assert.equal(getOddsDirection(+140, +130), 'down');
  });

  it('returns null for no change', () => {
    assert.equal(getOddsDirection(-110, -110), null);
  });

  it('returns null for invalid values', () => {
    assert.equal(getOddsDirection(NaN, -110), null);
    assert.equal(getOddsDirection(-110, NaN), null);
  });
});

describe('isSupportiveDirection', () => {
  it('down is supportive for home/favorite', () => {
    assert.equal(isSupportiveDirection('down', 'home'), true);
    assert.equal(isSupportiveDirection('down', 'favorite'), true);
    assert.equal(isSupportiveDirection('up', 'home'), false);
  });

  it('up is supportive for away/underdog', () => {
    assert.equal(isSupportiveDirection('up', 'away'), true);
    assert.equal(isSupportiveDirection('up', 'underdog'), true);
    assert.equal(isSupportiveDirection('down', 'away'), false);
  });

  it('any direction is supportive when pickSide unknown', () => {
    assert.equal(isSupportiveDirection('up', null), true);
    assert.equal(isSupportiveDirection('down', null), true);
  });
});

describe('detectSteamMove', () => {
  const nowMs = Date.parse('2025-05-29T12:00:00Z');

  it('detects steam when 2+ sharp books move same direction fast', () => {
    const row = {
      lineHistory: [
        { book: 'Pinnacle', odds: -110, time: '2025-05-29T11:00:00Z' },
        { book: 'Pinnacle', odds: -115, time: '2025-05-29T11:30:00Z' },
        { book: 'Circa', odds: -108, time: '2025-05-29T11:05:00Z' },
        { book: 'Circa', odds: -113, time: '2025-05-29T11:35:00Z' }
      ]
    };
    const result = detectSteamMove(row, { nowMs });
    assert.equal(result.isSteam, true);
    assert.ok(result.steamBooks.includes('Pinnacle'));
    assert.ok(result.steamBooks.includes('Circa'));
    assert.equal(result.direction, 'down');
  });

  it('rejects single book movement (not steam)', () => {
    const row = {
      lineHistory: [
        { book: 'Pinnacle', odds: -110, time: '2025-05-29T11:00:00Z' },
        { book: 'Pinnacle', odds: -115, time: '2025-05-29T11:30:00Z' }
      ]
    };
    const result = detectSteamMove(row, { nowMs });
    assert.equal(result.isSteam, false);
    assert.equal(result.reason, 'insufficient_book_count');
  });

  it('rejects old movement outside window', () => {
    const row = {
      lineHistory: [
        { book: 'Pinnacle', odds: -110, time: '2025-05-28T10:00:00Z' },
        { book: 'Pinnacle', odds: -115, time: '2025-05-28T10:30:00Z' },
        { book: 'Circa', odds: -108, time: '2025-05-28T10:05:00Z' },
        { book: 'Circa', odds: -113, time: '2025-05-28T10:35:00Z' }
      ]
    };
    const result = detectSteamMove(row, { nowMs });
    assert.equal(result.isSteam, false);
    assert.equal(result.reason, 'no_recent_movement');
  });

  it('rejects mixed directions (no consensus)', () => {
    const row = {
      lineHistory: [
        { book: 'Pinnacle', odds: -110, time: '2025-05-29T11:00:00Z' },
        { book: 'Pinnacle', odds: -115, time: '2025-05-29T11:30:00Z' },
        { book: 'Circa', odds: -115, time: '2025-05-29T11:05:00Z' },
        { book: 'Circa', odds: -108, time: '2025-05-29T11:35:00Z' }
      ]
    };
    const result = detectSteamMove(row, { nowMs });
    assert.equal(result.isSteam, false);
    assert.equal(result.dominantBookCount, 1);
  });

  it('rejects insufficient history', () => {
    const row = {
      lineHistory: [{ book: 'Pinnacle', odds: -110, time: '2025-05-29T11:00:00Z' }]
    };
    const result = detectSteamMove(row, { nowMs });
    assert.equal(result.isSteam, false);
    assert.equal(result.reason, 'insufficient_history');
  });

  it('respects custom steam window', () => {
    const row = {
      lineHistory: [
        { book: 'Pinnacle', odds: -110, time: '2025-05-29T09:00:00Z' },
        { book: 'Pinnacle', odds: -115, time: '2025-05-29T10:30:00Z' },
        { book: 'Circa', odds: -108, time: '2025-05-29T09:05:00Z' },
        { book: 'Circa', odds: -113, time: '2025-05-29T10:35:00Z' }
      ]
    };
    // 1 hour window: movement is 1.5 hours old, should not detect
    const shortWindow = detectSteamMove(row, { nowMs, steamWindowMs: 60 * 60 * 1000 });
    assert.equal(shortWindow.isSteam, false);

    // 3 hour window: should detect
    const longWindow = detectSteamMove(row, { nowMs, steamWindowMs: 3 * 60 * 60 * 1000 });
    assert.equal(longWindow.isSteam, true);
  });

  it('checks supportive direction when pickSide provided', () => {
    // Movement is UP (odds increasing) - supportive for away/underdog
    const row = {
      lineHistory: [
        { book: 'Pinnacle', odds: -115, time: '2025-05-29T11:00:00Z' },
        { book: 'Pinnacle', odds: -110, time: '2025-05-29T11:30:00Z' },
        { book: 'Circa', odds: -113, time: '2025-05-29T11:05:00Z' },
        { book: 'Circa', odds: -108, time: '2025-05-29T11:35:00Z' }
      ]
    };
    // Away pick: up is supportive
    const awayResult = detectSteamMove(row, { nowMs, pickSide: 'away' });
    assert.equal(awayResult.isSteam, true);

    // Home pick: up is NOT supportive
    const homeResult = detectSteamMove(row, { nowMs, pickSide: 'home' });
    assert.equal(homeResult.isSteam, false);
    assert.equal(homeResult.reason, 'adverse_direction');
  });

  it('uses filteredLineHistory when available', () => {
    const row = {
      filteredLineHistory: [
        { book: 'Pinnacle', odds: -110, time: '2025-05-29T11:00:00Z' },
        { book: 'Pinnacle', odds: -115, time: '2025-05-29T11:30:00Z' },
        { book: 'Circa', odds: -108, time: '2025-05-29T11:05:00Z' },
        { book: 'Circa', odds: -113, time: '2025-05-29T11:35:00Z' }
      ],
      lineHistory: [{ book: 'Bovada', odds: -100, time: '2025-05-29T11:00:00Z' }]
    };
    const result = detectSteamMove(row, { nowMs });
    assert.equal(result.isSteam, true);
    assert.ok(result.steamBooks.includes('Pinnacle'));
  });

  it('ignores non-sharp books in steam detection', () => {
    const row = {
      lineHistory: [
        { book: 'Fliff', odds: -110, time: '2025-05-29T11:00:00Z' },
        { book: 'Fliff', odds: -115, time: '2025-05-29T11:30:00Z' },
        { book: 'NoVigApp', odds: -108, time: '2025-05-29T11:05:00Z' },
        { book: 'NoVigApp', odds: -113, time: '2025-05-29T11:35:00Z' }
      ]
    };
    const result = detectSteamMove(row, { nowMs });
    assert.equal(result.isSteam, false);
  });
});
