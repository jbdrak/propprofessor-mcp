'use strict';

/**
 * Build options for ranked-screen odds-history hydration.
 *
 * @param {object} options - Hydration inputs
 * @returns {object} Hydration options
 */
function buildRankedHydrationOptions({ client, lookbackHours, targetBook, sharpBooks, sharpOddsBooks, args, sharpOddsProvider }) {
  return {
    client,
    lookbackHours,
    preferredBook: targetBook || null,
    sharpBooks,
    ...(Array.isArray(sharpOddsBooks) && sharpOddsBooks.length ? { sharpOddsBooks } : {}),
    historySportsbooks: sharpBooks,
    enableLineFallback: args.enableHistoryLineFallback !== false,
    ...(sharpOddsProvider ? { sharpOddsProvider, preferSharpOddsHistory: true } : {}),
    ...(Number.isFinite(Number(args.historyMinIntervalMs)) ? { minIntervalMs: Number(args.historyMinIntervalMs) } : {})
  };
}

module.exports = { buildRankedHydrationOptions };
