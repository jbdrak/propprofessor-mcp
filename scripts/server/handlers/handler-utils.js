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
const SOCCER_COMPETITIONS = new Set([
  'Bundesliga',
  'Champions League',
  'EFL Championship',
  'EPL',
  'Europa League',
  'La Liga',
  'Liga MX',
  'Ligue 1'
]);

function resolveSoccerLeague(league, leagueName) {
  const requested = String(league || '').trim();
  const named = String(leagueName || '').trim();
  const competition = SOCCER_COMPETITIONS.has(requested) ? requested : SOCCER_COMPETITIONS.has(named) ? named : null;
  if (competition) return { league: 'Soccer', leagueName: competition };
  return { league: requested || 'Soccer', leagueName: named || null };
}

function filterRowsByLeagueName(rows, leagueName) {
  if (!Array.isArray(rows) || !String(leagueName || '').trim()) return rows;
  const wanted = String(leagueName).trim().toLowerCase();
  return rows.filter(
    (row) =>
      String(row?.leagueName || '')
        .trim()
        .toLowerCase() === wanted
  );
}

function filterPayloadByLeagueName(payload, leagueName) {
  if (!String(leagueName || '').trim()) return payload;
  if (Array.isArray(payload)) return filterRowsByLeagueName(payload, leagueName);
  if (!Array.isArray(payload?.game_data)) return payload;
  return { ...payload, game_data: filterRowsByLeagueName(payload.game_data, leagueName) };
}

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
 * Merge an extracted handler module without silently losing a registration.
 * Any duplicate registration fails fast instead of being silently overwritten.
 * @param {Object} handlers
 * @param {Map<string, string>} owners
 * @param {string} moduleName
 * @param {Object} moduleHandlers
 * @returns {Object}
 */
function mergeHandlerModule(handlers, owners, moduleName, moduleHandlers) {
  for (const key of Object.keys(moduleHandlers)) {
    const previousOwner = owners.get(key);
    if (previousOwner) {
      throw new Error(`Duplicate MCP handler "${key}" from ${moduleName}; already registered by ${previousOwner}`);
    }
  }

  Object.assign(handlers, moduleHandlers);
  for (const key of Object.keys(moduleHandlers)) {
    owners.set(key, moduleName);
  }
  return handlers;
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
  resolveSoccerLeague,
  filterRowsByLeagueName,
  filterPayloadByLeagueName,
  resolveMarkets,
  mergeHandlerModule,
  buildPositiveEvTarget,
  VERDICT_FIELDS,
  stripVerdictFields
};
