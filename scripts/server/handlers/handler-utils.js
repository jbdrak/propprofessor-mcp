'use strict';

/**
 * Handler utility functions extracted from the createMcpHandlers() closure.
 * These were inline helpers that prevented handler extraction.
 */

const { resolveMarketName } = require('../../../lib/propprofessor-shared-utils');

/**
 * Strip undefined values so they don't override API client defaults via spread.
 * @param {Object} obj
 * @returns {Object}
 */
function defined(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}

/**
 * Resolve market alias(es) in args using the league context.
 */
function resolveMarkets(args, league, defaultMarket = 'Moneyline') {
  const leagueKey = league ? String(league).trim().toUpperCase() : '';
  const result = { single: defaultMarket, array: [], aliasesUsed: [] };

  // Markets array takes precedence
  if (Array.isArray(args.markets) && args.markets.length) {
    result.array = args.markets.map((m) => {
      const resolved = resolveMarketName(m, leagueKey);
      if (resolved.wasAliased) {
        result.aliasesUsed.push(`${m} → ${resolved.resolved}`);
      }
      return resolved.resolved;
    });
    result.single = result.array[0];
  } else if (Array.isArray(args.markets) && args.markets.length === 0) {
    // Empty array stays empty
    result.array = [];
  } else if (args.market !== undefined && args.market !== null) {
    // Single market was provided
    const market = String(args.market).trim();
    const resolved =
      market.toLowerCase() === 'moneyline'
        ? { resolved: market, wasAliased: false }
        : resolveMarketName(market, leagueKey);
    result.single = resolved.resolved;
    result.array = [result.single];
    if (resolved.wasAliased) {
      result.aliasesUsed.push(`${args.market} → ${resolved.resolved}`);
    }
  }

  // If only markets array provided (no single market explicit), use first resolved
  if (args.market === undefined && result.array.length > 0) {
    result.single = result.array[0];
  }

  return result;
}

/**
 * Build a normalized +EV target object from a play row for validation output.
 */
function buildPositiveEvTarget(play = {}) {
  const homeTeam = String(play.homeTeam || '').trim();
  const awayTeam = String(play.awayTeam || '').trim();
  const participant = String(play.participant || play.selection || '').trim();
  const selection = String(play.selection || participant).trim();
  const game = homeTeam && awayTeam ? `${awayTeam} vs ${homeTeam}` : String(play.game || play.matchup || '').trim();
  return {
    book: String(play.book || play.sportsbook || '').trim(),
    playType: String(play.market || play.marketType || '').trim(),
    pick: selection,
    selection,
    participant,
    game,
    odds: play.odds,
    league: String(play.league || '').trim(),
    gameId: play.gameId ?? play.game_id ?? null,
    selectionId: play.selectionId ?? play.selection_id ?? null
  };
}

/**
 * Fields to strip when removing verdict signal from candidate rows.
 */
const VERDICT_FIELDS = [
  'kaiCall',
  'displayTier',
  'finalVerdict',
  'finalConfidenceTier',
  'validatedTier',
  'validatedVerdict',
  'validatedConfidenceTier',
  'validatedConsensusDrift',
  'validatedDriftReason',
  'validatedUnverified',
  'validatedReconcileOverridden',
  'validatedReconcileReason',
  'validatedRiskFlags',
  'rationale'
];

/**
 * Strip verdict fields from a candidate row.
 * Keeps tier-based signal (confidenceTier, edge, movement, risk) while
 * removing the oscillating verdict layer that confuses agents and users.
 */
function stripVerdictFields(candidate) {
  for (const field of VERDICT_FIELDS) {
    delete candidate[field];
  }
}

module.exports = {
  defined,
  resolveMarkets,
  buildPositiveEvTarget,
  VERDICT_FIELDS,
  stripVerdictFields
};
