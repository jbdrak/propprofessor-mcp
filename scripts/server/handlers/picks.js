'use strict';

/**
 * Pick tracking handlers: log, resolve, history, stats.
 * Extracted from createMcpHandlers() in handlers.js.
 */

/**
 * @param {import('../../../lib/ssb-api').SSBClient} client
 * @param {import('./handler-context').HandlerContext} ctx
 */
function createPicksHandlers(client, _ctx) {
  return {
    async log_pick(args = {}) {
      const { gameId, market, selection, book, odds, stake, result = null } = args;
      if (!gameId || !market || !selection || !book || !stake) {
        return {
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'gameId, market, selection, book, and stake are required' }
        };
      }
      try {
        const response = await client.logPick({ gameId, market, selection, book, odds, stake, result });
        return { ...response, ok: true };
      } catch (err) {
        return { ok: false, error: { code: 'BACKEND_ERROR', message: err?.message || String(err) } };
      }
    },

    async resolve_pick(args = {}) {
      const { id, result } = args;
      if (!id) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'id is required' } };
      }
      if (!result) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'result is required' } };
      }
      try {
        const response = await client.resolvePick(id, result);
        return { ...response, ok: true, message: `Pick ${id} resolved as ${result}.` };
      } catch (err) {
        return { ok: false, error: { code: 'BACKEND_ERROR', message: err?.message || String(err) } };
      }
    },

    async get_pick_history(args = {}) {
      const { league, market, limit } = args;
      try {
        const result = await client.getPickHistory({ league, market, limit });
        return { ok: true, result, count: Array.isArray(result) ? result.length : 0 };
      } catch (err) {
        return { ok: false, error: { code: 'BACKEND_ERROR', message: err?.message || String(err) } };
      }
    },

    async get_pick_stats(_args = {}) {
      try {
        const result = await client.getPickStats();
        return { ok: true, result, ...result };
      } catch (err) {
        return { ok: false, error: { code: 'BACKEND_ERROR', message: err?.message || String(err) } };
      }
    }
  };
}

module.exports = { createPicksHandlers };
