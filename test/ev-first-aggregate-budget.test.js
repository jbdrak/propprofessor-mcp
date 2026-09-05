'use strict';

/**
 * Regression: in aggregate quick_screen mode (the multi-league `pp scan`
 * fan-out), runEvFirst MUST bound its odds-history fan-out so it cannot
 * starve the serial, process-global odds-history gate that the main ranked
 * query owns.
 *
 * Root cause (live `pp scan mlb wnba ncaaf -b NoVigApp -n 5 -j --card-window
 * all` exceeded 150s, 233× "History resolution failed: scan scope aborted",
 * never emitted JSON):
 *
 *   runLeagueScreen() calls runEvFirst() BEFORE the main ranked query.
 *   runEvFirst() validates EVERY EV-board candidate with one
 *   queryOddsHistory call each (slice = scanLimit, default up to 100), via
 *   validatePositiveEvCandidates → mapWithConcurrency(..., default 6).
 *
 * The real queryOddsHistory gate is PROCESS-GLOBAL and SERIAL
 * (ODDS_HISTORY_MAX_CONCURRENCY = 1, 100ms spacing ⇒ ~1200 calls per
 * PAIR_TIMEOUT_MS = 120s). The aggregate allocator reserves that ENTIRE
 * window for the main ranked query's preHistoryShortlist. EV-first adds up to
 * 900 more on top, blowing past the gate ceiling, so the main path misses its
 * deadline, every pair scope aborts at 120s, and the aborted/queued history
 * calls flood stderr with "History resolution failed: scan scope aborted".
 *
 * Narrow fix (per parent directive): bound runEvFirst's candidate slice in
 * aggregate mode so it fits the gate without starving the main path.
 * Direct/targeted (non-aggregate) scans keep the full EV-first pass. EV-first
 * discovery still runs in aggregate (coverage preserved, just bounded) and
 * still returns null when the EV board is empty (the no-op is untouched).
 *
 * Hermetic + deterministic: queryOddsHistory is a synchronous counter (no
 * setTimeout drift), and every candidate gets a UNIQUE gameId/selectionId so
 * the module-global history memo cache cannot mask the call count. The test
 * measures the true invariant — call COUNT — not wall-clock noise.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runEvFirst, EV_FIRST_AGGREGATE_CAP } = require('../scripts/server/handlers/screen-leagues');

let uid = 0;

function makeHistoryCountingClient(candidateCount, sink) {
  const myId = (uid += 1);
  const rows = [];
  for (let i = 0; i < candidateCount; i += 1) {
    rows.push({
      league: 'MLB',
      market: 'Total Runs',
      book: 'NoVigApp',
      participant: `Under 7.5 #${i}-${myId}`,
      selection: `Under 7.5 #${i}-${myId}`,
      game: `Game ${i}-${myId}`,
      // Unique per invocation so the cross-call memoized history cache (keyed
      // on gameId/selectionId) cannot collapse repeat calls into one.
      gameId: `game-${i}-${myId}`,
      odds: -120,
      value: -0.6
    });
  }
  return {
    querySportsbook: async () => rows,
    queryPositiveEV: async () => [],
    queryOddsHistory: async () => {
      sink.n += 1;
      return [];
    }
  };
}

const PAIRS = 9; // mlb wnba ncaaf × 3 default markets in a mixed scan
const EV_BOARD_SLICE = 100; // runEvFirst slices the EV board to scanLimit

describe('aggregate quick_screen bounds the EV-first history fan-out', () => {
  it('RED: aggregate-mode runEvFirst caps history calls to EV_FIRST_AGGREGATE_CAP per pair', async () => {
    const sink = { n: 0 };
    // Fan out like quick_screen: queryRankedSharpPlayResponses uses
    // concurrency 4 across the league×market pairs.
    for (let p = 0; p < PAIRS; p += 1) {
      await runEvFirst(
        makeHistoryCountingClient(EV_BOARD_SLICE, sink),
        { books: ['NoVigApp'], limit: 5, quickScreenAggregate: true },
        'MLB',
        'Total Runs',
        ['NoVigApp']
      );
    }
    const cap = EV_FIRST_AGGREGATE_CAP * PAIRS;
    assert.ok(
      sink.n <= cap,
      `aggregate runEvFirst fanned out ${sink.n} serial history calls; ` +
        `must be bounded to ${cap} (= ${EV_FIRST_AGGREGATE_CAP}/pair × ${PAIRS}). ` +
        `Unbounded fan-out floods the serial gate and blows PAIR_TIMEOUT.`
    );
    assert.ok(sink.n > 0, 'aggregate EV-first must still run (coverage preserved, just bounded)');
  });

  it('RED: aggregate-mode runEvFirst bounds the slice to the cap even with a huge EV board', async () => {
    const sink = { n: 0 };
    await runEvFirst(
      makeHistoryCountingClient(500, sink),
      { books: ['NoVigApp'], limit: 5, quickScreenAggregate: true },
      'MLB',
      'Total Runs',
      ['NoVigApp']
    );
    assert.equal(
      sink.n,
      EV_FIRST_AGGREGATE_CAP,
      `aggregate runEvFirst must validate exactly ${EV_FIRST_AGGREGATE_CAP} candidates, ` +
        `not the full 500-board slice.`
    );
  });

  it('aggregate-mode runEvFirst still returns validated rows (no silent coverage drop)', async () => {
    const sink = { n: 0 };
    const result = await runEvFirst(
      makeHistoryCountingClient(EV_BOARD_SLICE, sink),
      { books: ['NoVigApp'], limit: 5, quickScreenAggregate: true },
      'MLB',
      'Total Runs',
      ['NoVigApp']
    );
    assert.ok(result, 'aggregate EV-first must still produce a result when candidates exist');
    assert.ok(Array.isArray(result.result) && result.result.length > 0, 'returns validated rows');
  });

  it('non-aggregate single-league runEvFirst still validates the full board (no behavior loss)', async () => {
    const sink = { n: 0 };
    const result = await runEvFirst(
      makeHistoryCountingClient(7, sink),
      { books: ['NoVigApp'], limit: 5 }, // no quickScreenAggregate
      'MLB',
      'Total Runs',
      ['NoVigApp']
    );
    assert.ok(result, 'single-league EV-first must still run');
    assert.equal(sink.n, 7, 'single-league EV-first hydrates the full candidate set');
  });

  it('aggregate runEvFirst still returns null when the EV board is empty (no-op untouched)', async () => {
    const sink = { n: 0 };
    const emptyClient = {
      querySportsbook: async () => [],
      queryPositiveEV: async () => []
    };
    const result = await runEvFirst(
      emptyClient,
      { books: ['NoVigApp'], limit: 5, quickScreenAggregate: true },
      'MLB',
      'Total Runs',
      ['NoVigApp']
    );
    assert.equal(result, null, 'empty EV board must short-circuit to null');
    assert.equal(sink.n, 0, 'no history calls when board empty');
  });
});
