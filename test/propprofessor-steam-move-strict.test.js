'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { detectSteamMove } = require('../lib/propprofessor-steam-move');

/**
 * Helper: build a row with lineHistory where each sharp book has a clean
 * opening point (outside the window) and a series of recent points inside
 * the window with monotonically changing odds.
 */
function buildSteamRow({ books, recentOffsetsMs, openingOdds, recentOdds }) {
  const now = Date.now();
  const openTime = new Date(now - 30 * 60 * 1000).toISOString();
  const history = [];
  for (const book of books) {
    history.push({ book, time: openTime, odds: openingOdds });
    recentOffsetsMs.forEach((offset, i) => {
      history.push({
        book,
        time: new Date(now + offset).toISOString(),
        // Interpolate between opening and recent
        odds: openingOdds + (recentOdds - openingOdds) * ((i + 1) / recentOffsetsMs.length)
      });
    });
  }
  return { lineHistory: history, _now: now };
}

describe('strict steam rule (5-min window, 3+ sharp books)', () => {
  const STRICT = { steamWindowMs: 5 * 60 * 1000, minBooks: 3 };
  const LEGACY = { steamWindowMs: 60 * 60 * 1000, minBooks: 2 };

  it('flags 3 sharp books moving in same direction within 5 minutes', () => {
    const row = buildSteamRow({
      books: ['Pinnacle', 'Circa', 'BookMaker'],
      recentOffsetsMs: [-4 * 60 * 1000, -2 * 60 * 1000, -30 * 1000],
      openingOdds: -140,
      recentOdds: -160
    });
    const result = detectSteamMove(row, { ...STRICT, nowMs: row._now });
    assert.equal(result.isSteam, true, '3 books moving down within 4 min should be strict steam');
    assert.deepEqual(result.steamBooks.sort(), ['BookMaker', 'Circa', 'Pinnacle'].sort());
    assert.equal(result.direction, 'down');
  });

  it('does NOT flag 2 books within 5 minutes (strict needs 3+)', () => {
    const row = buildSteamRow({
      books: ['Pinnacle', 'Circa'],
      recentOffsetsMs: [-3 * 60 * 1000, -60 * 1000],
      openingOdds: -140,
      recentOdds: -160
    });
    const strict = detectSteamMove(row, { ...STRICT, nowMs: row._now });
    const legacy = detectSteamMove(row, { ...LEGACY, nowMs: row._now });
    assert.equal(strict.isSteam, false, '2 books should NOT trigger strict steam');
    assert.equal(legacy.isSteam, true, '2 books within 1h SHOULD trigger legacy steam');
  });

  it('does NOT flag 3 books when only 2 have moved inside the 5-min window', () => {
    // Pinnacle moved 6 min ago, the other 2 moved 2 min ago. With a 5-min window,
    // Pinnacle's move is dropped, leaving only 2 books → strict fails.
    const now = Date.now();
    const openTime = new Date(now - 30 * 60 * 1000).toISOString();
    const recentInside1 = new Date(now - 2 * 60 * 1000).toISOString();
    const recentInside2 = new Date(now - 60 * 1000).toISOString();
    const recentOutside = new Date(now - 6 * 60 * 1000).toISOString();
    const row = {
      lineHistory: [
        { book: 'Pinnacle', time: openTime, odds: -140 },
        { book: 'Pinnacle', time: recentOutside, odds: -160 }, // outside strict window
        { book: 'Circa', time: openTime, odds: -140 },
        { book: 'Circa', time: recentInside1, odds: -160 },
        { book: 'BookMaker', time: openTime, odds: -140 },
        { book: 'BookMaker', time: recentInside2, odds: -160 }
      ]
    };
    const strict = detectSteamMove(row, { ...STRICT, nowMs: now });
    const legacy = detectSteamMove(row, { ...LEGACY, nowMs: now });
    assert.equal(strict.isSteam, false, '3rd book outside 5-min window → strict should fail');
    assert.equal(legacy.isSteam, true, 'all 3 books within 1h → legacy should still flag');
  });

  it('does NOT flag when books move in mixed directions', () => {
    const now = Date.now();
    const openTime = new Date(now - 30 * 60 * 1000).toISOString();
    const recentTime = new Date(now - 60 * 1000).toISOString();
    const row = {
      lineHistory: [
        { book: 'Pinnacle', time: openTime, odds: -140 },
        { book: 'Pinnacle', time: recentTime, odds: -160 }, // down
        { book: 'Circa', time: openTime, odds: -140 },
        { book: 'Circa', time: recentTime, odds: -120 }, // up (mixed)
        { book: 'BookMaker', time: openTime, odds: -140 },
        { book: 'BookMaker', time: recentTime, odds: -160 } // down
      ]
    };
    const strict = detectSteamMove(row, { ...STRICT, nowMs: now });
    assert.equal(strict.isSteam, false, 'mixed directions should not be steam');
  });

  it('regression: ignores non-sharp books even when 3+ are present', () => {
    const row = buildSteamRow({
      books: ['Fliff', 'NoVigApp', 'Bovada'], // none are sharp
      recentOffsetsMs: [-3 * 60 * 1000, -60 * 1000],
      openingOdds: -140,
      recentOdds: -160
    });
    const strict = detectSteamMove(row, { ...STRICT, nowMs: row._now });
    const legacy = detectSteamMove(row, { ...LEGACY, nowMs: row._now });
    assert.equal(strict.isSteam, false, 'non-sharp books should not count');
    assert.equal(legacy.isSteam, false, 'non-sharp books should not count');
  });

  it('4 books within 2 minutes (tighter than default window) still triggers', () => {
    const row = buildSteamRow({
      books: ['Pinnacle', 'Circa', 'BookMaker', 'BetOnline'],
      recentOffsetsMs: [-90 * 1000, -45 * 1000, -15 * 1000],
      openingOdds: -140,
      recentOdds: -160
    });
    const strict = detectSteamMove(row, { ...STRICT, nowMs: row._now });
    assert.equal(strict.isSteam, true, '4 books in 2 min should be steam');
    assert.equal(strict.steamBooks.length, 4);
  });
});

describe('steam originator provenance (research: originators move first)', () => {
  it('counts originator books separately from followers in a steam move', () => {
    // Pinnacle + Circa are originators; DraftKings is a follower and should NOT
    // inflate originatorCount.
    const row = buildSteamRow({
      books: ['Pinnacle', 'Circa', 'DraftKings'],
      recentOffsetsMs: [-4 * 60 * 1000, -2 * 60 * 1000, -30 * 1000],
      openingOdds: -140,
      recentOdds: -160
    });
    const result = detectSteamMove(row, { steamWindowMs: 5 * 60 * 1000, minBooks: 3, nowMs: row._now });
    assert.equal(result.isSteam, true, '3 books (2 originators + 1 follower) should be steam at minBooks=3');
    assert.equal(result.originatorCount, 2, 'only Pinnacle + Circa are originators');
  });

  it('exposes originatorCount=0 when only followers move (weaker signal)', () => {
    const row = buildSteamRow({
      books: ['DraftKings', 'FanDuel', 'BetMGM'],
      recentOffsetsMs: [-4 * 60 * 1000, -2 * 60 * 1000, -30 * 1000],
      openingOdds: -140,
      recentOdds: -160
    });
    const result = detectSteamMove(row, { steamWindowMs: 5 * 60 * 1000, minBooks: 3, nowMs: row._now });
    assert.equal(result.isSteam, true, '3 followers still satisfy the multi-book rule');
    assert.equal(result.originatorCount, 0, 'no originators moved — followers copying only');
  });
});

describe('strict + legacy side-by-side comparison (what the daily report will see)', () => {
  it('shows steamMoveLegacy=true, steamMove=false when only 2 books moved within 1h', () => {
    const row = buildSteamRow({
      books: ['Pinnacle', 'Circa'],
      recentOffsetsMs: [-30 * 60 * 1000, -15 * 60 * 1000],
      openingOdds: -140,
      recentOdds: -160
    });
    const strictResult = detectSteamMove(row, { steamWindowMs: 5 * 60 * 1000, minBooks: 3, nowMs: row._now });
    const legacyResult = detectSteamMove(row, { steamWindowMs: 60 * 60 * 1000, minBooks: 2, nowMs: row._now });

    // Simulating the dual call in screen-utils.js
    const output = {
      steamMove: strictResult.isSteam, // false
      steamMoveLegacy: legacyResult.isSteam, // true
      steamBooks: strictResult.steamBooks,
      steamBooksLegacy: legacyResult.steamBooks
    };
    assert.equal(output.steamMove, false);
    assert.equal(output.steamMoveLegacy, true);
    assert.deepEqual(output.steamBooksLegacy.sort(), ['Circa', 'Pinnacle'].sort());
  });

  it('both flags true when 3 books moved within 5 minutes (rare but happens)', () => {
    const row = buildSteamRow({
      books: ['Pinnacle', 'Circa', 'BookMaker'],
      recentOffsetsMs: [-4 * 60 * 1000, -2 * 60 * 1000, -30 * 1000],
      openingOdds: -140,
      recentOdds: -160
    });
    const strictResult = detectSteamMove(row, { steamWindowMs: 5 * 60 * 1000, minBooks: 3, nowMs: row._now });
    const legacyResult = detectSteamMove(row, { steamWindowMs: 60 * 60 * 1000, minBooks: 2, nowMs: row._now });
    assert.equal(strictResult.isSteam, true);
    assert.equal(legacyResult.isSteam, true);
  });
});
