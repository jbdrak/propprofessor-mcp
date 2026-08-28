'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeHistoryPayload,
  resolveHistoryForEntity,
  getOddsHistoryStartTimestamp
} = require('../lib/propprofessor-history');
const { getSharpBookComparisonSet } = require('../lib/propprofessor-sharp-books');

describe('propprofessor history matching', () => {
  it('reports gameId metadata when selection ids differ but game ids match', async () => {
    const result = await resolveHistoryForEntity({
      client: {},
      target: {
        book: 'NoVigApp',
        pick: 'Boston Celtics',
        game: 'Boston Celtics vs Miami Heat',
        odds: '-142',
        gameId: 'game-1',
        selectionId: 'Moneyline:Boston_Celtics'
      },
      rows: [
        {
          book: 'NoVigApp',
          pick: 'Boston Celtics',
          game: 'Boston Celtics vs Miami Heat',
          odds: '-142',
          gameId: 'game-1',
          selectionId: 'Moneyline:Miami_Heat'
        }
      ],
      queryHistoryFn: async () => [
        { odds: -150, start_ts: 1 },
        { odds: -142, start_ts: 2 }
      ]
    });

    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.historyMatchedBy, 'gameId');
    assert.equal(result.historyMatchKey, 'gameId');
  });

  it('does not resolve odds history from a weak book-only row match', async () => {
    let queried = false;
    const result = await resolveHistoryForEntity({
      client: {},
      target: { book: 'NoVigApp', pick: 'Baltimore Orioles', game: 'Orioles vs Red Sox', odds: '-130' },
      rows: [
        {
          book: 'NoVigApp',
          pick: 'Portland Trail Blazers +5.5',
          game: 'Trail Blazers vs Warriors',
          odds: '+102',
          gameId: 'wrong-game',
          selectionId: 'wrong-selection'
        }
      ],
      queryHistoryFn: async () => {
        queried = true;
        return [{ odds: -110 }, { odds: -130 }];
      }
    });

    assert.equal(queried, false);
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.matchStrength.strong, false);
  });

  it('allows fallback matching when book and pick match plus game or odds matches', async () => {
    const calls = [];
    const result = await resolveHistoryForEntity({
      client: {},
      target: {
        book: 'NoVigApp',
        pick: 'Baltimore Orioles',
        game: 'Baltimore Orioles vs Boston Red Sox',
        odds: '-130'
      },
      rows: [
        {
          book: 'NoVigApp',
          pick: 'Baltimore Orioles',
          game: 'Baltimore Orioles vs Boston Red Sox',
          odds: '-120',
          gameId: 'game-1',
          selectionId: 'selection-1'
        }
      ],
      queryHistoryFn: async (params) => {
        calls.push(params);
        return [{ odds: -120 }, { odds: -140 }];
      }
    });

    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.matchStrength.strong, true);
    assert.equal(calls[0].gameId, 'game-1');
  });

  it('does not resolve fallback history when only book, pick, and odds match', async () => {
    let queried = false;
    const result = await resolveHistoryForEntity({
      client: {},
      target: {
        book: 'NoVigApp',
        pick: 'Baltimore Orioles',
        game: 'Baltimore Orioles vs Boston Red Sox',
        odds: '-130'
      },
      rows: [
        {
          book: 'NoVigApp',
          pick: 'Baltimore Orioles',
          game: 'Baltimore Orioles vs New York Yankees',
          odds: '-130',
          gameId: 'game-wrong',
          selectionId: 'selection-wrong'
        }
      ],
      queryHistoryFn: async () => {
        queried = true;
        return [
          { odds: -135, start_ts: 1 },
          { odds: -130, start_ts: 2 }
        ];
      }
    });

    assert.equal(queried, false);
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.matchStrength.strong, false);
  });

  it('queries backend odds history using the configured default lookback window', async () => {
    const calls = [];
    const fixedNowMs = Date.UTC(2026, 3, 26, 12, 0, 0);
    const result = await resolveHistoryForEntity({
      client: {},
      nowMs: fixedNowMs,
      target: {
        book: 'NoVigApp',
        pick: 'Baltimore Orioles',
        game: 'Baltimore Orioles vs Boston Red Sox',
        odds: '-130'
      },
      rows: [
        {
          book: 'NoVigApp',
          pick: 'Baltimore Orioles',
          game: 'Baltimore Orioles vs Boston Red Sox',
          odds: '-130',
          gameId: 'game-1',
          selectionId: 'selection-1'
        }
      ],
      queryHistoryFn: async (params) => {
        calls.push(params);
        return [{ odds: -120 }, { odds: -140 }];
      }
    });

    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(calls[0].startTimestamp, Math.floor(fixedNowMs / 1000) - 6 * 60 * 60);
  });

  // Regression: 2026-06-14 live test found that the upstream /odds_history
  // endpoint never returns a `line` field in any entry (only `odds`, `start_ts`,
  // `end_ts`, `liquidity`). For line-based markets (Puck Line, Run Line, Point
  // Spread, Total Goals, etc.) this means line-movement detection is degraded:
  // every entry shows line: null, so the ranker can't see actual line movement.
  // The fix: when the upstream response is missing `line`, backfill the
  // matchedRow's current line (from the screen response's line1/line2) and
  // surface a `lineFieldMissingCount` so the warning builder can flag the
  // degraded state honestly.
  it('backfills missing line values from the matched row and reports the count', async () => {
    const result = await resolveHistoryForEntity({
      client: {},
      target: {
        book: 'Circa',
        pick: 'Carolina Hurricanes -1',
        game: 'Carolina Hurricanes vs Vegas Golden Knights',
        odds: '155',
        line1: -1
      },
      rows: [
        {
          book: 'Circa',
          pick: 'Carolina Hurricanes -1',
          game: 'Carolina Hurricanes vs Vegas Golden Knights',
          odds: '155',
          line1: -1,
          line2: 1,
          gameId: 'NHL:PREMATCH:Carolina_Hurricanes:Vegas_Golden_Knights:1781481600:Carolina Hurricanes',
          selectionId: 'Puck_Line:Carolina_Hurricanes_-1'
        }
      ],
      // Upstream response: 3 entries, NONE with a `line` field. This is the
      // exact shape observed in the live 2026-06-14 probe (874/874 entries
      // across NHL/MLB/UFC had no line field at all).
      queryHistoryFn: async () => [
        { odds: 155, start_ts: 1781397799293, end_ts: 1781404059458, liquidity: 0 },
        { odds: 150, start_ts: 1781404060668, end_ts: 1781404100000, liquidity: 0 },
        { odds: 158, start_ts: 1781404200000, end_ts: 1781404300000, liquidity: 0 }
      ]
    });

    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.lineHistory.length, 3);
    // Every entry should now have a `line` value (backfilled from the row's line1).
    for (const entry of result.lineHistory) {
      assert.equal(entry.line, -1, `Expected line=-1 backfilled, got ${entry.line}`);
    }
    // The backfill count should match the number of missing entries.
    assert.equal(result.lineFieldMissingCount, 3);
  });

  it('does not backfill when the upstream already provides a line value', async () => {
    const result = await resolveHistoryForEntity({
      client: {},
      target: {
        book: 'Pinnacle',
        pick: 'Carolina Hurricanes -1',
        game: 'Carolina Hurricanes vs Vegas Golden Knights',
        odds: '155',
        line1: -1
      },
      rows: [
        {
          book: 'Pinnacle',
          pick: 'Carolina Hurricanes -1',
          game: 'Carolina Hurricanes vs Vegas Golden Knights',
          odds: '155',
          line1: -1,
          gameId: 'NHL:PREMATCH:Carolina_Hurricanes:Vegas_Golden_Knights:1781481600:Carolina Hurricanes',
          selectionId: 'Puck_Line:Carolina_Hurricanes_-1'
        }
      ],
      // Upstream response with line values present (hypothetical clean state).
      queryHistoryFn: async () => [
        { line: -1, odds: 155, start_ts: 1, end_ts: 2, liquidity: 0 },
        { line: -1.5, odds: 165, start_ts: 3, end_ts: 4, liquidity: 0 }
      ]
    });

    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.lineFieldMissingCount, 0);
    // Verify actual line values were preserved (not overwritten by backfill).
    assert.equal(result.lineHistory[0].line, -1);
    assert.equal(result.lineHistory[1].line, -1.5);
  });

  it('does not backfill on moneyline rows (line1 is null)', async () => {
    const result = await resolveHistoryForEntity({
      client: {},
      target: {
        book: 'Pinnacle',
        pick: 'Carolina Hurricanes',
        game: 'Carolina Hurricanes vs Vegas Golden Knights',
        odds: '-113',
        line1: null
      },
      rows: [
        {
          book: 'Pinnacle',
          pick: 'Carolina Hurricanes',
          game: 'Carolina Hurricanes vs Vegas Golden Knights',
          odds: '-113',
          line1: null,
          gameId: 'NHL:PREMATCH:Carolina_Hurricanes:Vegas_Golden_Knights:1781481600:Carolina Hurricanes',
          selectionId: 'Moneyline:Carolina_Hurricanes'
        }
      ],
      queryHistoryFn: async () => [
        { odds: -113, start_ts: 1, end_ts: 2, liquidity: 100 },
        { odds: -114, start_ts: 3, end_ts: 4, liquidity: 200 }
      ]
    });

    assert.equal(result.lineHistoryAvailable, true);
    // Moneylines legitimately have line: null. We don't backfill.
    assert.equal(result.lineFieldMissingCount, 0);
    for (const entry of result.lineHistory) {
      assert.equal(entry.line, null);
    }
  });

  it('falls back to the default lookback window for invalid values', () => {
    const fixedNowMs = Date.UTC(2026, 3, 26, 12, 0, 0);
    assert.equal(
      getOddsHistoryStartTimestamp({ lookbackHours: 0, nowMs: fixedNowMs }),
      Math.floor(fixedNowMs / 1000) - 6 * 60 * 60
    );
  });

  it('uses target ids when the best matching backend row is missing resolvable ids', async () => {
    const calls = [];
    const result = await resolveHistoryForEntity({
      client: {},
      target: {
        book: 'NoVigApp',
        pick: 'Boston Celtics',
        game: 'Boston Celtics vs Philadelphia 76ers',
        odds: '-105',
        gameId: 'game-99',
        selectionId: 'selection-99'
      },
      rows: [{ book: 'NoVigApp', pick: 'Boston Celtics', game: 'Boston Celtics vs Philadelphia 76ers', odds: '-105' }],
      queryHistoryFn: async (params) => {
        calls.push(params);
        return [{ odds: -110 }, { odds: -105 }];
      }
    });

    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(calls[0].gameId, 'game-99');
    assert.equal(calls[0].selectionId, 'selection-99');
  });

  it('flattens sportsbook-keyed odds history payloads', () => {
    const result = normalizeHistoryPayload({
      Rebet: [
        { odds: -118, start_ts: 1, liquidity: 20 },
        { odds: -112, start_ts: 2, liquidity: 30 }
      ],
      FanDuel: [{ odds: -110, start_ts: 3, liquidity: 0 }]
    });

    assert.equal(result.length, 3);
    assert.equal(result[0].book, 'Rebet');
    assert.equal(result[0].odds, -118);
    assert.equal(result[2].book, 'FanDuel');
  });

  it('sorts normalized odds history chronologically across payload shapes', () => {
    const result = normalizeHistoryPayload({
      NoVigApp: [
        { odds: -110, start_ts: 30 },
        { odds: -120, start_ts: 10 }
      ],
      FanDuel: [{ odds: -118, start_ts: 20 }]
    });

    assert.deepEqual(
      result.map((point) => point.odds),
      [-120, -118, -110]
    );
    assert.deepEqual(
      result.map((point) => point.book),
      ['NoVigApp', 'FanDuel', 'NoVigApp']
    );
  });

  it('parses numeric-string epoch timestamps without treating them as date strings', () => {
    const result = normalizeHistoryPayload([
      { odds: -110, start_ts: '1782551889460' },
      { odds: -120, start_ts: '1782551782005' }
    ]);

    assert.deepEqual(
      result.map((point) => point.time),
      ['1782551782005', '1782551889460']
    );
  });

  it('does not use response_received as a history timestamp', () => {
    const result = normalizeHistoryPayload([
      { odds: -110, response_received: '2026-08-28T12:00:00Z' },
      { odds: -120, response_received: '2026-08-28T12:01:00Z' }
    ]);

    assert.deepEqual(
      result.map((point) => point.time),
      [null, null]
    );
  });

  it('passes preferred and sharp sportsbooks into odds-history hydration requests', async () => {
    const calls = [];
    const sharpBooks = getSharpBookComparisonSet({ league: 'NBA', market: 'Moneyline' });
    const result = await resolveHistoryForEntity({
      client: {},
      target: { book: 'NoVigApp', pick: 'Boston Celtics', game: 'Boston Celtics vs Miami Heat', odds: '-142' },
      rows: [
        {
          book: 'NoVigApp',
          pick: 'Boston Celtics',
          game: 'Boston Celtics vs Miami Heat',
          odds: '-142',
          gameId: 'game-1',
          selectionId: 'Moneyline:Boston_Celtics'
        }
      ],
      preferredBook: 'NoVigApp',
      sharpBooks,
      queryHistoryFn: async (params) => {
        calls.push(params);
        return {
          NoVigApp: [
            { odds: -150, start_ts: 1 },
            { odds: -142, start_ts: 2 }
          ]
        };
      }
    });

    assert.equal(result.lineHistoryAvailable, true);
    assert.deepEqual(calls[0].sportsbooks, ['NoVigApp', ...sharpBooks]);
    assert.deepEqual(result.historySportsbooksRequested, ['NoVigApp', ...sharpBooks]);
  });
});
