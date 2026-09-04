'use strict';

/**
 * quick_screen handler — extracted from createMcpHandlers() in handlers.js.
 *
 * This is a behavioral extraction with NO behavior change. The original inline
 * handlers.quick_screen body is preserved verbatim but reorganized into a thin
 * orchestrator (runQuickScreen) that delegates each phase to an explicit,
 * dependency-injected helper below. Every helper receives its inputs and returns
 * its outputs — no closure state is captured beyond the passed `deps`.
 *
 * quick_screen fans out through handlers.sharp_plays and the screen impls via
 * ctx.handlers (already wired by createMcpHandlers before this module is
 * merged in), exactly as the inline version did.
 *
 * @param {import('../../../lib/propprofessor-api').PropProfessorClient} client
 * @param {import('./handler-context').HandlerContext} ctx
 * @param {object} deps
 * @param {object} deps.responseCache - LruCache instance (aggregate response cache)
 * @param {number} deps.responseCacheTtlMs
 * @param {Function} deps.gameContextFn
 * @param {Function} deps.maybeGc
 */

const { ok } = require('../../../lib/response-envelope');
const { clearTierCache } = require('../../../lib/propprofessor-risk-score');
const { getMarketsForSport } = require('../../../lib/propprofessor-market-registry');
const { getPropMarketsForSport } = require('../../../lib/propprofessor-market-registry');
const { getLocalTimezone, localDateKey } = require('../../../lib/mcp-runtime-config');
const { getLeagueRankingPreset } = require('../../../lib/propprofessor-mcp-ranked-screen');
const { mapCandidateRow } = require('../../../lib/propprofessor-mcp-candidate-mapper');
const { parseGameStartMs } = require('../../../lib/propprofessor-shared-utils');
const { recoverStandardTotals } = require('./totals-recovery');
const { resolveMarkets, stripVerdictFields } = require('./handler-utils');
const { planAggregateScreen } = require('./aggregate-screen');
const { logLargeQuickScreenResponse } = require('./log-large-response');
const { stripLiteResponse } = require('./strip-lite-response');
const validationPipeline = require('../../../lib/propprofessor-validation-pipeline');
const {
  applyValidatedFields,
  applyFinalVerdict,
  flagContradictoryPlays,
  promoteFinalVerdictToDisplay
} = require('../../../lib/bet-verdict');
const { runResearchOnTopRows } = require('../../../lib/propprofessor-research-runner');
const { buildFinalResearchBatch } = require('../../../lib/propprofessor-quick-screen-research');
const { categorizeError } = require('../../../lib/propprofessor-mcp-stdio');
const {
  formatQuickScreenMinimal,
  formatQuickScreenStandard,
  formatQuickScreenBets
} = require('../../../lib/propprofessor-formatter');
const { filterRowsByKaiCall, filterRowsByMinEV, filterRowsByMovement } = require('../../../lib/propprofessor-row-filter');
const { sortRows } = require('../../../lib/propprofessor-sort-utils');
const { getPickStats, getBacktestSummary } = require('../../../lib/propprofessor-picks');
const { mapWithConcurrency } = require('../../../lib/propprofessor-shared-utils');

// Local mirror of the original inline getDefaultMarketsForLeague wrapper in
// handlers.js — resolves default markets for a league via the registry.
function getDefaultMarketsForLeague(league, _targetBooks) {
  return getMarketsForSport(league, _targetBooks);
}

function isStandardTotalsMarket(market) {
  return new Set(['Total Runs', 'Total Points', 'Total Goals', 'Total Games', 'Total Rounds']).has(
    String(market || '').trim()
  );
}

// ─── Phase: resolve markets per league (incl. includeProps augmentation) ───────

function resolveQuickScreenMarkets(leagues, markets, targetBooks, includeProps) {
  const resolvedMarketsByLeague = {};
  const allAliasesUsed = [];
  for (const league of leagues) {
    const marketsForResolution = markets === null ? getDefaultMarketsForLeague(league, targetBooks) : markets;
    let marketArray = marketsForResolution;
    if (includeProps === true) {
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
  return { resolvedMarketsByLeague, allAliasesUsed };
}

// ─── Phase: active-pair probe + hydrated fan-out ──────────────────────────────

async function runQuickScreenFanout(ctx, { targetBooks, leagues, resolvedMarketsByLeague, scanLimit, lookbackHours, debug, maxPerMarket, limit, args }) {
  const allCandidates = [];
  const unresolvedCandidates = [];
  const emptySlate = []; // league+market pairs that returned zero candidates

  const leagueMarketPairs = [];
  for (const league of leagues) {
    for (const market of resolvedMarketsByLeague[league] || []) {
      leagueMarketPairs.push({ league, market });
    }
  }

  const activeLeagueMarketPairs = await probeActivePairs(ctx, leagueMarketPairs, { targetBooks, scanLimit, lookbackHours, emptySlate });
  const activeAggregatePairCount = Math.max(1, activeLeagueMarketPairs.length);

  await mapWithConcurrency(
    activeLeagueMarketPairs,
    async ({ league, market }) => {
      await runOneHydratedPair(ctx, {
        league,
        market,
        targetBooks,
        scanLimit,
        lookbackHours,
        debug,
        maxPerMarket,
        limit,
        args,
        leagueMarketPairs,
        activeAggregatePairCount,
        allCandidates,
        unresolvedCandidates,
        emptySlate
      });
    },
    { concurrency: 8 }
  );

  return { allCandidates, unresolvedCandidates, emptySlate };
}

// Active-pair probe (bounded, no-history): find which league×market pairs
// actually have current rows so the hydrated fan-out only consumes odds-history
// budget on live pairs.
async function probeActivePairs(ctx, leagueMarketPairs, { targetBooks, scanLimit, lookbackHours, emptySlate }) {
  const activeLeagueMarketPairs = [];
  await mapWithConcurrency(
    leagueMarketPairs,
    async ({ league, market }) => {
      try {
        const probeArgs = {
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
        // Probe failure: activity is unknown — fail OPEN and let the hydrated
        // fan-out report the error. Only a definitively EMPTY probe marks a
        // pair inactive.
        activeLeagueMarketPairs.push({ league, market });
      }
    },
    { concurrency: 8 }
  );
  return activeLeagueMarketPairs;
}

async function runOneHydratedPair(
  ctx,
  { league, market, targetBooks, scanLimit, lookbackHours, debug, maxPerMarket, limit, args, leagueMarketPairs, activeAggregatePairCount, allCandidates, unresolvedCandidates, emptySlate }
) {
  try {
    const spResult = await ctx.handlers.sharp_plays({
      targetBooks,
      league,
      market,
      limit: scanLimit,
      scanLimit,
      lookbackHours,
      recentWindowHours: args.recentWindowHours,
      is_live: false,
      strict: false,
      includePasses: true,
      includeResearch: false,
      cardWindow: 'all',
      debug,
      quickScreenAggregate: true,
      activeAggregatePairCount,
      aggregatePairCount: leagueMarketPairs.length
    });

    let candidates = Array.isArray(spResult?.result) ? spResult.result : [];
    if (Array.isArray(spResult?.resultMeta?.unresolvedCandidates)) {
      unresolvedCandidates.push(
        ...spResult.resultMeta.unresolvedCandidates.map((candidate) => ({
          ...mapCandidateRow(candidate),
          official: false,
          status: 'unresolved',
          incomplete: true,
          lineHistoryAvailable: false,
          movementDisposition: 'unavailable',
          validationFailureReason: candidate.validationFailureReason
        }))
      );
    }
    let totalsRecoveryApplied = false;
    const totalsScanTruncated = Boolean(
      spResult.resultMeta?.scanHealth?.truncated ||
        (Array.isArray(spResult.resultMeta?.preHistoryShortlist) &&
          spResult.resultMeta.preHistoryShortlist.some((entry) => entry.truncated))
    );
    if (
      !candidates.length &&
      isStandardTotalsMarket(market) &&
      totalsScanTruncated &&
      typeof ctx.handlers.runLeagueScreen === 'function'
    ) {
      try {
        const recoveredRows = await recoverStandardTotals({
          runLeagueScreen: ctx.handlers.runLeagueScreen,
          league,
          market,
          targetBooks,
          scanLimit,
          lookbackHours
        });
        if (recoveredRows?.length) {
          candidates = recoveredRows;
          totalsRecoveryApplied = true;
        }
      } catch {
        // Keep the original empty-market diagnostics on recovery failure.
      }
    }
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
        : {}),
      ...(totalsRecoveryApplied ? { totalsRecoveryApplied: true } : {})
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
}

// ─── Phase: card-window filter + multi-day merge ─────────────────────────────

function applyQuickScreenCardWindow(allCandidates, emptySlate, cardWindow) {
  if (cardWindow !== 'today' && cardWindow !== 'next') {
    return { cardWindowFallthrough: null, nextDayMerged: null };
  }
  const tz = getLocalTimezone();
  let targetDateKey =
    cardWindow === 'today' ? localDateKey(Date.now(), tz) : localDateKey(Date.now() + 24 * 60 * 60 * 1000, tz);

  const filterBy = (key) => {
    const nowMs = Date.now();
    for (const entry of allCandidates) {
      if (!entry.candidates || !entry.candidates.length) continue;
      const pregameOnly = String(entry.league || '').trim().toUpperCase() !== 'TENNIS';
      entry.candidates = entry.candidates.filter((row) => {
        const startMs = parseGameStartMs(row.start);
        if (!startMs) return true;
        if (localDateKey(startMs, tz) !== key) return false;
        if (pregameOnly && (row.isLive === true || startMs < nowMs)) return false;
        return true;
      });
    }
  };

  const fullCandidatesSnapshot = allCandidates.map((entry) => ({
    ...entry,
    candidates: [...(entry.candidates || [])]
  }));

  filterBy(targetDateKey);

  if (cardWindow !== 'today') {
    return { cardWindowFallthrough: null, nextDayMerged: null };
  }

  const totalLive = allCandidates.reduce((sum, e) => sum + (e.candidates?.length || 0), 0);
  const nextKey = localDateKey(Date.now() + 24 * 60 * 60 * 1000, tz);
  const nextCandidates = [];
  for (const entry of fullCandidatesSnapshot) {
    if (!entry.candidates || !entry.candidates.length) continue;
    if (String(entry.league || '').toLowerCase() === 'tennis') continue;
    const nextRows = entry.candidates.filter((row) => {
      const startMs = parseGameStartMs(row.start);
      if (!startMs) return true;
      return localDateKey(startMs, tz) === nextKey;
    });
    if (nextRows.length > 0) {
      nextCandidates.push({ league: entry.league, market: entry.market, candidates: nextRows });
    }
  }

  let cardWindowFallthrough = null;
  let nextDayMerged = null;
  if (totalLive <= 1 && allCandidates.length > 0) {
    for (let i = 0; i < allCandidates.length; i++) {
      allCandidates[i].candidates = [...fullCandidatesSnapshot[i].candidates];
    }
    targetDateKey = nextKey;
    filterBy(targetDateKey);
    cardWindowFallthrough = targetDateKey;
  } else if (nextCandidates.length > 0) {
    for (const nc of nextCandidates) {
      const existing = allCandidates.find((e) => e.league === nc.league && e.market === nc.market);
      if (existing) {
        const todayKeys = new Set(existing.candidates.map((c) => `${c.gameId || ''}:${c.selection || ''}`));
        const newRows = nc.candidates.filter((c) => !todayKeys.has(`${c.gameId || ''}:${c.selection || ''}`));
        existing.candidates.push(...newRows);
      } else {
        allCandidates.push(nc);
      }
    }
    nextDayMerged = nextKey;
  }
  return { cardWindowFallthrough, nextDayMerged };
}

// ─── Phase: validation pipeline + final verdict + contradictory downgrade ──────

// Build the validate_play args for one quick_screen candidate (mirrors the
// original inline buildArgs closure verbatim).
function buildQuickScreenValidationArgs(candidate, entry, args) {
  return {
    league: entry.league,
    gameId: candidate.gameId,
    selection: candidate.selection,
    books:
      Array.isArray(candidate.historySportsbooksRequested) && candidate.historySportsbooksRequested.length
        ? candidate.historySportsbooksRequested
        : Array.isArray(args.books) && args.books.length
          ? args.books
          : candidate.book
            ? [candidate.book]
            : args.book
              ? [args.book]
              : undefined,
    exactSelectionOnly: true,
    playId: candidate.playId,
    market: entry.market,
    skipResearch: true,
    lookbackHours:
      Number.isFinite(Number(candidate.lineHistoryLookbackHours)) && Number(candidate.lineHistoryLookbackHours) > 0
        ? Number(candidate.lineHistoryLookbackHours)
        : Number.isFinite(Number(args.lookbackHours))
          ? Number(args.lookbackHours)
          : 6,
    recentWindowHours:
      Number.isFinite(Number(candidate.recentWindowHours)) && Number(candidate.recentWindowHours) > 0
        ? Number(candidate.recentWindowHours)
        : Number.isFinite(Number(args.recentWindowHours)) && Number(args.recentWindowHours) > 0
          ? Number(args.recentWindowHours)
          : undefined,
    screenMovementSourceBook: candidate.movementSourceBook || undefined,
    screenMovementMode: candidate.movementMode || undefined,
    screenMovementDisposition: candidate.movementDisposition || undefined,
    screenTier: candidate.confidenceTier,
    screenKaiCall: candidate.kaiCall,
    screenConsensusBookCount: candidate.consensusBookCount,
    screenExecutionQuality: candidate.executionQuality,
    screenConsensusEdge: candidate.edge,
    enableHistoryLineFallback: false,
    screenSharpBookConfirmed: candidate.sharpBookMovementConfirmed || false
  };
}

async function runQuickScreenValidation(client, ctx, allCandidates, { args, validateAll, requestedValidateTop, leagues }) {
  const watchCandidates = [];
  let validationEligibleCount = 0;
  let validationSelectedCount = 0;
  let validationPartial = false;
  let validationBudgetExhausted = false;

  if (args.validate === false) {
    for (const entry of allCandidates) {
      for (const candidate of entry.candidates || []) candidate.validationSkipped = true;
    }
  }

  let validateTop = 0;
  if (validateAll || requestedValidateTop > 0) {
    const remainingBeforeValidation =
      typeof client.oddsHistoryBudgetRemaining === 'function' ? client.oddsHistoryBudgetRemaining() : null;
    const tennisInScan = (leagues || []).some((leagueName) => String(leagueName || '').toLowerCase() === 'tennis');
    const VALIDATION_RESERVE_CALLS = tennisInScan ? 40 : 20;
    const VALIDATION_ESTIMATED_CALLS = 3;
    const validationBudgetCap = Number.isFinite(remainingBeforeValidation)
      ? Math.max(0, Math.floor((remainingBeforeValidation - VALIDATION_RESERVE_CALLS) / VALIDATION_ESTIMATED_CALLS))
      : requestedValidateTop;
    validateTop = validateAll ? requestedValidateTop : Math.min(requestedValidateTop, validationBudgetCap);
    validationBudgetExhausted = args.validate !== false && requestedValidateTop > 0 && validateTop === 0;
  }

  if (validateAll || validateTop > 0) {
    const validationOutcome = await validationPipeline.runValidationPipeline({
      validate: (vargs) => ctx.handlers.runValidatePlayImpl(client, vargs),
      buildArgs: (candidate, entry) => buildQuickScreenValidationArgs(candidate, entry, args),
      buildCacheKey: (candidate, entry) => `${candidate.gameId}::${candidate.selection}::${entry.market}`,
      rows: allCandidates.flatMap((entry) =>
        (entry.candidates || []).map((candidate) => ({ target: candidate, entry }))
      ),
      isEligible: (candidate) =>
        Boolean(
          candidate.gameId &&
            candidate.selection &&
            !candidate.altLineFiltered &&
            (!args.onlyBets || candidate.kaiCall === 'BET')
        ),
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

  // Authoritative final verdict for every candidate (incl. budget-exhausted BETs).
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

  for (const entry of allCandidates) {
    if (entry.candidates && entry.candidates.length) {
      flagContradictoryPlays(entry.candidates);
    }
  }

  const validatedCount = allCandidates.reduce(
    (sum, entry) => sum + (entry.candidates || []).filter((c) => c._validated).length,
    0
  );

  return {
    watchCandidates,
    validationBudgetExhausted,
    validationEligibleCount,
    validationSelectedCount,
    validationPartial,
    validateTop,
    validatedCount
  };
}

// ─── Phase: post-validation filters (empty tracking, targetTiers, kaiCall/sort, onlyBets, hideVerdict) ─

function applyQuickScreenFilters(allCandidates, emptySlate, args) {
  // Post-filter empty tracking.
  for (const entry of allCandidates) {
    if (!entry.candidates || entry.candidates.length > 0) continue;
    if (entry.error) continue;
    const wasEmpty = emptySlate.some((e) => e.league === entry.league && e.market === entry.market);
    if (!wasEmpty) {
      emptySlate.push({
        league: entry.league,
        market: entry.market,
        reason: 'all candidates filtered out (card window / tier / kaiCall)'
      });
    }
  }

  if (Array.isArray(args.targetTiers) && args.targetTiers.length) {
    for (const entry of allCandidates) {
      if (!entry.candidates || !entry.candidates.length) continue;
      entry.candidates = entry.candidates.filter((c) => {
        const liveTier = c.finalConfidenceTier || c.confidenceTierLive || c.confidenceTier || 'TIER 4';
        return args.targetTiers.includes(liveTier);
      });
    }
  }

  for (const entry of allCandidates) {
    if (!entry.candidates || !entry.candidates.length) continue;
    entry.candidates = sortRows(
      filterRowsByMinEV(
        filterRowsByMovement(filterRowsByKaiCall(entry.candidates, args.kaiCall), args.movement),
        args.minEV
      ),
      { sortBy: args.sortBy, sortDir: args.sortDir }
    );
  }

  if (args.onlyBets) {
    const floor = ['TIER 1', 'TIER 2', 'TIER 3'].indexOf(args.minFinalTier || 'TIER 1');
    for (const entry of allCandidates) {
      if (!entry.candidates || !entry.candidates.length) continue;
      entry.candidates = entry.candidates.filter((c) => {
        const tierIdx = ['TIER 1', 'TIER 2', 'TIER 3', 'TIER 4'].indexOf(
          c.finalConfidenceTier || c.confidenceTier || 'TIER 4'
        );
        return (
          c.finalVerdict === 'BET' &&
          c._validated === true &&
          c.validationSkipped !== true &&
          !c.validationBudgetExhausted &&
          !c.validationBudgetSkipped &&
          tierIdx <= floor
        );
      });
    }
  }

  const verbosity = String(args.verbosity || 'full').toLowerCase();
  if (args.hideVerdict && verbosity !== 'bets') {
    for (const entry of allCandidates) {
      if (!entry.candidates || !entry.candidates.length) continue;
      for (const c of entry.candidates) {
        stripVerdictFields(c);
      }
    }
  }
  return verbosity;
}

// ─── Phase: scoped player research ────────────────────────────────────────────

async function runQuickScreenResearch(ctx, allCandidates, { includeResearch, args, gameContextFn }) {
  const researchResults = [];
  if (!includeResearch) return researchResults;
  const researchLimit = Number.isFinite(Number(args.researchLimit))
    ? Math.max(1, Math.min(50, Number(args.researchLimit)))
    : 50;
  const researchBatch = buildFinalResearchBatch(allCandidates, researchLimit);
  if (researchBatch.length) {
    const researchOut = await runResearchOnTopRows({
      rows: researchBatch.map((r) => ({
        selection: r.player,
        league: r.league,
        game: r.game,
        start: r.start,
        market: r.market
      })),
      limit: researchBatch.length,
      playerContextFn: ctx.handlers.player_context,
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
  return researchResults;
}

// ─── Phase: topPick collapse ──────────────────────────────────────────────────

function applyQuickScreenTopPick(allCandidates, topPick) {
  if (!topPick) return;
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

// ─── Phase: assemble + format + cache + log ───────────────────────────────────

function buildScanHealth(allCandidates, client, { validationBudgetExhausted, validationPartial, validatedCount, requestedValidateTop, validationEligibleCount, validationSelectedCount }) {
  return {
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
      remainingBeforeValidation:
        typeof client.oddsHistoryBudgetRemaining === 'function' ? client.oddsHistoryBudgetRemaining() : null,
      ...(validationPartial ? { reason: 'validation budget selected fewer candidates than eligible BET candidates' } : {})
    },
    truncated: allCandidates.some((entry) => entry.scanHealth?.truncated),
    preHistoryShortlist: allCandidates
      .filter((entry) => entry.preHistoryShortlist)
      .flatMap((entry) => entry.preHistoryShortlist)
  };
}

function buildTierStats() {
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
}

function assembleQuickScreenResponse({
  allCandidates,
  unresolvedCandidates,
  emptySlate,
  watchCandidates,
  researchResults,
  targetBooks,
  leagues,
  markets,
  activeSlate,
  warnings,
  validationBudgetExhausted,
  validationPartial,
  requestedValidateTop,
  validationEligibleCount,
  validationSelectedCount,
  validateTop,
  validatedCount,
  cardWindow,
  cardWindowFallthrough,
  nextDayMerged,
  allAliasesUsed,
  args,
  lite,
  responseCache,
  responseCacheTtlMs,
  maybeGc,
  validateAll,
  client
}) {
  const bookList = targetBooks.length === 1 ? targetBooks[0] : targetBooks.join(', ');
  const validateAllActive = validateAll || requestedValidateTop > 0;
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
    ...(unresolvedCandidates.length ? { unresolvedCandidates } : {}),
    scanHealth: buildScanHealth(allCandidates, client, { validationBudgetExhausted, validationPartial, validatedCount, requestedValidateTop, validationEligibleCount, validationSelectedCount }),
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
    tierStats: buildTierStats(),
    _meta:
      validateAllActive
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

  const verbosity = String(args.verbosity || 'full').toLowerCase();
  let formattedResponse;
  if (verbosity === 'minimal') formattedResponse = formatQuickScreenMinimal(screenResponse);
  else if (verbosity === 'bets') formattedResponse = formatQuickScreenBets(screenResponse);
  else if (verbosity === 'standard') formattedResponse = formatQuickScreenStandard(screenResponse);
  else formattedResponse = screenResponse;

  if (lite && formattedResponse.ok) {
    stripLiteResponse(formattedResponse);
  }

  if (args._aggregateCacheKey && formattedResponse.ok) {
    let estimatedSizeBytes = 0;
    try {
      estimatedSizeBytes = JSON.stringify(formattedResponse).length;
    } catch {
      /* non-serializable — skip caching */
    }
    const aggregateResultCount = (formattedResponse.results || []).reduce(
      (sum, entry) => sum + (entry.count || (entry.candidates || []).length || (entry.plays || []).length || 0),
      0
    );
    if (aggregateResultCount > 0) {
      responseCache.set(args._aggregateCacheKey, formattedResponse, responseCacheTtlMs, estimatedSizeBytes);
    }
  }
  logLargeQuickScreenResponse(formattedResponse);
  maybeGc();
  return ok(formattedResponse);
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

async function runQuickScreen(deps, args = {}) {
  const { client, ctx, responseCache, responseCacheTtlMs, gameContextFn, maybeGc } = deps;

  clearTierCache();

  const plan = planAggregateScreen(args, { responseCache });
  if (plan.cachedResponse) {
    return plan.cachedResponse;
  }
  if (plan.aggregateCacheKey) {
    args._aggregateCacheKey = plan.aggregateCacheKey;
  }
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

  const { resolvedMarketsByLeague, allAliasesUsed } = resolveQuickScreenMarkets(
    leagues,
    markets,
    targetBooks,
    args.includeProps
  );

  const { allCandidates, unresolvedCandidates, emptySlate } = await runQuickScreenFanout(ctx, {
    targetBooks,
    leagues,
    resolvedMarketsByLeague,
    scanLimit,
    lookbackHours,
    debug,
    maxPerMarket,
    limit,
    args
  });

  const { cardWindowFallthrough, nextDayMerged } = applyQuickScreenCardWindow(
    allCandidates,
    emptySlate,
    String(args.cardWindow || 'today').trim().toLowerCase()
  );

  // Strip alternate-line candidates (resolveAlternateLines TIER 4 downgrades).
  for (const entry of allCandidates) {
    if (!entry.candidates || !entry.candidates.length) continue;
    entry.candidates = entry.candidates.filter((c) => !c.altLineFiltered);
  }

  const activeSlate = allCandidates
    .filter((r) => r.candidates && r.candidates.length > 0)
    .map((r) => ({ league: r.league, market: r.market, count: r.candidates.length, error: r.error || null }));

  const warnings = allCandidates.some((r) =>
    r.candidates?.some((c) => c.hoursUntilStart !== null && c.hoursUntilStart < 0)
  )
    ? ['Some games have already started. Live odds may be stale.']
    : [];

  const validateAll = args.validate === true;
  const requestedValidateTop =
    args.validate === false ? 0 : Number.isFinite(Number(args.validateTop)) ? Number(args.validateTop) : 10;

  const validation = await runQuickScreenValidation(client, ctx, allCandidates, {
    args,
    validateAll,
    requestedValidateTop,
    leagues
  });

  const verbosity = applyQuickScreenFilters(allCandidates, emptySlate, args);
  void verbosity;

  const researchResults = await runQuickScreenResearch(ctx, allCandidates, {
    includeResearch,
    args,
    gameContextFn
  });

  applyQuickScreenTopPick(allCandidates, topPick);

  return assembleQuickScreenResponse({
    allCandidates,
    unresolvedCandidates,
    emptySlate,
    watchCandidates: validation.watchCandidates,
    researchResults,
    targetBooks,
    leagues,
    markets,
    activeSlate,
    warnings,
    validationBudgetExhausted: validation.validationBudgetExhausted,
    validationPartial: validation.validationPartial,
    requestedValidateTop,
    validationEligibleCount: validation.validationEligibleCount,
    validationSelectedCount: validation.validationSelectedCount,
    validateTop: validation.validateTop,
    validatedCount: validation.validatedCount,
    cardWindow: String(args.cardWindow || 'today').trim().toLowerCase(),
    cardWindowFallthrough,
    nextDayMerged,
    allAliasesUsed,
    args,
    lite,
    responseCache,
    responseCacheTtlMs,
    maybeGc,
    validateAll,
    client,
    limit
  });
}

function createQuickScreenHandlers(client, ctx, factoryDeps) {
  const { responseCache, responseCacheTtlMs, gameContextFn, maybeGc } = factoryDeps;
  return {
    async quick_screen(args = {}) {
      return runQuickScreen(
        { client, ctx, responseCache, responseCacheTtlMs, gameContextFn, maybeGc },
        args
      );
    }
  };
}

module.exports = { createQuickScreenHandlers };
