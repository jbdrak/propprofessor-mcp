'use strict';

/**
 * screen_ranked handler — extracted from createMcpHandlers() in handlers.js.
 *
 * Captures the closure dependencies it needs via the create*Handlers(client, ctx)
 * factory seam used by every other handler module (see screen.js). Behavior is
 * byte-for-byte identical to the previous inline handler: same canonical-cache
 * memoization, same ctx.handlers.runScreenRankedImpl delegation.
 */

const { clearTierCache } = require('../../../lib/propprofessor-risk-score');
const { canonicalizeScreenArgs } = require('../../../lib/propprofessor-shared-utils');

function createScreenRankedHandlers(client, ctx) {
  return {
    async screen_ranked(args = {}) {
      // Reset per-call tier hysteresis so each screen call starts clean
      // (prevents cross-call tier drift from stale cache state).
      clearTierCache();
      // Canonical cache key for stable (gameId, market, book) tuples
      const canonicalKey = canonicalizeScreenArgs(args);

      // If gameId is present, use the canonical cache; otherwise proceed without caching
      if (canonicalKey) {
        // memoize() returns a callable — must INVOKE it to get the response,
        // not hand the function back to the caller.
        return ctx.canonicalScreenCache.memoize(async () => {
          return ctx.handlers.runScreenRankedImpl(client, args);
        }, canonicalKey)();
      }

      // Full-league scan - no caching
      return ctx.handlers.runScreenRankedImpl(client, args);
    }
  };
}

module.exports = { createScreenRankedHandlers };
