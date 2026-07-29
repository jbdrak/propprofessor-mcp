'use strict';

const { getSharpBookComparisonSet, ALL_SCREEN_BOOKS, uniqueBooks } = require('./propprofessor-sharp-books');
const { getOddsHistoryLookbackHours } = require('./mcp-runtime-config');
const { summarizeFreshness } = require('./screen-summary');
const { getOddsHistoryStartTimestamp, DEFAULT_LEAGUES } = require('./propprofessor-shared-utils');
const { getOrCreateBreaker, CircuitBreakerOpenError } = require('./propprofessor-circuit-breaker');

// Re-export everything from auth module for backward compatibility
const auth = require('./propprofessor-auth');
const {
  ACCESS_TOKEN_URL,
  DEFAULT_AUTH_FILE,
  DEFAULT_USER_AUTH_FILE,
  REPO_AUTH_FILE,
  // Token persistence
  getTokenCacheFile,
  readTokenCache,
  writeTokenCache,
  isTokenCacheValid,
  clearTokenCache,
  // Auth file resolution
  getExplicitAuthFile,
  uniqueAuthPaths,
  getAuthFileCandidates,
  ensureAuthParentDirectory,
  installAuthFile,
  resolveAuthFile,
  readAuthState,
  inspectAuthSetup,
  // Cookie / domain helpers
  normalizeDomain,
  isPropProfessorDomain,
  isAuthValid,
  getCookieExpiryInfo,
  buildPropProfessorCookieHeader,
  // Token fetch
  fetchAccessToken,
  fetchAccessTokenViaCDP
} = auth;

const BACKEND_SPORTSBOOK_URL = 'https://backend.propprofessor.com/sportsbook';
const BACKEND_SMART_URL = 'https://backend.propprofessor.com/smart';
const BACKEND_ODDS_HISTORY_URL = 'https://backend.propprofessor.com/odds_history_new';
const TRPC_BASE_URL = 'https://app.propprofessor.com/api/trpc';
const SCREEN_BASE_URL = 'https://backend.propprofessor.com';
const SLIPGEN_URL = 'https://slipgen.propprofessor.com/fantasy-picks';
const BACKEND_FANTASY_URL = 'https://backend.propprofessor.com/fantasy';

const TOKEN_REFRESH_SAFETY_MS = 30 * 1000;
const DEFAULT_RETRY_DELAYS_MS = [400, 1200, 2800];
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

// ===== HTTP helpers (non-auth) =====
function serializeTrpcInput(input) {
  return { 0: { json: JSON.stringify(input) } };
}

/**
 * Normalize a selection ID by stripping the leading segment if colon-delimited.
 * @param {string} [selectionId] - The raw selection ID to normalize.
 * @returns {string} Normalized selection ID (empty string if input is empty).
 */
function normalizeSelectionId(selectionId) {
  const raw = String(selectionId || '').trim();
  if (!raw) return '';
  const parts = raw.split(':');
  if (parts.length > 2) return parts.slice(1).join(':');
  return raw;
}

function normalizeScreenLeagueName(league) {
  const raw = String(league || '').trim();
  if (!raw) return raw;
  const upper = raw.toUpperCase();
  const canonical = {
    NBA: 'NBA',
    MLB: 'MLB',
    NFL: 'NFL',
    NHL: 'NHL',
    WNBA: 'WNBA',
    NCAAB: 'NCAAB',
    NCAAF: 'NCAAF',
    SOCCER: 'Soccer',
    'FOOTBALL/SOCCER': 'Soccer',
    FUTBOL: 'Soccer',
    TENNIS: 'Tennis',
    UFC: 'UFC',
    MMA: 'UFC'
  };
  return canonical[upper] || raw;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {{ message?: string, code?: string, category?: string, status?: number, retryable?: boolean, details?: unknown }} [opts]
 * @returns {Error} Error with custom properties.
 */
function createTaggedError({ message, code, category, status, retryable, details } = {}) {
  const error =
    /** @type {Error & { code?: string, category?: string, status?: number, retryable?: boolean, details?: unknown }} */ (
      new Error(message || 'PropProfessor request failed')
    );
  if (code) error.code = code;
  if (category) error.category = category;
  if (status !== undefined) error.status = status;
  if (retryable !== undefined) error.retryable = retryable;
  if (details !== undefined) error.details = details;
  return error;
}

/**
 * Check whether an error is abort-like (AbortError, timeout, or connection abort).
 * @param {*} error - The error to inspect.
 * @returns {boolean} True if the error is an abort or timeout type.
 */
function isAbortLikeError(error) {
  return Boolean(
    error &&
    (error.name === 'AbortError' ||
      error.code === 'ABORT_ERR' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'UND_ERR_ABORTED')
  );
}

/**
 * Create a tagged timeout error with PropProfessor-specific metadata.
 * @param {Object} [options] - Options object.
 * @param {string} [options.source] - Source label for the timeout (e.g. 'request', 'HTTP', 'TRPC').
 * @param {number} [options.timeoutMs] - The timeout duration in milliseconds.
 * @param {Error} [options.cause] - The underlying error that caused the timeout.
 * @returns {Error} Tagged error with code, category, retryable, and details.
 */
function createTimeoutError({ source, timeoutMs, cause } = {}) {
  return createTaggedError({
    message: `PropProfessor ${source || 'request'} timed out after ${timeoutMs}ms`,
    code: 'PROPPROFESSOR_TIMEOUT_ERROR',
    category: 'transport',
    retryable: true,
    details: {
      source: source || 'request',
      timeoutMs,
      cause: cause ? String(cause.message || cause) : undefined
    }
  });
}

async function fetchWithTimeout(
  fetchImpl,
  url,
  options,
  { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, source = 'request' } = {}
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw createTimeoutError({ source, timeoutMs, cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function classifyPropProfessorHttpError({ status, text, source }) {
  const normalizedText = String(text || '').slice(0, 200);
  const lowerText = normalizedText.toLowerCase();
  const isHtmlCheckpoint =
    lowerText.includes('<html') ||
    lowerText.includes('<!doctype') ||
    lowerText.includes('just a moment') ||
    lowerText.includes('cf-chl') ||
    lowerText.includes('captcha');

  if (status === 401) {
    return createTaggedError({
      message: `PropProfessor ${source} auth failed (${status}): ${normalizedText}`,
      code: 'PROPPROFESSOR_AUTH_ERROR',
      category: 'auth',
      status,
      retryable: true
    });
  }

  if (status === 429 && isHtmlCheckpoint) {
    return createTaggedError({
      message: `PropProfessor ${source} transport checkpoint (${status}): ${normalizedText}`,
      code: 'PROPPROFESSOR_TRANSPORT_ERROR',
      category: 'transport',
      status,
      retryable: true
    });
  }

  if (status === 429 || status >= 500) {
    return createTaggedError({
      message: `PropProfessor ${source} backend failed (${status}): ${normalizedText}`,
      code: 'PROPPROFESSOR_BACKEND_ERROR',
      category: 'backend',
      status,
      retryable: true
    });
  }

  return createTaggedError({
    message: `PropProfessor ${source} request failed (${status}): ${normalizedText}`,
    code: 'PROPPROFESSOR_REQUEST_ERROR',
    category: 'validation',
    status,
    retryable: false
  });
}

/**
 * Create a PropProfessor API client with built-in auth, retry, and timeout logic.
 * The returned client object includes methods for querying sportsbooks, screen odds,
 * fantasy picks, odds history, and hidden bet management.
 * @param {Object} [options] - Configuration options.
 * @param {string} [options.authFile] - Path to the auth file. Defaults to resolved auth file.
 * @param {Function} [options.gotScrapingImpl] - got-scraping implementation for access-token fetch.
 * @param {Function} [options.fetchImpl] - Fetch implementation for API calls. Defaults to globalThis.fetch.
 * @param {Function} [options.now] - Function returning current timestamp in milliseconds. Defaults to Date.now.
 * @param {number} [options._tokenSafetyMs] - Token refresh safety margin in ms. Defaults to 30000.
 * @param {number[]} [options.retryDelaysMs] - Retry delay array in ms. Defaults to [400, 1200, 2800].
 * @param {number} [options.requestTimeoutMs] - Request timeout in ms. Defaults to 15000.
 * @returns {Object} Client object with methods: getAccessToken, querySportsbook, querySmartMoney,
 *   queryScreenOdds, queryScreenOddsBestComps, queryFantasyPicks, queryOddsHistory,
 *   healthStatus, getHiddenBets, hideBet, unhideBet, clearHiddenBets.
 * @throws {Error} If fetchImpl is not a function.
 */
function createPropProfessorClient({
  authFile = resolveAuthFile(),
  gotScrapingImpl,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  _tokenSafetyMs = TOKEN_REFRESH_SAFETY_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function');
  }

  let cachedToken = null;
  let tokenRefreshCount = 0;
  let lastTokenRefreshed = null;
  let tokenRefreshPromise = null; // Mutex: prevents concurrent token refreshes

  function invalidateAccessToken() {
    cachedToken = null;
    clearTokenCache(authFile);
    // Don't clear tokenRefreshPromise here — let the in-flight refresh finish
  }

  async function getAccessToken() {
    const nowMs = now();

    // 1. Check in-memory cache
    if (cachedToken && cachedToken.exp && nowMs < cachedToken.exp * 1000 - TOKEN_REFRESH_SAFETY_MS) {
      return cachedToken;
    }

    // 2. Check disk cache
    const diskCache = readTokenCache(authFile);
    if (diskCache && isTokenCacheValid(diskCache, TOKEN_REFRESH_SAFETY_MS)) {
      cachedToken = diskCache;
      return cachedToken;
    }

    // 3. If a refresh is already in flight, wait for it (mutex)
    if (tokenRefreshPromise) {
      return tokenRefreshPromise;
    }

    // 4. Start a new refresh (only one at a time)
    tokenRefreshPromise = (async () => {
      try {
        const newToken = await fetchAccessToken({ authFile, gotScrapingImpl, now });
        cachedToken = newToken;
        tokenRefreshCount += 1;
        lastTokenRefreshed = new Date().toISOString();
        writeTokenCache(cachedToken, authFile);
        return cachedToken;
      } finally {
        tokenRefreshPromise = null;
      }
    })();

    return tokenRefreshPromise;
  }

  async function requestJSON(url, body, { method = 'POST', headers = {}, retryDelays = [] } = {}) {
    // Get or create circuit breaker for this endpoint
    const breaker = getOrCreateBreaker(url);

    // Check if circuit is open before making any requests
    if (!breaker.allowRequest()) {
      throw new CircuitBreakerOpenError(`Circuit breaker for '${url}' is open`, url);
    }

    let lastError = null;
    const attempts = [0, ...retryDelays];
    // v2.1.9: hoist JSON.stringify(body) and the static header scaffolding out
    // of the retry loop. The body serialization is idempotent across retries,
    // and the Origin/Referer/Content-Type headers never change. The
    // Authorization header still depends on the live token (which can be
    // rotated after a 401), so it stays inside the loop.
    const serializedBody = body == null ? undefined : JSON.stringify(body);
    const staticHeaders = {
      'Content-Type': 'application/json',
      Origin: 'https://app.propprofessor.com',
      Referer: 'https://app.propprofessor.com/',
      ...headers
    };
    for (let attempt = 0; attempt < attempts.length; attempt += 1) {
      if (attempt > 0) {
        await sleep(attempts[attempt]);
      }
      try {
        const { token } = await getAccessToken();
        const response = await fetchWithTimeout(
          fetchImpl,
          url,
          {
            method,
            headers: {
              ...staticHeaders,
              Authorization: `Bearer ${token}`
            },
            body: serializedBody
          },
          { timeoutMs: requestTimeoutMs, source: 'HTTP' }
        );

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const status = Number(response.status || 0);
          const retryable = status === 429 || status >= 500 || status === 401;
          lastError = classifyPropProfessorHttpError({ status, text, source: 'HTTP' });
          if (status === 401) {
            invalidateAccessToken();
          }
          if (!retryable || attempt === attempts.length - 1) {
            // Record failure for 429/5xx/401 errors
            if (status === 429 || status >= 500 || status === 401) {
              breaker.recordFailure();
            }
            throw lastError;
          }
          continue;
        }

        // Success - reset the circuit breaker
        breaker.recordSuccess();
        return response.json ? response.json() : JSON.parse(await response.text());
      } catch (error) {
        lastError = error;
        // Record failure for 429/5xx/401 errors
        if (error && (error.status === 429 || error.status >= 500 || error.status === 401)) {
          breaker.recordFailure();
        }
        if (error && error.retryable === false) {
          throw error;
        }
        if (attempt === attempts.length - 1) {
          throw lastError;
        }
      }
    }
    throw lastError || new Error('PropProfessor request failed');
  }

  async function getTrpcJSON(path, input) {
    const delays = [0, ...retryDelaysMs];
    const serializedInput = serializeTrpcInput(input);
    const url = `${TRPC_BASE_URL}/${path}?batch=1&input=${encodeURIComponent(JSON.stringify(serializedInput))}`;

    // Circuit breaker for TRPC endpoint
    const breaker = getOrCreateBreaker(url);
    if (!breaker.allowRequest()) {
      throw new CircuitBreakerOpenError(`Circuit breaker for '${url}' is open`, url);
    }

    let lastError = null;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (attempt > 0) {
        await sleep(delays[attempt]);
      }
      const { token } = await getAccessToken();
      const response = await fetchWithTimeout(
        fetchImpl,
        url,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Referer: 'https://app.propprofessor.com/fantasy'
          }
        },
        { timeoutMs: requestTimeoutMs, source: 'TRPC' }
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const status = Number(response.status || 0);
        const retryable = status === 429 || status >= 500 || status === 401;
        lastError = classifyPropProfessorHttpError({ status, text, source: 'TRPC' });
        if (status === 401) {
          invalidateAccessToken();
        }
        if (!retryable || attempt === delays.length - 1) {
          // Record failure for 429/5xx/401 errors
          if (status === 429 || status >= 500 || status === 401) {
            breaker.recordFailure();
          }
          throw lastError;
        }
        continue;
      }

      // Success - reset the circuit breaker
      breaker.recordSuccess();
      return response.json ? response.json() : JSON.parse(await response.text());
    }

    throw lastError || new Error('PropProfessor TRPC request failed');
  }

  return {
    getAccessToken,
    querySportsbook(filters = {}) {
      return requestJSON(
        BACKEND_SPORTSBOOK_URL,
        {
          isLive: false,
          showBreakOnly: false,
          showTimeoutOnly: false,
          showPeriodEndOnly: false,
          timeAvailable: 0,
          userState: 'tx',
          hideNCAAPlayerProps: false,
          sportsbooks: ['FanDuel', 'DraftKings', 'BetMGM', 'Caesars', 'Pinnacle'],
          leagues: Array.from(DEFAULT_LEAGUES),
          minOdds: -200,
          maxOdds: 500,
          minValue: 2,
          maxValue: 999,
          marketTypes: ['Main Lines', 'Player Props'],
          periodTypes: ['Full Game'],
          minHoursAway: 0,
          maxHoursAway: 24,
          minLiquidity: 0,
          maxLiquidity: 999999,
          weightSettings: {},
          ...filters
        },
        { retryDelays: retryDelaysMs }
      );
    },
    querySmartMoney(filters = {}) {
      return requestJSON(
        BACKEND_SMART_URL,
        {
          userState: 'tx',
          hideNCAAPlayerProps: false,
          sportsbooks: ['Underdog', 'PrizePicks', 'DraftKings6', 'FanDuel', 'DraftKings'],
          leagues: ['NBA', 'MLB', 'NHL'],
          minLiquidity: 0,
          marketTypes: ['Main Lines', 'Player Props', 'Team Totals', 'Game Props'],
          periodTypes: ['Full Game', 'Single Period'],
          minHoursAway: 0,
          maxHoursAway: 24,
          ...filters
        },
        { retryDelays: retryDelaysMs }
      );
    },
    queryScreenOdds(filters = {}) {
      const normalizedFilters = /** @type {any} */ (filters && typeof filters === 'object' ? filters : {});
      const normalizedBooks = uniqueBooks(normalizedFilters.books);
      const books =
        normalizedFilters.books !== undefined && normalizedBooks.length ? normalizedBooks : ALL_SCREEN_BOOKS;
      return requestJSON(
        `${SCREEN_BASE_URL}/screen`,
        {
          market: 'Moneyline',
          games: [],
          participants: [],
          is_live: false,
          ...normalizedFilters,
          books,
          league: normalizeScreenLeagueName(normalizedFilters.league ?? 'NBA')
        },
        { retryDelays: retryDelaysMs }
      );
    },
    queryScreenOddsBestComps(filters = {}) {
      const normalizedFilters = /** @type {any} */ (filters && typeof filters === 'object' ? filters : {});
      const hasExplicitBooks = normalizedFilters.books !== undefined;
      const normalizedBooks = uniqueBooks(normalizedFilters.books);
      const merged = {
        ...normalizedFilters,
        books: hasExplicitBooks
          ? normalizedBooks
          : getSharpBookComparisonSet({ league: normalizedFilters.league ?? 'NBA', market: normalizedFilters.market })
      };
      // For non-major leagues, fall back to full books list since the backend
      // only returns multi-book data when the complete list is passed.
      if (!hasExplicitBooks) {
        const league = (normalizedFilters.league ?? 'NBA').toUpperCase();
        if (!['NBA', 'NFL', 'MLB'].includes(league)) {
          merged.books = ALL_SCREEN_BOOKS;
        }
      }
      return requestJSON(
        `${SCREEN_BASE_URL}/screen`,
        {
          market: 'Moneyline',
          games: [],
          participants: [],
          books: [],
          is_live: false,
          ...merged,
          league: normalizeScreenLeagueName(merged.league ?? 'NBA')
        },
        { retryDelays: retryDelaysMs }
      );
    },
    queryFantasyPicks(filters = {}) {
      const normalizedFilters = filters && typeof filters === 'object' ? filters : {};
      return requestJSON(
        SLIPGEN_URL,
        {
          ...normalizedFilters
        },
        {
          retryDelays: retryDelaysMs,
          headers: {
            Referer: 'https://app.propprofessor.com/fantasy'
          }
        }
      );
    },
    queryBackendFantasyPicks(filters = {}) {
      const normalizedFilters = filters && typeof filters === 'object' ? filters : {};
      return requestJSON(
        BACKEND_FANTASY_URL,
        {
          ...normalizedFilters
        },
        {
          retryDelays: retryDelaysMs,
          headers: {
            Referer: 'https://app.propprofessor.com/fantasy'
          }
        }
      );
    },
    queryOddsHistory(opts = {}) {
      const {
        gameId,
        selectionId,
        startTimestamp,
        sportsbooks = [],
        lookbackHours = getOddsHistoryLookbackHours(),
        nowMs = now()
      } = /** @type {any} */ (opts);
      if (!gameId) {
        throw new Error('gameId is required');
      }
      const normalizedSelectionId = normalizeSelectionId(selectionId);
      if (!normalizedSelectionId) {
        throw new Error('selectionId is required');
      }
      const resolvedStartTimestamp = Number.isFinite(Number(startTimestamp))
        ? Number(startTimestamp)
        : getOddsHistoryStartTimestamp({ lookbackHours, nowMs });
      return requestJSON(
        BACKEND_ODDS_HISTORY_URL,
        {
          gameId,
          selectionId: normalizedSelectionId,
          sportsbooks: Array.isArray(sportsbooks) ? sportsbooks : [],
          startTimestamp: resolvedStartTimestamp
        },
        { retryDelays: retryDelaysMs }
      );
    },
    async healthStatus() {
      const token = await getAccessToken();
      const [screenResult] = await Promise.allSettled([this.queryScreenOdds({})]);
      const screenValue = screenResult.status === 'fulfilled' ? screenResult.value : null;
      const screenRows = Array.isArray(screenValue)
        ? screenValue
        : Array.isArray(screenValue?.game_data)
          ? screenValue.game_data
          : Array.isArray(screenValue?.data)
            ? screenValue.data
            : [];
      const endpoints = {
        screen: screenResult.status === 'fulfilled' ? 'ok' : 'error'
      };
      const ok = endpoints.screen === 'ok';
      const diskCache = readTokenCache(authFile);
      return {
        ok,
        token: {
          exp: token.exp,
          expiresInSeconds: Math.max(0, Math.floor(token.exp - now() / 1000)),
          persistedToDisk: Boolean(diskCache),
          refreshCount: tokenRefreshCount,
          lastRefreshed: lastTokenRefreshed
        },
        endpoints,
        freshness: {
          screen: summarizeFreshness(screenRows, now())
        },
        errors: {
          screen:
            screenResult.status === 'rejected' ? screenResult.reason?.message || String(screenResult.reason) : null
        }
      };
    },
    getHiddenBets() {
      return getTrpcJSON('hidden.getHiddenBets', null);
    },
    hideBet(bet) {
      return getTrpcJSON('hidden.hideBet', bet);
    },
    unhideBet(id) {
      return getTrpcJSON('hidden.unhideBet', { id });
    },
    clearHiddenBets() {
      return getTrpcJSON('hidden.clearHiddenBets', null);
    }
  };
}

module.exports = {
  // API constants
  BACKEND_SMART_URL,
  BACKEND_SPORTSBOOK_URL,
  SCREEN_BASE_URL,
  SLIPGEN_URL,
  TRPC_BASE_URL,
  // Auth (re-exported from propprofessor-auth)
  ACCESS_TOKEN_URL,
  DEFAULT_AUTH_FILE,
  DEFAULT_USER_AUTH_FILE,
  REPO_AUTH_FILE,
  buildPropProfessorCookieHeader,
  clearTokenCache,
  ensureAuthParentDirectory,
  fetchAccessToken,
  fetchAccessTokenViaCDP,
  getAuthFileCandidates,
  getCookieExpiryInfo,
  getExplicitAuthFile,
  getTokenCacheFile,
  inspectAuthSetup,
  installAuthFile,
  isAuthValid,
  isPropProfessorDomain,
  isTokenCacheValid,
  normalizeDomain,
  readAuthState,
  readTokenCache,
  resolveAuthFile,
  uniqueAuthPaths,
  writeTokenCache,
  // HTTP / API utilities
  classifyPropProfessorHttpError,
  createPropProfessorClient,
  createTimeoutError,
  isAbortLikeError,
  normalizeSelectionId,
  getOddsHistoryStartTimestamp
};
