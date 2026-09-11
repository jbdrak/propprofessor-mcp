'use strict';

/**
 * Shared mock client factory for fixture-based handler tests.
 *
 * Usage:
 *   const { createMockClient } = require('./fixtures/mock-client');
 *   const { client, calls } = createMockClient();
 *   const handlers = createMcpHandlers({ client });
 *
 * The returned client implements all methods that MCP handlers call.
 * Customize per-test by passing overrides.
 */

const {
  NBA_MONEYLINE_PAYLOAD,
  NBA_SPREAD_PAYLOAD,
  NBA_TOTAL_PAYLOAD,
  MLB_MONEYLINE_PAYLOAD
} = require('./screen-payloads');
const { HISTORY_BY_GAME } = require('./odds-history');

const DEFAULT_SCREEN_PAYLOADS = {
  'NBA:Moneyline': NBA_MONEYLINE_PAYLOAD,
  'NBA:Spread': NBA_SPREAD_PAYLOAD,
  'NBA:Total': NBA_TOTAL_PAYLOAD,
  'MLB:Moneyline': MLB_MONEYLINE_PAYLOAD
};

/**
 * Create a mock SSB client with realistic fixture data.
 * @param {Object} [options]
 * @param {Object} [options.screenPayloads] - Override screen payloads by 'league:market' key.
 * @param {Object} [options.historyByGame] - Override odds history by gameId.
 * @param {Object} [options.healthPayload] - Override health status response.
 * @param {Function} [options.onCall] - Callback `(method, args)` fired on every client call.
 * @returns {{ client: Object, calls: Object }} Mock client and call tracker.
 */
function createMockClient({ screenPayloads = {}, historyByGame = {}, healthPayload = null, onCall = null } = {}) {
  const payloads = { ...DEFAULT_SCREEN_PAYLOADS, ...screenPayloads };
  const history = { ...HISTORY_BY_GAME, ...historyByGame };

  const calls = {
    queryScreenOdds: [],
    queryScreenOddsBestComps: [],
    queryOddsHistory: [],
    querySportsbook: [],
    queryBackendFantasyPicks: [],
    healthStatus: 0,
    getHiddenBets: 0,
    hideBet: [],
    unhideBet: [],
    clearHiddenBets: 0
  };

  function track(method, args) {
    if (onCall) onCall(method, args);
  }

  return {
    calls,
    client: {
      queryScreenOdds(filters = {}) {
        track('queryScreenOdds', filters);
        calls.queryScreenOdds.push(filters);
        const key = `${filters.league || 'NBA'}:${filters.market || 'Moneyline'}`;
        return Promise.resolve(payloads[key] || payloads['NBA:Moneyline']);
      },

      queryScreenOddsBestComps(filters = {}) {
        track('queryScreenOddsBestComps', filters);
        calls.queryScreenOddsBestComps.push(filters);
        const key = `${filters.league || 'NBA'}:${filters.market || 'Moneyline'}`;
        return Promise.resolve(payloads[key] || payloads['NBA:Moneyline']);
      },

      queryOddsHistory({ gameId, selectionId, sportsbooks, lookbackHours } = {}) {
        track('queryOddsHistory', { gameId, selectionId, sportsbooks, lookbackHours });
        calls.queryOddsHistory.push({ gameId, selectionId, sportsbooks, lookbackHours });
        const gameHistory = history[gameId] || {};
        // Filter to requested sportsbooks if provided
        if (Array.isArray(sportsbooks) && sportsbooks.length) {
          const filtered = {};
          for (const book of sportsbooks) {
            if (gameHistory[book]) filtered[book] = gameHistory[book];
          }
          return Promise.resolve(filtered);
        }
        return Promise.resolve(gameHistory);
      },

      querySportsbook(filters = {}) {
        track('querySportsbook', filters);
        calls.querySportsbook.push(filters);
        return Promise.resolve([]);
      },

      queryBackendFantasyPicks(filters = {}) {
        track('queryBackendFantasyPicks', filters);
        calls.queryBackendFantasyPicks.push(filters);
        return Promise.resolve({ rows: [] });
      },

      async healthStatus() {
        track('healthStatus', null);
        calls.healthStatus += 1;
        return (
          healthPayload || {
            ok: true,
            endpoints: { screen: 'ok', sportsbook: 'ok', smart: 'ok', odds_history: 'ok' },
            token: { exp: Math.floor(Date.now() / 1000) + 86400, expiresInSeconds: 86400 }
          }
        );
      },

      async getHiddenBets() {
        calls.getHiddenBets += 1;
        return { rows: [] };
      },

      async hideBet(bet) {
        calls.hideBet.push(bet);
        return { ok: true };
      },

      async unhideBet(id) {
        calls.unhideBet.push(id);
        return { ok: true };
      },

      async clearHiddenBets() {
        calls.clearHiddenBets += 1;
        return { ok: true };
      }
    }
  };
}

module.exports = { createMockClient, DEFAULT_SCREEN_PAYLOADS, HISTORY_BY_GAME };
