'use strict';

/**
 * Run one recommended-bets league/market screen with a bounded timeout.
 * A stalled or failed market contributes no rows to the aggregate result.
 *
 * @param {Object} options
 * @param {Object} options.handlers
 * @param {string} options.league
 * @param {string} options.market
 * @param {string[]} [options.books]
 * @param {number} options.limit
 * @param {boolean} [options.compact]
 * @param {string[]} [options.fields]
 * @param {string[]} [options.include]
 * @param {boolean} [options.skipHistory]
 * @param {number} options.screenTimeoutMs
 * @returns {Promise<Object[]>}
 */
async function runRecommendedMarket({
  handlers,
  league,
  market,
  books,
  limit,
  compact,
  fields,
  include,
  skipHistory,
  screenTimeoutMs
}) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('screen timeout')), screenTimeoutMs);
  });

  try {
    const screenResult = await Promise.race([
      handlers.screen_ranked({
        league,
        market,
        books,
        limit,
        is_live: false,
        includeAll: false,
        debug: false,
        compact: Boolean(compact),
        fields: Array.isArray(fields) ? fields : undefined,
        include: Array.isArray(include) ? include : undefined,
        skipHistory: skipHistory === true
      }),
      timeoutPromise
    ]);
    const rows = Array.isArray(screenResult?.result) ? screenResult.result : [];
    return rows.map((row) => ({ ...row, _market: market }));
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { runRecommendedMarket };
