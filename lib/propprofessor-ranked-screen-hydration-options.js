'use strict';

const { DEFAULT_SHARP_BOOKS } = require('./sharpodds-history-provider');

/**
 * Build options for ranked-screen odds-history hydration.
 *
 * @param {object} options - Hydration inputs
 * @returns {object} Hydration options
 */
function buildRankedHydrationOptions({
  client,
  lookbackHours,
  targetBook,
  sharpBooks,
  sharpOddsBooks,
  args,
  sharpOddsProvider
}) {
  const effectiveSharpOddsBooks =
    Array.isArray(sharpOddsBooks) && sharpOddsBooks.length ? sharpOddsBooks : DEFAULT_SHARP_BOOKS;
  return {
    client,
    lookbackHours,
    preferredBook: targetBook || null,
    sharpBooks,
    sharpOddsBooks: effectiveSharpOddsBooks,
    historySportsbooks: sharpBooks,
    enableLineFallback: args.enableHistoryLineFallback !== false,
    ...(sharpOddsProvider ? { sharpOddsProvider, preferSharpOddsHistory: true } : {}),
    ...(Number.isFinite(Number(args.historyMinIntervalMs)) ? { minIntervalMs: Number(args.historyMinIntervalMs) } : {})
  };
}

module.exports = { buildRankedHydrationOptions };
