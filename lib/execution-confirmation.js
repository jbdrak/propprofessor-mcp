'use strict';

const AMERICAN_QUOTE_PATTERN = /^[+-]?\d+$/;
const PERCENT_BODY_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

const MIN_AMERICAN_ABS = 100;

const AMERICAN_DRIFT_THRESHOLD = 30;
const PERCENTAGE_DRIFT_THRESHOLD = 5;

function parseQuote(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || Math.abs(raw) < MIN_AMERICAN_ABS) return null;
    return { value: raw, isPercentage: false };
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    if (trimmed.endsWith('%')) {
      const body = trimmed.slice(0, -1).trim();
      if (body === '' || !PERCENT_BODY_PATTERN.test(body)) return null;
      const value = Number(body);
      if (!Number.isFinite(value) || value <= 0 || value >= 100) return null;
      return { value, isPercentage: true };
    }
    if (!AMERICAN_QUOTE_PATTERN.test(trimmed)) return null;
    const value = Number(trimmed);
    if (!Number.isFinite(value) || Math.abs(value) < MIN_AMERICAN_ABS) return null;
    return { value, isPercentage: false };
  }

  return null;
}

/**
 * @param {Object} opts
 * @param {*} opts.rankedOdds
 * @param {*} opts.currentOdds
 * @param {Object|null} opts.currentRow
 * @param {string|null} [opts.quoteAsOf]
 * @param {boolean} [opts.ambiguous]
 * @param {Error|string|null} [opts.lookupError]
 * @param {boolean} [opts.skipped]
 * @param {boolean} [opts.matchedViaGameIdChange]
 * @param {string|null} [opts.expectedGameId]
 * @returns {{ status: string, currentOdds: *, quoteAsOf: string|null, gameId: string|null, reason: string }}
 */
function confirmExecution({
  rankedOdds = null,
  currentOdds = null,
  currentRow = null,
  quoteAsOf = null,
  ambiguous = false,
  lookupError = null,
  skipped = false,
  matchedViaGameIdChange = false,
  expectedGameId = null
} = { rankedOdds: null, currentOdds: null, currentRow: null }) {
  const result = {
    status: 'confirmed',
    currentOdds: currentOdds ?? null,
    quoteAsOf,
    gameId: currentRow?.gameId ?? null,
    reason: 'exact quote confirmed'
  };

  if (skipped) return { ...result, status: 'skipped', reason: 'execution confirmation skipped' };
  if (lookupError) return { ...result, status: 'error', reason: String(lookupError instanceof Error ? lookupError.message : lookupError) };
  if (ambiguous) return { ...result, status: 'ambiguous', reason: 'current quote match is ambiguous' };
  if (!currentRow) return { ...result, status: 'gone', reason: 'current ranked bet was not found' };

  if (expectedGameId != null && currentRow.gameId !== expectedGameId && !matchedViaGameIdChange) {
    return { ...result, status: 'ambiguous', reason: `game id mismatch: expected ${expectedGameId} but found ${currentRow.gameId}` };
  }

  const ranked = parseQuote(rankedOdds);
  const current = parseQuote(currentOdds);
  if (!ranked || !current || ranked.isPercentage !== current.isPercentage) {
    return { ...result, status: 'ambiguous', reason: 'ranked and current quotes are not comparable' };
  }

  const drift = Math.round(Math.abs(ranked.value - current.value) * 10000) / 10000;
  const threshold = ranked.isPercentage ? PERCENTAGE_DRIFT_THRESHOLD : AMERICAN_DRIFT_THRESHOLD;
  if (drift > threshold) {
    return {
      ...result,
      status: 'moved',
      reason: `quote moved by ${drift} ${ranked.isPercentage ? 'percentage points' : 'American points'} (threshold ${threshold})`
    };
  }

  if (matchedViaGameIdChange) {
    return { ...result, reason: 'exact quote confirmed after safe game id change' };
  }

  return result;
}

module.exports = { confirmExecution };
