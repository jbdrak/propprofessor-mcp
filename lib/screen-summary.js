'use strict';

const { americanOddsToImpliedProbability, average } = require('./ssb-shared-utils');
const { extractRowFreshnessInfo } = require('./screen-parser');

/**
 * Summarize freshness information for an array of rows.
 * Computes newest/oldest age, stale count, and timestamp source distribution.
 * @param {Array<Object>} rows - Array of row data objects.
 * @param {number} [nowMs=Date.now()] - Current time in milliseconds.
 * @param {Object} [options={}] - Options with optional maxAgeMs.
 * @param {number} [options.maxAgeMs] - Max age in ms before a row is considered stale.
 * @returns {{ rowCount: number, newestAgeMs: number|null, oldestAgeMs: number|null, staleCount: number, stale: boolean, freshnessFallbackUsed: boolean, timestampSources: Object.<string, number> }}
 */
function summarizeFreshness(rows, nowMs = Date.now(), options = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const rowCount = sourceRows.length;
  const freshnessInfos = sourceRows.map(extractRowFreshnessInfo).filter((info) => info && Number.isFinite(info.ms));

  if (!freshnessInfos.length) {
    return {
      rowCount,
      newestAgeMs: rowCount ? 0 : null,
      oldestAgeMs: rowCount ? 0 : null,
      staleCount: 0,
      stale: false,
      freshnessFallbackUsed: rowCount > 0,
      timestampSources: rowCount > 0 ? { response_received: rowCount } : {}
    };
  }

  const freshnessMs = freshnessInfos.map((info) => Math.max(0, nowMs - info.ms));
  const newestAgeMs = Math.min(...freshnessMs);
  const oldestAgeMs = Math.max(...freshnessMs);
  const maxAgeMs = Number(options?.maxAgeMs);
  const staleCount =
    Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? freshnessMs.filter((age) => age > maxAgeMs).length : 0;
  const timestampSources = freshnessInfos.reduce((acc, info) => {
    acc[info.source] = (acc[info.source] || 0) + 1;
    return acc;
  }, {});

  return {
    rowCount,
    newestAgeMs,
    oldestAgeMs,
    staleCount,
    stale: staleCount > 0,
    freshnessFallbackUsed: false,
    timestampSources
  };
}

/**
 * Summarize comparison books that have available odds for a given odds key.
 * @param {Array<{ book: string, odds: Object }>} compBooks - Array of comparison book objects.
 * @param {string} oddsKey - Odds key to check (e.g. 'odds1', 'odds2').
 * @returns {{ marketBookCount: number, marketBooks: string[] }}
 */
function summarizeComparisonBooks(compBooks, oddsKey) {
  const availableBooks = compBooks.filter((item) => Number.isFinite(item?.odds?.[oddsKey]));
  return {
    marketBookCount: availableBooks.length,
    marketBooks: availableBooks.map((item) => item.book)
  };
}

/**
 * Summarize support books that have a valid implied probability for a given odds key.
 * @param {Array<{ book: string, odds: Object }>} compBooks - Array of comparison book objects.
 * @param {string} oddsKey - Odds key to check (e.g. 'odds1', 'odds2').
 * @returns {{ supportBookCount: number, supportBooks: string[] }}
 */
function summarizeSupportBooks(compBooks, oddsKey) {
  const supportBooks = compBooks.filter((item) =>
    Number.isFinite(americanOddsToImpliedProbability(item?.odds?.[oddsKey]))
  );
  return {
    supportBookCount: supportBooks.length,
    supportBooks: supportBooks.map((item) => item.book)
  };
}

/**
 * Classify the execution quality of a target book's odds against comparison book odds.
 * @param {{ targetOdds: number, comparisonOdds: number[] }} params - Target odds and comparison odds array.
 * @returns {'best'|'playable'|'bad'|'unknown'} Quality classification.
 */
function classifyExecutionQuality({ targetOdds, comparisonOdds }) {
  const finite = comparisonOdds.filter(Number.isFinite);
  if (!Number.isFinite(targetOdds) || !finite.length) return 'unknown';
  const best = Math.max(...finite);
  const spread = Math.abs(targetOdds - best);
  if (spread > 300) return 'bad'; // off-market / stale price
  if (targetOdds >= best) return 'best';
  if (targetOdds >= best - 10) return 'playable';
  return 'bad';
}

/**
 * Classify the strength of cross-book consensus for a selection.
 * Based on how many comparison books have valid implied-probability odds for that side.
 *
 * @param {number} consensusBookCount - Number of books with valid odds.
 * @returns {'strong'|'moderate'|'weak'|'single_book'|'none'} Consensus strength classification.
 */
function classifyConsensusStrength(consensusBookCount) {
  const count = Number(consensusBookCount) || 0;
  if (count >= 3) return 'strong';
  if (count === 2) return 'moderate';
  if (count === 1) return 'weak';
  return 'none';
}

/**
 * Compute a weighted consensus probability when book coverage is sparse.
 * When only 1-2 books post odds, weight higher-liquidity books more.
 * Falls back to simple average when 3+ books are available.
 *
 * @param {Array<{book: string, odds: Object}>} compBooks - Comparison books with odds.
 * @param {string} oddsKey - Odds key to use (e.g. 'odds1', 'odds2').
 * @returns {{ weightedProb: number|null, bookCount: number, method: 'weighted'|'average'|'none' }}
 */
function computeWeightedConsensus(compBooks, oddsKey) {
  const withValidOdds = compBooks.filter((item) =>
    Number.isFinite(americanOddsToImpliedProbability(item.odds[oddsKey]))
  );
  const bookCount = withValidOdds.length;
  if (bookCount === 0) return { weightedProb: null, bookCount: 0, method: 'none' };
  if (bookCount >= 3) {
    const avg = average(withValidOdds.map((item) => americanOddsToImpliedProbability(item.odds[oddsKey])));
    return { weightedProb: avg, bookCount, method: 'average' };
  }
  // Weighted: Pinnacle gets 2x weight as the sharpest book
  let totalWeight = 0;
  let weightedSum = 0;
  for (const item of withValidOdds) {
    const prob = americanOddsToImpliedProbability(item.odds[oddsKey]);
    const weight = item.book === 'Pinnacle' ? 2 : 1;
    weightedSum += prob * weight;
    totalWeight += weight;
  }
  return { weightedProb: totalWeight > 0 ? weightedSum / totalWeight : null, bookCount, method: 'weighted' };
}

module.exports = {
  classifyConsensusStrength,
  classifyExecutionQuality,
  computeWeightedConsensus,
  summarizeComparisonBooks,
  summarizeFreshness,
  summarizeSupportBooks
};
