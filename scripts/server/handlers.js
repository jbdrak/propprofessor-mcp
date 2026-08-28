'use strict';
/**
 * MCP tool handlers (extracted from scripts/propprofessor-mcp-server.js in v2.0.0).
 *
 * This file owns the createMcpHandlers() tool implementations. The
 * createMcpServer() JSON-RPC frame stays in the parent file; this file
 * is a leaf that the parent re-exports for backward compatibility.
 *
 * No behavior change vs. v1.7.0 — this is a pure structural refactor.
 */

const { createHandlerContext } = require('./handler-context');
const { createHealthHandlers } = require('./handlers/health');
const { createMetaHandlers } = require('./handlers/meta');
const { createStateHandlers } = require('./handlers/state');
const { createScanHandlers } = require('./handlers/scan');
const { runRecommendedMarket } = require('./handlers/recommended-market');
const { mapRecommendedPlay } = require('./handlers/recommended-play');
const { stripLiteResponse } = require('./handlers/strip-lite-response');
const { logLargeQuickScreenResponse } = require('./handlers/log-large-response');
const { selectRecommendedRows } = require('./handlers/select-recommended-rows');
const { computeMarketsBreakdown } = require('./handlers/recommended-bets-breakdown');
const { createPicksHandlers } = require('./handlers/picks');
const { createPricingHandlers } = require('./handlers/pricing');
const { createContextPluginsHandlers } = require('./handlers/context-plugins');
const { createDiscoveryHandlers } = require('./handlers/discovery');
const { createConsensusHandlers } = require('./handlers/consensus');
const { createCompositesHandlers } = require('./handlers/composites');
const { createScreenHandlers } = require('./handlers/screen');
const { createPlayDetailsHandlers } = require('./handlers/play-details');
const { createValidatePlayHandlers } = require('./handlers/validate-play');
const { createScreenLeaguesHandlers } = require('./handlers/screen-leagues');
const { createTennisScreenHandler } = require('./handlers/tennis-screen');
// Phase 3 Task 6: aggregate screen request-planning + aggregate response-cache
// staging extracted to a dependency-injected seam so tests can pin the cache-key
// shape and hit/miss contract without the network path. Behavior unchanged.
const { planAggregateScreen } = require('./handlers/aggregate-screen');
const { resolveMarkets, stripVerdictFields, mergeHandlerModule } = require('./handlers/handler-utils');
const { ok } = require('../../lib/response-envelope');
const { createPropProfessorClient } = require('../../lib/propprofessor-api');
const {
  DEFAULT_LEAGUES,
  mapWithConcurrency,
  canonicalizeScreenArgs,
  parseGameStartMs
} = require('../../lib/propprofessor-shared-utils');
const { getLocalTimezone, localDateKey } = require('../../lib/mcp-runtime-config');
const { getPropMarketsForSport } = require('../../lib/propprofessor-market-registry');
const { DEFAULT_HISTORY_MIN_INTERVAL_MS } = require('../../lib/propprofessor-screen-history');
// Shared validate/cache/timeout/apply pipeline used by BOTH quick_screen and
// recommended_bets (plan Task 4.1). Required via the namespace (not destructured)
// so handler regression tests can wrap runValidationPipeline with a spy after
// module load.
const validationPipeline = require('../../lib/propprofessor-validation-pipeline');

/**
 * Get default markets for a given league and book.
 * Soccer uses different market names than US sports.
 * @param {string} league - League name (e.g. 'Soccer', 'NBA')
 * @param {string[]} [targetBooks] - Target book names (currently unused, reserved for future per-book overrides)
 * @returns {string[]} Default market names
 */
function getDefaultMarketsForLeague(league, _targetBooks) {
  return require('../../lib/propprofessor-market-registry').getMarketsForSport(league, _targetBooks);
}
const { mapCandidateRow } = require('../../lib/propprofessor-mcp-candidate-mapper');
const { getLimit, getLeagueRankingPreset } = require('../../lib/propprofessor-mcp-ranked-screen');
const { categorizeError } = require('../../lib/propprofessor-mcp-stdio');
// Verdict + tier reconciliation logic extracted to lib/bet-verdict.js (Phase 1
// Task 1). Re-exported below for backward compatibility with existing importers
// (tests, server bootstrap) that required these from handlers.js.
const {
  TIER_RANK,
  applyValidatedFields,
  applyFinalVerdict,
  flagContradictoryPlays,
  promoteFinalVerdictToDisplay
} = require('../../lib/bet-verdict');
const { runSharpPlays } = require('../../lib/propprofessor-sharp-plays-service');
const { getConfidenceTierStable, clearTierCache } = require('../../lib/propprofessor-risk-score');
const { getGameContext } = require('../../lib/propprofessor-game-context');
const { runResearchOnTopRows } = require('../../lib/propprofessor-research-runner');
const {
  formatRecommendedBetsMinimal,
  formatRecommendedBetsStandard,
  formatSharpPlaysMinimal,
  formatSharpPlaysStandard,
  formatQuickScreenMinimal,
  formatQuickScreenStandard,
  formatQuickScreenBets
} = require('../../lib/propprofessor-formatter');
const { filterRowsByKaiCall, filterRowsByMinEV, filterRowsByMovement } = require('../../lib/propprofessor-row-filter');
const { sortRows } = require('../../lib/propprofessor-sort-utils');
const { getPickStats, getBacktestSummary } = require('../../lib/propprofessor-picks');

// NOTE: applyValidatedFields / applyFinalVerdict / flagContradictoryPlays /
// promoteFinalVerdictToDisplay (and TIER_RANK) were extracted to
// lib/bet-verdict.js on 2026-08-27. They are imported at the top of this file
// and re-exported at the bottom for backward compatibility.

/**
 * Hint the JS engine that now is a good time to run GC.
 */
function createMcpHandlers({
  client = createPropProfessorClient(),
  gameContextFn = getGameContext,
  recommendedBetsScreenTimeoutMs = 25_000,
  historyMinIntervalMs: historyMinIntervalMsOption = DEFAULT_HISTORY_MIN_INTERVAL_MS
} = {}) {
  // Clamp the screen timeout so a bad injected value can never disable the
  // per-market stall guard. Production default stays 25s.
  const screenTimeoutMs =
    Number.isFinite(recommendedBetsScreenTimeoutMs) && recommendedBetsScreenTimeoutMs > 0
      ? recommendedBetsScreenTimeoutMs
      : 25_000;
  // Test seam for odds-history pacing: the hydration gate in
  // lib/propprofessor-screen-history.js spaces /odds_history_new calls
  // DEFAULT_HISTORY_MIN_INTERVAL_MS apart. Production keeps that default;
  // tests inject 0 to drop the artificial pacing. Negative/NaN values fall
  // back to the production default so a bad injection can never disable
  // pacing entirely.
  const historyMinIntervalMs =
    Number.isFinite(Number(historyMinIntervalMsOption)) && Number(historyMinIntervalMsOption) >= 0
      ? Number(historyMinIntervalMsOption)
      : DEFAULT_HISTORY_MIN_INTERVAL_MS;
  const ctx = createHandlerContext({ client });
  const { getCacheTtlMs, getCacheMaxEntries, getCacheMaxEntrySizeBytes } = require('../../lib/mcp-runtime-config');
  const { LruCache } = require('../../lib/propprofessor-lru-cache');

  // --- helpers ---

  /**
   * Hint the JS engine that now is a good time to run GC.
   * Only fires when the process was started with --expose-gc.
   * Quick-screen fan-out allocates hundreds of MB across concurrent HTTP
   * calls; without an explicit hint the engine may hold young-generation
   * objects far longer than needed, ballooning RSS by 500+ MB per call.
   */
  const _maybeGc =
    typeof global.gc === 'function'
      ? () => {
          try {
            global.gc();
          } catch {
            /* best-effort */
          }
        }
      : () => {};

  // Single shared response cache — backed directly by LruCache (lib/propprofessor-lru-cache.js).
  // TTL is applied per-set since LruCache supports per-entry TTL.
  // maxEntrySizeBytes caps per-entry size to prevent a single giant quick_screen
  // response (validation + research across 10 leagues) from dominating the heap.
  const responseCache = new LruCache(getCacheMaxEntries(), getCacheMaxEntrySizeBytes());
  const responseCacheTtlMs = getCacheTtlMs();

  // Canonical screen cache for stable (gameId, market, book) tuples.
  // Keyed on canonical tuple rather than full request signature.
  const canonicalScreenCache = ctx.canonicalScreenCache;

  // ─── Screen implementations (extracted to handlers/screen.js,
  // handlers/play-details.js, handlers/validate-play.js, handlers/screen-leagues.js) ───

  // ─── Play Detail & Validation Implementations ───────────────────────────

  // `runGetPlayDetailsImpl` extracted to handlers/play-details.js

  // runValidatePlayImpl extracted to handlers/validate-play.js
  // buildCacheKey, runLeagueScreen, runUfcCard extracted to handlers/screen-leagues.js
  //

  // ===== CONSOLIDATED HANDLER MAP =====
  // 30 old tools → 20 new tools:
  //   ev_candidates          ← query_positive_ev_candidates + query_validated_positive_ev_candidates
  //   screen_raw             ← query_screen_odds + query_screen_odds_best_comps
  //   screen_ranked          ← query_screen_odds_ranked
  //   sharp_plays            ← query_sharp_plays
  //   sharp_consensus        ← query_sharp_consensus_windows
  //   all_slates             ← query_all_slates
  //   ufc_card               ← query_ufc_card (absorbs query_ufc_screen)
  //   recommended_bets       ← query_recommended_bets
  //   staking_plan           ← query_staking_plan
  //   clv_history            ← query_clv_history
  //   player_context         ← query_player_context
  //   league_presets         ← league_presets (unchanged)
  //   health_status          ← health_status (unchanged)
  //   manage_hidden_bets     ← get_hidden_bets + hide_bet + unhide_bet + clear_hidden_bets (unchanged)
  //   fantasy_optimizer      ← query_fantasy_picks (new)
  //   find_best_price        ← find_best_price (unchanged)
  const handlers = {
    async screen_ranked(args = {}) {
      // Reset per-call tier hysteresis so each screen call starts clean
      // (prevents cross-call tier drift from stale cache state).
      clearTierCache();
      // Canonical cache key for stable (gameId, market, book) tuples
      const canonicalKey = canonicalizeScreenArgs(args);

      // If gameId is present, use the canonical cache; otherwise proceed without caching
      if (canonicalKey) {
        // memoize() returns a callable — must INVOKE it to get the response,
        // not hand the function back to the caller.
        return canonicalScreenCache.memoize(async () => {
          return ctx.handlers.runScreenRankedImpl(client, args);
        }, canonicalKey)();
      }

      // Full-league scan - no caching
      return ctx.handlers.runScreenRankedImpl(client, args);
    },

    // ─── Sharp Movement ─────────────────────────────────────────────
    async sharp_plays(args = {}) {
      const response = await runSharpPlays(args, {
        queryLeagueScreen: (rankedArgs) => ctx.handlers.runLeagueScreen(rankedArgs, rankedArgs.league),
        queryTennisScreen: (rankedArgs) => ctx.handlers.runTennisScreen(rankedArgs)
      });
      // Research: when includeResearch=true (default), run player_context
      // on the top N ranked rows to attach injury/risk flags.
      const includeResearch = args.includeResearch !== undefined ? Boolean(args.includeResearch) : true;
      if (includeResearch && Array.isArray(response.result) && response.result.length) {
        const researchLimit = Number.isFinite(Number(args.researchLimit))
          ? Math.max(1, Math.min(50, Number(args.researchLimit)))
          : 10;
        const research = await runResearchOnTopRows({
          rows: response.result,
          limit: researchLimit,
          playerContextFn: handlers.player_context
        });
        response.research = research.results;
        response.resultMeta = {
          ...response.resultMeta,
          researchRunCount: research.results.length,
          researchRiskHighCount: research.results.filter((r) => r.riskFlag === 'high').length,
          researchCachedCount: research.results.filter((r) => r.cached).length
        };
        if (args.riskDowngrade === true) {
          const beforeCount = response.result.length;
          const highRiskPlayers = new Set(
            research.results.filter((r) => r.riskFlag === 'high').map((r) => String(r.player || '').toLowerCase())
          );
          response.result = response.result.filter((row) => {
            const player = String(row.selection || row.participant || '').toLowerCase();
            return !highRiskPlayers.has(player);
          });
          response.resultMeta = {
            ...response.resultMeta,
            riskDowngradedCount: beforeCount - response.result.length
          };
        }
      }

      // === kaiCall filter + sortBy (agent ergonomics) ===
      // Apply after research/riskDowngrade so the filter operates on the
      // final result set. Both are no-ops when the params are missing.
      if (Array.isArray(response.result)) {
        response.result = sortRows(
          filterRowsByMinEV(
            filterRowsByMovement(filterRowsByKaiCall(response.result, args.kaiCall), args.movement),
            args.minEV
          ),
          {
            sortBy: args.sortBy,
            sortDir: args.sortDir
          }
        );
      }

      // Apply verbosity formatting
      const verbosity = String(args.verbosity || 'full').toLowerCase();
      if (verbosity === 'minimal') return formatSharpPlaysMinimal(response);
      if (verbosity === 'standard') return formatSharpPlaysStandard(response);
      return response;
    },

    // ─── Smart Money ───────────────────────────────────────────────
    // smart_money is registered by createDiscoveryHandlers() at line 4261.
    // The inline copy here is dead code — intentionally removed.

    // quick_screen: Accepts any book(s) via the `books` param and runs
    // sharp_plays + player_context for each (league, market) pair.
    // Defaults to ['NoVigApp'].
    // eslint-disable-next-line complexity
    async quick_screen(args = {}) {
      // Reset per-call tier hysteresis so each screen call starts clean
      // (prevents cross-call tier drift from stale cache state).
      clearTierCache();

      // === Aggregate screen planning stage (Phase 3 Task 6) ===
      // Mode presets, derived request scalars, lite field coercion, and the
      // aggregate response-cache key/lookup were extracted to
      // handlers/aggregate-screen.js#planAggregateScreen to create a real
      // dependency-injected seam (responseCache is injected; tests pin the
      // cache-key shape and hit/miss contract). Behavior is identical to the
      // previous inlined block.
      // NOTE: planAggregateScreen mutates args (mode presets + lite compact/
      // fields) in place, exactly as the previous inline code did.
      const plan = planAggregateScreen(args, { responseCache });
      const {
        targetBooks,
        leagues,
        markets,
        limit,
        maxPerMarket,
        scanLimit,
        lookbackHours,
        includeResearch,
        debug,
        topPick,
        lite
      } = plan;

      if (plan.cachedResponse) {
        return plan.cachedResponse;
      }
      // Stash the cache key so the return path can cache the assembled response.
      if (plan.aggregateCacheKey) {
        args._aggregateCacheKey = plan.aggregateCacheKey;
      }

      const allAliasesUsed = [];

      const resolvedMarketsByLeague = {};
      for (const league of leagues) {
        const marketsForResolution = markets === null ? getDefaultMarketsForLeague(league, targetBooks) : markets;
        let marketArray = marketsForResolution;
        if (args.includeProps === true) {
          const propMarkets = getPropMarketsForSport(league);
          if (propMarkets.length) {
            marketArray = [...new Set([...marketArray, ...propMarkets])];
          }
        }
        const marketResolution = resolveMarkets({ markets: marketArray }, league);
        resolvedMarketsByLeague[league] = marketResolution.array.length
          ? marketResolution.array
          : [marketResolution.single];
        allAliasesUsed.push(...marketResolution.aliasesUsed);
      }

      const allCandidates = [];
      const researchResults = [];
      const emptySlate = []; // league+market pairs that returned zero candidates

      // Date window: always scan 'all' to avoid the two-pass HTTP call explosion
      // on off-days (previously scanned 'today' first, then re-scanned 'all' if empty).
      // Post-filter by date when a specific card window is requested.
      const cardWindow = String(args.cardWindow || 'today')
        .trim()
        .toLowerCase();
      let cardWindowFallthrough = null; // set ONLY when today is dead and we fall through to 'next'
      let nextDayMerged = null; // set when today is alive AND tomorrow's rows are merged in

      // Fan out league×market pairs concurrently with concurrency=8.
      // Previously: outer league loop at concurrency=4, inner market loop serial.
      // Now: flat fan-out — all pairs in one pool, ~3× faster on 3-market scans.
      const leagueMarketPairs = [];
      for (const league of leagues) {
        for (const market of resolvedMarketsByLeague[league] || []) {
          leagueMarketPairs.push({ league, market });
        }
      }

      // === Active-pair probe (bounded, no-history) ===
      // The aggregate odds-history allocation (60% of the budget — 180 calls
      // at the default 300, env PP_ODDS_HISTORY_BUDGET) is split across the
      // pairs that actually have current rows, not the raw league×market
      // fan-out. A broad mixed scan (e.g. every league × every market) can
      // contain 20+ pairs while only a couple of leagues have live slates;
      // dividing the allocation by the TOTAL pair count starves the live
      // pairs down to ~1 hydrated game each and valid MLB/WNBA candidates
      // disappear.
      // Probe every pair with a current-market-only screen (skipHistory: true
      // → zero odds-history calls, compact → lighter payload and no per-league
      // cache write), then run the hydrated fan-out over the ACTIVE subset
      // only so empty pairs consume no odds-history calls at all.
      const activeLeagueMarketPairs = [];
      await mapWithConcurrency(
        leagueMarketPairs,
        async ({ league, market }) => {
          try {
            const probeArgs = {
              // Books must mirror the hydrated fan-out (targetBooks → the
              // per-pair scan augments with sharp books) so the probe sees
              // the same universe the scan would hydrate. A probe scoped to
              // a smaller book set could mark a pair inactive that the real
              // scan would find rows for.
              books: targetBooks,
              league,
              market,
              scanLimit,
              lookbackHours,
              is_live: false,
              cardWindow: 'all',
              skipHistory: true,
              compact: true,
              includeResearch: false,
              strict: false,
              includePasses: true
            };
            const probe =
              String(getLeagueRankingPreset(league).league || league).toUpperCase() === 'TENNIS'
                ? await ctx.handlers.runTennisScreen(probeArgs)
                : await ctx.handlers.runLeagueScreen(probeArgs, league);
            if (Array.isArray(probe?.result) && probe.result.length > 0) {
              activeLeagueMarketPairs.push({ league, market });
            } else {
              emptySlate.push({
                league,
                market,
                reason: probe?.resultMeta?.emptyState?.reason || 'no_ranked_rows_scanned',
                scannedRowCount: probe?.resultMeta?.emptyState?.scannedRowCount || 0,
                ...(probe?.resultMeta?.emptyState?.failureBreakdown
                  ? { failureBreakdown: probe.resultMeta.emptyState.failureBreakdown }
                  : {})
              });
            }
          } catch {
            // Probe failure: activity is unknown — fail OPEN and let the
            // hydrated fan-out report the error (preserves the pre-probe
            // error-reporting contract). Only a definitively EMPTY probe
            // (no rows, no error) marks a pair inactive.
            activeLeagueMarketPairs.push({ league, market });
          }
        },
        { concurrency: 8 }
      );
      // Global ACTIVE pair count, passed into every hydrated invocation so
      // the aggregate odds-history allocation (60% of the budget — 180 calls
      // at the default 300) is divided only across live pairs.
      const activeAggregatePairCount = Math.max(1, activeLeagueMarketPairs.length);

      await mapWithConcurrency(
        activeLeagueMarketPairs,
        async ({ league, market }) => {
          try {
            const spResult = await handlers.sharp_plays({
              targetBooks,
              league,
              market,
              limit: scanLimit,
              scanLimit,
              lookbackHours,
              is_live: false,
              strict: false,
              includePasses: true,
              includeResearch: false,
              cardWindow: 'all', // always scan all — filter below
              debug,
              // Aggregate scan mode: quick_screen fans out one sharp_plays
              // call per (league, market) pair against a process-wide
              // odds-history budget (default 300 calls per 5 min, env
              // PP_ODDS_HISTORY_BUDGET). Pass the ACTIVE pair count (from the
              // no-history probe above) so every live pair claims a fair,
              // small pre-history slice instead of the raw fan-out total —
              // on a mixed scan, empty pairs would otherwise starve the live
              // leagues down to ~1 hydrated game each. aggregatePairCount is
              // kept as the raw total for backward compatibility.
              quickScreenAggregate: true,
              activeAggregatePairCount,
              aggregatePairCount: leagueMarketPairs.length
            });

            const candidates = Array.isArray(spResult?.result) ? spResult.result : [];
            if (!candidates.length) {
              emptySlate.push({
                league,
                market,
                reason: spResult.resultMeta?.emptyState?.reason || 'no_ranked_rows_scanned',
                scannedRowCount: spResult.resultMeta?.emptyState?.scannedRowCount || 0,
                ...(spResult.resultMeta?.emptyState?.failureBreakdown
                  ? { failureBreakdown: spResult.resultMeta.emptyState.failureBreakdown }
                  : {})
              });
              if (spResult.resultMeta?.scanHealth || spResult.resultMeta?.preHistoryShortlist) {
                allCandidates.push({
                  league,
                  market,
                  candidates: [],
                  ...(spResult.resultMeta.scanHealth ? { scanHealth: spResult.resultMeta.scanHealth } : {}),
                  ...(spResult.resultMeta.preHistoryShortlist
                    ? { preHistoryShortlist: spResult.resultMeta.preHistoryShortlist }
                    : {}),
                  ...(spResult.resultMeta.perPairDiagnostics
                    ? { perPairDiagnostics: spResult.resultMeta.perPairDiagnostics }
                    : {})
                });
              }
              return;
            }

            const perMarketCap = maxPerMarket || limit;
            allCandidates.push({
              league,
              market,
              candidates: candidates.slice(0, perMarketCap).map(mapCandidateRow),
              ...(spResult.resultMeta?.scanHealth ? { scanHealth: spResult.resultMeta.scanHealth } : {}),
              ...(spResult.resultMeta?.preHistoryShortlist
                ? { preHistoryShortlist: spResult.resultMeta.preHistoryShortlist }
                : {}),
              ...(spResult.resultMeta?.perPairDiagnostics
                ? { perPairDiagnostics: spResult.resultMeta.perPairDiagnostics }
                : {})
            });
          } catch (error) {
            const categorized = categorizeError(error);
            allCandidates.push({
              league,
              market,
              candidates: [],
              error: categorized.message,
              code: categorized.code,
              recovery: categorized.recovery
            });
          }
        },
        { concurrency: 8 }
      );

      // Post-filter by card window when 'today' or 'next' is requested.
      // When 'today' returns a dead slate (<=1 surviving candidates total) and
      // the user didn't explicitly ask for 'today', fall through to 'next' so
      // we surface tomorrow's action instead of a near-empty response.
      if (cardWindow === 'today' || cardWindow === 'next') {
        const tz = getLocalTimezone();
        let targetDateKey =
          cardWindow === 'today' ? localDateKey(Date.now(), tz) : localDateKey(Date.now() + 24 * 60 * 60 * 1000, tz);

        const filterBy = (key) => {
          for (const entry of allCandidates) {
            if (!entry.candidates || !entry.candidates.length) continue;
            // Tennis: NO date filtering — odds presence is the ground truth.
            // Scheduled match times are unreliable (rain delays, ITF mismatches,
            // tournaments shifting day-of). If odds are on the book, show it.
            if (String(entry.league || '').toLowerCase() === 'tennis') continue;
            entry.candidates = entry.candidates.filter((row) => {
              const startMs = parseGameStartMs(row.start);
              if (!startMs) return true; // keep rows without parseable start time
              return localDateKey(startMs, tz) === key;
            });
          }
        };

        // Snapshot the full scan before filtering so we can fall through to 'next'
        const fullCandidatesSnapshot = allCandidates.map((entry) => ({
          ...entry,
          candidates: [...(entry.candidates || [])]
        }));

        filterBy(targetDateKey);

        // Multi-day merge: when cardWindow='today', also surface tomorrow's
        // candidates as separate league/market entries. The previous logic
        // only fell through when today had <=1 total candidate — but when
        // today has action (e.g. 6 Tennis matches), tomorrow's matches (e.g.
        // Korneeva/Birrell Wimbledon R1) were silently dropped. Instead of
        // choosing one day, merge both: keep today's filtered set, then
        // append a second pass of tomorrow's candidates under the same
        // league/market entries so the caller sees the full upcoming slate.
        if (cardWindow === 'today') {
          const totalLive = allCandidates.reduce((sum, e) => sum + (e.candidates?.length || 0), 0);
          // Always check tomorrow — if there are ANY tomorrow candidates,
          // merge them in instead of replacing today.
          const nextKey = localDateKey(Date.now() + 24 * 60 * 60 * 1000, tz);
          const nextCandidates = [];
          for (const entry of fullCandidatesSnapshot) {
            if (!entry.candidates || !entry.candidates.length) continue;
            // Tennis: skip next-day merge — tennis entries were never filtered,
            // so they already contain the full slate. Adding a separate tomorrow
            // entry would create a duplicate league/market pair.
            if (String(entry.league || '').toLowerCase() === 'tennis') continue;
            const nextRows = entry.candidates.filter((row) => {
              const startMs = parseGameStartMs(row.start);
              if (!startMs) return true;
              return localDateKey(startMs, tz) === nextKey;
            });
            if (nextRows.length > 0) {
              nextCandidates.push({
                league: entry.league,
                market: entry.market,
                candidates: nextRows
              });
            }
          }

          if (totalLive <= 1 && allCandidates.length > 0) {
            // Dead-today fall-through: today has nothing, replace with tomorrow
            // (original behavior preserved)
            for (let i = 0; i < allCandidates.length; i++) {
              allCandidates[i].candidates = [...fullCandidatesSnapshot[i].candidates];
            }
            targetDateKey = nextKey;
            filterBy(targetDateKey);
            cardWindowFallthrough = targetDateKey;
          } else if (nextCandidates.length > 0) {
            // Today has action AND tomorrow has action — merge both days.
            // This is NOT a fall-through: today is alive, so the reported
            // cardWindow must stay 'today'. We only flag that next-day rows
            // were merged so consumers know the slate spans two days.
            for (const nc of nextCandidates) {
              // Avoid duplicate entries: if the same league+market already
              // exists from today, append tomorrow's candidates to it.
              const existing = allCandidates.find((e) => e.league === nc.league && e.market === nc.market);
              if (existing) {
                // Filter out duplicates (same gameId + selection already in today)
                const todayKeys = new Set(existing.candidates.map((c) => `${c.gameId || ''}:${c.selection || ''}`));
                const newRows = nc.candidates.filter((c) => !todayKeys.has(`${c.gameId || ''}:${c.selection || ''}`));
                existing.candidates.push(...newRows);
              } else {
                allCandidates.push(nc);
              }
            }
            nextDayMerged = nextKey;
          }
        }
      }

      // === Strip alternate-line candidates (resolveAlternateLines downgrades) ===
      // These are alt Game Handicap / Total Games lines that the ranker already
      // marked TIER 4. They're noise — strip them before validation/research so
      // they don't consume limit slots, inflate response size, or waste API calls.
      for (const entry of allCandidates) {
        if (!entry.candidates || !entry.candidates.length) continue;
        entry.candidates = entry.candidates.filter((c) => !c.altLineFiltered);
      }

      // Tennis time correction and subsequent hoursUntilStart recomputation
      // removed. Rule: live odds on the book mean the match hasn't started.
      // Tennis scheduled times are unreliable — we trust odds presence over
      // any time field. The raw start times embedded in odds-feed game IDs
      // are good enough for display ordering. No ESPN corrections needed.

      const activeSlate = allCandidates
        .filter((r) => r.candidates && r.candidates.length > 0)
        .map((r) => ({
          league: r.league,
          market: r.market,
          count: r.candidates.length,
          error: r.error || null
        }));

      const warnings = allCandidates.some((r) =>
        r.candidates?.some((c) => c.hoursUntilStart !== null && c.hoursUntilStart < 0)
      )
        ? ['Some games have already started. Live odds may be stale.']
        : [];

      const bookList = targetBooks.length === 1 ? targetBooks[0] : targetBooks.join(', ');

      // === validate: run validate_play on returned candidates ===
      // validateAll defaults to false (changed 2026-07-20) to only validate top candidates
      // validateTop limits validation to N best candidates when validate is false/omitted
      // When validate is explicitly false, skip validation entirely.
      const validateAll = args.validate === true; // default false, validate top 10 only
      const requestedValidateTop =
        args.validate === false ? 0 : Number.isFinite(Number(args.validateTop)) ? Number(args.validateTop) : 10;
      // A validation can make several history calls while reconciling exact
      // selection/timestamp drift. Bound bundled quick-screen validation by
      // the shared window and reserve capacity for Tennis fallback recovery.
      // The per-validation estimate is LOW (exact-selection rechecks with
      // enableHistoryLineFallback:false cost 1-3 calls, not 20) so the cap
      // actually lets the requested top-N validate instead of rounding every
      // scan down to a single play.
      const remainingBeforeValidation =
        typeof client.oddsHistoryBudgetRemaining === 'function' ? client.oddsHistoryBudgetRemaining() : null;
      // Tennis in the requested leagues means the CLI tennis fallback runs
      // AFTER this scan and needs a slice of the same window to hydrate its
      // own candidates — reserve it so the fallback isn't starved to zero.
      const tennisInScan = (leagues || []).some((leagueName) => String(leagueName || '').toLowerCase() === 'tennis');
      const VALIDATION_RESERVE_CALLS = tennisInScan ? 40 : 20;
      const VALIDATION_ESTIMATED_CALLS = 3;
      const validationBudgetCap = Number.isFinite(remainingBeforeValidation)
        ? Math.max(0, Math.floor((remainingBeforeValidation - VALIDATION_RESERVE_CALLS) / VALIDATION_ESTIMATED_CALLS))
        : requestedValidateTop;
      const validateTop = validateAll ? requestedValidateTop : Math.min(requestedValidateTop, validationBudgetCap);
      const validationBudgetExhausted = args.validate !== false && requestedValidateTop > 0 && validateTop === 0;
      const watchCandidates = [];
      let validationEligibleCount = 0;
      let validationSelectedCount = 0;
      let validationPartial = false;

      if (args.validate === false) {
        for (const entry of allCandidates) {
          for (const candidate of entry.candidates || []) candidate.validationSkipped = true;
        }
      }

      if (validateAll || validateTop > 0) {
        // Selection policy: validateAll => validate everything; otherwise
        // validate the top N candidates GLOBALLY across the aggregate scan,
        // not N per bucket (selectTopGlobal). Marking/cache/timeout/apply
        // semantics live in the shared pipeline module (plan Task 4.1).
        const validationOutcome = await validationPipeline.runValidationPipeline({
          validate: (vargs) => ctx.handlers.runValidatePlayImpl(client, vargs),
          buildArgs: (candidate, entry) => ({
            league: entry.league,
            gameId: candidate.gameId,
            selection: candidate.selection,
            // Recheck only this exact selection (pre-hydration filter).
            exactSelectionOnly: true,
            playId: candidate.playId,
            market: entry.market,
            skipResearch: true,
            lookbackHours: Number.isFinite(Number(args.lookbackHours)) ? Number(args.lookbackHours) : 6,
            screenTier: candidate.confidenceTier,
            screenKaiCall: candidate.kaiCall,
            // Pass the screen snapshot's consensus/exec so the validator
            // can detect drift (e.g. 5 books on screen → 1 book on re-fetch)
            // and downgrade a phantom BET. Without this, consensusDrift can
            // never fire in the bundled validate path.
            screenConsensusBookCount: candidate.consensusBookCount,
            screenExecutionQuality: candidate.executionQuality,
            screenConsensusEdge: candidate.edge,
            // The aggregate screen already chose the exact line.
            // Recheck only that selection and do not amplify one
            // validation into adjacent-line history requests.
            enableHistoryLineFallback: false,
            // Carry sharpBookMovementConfirmed so the re-fetched row
            // doesn't lose the sharp-book confirmation and downgrade
            // movementDisposition to 'insufficient'.
            screenSharpBookConfirmed: candidate.sharpBookMovementConfirmed || false
          }),
          // Per-gameId+selection+market cache: same game + same selection shares
          // one cache slot. The original key (gameId::market) incorrectly shared
          // Over/Under validation on the same game.
          buildCacheKey: (candidate, entry) => `${candidate.gameId}::${candidate.selection}::${entry.market}`,
          rows: allCandidates.flatMap((entry) =>
            (entry.candidates || []).map((candidate) => ({ target: candidate, entry }))
          ),
          // Skip alt-line rows already downgraded to TIER 4 by resolveAlternateLines
          // in the screen ranker. Validating them re-derives a fresh tier that
          // overwrites the downgrade — wasting API calls and surfacing noise.
          isEligible: (candidate) => Boolean(candidate.gameId && candidate.selection && !candidate.altLineFiltered),
          isBet: (candidate) => candidate.kaiCall === 'BET',
          selectTargets: validationPipeline.selectTopGlobal,
          onNotSelected: (candidate) => {
            candidate.validationBudgetSkipped = true;
            candidate.validationBudgetExhausted = false;
            candidate.validationFailureReason = 'validation not selected within validation budget';
            watchCandidates.push({ ...candidate, official: false });
          },
          applyValidated: (candidate, validation) => {
            applyValidatedFields(candidate, validation);
            candidate._validated = true;
            applyFinalVerdict(candidate);
            // Promote the authoritative validated call into the agent-facing
            // display fields so the tier filters below and downstream consumers
            // see the merged verdict, not the raw screen snapshot.
            promoteFinalVerdictToDisplay(candidate);
          },
          validateAll,
          validateTop,
          mapWithConcurrency
        });
        validationEligibleCount = validationOutcome.eligibleCount;
        validationSelectedCount = validationOutcome.selectedCount;
        validationPartial = validationOutcome.partial;
      }

      // Every candidate needs an authoritative final verdict, even when the
      // shared validation budget prevented a validate_play call. In that case
      // applyFinalVerdict falls back to the screen's displayTier/kaiCall and
      // Budget-exhausted screen BETs remain diagnostic/watch candidates, never official bets.
      for (const entry of allCandidates) {
        for (const candidate of entry.candidates || []) {
          if (validationBudgetExhausted && candidate.kaiCall === 'BET' && !candidate._validated) {
            candidate.validationBudgetExhausted = true;
            candidate.validationFailureReason = 'shared odds-history budget exhausted before validation';
            watchCandidates.push({ ...candidate, official: false });
          }
          applyFinalVerdict(candidate);
        }
      }

      // Post-validation: downgrade contradictory same-game+market plays
      for (const entry of allCandidates) {
        if (entry.candidates && entry.candidates.length) {
          flagContradictoryPlays(entry.candidates);
        }
      }

      const validatedCount = allCandidates.reduce(
        (sum, entry) => sum + (entry.candidates || []).filter((c) => c._validated).length,
        0
      );

      // === Post-filter empty tracking ===
      // Capture league+market pairs that had candidates at scan time but were
      // filtered to zero by card window / tier threshold / kaiCall. Gives agents
      // context for empty results: "15 rows scanned across 5 markets, all below
      // TIER 1 threshold" vs "no games today at all."
      for (const entry of allCandidates) {
        if (!entry.candidates || entry.candidates.length > 0) continue;
        if (entry.error) continue; // already tracked — backend returned error
        const wasEmpty = emptySlate.some((e) => e.league === entry.league && e.market === entry.market);
        if (!wasEmpty) {
          emptySlate.push({
            league: entry.league,
            market: entry.market,
            reason: 'all candidates filtered out (card window / tier / kaiCall)'
          });
        }
      }

      // === targetTiers filter (agent ergonomics) ===
      // Apply before kaiCall/sort so the sequence is: execute -> validateTop -> tier filter -> kaiCall filter -> sort.
      // When omitted, passes through unchanged (same no-op pattern as filterRowsByKaiCall).
      // Key off the AUTHORITATIVE tier: finalConfidenceTier (set by validation
      // merge) takes priority over the raw screen confidenceTier, so a play
      // downgraded by validation can't survive a TIER 1 filter as BET.
      if (Array.isArray(args.targetTiers) && args.targetTiers.length) {
        for (const entry of allCandidates) {
          if (!entry.candidates || !entry.candidates.length) continue;
          entry.candidates = entry.candidates.filter((c) => {
            const liveTier = c.finalConfidenceTier || c.confidenceTierLive || c.confidenceTier || 'TIER 4';
            return args.targetTiers.includes(liveTier);
          });
        }
      }

      // === kaiCall filter + sortBy (agent ergonomics) ===
      // Apply per-entry so each league/market bucket stays in its slot.
      // Filter first, sort second. Both are no-ops when the params are missing.
      for (const entry of allCandidates) {
        if (!entry.candidates || !entry.candidates.length) continue;
        entry.candidates = sortRows(
          filterRowsByMinEV(
            filterRowsByMovement(filterRowsByKaiCall(entry.candidates, args.kaiCall), args.movement),
            args.minEV
          ),
          {
            sortBy: args.sortBy,
            sortDir: args.sortDir
          }
        );
      }

      // === onlyBets: collapse to BET-tier rows only (server-side) ===
      // Applied after validation so finalVerdict/finalConfidenceTier exist.
      if (args.onlyBets) {
        const floor = ['TIER 1', 'TIER 2', 'TIER 3'].indexOf(args.minFinalTier || 'TIER 1');
        for (const entry of allCandidates) {
          if (!entry.candidates || !entry.candidates.length) continue;
          entry.candidates = entry.candidates.filter((c) => {
            const tierIdx = ['TIER 1', 'TIER 2', 'TIER 3', 'TIER 4'].indexOf(
              c.finalConfidenceTier || c.confidenceTier || 'TIER 4'
            );
            return (
              c.finalVerdict === 'BET' && !c.validationBudgetExhausted && !c.validationBudgetSkipped && tierIdx <= floor
            );
          });
        }
      }

      // Resolve verbosity early — hideVerdict guard needs it (bets mode has its own
      // consolidated verdict field, so stripping would cause all-PASS default).
      const verbosity = String(args.verbosity || 'full').toLowerCase();

      // === hideVerdict: strip BET/CONSIDER/PASS from output (agent ergonomics) ===
      // Tier + edge + movement tells the full story. Verdict oscillates with
      // transient execution quality / consensus drift and causes confusion
      // (e.g. TIER 1 plays showing as CONSIDER). Validation still runs internally.
      // Skip when verbosity='bets' — bets mode collapses to a single verdict field,
      // and stripping would cause consolidateVerdict to default everything to PASS.
      if (args.hideVerdict && verbosity !== 'bets') {
        for (const entry of allCandidates) {
          if (!entry.candidates || !entry.candidates.length) continue;
          for (const c of entry.candidates) {
            stripVerdictFields(c);
          }
        }
      }

      // === Player research (scoped to FINAL returned plays) ===
      // Runs AFTER targetTiers/kaiCall/card-window filtering so the research
      // array matches exactly what the agent sees — no raw-scan payload blowup.
      if (includeResearch) {
        const { buildFinalResearchBatch } = require('../../lib/propprofessor-quick-screen-research');
        const researchLimit = Number.isFinite(Number(args.researchLimit))
          ? Math.max(1, Math.min(50, Number(args.researchLimit)))
          : 50;
        const researchBatch = buildFinalResearchBatch(allCandidates, researchLimit);
        if (researchBatch.length) {
          const { runResearchOnTopRows } = require('../../lib/propprofessor-research-runner');
          const researchOut = await runResearchOnTopRows({
            rows: researchBatch.map((r) => ({
              selection: r.player,
              league: r.league,
              game: r.game,
              start: r.start,
              market: r.market
            })),
            limit: researchBatch.length,
            playerContextFn: handlers.player_context,
            gameContextFn,
            concurrency: 3
          });
          for (const r of researchOut.results) {
            researchResults.push({
              player: r.player,
              game: r.game,
              riskFlag: r.riskFlag,
              riskSummary: r.riskSummary || null,
              contextType: r.contextType || 'player',
              market: r.market || null,
              ...(r.topTweet ? { topTweet: r.topTweet.slice(0, 120) } : {})
            });
          }
        }
      }

      // === topPick: collapse to the single best BET-tier play (one-call all-in) ===
      if (topPick) {
        const pool = [];
        for (const entry of allCandidates) {
          for (const c of entry.candidates || []) pool.push(c);
        }
        const betTier = pool.filter((c) => c.kaiCall === 'BET' || c.displayTier === 'BET');
        const source = betTier.length ? betTier : pool;
        source.sort((a, b) => (Number(b.screenScore) || 0) - (Number(a.screenScore) || 0));
        const top = source[0];
        for (const entry of allCandidates) entry.candidates = [];
        if (top) {
          top.why = `Top pick: ${top.selection} (${top.game}) — ${top.rationale}. Edge ${Number(top.edge || 0).toFixed(2)}%, CLV ${Number(top.clv || 0).toFixed(2)}%, ${top.consensusBookCount} books, movement ${top.movementDisposition}.`;
          allCandidates.push({ league: top.league || 'TOP', market: top.market, candidates: [top] });
        }
      }

      const screenResponse = {
        ok: true,
        targetBook: bookList,
        targetBooks,
        leagues,
        markets,
        totalCandidates: allCandidates.reduce((sum, l) => sum + (l.candidates?.length || 0), 0),
        activeSlate,
        emptySlate,
        ...(watchCandidates.length ? { watchCandidates } : {}),
        scanHealth: {
          incomplete:
            validationBudgetExhausted ||
            validationPartial ||
            allCandidates.some((entry) => entry.error || entry.scanHealth?.incomplete || entry.scanHealth?.truncated),
          validationBudgetExhausted,
          validation: {
            requested: requestedValidateTop,
            eligible: validationEligibleCount,
            selected: validationSelectedCount,
            completedCount: validatedCount,
            remainingBeforeValidation,
            ...(validationPartial
              ? { reason: 'validation budget selected fewer candidates than eligible BET candidates' }
              : {})
          },
          truncated: allCandidates.some((entry) => entry.scanHealth?.truncated),
          preHistoryShortlist: allCandidates
            .filter((entry) => entry.preHistoryShortlist)
            .flatMap((entry) => entry.preHistoryShortlist)
        },
        cardWindow: cardWindowFallthrough || cardWindow,
        ...(cardWindowFallthrough ? { cardWindowFallthrough: true } : {}),
        ...(nextDayMerged ? { nextDayMerged: true, nextDayDate: nextDayMerged } : {}),
        maxPlaysPerGame:
          Number.isFinite(Number(args.maxPlaysPerGame)) && Number(args.maxPlaysPerGame) > 0
            ? Number(args.maxPlaysPerGame)
            : 2,
        results: allCandidates,
        research: researchResults,
        warnings,
        tierStats: (() => {
          try {
            const stats = getPickStats({ days: 90 });
            const backtest = getBacktestSummary({ days: 90 });
            return {
              byTier: stats?.stats?.byTier || null,
              backtest: backtest?.ok ? backtest : null
            };
          } catch {
            return null;
          }
        })(),
        _meta:
          validateAll || validateTop > 0
            ? {
                validation: {
                  requested: validateTop,
                  completedCount: validatedCount,
                  note: 'Validated rows have validatedTier, validatedConsensusBookCount, validatedMovementDisposition, validatedActionableSummary, and _validated=true'
                }
              }
            : undefined,
        workflow: `${bookList} target book(s). Playable price (not necessarily best). Sharp book movement cross-referenced. Player context research included.`,
        markets_alias_used: allAliasesUsed
      };
      // Apply verbosity formatting (verbosity resolved earlier for hideVerdict guard)
      let formattedResponse;
      if (verbosity === 'minimal') formattedResponse = formatQuickScreenMinimal(screenResponse);
      else if (verbosity === 'bets') formattedResponse = formatQuickScreenBets(screenResponse);
      else if (verbosity === 'standard') formattedResponse = formatQuickScreenStandard(screenResponse);
      else formattedResponse = screenResponse;

      // lite: strip post-validation bloat AND collapse research inline.
      // The lite fields array only controls screen_ranked; validatedGameContext,
      // validatedEdge/Odds, and the separate research array blow up the payload
      // (4 leagues × 19 candidates = ~118K, truncated). This pass drops ~60%
      // of the response size while keeping every actionable field.
      if (lite && formattedResponse.ok) {
        stripLiteResponse(formattedResponse);
      }

      if (args._aggregateCacheKey && formattedResponse.ok) {
        // Estimate the serialized size so the LRU cache can reject entries
        // that exceed the per-entry cap.  JSON.stringify is O(n) but the
        // response is about to be serialized for the MCP wire anyway, so
        // this is sunk cost — the alternative is caching the blob and
        // unbounded heap growth.
        let estimatedSizeBytes = 0;
        try {
          estimatedSizeBytes = JSON.stringify(formattedResponse).length;
        } catch {
          /* non-serializable — skip caching */
        }
        // Per-league caches already filter empty responses; the aggregate
        // cache must never pin a transient EMPTY slate (a live backend can
        // intermittently return 0 rows, and serving that for the full TTL
        // would hide a later-loaded slate).
        const aggregateResultCount = (formattedResponse.results || []).reduce(
          (sum, entry) => sum + (entry.count || (entry.candidates || []).length || (entry.plays || []).length || 0),
          0
        );
        if (aggregateResultCount > 0) {
          responseCache.set(args._aggregateCacheKey, formattedResponse, responseCacheTtlMs, estimatedSizeBytes);
        }
      }
      // Log large responses for monitoring
      logLargeQuickScreenResponse(formattedResponse);
      _maybeGc();
      return ok(formattedResponse);
    },

    // ─── Betting ────────────────────────────────────────────────────
    async recommended_bets(args = {}) {
      // Reset per-call tier hysteresis so each screen call starts clean
      // (prevents cross-call tier drift from stale cache state).
      clearTierCache();
      const leagues = Array.isArray(args.leagues) && args.leagues.length ? args.leagues : Array.from(DEFAULT_LEAGUES);
      // Resolve markets using aliases for each league
      const allAliasesUsed = [];
      const resolvedMarketsByLeague = {};
      for (const league of leagues) {
        const userProvidedMarkets = !(args.markets === undefined && args.market === undefined);
        const marketResolution = resolveMarkets(
          {
            markets: userProvidedMarkets ? args.markets : getDefaultMarketsForLeague(league),
            market: userProvidedMarkets ? args.market : undefined
          },
          league,
          'Moneyline' // fallback for resolveMarkets
        );
        resolvedMarketsByLeague[league] = marketResolution.array.length
          ? marketResolution.array
          : [marketResolution.single];
        allAliasesUsed.push(...marketResolution.aliasesUsed);
      }
      // Use the first league's resolved markets as the default "markets" for response
      const firstLeague = leagues[0];
      const markets = resolvedMarketsByLeague[firstLeague] || ['Moneyline', 'Spread', 'Total'];
      const targetTiers =
        Array.isArray(args.targetTiers) && args.targetTiers.length ? args.targetTiers : ['TIER 1', 'TIER 2'];
      const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 100;
      // Parallelize per-league work — previously a serial for-of loop, which
      // meant 7 leagues × 3 markets = 21 sequential screen_ranked calls by
      // default. mapWithConcurrency(4) keeps the backend from being hammered
      // while cutting wall-clock latency ~60-70%.
      const allRecommended = [];
      await mapWithConcurrency(
        leagues,
        async (league) => {
          try {
            // Markets are independent per-league; fan them out under a small
            // concurrency cap. Combined with the outer league concurrency of
            // 4, peak in-flight calls sit around 4×3=12 (vs the previous
            // 4-leagues × 3-markets serial = 12 sequential per call) — but
            // the per-call wall-clock time drops to roughly max(per-call)
            // instead of sum(per-call). For 10 leagues × 3 markets that
            // cuts per-league work 3x.
            const leagueMarkets = resolvedMarketsByLeague[league] || markets;
            const marketResults = await mapWithConcurrency(
              leagueMarkets,
              async (market) =>
                runRecommendedMarket({
                  handlers,
                  league,
                  market,
                  books: args.books,
                  limit: limit * 2,
                  compact: args.compact,
                  fields: args.fields,
                  include: args.include,
                  skipHistory: args.skipHistory,
                  screenTimeoutMs
                }),
              { concurrency: 3 }
            );
            const allRows = marketResults.flat();
            const recommended = selectRecommendedRows(allRows, targetTiers, limit, {
              getStableTier: getConfidenceTierStable
            });

            // === kaiCall filter + sortBy (agent ergonomics) ===
            // When args.sortBy is set, override the default tier-then-screenScore order.
            // When args.kaiCall is set, drop rows that don't match the display tier.
            // Both are no-ops when the params are missing. We always copy into
            // a new array so clearing `recommended` doesn't also clear our
            // source when filterRowsByKaiCall/sortRows return the input as-is.
            {
              const kaiFiltered =
                args.kaiCall != null ? filterRowsByKaiCall(recommended, args.kaiCall) : recommended.slice();
              const movementFiltered =
                args.movement != null ? filterRowsByMovement(kaiFiltered, args.movement) : kaiFiltered;
              const filtered = args.minEV != null ? filterRowsByMinEV(movementFiltered, args.minEV) : movementFiltered;
              const sorted = args.sortBy
                ? sortRows(filtered, { sortBy: args.sortBy, sortDir: args.sortDir })
                : filtered;
              recommended.length = 0;
              for (const r of sorted) recommended.push(r);
            }

            if (recommended.length) {
              // Pre-flight research (v2.1.8): when includeResearch=true, attach
              // risk flags to each play. When riskDowngrade=true, drop plays
              // with riskFlag='high' from the recommendation.
              let researchResults = [];
              let downgraded = 0;
              if ((args.includeResearch !== undefined ? Boolean(args.includeResearch) : true) && recommended.length) {
                const research = await runResearchOnTopRows({
                  rows: recommended,
                  limit: recommended.length,
                  playerContextFn: handlers.player_context,
                  gameContextFn: getGameContext
                });
                researchResults = research.results;
                if (args.riskDowngrade === true) {
                  const beforeCount = recommended.length;
                  const highRiskPlayers = new Set(
                    research.results
                      .filter((r) => r.riskFlag === 'high')
                      .map((r) => String(r.player || '').toLowerCase())
                  );
                  for (let i = recommended.length - 1; i >= 0; i -= 1) {
                    const player = String(recommended[i].selection || recommended[i].participant || '').toLowerCase();
                    if (highRiskPlayers.has(player)) {
                      recommended.splice(i, 1);
                    }
                  }
                  downgraded = beforeCount - recommended.length;
                }
              }
              allRecommended.push({
                league,
                count: recommended.length,
                markets_queried: markets,
                downgradedCount: downgraded,
                plays: recommended.map((row) => mapRecommendedPlay(row, researchResults))
              });
            }
          } catch (error) {
            const categorized = categorizeError(error);
            allRecommended.push({
              league,
              count: 0,
              markets_queried: markets,
              error: categorized.message,
              code: categorized.code,
              recovery: categorized.recovery
            });
          }
        },
        { concurrency: 4 }
      );

      // === validate: run validate_play on returned plays ===
      // validateAll defaults to false (2026-07-20) to only validate top candidates
      // validateTopRB limits validation to N best plays when validate is false/omitted
      // When validate is explicitly false, skip validation entirely.
      const validateAllRB = args.validate === true; // default false, validate top 10 only
      const validateTopRB =
        args.validate === false ? 0 : Number.isFinite(Number(args.validateTop)) ? Number(args.validateTop) : 10;

      if (args.validate === false) {
        for (const leagueEntry of allRecommended) {
          for (const play of leagueEntry.plays || []) play.validationSkipped = true;
        }
      }

      if (validateAllRB || validateTopRB > 0) {
        // Selection policy: validateAllRB => validate everything; otherwise
        // validate the top-N plays per league bucket by screenScore
        // (selectTopPerBucket). Marking/cache/timeout/apply semantics live in
        // the shared pipeline module (plan Task 4.1).
        await validationPipeline.runValidationPipeline({
          validate: (vargs) => ctx.handlers.runValidatePlayImpl(client, vargs),
          buildArgs: (play, leagueEntry) => ({
            league: leagueEntry.league,
            gameId: play.gameId,
            selection: play.selection,
            playId: play.playId,
            market: play.market || 'Moneyline',
            skipResearch: true,
            lookbackHours: Number.isFinite(Number(args.lookbackHours)) ? Number(args.lookbackHours) : 6,
            screenTier: play.confidenceTier,
            screenKaiCall: play.kaiCall,
            // Pass the screen snapshot's consensus/exec so the validator
            // can detect drift and downgrade a phantom BET.
            screenConsensusBookCount: play.consensusBookCount,
            screenExecutionQuality: play.executionQuality,
            screenConsensusEdge: play.edge,
            // Carry sharpBookMovementConfirmed so the re-fetched row
            // doesn't lose the sharp-book confirmation and downgrade
            // movementDisposition to 'insufficient'.
            screenSharpBookConfirmed: play.sharpBookMovementConfirmed || false
          }),
          // Per-gameId+selection+market cache: plays from the same game+selection
          // share one cache slot. The key MUST include the selection — gameId::market
          // alone would share an Over validation across the opposing Under line on
          // the same game (and vice versa).
          buildCacheKey: (play) => `${play.gameId}::${play.selection}::${play.market || 'Moneyline'}`,
          rows: allRecommended.flatMap((leagueEntry) =>
            (leagueEntry.plays || []).map((play) => ({ target: play, entry: leagueEntry }))
          ),
          // Skip alt-line rows already downgraded to TIER 4 by resolveAlternateLines
          // in the screen ranker. Validating them re-derives a fresh tier that
          // overwrites the downgrade — wasting API calls and surfacing noise.
          isEligible: (play) => Boolean(play.gameId && play.selection && !play.altLineFiltered),
          isBet: (play) => play.kaiCall === 'BET',
          selectTargets: validationPipeline.selectTopPerBucket,
          onNotSelected: (play) => {
            play.validationFailed = true;
            play.validationFailureReason = 'validation not selected within validation budget';
          },
          applyValidated: (play, validation) => {
            applyValidatedFields(play, validation);
            play._validated = true;
            applyFinalVerdict(play);
            promoteFinalVerdictToDisplay(play);
          },
          validateAll: validateAllRB,
          validateTop: validateTopRB,
          mapWithConcurrency
        });
      }

      // Apply the fail-closed policy to plays that weren't selected within a
      // bounded validation budget. Explicit validate:false is marked as
      // validationSkipped above and remains an intentional opt-out.
      for (const leagueEntry of allRecommended) {
        for (const play of leagueEntry.plays || []) {
          applyFinalVerdict(play);
        }
      }

      // Validation can downgrade a play after the initial screen-tier filter.
      // Re-apply targetTiers to the authoritative final tier so a TIER 4
      // validation result can't leak through a TIER 1-only request.
      for (const entry of allRecommended) {
        if (!Array.isArray(entry.plays)) continue;
        entry.plays = entry.plays.filter((play) =>
          targetTiers.includes(play.finalConfidenceTier || play.confidenceTier)
        );
        entry.count = entry.plays.length;
      }

      // Post-validation: downgrade contradictory same-game+market plays
      for (const entry of allRecommended) {
        if (entry.plays && entry.plays.length) {
          flagContradictoryPlays(entry.plays);
        }
      }

      // === hideVerdict: strip BET/CONSIDER/PASS from output ===
      // recommended_bets defaults to hiding verdict (same philosophy as
      // quick_screen mode='recommended'). Pass hideVerdict: false to opt out.
      if (args.hideVerdict !== false) {
        for (const entry of allRecommended) {
          if (!entry.plays || !entry.plays.length) continue;
          for (const p of entry.plays) {
            stripVerdictFields(p);
          }
        }
      }

      const total = allRecommended.reduce((sum, l) => sum + (l.count || 0), 0);
      const leagueBooks = Array.isArray(args.books) && args.books.length ? args.books : [];
      const focusBook = leagueBooks[0] || null;
      const response = {
        ok: true,
        totalRecommended: total,
        focusBook,
        markets_queried: markets,
        leagues: allRecommended.filter((l) => l.count > 0),
        emptyLeagues: allRecommended.filter((l) => !l.count && !l.error).map((l) => l.league),
        failedLeagues: allRecommended.filter((l) => l.error).map((l) => ({ league: l.league, error: l.error })),
        summary: total
          ? `Found ${total} recommended bet${total === 1 ? '' : 's'} across ${allRecommended.filter((l) => l.count > 0).length} league${allRecommended.filter((l) => l.count > 0).length === 1 ? '' : 's'}`
          : 'No TIER 1 or TIER 2 plays found across requested leagues',
        tierFilter: targetTiers,
        markets_alias_used: allAliasesUsed,
        marketsBreakdown: computeMarketsBreakdown(allRecommended),
        _meta:
          validateAllRB || validateTopRB > 0
            ? {
                validation: {
                  requested: validateTopRB,
                  completedCount: allRecommended.reduce(
                    (sum, l) => sum + (l.plays || []).filter((p) => p._validated).length,
                    0
                  ),
                  note: 'Validated rows have validatedTier, validatedConsensusBookCount, validatedMovementDisposition, validatedActionableSummary, and _validated=true'
                }
              }
            : undefined
      };
      // Apply verbosity formatting
      const verbosity = String(args.verbosity || 'full').toLowerCase();
      if (verbosity === 'minimal') return formatRecommendedBetsMinimal(response);
      if (verbosity === 'standard') return formatRecommendedBetsStandard(response);
      return response;
    },

    // ─── Screening & Ranking (continued) ────────────────────────────
    async all_slates(args = {}) {
      const leagues =
        Array.isArray(args.leagues) && args.leagues.length
          ? args.leagues.map((l) => String(l).trim()).filter(Boolean)
          : Array.from(DEFAULT_LEAGUES);
      const allAliasesUsed = [];
      // Fan out across per-league default markets instead of single-market
      const marketResolutionByLeague = {};
      for (const league of leagues) {
        const userProvidedMarkets = !(args.markets === undefined && args.market === undefined);
        const markets = userProvidedMarkets ? args.markets || [args.market] : getDefaultMarketsForLeague(league);
        const resolvedMarkets = [];
        for (const m of Array.isArray(markets) ? markets : [markets]) {
          const marketResolution = resolveMarkets({ market: m }, league);
          resolvedMarkets.push(marketResolution.single);
          allAliasesUsed.push(...marketResolution.aliasesUsed);
        }
        marketResolutionByLeague[league] = resolvedMarkets;
      }
      const limit = getLimit({ limit: args.limit || 15 });

      const results = await mapWithConcurrency(
        leagues,
        async (league) => {
          try {
            const leagueKey = league.toUpperCase();
            const resolvedMarkets = marketResolutionByLeague[league] || ['Moneyline'];
            let allRows = [];
            let source = 'screen';
            let warnings = undefined;
            for (const resolvedMarket of resolvedMarkets) {
              if (leagueKey === 'TENNIS') {
                const tennisResult = await ctx.handlers.runTennisScreen({
                  market: resolvedMarket,
                  limit,
                  includeAll: args.includeAll,
                  lookbackHours: args.lookbackHours,
                  is_live: false,
                  compact: Boolean(args.compact),
                  fields: Array.isArray(args.fields) ? args.fields : undefined,
                  include: Array.isArray(args.include) ? args.include : undefined,
                  skipHistory: args.skipHistory === true
                });
                allRows.push(...(tennisResult.result || []));
                source = tennisResult.source || source;
                warnings = tennisResult.warnings || warnings;
              } else {
                const leagueResult = await ctx.handlers.runLeagueScreen({
                  market: resolvedMarket,
                  league,
                  limit: limit * 2,
                  includeAll: args.includeAll,
                  lookbackHours: args.lookbackHours,
                  is_live: false,
                  compact: Boolean(args.compact),
                  fields: Array.isArray(args.fields) ? args.fields : undefined,
                  include: Array.isArray(args.include) ? args.include : undefined,
                  skipHistory: args.skipHistory === true
                });
                allRows.push(...(leagueResult.result || []));
                warnings = leagueResult.warnings || warnings;
              }
            }
            return {
              league,
              rows: allRows,
              meta: {
                rowCount: allRows.length,
                source,
                ...(warnings ? { warnings } : {})
              }
            };
          } catch (error) {
            const categorized = categorizeError(error);
            return {
              league,
              rows: [],
              meta: { rowCount: 0, source: 'error' },
              error: {
                error: categorized.message,
                code: categorized.code,
                recovery: categorized.recovery
              }
            };
          }
        },
        { concurrency: 3 }
      );

      const errors = results.filter((r) => r.error).map((r) => ({ league: r.league, ...r.error }));
      const leagueMeta = Object.fromEntries(results.map((r) => [r.league, r.meta]));
      let totalPlays = 0;
      const allRows = [];
      for (const { league, rows } of results) {
        totalPlays += rows.length;
        for (const row of rows) {
          allRows.push({ ...row, _league: league });
        }
      }
      allRows.sort((a, b) => Number(b.screenScore || 0) - Number(a.screenScore || 0));

      return {
        ok: true,
        totalPlays,
        leaguesQueried: leagues,
        leagueMeta,
        consolidated: allRows.slice(0, limit * leagues.length),
        markets_alias_used: allAliasesUsed,
        ...(errors.length > 0 ? { errors } : {})
      };
    },

    // ─── UFC ────────────────────────────────────────────────────────
    async ufc_card(args = {}) {
      return ctx.handlers.runUfcCard(args);
    },

    // ─── Play Detail & Validation Handlers ──────────────────────────────────

    async get_play_details(args = {}) {
      if (!args.books && args.book) {
        args.books = [args.book];
      }
      const canonicalKey = canonicalizeScreenArgs(args);
      if (canonicalKey) {
        return await canonicalScreenCache.memoize(async () => {
          return await ctx.handlers.runGetPlayDetailsImpl(client, args);
        }, canonicalKey)();
      }
      return ctx.handlers.runGetPlayDetailsImpl(client, args);
    },

    /**
     * validate_play (v2.1.8): bundle a get_play_details + player_context +
     * execution check into a single call. Returns a single BET / CONSIDER /
     * PASS verdict with all supporting evidence so the agent doesn't have
     * to chain three separate tool calls.
     *
     * NOTE: does NOT use canonicalScreenCache. The cache's 60s TTL is
     * appropriate for screen_ranked (where the same gameId is re-fetched
     * within seconds across markets) but actively harmful for validate_play,
     * which bundles research + MLB game context that goes stale quickly.
     * Agents also call validate_play once per candidate, not N times, so
     * there's no dedup benefit worth the staleness risk.
     */
    async validate_play(args = {}) {
      // Reset per-call tier hysteresis so each screen call starts clean
      // (prevents cross-call tier drift from stale cache state).
      clearTierCache();
      const result = await ctx.handlers.runValidatePlayImpl(client, args);
      if (result && result.ok === false) {
        return result;
      }
      return ok(result);
    }
  };

  // Extracted module handlers — merge in so they override inline defs.
  // mergeHandlerModule makes every override explicit and rejects new collisions.
  const handlerOwners = new Map(Object.keys(handlers).map((key) => [key, 'inline']));
  mergeHandlerModule(handlers, handlerOwners, 'health', createHealthHandlers(client, ctx));
  mergeHandlerModule(handlers, handlerOwners, 'meta', createMetaHandlers(client, ctx));
  mergeHandlerModule(handlers, handlerOwners, 'state', createStateHandlers(client, ctx));
  mergeHandlerModule(handlers, handlerOwners, 'scan', createScanHandlers(client, ctx));
  mergeHandlerModule(handlers, handlerOwners, 'picks', createPicksHandlers(client, ctx));
  mergeHandlerModule(handlers, handlerOwners, 'pricing', createPricingHandlers(client, ctx));
  mergeHandlerModule(handlers, handlerOwners, 'context-plugins', createContextPluginsHandlers(client, ctx));
  mergeHandlerModule(handlers, handlerOwners, 'discovery', createDiscoveryHandlers(client, ctx));
  mergeHandlerModule(handlers, handlerOwners, 'consensus', createConsensusHandlers(client, ctx));
  mergeHandlerModule(handlers, handlerOwners, 'composites', createCompositesHandlers(client, ctx));
  mergeHandlerModule(handlers, handlerOwners, 'screen', createScreenHandlers(client, ctx));
  mergeHandlerModule(handlers, handlerOwners, 'play-details', createPlayDetailsHandlers(client, ctx));
  mergeHandlerModule(handlers, handlerOwners, 'validate-play', createValidatePlayHandlers(client, ctx));
  mergeHandlerModule(handlers, handlerOwners, 'screen-leagues', createScreenLeaguesHandlers(client, ctx));
  mergeHandlerModule(
    handlers,
    handlerOwners,
    'tennis-screen',
    createTennisScreenHandler(client, { responseCache, responseCacheTtlMs })
  );

  // Test seam plumbing: when the factory was given a non-default
  // historyMinIntervalMs, inject it into the args of every screen/validation
  // impl that reaches buildRankedScreenResponse → hydrateScreenRowsWithHistory
  // so the hydration gate uses the injected interval. The key is unknown to
  // all ranking/verdict logic; it only feeds the gate's minIntervalMs.
  // Production (default 50ms) skips this entirely — impls receive their args
  // unchanged, preserving the production pacing byte-for-byte.
  if (historyMinIntervalMs !== DEFAULT_HISTORY_MIN_INTERVAL_MS) {
    const withHistoryMinInterval = (args = {}) =>
      args && typeof args === 'object' ? { ...args, historyMinIntervalMs } : args;
    const wrapClientArgs = (impl) =>
      typeof impl === 'function'
        ? (client, args = {}, ...rest) => impl(client, withHistoryMinInterval(args), ...rest)
        : impl;
    const wrapArgs = (impl) =>
      typeof impl === 'function' ? (args = {}, ...rest) => impl(withHistoryMinInterval(args), ...rest) : impl;
    handlers.runScreenRankedImpl = wrapClientArgs(handlers.runScreenRankedImpl);
    handlers.runGetPlayDetailsImpl = wrapClientArgs(handlers.runGetPlayDetailsImpl);
    handlers.runValidatePlayImpl = wrapClientArgs(handlers.runValidatePlayImpl);
    handlers.runLeagueScreen = wrapArgs(handlers.runLeagueScreen);
    handlers.runUfcCard = wrapArgs(handlers.runUfcCard);
    handlers.runTennisScreen = wrapArgs(handlers.runTennisScreen);
  }

  // Set handlers reference on ctx so extracted modules can cross-call.
  ctx.handlers = handlers;

  return handlers;
}

module.exports = {
  createMcpHandlers,
  mapWithConcurrency,
  // Re-exported from lib/bet-verdict.js (extracted in Phase 1 Task 1) for
  // backward compatibility with existing importers (tests, server bootstrap).
  TIER_RANK,
  applyValidatedFields,
  applyFinalVerdict,
  flagContradictoryPlays,
  promoteFinalVerdictToDisplay
};
