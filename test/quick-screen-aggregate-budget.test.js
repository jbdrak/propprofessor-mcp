'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runSharpPlays } = require('../lib/propprofessor-sharp-plays-service');
const { buildRankedScreenResponse } = require('../lib/propprofessor-mcp-ranked-screen');

/**
 * Aggregate odds-history budget regression.
 *
 * quick_screen fans out one sharp_plays call per (league, market) pair
 * against a process-wide 75-call odds-history budget. Before the aggregate
 * fix each pair's main ranked query claimed up to 48 selection calls (24
 * games × 2 sides) AND ran a duplicate sharp-only cross-reference query, so
 * a handful of pairs exhausted the budget and every later row degraded to
 * movementDisposition=insufficient (the exact live `pp scan -b NoVigApp`
 * failure). In aggregate mode the cross-reference is skipped (the main query
 * already hydrates target + sharp books) and each pair gets a small explicit
 * pre-history game budget derived from the total pair count, keeping total
 * selection-hydration calls below 75 while still hydrating at least one
 * strong candidate per pair.
 */
describe('quick_screen aggregate odds-history budget', () => {
  function makeScreenRow(gameId, edge = 0.5) {
    return {
      gameId,
      league: 'NBA',
      market: 'Moneyline',
      selection1: `Home ${gameId}`,
      participant1: `Home ${gameId}`,
      selection1Id: `Moneyline:Home_${gameId}`,
      selection2: `Away ${gameId}`,
      participant2: `Away ${gameId}`,
      selection2Id: `Moneyline:Away_${gameId}`,
      odds: {
        NoVigApp: { odds1: edge > 1 ? 105 : -100, odds2: 100 },
        Pinnacle: { odds1: -120, odds2: -120 }
      },
      timestamp: Date.now()
    };
  }

  // Ranker stub: rows hydrated with real history are graded supportive so
  // the regression can assert the scan still yields non-insufficient rows.
  function makeSupportiveRanker(rows) {
    return rows.map((row) =>
      row.lineHistoryAvailable
        ? {
            ...row,
            movementGrade: 'green',
            movementLabel: 'supportive',
            recentSharpMoveDirection: 'supportive',
            fullWindowSharpMoveDirection: 'supportive',
            clvProxyPct: 1
          }
        : row
    );
  }

  it('keeps total odds-history calls below 75 across many league×market pairs', async () => {
    const pairCount = 12;
    const leagues = Array.from({ length: pairCount }, (_, index) => `LEAGUE_${index}`);
    const historyCalls = [];
    const client = {
      queryOddsHistory: async (params) => {
        historyCalls.push(params);
        return [
          { odds: -110, line: null, start_ts: 1 },
          { odds: -120, line: null, start_ts: 2 },
          { odds: -130, line: null, start_ts: 3 }
        ];
      }
    };
    const queryCalls = [];
    const queryLeagueScreen = async (rankedArgs, league) => {
      queryCalls.push({ rankedArgs, league });
      // 10 games per pair — enough that the pre-fix per-call 24-game cap
      // would claim 20 selection calls here and the duplicate cross-reference
      // would double it, blowing the 75-call budget after a few pairs.
      const payload = {
        rows: Array.from({ length: 10 }, (_, index) => makeScreenRow(`game-${league}-${index}`, 0.5 + index * 0.1))
      };
      return buildRankedScreenResponse({
        client,
        payloads: [payload],
        // The broad-scan pre-history shortlist is injected by the aggregate
        // sharp-plays service (runSharpPlays), NOT at the handler layer —
        // standalone screen_ranked / direct sharp_plays keep full hydration.
        args: { ...rankedArgs },
        league,
        focusBook: 'NoVigApp',
        rankRows: makeSupportiveRanker
      });
    };

    const result = await runSharpPlays(
      {
        book: 'NoVigApp',
        targetBooks: ['NoVigApp'],
        leagues,
        markets: ['Moneyline'],
        limit: 5,
        scanLimit: 20,
        lookbackHours: 6,
        strict: false,
        includePasses: true,
        quickScreenAggregate: true,
        aggregatePairCount: pairCount
      },
      {
        queryLeagueScreen,
        queryTennisScreen: async () => {
          throw new Error('Tennis path should not be used in this aggregate test');
        }
      }
    );

    // One main ranked query per pair — the duplicate sharp-only
    // cross-reference must be skipped in aggregate mode.
    assert.equal(queryCalls.length, pairCount, 'aggregate mode must not run the duplicate sharp-only cross-reference');
    assert.equal(result.resultMeta.scannedQueryCount, pairCount, 'scannedQueryCount should count main queries only');

    // Every ranked query received the explicit per-pair pre-history budget
    // AND the shortlist opt-in, both injected by the aggregate service.
    for (const { rankedArgs } of queryCalls) {
      assert.equal(
        rankedArgs.preHistoryShortlist,
        true,
        'aggregate mode must inject preHistoryShortlist from the service, not the handler'
      );
      assert.ok(
        Number.isFinite(rankedArgs.preHistoryGameBudget) && rankedArgs.preHistoryGameBudget >= 1,
        'each pair must receive an explicit per-pair pre-history game budget'
      );
      assert.ok(
        Number.isFinite(rankedArgs.preHistoryRowBudget) && rankedArgs.preHistoryRowBudget >= 1,
        'each pair must receive an explicit per-pair pre-history row budget'
      );
    }

    // THE regression: total selection-hydration calls across all pairs stay
    // below the process-wide 75-call odds-history budget.
    assert.ok(
      historyCalls.length < 75,
      `expected total history calls < 75 across ${pairCount} pairs, got ${historyCalls.length}`
    );

    // Every pair still hydrates at least one strongest current-market side —
    // no first-come starvation, so each league appears in the history calls.
    for (const league of leagues) {
      const leagueCalls = historyCalls.filter((call) => String(call.gameId).startsWith(`game-${league}-`));
      assert.ok(
        leagueCalls.length >= 1,
        `pair ${league} should hydrate at least one candidate, got ${leagueCalls.length}`
      );
    }

    // And the scan still yields hydrated (non-insufficient) candidates.
    const supportiveRows = result.result.filter((row) => row.movementDisposition === 'supportive_clean');
    assert.ok(supportiveRows.length >= 1, 'expected at least one hydrated supportive row in the final result');

    // Budget metadata is surfaced for debugging.
    assert.equal(result.resultMeta.historyBudget?.mode, 'aggregate');
    assert.ok(result.resultMeta.historyBudget.maxSelectionCalls < 75);
    assert.equal(result.resultMeta.historyBudget.pairCount, pairCount);
  });

  it('direct sharp_plays (no aggregate opt-in) keeps the two-query contract', async () => {
    const queryCalls = [];
    const result = await runSharpPlays(
      {
        book: 'Fliff',
        targetBooks: ['Fliff'],
        leagues: ['NBA'],
        markets: ['Moneyline'],
        limit: 5,
        scanLimit: 5,
        minConsensusBookCount: 1,
        lookbackHours: 6,
        strict: true,
        includePasses: true
      },
      {
        queryLeagueScreen: async (rankedArgs) => {
          queryCalls.push(rankedArgs);
          return { ok: true, result: [] };
        },
        queryTennisScreen: async () => {
          throw new Error('Tennis path should not be used in this contract test');
        }
      }
    );

    // 1 main query + 1 sharp book group query — unchanged external contract.
    assert.equal(queryCalls.length, 2);
    assert.equal(result.resultMeta.scannedQueryCount, 2);
    assert.equal(
      result.resultMeta.historyBudget,
      undefined,
      'direct sharp_plays must not surface aggregate budget metadata'
    );
    // No aggregate budget is forced onto direct callers.
    assert.equal(queryCalls[0].preHistoryGameBudget, undefined);
    assert.equal(
      queryCalls[0].preHistoryShortlist,
      undefined,
      'direct sharp_plays must not silently truncate via the pre-history shortlist'
    );
  });

  it('per-pair budget shrinks with pair count and floors at one game', async () => {
    const { getAggregateGameBudget } = require('../lib/propprofessor-sharp-plays-service');
    // Aggregate mode hydrates the strongest side per shortlisted game and
    // reserves 40 calls for initial ranking.
    assert.equal(getAggregateGameBudget(36), 1);
    assert.equal(getAggregateGameBudget(12), 3);
    assert.equal(getAggregateGameBudget(4), 10);
    assert.equal(getAggregateGameBudget(1), 24); // capped at the per-call max
    assert.equal(getAggregateGameBudget(0), 24); // degenerate input
  });
});
