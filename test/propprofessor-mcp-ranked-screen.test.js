'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRankedScreenResponse,
  buildDegradedDataWarnings,
  getIncludeAll,
  getLimit,
  getLookbackHours,
  getRecentWindowHours,
  getMaxAgeMs,
  normalizeBookList,
  getDebugFlag,
  DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS
} = require('../lib/propprofessor-mcp-ranked-screen');

describe('normalizeBookList', () => {
  it('deduplicates book names', () => {
    const result = normalizeBookList(['DraftKings', 'FanDuel', 'DraftKings']);
    assert.deepEqual(result, ['DraftKings', 'FanDuel']);
  });

  it('trims whitespace from each entry', () => {
    const result = normalizeBookList(['  DK  ', ' FD ']);
    assert.deepEqual(result, ['DK', 'FD']);
  });

  it('filters out empty strings', () => {
    const result = normalizeBookList(['DK', '', '  ', 'FD']);
    assert.deepEqual(result, ['DK', 'FD']);
  });

  it('returns empty array for non-array input', () => {
    assert.deepEqual(normalizeBookList(null), []);
    assert.deepEqual(normalizeBookList(undefined), []);
    assert.deepEqual(normalizeBookList('DK'), []);
    assert.deepEqual(normalizeBookList(42), []);
  });

  it('coerces non-string entries to strings', () => {
    const result = normalizeBookList([123, true, 'DK']);
    assert.deepEqual(result, ['123', 'true', 'DK']);
  });
});

describe('getLimit', () => {
  it('returns explicit limit when valid', () => {
    assert.equal(getLimit({ limit: 25 }), 25);
    assert.equal(getLimit({ limit: '5' }), 5);
    assert.equal(getLimit({ limit: 1 }), 1);
  });

  it('returns 100 default for invalid or missing limit', () => {
    assert.equal(getLimit({}), 100);
    assert.equal(getLimit({ limit: -1 }), 100);
    assert.equal(getLimit({ limit: 0 }), 100);
    assert.equal(getLimit({ limit: 'abc' }), 100);
    assert.equal(getLimit({ limit: NaN }), 100);
    assert.equal(getLimit({ limit: Infinity }), 100);
  });
});

describe('getIncludeAll', () => {
  it('returns true by default', () => {
    assert.equal(getIncludeAll({}), true);
    assert.equal(getIncludeAll(), true);
  });

  it('respects explicit false', () => {
    assert.equal(getIncludeAll({ includeAll: false }), false);
  });

  it('respects explicit true', () => {
    assert.equal(getIncludeAll({ includeAll: true }), true);
  });

  it('coerces truthy/falsy values', () => {
    assert.equal(getIncludeAll({ includeAll: 0 }), false);
    assert.equal(getIncludeAll({ includeAll: 1 }), true);
  });
});

describe('getMaxAgeMs', () => {
  it('returns value when valid', () => {
    assert.equal(getMaxAgeMs({ maxAgeMs: 60000 }), 60000);
    assert.equal(getMaxAgeMs({ maxAgeMs: 0 }), 0);
    assert.equal(getMaxAgeMs({ maxAgeMs: '30000' }), 30000);
  });

  it('returns undefined for invalid or missing', () => {
    assert.equal(getMaxAgeMs({}), undefined);
    assert.equal(getMaxAgeMs({ maxAgeMs: -1 }), undefined);
    assert.equal(getMaxAgeMs({ maxAgeMs: 'abc' }), undefined);
    assert.equal(getMaxAgeMs({ maxAgeMs: NaN }), undefined);
    assert.equal(getMaxAgeMs({ maxAgeMs: Infinity }), undefined);
  });
});

describe('getLookbackHours', () => {
  it('returns explicit hours when valid', () => {
    assert.equal(getLookbackHours({ lookbackHours: 12 }), 12);
    assert.equal(getLookbackHours({ lookbackHours: '4' }), 4);
  });

  it('falls back to default when invalid or missing', () => {
    assert.equal(getLookbackHours({}), DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS);
    assert.equal(getLookbackHours({ lookbackHours: 0 }), DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS);
    assert.equal(getLookbackHours({ lookbackHours: -1 }), DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS);
    assert.equal(getLookbackHours({ lookbackHours: 'abc' }), DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS);
  });
});

describe('getRecentWindowHours', () => {
  it('returns explicit recentWindowHours when valid', () => {
    assert.equal(getRecentWindowHours({ recentWindowHours: 3, lookbackHours: 6 }), 3);
    assert.equal(getRecentWindowHours({ recentWindowHours: '1', lookbackHours: 6 }), 1);
  });

  it('falls back to lookbackHours when recentWindowHours is missing or invalid', () => {
    assert.equal(getRecentWindowHours({ lookbackHours: 4 }), 4);
    assert.equal(getRecentWindowHours({ recentWindowHours: 0, lookbackHours: 5 }), 5);
    assert.equal(getRecentWindowHours({ recentWindowHours: 'abc', lookbackHours: 2 }), 2);
  });
});

describe('getDebugFlag', () => {
  it('returns defaultValue for undefined/null', () => {
    assert.equal(getDebugFlag(undefined, true), true);
    assert.equal(getDebugFlag(undefined, false), false);
    assert.equal(getDebugFlag(null, true), true);
  });

  it('returns booleans as-is', () => {
    assert.equal(getDebugFlag(true), true);
    assert.equal(getDebugFlag(false), false);
  });

  it('treats non-zero numbers as true, zero as false', () => {
    assert.equal(getDebugFlag(1), true);
    assert.equal(getDebugFlag(42), true);
    assert.equal(getDebugFlag(0), false);
  });

  it('handles string true/false/on/off/yes/no', () => {
    assert.equal(getDebugFlag('true'), true);
    assert.equal(getDebugFlag('false'), false);
    assert.equal(getDebugFlag('on'), true);
    assert.equal(getDebugFlag('off'), false);
    assert.equal(getDebugFlag('yes'), true);
    assert.equal(getDebugFlag('no'), false);
  });

  it('handles case-insensitive and whitespace-padded strings', () => {
    assert.equal(getDebugFlag('  TRUE  '), true);
    assert.equal(getDebugFlag('Off'), false);
    assert.equal(getDebugFlag('  YES '), true);
  });

  it('returns defaultValue for unrecognized strings', () => {
    assert.equal(getDebugFlag('maybe', false), false);
    assert.equal(getDebugFlag('maybe', true), true);
  });

  it('returns defaultValue for empty string', () => {
    assert.equal(getDebugFlag('', true), true);
    assert.equal(getDebugFlag('   ', false), false);
  });

  it('defaults defaultValue to true', () => {
    assert.equal(getDebugFlag(undefined), true);
  });
});

describe('DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS', () => {
  it('is 6', () => {
    assert.equal(DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS, 6);
  });
});

describe('buildRankedScreenResponse', () => {
  it('builds a ranked response with correct shape', async () => {
    const stubClient = { getOddsHistory: async () => [] };
    const payload = {
      rows: [
        {
          playerId: 'p1',
          playerName: 'Player One',
          statType: 'points',
          line: 20.5,
          overOdds: -110,
          underOdds: -110,
          book: 'DK',
          timestamp: Date.now() - 60000
        }
      ]
    };
    const rankRows = (rows) => rows;

    const result = await buildRankedScreenResponse({
      client: stubClient,
      payloads: [payload],
      args: { debug: false, lookbackHours: 2 },
      rankRows
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.result));
    assert.ok(result.freshness);
    assert.ok(result.resultMeta);
    assert.equal(result.resultMeta.lookbackHoursUsed, 2);
    assert.equal(result.resultMeta.debugEnabled, false);
  });

  it('passes recentWindowHours through to rankRows when explicitly requested', async () => {
    const payload = {
      rows: [
        {
          book: 'DK',
          timestamp: Date.now() - 60000
        }
      ]
    };
    const rankRows = (rows, options = {}) => [
      { rowCount: rows.length, recentWindowHours: options.recentWindowHours ?? null }
    ];

    const result = await buildRankedScreenResponse({
      client: null,
      payloads: [payload],
      args: { debug: true, lookbackHours: 6, recentWindowHours: 3 },
      rankRows
    });

    assert.equal(result.result[0].rowCount, 1);
    assert.equal(result.result[0].recentWindowHours, 3);
  });

  it('defaults recentWindowHours to lookbackHours when not explicitly provided', async () => {
    const payload = {
      rows: [
        {
          book: 'DK',
          timestamp: Date.now() - 60000
        }
      ]
    };
    const rankRows = (rows, options = {}) => [
      { rowCount: rows.length, recentWindowHours: options.recentWindowHours ?? null }
    ];

    const result = await buildRankedScreenResponse({
      client: null,
      payloads: [payload],
      args: { debug: false, lookbackHours: 1 },
      rankRows
    });

    assert.equal(result.result[0].rowCount, 1);
    assert.equal(result.result[0].recentWindowHours, 1);
  });

  it('surfaces coverageGaps from the ranker in resultMeta (P0: focus-book coverage gap)', async () => {
    // When the ranker reports that the focus book has no price for a match,
    // buildRankedScreenResponse must propagate that into resultMeta.coverageGaps
    // so callers can see "you asked for NoVigApp but the screen endpoint
    // didn't return it for 3 of 12 matches" without losing the surviving rows.
    const payload = {
      rows: [
        {
          book: 'Pinnacle',
          homeTeam: 'Lakers',
          awayTeam: 'Warriors',
          market: 'Moneyline',
          timestamp: Date.now() - 60000
        }
      ]
    };
    const fakeGap = {
      preferredBook: 'NoVigApp',
      availableBooks: ['Pinnacle', 'FanDuel'],
      matchup: 'Warriors vs Lakers',
      market: 'moneyline',
      reason: 'no_price_fallback',
      focusBookMissingReason: 'no price for NoVigApp'
    };
    const rankRows = (rows) => {
      const result = rows.map((r) => ({ ...r, book: 'Pinnacle', focusBookMissing: true }));
      Object.defineProperty(result, 'coverageGaps', { value: [fakeGap], enumerable: false });
      return result;
    };
    const result = await buildRankedScreenResponse({
      client: null,
      payloads: [payload],
      args: { debug: false, lookbackHours: 6 },
      rankRows,
      focusBook: 'NoVigApp'
    });
    assert.ok(Array.isArray(result.resultMeta.coverageGaps));
    assert.equal(result.resultMeta.coverageGaps.length, 1);
    assert.equal(result.resultMeta.coverageGaps[0].preferredBook, 'NoVigApp');
    assert.equal(result.resultMeta.coverageGaps[0].reason, 'no_price_fallback');
    // Focus-book coverage gap should also show up in degradedDataWarningCount or
    // similar surfaced count — at minimum, the gap info is reachable via resultMeta.
    assert.equal(result.resultMeta.focusBook, 'NoVigApp');
  });
});

describe('buildRankedScreenResponse — bounded pre-history shortlist', () => {
  function makeScreenRow(gameId, edge = 0.5, market = 'Moneyline', league = 'NBA') {
    return {
      gameId,
      league,
      market,
      selection1: `Home ${gameId}`,
      participant1: `Home ${gameId}`,
      selection1Id: `${market}:Home_${gameId}`,
      selection2: `Away ${gameId}`,
      participant2: `Away ${gameId}`,
      selection2Id: `${market}:Away_${gameId}`,
      odds: {
        NoVigApp: { odds1: edge > 1 ? 105 : -100, odds2: 100 },
        Pinnacle: { odds1: -120, odds2: -120 }
      },
      timestamp: Date.now()
    };
  }

  it('hydrates only a bounded current-market shortlist and keeps a late strong candidate', async () => {
    const historyCalls = [];
    const strongGame = 'game-late-strong';
    const payload = {
      rows: [
        ...Array.from({ length: 20 }, (_, index) => makeScreenRow(`game-weak-${index}`)),
        makeScreenRow(strongGame, 2.5)
      ]
    };
    const client = {
      queryOddsHistory: async (params) => {
        historyCalls.push(params);
        if (params.gameId !== strongGame) return [];
        return [
          { odds: -110, line: null, start_ts: 1 },
          { odds: -130, line: null, start_ts: 2 }
        ];
      }
    };
    const rankRows = (rows) =>
      rows.map((row) => ({
        ...row,
        ...(row.gameId === strongGame
          ? {
              movementGrade: 'green',
              movementLabel: 'supportive',
              recentSharpMoveDirection: 'supportive',
              fullWindowSharpMoveDirection: 'supportive',
              clvProxyPct: 1
            }
          : {})
      }));

    const result = await buildRankedScreenResponse({
      client,
      payloads: [payload],
      args: { limit: 1, preHistoryShortlist: true, historySportsbooks: ['Pinnacle'] },
      focusBook: 'NoVigApp',
      rankRows
    });

    assert.ok(historyCalls.length > 0);
    assert.ok(historyCalls.length <= 4, `expected bounded history calls, got ${historyCalls.length}`);
    assert.ok(historyCalls.some((call) => call.gameId === strongGame));
    const strongRows = result.result.filter((row) => row.gameId === strongGame);
    assert.ok(strongRows.length > 0, 'late strong candidate should reach ranking');
    assert.equal(strongRows[0].movementDisposition, 'supportive_clean');
    assert.ok(result.resultMeta.preHistoryShortlist, 'shortlist metadata should be surfaced');
    assert.equal(result.resultMeta.preHistoryShortlist.enabled, true);
  });

  it('does not treat absent history as supportive and preserves adverse movement as pass data', async () => {
    const payload = { rows: [makeScreenRow('game-no-history'), makeScreenRow('game-adverse')] };
    const result = await buildRankedScreenResponse({
      client: {
        queryOddsHistory: async (params) =>
          params.gameId === 'game-adverse'
            ? [
                { odds: -110, start_ts: 1 },
                { odds: 100, start_ts: 2 }
              ]
            : []
      },
      payloads: [payload],
      args: { limit: 4, preHistoryShortlist: true },
      focusBook: 'NoVigApp',
      rankRows: (rows) =>
        rows.map((row) => ({
          ...row,
          ...(row.gameId === 'game-adverse' ? { movementGrade: 'red', movementLabel: 'adverse' } : {})
        }))
    });

    const noHistory = result.result.find((row) => row.gameId === 'game-no-history');
    const adverse = result.result.find((row) => row.gameId === 'game-adverse');
    assert.equal(noHistory.movementDisposition, 'insufficient');
    assert.equal(adverse.movementDisposition, 'adverse_full');
  });

  it('keeps full exact-selection hydration when the shortlist is not requested (targeted path)', async () => {
    const historyCalls = [];
    const payload = {
      rows: [
        ...Array.from({ length: 10 }, (_, index) => makeScreenRow(`game-tgt-${index}`)),
        makeScreenRow('game-tgt-exact', 2.5)
      ]
    };
    const result = await buildRankedScreenResponse({
      client: {
        queryOddsHistory: async (params) => {
          historyCalls.push(params);
          return [];
        }
      },
      payloads: [payload],
      args: { limit: 1 },
      focusBook: 'NoVigApp',
      rankRows: (rows) => rows
    });

    // Default (targeted/game lookup) path must hydrate the ENTIRE raw
    // universe — one history call per extracted side row.
    assert.equal(historyCalls.length, payload.rows.length * 2);
    assert.equal(result.result.length, payload.rows.length * 2);
    assert.equal(result.resultMeta.preHistoryShortlist, undefined);
  });

  it('honors an explicit preHistoryShortlist:false opt-out (full hydration)', async () => {
    const historyCalls = [];
    const payload = {
      rows: Array.from({ length: 8 }, (_, index) => makeScreenRow(`game-opt-${index}`))
    };
    const result = await buildRankedScreenResponse({
      client: {
        queryOddsHistory: async (params) => {
          historyCalls.push(params);
          return [];
        }
      },
      payloads: [payload],
      args: { limit: 1, preHistoryShortlist: false },
      focusBook: 'NoVigApp',
      rankRows: (rows) => rows
    });

    assert.equal(historyCalls.length, payload.rows.length * 2);
    assert.equal(result.result.length, payload.rows.length * 2);
  });

  it('does not starve a whole league/market when the shortlist is small', async () => {
    const historyCalls = [];
    const payload = {
      rows: [
        ...Array.from({ length: 20 }, (_, index) => makeScreenRow(`ml-${index}`, 0.5, 'Moneyline', 'NBA')),
        ...Array.from({ length: 20 }, (_, index) => makeScreenRow(`tot-${index}`, 0.5, 'Total', 'NBA'))
      ]
    };
    const result = await buildRankedScreenResponse({
      client: {
        queryOddsHistory: async (params) => {
          historyCalls.push(params);
          return [];
        }
      },
      payloads: [payload],
      args: { limit: 1, preHistoryShortlist: true },
      focusBook: 'NoVigApp',
      rankRows: (rows) => rows
    });

    const moneylineGames = new Set(
      historyCalls.filter((call) => String(call.gameId).startsWith('ml-')).map((call) => call.gameId)
    );
    const totalGames = new Set(
      historyCalls.filter((call) => String(call.gameId).startsWith('tot-')).map((call) => call.gameId)
    );
    assert.ok(moneylineGames.size > 0, 'Moneyline market should be represented in the shortlist');
    assert.ok(totalGames.size > 0, 'Total market should be represented in the shortlist');
    assert.ok(result.resultMeta.preHistoryShortlist, 'shortlist metadata should be surfaced');
  });
});

describe('buildDegradedDataWarnings — line field backfill (v2.1.3)', () => {
  it('emits a warning when non-moneyline rows had line values backfilled from upstream', () => {
    // Real shape after the ranker: rows do NOT have `line1` or `line` set
    // directly. The ranker spreads `...item.row` but `normalizeRow` only
    // lifts `selections.null` — for Puck Line rows (defaultKey "-1" or
    // "-3.5" etc.) the line value lives at `selections[defaultKey].line1`
    // and never gets lifted. The ranker sets `line` from extractScreenRows
    // (which does `row.line1 ?? null`) but in practice for the live NHL
    // Puck Line data the line is on `r.line` (set to the per-row current
    // line), not `r.line1`. The warning check must therefore rely on
    // `lineFieldMissingCount > 0` as the primary signal, with the market
    // name as defense-in-depth.
    const ranked = [
      {
        market: 'Puck Line',
        // No line1 / line2 / selection1 / selection2 — these don't survive
        // the ranker for Puck Line rows in the live data shape.
        lineHistory: [
          { line: -1, odds: 155, time: 1 },
          { line: -1, odds: 150, time: 2 },
          { line: -1, odds: 158, time: 3 }
        ],
        lineFieldMissingCount: 3,
        consensusBookCount: 0
      },
      {
        market: 'Puck Line',
        lineHistory: [
          { line: 1.5, odds: -180, time: 1 },
          { line: 1.5, odds: -185, time: 2 }
        ],
        lineFieldMissingCount: 2,
        consensusBookCount: 0
      }
    ];
    const warnings = buildDegradedDataWarnings(ranked, ranked, {});
    const lineWarning = warnings.find((w) => w.includes('Line values missing from upstream'));
    assert.ok(lineWarning, 'expected a line-field backfill warning to be present');
    assert.match(lineWarning, /2\/2 non-moneyline rows/);
    assert.match(lineWarning, /5 entries backfilled/);
    assert.match(lineWarning, /Line-movement detection is degraded/);
  });

  it('does not warn for moneyline rows (count is naturally 0 since backfill guards on fallbackLine)', () => {
    const ranked = [
      {
        market: 'Moneyline',
        lineHistory: [
          { line: null, odds: -113, time: 1 },
          { line: null, odds: -114, time: 2 }
        ],
        lineFieldMissingCount: 0,
        consensusBookCount: 0
      }
    ];
    const warnings = buildDegradedDataWarnings(ranked, ranked, {});
    const lineWarning = warnings.find((w) => w.includes('Line values missing from upstream'));
    assert.equal(lineWarning, undefined, 'should not warn for moneyline rows');
  });

  it('does not warn when lineFieldMissingCount is 0 (upstream provided line values)', () => {
    const ranked = [
      {
        market: 'Puck Line',
        lineHistory: [
          { line: -1, odds: 155, time: 1 },
          { line: -1.5, odds: 165, time: 2 }
        ],
        lineFieldMissingCount: 0,
        consensusBookCount: 0
      }
    ];
    const warnings = buildDegradedDataWarnings(ranked, ranked, {});
    const lineWarning = warnings.find((w) => w.includes('Line values missing from upstream'));
    assert.equal(lineWarning, undefined, 'should not warn when no fields were backfilled');
  });

  it('does not warn even when line1 is undefined but the row is Puck Line with backfill count > 0', () => {
    // Regression: 2026-06-14 live test caught that the v2.1.3 warning check
    // was filtering out Puck Line rows because `r.line1 == null` evaluated
    // true (line1 is never set for non-"null" default keys). The fix
    // removes the line1/line checks and relies on lineFieldMissingCount +
    // market name. This test confirms the warning fires for the real
    // ranked-row shape (no line1, no line).
    const ranked = [
      {
        market: 'Puck Line',
        // line1 deliberately not set — this is the actual shape from the ranker
        lineHistory: [
          { line: -3.5, odds: 800, time: 1 },
          { line: -3.5, odds: -809, time: 2 }
        ],
        lineFieldMissingCount: 906,
        consensusBookCount: 6
      }
    ];
    const warnings = buildDegradedDataWarnings(ranked, ranked, {});
    const lineWarning = warnings.find((w) => w.includes('Line values missing from upstream'));
    assert.ok(
      lineWarning,
      'Puck Line rows with backfill count > 0 should trigger the warning even when line1 is missing from the row'
    );
  });
});
