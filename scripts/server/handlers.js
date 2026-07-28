'use strict';
/* eslint-disable max-lines */
/**
 * MCP tool handlers (extracted from scripts/propprofessor-mcp-server.js in v2.0.0).
 *
 * This file owns the 23 createMcpHandlers() tool implementations. The
 * createMcpServer() JSON-RPC frame stays in the parent file; this file
 * is a leaf that the parent re-exports for backward compatibility.
 *
 * No behavior change vs. v1.7.0 — this is a pure structural refactor.
 */

const { createHandlerContext } = require('./handler-context');
const { createHealthHandlers } = require('./handlers/health');
const { createMetaHandlers } = require('./handlers/meta');
const { createStateHandlers } = require('./handlers/state');
const { createPicksHandlers } = require('./handlers/picks');
const { createPricingHandlers } = require('./handlers/pricing');
const { createContextPluginsHandlers } = require('./handlers/context-plugins');
const { createDiscoveryHandlers } = require('./handlers/discovery');
const { createConsensusHandlers } = require('./handlers/consensus');
const { createCompositesHandlers } = require('./handlers/composites');
const { createTennisScreenHandler } = require('./handlers/tennis-screen');
const { createScreenHandlers } = require('./handlers/screen');
const { createPlayDetailsHandlers } = require('./handlers/play-details');
const { defined, resolveMarkets, buildPositiveEvTarget, stripVerdictFields } = require('./handlers/handler-utils');
const { ok } = require('../../lib/response-envelope');
const {
  createPropProfessorClient,
  getCookieExpiryInfo,
  isAuthValid,
  resolveAuthFile,
  readAuthState
} = require('../../lib/propprofessor-api');
const { normalizeTennisMarketQuery } = require('../../lib/screen-tennis');
const { rankLeagueScreenRows } = require('../../lib/screen-ranker');
const { extractScreenRows } = require('../../lib/screen-parser');
const {
  DEFAULT_LEAGUES,
  mapWithConcurrency,
  createCrossCallMemoizedQuery,
  canonicalizeScreenArgs,
  parseGameStartMs
} = require('../../lib/propprofessor-shared-utils');
const { getLocalTimezone, localDateKey } = require('../../lib/mcp-runtime-config');

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
const { getOddsHistoryCache, DEFAULT_ODDS_HISTORY_CACHE_TTL_MS } = require('../../lib/mcp-runtime-config');
const { buildUfcShortlist } = require('../../lib/propprofessor-sharp-plays');
const { findBestMatch } = require('../../lib/selection-matcher');
const { mapCandidateRow } = require('../../lib/propprofessor-mcp-candidate-mapper');
const {
  buildRankedScreenResponse: buildRankedScreenResponseShared,
  getIncludeAll,
  getLeagueRankingPreset,
  getLimit,
  getLookbackHours,
  getMaxAgeMs,
  normalizeBookList,
  normalizeSelectionKey,
  buildCanonicalPlayId,
  getDebugFlag
} = require('../../lib/propprofessor-mcp-ranked-screen');
const { getSharpBookComparisonSet, ALL_SCREEN_BOOKS, uniqueBooks } = require('../../lib/propprofessor-sharp-books');
const { resolveHistoryForEntity } = require('../../lib/propprofessor-history');
const { categorizeError } = require('../../lib/propprofessor-mcp-stdio');
const { computeMovementDisposition } = require('../../lib/propprofessor-movement-disposition');
const { reconcileValidateOverride } = require('../../lib/validate-reconcile');
const { runSharpPlays } = require('../../lib/propprofessor-sharp-plays-service');
const {
  analyzeMultiWindow,
  summarizeResults,
  DEFAULT_WINDOWS,
  DEFAULT_SHARP_BOOKS
} = require('../../lib/propprofessor-sharp-consensus');
const { getConfidenceTierStable, clearTierCache, suggestStakes } = require('../../lib/propprofessor-risk-score');
const { getMlbGameContext, findMlbGamePk } = require('../../lib/propprofessor-mlb-game-context');
const { getGameContext } = require('../../lib/propprofessor-game-context');
const { runResearchOnTopRows } = require('../../lib/propprofessor-research-runner');
const {
  formatRecommendedBetsMinimal,
  formatRecommendedBetsStandard,
  formatSharpPlaysMinimal,
  formatSharpPlaysStandard,
  formatScreenRankedMinimal,
  formatScreenRankedStandard,
  formatGetPlayDetailsMinimal,
  formatGetPlayDetailsStandard,
  formatQuickScreenMinimal,
  formatQuickScreenStandard,
  formatQuickScreenBets
} = require('../../lib/propprofessor-formatter');
const { filterRowsByKaiCall, filterRowsByMinEV, filterRowsByMovement } = require('../../lib/propprofessor-row-filter');
const { sortRows } = require('../../lib/propprofessor-sort-utils');
const {
  getPickHistory,
  getPickStats,
  getBacktestSummary,
  logPick,
  readCheckpoint,
  resolvePick,
  writeCheckpoint
} = require('../../lib/propprofessor-picks');
const { parseNaturalLanguagePropQuery } = require('../../lib/propprofessor-query-parser');

// Strip undefined values so they don't override API client defaults via spread

function createOddsHistoryMemoizedQuery(client) {
  // Cross-call LRU cache (shared process-wide, 5-min TTL). The previous
  // implementation used a per-call Map, which only deduped within a single
  // ev_candidates invocation. The shared cache absorbs "screen_ranked then
  // validate_play" / "validate_play then find_best_price" workflows that
  // re-fetch the same (gameId, selectionId, sportsbooks, startTimestamp).
  // Backed by createCrossCallMemoizedQuery which also provides an in-flight
  // mutex — N concurrent calls for the same key collapse to 1 network call.
  const cache = getOddsHistoryCache();
  const memoized = createCrossCallMemoizedQuery(
    (params) => {
      const sportsbooks = Array.isArray(params.sportsbooks)
        ? params.sportsbooks.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
      return client.queryOddsHistory({ ...params, sportsbooks });
    },
    {
      cache,
      keyFn: (params) =>
        JSON.stringify({
          gameId: params.gameId ?? null,
          selectionId: params.selectionId ?? null,
          sportsbooks: Array.isArray(params.sportsbooks)
            ? params.sportsbooks.map((value) => String(value || '').trim()).filter(Boolean)
            : [],
          startTimestamp: params.startTimestamp ?? null
        })
    }
  );
  return memoized;
}

async function validatePositiveEvCandidates({ client, candidates = [], args = {} } = {}) {
  const rows = Array.isArray(candidates) ? candidates.filter((play) => play && typeof play === 'object') : [];
  const requestedBooks = normalizeBookList(args.books);
  const limit = getLimit(args);
  const debug = getDebugFlag(args.debug, false);
  const lookbackHoursUsed = getLookbackHours(args);
  const maxAgeMs = getMaxAgeMs(args);
  const queryHistoryMemoized = createOddsHistoryMemoizedQuery(client);
  let failedValidationCount = 0;
  let historyFailureCount = 0;
  const validationWarnings = [];

  const enriched = await mapWithConcurrency(rows, async (play) => {
    const league = String(play.league || args.league || '').trim() || 'NBA';
    const market = String(play.market || args.market || '').trim() || 'Moneyline';
    const focusBook = String(play.book || '').trim();
    const sharpBooks = getSharpBookComparisonSet({
      league,
      market,
      requestedBooks: requestedBooks.length ? requestedBooks : undefined
    });
    const target = buildPositiveEvTarget(play);

    let history;
    let validationFailed = false;
    let validationError = null;
    try {
      history = await resolveHistoryForEntity({
        client,
        target,
        rows,
        lookbackHours: lookbackHoursUsed,
        preferredBook: focusBook || null,
        sharpBooks,
        historySportsbooks: sharpBooks,
        queryHistoryFn: queryHistoryMemoized
      });
    } catch (error) {
      validationFailed = true;
      validationError = error;
      failedValidationCount += 1;
      historyFailureCount += 1;
      history = {
        lineHistory: [],
        lineHistoryAvailable: false,
        lineHistorySource: null,
        historySportsbooksRequested: sharpBooks
      };
    }

    return {
      ...play,
      league,
      market,
      book: focusBook || play.book || play.sportsbook || '',
      participant: play.participant || target.participant,
      selection: play.selection || target.selection,
      pick: play.pick || target.pick,
      game: play.game || play.matchup || target.game,
      odds: play.odds,
      lineHistory: Array.isArray(history.lineHistory) ? history.lineHistory : [],
      lineHistoryAvailable: Boolean(history.lineHistoryAvailable),
      lineHistorySource: history.lineHistorySource || null,
      lineHistoryLookbackHours: lookbackHoursUsed,
      historySportsbooksRequested: Array.isArray(history.historySportsbooksRequested)
        ? history.historySportsbooksRequested
        : sharpBooks,
      normalizedSelectionId: history.normalizedSelectionId || target.selectionId || null,
      historyGameId: history.historyGameId || target.gameId || null,
      historyMatchedBy: history.historyMatchedBy || null,
      historyMatchKey: history.historyMatchKey || null,
      validationFailed,
      validationErrorMessage: validationFailed
        ? String(validationError?.message || validationError || 'Validation failed')
        : null
    };
  });

  const validatedRows = enriched.filter((row) => !row.validationFailed);
  const partiallyValidated = failedValidationCount > 0 && validatedRows.length > 0;
  const noRowsValidated = rows.length > 0 && validatedRows.length === 0;

  if (partiallyValidated) {
    validationWarnings.push(
      `${failedValidationCount} candidate validation lookup(s) failed; returning ${validatedRows.length} validated row(s).`
    );
  }

  if (noRowsValidated) {
    const error = new Error(
      `Positive EV validation failed for all ${rows.length} candidate(s); no validated results returned`
    );
    error.code = 'VALIDATION_INCOMPLETE';
    error.category = 'backend';
    error.status = 503;
    error.retryable = true;
    error.details = {
      candidateCount: rows.length,
      validatedCount: 0,
      failedValidationCount,
      historyFailureCount,
      lookbackHoursUsed
    };
    throw error;
  }

  const ranked = rankLeagueScreenRows(validatedRows, {
    league: args.league || validatedRows[0]?.league || 'NBA',
    market: args.market || validatedRows[0]?.market || 'Moneyline',
    limit,
    includeAll: getIncludeAll(args),
    maxAgeMs,
    books: requestedBooks.length ? requestedBooks : undefined,
    debug
  });

  return {
    ok: true,
    result: ranked,
    count: ranked.length,
    freshness: require('../../lib/screen-summary').summarizeFreshness(extractScreenRows(validatedRows), Date.now(), {
      maxAgeMs
    }),
    warnings: validationWarnings,
    resultMeta: {
      lookbackHoursUsed,
      debugEnabled: debug,
      source: 'positive_ev_candidates',
      candidateCount: rows.length,
      validatedCount: validatedRows.length,
      failedValidationCount,
      historyFailureCount,
      partialValidation: partiallyValidated
    }
  };
}

/**
 * Merge validate_play verdict data into a candidate/play object.
 * Used by both quick_screen and recommended_bets validateTop loops.
 * Sets validatedTier, validatedConsensusBookCount, validatedMovementDisposition,
 * validatedActionableSummary, validatedEdge, validatedClv, validatedGameContext, etc.
 */
function applyValidatedFields(target, validationResult) {
  const verdict = validationResult.verdictSummary;
  // play is null on lookup_failed (line gone / no longer priced). The `|| {}`
  // fallback below would make `!play` evaluate against an object (always
  // truthy), which is why unverified must key off the ORIGINAL null, not the
  // fallback object.
  const playPresent = Boolean(validationResult.play);
  const play = validationResult.play || {};
  const gameCtx = validationResult.gameContext || null;

  target.validatedTier = verdict.displayTier || target.displayTier;
  target.validatedVerdict = validationResult.verdict || null;
  // Real confidence tier (TIER 1/2/3/4) from the validate impl. The verdict's
  // displayTier is BET/CONSIDER/PASS (a different vocabulary) — do NOT confuse
  // it with a confidence tier. finalConfidenceTier must hold a TIER string.
  target.validatedConfidenceTier = validationResult.tier || verdict.displayTier || target.confidenceTier;
  // Lookup_failed (play===null) means the screen row could not be rehydrated
  // from the current feed — the requested line is gone or no longer priced.
  // Do NOT fall back to the screen's (now-stale) consensusBookCount, or agents
  // see a phantom "5 books" on a play that doesn't exist anymore. Mark it
  // 0 + unverified so the drift is visible instead of buried.
  target.validatedConsensusBookCount =
    playPresent && Number.isFinite(Number(play.consensusBookCount)) ? Number(play.consensusBookCount) : 0;
  target.validatedUnverified = !playPresent;
  // Thread consensus drift so applyFinalVerdict can downgrade a BET that
  // was built on a consensus that evaporated between screen and validate.
  target.validatedConsensusDrift = Boolean(validationResult.consensusDrift);
  target.validatedDriftReason = validationResult.driftReason || null;
  // Reconcile the validate re-derivation against the screen snapshot. The
  // validate path re-fetches and re-derives executionQuality + movementDisposition
  // a few seconds later; it must NOT silently override a clean screen signal
  // unless consensus actually drifted (a real, explainable change). See
  // lib/validate-reconcile.js.
  const reconcile = reconcileValidateOverride({
    screenExec: target.executionQuality,
    screenDisposition: target.movementDisposition,
    validateExec: play.executionQuality || target.executionQuality,
    validateDisposition: verdict.movementDisposition || target.movementDisposition,
    consensusDrift: Boolean(validationResult.consensusDrift)
  });
  target.validatedMovementDisposition = reconcile.movementDisposition;
  target.validatedExecQuality = reconcile.executionQuality;
  target.validatedReconcileOverridden = reconcile.overridden;
  target.validatedReconcileReason = reconcile.reason;
  target.validatedRiskFlags = verdict.riskFlags || [];
  target.validatedActionableSummary = verdict.actionableSummary || null;
  target.validatedConsensusSupport = verdict.consensusSupport || null;
  target.rationale = verdict.rationale || null;

  if (gameCtx) {
    target.validatedGameContext = gameCtx;
  }
  if (play) {
    target.validatedEdge = play.consensusEdge ?? target.edge;
    target.validatedClv = play.clvProxyPct ?? target.clv;
    target.validatedOdds = play.odds ?? target.odds;
  }
}

/**
 * Merge the raw screen tier and the validation verdict into ONE authoritative
 * bet/no-bet call (`finalVerdict`) so agents read a single field instead of
 * reconciling a screen BET against a validation PASS by hand.
 *
 * Resolution rule:
 *  - Prefer `validatedVerdict` (it reflects re-fetched consensus + movement).
 *  - Fall back to displayTier / kaiCall when validation didn't run.
 *  - Hard safety override: a validation hard-fail (movement adverse flag or
 *    bad execution quality) can NEVER be a BET — forced to PASS.
 * Also sets `finalConfidenceTier`, `priceDrift`, and `finalWarnings`.
 */
function applyFinalVerdict(target) {
  const validatedVerdict = target.validatedVerdict || null;
  // validatedTier / displayTier are BET/CONSIDER/PASS verdicts. The real
  // confidence tier (TIER 1/2/3/4) lives in validatedConfidenceTier.
  let validatedTier = target.validatedConfidenceTier || target.confidenceTier || 'TIER 4';
  let verdict = validatedVerdict || target.displayTier || target.kaiCall || 'PASS';

  // Alternate-line guard: these were downgraded by resolveAlternateLines
  // in the screen ranker. The validateTop re-grade can overwrite the tier,
  // but alternate lines must never surface as picks — one line per side.
  if (target.altLineFiltered) {
    verdict = 'PASS';
    validatedTier = 'TIER 4';
  }

  const riskFlags = target.validatedRiskFlags || [];
  // A 'bad' that was reconciled back to the screen signal (overridden, no
  // drift) is NOT a real execution failure — do not hard-PASS on it.
  const execBad = target.validatedExecQuality === 'bad' && target.validatedReconcileOverridden !== true;
  if ((riskFlags.includes('movement adverse') || execBad) && verdict === 'BET') {
    verdict = 'PASS';
  }

  // Consensus-drift / unverified downgrade: if the re-fetch collapsed the
  // screen's consensus (e.g. 5 books → 1) or couldn't re-find the line at
  // all, the pre-validation BET is no longer trustworthy. This mirrors the
  // guard inside runValidatePlayImpl (which already downgrades to CONSIDER
  // there) — applied again here so finalVerdict + the promoted display tier
  // can never ship a stale BET. Idempotent: CONSIDER/PASS are left alone.
  if ((target.validatedConsensusDrift || target.validatedUnverified) && verdict === 'BET') {
    verdict = 'CONSIDER';
  }

  // PASS verdicts always force TIER 4 — a play can't be 'high confidence
  // PASS' in PropProfessor's model. This must happen here (not only in
  // promoteFinalVerdictToDisplay) so that finalConfidenceTier is set
  // consistently with finalVerdict from the start.
  if (verdict === 'PASS') {
    validatedTier = 'TIER 4';
  }

  target.finalVerdict = verdict;
  target.finalConfidenceTier = validatedTier;

  const screenOdds = Number(target.odds);
  const valOdds = Number(target.validatedOdds);
  if (Number.isFinite(screenOdds) && Number.isFinite(valOdds)) {
    const drift = Math.abs(valOdds - screenOdds);
    target.priceDrift = drift;
    if (drift > 30) {
      target.finalWarnings = [...(target.finalWarnings || []), 'price-drift'];
    }
  } else {
    target.priceDrift = null;
  }

  if (target.validatedGameContext && target.validatedGameContext.riskFlag === 'unknown') {
    target.finalWarnings = [...(target.finalWarnings || []), 'unknown-game-context'];
  }
  if (!target._validated) {
    target.finalWarnings = [...(target.finalWarnings || []), 'validation-failed'];
  }
  if (target.validatedConsensusDrift) {
    target.finalWarnings = [...(target.finalWarnings || []), 'consensus-drift'];
  }
  if (target.validatedUnverified) {
    target.finalWarnings = [...(target.finalWarnings || []), 'unverified-line'];
  }
}

/**
 * Post-validation check: flag plays on the same game+market that contradict
 * each other (e.g. Over 173.5 BET alongside Under 179.5 BET for the same game). The system
 * evaluates each line independently, so a match with split market signals
 * can ship TIER 1 plays in opposite directions — which is noise, not
 * signal. This function picks the stronger side per game+market and
 * downgrades the weaker side to CONSIDER.
 *
 * Unlike the old implementation which only caught exact same-line
 * opposites (Over 179.5 vs Under 179.5), this version detects ANY
 * Over-vs-Under conflict regardless of line number.
 */
function flagContradictoryPlays(plays) {
  if (!Array.isArray(plays) || plays.length < 2) return;

  // Group by gameId+market
  const groups = {};
  for (const p of plays) {
    const key = `${p.gameId}||${p.market}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  }

  for (const key of Object.keys(groups)) {
    const group = groups[key];
    if (group.length < 2) continue;

    // Split into over and under buckets
    const overPlays = [];
    const underPlays = [];
    for (const p of group) {
      const sel = String(p.selection || '').toLowerCase();
      if (sel.startsWith('over')) overPlays.push(p);
      else if (sel.startsWith('under')) underPlays.push(p);
      // Non-total plays (ML/spread) don't have over/under, skip them
    }

    if (overPlays.length === 0 || underPlays.length === 0) continue;
    // Both sides are present — need to pick one

    // Score each side by movement quality
    function movementScore(play) {
      const m = String(play.movementDisposition || '');
      if (m === 'supportive_clean') return 3;
      if (m === 'supportive_bouncy') return 2;
      if (m === 'insufficient') return 1;
      return -1; // adverse_full or unknown
    }

    const overMovScore = overPlays.reduce((s, p) => s + movementScore(p), 0);
    const underMovScore = underPlays.reduce((s, p) => s + movementScore(p), 0);
    const overBestEdge = Math.max(...overPlays.map((p) => Number(p.edge || 0)));
    const underBestEdge = Math.max(...underPlays.map((p) => Number(p.edge || 0)));

    // Primary: side with more total movement score wins.
    // Tie-breaker: best edge.
    let weakerPlays, strongerPlays, detail;
    if (overMovScore > underMovScore) {
      weakerPlays = underPlays;
      strongerPlays = overPlays;
      detail = 'under-side';
    } else if (underMovScore > overMovScore) {
      weakerPlays = overPlays;
      strongerPlays = underPlays;
      detail = 'over-side';
    } else if (overBestEdge > underBestEdge) {
      weakerPlays = underPlays;
      strongerPlays = overPlays;
      detail = 'under-side (tie-broken by edge)';
    } else {
      weakerPlays = overPlays;
      strongerPlays = underPlays;
      detail = 'over-side (tie-broken by edge)';
    }

    // Downgrade all plays on the weaker side
    for (const w of weakerPlays) {
      w.finalWarnings = [...(w.finalWarnings || []), `contradictory-signal:${detail}`];
      if (w.finalVerdict === 'BET' || w.kaiCall === 'BET') {
        w.finalVerdict = 'CONSIDER';
        w.finalConfidenceTier = 'TIER 2';
        w.displayTier = 'CONSIDER';
        w.kaiCall = 'CONSIDER';
      }
    }

    // Contradictory Over/Under = market hasn't settled. Downgrade the stronger
    // side ONLY if the weaker side also shows supportive movement. If the weaker
    // side is adverse, the market IS picking a direction — let the stronger side
    // keep its tier. Both supportive = noise. One supportive + one adverse = signal.
    const weakerAllSupportive = weakerPlays.every((p) => {
      const m = String(p.movementDisposition || p.movement || '').toLowerCase();
      return m.includes('supportive');
    });

    for (const s of strongerPlays) {
      s.finalWarnings = [...(s.finalWarnings || []), `contradictory-signal:opposing:${detail}`];
      if (weakerAllSupportive && (s.finalVerdict === 'BET' || s.kaiCall === 'BET')) {
        s.finalVerdict = 'CONSIDER';
        s.finalConfidenceTier = 'TIER 2';
        s.displayTier = 'CONSIDER';
        s.kaiCall = 'CONSIDER';
      }
    }
  }
}

/**
 * Promote the authoritative merged verdict (finalVerdict / finalConfidenceTier)
 * into the agent-facing display fields (displayTier, confidenceTier, kaiCall)
 * so consumers that read the PRIMARY fields — not the buried finalVerdict —
 * see the validated call. Without this, an adverse-movement play ships as
 * displayTier BET because the screen's snapshot always won, and the tier
 * filters (targetTiers) keyed off confidenceTier, so PASS-level validated
 * plays leaked through as TIER 1 BETs.
 *
 * Only promotes when validation actually ran (_validated) and produced a
 * finalVerdict. If validation didn't run, the screen snapshot stands.
 */
function promoteFinalVerdictToDisplay(target) {
  if (!target._validated) return;
  if (!target.finalVerdict) return;
  // finalVerdict is the single authoritative bet/no-bet call.
  target.displayTier = target.finalVerdict;
  target.kaiCall = target.finalVerdict;
  if (target.finalConfidenceTier) {
    target.confidenceTier = target.finalConfidenceTier;
  }
  // GUARD: a PASS verdict always forces TIER 4 regardless of any
  // stale TIER 1/2/3 that may have leaked from the screen snapshot.
  // Without this, promoteFinalVerdictToDisplay would ship TIER 1 + PASS
  // (structurally impossible per gradeRiskToTierAndCall's contract).
  if (target.finalVerdict === 'PASS') {
    target.confidenceTier = 'TIER 4';
  }
  // Add quick summary for agent decision-making
  const odds = target.odds ? ` at ${target.odds}` : '';
  const selection = target.selection || target.participant || target.pick || '';
  target.summary = `${target.finalVerdict} ${selection}${odds}`.trim();
}

/**
 * Strip heavy post-validation fields from the quick_screen response when
 * lite=true. The lite 'fields' array only controls screen_ranked output;
 * validatedGameContext, redundant validatedEdge/Clv/Odds, and the separate
 * research array are appended after that pass and balloon the payload even
 * in lite mode (4 leagues × 19 candidates = ~118K chars, truncated).
 *
 * This function collapses research into the candidate rows directly and
 * drops objects that duplicate what validatedActionableSummary already says.
 */
function stripLiteResponse(response) {
  // 1. Collapse research into candidates: look up each row's risk info
  //    and attach it inline, then drop the separate research array.
  const researchByGame = new Map();
  for (const r of response.research || []) {
    if (r.player && r.game) {
      researchByGame.set(`${r.game}:${r.player.toLowerCase()}`, r);
    }
  }
  for (const entry of response.results || []) {
    for (const c of entry.candidates || []) {
      const player = (c.selection || '').toLowerCase();
      const game = c.game || '';
      const key = `${game}:${player}`;
      const research = researchByGame.get(key);
      if (research) {
        c.riskFlag = research.riskFlag || c.riskFlag || null;
        c.riskSummary = research.riskSummary || c.riskSummary || null;
      }
      // Strip heavy validated bloat — actionableSummary already captures the signal.
      delete c.validatedGameContext;
      delete c.validatedEdge;
      delete c.validatedClv;
      delete c.validatedOdds;
      delete c.priceDrift;
      delete c.finalWarnings;
      delete c.screenUrl;
      delete c.rationale;
      // validatedConsensusSupport is a free-text string, keep it (small).
      // validatedUnverified, validatedConsensusDrift, validatedDriftReason:
      // keep them — they're compact flags the agent needs.
    }
  }
  // 2. Drop the separate research array (now inlined on candidates).
  response.research = undefined;
  // 3. Trim activeSlate to per-league summaries instead of per-market entries.
  if (Array.isArray(response.activeSlate)) {
    const leagueCounts = {};
    for (const s of response.activeSlate) {
      leagueCounts[s.league] = (leagueCounts[s.league] || 0) + (s.count || 0);
    }
    response.activeSlate = Object.entries(leagueCounts).map(([league, count]) => ({
      league,
      count
    }));
  }
  return response;
}

/**
 * Hint the JS engine that now is a good time to run GC.
 */
function createMcpHandlers({ client = createPropProfessorClient() } = {}) {
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

  // ─── Screen implementations (used by both the cache-wrapped handlers and
  // direct callers like recommended_bets → handlers.screen_ranked). ───

  async function runScreenRankedImpl(client, args = {}) {
    const requestedBooks = normalizeBookList(args.books);
    const league = args.league || 'NBA';
    const marketResolution = resolveMarkets(args, league);
    const market = marketResolution.single;
    // focusBook: only set if the user explicitly asked for one. Defaulting to
    // preset.preferredBooks[0] (Pinnacle for most leagues) breaks UFC/Soccer
    // because Pinnacle doesn't post those moneylines — the focusPlays filter
    // in extractScreenRows would then drop every row.
    // Fix shipped 2026-06-14: the screen_ranked handler used to default the
    // focus book to the preset's preferred book, which worked for NBA/NFL/MLB
    // but eliminated every UFC row. Now we only set focusBook when the user
    // explicitly passed books, leaving focusPlays empty (= expand to all
    // books in the payload) otherwise.
    const focusBook = requestedBooks.length ? requestedBooks[0] : '';
    // Auto-augment the backend query with the league's sharp-book set so
    // consensus data populates. The user-requested book (e.g. Fliff) typically
    // is NOT a sharp book, so without augmentation the backend returns just
    // that one book and consensusBookCount=0 on every row. The ranker needs
    // at least 2-3 comp books in allBookOdds to compute consensusEdge.
    // Audit 2026-06-15: this augmentation was present in runLeagueScreen
    // (used by sharp_plays) but missing from screen_ranked. Symptom: every
    // screen_ranked call on a single non-sharp book returned consBk=0.
    const sharpBookSet = getSharpBookComparisonSet({ league, market });
    // Non-major leagues (Tennis, Soccer, UFC, WNBA, etc.) need
    // ALL_SCREEN_BOOKS for the backend to return multi-book data.
    // The default sharp-book set (5 books) is too narrow — the backend
    // only populates full odds maps when the complete list is sent.
    // Matches the same non-major logic in queryScreenOddsBestComps
    // (lib/propprofessor-api.js:511-515).
    const leagueUpper = (league || '').toUpperCase();
    const augmentedBooks = !['NBA', 'NFL', 'MLB'].includes(leagueUpper)
      ? ALL_SCREEN_BOOKS
      : uniqueBooks([...requestedBooks, ...sharpBookSet]);
    const payload = await client.queryScreenOddsBestComps({
      market,
      league,
      games: Array.isArray(args.games) ? args.games : [],
      participants: Array.isArray(args.participants) ? args.participants : [],
      books: augmentedBooks,
      is_live: false
    });
    const response = await buildRankedScreenResponseShared({
      client,
      payloads: [payload],
      args: { ...args, historySportsbooks: augmentedBooks },
      league,
      focusBook,
      rankRows: (hydratedRows, { debug } = {}) =>
        rankLeagueScreenRows(hydratedRows, {
          league,
          market,
          limit: getLimit(args),
          books: requestedBooks.length ? requestedBooks : undefined,
          includeAll: getIncludeAll(args),
          maxAgeMs: getMaxAgeMs(args),
          debug,
          requirePreferredBook: requestedBooks.length > 0,
          playableOnly: args.playableOnly === true
        })
    });
    if (marketResolution.aliasesUsed.length) {
      response.resultMeta = {
        ...response.resultMeta,
        markets_alias_used: marketResolution.aliasesUsed
      };
    }
    // Pre-flight player research (v2.1.8): when includeResearch=true, run
    // player_context on the top N ranked rows so the response includes
    // injury/risk flags alongside the ranked plays.
    if (args.includeResearch === true && Array.isArray(response.result) && response.result.length) {
      const researchLimit = Number.isFinite(Number(args.researchLimit))
        ? Math.max(1, Math.min(50, Number(args.researchLimit)))
        : 10;
      const research = await runResearchOnTopRows({
        rows: response.result,
        limit: researchLimit,
        playerContextFn: handlers.player_context,
        gameContextFn: (opts) =>
          getGameContext({
            sport: opts.sport || opts.league,
            selection: opts.selection,
            game: opts.game,
            start: opts.start,
            market: opts.market
          })
      });
      response.research = research.results;
      response.resultMeta = {
        ...response.resultMeta,
        researchRunCount: research.results.length,
        researchPlayerContextCount: research.results.filter((r) => r.contextType === 'player').length,
        researchGameContextCount: research.results.filter((r) => r.contextType === 'game').length,
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
    // Apply before verbosity formatting so the formatter sees the final shape.
    // Both are no-ops when the params are missing.
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

    const verbosity = String(args.verbosity || 'full').toLowerCase();
    if (verbosity === 'minimal') return formatScreenRankedMinimal(response);
    if (verbosity === 'standard') return formatScreenRankedStandard(response);
    return response;
  }

  // ─── Play Detail & Validation Implementations ───────────────────────────

  async function runGetPlayDetailsImpl(client, args = {}) {
    const league = String(args.league || '').trim();
    const rawGameIds = Array.isArray(args.gameIds) ? args.gameIds : [];
    // Sanitize: trim, drop empties, dedupe. Stale/closed/malformed game IDs
    // (e.g. non-numeric timestamps) used to crash the per-row enrichment
    // path with "Cannot read properties of undefined (reading 'filter')".
    // Clean them here so the downstream pipeline only sees well-formed IDs.
    const gameIds = Array.from(new Set(rawGameIds.map((id) => String(id == null ? '' : id).trim()).filter(Boolean)));
    if (!league || !gameIds.length) {
      const error = new Error('league and gameIds are required.');
      error.code = 'MISSING_PARAMS';
      error.category = 'validation';
      error.status = 400;
      throw error;
    }
    // When no market is requested, fan out across the league's default
    // markets (Moneyline/Spread/Total, or soccer variants) and merge — so
    // the agent gets every market line for a game (incl. the sharp Total
    // the website's +EV feed hides) in one call instead of N.
    if (!args.market) {
      const markets = getDefaultMarketsForLeague(league);
      const perMarket = await Promise.all(markets.map((m) => runGetPlayDetailsImpl(client, { ...args, market: m })));
      const combined = [];
      const metaList = [];
      let firstError = null;
      for (const r of perMarket) {
        if (r && Array.isArray(r.result)) combined.push(...r.result);
        if (r && r.resultMeta) {
          metaList.push(r.resultMeta);
          // Propagate a per-market query failure so callers (and tests)
          // see SCREEN_QUERY_FAILED instead of a silent empty merge.
          if (r.resultMeta.errorCode && !firstError) {
            firstError = { errorCode: r.resultMeta.errorCode, error: r.resultMeta.error };
          }
        }
      }
      const merged = {
        ok: true,
        result: combined,
        resultMeta: {
          queryGameIds: gameIds,
          matchedRows: combined.length,
          marketsQueried: markets,
          perMarket: metaList,
          ...(firstError || {})
        }
      };
      const verbosity = String(args.verbosity || 'full').toLowerCase();
      if (verbosity === 'minimal') return formatGetPlayDetailsMinimal(merged);
      if (verbosity === 'standard') return formatGetPlayDetailsStandard(merged);
      return merged;
    }
    const marketResolution = resolveMarkets(args, league);
    let market = marketResolution.single;
    const requestedBooks = normalizeBookList(args.books);
    // BUGFIX (2026-06-22): Tennis market normalization in get_play_details.
    // The Tennis screen handler normalizes generic markets ("Spread", "Total")
    // into specific backend market names (Game Handicap, Set Handicap, Total
    // Games, etc.) via normalizeTennisMarketQuery. But get_play_details
    // bypassed this and passed the raw "Spread"/"Total" string directly to
    // queryScreenOddsBestComps — which has no rows for those names, causing
    // validate_play to always FAIL with "no row matched selection" on Tennis
    // spread/total plays. Apply the same normalization here.
    if (league === 'Tennis') {
      const tennisMarkets = normalizeTennisMarketQuery(market);
      market = tennisMarkets[0] || market;
    }
    // BUGFIX: don't default focusBook to the preset's preferred book
    // (Pinnacle for most leagues). Pinnacle doesn't post UFC/Tennis/Soccer
    // moneylines, so focusPlays in extractScreenRows would drop every row
    // whose odds don't include Pinnacle — which is most non-NA-sports rows.
    // Only set focusBook when the user explicitly passed books. Same fix
    // as runScreenRankedImpl (shipped 2026-06-14).
    const focusBook = requestedBooks.length ? requestedBooks[0] : '';

    // Auto-augment the backend query with the league's sharp-book set so
    // consensus data populates. Same logic as runScreenRankedImpl.
    const sharpBookSetDetail = getSharpBookComparisonSet({ league, market });
    const leagueUpperDetail = (league || '').toUpperCase();
    const augmentedBooks = !['NBA', 'NFL', 'MLB'].includes(leagueUpperDetail)
      ? ALL_SCREEN_BOOKS
      : uniqueBooks([...requestedBooks, ...sharpBookSetDetail]);

    // excludeBooks lets the agent mirror the website's account Settings
    // (Hide Offshore Books / Hide Sweepstakes / per-book hides) so MCP odds
    // match what the user sees. Off by default — pass the account's hidden
    // book set to filter them out before the backend query + ranking.
    const excludeSet = new Set(normalizeBookList(args.excludeBooks).map((b) => b.toLowerCase()));
    const applyExcludes = (list) =>
      excludeSet.size ? list.filter((b) => !excludeSet.has(String(b).toLowerCase())) : list;
    const augmentedBooksExcluded = applyExcludes(augmentedBooks);

    // Fetch full screen data (with history hydration — this is the detailed view)
    let payload;
    try {
      payload = await client.queryScreenOddsBestComps({
        market,
        league,
        games: gameIds,
        participants: Array.isArray(args.participants) ? args.participants : [],
        books: augmentedBooksExcluded,
        is_live: Boolean(args.live || args.is_live)
      });
    } catch (err) {
      return {
        ok: true,
        result: [],
        resultMeta: {
          queryGameIds: gameIds,
          matchedRows: 0,
          error: err?.message || String(err),
          errorCode: 'SCREEN_QUERY_FAILED'
        }
      };
    }
    let response;
    try {
      // BUGFIX (regression pitfall #48): the previous code omitted the
      // `await` here, so `response` was a Promise and the subsequent
      // `response.result.filter(...)` crashed with
      // "Cannot read properties of undefined (reading 'filter')".
      response = await buildRankedScreenResponseShared({
        client,
        payloads: [payload],
        args: { ...args, compact: false, skipHistory: false, historySportsbooks: augmentedBooksExcluded },
        league,
        focusBook,
        rankRows: (hydratedRows, { debug } = {}) =>
          rankLeagueScreenRows(hydratedRows, {
            league,
            market,
            limit: gameIds.length * 4,
            books: augmentedBooks,
            includeAll: true,
            debug
          })
      });
    } catch (err) {
      return {
        ok: true,
        result: [],
        resultMeta: {
          queryGameIds: gameIds,
          matchedRows: 0,
          error: err?.message || String(err),
          errorCode: 'RANK_PIPELINE_FAILED'
        }
      };
    }

    // Add market alias info to resultMeta if any aliases were used
    if (marketResolution.aliasesUsed.length) {
      response.resultMeta = {
        ...response.resultMeta,
        markets_alias_used: marketResolution.aliasesUsed
      };
    }

    // Normalize gameIds by stripping trailing unix timestamp suffix.
    // The upstream screen endpoint sometimes returns gameIds with a
    // timestamp segment (e.g. "Tennis:PREMATCH:Jovic:Pegula:1783252800")
    // and sometimes without. If the two API calls disagree on format,
    // strict Set.has() comparison would return zero matching rows.
    const normalizeGameId = (id) =>
      String(id || '')
        .replace(/:\d{10,}$/, '')
        .trim();
    const normalizedRequested = gameIds.map(normalizeGameId);
    const gameIdSet = new Set(normalizedRequested);
    const safeResult = Array.isArray(response.result) ? response.result : [];
    const filtered = safeResult.filter((row) => gameIdSet.has(normalizeGameId(row && row.gameId)));
    // BUGFIX (2026-06-21): when the ranker's preferred book (Pinnacle for most
    // leagues) has no odds for a match — e.g. Pinnacle doesn't post UFC/Tennis
    // moneylines — all rows land in `focusBookMissingRows` instead of `result`.
    // Merge those back in so that get_play_details and validate_play actually
    // return a row for the requested gameId.
    const fallbackRows = Array.isArray(response.focusBookMissingRows) ? response.focusBookMissingRows : [];
    const merged = [...filtered];
    for (const fbRow of fallbackRows) {
      if (gameIdSet.has(normalizeGameId(fbRow && fbRow.gameId))) {
        // Set the focusBookMissing flag so callers know this is a fallback row
        merged.push({ ...fbRow, __focusBookMissing: true });
      }
    }
    response.result = merged;
    // Enrich each row with a flat per-book odds matrix (book → odds) so the
    // agent can report "best is NoVig +125, but DK is +118" like the +EV
    // card's per-book view. Derived from sportsbookData (hydrated) or the
    // raw selections[].odds map (pre-hydration), whichever is present.
    for (const row of response.result) {
      const matrix = {};
      const sb = Array.isArray(row?.sportsbookData) ? row.sportsbookData : [];
      for (const entry of sb) {
        const book = String(entry?.book || '').trim();
        const odds = Number(entry?.odds ?? entry?.noVigOdds);
        if (book && Number.isFinite(odds)) matrix[book] = odds;
      }
      // Fallback: selections[line].odds is a { book: {odds1,odds2} } map.
      const selections = row?.selections && typeof row.selections === 'object' ? row.selections : {};
      for (const sel of Object.values(selections)) {
        const oddsMap = sel?.odds && typeof sel.odds === 'object' ? sel.odds : {};
        for (const [book, v] of Object.entries(oddsMap)) {
          if (!matrix[book] && Number.isFinite(Number(v?.odds1 ?? v))) {
            matrix[book] = Number(v.odds1 ?? v);
          }
        }
      }
      if (Object.keys(matrix).length) row.oddsMatrix = matrix;
    }
    // Stamp sharpBookMovementConfirmed on detail rows so validate_play
    // re-derivations don't lose the sharp-book signal and downgrade
    // movementDisposition to 'insufficient'. The detail query already
    // includes the league's sharp books (line ~884); if the consensus
    // movement label is supportive, the sharp books are onside.
    for (const row of response.result) {
      if (row.sharpBookMovementConfirmed) continue;
      const label = String(row.movementLabel || '').toLowerCase();
      if (label === 'supportive') {
        // Check that a sharp book actually has odds for this row.
        // SportsbookData carries hydrated per-book entries.
        const sb = Array.isArray(row?.sportsbookData) ? row.sportsbookData : [];
        const sharpBookNames = new Set(sharpBookSetDetail.map((b) => b.toLowerCase()));
        const hasSharpBookOdds = sb.some((entry) => sharpBookNames.has(String(entry?.book || '').toLowerCase()));
        if (hasSharpBookOdds) {
          row.sharpBookMovementConfirmed = true;
          // Find the first sharp book with odds as the source.
          const sourceEntry = sb.find((entry) => sharpBookNames.has(String(entry?.book || '').toLowerCase()));
          row.sharpBookMovementSource = sourceEntry?.book || sharpBookSetDetail[0] || null;
        }
      }
    }
    // Drop the non-enumerable focusBookMissingRows from the response —
    // they've been merged into result.
    response.focusBookMissingRows = undefined;
    response.resultMeta = {
      ...response.resultMeta,
      queryGameIds: gameIds,
      matchedRows: merged.length
    };
    // Apply verbosity formatting (adds summary mode for agents that just
    // need a quick overview of game details without 700KB+ of line history)
    const verbosity = String(args.verbosity || 'full').toLowerCase();
    if (verbosity === 'minimal') return formatGetPlayDetailsMinimal(response);
    if (verbosity === 'standard') return formatGetPlayDetailsStandard(response);
    return response;
  }

  // eslint-disable-next-line complexity
  async function runValidatePlayImpl(client, args = {}) {
    const league = String(args.league || '').trim();
    const gameId = String(args.gameId || '').trim();
    const selection = String(args.selection || '').trim();
    const requestedPlayId = String(args.playId || '').trim();
    if (!league) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'league is required' } };
    }
    if (!gameId) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'gameId is required' } };
    }
    if (!selection && !requestedPlayId) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'selection or playId is required' } };
    }
    const market = String(args.market || 'Moneyline').trim() || 'Moneyline';
    const books = normalizeBookList(args.books);
    const lookbackHours = Number.isFinite(Number(args.lookbackHours)) ? Number(args.lookbackHours) : 6;
    const skipResearch = args.skipResearch === true;
    const skipGameContext = args.skipGameContext === true;

    // Steps 1 + 2 in parallel: re-fetch the screen for this game AND run
    // player_context research concurrently. The two calls are independent —
    // research only needs the selection name + league, not the detail row —
    // so serializing them doubled wall-clock latency for no reason. We
    // resolve detail first so we can pass `gameTime` to research without a
    // second round-trip; in practice this is still 30-40% faster than the
    // previous all-serial path on the typical validate_play invocation.
    const detailPromise = (async () => {
      try {
        return {
          ok: true,
          value: await runGetPlayDetailsImpl(client, {
            league,
            market,
            gameIds: [gameId],
            books: books.length ? books : undefined,
            lookbackHours
          })
        };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    })();
    const researchPromise = skipResearch
      ? Promise.resolve(null)
      : (async () => {
          try {
            return {
              ok: true,
              value: await handlers.player_context({
                player: selection,
                sport: league
              })
            };
          } catch (err) {
            return { ok: false, error: err?.message || String(err) };
          }
        })();

    // MLB game-level context (pitcher, weather, park, lineup). Only runs
    // for league=MLB. The screen gameId is the format
    // "MLB:PREMATCH:<homeSlug>:<awaySlug>:<unixStart>" — note the
    // <home>:<away> order, not the more intuitive away-first. The last
    // segment is a Unix timestamp, NOT the MLB gamePk. We resolve the
    // real gamePk via the schedule endpoint using the homeSlug + awaySlug
    // + the start date derived from the Unix timestamp. The lookup is
    // best-effort: if the schedule fetch fails or no match is found,
    // gameContext stays null and the verdict is unaffected. Skipped on
    // skipResearch to honor that opt-out.
    const isMlb = league.toUpperCase() === 'MLB';
    // The screen gameId encodes the matchup; parse it to seed the lookup.
    const gameIdParts = isMlb && gameId ? gameId.split(':') : [];
    // Convention: index 2 = HOME slug, index 3 = AWAY slug.
    const seedHomeTeam = gameIdParts[2] ? gameIdParts[2].replace(/_/g, ' ') : '';
    const seedAwayTeam = gameIdParts[3] ? gameIdParts[3].replace(/_/g, ' ') : '';
    // Start date is the date of the Unix timestamp (last segment).
    const seedStartDate =
      gameIdParts[4] && /^\d{10}$/.test(gameIdParts[4])
        ? new Date(Number(gameIdParts[4]) * 1000).toISOString().slice(0, 10)
        : '';
    const gameContextPromise = skipGameContext
      ? Promise.resolve(null)
      : isMlb
        ? (async () => {
            try {
              if (!seedAwayTeam || !seedHomeTeam || !seedStartDate) {
                return { ok: false, error: 'missing MLB matchup data for game context' };
              }
              const attemptedLookup = {
                isoDate: seedStartDate,
                awayTeam: seedAwayTeam,
                homeTeam: seedHomeTeam,
                unixStart: gameIdParts[4] && /^\d{10}$/.test(gameIdParts[4]) ? Number(gameIdParts[4]) : undefined
              };
              const gamePk = await findMlbGamePk(attemptedLookup);
              if (!gamePk) {
                return {
                  ok: false,
                  error: {
                    errorType: 'schedule_not_found',
                    errorDetail: 'no MLB gamePk found for matchup',
                    attemptedLookup
                  }
                };
              }
              return { ok: true, value: await getMlbGameContext({ gamePk }) };
            } catch (err) {
              return { ok: false, error: err?.message || String(err) };
            }
          })()
        : (async () => {
            try {
              // Non-MLB: run sport-agnostic game context via dispatcher.
              // For Tennis, parse the gameId to extract the unix start
              // (Tennis:PREMATCH:p1:p2:unixStart) so the resolver can
              // map a matchup string ("Dart vs Sonmez") to a real
              // tourney via the 2026 weekly schedule.
              let derivedStart = null;
              let tennisGameStr = gameId;
              if (league.toLowerCase() === 'tennis' && gameId) {
                const parts = gameId.split(':');
                const ts = parts[parts.length - 1];
                if (ts && /^\d{10}$/.test(ts)) {
                  derivedStart = new Date(Number(ts) * 1000).toISOString();
                }
                // Build "player1 vs player2" from the gameId so parseGameString
                // can extract player names (it splits on "vs"/"@"/"at", not colons).
                // Format: Tennis:PREMATCH:player1:player2:unixTimestamp
                const p1 = (parts[2] || '').trim();
                const p2 = (parts[3] || '').trim();
                if (p1 && p2) {
                  tennisGameStr = `${p1} vs ${p2}`;
                }
              }
              const ctx = await getGameContext({
                sport: league,
                selection,
                game: tennisGameStr,
                start: derivedStart
              });
              return { ok: true, value: ctx };
            } catch (err) {
              return { ok: false, error: err?.message || String(err) };
            }
          })();

    const [detailOutcome, researchOutcome, gameContextOutcome] = await Promise.all([
      detailPromise,
      researchPromise,
      gameContextPromise
    ]);
    const detailResult = detailOutcome?.ok ? detailOutcome.value : null;
    const detailError = detailOutcome?.ok ? null : detailOutcome.error;
    const gameContext = gameContextOutcome?.ok ? gameContextOutcome.value : null;
    const gameContextError = gameContextOutcome?.ok ? null : gameContextOutcome?.error || null;

    // Extract the specific row that matches the selection.
    // The screen's `selection` field for spread/total plays concatenates the
    // line (e.g. "Harris -1.5", "Over 22.5", "Under 2.5 sets"), but
    // get_play_details stores them as `participant: "Harris"` with the line
    // in a separate `line` field. To match both shapes:
    //   1. Try exact match (moneyline case).
    //   2. Strip trailing line digits and re-try (spread case).
    //   3. Strip "Over "/"Under " prefix and re-try (total case).
    //   4. Fall back to home/away includes.
    const detailRows = Array.isArray(detailResult?.result) ? detailResult.result : [];
    const matchingRow = findBestMatch(detailRows, selection, requestedPlayId, books[0] || '');

    // If research was started before we had the row, re-run it with
    // gameTime now that we know the start. Skip the round-trip when the
    // gameTime is already present in the result.
    let research = researchOutcome?.ok ? researchOutcome.value : null;
    const researchError = researchOutcome?.ok ? null : researchOutcome?.error || null;
    if (research && !research.gameTime && matchingRow?.start) {
      research = { ...research, gameTime: matchingRow.start };
    }

    // Step 3: compute the verdict.
    // We classify the play using the same signals the ranker uses,
    // then layer on the risk-flag downgrade from research.
    let verdict = 'PASS';
    const reasons = [];
    const screenTier = args.screenTier || (matchingRow && matchingRow.screenTier);
    const screenKaiCall = args.screenKaiCall || (matchingRow && matchingRow.screenKaiCall);
    // Prefer the agent's already-returned tier for consistency, unless research/exec downgrades.
    // Fallback chain: screenTier → confidenceTier → kaiCall→tier mapping → 'TIER 4'
    let tier = screenTier || matchingRow?.confidenceTier || null;
    if (!tier) {
      const kaiCall = screenKaiCall || matchingRow?.kaiCall;
      if (kaiCall === 'BET') tier = 'TIER 1';
      else if (kaiCall === 'CONSIDER') tier = 'TIER 2';
      else tier = 'TIER 4';
    }
    let lookupStatus = 'resolved';
    let reasonType = 'signal';

    // Consensus drift detection: compare the agent's snapshot against the re-fetched row.
    // Drift is only meaningful when the consensus materially collapses — a 15→12 book
    // swing is normal market noise, not a reason to downgrade. Use relative threshold:
    // must lose >25% of books AND at least 4 books absolute to qualify as drift.
    // This prevents the validateTop path from producing false PASSes that the standalone
    // validate_play (which doesn't pass screenConsensusBookCount) never would.
    let consensusDrift = false;
    let driftReason = null;
    if (matchingRow) {
      const screenCbk = Number(args.screenConsensusBookCount);
      const screenExec = String(args.screenExecutionQuality || '');
      const currentCbk = Number(matchingRow.consensusBookCount || 0);
      const currentExec = String(matchingRow.executionQuality || '');

      if (Number.isFinite(screenCbk) && screenCbk > 0) {
        const absDrop = screenCbk - currentCbk;
        const pctDrop = screenCbk > 0 ? absDrop / screenCbk : 0;
        // Only flag drift when the book count meaningfully collapsed:
        // lost at least 4 books AND lost more than 25% of the screen consensus.
        if (absDrop >= 4 && pctDrop > 0.25) {
          consensusDrift = true;
          driftReason = `consensus collapsed (${screenCbk} → ${currentCbk} books)`;
        }
      }
      if (
        !consensusDrift &&
        screenExec &&
        screenExec !== 'unknown' &&
        screenExec !== currentExec &&
        currentExec === 'bad'
      ) {
        consensusDrift = true;
        driftReason = 'execution quality changed';
      }
    }

    if (matchingRow) {
      // Base quality from the existing ranker output.
      if (tier === 'TIER 1') {
        verdict = 'BET';
      } else if (tier === 'TIER 2' || tier === 'TIER 3') {
        verdict = 'CONSIDER';
      } else {
        verdict = 'PASS';
        reasons.push('TIER 4 (no signal)');
      }

      // Consensus-drift guard: the screen snapshot showed broad agreement
      // (e.g. 5 books) but the re-fetch collapsed to a thin/none consensus
      // (e.g. 1 book). That is NOT noise — it means the line either lost
      // cross-book support or moved off the requested number between the
      // screen and validation. A BET built on a phantom 5-book consensus is
      // a lie, so downgrade to CONSIDER and flag it. Without this, the
      // surveyor ships TIER 1 BETs whose real support evaporated.
      if (consensusDrift && verdict === 'BET') {
        verdict = 'CONSIDER';
        reasons.push(`consensus drift: ${driftReason} (re-fetch disagrees with screen snapshot)`);
      }

      // Execution quality on the requested book.
      const exec = String(matchingRow.executionQuality || '');
      if (exec === 'bad') {
        verdict = 'PASS';
        reasons.push('execution quality is "bad" on the requested book');
      } else if (exec === 'playable') {
        reasons.push('execution quality is "playable" (within 10¢ of best)');
      } else if (exec === 'best') {
        reasons.push('execution quality is "best" (top of market)');
      } else {
        reasons.push(`execution quality is "${exec || 'unknown'}"`);
      }

      // Consensus/movement support.
      const cbk = Number(matchingRow.consensusBookCount || 0);
      if (cbk >= 3) reasons.push(`consensus: ${cbk} comp books agree`);
      else if (cbk >= 1) reasons.push(`consensus: ${cbk} comp book (thin)`);
      else reasons.push('no comp book consensus');
    } else {
      lookupStatus = 'lookup_failed';
      reasonType = 'lookup_failure';
      verdict = 'CONSIDER';
      reasons.push(
        detailError
          ? `screen lookup failed: ${detailError}`
          : `no row matched selection "${selection}" on gameId ${gameId}`
      );
    }

    // Consistency guard: if the caller supplied a lower screen snapshot tier/kaiCall
    // (the row the agent already returned), refuse a fresh re-fetch upgrade to BET.
    if (screenKaiCall && screenKaiCall !== 'BET' && verdict === 'BET') {
      verdict = 'CONSIDER';
      reasons.push(`downgraded to match screen snapshot (${screenKaiCall})`);
    }

    // Risk-flag override.
    if (research && research.riskFlag === 'high') {
      verdict = 'PASS';
      reasons.push('player_context riskFlag = "high"');
    } else if (research && research.riskFlag === 'medium') {
      if (verdict === 'BET') verdict = 'CONSIDER';
      reasons.push('player_context riskFlag = "medium" — proceed with caution');
    } else if (research && research.riskFlag === 'low') {
      reasons.push('player_context riskFlag = "low"');
    }

    // Game-context risk override (weather / park / rest / surface). Applied
    // AFTER player_context so a high weather flag can still PASS a play
    // that survived the player-news check. Same downgrades as
    // player_context so the agent's reasoning doesn't have to branch.
    if (gameContext && gameContext.riskFlag === 'high') {
      verdict = 'PASS';
      reasons.push(`game_context riskFlag = "high"${gameContext.riskSummary ? ` — ${gameContext.riskSummary}` : ''}`);
    } else if (gameContext && gameContext.riskFlag === 'medium') {
      if (verdict === 'BET') verdict = 'CONSIDER';
      reasons.push(`game_context riskFlag = "medium" — ${gameContext.riskSummary || 'proceed with caution'}`);
    } else if (gameContext && gameContext.riskFlag === 'low') {
      reasons.push(`game_context riskFlag = "low" — ${gameContext.riskSummary || 'minor flag'}`);
    } else if (gameContext && gameContext.riskFlag === 'unknown') {
      // Surface/level couldn't be determined — note it but don't downgrade
      if (gameContext.riskSummary) {
        reasons.push(`game_context: ${gameContext.riskSummary}`);
      }
    }

    // --- Synthesize verdict summary for agents ---
    // Combines movement disposition, verdict, risk flags, and execution quality
    // into a single "should I bet this" answer. This encodes the bet-card drill
    // so no agent-side skill doc is needed.
    //
    // BUGFIX: the re-fetched matchingRow from get_play_details often lacks
    // sharpBookMovementConfirmed (set during quick_screen's sharp-book cross-
    // reference, not in the detail endpoint). Without it, computeMovementDisposition
    // returns 'insufficient' on thin-history slates where the screen correctly
    // showed supportive_bouncy. Carry the screen snapshot's value if available.
    const _rowForDisposition = matchingRow ? { ...matchingRow } : null;
    if (_rowForDisposition && !_rowForDisposition.sharpBookMovementConfirmed && args.screenSharpBookConfirmed) {
      _rowForDisposition.sharpBookMovementConfirmed = true;
    }
    const _disposition = _rowForDisposition ? computeMovementDisposition(_rowForDisposition) : 'insufficient';

    // Tier downgrade for adverse movement: the screen ranker's tier is a
    // pre-validation snapshot — it can't see what the re-fetch reveals. If
    // validation finds adverse movement (adverse_recent or adverse_full),
    // the play's tier must reflect that. Otherwise you get TIER 2 plays
    // with validated "movement adverse" sitting above TIER 3 plays with
    // validated "supportive_clean" — the tier lies.
    if ((_disposition === 'adverse_recent' || _disposition === 'adverse_full') && tier !== 'TIER 4') {
      tier = 'TIER 3';
      reasons.push(`movement ${_disposition} — tier downgraded from screen snapshot`);
    }

    const _statusMessages = {
      supportive_clean: 'all signals aligned — green movement, supportive direction, clean path',
      supportive_bouncy: 'direction is right but path was rocky — yellow grade or V-shaped recovery',
      adverse_recent: 'recent movement turned adverse — the direction went against the play recently',
      adverse_full: 'full-window direction is adverse — do not bet',
      insufficient: 'not enough data to evaluate movement quality'
    };

    const _riskFlags = [];
    if (research && research.riskFlag && research.riskFlag !== 'low' && research.riskFlag !== 'clean') {
      _riskFlags.push(`player_context: ${research.riskFlag}`);
    }
    if (gameContext && gameContext.riskFlag && gameContext.riskFlag !== 'low' && gameContext.riskFlag !== 'clean') {
      _riskFlags.push(`game_context: ${gameContext.riskFlag}`);
    }
    if (_disposition === 'adverse_recent' || _disposition === 'adverse_full') {
      _riskFlags.push('movement adverse');
    }

    let _actionableSummary;
    if (_riskFlags.length === 0 && verdict === 'BET') {
      _actionableSummary = 'No red flags. Clean play across all checks.';
    } else if (verdict === 'BET' && _riskFlags.length > 0) {
      _actionableSummary = `BET with caution — flags: ${_riskFlags.join(', ')}`;
    } else if (lookupStatus === 'lookup_failed') {
      _actionableSummary =
        "Couldn't be rehydrated from the current screen snapshot. Treat as stale / unverified, not an automatic fade.";
    } else if (verdict === 'CONSIDER') {
      // Nuanced tiers within CONSIDER — not all thin plays are equal.
      const cbk = Number(matchingRow?.consensusBookCount || 0);
      // Fall back to screen snapshot's edge when the re-fetched row lacks it
      // (the detail endpoint doesn't always compute consensusEdge).
      const edge = Number(matchingRow?.consensusEdge || args.screenConsensusEdge || 0);
      const clv = Number(matchingRow?.clvProxyPct || 0);
      const riskFlagsSuffix = _riskFlags.length > 0 ? ` — ${_riskFlags.join(', ')}` : '';

      if (cbk >= 10 && _disposition === 'supportive_clean') {
        _actionableSummary = `Deep consensus (${cbk} books, ${edge.toFixed(1)}% edge). Clean movement — playable with standard sizing.`;
      } else if (cbk >= 8 && _disposition === 'supportive_clean' && edge > 1.5) {
        _actionableSummary = `Strong signal across deep consensus (${cbk} books, ${edge.toFixed(1)}% edge). Playable with standard sizing.`;
      } else if (cbk >= 8 && _disposition === 'supportive_bouncy' && edge > 1.0) {
        _actionableSummary = `Deep consensus (${cbk} books, ${edge.toFixed(1)}% edge). Direction is right but path was rocky — standard sizing.`;
      } else if (cbk >= 8 && _disposition === 'supportive_clean') {
        _actionableSummary = `Deep consensus (${cbk} books). Clean movement, edge is thin (${edge.toFixed(1)}%) — reduce stake.`;
      } else if (cbk >= 8 && _disposition === 'supportive_bouncy') {
        _actionableSummary = `Deep consensus (${cbk} books). Bouncy movement, edge is thin (${edge.toFixed(1)}%) — reduce stake${riskFlagsSuffix}.`;
      } else if (cbk >= 5 && _disposition === 'supportive_clean' && edge > 0.5) {
        _actionableSummary = `Solid signal — ${cbk} books agree, clean movement. Standard sizing${riskFlagsSuffix}.`;
      } else if (cbk >= 5 && _disposition === 'supportive_bouncy' && edge > 0.5) {
        _actionableSummary = `Decent consensus (${cbk} books, ${edge.toFixed(1)}% edge). Bouncy but direction is right — reduce stake${riskFlagsSuffix}.`;
      } else if (cbk >= 3 && _disposition !== 'adverse_recent') {
        _actionableSummary = `Thin consensus (${cbk} books) but direction is right. Reduce stake or skip${riskFlagsSuffix}.`;
      } else if (cbk >= 1) {
        _actionableSummary = `Marginal — only ${cbk} book${cbk > 1 ? 's' : ''} in consensus. Skip unless you have a strong read${riskFlagsSuffix}.`;
      } else {
        _actionableSummary = `No comp book consensus. Pass${riskFlagsSuffix}.`;
      }
      // CLV nuance: append a note for significant CLV values
      if (clv > 4) {
        _actionableSummary += ` Strong CLV (${clv.toFixed(1)}%) confirms the move direction.`;
      } else if (clv < -4) {
        _actionableSummary += ` Weak CLV (${clv.toFixed(1)}%) — line moved against you. Reduce stake or pass.`;
      }
    } else {
      _actionableSummary = 'PASS — one or more hard checks failed.';
    }

    const verdictSummary = {
      displayTier: verdict === 'BET' ? 'BET' : verdict === 'CONSIDER' ? 'CONSIDER' : 'PASS',
      movementDisposition: _disposition,
      movementStatus: _statusMessages[_disposition] || 'unknown',
      executionQuality: matchingRow?.executionQuality || null,
      consensusSupport:
        matchingRow?.consensusBookCount > 0 ? `${matchingRow.consensusBookCount} books` : 'no consensus',
      riskFlags: _riskFlags,
      actionableSummary: _actionableSummary,
      rationale: (() => {
        const parts = [];
        const sharpSource = matchingRow?.sharpBookMovementSource || null;
        if (sharpSource) parts.push(`${sharpSource} confirms`);
        if (_disposition === 'supportive_clean') parts.push('clean movement');
        else if (_disposition === 'supportive_bouncy') parts.push('direction right, bouncy path');
        else if (_disposition === 'adverse_recent' || _disposition === 'adverse_full')
          parts.push('movement went against');
        else if (_disposition === 'insufficient') parts.push('no directional signal');
        const cbk = Number(matchingRow?.consensusBookCount || 0);
        if (cbk >= 3) parts.push(`${cbk} books`);
        const edgeVal = Number(matchingRow?.consensusEdge || args.screenConsensusEdge || 0);
        if (edgeVal > 0) parts.push(`+${edgeVal.toFixed(1)}% edge`);
        const clvVal = Number(matchingRow?.clvProxyPct ?? 0);
        if (clvVal > 0) parts.push(`+${clvVal.toFixed(1)}% CLV`);
        else if (clvVal < 0) parts.push(`${clvVal.toFixed(1)}% CLV`);
        else parts.push('0% CLV');
        if (consensusDrift && driftReason) parts.push(`drift: ${driftReason}`);
        return parts.length ? parts.join(' · ') : null;
      })()
    };

    return {
      ok: true,
      league,
      market,
      gameId,
      selection,
      executionBook: String(args.book || books[0] || ''),
      verdict,
      tier,
      lookupStatus,
      reasonType,
      reasons,
      verdictSummary,
      screenFreshness: detailResult?.freshness || null,
      consensusDrift,
      driftReason,
      play: matchingRow
        ? {
            playId: matchingRow.playId || buildCanonicalPlayId(matchingRow),
            selectionKey:
              matchingRow.selectionKey || normalizeSelectionKey(matchingRow.selection || matchingRow.participant || ''),
            gameId: matchingRow.gameId,
            homeTeam: matchingRow.homeTeam,
            awayTeam: matchingRow.awayTeam,
            start: matchingRow.start,
            odds: matchingRow.odds,
            bestAvailableOdds: matchingRow.bestAvailableOdds,
            executionQuality: matchingRow.executionQuality,
            consensusEdge: matchingRow.consensusEdge,
            consensusBookCount: matchingRow.consensusBookCount,
            clvProxyPct: matchingRow.clvProxyPct,
            openToCurrentClvPct: matchingRow.openToCurrentClvPct,
            freshnessSource: matchingRow.freshnessSource || null,
            movementLabel: matchingRow.movementLabel,
            kaiCall: matchingRow.kaiCall,
            screenScore: matchingRow.screenScore,
            screenUrl:
              `https://app.propprofessor.com/screen?market=${encodeURIComponent(market)}` +
              `&game=${encodeURIComponent(gameId)}` +
              `&league=${encodeURIComponent(league)}` +
              `&participant=${encodeURIComponent(selection)}`
          }
        : null,
      research: research
        ? {
            riskFlag: research.riskFlag,
            riskSummary: research.summary || null,
            topTweet:
              Array.isArray(research.tweets) && research.tweets.length > 0
                ? research.tweets[0]?.text?.slice(0, 200) || null
                : null,
            cached: Boolean(research.cached),
            fetchedAt: research.fetchedAt
          }
        : skipResearch
          ? { skipped: true }
          : { error: researchError || 'research failed' },
      gameContext: gameContext
        ? {
            gamePk: gameContext.gamePk,
            sport: gameContext.sport || null,
            riskFlag: gameContext.riskFlag,
            riskSummary: gameContext.riskSummary || null,
            signals: gameContext.signals || null,
            cached: Boolean(gameContext.cached),
            fetchedAt: gameContext.fetchedAt,
            // MLB-specific
            ...(isMlb
              ? {
                  venue: gameContext.venue || null,
                  pitchers: gameContext.pitchers || null,
                  park: gameContext.park || null,
                  weather: gameContext.weather || null,
                  lineups: gameContext.lineups || null
                }
              : {}),
            // Basketball-specific
            ...(gameContext.awayTeam
              ? {
                  awayTeam: gameContext.awayTeam,
                  homeTeam: gameContext.homeTeam
                }
              : {}),
            // Tennis-specific
            ...(gameContext.surface
              ? {
                  surface: gameContext.surface,
                  level: gameContext.level,
                  matchupNewsCount: gameContext.matchupNewsCount
                }
              : {})
          }
        : isMlb
          ? skipGameContext
            ? { skipped: true }
            : gameContextError
              ? typeof gameContextError === 'string'
                ? { error: gameContextError }
                : gameContextError
              : null
          : null
    };
  }

  function buildCacheKey(prefix, args, league) {
    return JSON.stringify({
      prefix,
      league,
      market: args.market || 'Moneyline',
      books: normalizeBookList(args.books),
      is_live: false,
      cardWindow: String(args.cardWindow || 'all')
        .trim()
        .toLowerCase(),
      lookbackHours: Number.isFinite(Number(args.lookbackHours)) ? Number(args.lookbackHours) : null,
      games: args.games || [],
      participants: args.participants || []
    });
  }
  async function runLeagueScreen(args = {}, league) {
    const requestedBooks = normalizeBookList(args.books);
    const marketResolution = resolveMarkets(args, league);
    const market = marketResolution.single;
    const preset = getLeagueRankingPreset(league, market);
    const focusBook = requestedBooks[0] || preset.preferredBooks[0];

    // Auto-augment with sharp books for consensus data.
    // When the user requests a single non-sharp book (e.g. NoVigApp), the backend
    // returns zero consensus because vig-removed lines don't match other books.
    // We always query with the league's sharp book set included, so consensus
    // and movement data populate. The focus book (user's execution book) is
    // preserved for display via focusPlays in extractScreenRows.
    // Non-major leagues (Tennis, Soccer, UFC, WNBA, etc.) need
    // ALL_SCREEN_BOOKS for the backend to return multi-book data.
    // The default sharp-book set (5 books) is too narrow — Total Goals on
    // Soccer, for example, returns insufficient_history without the full set.
    // Same logic as runScreenRankedImpl (lines 468-471).
    const nonMajorLeagues = ['TENNIS', 'SOCCER', 'UFC', 'WNBA', 'NCAAB', 'NCAAF'];
    const leagueUpper = (league || '').toUpperCase();
    const sharpBookSet = getSharpBookComparisonSet({ league, market });
    const augmentedBooks = nonMajorLeagues.includes(leagueUpper)
      ? ALL_SCREEN_BOOKS
      : uniqueBooks([...requestedBooks, ...sharpBookSet]);

    // Check cache first (only cache full responses, not compact/fields-filtered)
    // Use augmented books in cache key so different book combos don't collide
    const canCache = !args.compact && !args.fields && !args.include;
    const cacheKey = canCache ? buildCacheKey('league', { ...args, books: augmentedBooks }, league) : null;
    if (cacheKey) {
      const cached = responseCache.get(cacheKey);
      if (cached) {
        return { ...cached, resultMeta: { ...cached.resultMeta, cached: true } };
      }
    }

    const payload = await client.queryScreenOddsBestComps({
      market,
      league,
      games: Array.isArray(args.games) ? args.games : [],
      participants: Array.isArray(args.participants) ? args.participants : [],
      books: augmentedBooks,
      is_live: false
    });
    const response = buildRankedScreenResponseShared({
      client,
      payloads: [payload],
      args: { ...args, historySportsbooks: augmentedBooks },
      league,
      focusBook,
      rankRows: (hydratedRows, { debug } = {}) =>
        rankLeagueScreenRows(hydratedRows, {
          league,
          market,
          limit: getLimit(args),
          books: requestedBooks.length ? requestedBooks : undefined,
          includeAll: getIncludeAll(args),
          maxAgeMs: getMaxAgeMs(args),
          debug,
          // Audit 2026-06-15: same gate as screen_ranked — drop rows where
          // the user-requested book has no price. Without this, sharp_plays
          // could surface "Fliff -117" when Fliff never posted a line.
          requirePreferredBook: requestedBooks.length > 0,
          // playableOnly flag (2026-06-15): see screen_ranked comment.
          playableOnly: args.playableOnly === true
        })
    });

    // Add market alias info to resultMeta if any aliases were used
    if (marketResolution.aliasesUsed.length) {
      response.resultMeta = {
        ...response.resultMeta,
        markets_alias_used: marketResolution.aliasesUsed
      };
    }

    // Store in cache — but NEVER pin a transient empty/errored response.
    // The live backend intermittently returns 0 rows (rate-limit / refresh);
    // caching that would serve an empty slate for the full TTL and make
    // back-to-back calls look broken ("5 plays then 0"). Only cache real data.
    if (cacheKey) {
      const hasResults = Array.isArray(response.result) && response.result.length > 0;
      const hasError = response.error || (response.resultMeta && response.resultMeta.error);
      if (hasResults && !hasError) {
        responseCache.set(cacheKey, response, responseCacheTtlMs);
      }
    }

    return response;
  }

  const { runTennisScreen } = createTennisScreenHandler(client, { responseCache, responseCacheTtlMs });

  async function runUfcCard(args = {}) {
    try {
      const marketResolution = resolveMarkets(args, 'UFC');
      const normalizedMarkets = marketResolution.array.length ? marketResolution.array : [marketResolution.single];
      const market = normalizedMarkets[0];
      const targetBook = String(args.book || args.targetBook || '').trim();
      const rankedArgs = {
        ...args,
        market,
        books: targetBook ? [targetBook] : Array.isArray(args.books) ? args.books : []
      };
      const rankedResponse = await runLeagueScreen(rankedArgs, 'UFC');
      const rankedRows = Array.isArray(rankedResponse?.result) ? rankedResponse.result : [];
      const shortlist = buildUfcShortlist(rankedRows, {
        ...args,
        market,
        targetBook,
        limit: getLimit(args)
      });
      if (!shortlist || typeof shortlist !== 'object') {
        return {
          ok: false,
          league: 'UFC',
          error: { code: 'UFC_CARD_FAILED', message: 'buildUfcShortlist returned null/undefined' }
        };
      }
      const count = shortlist.shortlistMeta?.filteredCount ?? shortlist.officialCount;
      const cardWindow = shortlist.shortlistMeta?.cardWindow || shortlist.shortlistCardWindow || null;
      const eventDate = shortlist.shortlistMeta?.eventDate || shortlist.shortlistEventDate || null;
      return {
        ok: true,
        league: 'UFC',
        officialPlays: shortlist.bestBets,
        bestLooks: shortlist.bestLooks,
        passes: shortlist.bestPasses,
        summaryText: shortlist.summaryText,
        count,
        resultMeta: {
          ...rankedResponse.resultMeta,
          source: 'ufc_card',
          cardWindow,
          eventDate,
          count,
          // Include aliases from the UFC card's own resolution
          markets_alias_used: [
            ...(rankedResponse.resultMeta?.markets_alias_used || []),
            ...marketResolution.aliasesUsed
          ],
          shortlist: {
            ...shortlist,
            count
          }
        }
      };
    } catch (error) {
      process.stderr.write(`[propprofessor-mcp] ufc_card handler error: ${error.stack || error.message || error}\n`);
      return {
        ok: false,
        league: 'UFC',
        error: { code: 'UFC_CARD_FAILED', message: error.message || String(error) }
      };
    }
  }

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
    // ─── Screening & Ranking ────────────────────────────────────────
    async ev_candidates(args = {}) {
      const leagues = Array.isArray(args.leagues) && args.leagues.length ? args.leagues : undefined;
      if (!leagues) {
        const error = new Error(
          'The leagues parameter is required on ev_candidates. ' +
            'Pass one or more league names, e.g. leagues: ["NBA", "MLB", "Tennis"]. ' +
            'An empty array or omitted leagues will cause the backend to return HTTP 400.'
        );
        error.code = 'MISSING_LEAGUES';
        error.category = 'validation';
        error.status = 400;
        throw error;
      }
      const payload = await client.querySportsbook(
        defined({
          isLive: false,
          showBreakOnly: args.showBreakOnly,
          showTimeoutOnly: args.showTimeoutOnly,
          showPeriodEndOnly: args.showPeriodEndOnly,
          timeAvailable: args.timeAvailable,
          userState: args.userState,
          hideNCAAPlayerProps: args.hideNCAAPlayerProps,
          sportsbooks: Array.isArray(args.sportsbooks) ? args.sportsbooks : undefined,
          leagues,
          minOdds: args.minOdds,
          maxOdds: args.maxOdds,
          minValue: args.minValue,
          maxValue: args.maxValue,
          marketTypes: Array.isArray(args.marketTypes) ? args.marketTypes : undefined,
          periodTypes: Array.isArray(args.periodTypes) ? args.periodTypes : undefined,
          minHoursAway: args.minHoursAway,
          maxHoursAway: args.maxHoursAway,
          minLiquidity: args.minLiquidity,
          maxLiquidity: args.maxLiquidity,
          weightSettings:
            args.weightSettings && typeof args.weightSettings === 'object' ? args.weightSettings : undefined
        })
      );
      const rows = Array.isArray(payload) ? payload : [];
      const baseResult = {
        ok: true,
        count: rows.length,
        result: rows,
        notes: {
          workflow:
            'Use these rows as fast discovery candidates, then validate finalists with /screen, exact-line checks, and sharp-book movement.',
          minValueBehavior: args.minValue === undefined ? 'unset_here_use_frontend_filter' : 'explicit_request_override'
        }
      };
      if (args.validated) {
        return validatePositiveEvCandidates({ client, candidates: rows, args });
      }
      return baseResult;
    },

    async screen_ranked(args = {}) {
      // Reset per-call tier hysteresis so each screen call starts clean
      // (prevents cross-call tier drift from stale cache state).
      clearTierCache();
      // Canonical cache key for stable (gameId, market, book) tuples
      const canonicalKey = canonicalizeScreenArgs(args);

      // If gameId is present, use the canonical cache; otherwise proceed without caching
      if (canonicalKey) {
        return canonicalScreenCache.memoize(async () => {
          return await runScreenRankedImpl(client, args);
        }, canonicalKey);
      }

      // Full-league scan - no caching
      return runScreenRankedImpl(client, args);
    },

    // ─── Sharp Movement ─────────────────────────────────────────────
    async sharp_plays(args = {}) {
      const response = await runSharpPlays(args, {
        queryLeagueScreen: runLeagueScreen,
        queryTennisScreen: (rankedArgs) => runTennisScreen(rankedArgs)
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

    // scan: Simplified one-call entry point. Same engine as quick_screen
    // but with agent-friendly defaults and cleaner output. The preferred
    // tool for AI agents — quick_screen remains for backward compat.
    async scan(args = {}) {
      // Map sport→league for user ergonomics
      const sport = String(args.sport || '')
        .trim()
        .toLowerCase();
      const leagueMap = {
        tennis: 'Tennis',
        nba: 'NBA',
        mlb: 'MLB',
        nfl: 'NFL',
        nhl: 'NHL',
        wnba: 'WNBA',
        ufc: 'UFC',
        soccer: 'Soccer',
        ncaab: 'NCAAB',
        ncaaf: 'NCAAF',
        nbasl: 'NBASL'
      };
      const resolvedLeague = args.league || (sport ? leagueMap[sport] || args.sport : undefined);

      return handlers.quick_screen({
        ...args,
        league: resolvedLeague,
        book: args.book || 'NoVigApp',
        verbosity: args.verbosity || 'bets',
        lite: args.lite !== false,
        sortBy: args.sortBy || 'edge',
        sortDir: args.sortDir || 'desc',
        // Default: only show plays with supportive movement (clean or bouncy).
        // The line IS moving the right direction — that's the whole point.
        movement: args.movement || ['supportive_clean', 'supportive_bouncy']
      });
    },

    // quick_screen: Accepts any book(s) via the `books` param and runs
    // sharp_plays + player_context for each (league, market) pair.
    // Defaults to ['NoVigApp'].
    // eslint-disable-next-line complexity
    async quick_screen(args = {}) {
      // Reset per-call tier hysteresis so each screen call starts clean
      // (prevents cross-call tier drift from stale cache state).
      clearTierCache();

      // === mode presets (folded-in retired tools) ===
      // quick_screen always screens through handlers.sharp_plays internally,
      // so 'sharp' is the same as the default broad scan — the mode flag
      // exists for agent ergonomics / backward-compat routing. The other two
      // presets mirror the retired recommended_bets and tonight_bets tools.
      // Explicit args always win over these preset defaults.
      const mode = args.mode;
      if (mode === 'recommended') {
        if (!(Array.isArray(args.leagues) && args.leagues.length) && !args.league) {
          args.leagues = ['WNBA', 'NBA', 'MLB', 'NFL'];
        }
        if (!(Array.isArray(args.targetTiers) && args.targetTiers.length)) {
          args.targetTiers = ['TIER 1', 'TIER 2'];
        }
        if (args.validate === undefined) args.validate = true;
        if (args.hideVerdict === undefined) args.hideVerdict = true;
      } else if (mode === 'tonight') {
        if (!(Array.isArray(args.kaiCall) && args.kaiCall.length)) {
          args.kaiCall = ['BET', 'CONSIDER'];
        }
        if (!args.sortBy) args.sortBy = 'start';
        if (!args.sortDir) args.sortDir = 'asc';
        if (args.includeResearch === undefined) args.includeResearch = true;
        if (!Number.isFinite(Number(args.limit))) args.limit = 5;
      }
      // ('sharp' === default sharp_plays-backed scan; no override needed.)

      const targetBooks =
        Array.isArray(args.books) && args.books.length ? args.books : args.book ? [args.book] : ['NoVigApp'];
      const leagues =
        Array.isArray(args.leagues) && args.leagues.length
          ? args.leagues
          : args.league
            ? [args.league]
            : Array.from(DEFAULT_LEAGUES);
      const markets =
        Array.isArray(args.markets) && args.markets.length ? args.markets : args.market ? [args.market] : null; // null = use per-league defaults below
      const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 100;
      const maxPerMarket = Number.isFinite(Number(args.maxPerMarket)) ? Number(args.maxPerMarket) : null;
      const scanLimit = Number.isFinite(Number(args.scanLimit)) ? Number(args.scanLimit) : 100;
      const lookbackHours = Number.isFinite(Number(args.lookbackHours)) ? Number(args.lookbackHours) : 6;
      const includeResearch = args.includeResearch !== undefined ? Boolean(args.includeResearch) : true;
      const debug = Boolean(args.debug);
      const topPick = Boolean(args.topPick);
      // lite: token-light mode. Implies compact + a fixed essential field set.
      const lite = Boolean(args.lite);
      if (lite) {
        args.compact = true;
        args.fields = [
          'game',
          'selection',
          'odds',
          'edge',
          'clv',
          'confidenceTier',
          'riskScore',
          'startCST',
          'movementDisposition',
          'riskFlag',
          'screenScore'
        ];
      }

      // === response cache (aggregate level) ===
      // Cache the FULL quick_screen response keyed on the request shape.
      // Per-league screen_ranked calls are already cached individually, but
      // the fan-out loop still burns time iterating leagues. This cache
      // short-circuits the entire call when args haven't changed.
      // Bypassed when validate:true (must re-fetch for fresh validation).
      const canCacheAggregate = !args.validate;
      if (canCacheAggregate) {
        const aggregateCacheKey = JSON.stringify({
          _qs: 1,
          leagues: (leagues || []).slice().sort(),
          markets: (markets || []).slice().sort(),
          books: (targetBooks || []).slice().sort(),
          limit,
          cardWindow: args.cardWindow || 'today'
        });
        const cached = responseCache.get(aggregateCacheKey);
        if (cached) {
          return { ...cached, resultMeta: { ...cached.resultMeta, cached: true } };
        }
        // Store the key on a temp so the return path can cache the response
        args._aggregateCacheKey = aggregateCacheKey;
      }
      // === end response cache ===

      const allAliasesUsed = [];

      const resolvedMarketsByLeague = {};
      for (const league of leagues) {
        const marketsForResolution = markets === null ? getDefaultMarketsForLeague(league, targetBooks) : markets;
        const marketResolution = resolveMarkets({ markets: marketsForResolution }, league);
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

      await mapWithConcurrency(
        leagueMarketPairs,
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
              debug
            });

            const candidates = Array.isArray(spResult?.result) ? spResult.result : [];
            if (!candidates.length) {
              emptySlate.push({ league, market, reason: 'no candidates returned' });
              return;
            }

            const perMarketCap = maxPerMarket || limit;
            allCandidates.push({
              league,
              market,
              candidates: candidates.slice(0, perMarketCap).map(mapCandidateRow)
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
      const validateTop =
        args.validate === false ? 0 : Number.isFinite(Number(args.validateTop)) ? Number(args.validateTop) : 10;

      if (validateAll || validateTop > 0) {
        const validationCache = new Map(); // gameId → validated result, shared across candidates
        const validationPromises = [];

        for (const entry of allCandidates) {
          if (!entry.candidates || !entry.candidates.length) continue;
          const sorted = validateAll
            ? entry.candidates
            : [...entry.candidates].sort((a, b) => (b.screenScore || 0) - (a.screenScore || 0));
          const topN = sorted.slice(0, validateTop);

          for (const candidate of entry.candidates) {
            // validateAll => validate everything; else only top-N (capped)
            if (!validateAll && !topN.includes(candidate)) continue;
            if (!candidate.gameId || !candidate.selection) continue;
            // Skip alt-line rows already downgraded to TIER 4 by resolveAlternateLines
            // in the screen ranker. Validating them re-derives a fresh tier that
            // overwrites the downgrade — wasting API calls and surfacing noise.
            if (candidate.altLineFiltered) continue;

            // Per-gameId+selection+market cache: same game + same selection shares one validate_play call.
            // The original key (gameId::market) incorrectly shared Over/Under validation on the same game.
            const qsCacheKey = `${candidate.gameId}::${candidate.selection}::${entry.market}`;
            if (validationCache.has(qsCacheKey)) {
              const cached = validationCache.get(qsCacheKey);
              if (cached) {
                applyValidatedFields(candidate, cached);
                candidate._validated = true;
                applyFinalVerdict(candidate);
                promoteFinalVerdictToDisplay(candidate);
              }
              continue;
            }

            validationPromises.push(
              (async () => {
                try {
                  const VALIDATION_TIMEOUT_MS = 15000;
                  const validatePromise = runValidatePlayImpl(client, {
                    league: entry.league,
                    gameId: candidate.gameId,
                    selection: candidate.selection,
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
                    // Carry sharpBookMovementConfirmed so the re-fetched row
                    // doesn't lose the sharp-book confirmation and downgrade
                    // movementDisposition to 'insufficient'.
                    screenSharpBookConfirmed: candidate.sharpBookMovementConfirmed || false
                  });
                  const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(
                      () => reject(new Error(`Validation timeout for ${candidate.gameId}:${candidate.selection}`)),
                      VALIDATION_TIMEOUT_MS
                    )
                  );
                  const result = await Promise.race([validatePromise, timeoutPromise]);
                  if (candidate.gameId && result && result.ok) {
                    validationCache.set(qsCacheKey, result);
                  }
                  return { candidate, result };
                } catch (err) {
                  return { candidate, result: null, error: err.message };
                }
              })()
            );
          }
        }

        const validationResults = await mapWithConcurrency(validationPromises, async (p) => p, { concurrency: 5 });

        for (const vr of validationResults) {
          if (!vr.result || !vr.result.ok || !vr.result.verdictSummary) continue;
          applyValidatedFields(vr.candidate, vr.result);
          vr.candidate._validated = true;
          applyFinalVerdict(vr.candidate);
          // Promote the authoritative validated call into the agent-facing
          // display fields so the tier filters below and downstream consumers
          // see the merged verdict, not the raw screen snapshot.
          promoteFinalVerdictToDisplay(vr.candidate);
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
            return c.finalVerdict === 'BET' && tierIdx <= floor;
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
            gameContextFn: (opts) =>
              getGameContext({
                sport: opts.sport || opts.league,
                selection: opts.selection,
                game: opts.game,
                start: opts.start,
                market: opts.market
              }),
            concurrency: 3
          });
          for (const r of researchOut.results) {
            researchResults.push({
              player: r.player,
              game: r.game,
              riskFlag: r.riskFlag,
              riskSummary: r.riskSummary || null,
              contextType: r.contextType || 'player',
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
        // Per-league caches already filter empty responses; aggregate cache stores whatever we got
        responseCache.set(args._aggregateCacheKey, formattedResponse, responseCacheTtlMs, estimatedSizeBytes);
      }
      // Log large responses for monitoring
      try {
        const responseSize = JSON.stringify(formattedResponse).length;
        if (responseSize > 500000) {
          // 500KB
          console.warn(`[PropProfessor MCP] Large quick_screen response: ${(responseSize / 1024).toFixed(1)}KB`);
        }
      } catch {
        /* ignore */
      }
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
              async (market) => {
                // Live backend can stall on a single league/market call. Don't
                // let one hung call hang the whole recommended_bets response —
                // time it out and contribute 0 rows for that market.
                const withTimeout = (p, ms) =>
                  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('screen timeout')), ms))]);
                let screenResult;
                try {
                  screenResult = await withTimeout(
                    handlers.screen_ranked({
                      league,
                      market,
                      books: args.books,
                      limit: limit * 2,
                      is_live: false,
                      includeAll: false,
                      debug: false,
                      compact: Boolean(args.compact),
                      fields: Array.isArray(args.fields) ? args.fields : undefined,
                      include: Array.isArray(args.include) ? args.include : undefined,
                      skipHistory: args.skipHistory === true
                    }),
                    25000
                  );
                } catch {
                  return [];
                }
                const rows = Array.isArray(screenResult?.result) ? screenResult.result : [];
                return rows.map((r) => ({ ...r, _market: market }));
              },
              { concurrency: 3 }
            );
            const allRows = marketResults.flat();
            // Deduplicate by gameId+selection (keep higher screenScore)
            const seen = new Map();
            for (const row of allRows) {
              const key = `${row.gameId || ''}:${row.selection || ''}`;
              const existing = seen.get(key);
              if (!existing || Number(row.screenScore ?? 0) > Number(existing.screenScore ?? 0)) {
                seen.set(key, row);
              }
            }
            const deduped = Array.from(seen.values());
            let eligible = deduped.filter((row) => {
              // Use the live (current) tier for filtering so a deteriorating play
              // that was cached as TIER 1 earlier cannot sneak into TIER 1 results.
              const liveTier = row.confidenceTierLive || row.confidenceTier || getConfidenceTierStable(row);
              return targetTiers.includes(liveTier);
            });
            const recommended = eligible
              .sort((a, b) => {
                const tierOrder = { 'TIER 1': 0, 'TIER 2': 1, 'TIER 3': 2, 'TIER 4': 3 };
                const tierDiff = (tierOrder[a.confidenceTier] ?? 9) - (tierOrder[b.confidenceTier] ?? 9);
                if (tierDiff !== 0) return tierDiff;
                return (Number(b.screenScore ?? 0) || 0) - (Number(a.screenScore ?? 0) || 0);
              })
              .slice(0, limit);

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
                plays: recommended.map((row) => {
                  const playerName = String(row.selection || row.participant || '');
                  const research = researchResults.find(
                    (r) => String(r.player || '').toLowerCase() === playerName.toLowerCase()
                  );
                  // Route every play through mapCandidateRow so recommended_bets
                  // matches quick_screen's field shape (startCST, hoursUntilStart,
                  // consistent odds/edge/clv). Keeps research flags as overlay.
                  const mapped = mapCandidateRow(row);
                  if (row._market) mapped.market = row._market;
                  if (research) {
                    mapped.riskFlag = research.riskFlag;
                    mapped.riskSummary = research.riskSummary;
                    mapped.topTweet = research.topTweet;
                  }
                  return mapped;
                })
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

      if (validateAllRB || validateTopRB > 0) {
        const validationCache = new Map();
        const validationPromises = [];

        for (const leagueEntry of allRecommended) {
          if (!leagueEntry.plays || !leagueEntry.plays.length) continue;
          const sorted = validateAllRB
            ? leagueEntry.plays
            : [...leagueEntry.plays].sort((a, b) => (b.screenScore || 0) - (a.screenScore || 0));
          const topN = sorted.slice(0, validateTopRB);

          for (const play of leagueEntry.plays) {
            // validateAllRB => validate everything; else only top-N (capped)
            if (!validateAllRB && !topN.includes(play)) continue;
            if (!play.gameId || !play.selection) continue;
            // Skip alt-line rows already downgraded to TIER 4 by resolveAlternateLines
            // in the screen ranker. Validating them re-derives a fresh tier that
            // overwrites the downgrade — wasting API calls and surfacing noise.
            if (play.altLineFiltered) continue;

            // Per-gameId+market cache: plays from the same game+market share one validate_play call.
            // Market-scoped to prevent cross-market validation pollution.
            const rbCacheKey = `${play.gameId}::${play.market || 'Moneyline'}`;
            if (validationCache.has(rbCacheKey)) {
              const cached = validationCache.get(rbCacheKey);
              if (cached) {
                applyValidatedFields(play, cached);
                play._validated = true;
                applyFinalVerdict(play);
                promoteFinalVerdictToDisplay(play);
              }
              continue;
            }

            validationPromises.push(
              (async () => {
                try {
                  const VALIDATION_TIMEOUT_MS = 15000;
                  const validatePromise = runValidatePlayImpl(client, {
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
                  });
                  const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(
                      () => reject(new Error(`Validation timeout for ${play.gameId}:${play.selection}`)),
                      VALIDATION_TIMEOUT_MS
                    )
                  );
                  const result = await Promise.race([validatePromise, timeoutPromise]);
                  if (play.gameId && result && result.ok) {
                    validationCache.set(rbCacheKey, result);
                  }
                  return { play, result };
                } catch (err) {
                  return { play, result: null, error: err.message };
                }
              })()
            );
          }
        }

        const validationResults = await mapWithConcurrency(validationPromises, async (p) => p, { concurrency: 5 });

        for (const vr of validationResults) {
          if (!vr.result || !vr.result.ok || !vr.result.verdictSummary) continue;
          applyValidatedFields(vr.play, vr.result);
          vr.play._validated = true;
          applyFinalVerdict(vr.play);
          promoteFinalVerdictToDisplay(vr.play);
        }
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
        marketsBreakdown: (() => {
          const breakdown = {};
          for (const leagueData of allRecommended) {
            for (const play of leagueData.plays || []) {
              const m = play.market || 'unknown';
              breakdown[m] = (breakdown[m] || 0) + 1;
            }
          }
          return breakdown;
        })(),
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

    async smart_bet(args = {}) {
      const selection = String(args.selection || '').trim();
      const book = String(args.book || '').trim();
      const league = String(args.league || '').trim() || undefined;
      const market = String(args.market || 'Moneyline').trim();
      const bankroll = Number.isFinite(Number(args.bankroll)) ? Number(args.bankroll) : 1000;
      const verbosity = args.verbosity || 'standard';

      if (!selection) {
        const error = new Error('selection is required');
        error.code = 'MISSING_PARAMS';
        error.category = 'validation';
        error.status = 400;
        throw error;
      }
      if (!book) {
        const error = new Error('book is required');
        error.code = 'MISSING_PARAMS';
        error.category = 'validation';
        error.status = 400;
        throw error;
      }

      // Step 1: Quick screen to find the play (skip research — validate_play does it later)
      const screenResult = await handlers.quick_screen({
        book,
        leagues: league ? [league] : undefined,
        markets: [market],
        limit: 20,
        includeResearch: false,
        verbosity: 'full'
      });

      // Step 2: Find the matching candidate — track which league/market entry it came from
      let match = null;
      let matchLeague = league || null;
      let matchMarket = market;

      for (const entry of screenResult.results || []) {
        const found = (entry.candidates || []).find(
          (c) => c.selection && c.selection.toLowerCase().includes(selection.toLowerCase())
        );
        if (found) {
          match = found;
          matchLeague = entry.league || matchLeague;
          matchMarket = entry.market || matchMarket;
          break;
        }
      }

      if (!match) {
        return {
          ok: true,
          found: false,
          message: `No play found for "${selection}" on ${book}. The slate may be empty or the player/team isn't in today's games.`,
          activeSlate: screenResult.activeSlate || []
        };
      }

      // Step 3: Validate the play
      let validation = null;
      try {
        validation = await handlers.validate_play({
          league: matchLeague,
          gameId: match.gameId,
          selection: match.selection,
          market: matchMarket,
          book
        });
      } catch (err) {
        validation = { _error: true, error: err.message };
      }

      // Step 4: Line shop
      let bestPrice = null;
      try {
        bestPrice = await handlers.find_best_price({
          game: match.game,
          league: matchLeague,
          market: matchMarket,
          selection: match.selection
        });
      } catch (err) {
        bestPrice = { _error: true, error: err.message };
      }

      // Step 5: Staking recommendation
      let staking = null;
      if (validation?.verdict === 'BET' || validation?.verdict === 'CONSIDER') {
        try {
          const stakingResult = await handlers.staking_plan({
            bankroll,
            leagues: matchLeague ? [matchLeague] : undefined,
            markets: [matchMarket],
            targetTiers: validation.verdict === 'BET' ? ['TIER 1'] : ['TIER 1', 'TIER 2']
          });
          const stakingStakes = stakingResult?.stakes || [];
          staking =
            stakingStakes.find((p) => p.selection && p.selection.toLowerCase().includes(selection.toLowerCase())) ||
            null;
        } catch (err) {
          staking = { _error: true, error: err.message };
        }
      }

      return {
        ok: true,
        found: true,
        play: {
          selection: match.selection,
          game: match.game,
          league: matchLeague,
          market: matchMarket,
          odds: match.odds,
          edge: match.edge,
          executionQuality: match.executionQuality,
          movementDisposition: match.movementDisposition,
          displayTier: match.displayTier,
          kaiCall: match.kaiCall,
          confidenceTier: match.confidenceTier,
          riskScore: match.riskScore
        },
        verdict: validation
          ? {
              verdict: validation.verdict,
              tier: validation.tier,
              actionableSummary: validation.verdictSummary?.actionableSummary,
              riskFlags: validation.verdictSummary?.riskFlags || [],
              movementDisposition: validation.verdictSummary?.movementDisposition
            }
          : null,
        bestPrice: bestPrice?.found ? bestPrice.bestPrice : null,
        staking: staking
          ? {
              stake: staking.stakeDollars,
              stakePct: staking.bankrollPct,
              reason: staking.rationale
            }
          : null,
        verbosity
      };
    },

    async staking_plan(args = {}) {
      const bankroll = Number.isFinite(Number(args.bankroll)) ? Number(args.bankroll) : 1000;
      const leagues = Array.isArray(args.leagues) && args.leagues.length ? args.leagues : undefined;
      const markets =
        Array.isArray(args.markets) && args.markets.length
          ? args.markets
          : args.market
            ? [args.market]
            : ['Moneyline', 'Spread', 'Total'];
      const targetTiers =
        Array.isArray(args.targetTiers) && args.targetTiers.length ? args.targetTiers : ['TIER 1', 'TIER 2'];
      const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 10;
      const recResult = await handlers.quick_screen({
        leagues,
        markets,
        targetTiers,
        limit,
        is_live: false,
        includeResearch: false,
        compact: Boolean(args.compact),
        fields: Array.isArray(args.fields) ? args.fields : undefined,
        include: Array.isArray(args.include) ? args.include : undefined,
        skipHistory: args.skipHistory === true
      });
      if (!recResult.ok || !recResult.totalCandidates) {
        return {
          ok: true,
          bankroll,
          totalStake: 0,
          playCount: 0,
          stakes: [],
          remainingBankroll: bankroll,
          warnings: ['No recommended plays found for the given criteria'],
          summary: 'No plays to stake'
        };
      }
      const allPlays = [];
      for (const league of recResult.leagues || []) {
        for (const play of league.plays || []) {
          allPlays.push({ ...play, league: league.league });
        }
      }
      const plan = suggestStakes({ bankroll, plays: allPlays });
      return {
        ...plan,
        bankroll,
        leagueBreakdown: recResult.leagues.map((l) => ({ league: l.league, count: l.count })),
        totalRecommended: recResult.totalRecommended,
        markets_queried: recResult.markets_queried,
        markets_alias_used: recResult.markets_alias_used
      };
    },

    async sharp_consensus(args = {}) {
      const league = String(args.league || 'Tennis').trim();
      const marketResolution = resolveMarkets(args, league);
      const market = marketResolution.single;
      const windows =
        Array.isArray(args.windows) && args.windows.length
          ? args.windows
              .map(Number)
              .filter(Boolean)
              .sort((a, b) => a - b)
          : DEFAULT_WINDOWS;
      const sharpBooks =
        Array.isArray(args.sharpBooks) && args.sharpBooks.length
          ? args.sharpBooks.map((b) => String(b).trim()).filter(Boolean)
          : DEFAULT_SHARP_BOOKS;
      const minConsensusWindows = Number(args.minConsensusWindows) || 0;
      const lookbackHours = Number(args.lookbackHours) || 48;
      const limit = Number(args.limit) || 100;
      const rankedResponse = await handlers.screen_ranked({
        league,
        market,
        historySportsbooks: sharpBooks,
        includeAll: true,
        limit,
        lookbackHours,
        debug: false,
        is_live: false,
        skipHistory: args.skipHistory === true
      });
      if (!rankedResponse?.ok || !Array.isArray(rankedResponse.result)) {
        return { ok: false, error: 'Failed to fetch ranked screen data' };
      }
      const rows = rankedResponse.result;
      const analysis = analyzeMultiWindow(rows, { windows, sharpBooks, minConsensusWindows, nowMs: Date.now() });
      const analysisResults = analysis.results || [];
      const summary = summarizeResults(analysisResults);
      return {
        ok: true,
        count: analysisResults.length,
        summary,
        result: analysisResults,
        resultMeta: {
          league,
          market,
          windows,
          sharpBooks,
          lookbackHours,
          totalRowsScanned: rows.length,
          minConsensusWindows,
          rowsSkippedNoHistory: analysis.skippedNoHistory || 0,
          rowsSkippedInsufficientBooks: analysis.skippedInsufficientBooks || 0,
          markets_alias_used: marketResolution.aliasesUsed
        }
      };
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
                const tennisResult = await runTennisScreen({
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
                const leagueResult = await runLeagueScreen(
                  {
                    market: resolvedMarket,
                    limit,
                    includeAll: args.includeAll,
                    lookbackHours: args.lookbackHours,
                    is_live: false,
                    compact: Boolean(args.compact),
                    fields: Array.isArray(args.fields) ? args.fields : undefined,
                    include: Array.isArray(args.include) ? args.include : undefined,
                    skipHistory: args.skipHistory === true
                  },
                  league
                );
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

    // ─── Sharp Alerts (on-demand, deduped — no cron) ───────────────
    async sharp_alerts(args = {}) {
      const { loadStore, saveStore, upsert, defaultPath } = require('../../lib/propprofessor-sharp-alerts-store');
      const storePath = args.storePath || defaultPath();
      const dedupWindowMs =
        (Number.isFinite(Number(args.dedupWindowMinutes)) ? Number(args.dedupWindowMinutes) : 360) * 60000;
      const sinceMs = (Number.isFinite(Number(args.sinceMinutes)) ? Number(args.sinceMinutes) : 2880) * 60000;
      const floor = ['TIER 1', 'TIER 2', 'TIER 3'].indexOf(args.minFinalTier || 'TIER 1');

      // Delegate to quick_screen with validation + research on (reuses all filters).
      const screen = await handlers.quick_screen({
        ...args,
        validate: true,
        includeResearch: true,
        verbosity: 'full'
      });
      if (!screen || !screen.ok) {
        return { ok: false, error: 'screen failed', newAlerts: [], repeatAlerts: [], allBets: [] };
      }

      const researchByPlayer = new Map();
      for (const r of screen.research || []) {
        researchByPlayer.set(String(r.player || '').toLowerCase(), r);
      }

      const now = Date.now();
      const store = loadStore(storePath);
      const newAlerts = [];
      const repeatAlerts = [];
      const allBets = [];

      for (const entry of screen.results || []) {
        for (const c of entry.candidates || []) {
          const tierIdx = ['TIER 1', 'TIER 2', 'TIER 3', 'TIER 4'].indexOf(
            c.finalConfidenceTier || c.confidenceTier || 'TIER 4'
          );
          if (c.finalVerdict !== 'BET' || tierIdx > floor) continue;
          const startMs = parseGameStartMs(c.start);
          if (startMs && now - startMs > sinceMs) continue; // already past the alert window
          const risk = researchByPlayer.get(String(c.selection || '').toLowerCase());
          if (risk && risk.riskFlag === 'high') continue;
          const odds = Number.isFinite(Number(c.validatedOdds)) ? c.validatedOdds : c.odds;
          const alert = {
            game: c.game,
            selection: c.selection,
            market: entry.market,
            odds,
            edge: c.edge,
            clv: c.clv,
            startCST: c.startCST,
            finalConfidenceTier: c.finalConfidenceTier,
            researchRiskFlag: risk ? risk.riskFlag : null,
            priceDrift: c.priceDrift != null ? c.priceDrift : null,
            finalWarnings: c.finalWarnings || []
          };
          allBets.push(alert);
          const key = `${c.gameId || c.game}:${c.selection}:${entry.market}`;
          const { isNew } = upsert(store, key, now, dedupWindowMs);
          (isNew ? newAlerts : repeatAlerts).push(alert);
        }
      }

      saveStore(storePath, store);
      return {
        ok: true,
        newAlerts,
        repeatAlerts,
        allBets,
        message: newAlerts.length ? null : 'No new sharp plays right now.'
      };
    },

    // ─── UFC ────────────────────────────────────────────────────────
    async ufc_card(args = {}) {
      return runUfcCard(args);
    },

    // ─── Play Detail & Validation Handlers ──────────────────────────────────

    async get_play_details(args = {}) {
      if (!args.books && args.book) {
        args.books = [args.book];
      }
      const canonicalKey = canonicalizeScreenArgs(args);
      if (canonicalKey) {
        return await canonicalScreenCache.memoize(async () => {
          return await runGetPlayDetailsImpl(client, args);
        }, canonicalKey)();
      }
      return runGetPlayDetailsImpl(client, args);
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
      const result = await runValidatePlayImpl(client, args);
      if (result && result.ok === false) {
        return result;
      }
      return ok(result);
    },

    async health_status() {
      const authFile = resolveAuthFile();
      let authState;
      try {
        authState = readAuthState(authFile);
      } catch {
        authState = null;
      }

      const authValid = isAuthValid(authState);
      const expiryInfo = getCookieExpiryInfo(authState);
      const authSection = {
        valid: authValid,
        file: authValid ? authFile : null,
        message: authValid ? 'Auth is valid' : 'Auth missing or expired. Run: pp-query login',
        session: {
          status: expiryInfo.status,
          expiresAt: expiryInfo.sessionExpiry,
          daysRemaining: expiryInfo.daysRemaining,
          warning: expiryInfo.warning
        }
      };

      if (!authValid) {
        return { ok: false, auth: authSection };
      }

      const result = await client.healthStatus();
      // Surface cache hit/miss/eviction stats so operators can verify the
      // 60s response cache and the cross-call odds-history LRU are doing
      // useful work. Without this, a misconfigured cache (TTL too short,
      // max-entries too small) would silently underperform.
      const responseCacheStats = responseCache.stats();
      const totalLooks = responseCacheStats.hits + responseCacheStats.misses;
      const responseCacheHitRate = totalLooks > 0 ? responseCacheStats.hits / totalLooks : 0;
      const oddsHistoryCacheStats = getOddsHistoryCache().stats();
      const oddsTotalLooks = oddsHistoryCacheStats.hits + oddsHistoryCacheStats.misses;
      const oddsHistoryHitRate = oddsTotalLooks > 0 ? oddsHistoryCacheStats.hits / oddsTotalLooks : 0;
      return {
        ok: true,
        auth: authSection,
        result,
        backend: {
          ok: result.ok,
          message: result.ok ? 'Backend is reachable' : 'Backend returned an error',
          ...result
        },
        caches: {
          response: {
            size: responseCacheStats.size,
            max: responseCacheStats.max,
            hits: responseCacheStats.hits,
            misses: responseCacheStats.misses,
            evictions: responseCacheStats.evictions,
            hitRate: Number(responseCacheHitRate.toFixed(4)),
            ttlMs: responseCacheTtlMs
          },
          oddsHistory: {
            size: oddsHistoryCacheStats.size,
            max: oddsHistoryCacheStats.max,
            hits: oddsHistoryCacheStats.hits,
            misses: oddsHistoryCacheStats.misses,
            evictions: oddsHistoryCacheStats.evictions,
            hitRate: Number(oddsHistoryHitRate.toFixed(4)),
            ttlMs: DEFAULT_ODDS_HISTORY_CACHE_TTL_MS
          }
        }
      };
    },

    // ─── Line Shopping ──────────────────────────────────────────────
    // find_best_price extracted to handlers/pricing.js

    async ask(args = {}) {
      const query = String(args.query || '').trim();
      if (!query) {
        const error = new Error(
          'query is required. Pass a natural language bet query, e.g. "best plays on Fliff today" or "Tatum over 29.5 points".'
        );
        error.code = 'MISSING_PARAMS';
        error.category = 'validation';
        error.status = 400;
        throw error;
      }
      const parsed = parseNaturalLanguagePropQuery(query);

      // Execute the appropriate tool based on the parsed query.
      // One call = one answer — no more parse-only suggest-then-call-again pattern.

      const isValidationQuery = /\b(should i bet|is .* safe|validate|check .* play)\b/i.test(query);

      // Build pure-args objects for each branch so we can attach
      // _suggestedTool metadata regardless of which path was taken.
      const queryArgs = {
        query,
        parsed: {
          league: parsed.league,
          book: parsed.book,
          market: parsed.market,
          side: parsed.side,
          line: parsed.line,
          player: parsed.player,
          rawText: parsed.raw
        }
      };

      let result, executedTool, executedArgs;

      if (isValidationQuery && parsed.player) {
        executedTool = 'validate_play';
        executedArgs = {
          ...(parsed.league ? { league: parsed.league } : {}),
          selection: parsed.player,
          ...(parsed.book ? { book: parsed.book } : {})
        };
        result = await handlers.validate_play(executedArgs);
      } else if (parsed.book) {
        executedTool = 'quick_screen';
        executedArgs = {
          books: [parsed.book],
          ...(parsed.league ? { leagues: [parsed.league] } : {}),
          ...(parsed.market ? { markets: [parsed.market] } : {})
        };
        result = await handlers.quick_screen(executedArgs);
      } else if (parsed.player) {
        executedTool = 'player_context';
        executedArgs = {
          player: parsed.player,
          ...(parsed.league ? { sport: parsed.league } : {})
        };
        result = await handlers.player_context(executedArgs);
      } else {
        executedTool = 'quick_screen';
        executedArgs = { mode: 'recommended' };
        result = await handlers.quick_screen(executedArgs);
      }

      // Preserve the debug surface — agents can see what was called and
      // with what args, alongside the actual result.
      return {
        ok: result && result.ok !== false,
        ...queryArgs,
        _executed: { tool: executedTool, args: executedArgs },
        result
      };
    },

    async get_started(args = {}) {
      const userType = args.user_type || 'intermediate';

      const workflows = {
        casual: {
          summary: 'For casual bettors who just want top picks.',
          prompt: [
            '1. Call today({ leagues: [...], book: "NoVigApp" }) for a one-call briefing — sharp slate + your pending picks + recent stats.',
            '2. For quick picks: quick_screen({ book: "NoVigApp", kaiCall: ["BET"], sortBy: "start", verbosity: "minimal" }). Present the top 3-5 plays.',
            '3. Before recommending: player_context({ player, sport }) for injury/availability flags.',
            '4. Skip sharp_consensus and ev_candidates — those are for advanced users.'
          ],
          key_tools: ['today', 'quick_screen', 'player_context'],
          pitfall:
            'tier/kaiCall/edge are signal-quality ratings, not win predictions. TIER 1 means sharp books agree — it does not mean the side will win.'
        },
        intermediate: {
          summary: 'For bettors who understand edge and tier.',
          prompt: [
            '1. Call today() for a one-call briefing (slate + your pending picks + stats).',
            '2. For deeper scanning: quick_screen({ leagues: [...], book: "NoVigApp", kaiCall: ["BET"], sortBy: "start", verbosity: "standard" }).',
            '3. Before recommending any play: validate_play({ league, gameId, playId, market, book }) — always pass playId from the screen row.',
            '4. Check player_context({ player, sport }) for injury flags on final picks.',
            '5. Optionally: find_best_price({ league, market, game, selection }) to line-shop.',
            '6. To bet: place_bet({ league, gameId, playId, selection, market, book, stake }). It validates first and rejects PASS plays.',
            '7. After games settle: resolve_pick({ id, result }) for each logged pick.'
          ],
          key_tools: [
            'today',
            'quick_screen',
            'validate_play',
            'player_context',
            'place_bet',
            'resolve_pick',
            'find_best_price'
          ],
          pitfall:
            'Always pass playId to validate_play — bare selection strings fail. Use league-specific market names (get_market_registry for the mapping).'
        },
        sharp: {
          summary: 'For sharp bettors who want full data and control.',
          prompt: [
            '1. Call today() for a one-call briefing.',
            '2. For full data: quick_screen({ leagues: [...], book: "NoVigApp", kaiCall: ["BET"], sortBy: "edge", verbosity: "full" }).',
            '3. Use quick_screen({ mode: "sharp" }) for multi-sharp-book confirmation.',
            '4. Use sharp_consensus({ league, market }) for multi-window movement analysis.',
            '5. Validate every play with validate_play — movementDisposition is the single field to trust.',
            '6. get_play_details({ league, gameIds: [...] }) for full line history on specific plays.',
            '7. staking_plan({ picks: [...] }) for Kelly sizing.',
            '8. place_bet + resolve_pick for tracking.'
          ],
          key_tools: [
            'today',
            'quick_screen',
            'sharp_consensus',
            'validate_play',
            'get_play_details',
            'staking_plan',
            'place_bet',
            'resolve_pick'
          ],
          pitfall:
            'movementDisposition is the single field to check: supportive_clean = BET, supportive_bouncy = CONSIDER, adverse = PASS. Do not cross-reference movementGrade + movementLabel separately.'
        }
      };

      const workflow = workflows[userType] || workflows.intermediate;
      // Always include a top-level reminder of the honest-scope caveat so an
      // agent that ONLY reads get_started (and skips individual tool
      // descriptions) still sees it. Tier and kaiCall are signal-quality
      // ratings, not win-probability predictions.
      const out = {
        ...workflow,
        honest_scope:
          'TIER 1-4, kaiCall (BET/CONSIDER/PASS), edge, and screenScore are quality ratings on what sharp books are doing — NOT predictions about which side will win. TIER 1 means sharp books agree; it does not mean the side will win. Use to inform handicapping, not to outsource decisions.',
        edge_cases: [
          'validate_play_no_match: If validate_play returns lookupStatus="lookup_failed" with verdict CONSIDER, the screen row could not be rehydrated — this is a stale snapshot, not a negative signal. Pass playId from the prior quick_screen call for exact matching. Do NOT treat this as PASS.',
          'soccer_markets: quick_screen with leagues=["Soccer"] uses Draw No Bet / Match Handicap / Total Goals by default. If you get 0 results, the book may genuinely not have soccer that day. Probe find_best_price with market="Draw No Bet" on a known fixture.',
          'tennis_start_time: validate_play may return stale start timestamps for tennis. Check verdictSummary.movementDisposition and gameContext — if surface/level resolve to a real tournament, the match is live regardless of the API start time.',
          'movement_disposition: validate_play.verdictSummary.movementDisposition is the single field to check: supportive_clean = BET, supportive_bouncy = CONSIDER, adverse_recent/adverse_full = PASS. Do not cross-reference movementGrade + movementLabel separately.',
          'empty_slate: If quick_screen returns 0 candidates across all leagues, run health_status first. If auth is valid, the slate is genuinely empty. Do not force recommendations.'
        ]
      };

      // Append a live today-briefing so an agent calling get_started gets the
      // current slate + pending picks + stats in the same response. Failures
      // are non-fatal — get_started still returns the workflow.
      try {
        out.today_briefing = await handlers.today({ user_type: userType });
      } catch (err) {
        out.today_briefing = { ok: false, error: err.message };
      }

      return out;
    },

    // ─── Picks ─────────────────────────────────────────────────────
    async log_pick(args = {}) {
      if (!args.game || !args.league || !args.market || !args.selection || !Number.isFinite(args.odds)) {
        const error = new Error('game, league, market, selection, and odds are required');
        error.code = 'VALIDATION_ERROR';
        error.category = 'validation';
        error.status = 400;
        throw error;
      }
      return logPick(args.game, args.league, args.market, args.selection, args.odds, {
        stake: args.stake,
        confidenceTier: args.confidenceTier,
        kaiCall: args.kaiCall,
        rationale: args.rationale,
        notes: args.notes
      });
    },

    // One-call validate + log workflow. Replaces the 2-call
    // validate_play -> log_pick pattern. If validate_play returns PASS the
    // bet is rejected up front (no log spam for non-bets).
    async place_bet(args = {}) {
      if (!args.league || !args.selection || !args.market) {
        const error = new Error('league, selection, and market are required');
        error.code = 'VALIDATION_ERROR';
        error.category = 'validation';
        error.status = 400;
        throw error;
      }

      const validation = await handlers.validate_play({
        league: args.league,
        gameId: args.gameId,
        selection: args.selection,
        market: args.market,
        book: args.book
      });

      if (!validation || !validation.ok || !validation.verdict) {
        return {
          ok: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: `validate_play did not return a verdict: ${(validation && validation.error && validation.error.message) || 'unknown'}`
          }
        };
      }

      if (validation.verdict === 'PASS') {
        return {
          ok: false,
          error: {
            code: 'BET_REJECTED',
            message: `validate_play returned PASS — this play is not a bet. reasons: ${(validation.reasons || []).join('; ')}`
          },
          validation: {
            verdict: validation.verdict,
            tier: validation.tier,
            reasons: validation.reasons
          }
        };
      }

      const logged = await handlers.log_pick({
        game: validation.play && validation.play.game ? validation.play.game : args.gameId,
        league: args.league,
        market: args.market,
        selection: args.selection,
        odds: validation.play && Number.isFinite(validation.play.odds) ? validation.play.odds : args.odds,
        stake: args.stake,
        confidenceTier: validation.tier,
        kaiCall: validation.verdict,
        notes: args.notes
      });

      if (!logged || !logged.ok) {
        return {
          ok: false,
          error: {
            code: 'LOG_FAILED',
            message: (logged && logged.error && logged.error.message) || 'log_pick failed'
          },
          validation: { verdict: validation.verdict, tier: validation.tier, reasons: validation.reasons }
        };
      }

      return {
        ok: true,
        verdict: validation.verdict,
        tier: validation.tier,
        pickId: logged.pick && logged.pick.id,
        pick: logged.pick,
        validation: { verdict: validation.verdict, tier: validation.tier, reasons: validation.reasons },
        workflow: `Validated (${validation.verdict}), logged as pick ${logged.pick && logged.pick.id}. Settle with resolve_pick(id="${logged.pick && logged.pick.id}") after the game.`
      };
    },

    async get_pick_history(args = {}) {
      return getPickHistory({
        status: args.status,
        league: args.league,
        days: args.days,
        limit: args.limit
      });
    },

    async resolve_pick(args = {}) {
      if (!args.id || !args.result) {
        const error = new Error('id and result are required');
        error.code = 'VALIDATION_ERROR';
        error.category = 'validation';
        error.status = 400;
        throw error;
      }
      return resolvePick(args.id, args.result);
    },

    async get_pick_stats(args = {}) {
      return getPickStats({ days: args.days });
    },

    // One-call daily briefing: current sharp slate + your pending picks +
    // your recent stats. Replaces the 3-call pattern (quick_screen +
    // get_pick_history + get_pick_stats) with a single call.
    async today(args = {}) {
      const leagues =
        Array.isArray(args.leagues) && args.leagues.length
          ? args.leagues
          : args.league
            ? [args.league]
            : Array.from(DEFAULT_LEAGUES);
      const book = args.book || 'NoVigApp';

      const [slateRes, pendingRes, statsRes, backtestRes] = await Promise.all([
        handlers
          .quick_screen({
            leagues,
            book,
            limit: args.limit || 10,
            targetTiers:
              Array.isArray(args.targetTiers) && args.targetTiers.length ? args.targetTiers : ['TIER 1', 'TIER 2'],
            validate: false,
            includeResearch: false,
            lite: true
          })
          .catch(() => ({ ok: true, results: [] })),
        handlers.get_pick_history({ status: 'pending', days: 1 }).catch(() => ({ ok: true, picks: [] })),
        handlers.get_pick_stats({ days: args.statsDays || 30 }).catch(() => ({ ok: true, stats: null })),
        Promise.resolve()
          .then(() => getBacktestSummary({ days: args.statsDays || 30 }))
          .catch(() => ({ ok: false, stats: null }))
      ]);

      const slate = (slateRes.results || []).flatMap((e) =>
        (e.candidates || []).map((c) => ({
          game: c.game,
          gameId: c.gameId,
          market: e.market || c.market,
          selection: c.selection,
          odds: c.odds,
          tier: c.confidenceTier,
          kai: c.kaiCall,
          edge: c.consensusEdge || c.edge,
          startCST: c.startCST || null,
          hoursUntilStart: c.hoursUntilStart ?? null,
          movementDisposition: c.movementDisposition || null,
          executionQuality: c.executionQuality || null,
          consensusBookCount: c.consensusBookCount ?? null,
          sharpBookMovementConfirmed: c.sharpBookMovementConfirmed || false
        }))
      );

      const pendingPicks = (pendingRes.picks || []).map((p) => ({
        id: p.id,
        selection: p.selection,
        league: p.league,
        market: p.market,
        odds: p.odds,
        stake: p.stake,
        status: p.status
      }));

      return ok({
        asOf: new Date().toISOString(),
        leagues,
        book,
        slate,
        pendingPicks,
        stats: statsRes.stats || null,
        backtest: backtestRes.ok ? backtestRes : null,
        summary: `${slate.length} sharp plays, ${pendingPicks.length} pending picks, ${statsRes.stats && statsRes.stats.winRate ? statsRes.stats.winRate : 'n/a'} lifetime win rate`
      });
    },

    // ─── Alerts ─────────────────────────────────────────────────────
    async get_alerts(args = {}) {
      const leagues = Array.isArray(args.leagues) && args.leagues.length ? args.leagues : Array.from(DEFAULT_LEAGUES);
      const lookbackHours = Number.isFinite(Number(args.lookbackHours))
        ? Math.min(48, Math.max(1, Number(args.lookbackHours)))
        : 6;
      const minSteamBooks = Number.isFinite(Number(args.minSteamBooks))
        ? Math.min(5, Math.max(1, Number(args.minSteamBooks)))
        : 2;

      const checkpoint = readCheckpoint();
      const now = new Date().toISOString();
      const alerts = [];

      for (const league of leagues) {
        try {
          const screenResult = await handlers.screen_ranked({
            league,
            market: 'Moneyline',
            limit: 20,
            includeAll: true,
            debug: false,
            compact: true,
            skipHistory: false,
            lookbackHours,
            is_live: false
          });

          const rows = Array.isArray(screenResult?.result) ? screenResult.result : [];
          if (!rows.length) continue;

          const lastChecked = checkpoint.leagues[league];
          const lastCheckedMs = lastChecked ? new Date(lastChecked).getTime() : 0;

          // Steam moves (strict rule: 3+ books, 5-min window)
          const steamMoves = rows.filter((r) => r.steamMove && r.steamBookCount >= minSteamBooks);
          if (steamMoves.length) {
            alerts.push({
              type: 'steam_move',
              league,
              count: steamMoves.length,
              examples: steamMoves.slice(0, 3).map((r) => ({
                game: r.game || `${r.awayTeam || '?'} @ ${r.homeTeam || '?'}`,
                selection: r.selection || r.participant,
                market: r.screenMarket || r.market,
                direction: r.steamDirection,
                books: r.steamBooks,
                bookCount: r.steamBookCount
              }))
            });
          }

          // Significant CLV shifts (>= 2% CLV proxy)
          const clvShifts = rows.filter((r) => Number.isFinite(r.clvProxyPct) && Math.abs(r.clvProxyPct) >= 2);
          if (clvShifts.length) {
            alerts.push({
              type: 'clv_shift',
              league,
              count: clvShifts.length,
              examples: clvShifts.slice(0, 3).map((r) => ({
                game: r.game || `${r.awayTeam || '?'} @ ${r.homeTeam || '?'}`,
                selection: r.selection || r.participant,
                market: r.screenMarket || r.market,
                clvPct: r.clvProxyPct,
                direction: r.clvProxyPct > 0 ? 'supportive' : 'adverse'
              }))
            });
          }

          // New TIER 1 / TIER 2 plays
          const newPlays = rows.filter((r) => {
            if (!lastCheckedMs) return false;
            const rowTime = r.freshnessMs || 0;
            return rowTime > lastCheckedMs && (r.confidenceTier === 'TIER 1' || r.confidenceTier === 'TIER 2');
          });
          if (newPlays.length) {
            alerts.push({
              type: 'new_play',
              league,
              count: newPlays.length,
              examples: newPlays.slice(0, 5).map((r) => ({
                game: r.game || `${r.awayTeam || '?'} @ ${r.homeTeam || '?'}`,
                selection: r.selection || r.participant,
                tier: r.confidenceTier,
                edge: r.consensusEdge,
                clv: r.clvProxyPct
              }))
            });
          }
        } catch {
          // League failed to scan — skip, continue with others
        }
      }

      // Update checkpoint
      const updatedLeagues = {};
      for (const league of leagues) {
        updatedLeagues[league] = now;
      }
      writeCheckpoint({ lastCheckedAt: now, leagues: { ...checkpoint.leagues, ...updatedLeagues } });

      return {
        ok: true,
        totalAlerts: alerts.length,
        alerts,
        leaguesChecked: leagues,
        lastCheckedAt: now
      };
    }
  };

  // Extracted module handlers — merge in so they override inline defs
  Object.assign(handlers, createHealthHandlers(client, ctx));
  Object.assign(handlers, createMetaHandlers(client, ctx));
  Object.assign(handlers, createStateHandlers(client, ctx));
  Object.assign(handlers, createPicksHandlers(client, ctx));
  Object.assign(handlers, createPricingHandlers(client, ctx));
  Object.assign(handlers, createContextPluginsHandlers(client, ctx));
  Object.assign(handlers, createDiscoveryHandlers(client, ctx));
  Object.assign(handlers, createConsensusHandlers(client, ctx));
  Object.assign(handlers, createCompositesHandlers(client, ctx));
  Object.assign(handlers, createScreenHandlers(client, ctx));
  Object.assign(handlers, createPlayDetailsHandlers(client, ctx));

  // Set handlers reference on ctx so extracted modules can cross-call.
  ctx.handlers = handlers;

  return handlers;
}

module.exports = { createMcpHandlers, mapWithConcurrency, applyValidatedFields, applyFinalVerdict };
