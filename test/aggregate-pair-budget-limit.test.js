'use strict';

/**
 * Regression: the aggregate per-pair hydration budget must track the
 * caller's limit, not just the allocator share.
 *
 * Root cause (live `pp scan mlb wnba ncaaf -b NoVigApp -n 5 -j
 * --card-window all` never emitted JSON, 1000+ "scan scope aborted"):
 * getAggregateGameBudget(9) = floor(1200/9) = 133 games/pair. A -n 5 scan
 * hydrated ~133 sides/pair through a SERIAL gate (concurrency 1, 100ms
 * spacing), so every pair blew its PAIR_TIMEOUT_MS deadline and aborted.
 * The EV-first cap alone only cut the flood from ~1000 to ~250 aborts.
 *
 * Fix: bound the effective per-pair budget by the limit-derived shortlist
 * need (getPreHistoryShortlistGameBudget). A -n 5 scan hydrates ~10
 * games/pair; wide scans keep the allocator share. getAggregateGameBudget
 * itself is untouched (budget meta + existing tests pinned to it).
 *
 * Hermetic: injected query fns capture rankedArgs; no network.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runSharpPlays } = require('../lib/propprofessor-sharp-plays-service');

async function captureRankedArgs(args) {
  const seen = [];
  const stub = async (rankedArgs) => {
    seen.push(rankedArgs);
    return { ok: true, result: [] };
  };
  await runSharpPlays(
    {
      leagues: ['MLB'],
      markets: ['Moneyline'],
      books: ['NoVigApp'],
      quickScreenAggregate: true,
      activeAggregatePairCount: 1,
      includeResearch: false,
      ...args
    },
    { queryLeagueScreen: stub, queryTennisScreen: stub }
  );
  assert.ok(seen.length > 0, 'injected query fn must actually run (else the test is vacuous)');
  return seen;
}

describe('aggregate per-pair hydration budget tracks the caller limit', () => {
  it('small -n scan hydrates ~limit games per pair, not the 133-game allocator share', async () => {
    const seen = await captureRankedArgs({ limit: 5, scanLimit: 5 });
    for (const rankedArgs of seen) {
      assert.ok(
        Number(rankedArgs.preHistoryGameBudget) <= 10,
        `preHistoryGameBudget=${rankedArgs.preHistoryGameBudget} must be <= 10 for -n 5 (was 132 pre-fix)`
      );
      assert.ok(
        Number(rankedArgs.preHistoryRowBudget) <= 10,
        `preHistoryRowBudget=${rankedArgs.preHistoryRowBudget} must be <= 10 for -n 5 (was 133 pre-fix)`
      );
      assert.ok(
        Number(rankedArgs.evFirstHistoryCap) <= 3,
        `evFirstHistoryCap=${rankedArgs.evFirstHistoryCap} must be <= 3 for -n 5`
      );
    }
  });

  it('wide scan keeps a generous per-pair budget', async () => {
    const seen = await captureRankedArgs({ limit: 100, scanLimit: 100 });
    for (const rankedArgs of seen) {
      assert.ok(
        Number(rankedArgs.preHistoryGameBudget) >= 50,
        `preHistoryGameBudget=${rankedArgs.preHistoryGameBudget} must stay generous for limit 100`
      );
      assert.equal(rankedArgs.preHistoryShortlist, true, 'hydrated pass must opt into the pre-history shortlist');
    }
  });

  it('every pair still gets at least one game (floor holds)', async () => {
    const seen = await captureRankedArgs({ limit: 1, scanLimit: 1 });
    for (const rankedArgs of seen) {
      assert.ok(
        Number(rankedArgs.preHistoryGameBudget) >= 1,
        'floor: every pair keeps at least one game even at limit 1'
      );
    }
  });
});
