'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { CircuitBreakerOpenError } = require('../lib/propprofessor-circuit-breaker');

const {
  hydrateScreenRowsWithHistory,
  extractLineFromPick,
  generateLineVariants,
  rebuildPickWithLine
} = require('../lib/propprofessor-screen-history');

function makeClient(queryFn) {
  return { queryOddsHistory: queryFn || (async () => []) };
}

function makeRow(overrides = {}) {
  return {
    gameId: 'game-1',
    selectionId: 'sel-1',
    book: 'DraftKings',
    pick: 'Lakers',
    game: 'Lakers vs Celtics',
    odds: '-110',
    ...overrides
  };
}

describe('hydrateScreenRowsWithHistory', () => {
  it('returns source rows as-is when client is null', async () => {
    const rows = [makeRow()];
    const result = await hydrateScreenRowsWithHistory(rows, { client: null });
    assert.deepEqual(result, rows);
  });

  it('returns source rows as-is when client is missing queryOddsHistory', async () => {
    const rows = [makeRow()];
    const result = await hydrateScreenRowsWithHistory(rows, { client: {} });
    assert.deepEqual(result, rows);
  });

  it('returns empty array when rows is empty', async () => {
    const client = makeClient();
    const result = await hydrateScreenRowsWithHistory([], { client });
    assert.deepEqual(result, []);
  });

  it('returns empty array when rows is not an array', async () => {
    const client = makeClient();
    const result = await hydrateScreenRowsWithHistory(null, { client });
    assert.deepEqual(result, []);
  });

  it('filters out null and non-object rows', async () => {
    const client = makeClient(async () => []);
    const validRow = makeRow();
    const result = await hydrateScreenRowsWithHistory([null, validRow, 'string', 42, undefined], { client });
    assert.equal(result.length, 1);
  });

  it('returns rows that already have lineHistory with 2+ entries unchanged with lineHistoryAvailable=true', async () => {
    const client = makeClient(async () => {
      throw new Error('should not call');
    });
    const row = makeRow({
      lineHistory: [
        { odds: -110, ts: 1 },
        { odds: -120, ts: 2 }
      ],
      lineHistorySource: 'test_source',
      lineHistoryLookbackHours: 12,
      normalizedSelectionId: 'norm-1',
      historyGameId: 'hist-game-1',
      historyMatchedBy: 'exact',
      historyMatchKey: 'key-1'
    });
    const [result] = await hydrateScreenRowsWithHistory([row], { client });
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.lineHistorySource, 'test_source');
    assert.equal(result.lineHistoryLookbackHours, 12);
    assert.equal(result.normalizedSelectionId, 'norm-1');
    assert.equal(result.historyGameId, 'hist-game-1');
    assert.equal(result.historyMatchedBy, 'exact');
    assert.equal(result.historyMatchKey, 'key-1');
    assert.equal(result.lineHistory.length, 2);
  });

  it('defaults lineHistorySource to screen_payload when row already has history', async () => {
    const client = makeClient(async () => {
      throw new Error('should not call');
    });
    const row = makeRow({
      lineHistory: [{ odds: -110 }, { odds: -120 }]
    });
    const [result] = await hydrateScreenRowsWithHistory([row], { client });
    assert.equal(result.lineHistorySource, 'screen_payload');
  });

  it('defaults lineHistoryLookbackHours from options when row does not specify', async () => {
    const client = makeClient(async () => {
      throw new Error('should not call');
    });
    const row = makeRow({
      lineHistory: [{ odds: -110 }, { odds: -120 }]
    });
    const [result] = await hydrateScreenRowsWithHistory([row], { client, lookbackHours: 48 });
    assert.equal(result.lineHistoryLookbackHours, 48);
  });

  it('hydrates rows by calling resolveHistoryForEntity through client.queryOddsHistory', async () => {
    const calls = [];
    const client = makeClient(async (params) => {
      calls.push(params);
      return [
        { odds: -110, start_ts: 1 },
        { odds: -120, start_ts: 2 }
      ];
    });
    const row = makeRow({ gameId: 'game-abc', selectionId: 'sel-abc' });
    const [result] = await hydrateScreenRowsWithHistory([row], { client, lookbackHours: 24 });

    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.lineHistorySource, 'odds_history');
    assert.equal(result.lineHistoryLookbackHours, 24);
    assert.ok(Array.isArray(result.lineHistory));
  });

  it('resolves from cache — identical cache keys only make one query', async () => {
    let queryCount = 0;
    const client = makeClient(async () => {
      queryCount++;
      return [
        { odds: -110, start_ts: 1 },
        { odds: -120, start_ts: 2 }
      ];
    });

    const rows = [
      makeRow({ gameId: 'game-same', selectionId: 'sel-same', book: 'DK' }),
      makeRow({ gameId: 'game-same', selectionId: 'sel-same', book: 'DK' }),
      makeRow({ gameId: 'game-same', selectionId: 'sel-same', book: 'DK' })
    ];

    const results = await hydrateScreenRowsWithHistory(rows, { client });
    assert.equal(queryCount, 1);
    assert.equal(results.length, 3);
    for (const r of results) {
      assert.equal(r.lineHistoryAvailable, true);
    }
  });

  it('makes separate queries for different cache keys', async () => {
    const queriedKeys = [];
    const client = makeClient(async () => {
      queriedKeys.push(true);
      return [
        { odds: -110, start_ts: 1 },
        { odds: -120, start_ts: 2 }
      ];
    });

    const rows = [
      makeRow({ gameId: 'game-a', selectionId: 'sel-a' }),
      makeRow({ gameId: 'game-b', selectionId: 'sel-b' })
    ];

    const results = await hydrateScreenRowsWithHistory(rows, { client });
    assert.equal(queriedKeys.length, 2);
    assert.equal(results.length, 2);
  });

  it('handles history resolution errors gracefully returning lineHistoryAvailable=false', async () => {
    const originalWrite = process.stderr.write.bind(process.stderr);
    const stderrChunks = [];
    process.stderr.write = (chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    };

    const client = makeClient(async () => {
      throw new Error('API timeout');
    });

    const row = makeRow({ gameId: 'game-err', selectionId: 'sel-err' });
    const [result] = await hydrateScreenRowsWithHistory([row], { client });

    process.stderr.write = originalWrite;

    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.lineHistorySource, null);
    assert.ok(Array.isArray(result.lineHistory));
    assert.equal(result.lineHistory.length, 0);

    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('API timeout'));
  });

  it('sets lineHistoryAvailable=false when resolveHistoryForEntity returns no history', async () => {
    const client = makeClient(async () => []);
    const row = makeRow({ gameId: 'game-nohist', selectionId: 'sel-nohist' });
    const [result] = await hydrateScreenRowsWithHistory([row], { client });

    assert.equal(result.lineHistoryAvailable, false);
    assert.ok(Array.isArray(result.lineHistory));
    assert.equal(result.lineHistory.length, 0);
  });

  it('limits concurrency — with concurrency=2 it does not exceed 2 in-flight', async () => {
    let maxInFlight = 0;
    let currentInFlight = 0;

    const client = makeClient(async () => {
      currentInFlight++;
      if (currentInFlight > maxInFlight) maxInFlight = currentInFlight;
      await new Promise((resolve) => setTimeout(resolve, 50));
      currentInFlight--;
      return [
        { odds: -110, start_ts: 1 },
        { odds: -120, start_ts: 2 }
      ];
    });

    const rows = Array.from({ length: 10 }, (_, i) =>
      makeRow({ gameId: `game-conc-${i}`, selectionId: `sel-conc-${i}` })
    );

    const results = await hydrateScreenRowsWithHistory(rows, { client, concurrency: 2 });

    assert.equal(results.length, 10);
    assert.ok(maxInFlight <= 2, `Expected max 2 in-flight but got ${maxInFlight}`);
  });

  it('bounds the default concurrency below the previous default of 6 when no option is given', async () => {
    let maxInFlight = 0;
    let currentInFlight = 0;

    const client = makeClient(async () => {
      currentInFlight++;
      if (currentInFlight > maxInFlight) maxInFlight = currentInFlight;
      await new Promise((resolve) => setTimeout(resolve, 50));
      currentInFlight--;
      return [
        { odds: -110, start_ts: 1 },
        { odds: -120, start_ts: 2 }
      ];
    });

    const rows = Array.from({ length: 10 }, (_, i) =>
      makeRow({ gameId: `game-defconc-${i}`, selectionId: `sel-defconc-${i}` })
    );

    // Callers (scan/screen_ranked) omit concurrency — the default itself must
    // stay bounded so a full screen does not pile 6+ history calls onto a
    // throttled upstream.
    const results = await hydrateScreenRowsWithHistory(rows, { client });

    assert.equal(results.length, 10);
    assert.ok(maxInFlight < 6, `default concurrency must stay below 6, saw ${maxInFlight} in-flight`);
    assert.ok(maxInFlight >= 1, 'default concurrency must stay above 0');
  });

  it('respects concurrency=1 for serial execution', async () => {
    const order = [];
    const client = makeClient(async ({ gameId }) => {
      order.push(gameId);
      return [
        { odds: -110, start_ts: 1 },
        { odds: -120, start_ts: 2 }
      ];
    });

    const rows = [
      makeRow({ gameId: 'game-ser-1', selectionId: 'sel-ser-1' }),
      makeRow({ gameId: 'game-ser-2', selectionId: 'sel-ser-2' }),
      makeRow({ gameId: 'game-ser-3', selectionId: 'sel-ser-3' })
    ];

    await hydrateScreenRowsWithHistory(rows, { client, concurrency: 1 });
    assert.deepEqual(order, ['game-ser-1', 'game-ser-2', 'game-ser-3']);
  });

  it('preserves original row properties in hydrated results', async () => {
    const client = makeClient(async () => [
      { odds: -110, start_ts: 1 },
      { odds: -120, start_ts: 2 }
    ]);
    const row = makeRow({ gameId: 'game-prop', selectionId: 'sel-prop', customField: 'hello' });
    const [result] = await hydrateScreenRowsWithHistory([row], { client });

    assert.equal(result.customField, 'hello');
    assert.equal(result.gameId, 'game-prop');
    assert.equal(result.selectionId, 'sel-prop');
    assert.equal(result.lineHistoryAvailable, true);
  });
});

describe('extractLineFromPick', () => {
  it('parses total-style picks (Over/Under + number)', () => {
    assert.deepEqual(extractLineFromPick('Over 9.5'), {
      side: 'over',
      line: 9.5,
      format: 'total'
    });
    assert.deepEqual(extractLineFromPick('Under 8'), {
      side: 'under',
      line: 8,
      format: 'total'
    });
  });

  it('parses spread-style picks (team + signed number)', () => {
    assert.deepEqual(extractLineFromPick('Lakers -3.5'), {
      side: 'Lakers',
      line: -3.5,
      format: 'spread'
    });
    assert.deepEqual(extractLineFromPick('Athletics +1.5'), {
      side: 'Athletics',
      line: 1.5,
      format: 'spread'
    });
  });

  it('returns null for moneyline picks with large signed numbers', () => {
    assert.equal(extractLineFromPick('Lakers +200'), null);
    assert.equal(extractLineFromPick('Celtics -150'), null);
  });

  it('returns null for empty / null / non-string input', () => {
    assert.equal(extractLineFromPick(null), null);
    assert.equal(extractLineFromPick(''), null);
    assert.equal(extractLineFromPick(undefined), null);
    assert.equal(extractLineFromPick(42), null);
  });
});

describe('generateLineVariants', () => {
  it('returns ±0.5 for a finite line value', () => {
    assert.deepEqual(generateLineVariants(9.5), [9, 10]);
    assert.deepEqual(generateLineVariants(-3.5), [-4, -3]);
  });

  it('returns empty array for non-finite values', () => {
    assert.deepEqual(generateLineVariants(NaN), []);
    assert.deepEqual(generateLineVariants(Infinity), []);
    assert.deepEqual(generateLineVariants(undefined), []);
  });
});

describe('rebuildPickWithLine', () => {
  it('rebuilds totals with the new line value', () => {
    const parsed = extractLineFromPick('Over 9.5');
    assert.equal(rebuildPickWithLine(parsed, 9), 'Over 9');
    assert.equal(rebuildPickWithLine(parsed, 10), 'Over 10');
  });

  it('rebuilds spreads with the new signed line value', () => {
    const parsed = extractLineFromPick('Lakers -3.5');
    assert.equal(rebuildPickWithLine(parsed, -3), 'Lakers -3');
    assert.equal(rebuildPickWithLine(parsed, -4), 'Lakers -4');
    assert.equal(rebuildPickWithLine(parsed, 3.5), 'Lakers +3.5');
  });

  it('returns null for unsupported parsed shapes', () => {
    assert.equal(rebuildPickWithLine(null, 9), null);
    assert.equal(rebuildPickWithLine({ side: 'x', line: 1, format: 'other' }, 9), null);
  });
});

describe('hydrateScreenRowsWithHistory — line-key fallback', () => {
  it('uses adjacent-line history when exact line has no history', async () => {
    // Orioles/Padres over/under rows: target "Over 9.5" has no history,
    // but the adjacent "Over 9" row has full history. The wrapper should
    // bridge through the variant row and return its history.
    const callLog = [];
    const client = makeClient(async (params) => {
      callLog.push(params);
      // First call: exact target with selectionId 'sel-95' returns empty.
      // Second call: variant target with selectionId 'sel-90' returns history.
      if (params.selectionId === 'sel-90') {
        return [
          { odds: -101, start_ts: 1 },
          { odds: -110, start_ts: 2 },
          { odds: -120, start_ts: 3 }
        ];
      }
      return [];
    });

    // The screen rows include both the target "Over 9.5" and the adjacent
    // "Over 9" row. The matcher finds both by pick, and the variant
    // re-resolution uses the "Over 9" row's selectionId.
    const sourceRows = [
      makeRow({ gameId: 'g1', selectionId: 'sel-95', pick: 'Over 9.5', book: 'Pinnacle' }),
      makeRow({ gameId: 'g1', selectionId: 'sel-90', pick: 'Over 9', book: 'BetOnline' })
    ];
    const [result] = await hydrateScreenRowsWithHistory(sourceRows, { client });
    // The first row ("Over 9.5") should have inherited the variant history.
    assert.equal(result.pick, 'Over 9.5');
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.lineHistorySource, 'odds_history');
    assert.equal(result.lineVariantUsed, 'Over 9');
    assert.equal(result.historyMatchedBy, 'line_variant');
    assert.equal(result.lineHistory.length, 3);
    // Sanity: both the exact and variant calls were attempted.
    assert.ok(callLog.length >= 2);
  });

  it('skips variant fallback when exact line already has history', async () => {
    let callCount = 0;
    const client = makeClient(async () => {
      callCount += 1;
      return [
        { odds: -110, start_ts: 1 },
        { odds: -120, start_ts: 2 }
      ];
    });
    const row = makeRow({ gameId: 'g1', selectionId: 'sel-1', pick: 'Over 9.5', book: 'Pinnacle' });
    const [result] = await hydrateScreenRowsWithHistory([row], { client });
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.lineVariantUsed, undefined);
    assert.equal(callCount, 1, 'no variant attempt when exact line resolves');
  });

  it('skips variant fallback for moneyline picks (no line value)', async () => {
    let callCount = 0;
    const client = makeClient(async () => {
      callCount += 1;
      return []; // No history for the moneyline pick.
    });
    const row = makeRow({ gameId: 'g1', selectionId: 'sel-1', pick: 'Lakers', book: 'Pinnacle' });
    const [result] = await hydrateScreenRowsWithHistory([row], { client });
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(callCount, 1, 'no variant attempt for moneyline pick');
  });

  it('returns no history when both exact and variant lines are missing', async () => {
    let callCount = 0;
    const client = makeClient(async () => {
      callCount += 1;
      return []; // No history available for any line.
    });
    const sourceRows = [
      makeRow({ gameId: 'g1', selectionId: 'sel-95', pick: 'Over 9.5', book: 'Pinnacle' }),
      makeRow({ gameId: 'g1', selectionId: 'sel-90', pick: 'Over 9', book: 'BetOnline' })
    ];
    const [result] = await hydrateScreenRowsWithHistory(sourceRows, { client });
    assert.equal(result.lineHistoryAvailable, false);
    assert.ok(callCount >= 2, 'tried both exact and variant lines');
  });
});

describe('hydrateScreenRowsWithHistory — throttle/circuit fail-soft', () => {
  function captureStderr() {
    const originalWrite = process.stderr.write.bind(process.stderr);
    const chunks = [];
    process.stderr.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    return {
      restore() {
        process.stderr.write = originalWrite;
      },
      output() {
        return chunks.join('');
      }
    };
  }

  function lineShapeRows() {
    return [
      makeRow({ gameId: 'g1', selectionId: 'sel-95', pick: 'Over 9.5', book: 'Pinnacle' }),
      makeRow({ gameId: 'g1', selectionId: 'sel-90', pick: 'Over 9', book: 'BetOnline' })
    ];
  }

  it('stops line-variant fallback after a 429 throttle error on the exact query', async () => {
    const stderr = captureStderr();
    let callCount = 0;
    const client = makeClient(async () => {
      callCount += 1;
      const error = new Error('PropProfessor backend failed (429): rate limited');
      error.status = 429;
      error.code = 'PROPPROFESSOR_BACKEND_ERROR';
      error.category = 'backend';
      error.retryable = true;
      throw error;
    });

    const results = await hydrateScreenRowsWithHistory(lineShapeRows(), { client });
    stderr.restore();

    // One exact query per row (2 rows) and no adjacent line variants on top:
    // without the fail-soft guard each line-shaped row also re-queries its
    // ±0.5 variants, turning this into 4 upstream calls during an outage.
    assert.equal(callCount, 2, 'no adjacent line variants queried after a 429');
    assert.ok(results.every((row) => row.lineHistoryAvailable === false));
    const [result] = results;
    assert.equal(result.historyErrorStatus, 429);
    assert.equal(result.historyErrorCode, 'PROPPROFESSOR_BACKEND_ERROR');
    assert.ok(result.historyError.includes('429'));
    assert.ok(stderr.output().includes('429'));
  });

  it('stops line-variant fallback after a circuit-breaker-open error on the exact query', async () => {
    const stderr = captureStderr();
    let callCount = 0;
    const client = makeClient(async () => {
      callCount += 1;
      throw new CircuitBreakerOpenError("Circuit breaker '/odds_history_new' is open", '/odds_history_new');
    });

    const results = await hydrateScreenRowsWithHistory(lineShapeRows(), { client });
    stderr.restore();

    // Same invariant: one exact query per row, zero variant queries.
    assert.equal(callCount, 2, 'no adjacent line variants queried after circuit-open');
    assert.ok(results.every((row) => row.lineHistoryAvailable === false));
    const [result] = results;
    assert.equal(result.historyErrorCode, 'CIRCUIT_BREAKER_OPEN');
    assert.equal(result.historyErrorStatus, null);
  });
});
