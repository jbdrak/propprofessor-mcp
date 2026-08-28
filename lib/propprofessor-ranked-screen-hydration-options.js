'use strict';

/**
 * Build options for ranked-screen odds-history hydration.
 *
 * @param {object} options - Hydration inputs
 * @returns {object} Hydration options
 */
function buildRankedHydrationOptions({ client, lookbackHours, targetBook, sharpBooks, args }) {
  return {
    client,
    lookbackHours,
    preferredBook: targetBook || null,
    sharpBooks,
    historySportsbooks: sharpBooks,
    enableLineFallback: args.enableHistoryLineFallback !== false,
    ...(Number.isFinite(Number(args.historyMinIntervalMs)) ? { minIntervalMs: Number(args.historyMinIntervalMs) } : {})
  };
}

module.exports = { buildRankedHydrationOptions };
