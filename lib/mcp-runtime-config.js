'use strict';

const { LruCache } = require('./propprofessor-lru-cache');

const DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS = 6;
const DEFAULT_CACHE_TTL_MS = 120_000; // 2 minutes
const DEFAULT_CACHE_MAX_ENTRIES = 50;
// Per-entry response-cache size cap.  A single quick_screen response with
// validation + research for 10 leagues can balloon to 20-50 MB.  Capping at
// 5 MB keeps the aggregate cache budget bounded (~250 MB at 50 entries)
// instead of unbounded (potential 2+ GB).  Oversized entries are measured
// via JSON.stringify(value).length and silently dropped above this threshold.
const DEFAULT_CACHE_MAX_ENTRY_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
// Cross-call odds-history cache. /odds_history_new responses change with
// movement (which happens on game-time scale, seconds to minutes) but the
// underlying selectionId+gameId+sportsbooks+startTimestamp tuple is stable
// for the duration of a slate. A 5-minute TTL is enough to absorb the
// "screen_ranked then validate_play" workflow without serving truly stale
// data. Sized to ~250 entries (vs the 50-entry response cache) because a
// full NBA slate can easily produce 100+ unique (gameId, selectionId) pairs.
const DEFAULT_ODDS_HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ODDS_HISTORY_CACHE_MAX_ENTRIES = 250;

let _oddsHistoryCache = null;

/**
 * Returns the local timezone to use for date/time display.
 * Reads from the LOCAL_TIMEZONE environment variable, defaulting to
 * America/Chicago.
 * @returns {string} IANA timezone identifier (e.g. 'America/Chicago').
 */
function getLocalTimezone() {
  return process.env.LOCAL_TIMEZONE || 'America/Chicago';
}

/**
 * Format an epoch-ms as a YYYY-MM-DD calendar-day key in the given IANA
 * timezone. Use this for ALL card-window date filtering so games tipping
 * later the same LOCAL day are not orphaned by the UTC midnight flip
 * (e.g. a WNBA game at 8pm CT that UTC-dates to the next day).
 * @param {number} ms - epoch milliseconds
 * @param {string} [tz] - IANA timezone (defaults to getLocalTimezone())
 * @returns {string|null} 'YYYY-MM-DD' or null if ms is not finite
 */
function localDateKey(ms, tz) {
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || getLocalTimezone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10); // last-resort fallback
  }
}

/**
 * Returns the number of hours to look back when fetching odds history.
 * Reads from the PROPPROFESSOR_ODDS_HISTORY_LOOKBACK_HOURS environment variable
 * (or the optional `value` parameter), defaulting to 6.
 * @param {string|number} [value] - Override value (takes precedence over env var).
 * @returns {number} Positive number of hours.
 */
function getOddsHistoryLookbackHours(value = process.env.PROPPROFESSOR_ODDS_HISTORY_LOOKBACK_HOURS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS;
}

/**
 * Returns the cache TTL in milliseconds.
 * Reads from the PROPPROFESSOR_CACHE_TTL_MS environment variable,
 * defaulting to 60 000 (1 minute).
 * @returns {number} Positive cache TTL in milliseconds.
 */
function getCacheTtlMs() {
  const parsed = Number(process.env.PROPPROFESSOR_CACHE_TTL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CACHE_TTL_MS;
}

/**
 * Returns the maximum number of entries in the LRU cache.
 * Reads from the PROPPROFESSOR_CACHE_MAX environment variable,
 * defaulting to 50.
 * @returns {number} Positive maximum cache entries.
 */
function getCacheMaxEntries() {
  const parsed = Number(process.env.PROPPROFESSOR_CACHE_MAX);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CACHE_MAX_ENTRIES;
}

/**
 * Returns the per-entry response-cache size cap in bytes.
 * Reads from PROPPROFESSOR_CACHE_MAX_ENTRY_SIZE_BYTES, defaulting to 5 MB.
 * Set to 0 to disable the cap (pre-2026-07-17 behaviour).
 * @returns {number} Max bytes per cached entry (0 = no cap).
 */
function getCacheMaxEntrySizeBytes() {
  const parsed = Number(process.env.PROPPROFESSOR_CACHE_MAX_ENTRY_SIZE_BYTES);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CACHE_MAX_ENTRY_SIZE_BYTES;
}

/**
 * Get the cross-call odds-history LRU cache. Shared across all callers in
 * the same process. The TTL and max-entries are fixed at module init so a
 * single LruCache instance can be reused (constructing a fresh one per call
 * would defeat the purpose). The first call wins — there is intentionally
 * no per-call override, since the cross-call dedup contract is the point.
 *
 * @returns {LruCache} The shared cross-call odds-history cache.
 */
function getOddsHistoryCache() {
  if (!_oddsHistoryCache) {
    _oddsHistoryCache = new LruCache(DEFAULT_ODDS_HISTORY_CACHE_MAX_ENTRIES);
  }
  return _oddsHistoryCache;
}

module.exports = {
  DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CACHE_MAX_ENTRIES,
  DEFAULT_ODDS_HISTORY_CACHE_TTL_MS,
  DEFAULT_ODDS_HISTORY_CACHE_MAX_ENTRIES,
  getLocalTimezone,
  localDateKey,
  getOddsHistoryLookbackHours,
  getCacheTtlMs,
  getCacheMaxEntries,
  getCacheMaxEntrySizeBytes,
  getOddsHistoryCache
};
