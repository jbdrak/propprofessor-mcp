'use strict';

// Task 2: exact tennis detail must correct row.start BEFORE history hydration.
//
// Boundary: the SharpOdds event matcher receives `request.startTime` derived
// from parseStartMs(row) inside the provider's resolve(row), which runs
// before native hydration in resolveHistoryWithLineFallback. Native
// queryOddsHistory.startTimestamp is only the lookback cutoff — never the
// event start — so this test observes the matcher, not the native timestamp.
//
// Fails before the fix (matcher sees the stale PP start); passes after
// (matcher sees the Flashscore-corrected start).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Patch the matcher BEFORE the handler chain loads: the history provider
// destructures matchSharpOddsEvent at require time, so the wrapper must be
// installed first.
const sharpMatch = require('../lib/sharpodds-match');
const origMatch = sharpMatch.matchSharpOddsEvent;
const seenStartTimes = [];
sharpMatch.matchSharpOddsEvent = function (request, candidate, options) {
  if (request && request.startTime !== undefined && request.startTime !== null) {
    seenStartTimes.push(request.startTime);
  }
  return origMatch.call(this, request, candidate, options);
};

const flashscore = require('../lib/flashscore-times');
const tennis = require('../lib/propprofessor-tennis');
const { createPlayDetailsHandlers } = require('../scripts/server/handlers/play-details');

const STALE_PP_START = '2026-09-15T10:00:00.000Z';
const STALE_MS = Date.parse(STALE_PP_START);
const FS_TIME = '22:05'; // CDT on the schedule date
const FS_DATE = '2026-09-15';
const CORRECTED_ISO = tennis.flashscoreTimeToISO(FS_TIME, FS_DATE);
const CORRECTED_MS = Date.parse(CORRECTED_ISO);
const GAME_ID = 'Tennis:PREMATCH:Shapovalov:Pacheco_Mendez:1786017600';

let origLookup;
let origCacheInfo;
let origFetch;

function tennisRow() {
  return {
    gameId: GAME_ID,
    game: 'Shapovalov vs Pacheco Mendez',
    league: 'Tennis',
    market: 'Moneyline',
    homeTeam: 'Shapovalov',
    awayTeam: 'Pacheco Mendez',
    start: STALE_PP_START,
    selectionId: 'Moneyline:Shapovalov',
    selection: 'Shapovalov',
    pick: 'Shapovalov',
    participant: 'Shapovalov',
    odds: -170,
    book: 'NoVigApp'
  };
}

beforeEach(() => {
  assert.ok(
    Number.isFinite(CORRECTED_MS) && Math.abs(CORRECTED_MS - STALE_MS) > 90 * 60 * 1000,
    'fixture sanity: Flashscore-corrected time must differ from stale PP start by >90min (SharpOdds tolerance)'
  );
  seenStartTimes.length = 0;
  origLookup = flashscore.lookupFromPPRow;
  origCacheInfo = flashscore.getCacheInfo;
  // Flashscore is authoritative for this matchup: fresh cache + exact row hit.
  flashscore.getCacheInfo = () => ({ fresh: true, stale: false });
  flashscore.lookupFromPPRow = () => ({
    time: FS_TIME,
    date: FS_DATE,
    tournament: 'Los Cabos',
    category: 'ATP',
    home: 'Shapovalov',
    away: 'Pacheco Mendez'
  });
  origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url && url.href ? url.href : url);
    if (href.includes('tsp.live')) {
      // SharpOdds board: one event at the CORRECTED time. A stale row.start
      // misses it (outside the 90min tolerance); the corrected start hits it.
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: 'ev-corrected-1',
              homeTeam: 'Shapovalov',
              awayTeam: 'Pacheco Mendez',
              startTime: CORRECTED_ISO
            }
          ]
        })
      };
    }
    // ESPN fallback inside correctTennisTimes: no matches, stay offline.
    return { ok: true, status: 200, json: async () => ({ events: [] }) };
  };
});

afterEach(() => {
  flashscore.lookupFromPPRow = origLookup;
  flashscore.getCacheInfo = origCacheInfo;
  globalThis.fetch = origFetch;
  seenStartTimes.length = 0;
});

describe('tennis detail corrects row.start before history hydration (Task 2)', () => {
  it('SharpOdds event matcher observes the Flashscore-corrected start, not the stale PP start', async () => {
    const client = {
      queryScreenOddsBestComps: async () => ({ rows: [tennisRow()] }),
      queryScreenOdds: async () => ({ rows: [] }),
      queryOddsHistory: async () => ({})
    };
    const { runGetPlayDetailsImpl } = createPlayDetailsHandlers(client, {});
    const response = await runGetPlayDetailsImpl(client, {
      league: 'Tennis',
      market: 'Moneyline',
      gameIds: [GAME_ID],
      books: ['NoVigApp'],
      enableSharpOddsHistory: true
    });

    assert.ok(
      seenStartTimes.length >= 1,
      `expected the SharpOdds matcher to run at least once (got ${seenStartTimes.length} calls)`
    );
    assert.equal(
      seenStartTimes[0],
      CORRECTED_MS,
      `matcher must observe the Flashscore-corrected start (${CORRECTED_ISO}), ` +
        `not the stale PP start (${STALE_PP_START}); got ${new Date(seenStartTimes[0]).toISOString()}`
    );
    // Sanity: the detail response itself carries the corrected start.
    const row = Array.isArray(response?.result) ? response.result[0] : null;
    if (row && row.start) {
      assert.equal(row.start, CORRECTED_ISO);
    }
  });
});
