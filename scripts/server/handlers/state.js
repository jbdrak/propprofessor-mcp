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
      const { action } = args;
      if (action === 'list') {
        const result = await client.getHiddenBets();
        return { ok: true, action, result };
      }
      if (action === 'hide') {
        if (!args.bet || typeof args.bet !== 'object') {
          const error = new Error('The bet parameter is required and must be an object.');
          error.code = 'MISSING_BET';
          error.category = 'validation';
          error.status = 400;
          throw error;
        }
        const result = await client.hideBet(args.bet);
        return { ok: true, action, result };
      }
      if (action === 'unhide') {
        if (!args.id) {
          const error = new Error('The id parameter is required.');
          error.code = 'MISSING_ID';
          error.category = 'validation';
          error.status = 400;
          throw error;
        }
        const result = await client.unhideBet(args.id);
        return { ok: true, action, result };
      }
      if (action === 'clear') {
        const result = await client.clearHiddenBets();
        return { ok: true, action, result };
      }
      const error = new Error(`Unknown action: ${action}. Must be one of: list, hide, unhide, clear.`);
      error.code = 'INVALID_ACTION';
      error.category = 'validation';
      error.status = 400;
      throw error;
    }
  };
}

module.exports = { createStateHandlers };
