'use strict';

const { getSharpBookComparisonSet, ALL_SCREEN_BOOKS, uniqueBooks } = require('./propprofessor-sharp-books');
const {
  getOddsHistoryLookbackHours,
  getOddsHistoryCache,
  DEFAULT_ODDS_HISTORY_CACHE_TTL_MS
} = require('./mcp-runtime-config');
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
  fetchAccessTokenViaCDP,
  fetchAccessTokenViaEgo
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
const ODDS_HISTORY_MIN_INTERVAL_MS = 100;
const ODDS_HISTORY_MAX_CONCURRENCY = 1;
// Local safety window: the odds-history budget applies per rolling window. When
// the window is exhausted, calls fail fast (zero network) until the window
// rolls over. This is a self-imposed guard, NOT a server signal — it never
// persists as a halt. The budget is env-tunable (PP_ODDS_HISTORY_BUDGET) so a
// wide all-sport scan can hydrate + validate a meaningful slate; real upstream
// 429s are still handled with their own cooldown + retry below, independent of
// this local window.
const ODDS_HISTORY_WINDOW_MS = 5 * 60 * 1000;
const ODDS_HISTORY_REQUEST_BUDGET = readOddsHistoryBudget();
function readOddsHistoryBudget() {
  const raw = process.env.PP_ODDS_HISTORY_BUDGET;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 25) return Math.floor(parsed);
  return 2000;
}
// Short safe default cooldown for a REAL upstream 429 that carried no usable
// Retry-After hint. Bounded by MAX_RETRY_AFTER_MS so a long/errant hint can
// never stall the account for minutes.
const DEFAULT_429_COOLDOWN_MS = 30 * 1000;
const oddsHistoryGateStates = new Map();
const oddsHistoryInflight = new Map();
// Cap on how long a Retry-After (RFC 7231) hint from a 429 response is
// honored. A long/errant hint (minutes or hours) must not stall a single
// logical request indefinitely; past this bound we retry on the generic
// schedule instead.
const MAX_RETRY_AFTER_MS = 30 * 1000;

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
    MMA: 'UFC',
    MLS: 'MLS',
    'MAJOR LEAGUE SOCCER': 'MLS'
  };
  return canonical[upper] || raw;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOddsHistoryGateState(gateKey) {
  let state = oddsHistoryGateStates.get(gateKey);
  if (!state) {
    state = {
      startTail: Promise.resolve(),
      active: 0,
      waiters: [],
      nextRequestAt: 0,
      budgetStartedAt: Date.now(),
      requestsStarted: 0,
      haltedUntil: 0,
      haltedError: null
    };
    oddsHistoryGateStates.set(gateKey, state);
  }
  return state;
}

function createOddsHistoryBudgetError() {
  const error = createTaggedError({
    message: 'Odds history request budget exhausted; history is degraded for this scan',
    code: 'ODDS_HISTORY_BUDGET_EXHAUSTED',
    category: 'throttle',
    retryable: true
  });
  error.name = 'OddsHistoryBudgetError';
  return error;
}

function buildOddsHistoryCacheKey(authFile, { gameId, selectionId, sportsbooks, startTimestamp }) {
  const books = Array.isArray(sportsbooks) ? [...sportsbooks].sort() : [];
  const startMinute = Number.isFinite(Number(startTimestamp)) ? Math.floor(Number(startTimestamp) / 60000) : null;
  return JSON.stringify([authFile, gameId, selectionId, books, startMinute]);
}

async function acquireOddsHistorySlot(state, minIntervalMs = ODDS_HISTORY_MIN_INTERVAL_MS) {
  if (state.active < ODDS_HISTORY_MAX_CONCURRENCY) {
    state.active += 1;
  } else {
    await new Promise((resolve) => state.waiters.push(resolve));
  }

  const start = state.startTail.then(async () => {
    const now = Date.now();
    if (now - state.budgetStartedAt >= ODDS_HISTORY_WINDOW_MS) {
      state.budgetStartedAt = now;
      state.requestsStarted = 0;
    }
    if (state.haltedUntil && now >= state.haltedUntil) {
      state.haltedUntil = 0;
      state.haltedError = null;
    }
    if (state.haltedError) throw state.haltedError;

    const waitMs = Math.max(0, state.nextRequestAt - now);
    if (waitMs > 0) await sleep(waitMs);
    if (state.haltedError) throw state.haltedError;
    if (state.requestsStarted >= ODDS_HISTORY_REQUEST_BUDGET) {
      // Local budget exhaustion fails THIS caller only — no persistent
      // halt (haltedError stays null). Callers keep failing fast while the
      // window is exhausted, with zero network traffic, until the window
      // rolls over. A broad scan's exhaustion must never poison a later
      // targeted lookup from a different request context.
      throw createOddsHistoryBudgetError();
    }

    state.nextRequestAt = Date.now() + minIntervalMs;
    state.requestsStarted += 1;
  });
  state.startTail = start.catch(() => undefined);
  try {
    await start;
  } catch (error) {
    releaseOddsHistorySlot(state);
    throw error;
  }
}

function releaseOddsHistorySlot(state) {
  const next = state.waiters.shift();
  if (next) next();
  else state.active -= 1;
}

async function runOddsHistoryRequest(gateKey, requestFn, { minIntervalMs = ODDS_HISTORY_MIN_INTERVAL_MS } = {}) {
  const state = getOddsHistoryGateState(gateKey);
  await acquireOddsHistorySlot(state, minIntervalMs);
  try {
    try {
      return await requestFn();
    } catch (error) {
      // A REAL upstream 429 halts the gate for a bounded cooldown: honor a
      // Retry-After hint (capped at MAX_RETRY_AFTER_MS) when the backend
      // sent one, otherwise fall back to a short safe default. Local budget
      // exhaustion never persists (see acquireOddsHistorySlot), and an open
      // circuit breaker needs NO gate halt — the breaker's own recovery
      // timing governs, and it fails fast without network while open.
      if (Number(error?.status) === 429) {
        const retryAfterMs = Number(error?.retryAfterMs);
        const cooldownMs =
          Number.isFinite(retryAfterMs) && retryAfterMs > 0
            ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
            : DEFAULT_429_COOLDOWN_MS;
        state.haltedError = error;
        state.haltedUntil = Date.now() + cooldownMs;
      } else if (error?.code === 'CIRCUIT_BREAKER_OPEN') {
        // The request never reached the network, so refund the local budget
        // slot — otherwise circuit-open churn would burn the odds-history
        // window (default 300 calls per 5 min, env PP_ODDS_HISTORY_BUDGET)
        // and poison it for after the breaker recovers.
        state.requestsStarted = Math.max(0, state.requestsStarted - 1);
      }
      throw error;
    }
  } finally {
    releaseOddsHistorySlot(state);
  }
}

/**
 * Remaining calls in the current local odds-history budget window for an
 * account. Lets bounded consumers (e.g. the CLI tennis fallback) size their
 * history spend to what actually remains instead of blindly trying hundreds.
 *
 * @param {string} gateKey - Auth file path used as the gate key.
 * @returns {number} Remaining local budget calls (0..ODDS_HISTORY_REQUEST_BUDGET).
 */
function getOddsHistoryBudgetRemaining(gateKey) {
  const state = oddsHistoryGateStates.get(gateKey);
  if (!state) return ODDS_HISTORY_REQUEST_BUDGET;
  const now = Date.now();
  if (now - state.budgetStartedAt >= ODDS_HISTORY_WINDOW_MS) {
    return ODDS_HISTORY_REQUEST_BUDGET;
  }
  return Math.max(0, ODDS_HISTORY_REQUEST_BUDGET - state.requestsStarted);
}

/**
 * Parse an RFC 7231 Retry-After header into a bounded millisecond delay.
 * Only meaningful for HTTP 429 (Too Many Requests) responses. Returns null
 * when the header is absent or not a positive number of seconds (including
 * the HTTP-date form), so callers keep their generic retry schedule. The
 * value is capped at MAX_RETRY_AFTER_MS so an errant long hint cannot stall
 * a logical request indefinitely.
 *
 * @param {{ get?: (name: string) => string | null } | null | undefined} headers - Response headers.
 * @returns {number | null} Capped delay in milliseconds, or null when absent/malformed.
 */
function parseRetryAfterDelayMs(headers) {
  const raw = headers?.get?.('Retry-After');
  if (raw == null || raw === '') return null;
  const seconds = Number(String(raw).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS);
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
 * @param {number} [options.oddsHistoryMinIntervalMs] - Internal odds-history pacing override in ms. Defaults to 100.
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
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  oddsHistoryMinIntervalMs = ODDS_HISTORY_MIN_INTERVAL_MS
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function');
  }

  const requestedOddsHistoryMinIntervalMs = Number(oddsHistoryMinIntervalMs);
  const effectiveOddsHistoryMinIntervalMs =
    Number.isFinite(requestedOddsHistoryMinIntervalMs) && requestedOddsHistoryMinIntervalMs >= 0
      ? requestedOddsHistoryMinIntervalMs
      : ODDS_HISTORY_MIN_INTERVAL_MS;

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

  async function requestJSON(
    url,
    body,
    { method = 'POST', headers = {}, retryDelays = [], failFast429WithoutRetryAfter = false } = {}
  ) {
    // Get or create circuit breaker for this endpoint
    const breaker = getOrCreateBreaker(url);

    // Check if circuit is open before making any requests
    if (!breaker.allowRequest()) {
      throw new CircuitBreakerOpenError(`Circuit breaker for '${url}' is open`, url);
    }

    /** @type {Error & { retryAfterMs?: number } | null} */
    let lastError = null;
    const attempts = [0, ...retryDelays];
    // Throttle-aware retry: when a 429 response carries a Retry-After hint,
    // the NEXT attempt sleeps for the (capped) header delay instead of the
    // generic schedule delay. Only 429 re-arms this; 401/5xx keep the
    // generic schedule untouched.
    let retryAfterDelayMs = null;
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
        await sleep(retryAfterDelayMs ?? attempts[attempt]);
      }
      // Consumed above; a fresh 429 hint from this attempt (if any) re-arms it.
      retryAfterDelayMs = null;
      // Track whether this attempt already recorded a breaker failure so the
      // response branch and the catch branch never double-count one logical
      // request (terminal 429/5xx/401 would otherwise be recorded twice).
      let failureRecorded = false;
      let noRetry = false;
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
          if (status === 429) {
            retryAfterDelayMs = parseRetryAfterDelayMs(response.headers);
            // Attach the bounded hint so the odds-history gate can honor a
            // short Retry-After as its cooldown instead of a fixed default.
            if (retryAfterDelayMs !== null) lastError.retryAfterMs = retryAfterDelayMs;
          }
          if (failFast429WithoutRetryAfter && status === 429 && retryAfterDelayMs === null) {
            try {
              breaker.recordFailure();
            } catch (error) {
              if (!(error instanceof CircuitBreakerOpenError)) throw error;
            }
            failureRecorded = true;
            noRetry = true;
            throw lastError;
          }
          if (!retryable || attempt === attempts.length - 1) {
            // Record failure for 429/5xx/401 errors
            if (status === 429 || status >= 500 || status === 401) {
              breaker.recordFailure();
              failureRecorded = true;
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
        // Record failure for 429/5xx/401 errors (unless already recorded for this attempt)
        if (!failureRecorded && error && (error.status === 429 || error.status >= 500 || error.status === 401)) {
          breaker.recordFailure();
        }
        if (error && (error.retryable === false || noRetry)) {
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
      const historyParams = {
        gameId,
        selectionId: normalizedSelectionId,
        sportsbooks: Array.isArray(sportsbooks) ? sportsbooks : [],
        startTimestamp: resolvedStartTimestamp
      };
      const cacheKey = buildOddsHistoryCacheKey(authFile, historyParams);
      const cache = getOddsHistoryCache();
      const cached = cache.get(cacheKey);
      if (cached !== undefined) return Promise.resolve(cached);
      if (oddsHistoryInflight.has(cacheKey)) return oddsHistoryInflight.get(cacheKey);

      const request = runOddsHistoryRequest(
        authFile,
        () =>
          requestJSON(BACKEND_ODDS_HISTORY_URL, historyParams, {
            retryDelays: retryDelaysMs,
            failFast429WithoutRetryAfter: true
          }),
        { minIntervalMs: effectiveOddsHistoryMinIntervalMs }
      )
        .then((result) => {
          cache.set(cacheKey, result, DEFAULT_ODDS_HISTORY_CACHE_TTL_MS);
          return result;
        })
        .finally(() => oddsHistoryInflight.delete(cacheKey));
      oddsHistoryInflight.set(cacheKey, request);
      return request;
    },
    /**
     * Remaining local odds-history budget calls in the current window.
     * Lets bounded consumers (e.g. the CLI tennis fallback) size their
     * history spend to what actually remains.
     * @returns {number}
     */
    oddsHistoryBudgetRemaining() {
      return getOddsHistoryBudgetRemaining(authFile);
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
  fetchAccessTokenViaEgo,
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
  parseRetryAfterDelayMs,
  getOddsHistoryStartTimestamp,
  getOddsHistoryBudgetRemaining,
  // Expose the configured local window budget so consumers (aggregate scan
  // allocators, validation caps) can scale their spend to the real ceiling
  // (default 300 calls per 5 min, env PP_ODDS_HISTORY_BUDGET) instead of
  // hardcoding a stale assumption.
  ODDS_HISTORY_REQUEST_BUDGET,
  // Test-only introspection: lets tests assert the gate's persisted-halt /
  // budget state without time travel. Read-only — it cannot bypass the
  // budget or cooldown enforcement.
  __getOddsHistoryGateStateForTests: (gateKey) => oddsHistoryGateStates.get(gateKey) || null
};
