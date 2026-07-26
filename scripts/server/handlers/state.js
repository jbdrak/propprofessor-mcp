'use strict';

/**
 * State management handlers: score timeline, hidden bets.
 * Stateless helpers that clear or query internal caches.
 */

const { clearScoreTimeline } = require('../../../lib/propprofessor-risk-score');

/**
 * @param {import('../../../lib/propprofessor-api').PropProfessorClient} client
 * @param {import('./handler-context').HandlerContext} _ctx
 */
function createStateHandlers(client, _ctx) {
  return {
    async clear_score_timeline() {
      clearScoreTimeline();
      return { ok: true, message: 'Score timeline cache cleared. Tier trajectory data reset.' };
    },

    async manage_hidden_bets(args = {}) {
      const action = String(args.action || '')
        .toLowerCase()
        .trim();
      if (!['list', 'hide', 'unhide', 'clear'].includes(action)) {
        return { ok: false, error: { code: 'INVALID_PARAMS', message: 'action must be list, hide, unhide, or clear' } };
      }

      try {
        switch (action) {
          case 'list':
            return { ok: true, result: await client.getHiddenBets() };
          case 'hide': {
            if (!args.gameId) {
              return { ok: false, error: { code: 'MISSING_PARAMS', message: 'gameId is required' } };
            }
            await client.hideBet(args.gameId, args.selection || null, args.market || null);
            return { ok: true, message: `Bet(s) hidden for game ${args.gameId}.` };
          }
          case 'unhide': {
            if (!args.gameId) {
              return { ok: false, error: { code: 'MISSING_PARAMS', message: 'gameId is required' } };
            }
            await client.unhideBet(args.gameId, args.selection || null, args.market || null);
            return { ok: true, message: `Bet(s) unhidden for game ${args.gameId}.` };
          }
          case 'clear':
            await client.clearHiddenBets();
            return { ok: true, message: 'All hidden bets cleared.' };
          default:
            return { ok: false, error: { code: 'INVALID_PARAMS', message: `Unknown action: ${action}` } };
        }
      } catch (err) {
        return { ok: false, error: { code: 'BACKEND_ERROR', message: String(err.message || err) } };
      }
    }
  };
}

module.exports = { createStateHandlers };
