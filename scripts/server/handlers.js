'use strict';
/**
 * MCP tool handlers (extracted from scripts/propprofessor-mcp-server.js in v2.0.0).
 *
 * This file owns the createMcpHandlers() factory. The individual tool
 * implementations live in the ./handlers/* modules and are merged in via
 * mergeHandlerModule below. No behavior change vs. v1.7.0 — this is a pure
 * structural refactor; the dispatch table is assembled, not duplicated.
 */

const { createHandlerContext } = require('./handler-context');
const { createHealthHandlers } = require('./handlers/health');
const { createMetaHandlers } = require('./handlers/meta');
const { createStateHandlers } = require('./handlers/state');
const { createScanHandlers } = require('./handlers/scan');
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
const { createScreenRankedHandlers } = require('./handlers/screen-ranked');
const { createSharpPlaysHandlers } = require('./handlers/sharp-plays');
const { createQuickScreenHandlers } = require('./handlers/quick-screen');
const { createRecommendedBetsHandlers } = require('./handlers/recommended-bets');
const { createSlatesUfcDetailsHandlers } = require('./handlers/slates-ufc-details');
const { mergeHandlerModule } = require('./handlers/handler-utils');
const { createPropProfessorClient } = require('../../lib/propprofessor-api');
const { DEFAULT_HISTORY_MIN_INTERVAL_MS } = require('../../lib/propprofessor-screen-history');
const { getGameContext } = require('../../lib/propprofessor-game-context');
const { mapWithConcurrency } = require('../../lib/propprofessor-shared-utils');
const {
  TIER_RANK,
  applyValidatedFields,
  applyFinalVerdict,
  flagContradictoryPlays,
  promoteFinalVerdictToDisplay
} = require('../../lib/bet-verdict');

/**
 * Build the MCP tool-handler dispatch table.
 *
 * @param {Object} [options]
 * @param {import('../../lib/propprofessor-api').PropProfessorClient} [options.client]
 * @param {Function} [options.gameContextFn]
 * @param {number} [options.recommendedBetsScreenTimeoutMs]
 * @param {number} [options.historyMinIntervalMs]
 * @returns {Object} handlers keyed by tool name
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

  // Start with an empty dispatch table; every tool is registered by exactly
  // one extracted module via mergeHandlerModule (which rejects duplicate keys).
  const handlers = {};

  const handlerOwners = new Map();
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
    createTennisScreenHandler(client, { responseCache: ctx.responseCache, responseCacheTtlMs: ctx.responseCacheTtlMs })
  );
  // Core dispatch handlers extracted from the monolithic body below.
  mergeHandlerModule(handlers, handlerOwners, 'screen-ranked', createScreenRankedHandlers(client, ctx));
  mergeHandlerModule(handlers, handlerOwners, 'sharp-plays', createSharpPlaysHandlers(client, ctx));
  mergeHandlerModule(
    handlers,
    handlerOwners,
    'quick-screen',
    createQuickScreenHandlers(client, ctx, {
      responseCache: ctx.responseCache,
      responseCacheTtlMs: ctx.responseCacheTtlMs,
      gameContextFn,
      maybeGc: ctx.maybeGc
    })
  );
  mergeHandlerModule(
    handlers,
    handlerOwners,
    'recommended-bets',
    createRecommendedBetsHandlers(client, ctx, { screenTimeoutMs })
  );
  mergeHandlerModule(handlers, handlerOwners, 'slates-ufc-details', createSlatesUfcDetailsHandlers(client, ctx));

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
