'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runSharpPlays, getAggregateGameBudget } = require('../lib/propprofessor-sharp-plays-service');
const { buildRankedScreenResponse } = require('../lib/propprofessor-mcp-ranked-screen');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');
const { ODDS_HISTORY_REQUEST_BUDGET } = require('../lib/propprofessor-api');

it('wires the extracted tennis screen handler into the production handler map', () => {
  const handlers = createMcpHandlers({ client: {} });
  assert.equal(typeof handlers.runTennisScreen, 'function');
});

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
    // below the process-wide odds-history budget.
    assert.ok(
      historyCalls.length < ODDS_HISTORY_REQUEST_BUDGET,
      `expected total history calls < ${ODDS_HISTORY_REQUEST_BUDGET} across ${pairCount} pairs, got ${historyCalls.length}`
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
    assert.ok(result.resultMeta.historyBudget.maxSelectionCalls < ODDS_HISTORY_REQUEST_BUDGET);
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

  it('propagates per-pair shortlist health and preserves empty/failure diagnostics', async () => {
    const result = await runSharpPlays(
      {
        book: 'NoVigApp',
        targetBooks: ['NoVigApp'],
        leagues: ['MLB', 'NBA'],
        markets: ['Moneyline'],
        limit: 5,
        quickScreenAggregate: true,
        aggregatePairCount: 2
      },
      {
        queryLeagueScreen: async (rankedArgs, league) => {
          if (league === 'NBA') throw new Error('NBA feed unavailable');
          return {
            ok: true,
            result: [{ gameId: 'mlb-1', selection: 'Home', league, market: 'Moneyline' }],
            resultMeta: {
              preHistoryShortlist: {
                enabled: true,
                truncated: true,
                totalRows: 4,
                shortlistedRows: 1,
                skippedRowCount: 3
              }
            }
          };
        },
        queryTennisScreen: async () => ({ ok: true, result: [] })
      }
    );

    assert.deepEqual(result.resultMeta.preHistoryShortlist, [
      {
        league: 'MLB',
        market: 'Moneyline',
        totalRows: 4,
        shortlistedRows: 1,
        skippedRowCount: 3,
        truncated: true
      }
    ]);
    assert.equal(result.resultMeta.scanHealth.truncated, true);
    assert.equal(result.resultMeta.perPairDiagnostics.length, 2);
    assert.equal(result.resultMeta.perPairDiagnostics.find((p) => p.league === 'MLB').scannedRowCount, 1);
    assert.equal(
      result.resultMeta.perPairDiagnostics.find((p) => p.league === 'NBA').failureReason,
      'NBA feed unavailable'
    );
  });

  it('marks a truncated zero-result aggregate scan incomplete and preserves scope diagnostics', async () => {
    const result = await runSharpPlays(
      {
        book: 'NoVigApp',
        targetBooks: ['NoVigApp'],
        leagues: ['MLB'],
        markets: ['Run Line'],
        limit: 5,
        quickScreenAggregate: true,
        aggregatePairCount: 1
      },
      {
        queryLeagueScreen: async () => ({
          ok: true,
          result: [],
          resultMeta: {
            preHistoryShortlist: {
              enabled: true,
              truncated: true,
              totalRows: 144,
              shortlistedRows: 16,
              skippedRowCount: 128
            },
            perPairDiagnostics: [
              {
                league: 'MLB',
                market: 'Run Line',
                scannedRowCount: 16,
                affectedScope: 'MLB::Run Line'
              }
            ]
          }
        }),
        queryTennisScreen: async () => ({ ok: true, result: [] })
      }
    );

    assert.equal(result.resultMeta.scanHealth.truncated, true);
    assert.equal(result.resultMeta.scanHealth.incomplete, true);
    assert.deepEqual(result.resultMeta.preHistoryShortlist, [
      {
        league: 'MLB',
        market: 'Run Line',
        totalRows: 144,
        shortlistedRows: 16,
        skippedRowCount: 128,
        truncated: true
      }
    ]);
    assert.equal(result.resultMeta.scanHealth.totalRows, 144);
    assert.equal(result.resultMeta.scanHealth.shortlistedRows, 16);
    assert.equal(result.resultMeta.scanHealth.skippedRowCount, 128);
  });

  it('retains truncated zero-result pair health in quick_screen output', async () => {
    const { createMcpHandlers } = require('../scripts/server/handlers');
    const handlers = createMcpHandlers({ client: {} });
    handlers.runLeagueScreen = async (args) =>
      args.skipHistory ? { ok: true, result: [{ gameId: 'mlb-probe' }] } : { ok: true, result: [] };
    handlers.sharp_plays = async () => ({
      ok: true,
      result: [],
      resultMeta: {
        scanHealth: { truncated: true, incomplete: true, totalRows: 144, shortlistedRows: 16, skippedRowCount: 128 },
        preHistoryShortlist: [
          {
            league: 'MLB',
            market: 'Run Line',
            totalRows: 144,
            shortlistedRows: 16,
            skippedRowCount: 128,
            truncated: true
          }
        ]
      }
    });

    const response = await handlers.quick_screen({
      leagues: ['MLB'],
      markets: ['Run Line'],
      book: 'NoVigApp',
      validate: false,
      includeResearch: false,
      cache: false
    });

    assert.equal(response.scanHealth.truncated, true);
    assert.equal(response.scanHealth.incomplete, true);
    assert.deepEqual(response.scanHealth.preHistoryShortlist, [
      {
        league: 'MLB',
        market: 'Run Line',
        totalRows: 144,
        shortlistedRows: 16,
        skippedRowCount: 128,
        truncated: true
      }
    ]);
    assert.equal(response.scanHealth.preHistoryShortlist[0].skippedRowCount, 128);
  });

  it('keeps screen BETs as diagnostic watch candidates when validation budget is exhausted', async () => {
    const { createMcpHandlers } = require('../scripts/server/handlers');
    const handlers = createMcpHandlers({
      client: {
        oddsHistoryBudgetRemaining: () => 0,
        queryScreenOddsBestComps: async () => ({ rows: [] })
      }
    });
    handlers.runLeagueScreen = async () => ({ ok: true, result: [{ gameId: 'probe-1' }] });
    handlers.sharp_plays = async (args) => ({
      ok: true,
      result: [
        {
          gameId: 'mlb-budget-1',
          league: args.league,
          market: args.market,
          selection: 'Home',
          participant: 'Home',
          kaiCall: 'BET',
          displayTier: 'BET',
          confidenceTier: 'TIER 1',
          screenScore: 10,
          odds: -110
        }
      ],
      resultMeta: {
        scanHealth: { truncated: true },
        preHistoryShortlist: [
          {
            league: args.league,
            market: args.market,
            totalRows: 2,
            shortlistedRows: 1,
            skippedRowCount: 1,
            truncated: true
          }
        ]
      }
    });

    const response = await handlers.quick_screen({
      leagues: ['MLB'],
      markets: ['Moneyline'],
      book: 'NoVigApp',
      limit: 5,
      onlyBets: true,
      includeResearch: false,
      cache: false
    });

    assert.equal(response.scanHealth.validationBudgetExhausted, true);
    assert.equal(response.results[0]?.candidates?.length || 0, 0);
    assert.equal(response.watchCandidates.length, 1);
    assert.equal(response.watchCandidates[0].validationBudgetExhausted, true);
    assert.equal(response.watchCandidates[0].official, false);
  });

  it('preserves unselected BETs as non-official watch candidates during partial validation for MLB/WNBA/NFL shapes', async () => {
    const { createMcpHandlers } = require('../scripts/server/handlers');
    const handlers = createMcpHandlers({
      client: {
        // 24 remaining → validation cap = floor((24-20)/3) = 1, so exactly
        // one of the two BETs validates and the other becomes a watch
        // candidate. (Pre-fix math was /20 per validation, which rounded
        // nearly every scan down to a single play.)
        oddsHistoryBudgetRemaining: () => 24
      }
    });
    const cases = [
      { league: 'MLB', market: 'Moneyline' },
      { league: 'WNBA', market: 'Total Points' },
      { league: 'NFL', market: 'Moneyline' }
    ];

    handlers.runLeagueScreen = async () => ({ ok: true, result: [{ gameId: 'probe' }] });
    handlers.sharp_plays = async (args) => ({
      ok: true,
      result: [
        {
          gameId: `${args.league}-best`,
          league: args.league,
          market: args.market,
          selection: 'known good selection',
          participant: 'known good selection',
          kaiCall: 'BET',
          displayTier: 'BET',
          confidenceTier: 'TIER 1',
          screenScore: 100,
          odds: -110
        },
        {
          gameId: `${args.league}-watch`,
          league: args.league,
          market: args.market,
          selection: 'ranked watch selection',
          participant: 'ranked watch selection',
          kaiCall: 'BET',
          displayTier: 'BET',
          confidenceTier: 'TIER 1',
          screenScore: 90,
          odds: -105
        }
      ],
      resultMeta: { scanHealth: { truncated: false } }
    });
    handlers.runValidatePlayImpl = async (_client, args) => ({
      ok: true,
      verdict: 'BET',
      tier: 'TIER 1',
      verdictSummary: {
        displayTier: 'BET',
        movementDisposition: 'supportive_clean',
        executionQuality: 'playable',
        riskFlags: [],
        actionableSummary: 'Known good validated play.'
      },
      play: { consensusBookCount: 5, executionQuality: 'playable', odds: -110 },
      gameId: args.gameId
    });

    for (const { league, market } of cases) {
      const response = await handlers.quick_screen({
        leagues: [league],
        markets: [market],
        book: 'NoVigApp',
        limit: 5,
        onlyBets: true,
        includeResearch: false,
        cache: false
      });

      assert.equal(response.scanHealth.incomplete, true);
      assert.equal(response.scanHealth.validation.eligible, 2);
      assert.equal(response.scanHealth.validation.selected, 1);
      assert.equal(response.scanHealth.validation.completedCount, 1);
      assert.equal(
        response.scanHealth.validation.reason,
        'validation budget selected fewer candidates than eligible BET candidates'
      );
      assert.equal(response.results[0].candidates.length, 1);
      assert.equal(response.results[0].candidates[0].gameId, `${league}-best`);
      assert.equal(response.watchCandidates.length, 1);
      assert.equal(response.watchCandidates[0].gameId, `${league}-watch`);
      assert.equal(response.watchCandidates[0].official, false);
      assert.equal(response.watchCandidates[0].validationBudgetExhausted, false);
    }
  });

  it('per-pair budget shrinks with pair count and floors at one game', async () => {
    const { getAggregateGameBudget } = require('../lib/propprofessor-sharp-plays-service');
    const { ODDS_HISTORY_REQUEST_BUDGET } = require('../lib/propprofessor-api');
    // Aggregate mode hydrates the strongest side per shortlisted game and
    // reserves 60% of the process budget for initial ranking.
    const allocation = Math.floor(ODDS_HISTORY_REQUEST_BUDGET * 0.6);
    assert.equal(getAggregateGameBudget(36), Math.max(1, Math.min(24, Math.floor(allocation / 36))));
    assert.equal(getAggregateGameBudget(12), Math.max(1, Math.min(24, Math.floor(allocation / 12))));
    assert.equal(getAggregateGameBudget(4), Math.max(1, Math.min(24, Math.floor(allocation / 4))));
    assert.equal(getAggregateGameBudget(1), 24); // capped at the per-call max
    assert.equal(getAggregateGameBudget(0), 24); // degenerate input
  });

  it('mixed quick_screen: empty pairs do not starve MLB/WNBA of the 40-call budget', async () => {
    // Production-shaped coordinator regression: quick_screen fans out one
    // sharp_plays call per (league, market) pair. On a broad MIXED scan only
    // MLB and WNBA have live slates; every other league is empty. Before the
    // active-pair fix the 40-call initial odds-history allocation was divided
    // by the RAW fan-out count (9 pairs → 4 games per pair → only the top-2
    // games actually hydrated), so qualifying MLB/WNBA candidates outside the
    // top games were dropped from the shortlist and disappeared. After the
    // fix quick_screen probes each pair with a no-history screen, fans out
    // hydration over the ACTIVE pairs only (2), and passes
    // activeAggregatePairCount=2 — so each live pair gets a 20-game budget,
    // every game is hydrated, both qualifying rows survive, and total initial
    // odds-history selection calls stay <= 40.
    const LEAGUES = ['MLB', 'WNBA', 'NBA', 'NFL', 'NHL', 'Soccer', 'NCAAF', 'NCAAB', 'Tennis'];

    // Side-1 consensus edge rises monotonically with `edge` (NoVigApp -100 →
    // +105 pivot at 1.0 against Pinnacle -120), so the pre-history shortlist
    // picks games by index order: under the old 9-pair split only indices 6–7
    // hydrated; index 5 is the qualifying row that vanished.
    function makeLeagueRow(gameId, edge) {
      return {
        gameId,
        league: 'MLB',
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
    // the regression can assert the surviving rows are usable, not degraded.
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
    const handlers = createMcpHandlers({ client });

    // Run the REAL sharp_plays/runSharpPlays pipeline but record every
    // invocation so we can assert the active-pair contract end to end.
    const sharpPlaysInvocations = [];
    const originalSharpPlays = handlers.sharp_plays;
    handlers.sharp_plays = async (args) => {
      const result = await originalSharpPlays(args);
      sharpPlaysInvocations.push({ args, result });
      return result;
    };

    // Screen layer: MLB and WNBA have 8 current games each; every other
    // league/market is empty. buildRankedScreenResponse runs the REAL
    // pre-history shortlist + odds-history hydration machinery.
    const screenCalls = [];
    const tennisScreenCalls = [];
    handlers.runLeagueScreen = async (rankedArgs, league) => {
      screenCalls.push({ args: rankedArgs, league });
      const active = league === 'MLB' || league === 'WNBA';
      const payload = {
        rows: active
          ? Array.from({ length: 8 }, (_, index) => makeLeagueRow(`game-${league}-${index}`, 0.5 + index * 0.3))
          : []
      };
      return buildRankedScreenResponse({
        client,
        payloads: [payload],
        args: rankedArgs,
        league,
        focusBook: 'NoVigApp',
        rankRows: makeSupportiveRanker
      });
    };
    handlers.runTennisScreen = async (rankedArgs) => {
      tennisScreenCalls.push(rankedArgs);
      return { ok: true, result: [] };
    };

    const result = await handlers.quick_screen({
      leagues: LEAGUES,
      markets: ['Moneyline'],
      book: 'NoVigApp',
      limit: 100,
      scanLimit: 100,
      validate: false,
      includeResearch: false
    });

    // 1) Probe contract: every pair was probed current-market-only (zero
    //    odds-history calls), and the hydrated fan-out ran for exactly the
    //    two active pairs.
    const probeCalls = screenCalls.filter((c) => c.args.skipHistory === true);
    const hydratedCalls = screenCalls.filter((c) => c.args.skipHistory !== true);
    assert.equal(probeCalls.length, LEAGUES.length - 1, 'every non-tennis pair should be probed once');
    assert.equal(tennisScreenCalls.length, 1, 'tennis pair should be probed through runTennisScreen');
    assert.equal(hydratedCalls.length, 2, 'only the active MLB/WNBA pairs should be hydrated');
    for (const { args } of probeCalls) {
      assert.equal(args.skipHistory, true, 'probe must be current-market-only');
      assert.equal(args.compact, true, 'probe must use a light compact response');
    }
    for (const { args } of hydratedCalls) {
      assert.equal(args.preHistoryShortlist, true, 'hydrated pass must opt into the pre-history shortlist');
      assert.equal(args.enableHistoryLineFallback, false, 'aggregate hydration must not amplify line variants');
    }

    // 2) Active-pair count contract: every per-pair sharp_plays call got the
    //    SAME global active count (2), not the raw 9-pair fan-out total.
    assert.equal(sharpPlaysInvocations.length, 2, 'one sharp_plays call per active pair');
    for (const { args, result: spResult } of sharpPlaysInvocations) {
      assert.equal(args.quickScreenAggregate, true);
      assert.equal(args.activeAggregatePairCount, 2, 'active count must be passed into every invocation');
      assert.equal(args.aggregatePairCount, LEAGUES.length, 'raw total kept for backward compat');
      assert.equal(spResult.resultMeta.historyBudget.pairCount, 2, 'budget meta must reflect ACTIVE pairs');
      assert.equal(
        spResult.resultMeta.historyBudget.maxSelectionCalls,
        2 * getAggregateGameBudget(2),
        '2 active pairs × per-pair game budget = expected max calls'
      );
    }

    // 3) THE regression: both qualifying rows survive with real movement.
    const allCandidates = (result.results || []).flatMap((entry) => entry.candidates || []);
    const findQualifying = (league) =>
      allCandidates.find((c) => String(c.gameId) === `game-${league}-5` && c.selection === `Home game-${league}-5`);
    for (const league of ['MLB', 'WNBA']) {
      const qualifying = findQualifying(league);
      assert.ok(qualifying, `qualifying ${league} candidate (game index 5) must survive the scan`);
      assert.equal(
        qualifying.movementDisposition,
        'supportive_clean',
        `${league} qualifying row must be hydrated (starved to 'insufficient' or dropped pre-fix)`
      );
    }

    // 4) Empty pairs consumed zero odds-history calls; total initial
    //    odds-history selection calls stay within the 40-call allocation.
    assert.ok(historyCalls.length <= 40, `total odds-history calls ${historyCalls.length} must stay <= 40`);
    assert.ok(
      historyCalls.length >= 16,
      `active pairs should hydrate at least 8 games each, got ${historyCalls.length} calls`
    );
    for (const call of historyCalls) {
      const gameId = String(call.gameId || '');
      assert.ok(
        gameId.startsWith('game-MLB-') || gameId.startsWith('game-WNBA-'),
        `empty pairs must never consume odds-history calls (got ${gameId})`
      );
    }

    // 5) Empty pairs are still reported so the response stays informative.
    const emptySlateLeagues = (result.emptySlate || []).map((e) => e.league);
    assert.ok(
      LEAGUES.filter((l) => l !== 'MLB' && l !== 'WNBA').every((l) => emptySlateLeagues.includes(l)),
      'empty pairs should be surfaced in emptySlate'
    );
  });
});
