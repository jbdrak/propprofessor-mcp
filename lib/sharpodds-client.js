'use strict';

// SharpOdds public HTTP client seam (Task 2).
//
// Verified public endpoint: https://api.tsp.live/v1/odds (no auth, no cookies).
// Board: GET /v1/odds
// History: GET /v1/odds?action=linehistory&t=SPREAD|TOTAL|ML&d=YYYY-MM-DD
//   &n=<gameId>&s=<sportId>&p=<period>&z=<timezone>&sn=<bookName>
//   &an=<awayTeam>&hn=<homeTeam>&bid=<bookId>&league=<league>
// Verified history envelope: { meta, markets } with
// markets.SPREADS / markets.TOTALS / markets.MONEYLINES.
// The worker fallback endpoint returned empty in the bounded probe and is
// intentionally NOT implemented here.
//
// Design: CommonJS, native fetch only via dependency injection, no request at
// module import, no retry, no polling, no PP auth.

const SHARPODDS_API_ORIGIN = 'https://api.tsp.live';
const SHARPODDS_ODDS_PATH = '/v1/odds';
const HISTORY_ACTION = 'linehistory';
const HISTORY_MARKETS = new Set(['SPREAD', 'TOTAL', 'ML']);
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * @param {{ endpoint: string, status?: number, category: string, message: string }} fields
 * @returns {any}
 */
function sharpError({ endpoint, status, category, message }) {
  const err = /** @type {any} */ (new Error(message));
  err.provider = 'sharpodds';
  err.endpoint = endpoint;
  err.category = category;
  if (status !== undefined) err.status = status;
  return err;
}

function requireFetchImpl(fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    throw sharpError({
      endpoint: `${SHARPODDS_API_ORIGIN}${SHARPODDS_ODDS_PATH}`,
      category: 'config',
      message: 'sharpodds-client: fetchImpl must be a function (dependency-injected fetch)'
    });
  }
}

function setParam(params, key, value) {
  if (value === undefined || value === null || value === '') return;
  params.set(key, String(value));
}

function buildBoardUrl(params) {
  const url = new URL(`${SHARPODDS_API_ORIGIN}${SHARPODDS_ODDS_PATH}`);
  if (params && typeof params === 'object') {
    // Optional passthrough only; the verified board endpoint is bare /v1/odds.
    setParam(url.searchParams, 'd', params.date);
    setParam(url.searchParams, 'z', params.timezone);
    setParam(url.searchParams, 'league', params.league ?? params.leagues);
  }
  return url.toString();
}

function normalizeMarket(market) {
  const upper = String(market || '')
    .trim()
    .toUpperCase();
  if (!HISTORY_MARKETS.has(upper)) {
    throw sharpError({
      endpoint: `${SHARPODDS_API_ORIGIN}${SHARPODDS_ODDS_PATH}`,
      category: 'validation',
      message: `sharpodds-client: invalid market "${market}" (expected SPREAD, TOTAL, or ML)`
    });
  }
  return upper;
}

function buildHistoryUrl(params) {
  const p = params && typeof params === 'object' ? params : {};
  const market = normalizeMarket(p.market);
  if (p.date === undefined || p.date === null || String(p.date).trim() === '') {
    throw sharpError({
      endpoint: `${SHARPODDS_API_ORIGIN}${SHARPODDS_ODDS_PATH}`,
      category: 'validation',
      message: 'sharpodds-client: history requires date (d=YYYY-MM-DD)'
    });
  }
  if (p.gameId === undefined || p.gameId === null || String(p.gameId).trim() === '') {
    throw sharpError({
      endpoint: `${SHARPODDS_API_ORIGIN}${SHARPODDS_ODDS_PATH}`,
      category: 'validation',
      message: 'sharpodds-client: history requires gameId (n=)'
    });
  }
  const url = new URL(`${SHARPODDS_API_ORIGIN}${SHARPODDS_ODDS_PATH}`);
  const q = url.searchParams;
  q.set('action', HISTORY_ACTION);
  q.set('t', market);
  q.set('d', String(p.date));
  q.set('n', String(p.gameId));
  setParam(q, 's', p.sportId);
  setParam(q, 'p', p.period);
  setParam(q, 'z', p.timezone);
  setParam(q, 'sn', p.bookName);
  setParam(q, 'an', p.awayTeam);
  setParam(q, 'hn', p.homeTeam);
  setParam(q, 'bid', p.bookId);
  setParam(q, 'league', p.league);
  return url.toString();
}

function resolveTimeoutMs(options) {
  const raw = options && options.timeoutMs !== undefined ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(n), 30000);
}

async function requestJson(fetchImpl, url, options) {
  requireFetchImpl(fetchImpl);
  const timeoutMs = resolveTimeoutMs(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
    } catch (thrown) {
      if (thrown && thrown.name === 'AbortError') {
        throw sharpError({
          endpoint: url,
          category: 'timeout',
          message: `sharpodds-client: request timed out after ${timeoutMs}ms`
        });
      }
      throw sharpError({
        endpoint: url,
        category: 'network',
        message: `sharpodds-client: request failed (${(thrown && thrown.message) || 'network error'})`
      });
    }
    const status = res && typeof res.status === 'number' ? res.status : 0;
    const ok = res && (typeof res.ok === 'boolean' ? res.ok : status >= 200 && status < 300);
    if (!ok) {
      throw sharpError({
        endpoint: url,
        status,
        category: 'http',
        message: `sharpodds-client: HTTP ${status} from SharpOdds odds endpoint`
      });
    }
    let data;
    try {
      data = await res.json();
    } catch (thrown) {
      throw sharpError({
        endpoint: url,
        status,
        category: 'parse',
        message: `sharpodds-client: malformed JSON (${(thrown && thrown.message) || 'parse error'})`
      });
    }
    return { url, status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBoard(fetchImpl, params, options) {
  // Allow fetchBoard(fetchImpl, options) when second arg looks like options.
  let query = params;
  let opts = options;
  if (
    query &&
    typeof query === 'object' &&
    (query.timeoutMs !== undefined || query.signal !== undefined) &&
    opts === undefined
  ) {
    const { timeoutMs, ...rest } = query;
    if (Object.keys(rest).length === 0) {
      query = undefined;
      opts = { timeoutMs };
    }
  }
  const url = buildBoardUrl(query);
  return requestJson(fetchImpl, url, opts);
}

async function fetchHistory(fetchImpl, params, options) {
  const url = buildHistoryUrl(params);
  return requestJson(fetchImpl, url, options);
}

/**
 * @param {any} [options]
 */
function createSharpOddsClient(options = {}) {
  const { fetchImpl, timeoutMs } = /** @type {any} */ (options || {});
  requireFetchImpl(fetchImpl);
  const boundTimeout = timeoutMs;
  return {
    fetchBoard: (params, options) => fetchBoard(fetchImpl, params, mergeTimeout(options, boundTimeout)),
    fetchHistory: (params, options) => fetchHistory(fetchImpl, params, mergeTimeout(options, boundTimeout)),
    buildBoardUrl,
    buildHistoryUrl
  };
}

function mergeTimeout(options, boundTimeout) {
  if (boundTimeout === undefined) return options;
  if (options && options.timeoutMs !== undefined) return options;
  return { ...(options || {}), timeoutMs: boundTimeout };
}

module.exports = {
  SHARPODDS_API_ORIGIN,
  SHARPODDS_ODDS_PATH,
  HISTORY_ACTION,
  DEFAULT_TIMEOUT_MS,
  buildBoardUrl,
  buildHistoryUrl,
  fetchBoard,
  fetchHistory,
  createSharpOddsClient
};
