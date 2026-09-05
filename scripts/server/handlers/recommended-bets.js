'use strict';

/**
 * recommended_bets handler — extracted from createMcpHandlers() in handlers.js.
 *
 * Behavioral extraction with NO behavior change. The original inline
 * handlers.recommended_bets body is preserved verbatim but reorganized into a
 * thin orchestrator (runRecommendedBets) that delegates each phase to an
 * explicit, dependency-injected helper below. Every helper receives its inputs
 * and returns its outputs — no closure state is captured beyond the passed deps.
 *
 * League/market screening is delegated to handlers.screen_ranked via
 * runRecommendedMarket({ handlers: ctx.handlers, ... }) — exactly the prior
 * inline contract.
 *
 * @param {import('../../../lib/propprofessor-api').PropProfessorClient} client
 * @param {import('./handler-context').HandlerContext} ctx
 * @param {object} deps
 * @param {number} deps.screenTimeoutMs - Bounded per-market stall guard timeout.
 */

const { clearTierCache } = require('../../../lib/propprofessor-risk-score');
const { getMarketsForSport } = require('../../../lib/propprofessor-market-registry');
// Local mirror of the original inline getDefaultMarketsForLeague wrapper in
// handlers.js — resolves default markets for a league via the registry.
function getDefaultMarketsForLeague(league, _targetBooks) {
  return getMarketsForSport(league, _targetBooks);
}
const { mapWithConcurrency } = require('../../../lib/propprofessor-shared-utils');
const { resolveMarkets, stripVerdictFields } = require('./handler-utils');
const { runRecommendedMarket } = require('./recommended-market');
const { selectRecommendedRows } = require('./select-recommended-rows');
const { computeMarketsBreakdown } = require('./recommended-bets-breakdown');
const { mapRecommendedPlay } = require('./recommended-play');
const { getConfidenceTierStable } = require('../../../lib/propprofessor-risk-score');
const { runResearchOnTopRows } = require('../../../lib/propprofessor-research-runner');
const { getGameContext } = require('../../../lib/propprofessor-game-context');
const { formatRecommendedBetsMinimal, formatRecommendedBetsStandard } = require('../../../lib/propprofessor-formatter');
const {
  filterRowsByKaiCall,
  filterRowsByMinEV,
  filterRowsByMovement
} = require('../../../lib/propprofessor-row-filter');
const { sortRows } = require('../../../lib/propprofessor-sort-utils');
const { categorizeError } = require('../../../lib/propprofessor-mcp-stdio');
const validationPipeline = require('../../../lib/propprofessor-validation-pipeline');
const {
  applyValidatedFields,
  applyFinalVerdict,
  flagContradictoryPlays,
  promoteFinalVerdictToDisplay
} = require('../../../lib/bet-verdict');

// ─── Phase: resolve markets per league (with user-override handling) ──────────

function resolveRecommendedMarkets(args) {
  const leagues = Array.isArray(args.leagues) && args.leagues.length ? args.leagues : Array.from(DEFAULT_LEAGUES_RB);
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
      'Moneyline'
    );
    resolvedMarketsByLeague[league] = marketResolution.array.length
      ? marketResolution.array
      : [marketResolution.single];
    allAliasesUsed.push(...marketResolution.aliasesUsed);
  }
  const firstLeague = leagues[0];
  const markets = resolvedMarketsByLeague[firstLeague] || ['Moneyline', 'Spread', 'Total'];
  return { leagues, allAliasesUsed, resolvedMarketsByLeague, markets };
}

const { DEFAULT_LEAGUES: DEFAULT_LEAGUES_RB } = require('../../../lib/propprofessor-shared-utils');

// ─── Phase: per-league/market screen fan-out + research + selection ──────────

async function screenRecommendedLeagues(
  ctx,
  { leagues, resolvedMarketsByLeague, markets, limit, screenTimeoutMs, args }
) {
  const allRecommended = [];
  await mapWithConcurrency(
    leagues,
    async (league) => {
      try {
        const leagueMarkets = resolvedMarketsByLeague[league] || markets;
        const marketResults = await mapWithConcurrency(
          leagueMarkets,
          async (market) =>
            runRecommendedMarket({
              handlers: ctx.handlers,
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
        const recommended = selectRecommendedRows(allRows, targetTiersFor(args), limit, {
          getStableTier: getConfidenceTierStable
        });

        {
          const kaiFiltered =
            args.kaiCall != null ? filterRowsByKaiCall(recommended, args.kaiCall) : recommended.slice();
          const movementFiltered =
            args.movement != null ? filterRowsByMovement(kaiFiltered, args.movement) : kaiFiltered;
          const filtered = args.minEV != null ? filterRowsByMinEV(movementFiltered, args.minEV) : movementFiltered;
          const sorted = args.sortBy ? sortRows(filtered, { sortBy: args.sortBy, sortDir: args.sortDir }) : filtered;
          recommended.length = 0;
          for (const r of sorted) recommended.push(r);
        }

        if (recommended.length) {
          let researchResults = [];
          let downgraded = 0;
          if ((args.includeResearch !== undefined ? Boolean(args.includeResearch) : true) && recommended.length) {
            const research = await runResearchOnTopRows({
              rows: recommended,
              limit: recommended.length,
              playerContextFn: ctx.handlers.player_context,
              gameContextFn: getGameContext
            });
            researchResults = research.results;
            if (args.riskDowngrade === true) {
              const beforeCount = recommended.length;
              const highRiskPlayers = new Set(
                research.results.filter((r) => r.riskFlag === 'high').map((r) => String(r.player || '').toLowerCase())
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
  return allRecommended;
}

function targetTiersFor(args) {
  return Array.isArray(args.targetTiers) && args.targetTiers.length ? args.targetTiers : ['TIER 1', 'TIER 2'];
}

// ─── Phase: validation pipeline ────────────────────────────────────────────────

async function validateRecommended(client, ctx, allRecommended, { args, validateAllRB, validateTopRB }) {
  if (args.validate === false) {
    for (const leagueEntry of allRecommended) {
      for (const play of leagueEntry.plays || []) play.validationSkipped = true;
    }
  }

  if (validateAllRB || validateTopRB > 0) {
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
        screenConsensusBookCount: play.consensusBookCount,
        screenExecutionQuality: play.executionQuality,
        screenConsensusEdge: play.edge,
        screenSharpBookConfirmed: play.sharpBookMovementConfirmed || false
      }),
      buildCacheKey: (play) => `${play.gameId}::${play.selection}::${play.market || 'Moneyline'}`,
      rows: allRecommended.flatMap((leagueEntry) =>
        (leagueEntry.plays || []).map((play) => ({ target: play, entry: leagueEntry }))
      ),
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

  for (const leagueEntry of allRecommended) {
    for (const play of leagueEntry.plays || []) {
      applyFinalVerdict(play);
    }
  }
}

// ─── Phase: post-validation filters + response assembly ───────────────────────

function finalizeRecommended(
  allRecommended,
  { args, targetTiers, markets, allAliasesUsed, validateAllRB, validateTopRB }
) {
  // Re-apply targetTiers to the authoritative final tier so a TIER 4 validation
  // result can't leak through a TIER 1-only request.
  for (const entry of allRecommended) {
    if (!Array.isArray(entry.plays)) continue;
    entry.plays = entry.plays.filter((play) => targetTiers.includes(play.finalConfidenceTier || play.confidenceTier));
    entry.count = entry.plays.length;
  }

  for (const entry of allRecommended) {
    if (entry.plays && entry.plays.length) {
      flagContradictoryPlays(entry.plays);
    }
  }

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
  return response;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

async function runRecommendedBets(deps, args = {}) {
  const { client, ctx } = deps;
  clearTierCache();

  const { leagues, allAliasesUsed, resolvedMarketsByLeague, markets } = resolveRecommendedMarkets(args);
  const targetTiers = targetTiersFor(args);
  const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 100;

  const allRecommended = await screenRecommendedLeagues(ctx, {
    leagues,
    resolvedMarketsByLeague,
    markets,
    limit,
    screenTimeoutMs: deps.screenTimeoutMs,
    args
  });

  const validateAllRB = args.validate === true;
  const validateTopRB =
    args.validate === false ? 0 : Number.isFinite(Number(args.validateTop)) ? Number(args.validateTop) : 10;

  await validateRecommended(client, ctx, allRecommended, { args, validateAllRB, validateTopRB });

  const response = finalizeRecommended(allRecommended, {
    args,
    targetTiers,
    markets,
    allAliasesUsed,
    validateAllRB,
    validateTopRB
  });

  const verbosity = String(args.verbosity || 'full').toLowerCase();
  if (verbosity === 'minimal') return formatRecommendedBetsMinimal(response);
  if (verbosity === 'standard') return formatRecommendedBetsStandard(response);
  return response;
}

function createRecommendedBetsHandlers(client, ctx, factoryDeps) {
  const { screenTimeoutMs } = factoryDeps;
  return {
    async recommended_bets(args = {}) {
      return runRecommendedBets({ client, ctx, screenTimeoutMs }, args);
    }
  };
}

module.exports = { createRecommendedBetsHandlers };
