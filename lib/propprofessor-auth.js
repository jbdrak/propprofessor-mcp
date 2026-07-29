'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_AUTH_FILE = path.resolve(__dirname, '..', 'auth.json');
const DEFAULT_AUTH_DIR = path.join(os.homedir(), '.propprofessor');
const DEFAULT_USER_AUTH_FILE = path.join(DEFAULT_AUTH_DIR, 'auth.json');
const ACCESS_TOKEN_URL = 'https://app.propprofessor.com/api/access-token';
const TOKEN_CACHE_SAFETY_MS = 5 * 60 * 1000; // Refresh if within 5 min of expiry

// ===== Token persistence =====
function getTokenCacheFile(authFile) {
  const authDir = path.dirname(authFile);
  return path.join(authDir, 'token-cache.json');
}

function readTokenCache(authFile) {
  try {
    const cacheFile = getTokenCacheFile(authFile);
    const raw = fs.readFileSync(cacheFile, 'utf8');
    const data = JSON.parse(raw);
    if (data && data.token && data.exp && typeof data.exp === 'number') {
      return data;
    }
  } catch {
    // File missing or corrupt — that's fine
  }
  return null;
}

function writeTokenCache(tokenData, authFile) {
  try {
    // Validate JWT format BEFORE writing — prevents truncated tokens from
    // being persisted to disk (e.g. if process is SIGKILL'd mid-fetch).
    if (!tokenData || !tokenData.token || typeof tokenData.token !== 'string') return;
    const parts = tokenData.token.split('.');
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) return;
    const b64uRx = /^[A-Za-z0-9_-]+=*$/;
    if (!parts.every((p) => b64uRx.test(p))) return;

    const cacheFile = getTokenCacheFile(authFile);
    const dir = path.dirname(cacheFile);
    // 0o700 — owner-only on the parent directory.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const payload = JSON.stringify(
      {
        token: tokenData.token,
        exp: tokenData.exp,
        perm: tokenData.perm || {},
        cachedAt: Date.now()
      },
      null,
      2
    );

    // Atomic write: write to temp file then rename. Prevents partial writes
    // from SIGKILL during token refresh from leaving a corrupted cache file.
    const tmpFile = cacheFile + '.tmp.' + process.pid;
    fs.writeFileSync(tmpFile, payload, { mode: 0o600, encoding: 'utf8' });
    fs.renameSync(tmpFile, cacheFile);

    // chmod to lock it down (idempotent).
    try {
      fs.chmodSync(cacheFile, 0o600);
    } catch {
      // Best effort — chmod failures on read-only volumes are non-fatal
    }
  } catch {
    // Best effort — don't break auth if cache write fails
  }
}

function isTokenCacheValid(cached, safetyMs = TOKEN_CACHE_SAFETY_MS) {
  if (!cached || !cached.exp) return false;
  // Validate JWT format: 3 dot-separated base64url segments
  // Prevents silent crashes from truncated tokens (eyJhbG...v8YA)
  if (!cached.token || typeof cached.token !== 'string') return false;
  const parts = cached.token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return false;
  // Each segment should be valid base64url (alphanumeric, _, -, optional padding)
  const b64uRx = /^[A-Za-z0-9_-]+=*$/;
  if (!parts.every((p) => b64uRx.test(p))) return false;
  const nowMs = Date.now();
  return nowMs < cached.exp * 1000 - safetyMs;
}

function clearTokenCache(authFile) {
  try {
    const cacheFile = getTokenCacheFile(authFile);
    if (fs.existsSync(cacheFile)) {
      fs.unlinkSync(cacheFile);
    }
  } catch {
    // Best effort
  }
}

// ===== Auth file resolution =====
function getExplicitAuthFile() {
  const raw = String(process.env.AUTH_FILE || '').trim();
  return raw || null;
}

function uniqueAuthPaths(paths) {
  const seen = new Set();
  return paths.filter((file) => {
    const normalized = String(file || '').trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/**
 * Get the list of candidate auth file paths to check, in priority order.
 * @returns {string[]} Array of auth file paths (explicit env var, user default, repo default).
 */
function getAuthFileCandidates() {
  return uniqueAuthPaths([getExplicitAuthFile(), DEFAULT_USER_AUTH_FILE, REPO_AUTH_FILE]);
}

/**
 * Ensure the parent directory for an auth file exists, creating it if needed.
 * @param {string} [authFile] - Path to the auth file whose parent directory should exist.
 * @returns {string} The parent directory path.
 */
function ensureAuthParentDirectory(authFile = DEFAULT_USER_AUTH_FILE) {
  const directory = path.dirname(authFile);
  // 0o700 on the parent so a sibling user can't list the auth dir.
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/**
 * Copy an auth file from a source path to the destination path.
 * @param {Object} [options] - Options object.
 * @param {string} options.sourceFile - Path to the source auth file (required).
 * @param {string} [options.destinationFile] - Destination path (defaults to user auth file).
 * @returns {Object} Result with ok, sourceFile, destinationFile, usedExistingFile.
 */
function installAuthFile(
  {
    sourceFile,
    destinationFile = DEFAULT_USER_AUTH_FILE
  } = /** @type {{ sourceFile: string, destinationFile?: string }} */ ({})
) {
  const sourcePath = String(sourceFile || '').trim();
  const destinationPath = String(destinationFile || '').trim() || DEFAULT_USER_AUTH_FILE;
  if (!sourcePath) {
    throw new Error('sourceFile is required');
  }

  const resolvedSource = path.resolve(sourcePath);
  const resolvedDestination = path.resolve(destinationPath);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`Auth source file not found: ${resolvedSource}`);
  }

  ensureAuthParentDirectory(resolvedDestination);
  if (resolvedSource !== resolvedDestination) {
    fs.copyFileSync(resolvedSource, resolvedDestination);
  }
  // copyFileSync inherits the source file's mode (typically 0o600 since browsers
  // and Playwright write private storage state), but auth.json may have been
  // pre-existing at 0o644 from a prior install. Force 0o600 to lock it down
  // (June 8 SEC-003). Best-effort — chmod failures on read-only volumes are
  // non-fatal for the install itself.
  try {
    fs.chmodSync(resolvedDestination, 0o600);
  } catch {
    // Best effort
  }

  return {
    ok: true,
    sourceFile: resolvedSource,
    destinationFile: resolvedDestination,
    usedExistingFile: resolvedSource === resolvedDestination
  };
}

/**
 * Resolve the auth file path to use, checking explicit env var, user default, and repo default.
 * @returns {string} The resolved auth file path.
 */
function resolveAuthFile() {
  const explicitAuthFile = getExplicitAuthFile();
  if (explicitAuthFile) {
    return explicitAuthFile;
  }

  if (fs.existsSync(DEFAULT_USER_AUTH_FILE)) {
    return DEFAULT_USER_AUTH_FILE;
  }
  if (fs.existsSync(REPO_AUTH_FILE)) {
    return REPO_AUTH_FILE;
  }
  return DEFAULT_USER_AUTH_FILE;
}

/**
 * Read and parse the auth state from a JSON auth file.
 * Falls back to PROPPROFESSOR_COOKIES env var if no auth file is found.
 * @param {string} [authFile] - Path to the auth file to read (defaults to resolved auth file).
 * @returns {Object} Parsed auth state object.
 * @throws {Error} If the file is missing, unreadable, or contains invalid JSON.
 */
function readAuthState(authFile = resolveAuthFile()) {
  // Try the auth file first
  try {
    return JSON.parse(fs.readFileSync(authFile, 'utf8'));
  } catch (error) {
    // If the file doesn't exist or is empty, check the env var
    const cookiesEnv = String(process.env.PROPPROFESSOR_COOKIES || '').trim();
    if (cookiesEnv) {
      try {
        const parsed = JSON.parse(cookiesEnv);
        // Support both raw cookie array and { cookies: [...] } shape
        if (Array.isArray(parsed)) {
          return { cookies: parsed };
        }
        if (parsed && Array.isArray(parsed.cookies)) {
          return parsed;
        }
      } catch {
        // Env var exists but is malformed JSON
      }
    }
    // If env var didn't help, throw the original error
    const message =
      error?.code === 'ENOENT'
        ? `PropProfessor auth file not found: ${authFile}. Set AUTH_FILE env var or PROPPROFESSOR_COOKIES for cookie-based auth.`
        : error?.code === 'EACCES'
          ? `PropProfessor auth file not readable: ${authFile}`
          : `Failed to read PropProfessor auth file at ${authFile}: ${error?.message || error}`;
    throw new Error(message, { cause: error });
  }
}

// ===== Cookie / domain helpers =====
function normalizeDomain(domain) {
  return String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '');
}

function isPropProfessorDomain(domain) {
  const normalized = normalizeDomain(domain);
  return normalized === 'propprofessor.com' || normalized.endsWith('.propprofessor.com');
}

/**
 * Check whether an auth object is valid (has at least one non-empty PropProfessor cookie).
 * @param {*} auth - The auth object to validate.
 * @returns {boolean} True if the auth object has valid PropProfessor cookies.
 */
function isAuthValid(auth) {
  if (auth == null || typeof auth !== 'object') return false;
  if (!Array.isArray(auth.cookies)) return false;
  return auth.cookies.some(
    (cookie) =>
      cookie &&
      typeof cookie === 'object' &&
      isPropProfessorDomain(cookie.domain) &&
      typeof cookie.value === 'string' &&
      cookie.value.length > 0
  );
}

/**
 * Analyze cookie expiry dates from auth state to detect upcoming session expiration.
 * Focuses on the NextAuth session token (__Secure-next-auth.session-token) which is
 * the critical cookie — when it expires, the entire session is dead regardless of other cookies.
 * @param {Object} auth - The auth state object (from readAuthState).
 * @param {Function} [nowFn] - Function returning current time in ms. Defaults to Date.now.
 * @returns {Object} Expiry analysis with sessionExpiry, daysRemaining, status, and warning.
 */
function getCookieExpiryInfo(auth, nowFn = Date.now) {
  const nowMs = nowFn();

  if (auth == null || typeof auth !== 'object' || !Array.isArray(auth.cookies)) {
    return { status: 'no_auth', sessionExpiry: null, daysRemaining: null, warning: 'No auth file found' };
  }

  const ppCookies = auth.cookies.filter(
    (c) => c && isPropProfessorDomain(c.domain) && typeof c.expires === 'number' && c.expires > 0
  );

  // Find the NextAuth session token — this is the one that matters
  const sessionCookie = ppCookies.find((c) => c.name === '__Secure-next-auth.session-token');

  if (!sessionCookie) {
    // Check for session cookies (expires === -1 means browser-session only)
    const sessionCookies = auth.cookies.filter(
      (c) => c && isPropProfessorDomain(c.domain) && c.name && c.name.includes('session')
    );
    if (sessionCookies.length > 0 && ppCookies.length === 0) {
      return {
        status: 'browser_session_only',
        sessionExpiry: null,
        daysRemaining: null,
        warning: 'Session cookies are browser-only (no expiry set). Re-login when browser closes.'
      };
    }
    return {
      status: 'no_session_token',
      sessionExpiry: null,
      daysRemaining: null,
      warning: 'No session token found in auth file'
    };
  }

  const expirySec = sessionCookie.expires;
  const expiryMs = expirySec * 1000;
  const daysRemaining = (expiryMs - nowMs) / (1000 * 60 * 60 * 24);
  const expiryDate = new Date(expiryMs).toISOString();

  let status;
  let warning;
  if (daysRemaining <= 0) {
    status = 'expired';
    warning = `Session expired ${Math.abs(Math.round(daysRemaining))} day(s) ago. Run: pp-query login`;
  } else if (daysRemaining <= 3) {
    status = 'critical';
    warning = `Session expires in ${Math.round(daysRemaining * 10) / 10} day(s) (${expiryDate}). Run: pp-query login soon`;
  } else if (daysRemaining <= 7) {
    status = 'warning';
    warning = `Session expires in ${Math.round(daysRemaining)} day(s) (${expiryDate}). Consider re-login.`;
  } else {
    status = 'ok';
    warning = null;
  }

  return {
    status,
    sessionExpiry: expiryDate,
    sessionExpiryUnix: expirySec,
    daysRemaining: Math.round(daysRemaining * 10) / 10,
    warning,
    cookieCount: ppCookies.length,
    allCookieExpiries: ppCookies.map((c) => ({
      name: c.name,
      expires: new Date(c.expires * 1000).toISOString(),
      daysRemaining: Math.round(((c.expires * 1000 - nowMs) / (1000 * 60 * 60 * 24)) * 10) / 10
    }))
  };
}

/**
 * Build a Cookie header string from auth state, filtering only PropProfessor domain cookies.
 * @param {Object} authState - The auth state object.
 * @param {Array<Object>} [authState.cookies] - Array of cookie objects with name, value, and domain.
 * @returns {string} Semicolon-separated cookie header string.
 */
function buildPropProfessorCookieHeader(authState) {
  const cookies = Array.isArray(authState?.cookies) ? authState.cookies : [];
  return cookies
    .filter((cookie) => cookie && isPropProfessorDomain(cookie.domain))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

/**
 * Inspect the current auth setup, checking all candidate auth files for validity.
 * @returns {Object} Inspection result with ok, source, selectedAuthFile, and checkedPaths details.
 */
function inspectAuthSetup() {
  const selectedAuthFile = resolveAuthFile();
  const checkedPaths = getAuthFileCandidates().map((file) => {
    let exists = false;
    let readable = false;
    let parseable = false;
    let propProfessorCookieCount = 0;
    let error = null;

    try {
      exists = fs.existsSync(file);
      if (exists) {
        fs.accessSync(file, fs.constants.R_OK);
        readable = true;
        const authState = readAuthState(file);
        parseable = true;
        const cookies = Array.isArray(authState?.cookies) ? authState.cookies : [];
        propProfessorCookieCount = cookies.filter((cookie) => cookie && isPropProfessorDomain(cookie.domain)).length;
      }
    } catch (cause) {
      error = String(cause?.message || cause);
    }

    return {
      path: file,
      exists,
      readable,
      parseable,
      propProfessorCookieCount,
      selected: file === selectedAuthFile,
      error
    };
  });

  const selectedEntry = checkedPaths.find((entry) => entry.selected) || {
    path: selectedAuthFile,
    exists: false,
    readable: false,
    parseable: false,
    propProfessorCookieCount: 0,
    selected: true,
    error: null
  };

  const source = getExplicitAuthFile() ? 'AUTH_FILE' : selectedAuthFile === DEFAULT_USER_AUTH_FILE ? 'user' : 'repo';

  // Cookie expiry analysis for the selected auth file
  let sessionExpiry = null;
  if (selectedEntry.exists && selectedEntry.parseable) {
    try {
      const authState = readAuthState(selectedAuthFile);
      sessionExpiry = getCookieExpiryInfo(authState);
    } catch {
      // Best effort
    }
  }

  return {
    ok:
      selectedEntry.exists &&
      selectedEntry.readable &&
      selectedEntry.parseable &&
      selectedEntry.propProfessorCookieCount > 0,
    source,
    selectedAuthFile,
    defaultUserAuthFile: DEFAULT_USER_AUTH_FILE,
    repoAuthFile: REPO_AUTH_FILE,
    checkedPaths,
    selected: selectedEntry,
    sessionExpiry
  };
}

const DEFAULT_AUTH_FILE = resolveAuthFile();

// ===== Token fetch =====
async function defaultGotScraping(options) {
  const mod = /** @type {any} */ (await import('got-scraping'));
  const gotScraping = mod.gotScraping || mod.default || mod;
  return gotScraping(options);
}

/**
 * Fetch a PropProfessor access token via Chrome DevTools Protocol from a
 * logged-in browser tab. This is the Vercel-TLS-fingerprint-bypassing path:
 * the MCP's server-to-server `got-scraping` request gets 429'd by Vercel,
 * but a `fetch()` issued from a browser tab that already has the session
 * cookies sails through.
 *
 * Requires Chrome running with remote debugging enabled on port 9222
 * (Chrome's default when launched with `--remote-debugging-port=9222`).
 * Returns `{ token, exp, perm }` on success; throws on any failure.
 *
 * @param {Object} [options] - Options object.
 * @param {string} [options.versionUrl] - Chrome DevTools version endpoint.
 * @param {number} [options.cdpTimeoutMs] - Timeout for the WebSocket connect.
 * @param {number} [options.runtimeTimeoutMs] - Timeout for the in-page fetch.
 * @param {Function} [options.fetchImpl] - fetch implementation (injectable for tests).
 * @param {{ new(url: string): { addEventListener: Function, removeEventListener: Function, send: Function, close: Function } }} [options.WebSocketImpl] - WebSocket constructor (injectable for tests).
 * @returns {Promise<Object>} Token object with token, exp, perm.
 */
async function fetchAccessTokenViaCDP({
  versionUrl = 'http://127.0.0.1:9222/json/version',
  cdpTimeoutMs = 5000,
  runtimeTimeoutMs = 10000,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket
} = {}) {
  if (typeof WebSocketImpl !== 'function') {
    throw new Error('CDP fallback requires a WebSocket implementation (Node 22+ has one built in)');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('CDP fallback requires a fetch implementation');
  }

  // 1. Discover the browser's WebSocket endpoint.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cdpTimeoutMs);
  let versionRes;
  try {
    versionRes = await fetchImpl(versionUrl, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!versionRes || !versionRes.ok) {
    throw new Error(`CDP version endpoint returned ${versionRes ? versionRes.status : 'no response'}`);
  }
  const { webSocketDebuggerUrl } = await versionRes.json();
  if (!webSocketDebuggerUrl) {
    throw new Error('CDP version response missing webSocketDebuggerUrl');
  }

  // 2. Open a WebSocket to the browser.
  const ws = new WebSocketImpl(webSocketDebuggerUrl);
  let id = 0;
  const send = (method, params, sid) =>
    new Promise((resolve, reject) => {
      const reqId = ++id;
      const msg = { id: reqId, method, params: params || {} };
      if (sid) msg.sessionId = sid;
      const settle = (raw) => {
        try {
          const r = JSON.parse(typeof raw === 'string' ? raw : raw.data);
          if (r && r.id === reqId) {
            ws.removeEventListener('message', settle);
            if (r.error) return reject(new Error(JSON.stringify(r.error)));
            resolve(r.result || {});
          }
        } catch {
          // Malformed message — leave the listener registered for the next one
        }
      };
      ws.addEventListener('message', settle);
      const onError = (err) => {
        ws.removeEventListener('message', settle);
        ws.removeEventListener('error', onError);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      ws.addEventListener('error', onError);
      try {
        ws.send(JSON.stringify(msg));
      } catch (e) {
        ws.removeEventListener('message', settle);
        ws.removeEventListener('error', onError);
        reject(e);
      }
    });

  try {
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener('open', onOpen);
        resolve();
      };
      const onErr = (e) => {
        ws.removeEventListener('error', onErr);
        reject(new Error('CDP WebSocket connect failed: ' + ((e && e.message) || e)));
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onErr);
    });

    // 3. Find or create a tab on app.propprofessor.com.
    const targets = await send('Target.getTargets');
    let tab = (targets.targetInfos || []).find(
      (t) => t.type === 'page' && (t.url || '').includes('app.propprofessor.com')
    );
    let tid = tab && tab.targetId;
    if (!tid) {
      const created = await send('Target.createTarget', { url: 'https://app.propprofessor.com/' });
      tid = created.targetId;
    }

    // 4. Attach as a flat session so we can use Runtime.evaluate.
    const sess = await send('Target.attachToTarget', { targetId: tid, flatten: true });
    const sid = sess.sessionId;

    // 5. GET, not POST — POST returns 405.
    // Build the expression with JSON.stringify on the URL constant so any
    // future change to ACCESS_TOKEN_URL (or an attempt to pass attacker-
    // controlled data through it) is safely escaped rather than interpreted
    // as JavaScript. Runtime.evaluate has no arguments field, so JSON
    // serialization of a constant is the right escape hatch.
    const runtimeTimer = setTimeout(() => controller.abort(), runtimeTimeoutMs);
    try {
      const urlLiteral = JSON.stringify(ACCESS_TOKEN_URL);
      const result = await send(
        'Runtime.evaluate',
        {
          expression: `fetch(${urlLiteral}, {
          method: 'GET',
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        }).then(r => r.json()).then(j => JSON.stringify(j))
          .catch(e => JSON.stringify({ error: String(e && e.message || e) }))`,
          awaitPromise: true,
          returnByValue: true
        },
        sid
      );
      const raw = (result.result || {}).value || '{}';
      const body = JSON.parse(raw);
      if (body && body.error) throw new Error(body.error);
      if (!body || !body.token) throw new Error('CDP fetch returned no token');
      return { token: body.token, exp: body.exp, perm: body.perm || {} };
    } finally {
      clearTimeout(runtimeTimer);
    }
  } finally {
    try {
      ws.close();
    } catch {
      /* best effort */
    }
  }
}

/**
 * Fetch a PropProfessor access token using stored auth cookies.
 *
 * Tries the server-to-server `got-scraping` path first. If that path
 * fails (most commonly because Vercel's TLS-fingerprint challenge is
 * 429-ing the request), falls back to a Chrome DevTools Protocol fetch
 * from a logged-in browser tab — that path sails through Vercel because
 * the browser already solved the TLS-fingerprint challenge.
 *
 * Set `PP_NO_CDP_FALLBACK=1` to disable the CDP fallback (e.g. in
 * headless / CI environments where Chrome is not available).
 *
 * @param {Object} [options] - Options object.
 * @param {string} [options.authFile] - Path to the auth file containing cookies.
 * @param {Function} [options.gotScrapingImpl] - got-scraping implementation for HTTP requests.
 * @param {Function} [options.now] - Function returning current timestamp in milliseconds.
 * @param {boolean} [options.enableCdpFallback] - If false, skip the CDP fallback on got-scraping failure. Defaults to env var `PP_NO_CDP_FALLBACK !== '1'`.
 * @param {Function} [options.cdpImpl] - CDP fallback implementation (injectable for tests).
 * @returns {Promise<Object>} Token object with token (string), exp (number), and perm (Object).
 * @throws {Error} If no PropProfessor cookies are found or both refresh paths fail.
 */
async function fetchAccessToken({
  authFile = resolveAuthFile(),
  gotScrapingImpl = defaultGotScraping,
  now = Date.now,
  enableCdpFallback = process.env.PP_NO_CDP_FALLBACK !== '1',
  cdpImpl = fetchAccessTokenViaCDP
} = {}) {
  const authState = readAuthState(authFile);
  const cookieHeader = buildPropProfessorCookieHeader(authState);
  if (!cookieHeader) {
    throw new Error(`No PropProfessor cookies found in ${authFile}`);
  }

  let response;
  try {
    response = await gotScrapingImpl({
      url: ACCESS_TOKEN_URL,
      headers: {
        Cookie: cookieHeader,
        Referer: 'https://app.propprofessor.com/'
      },
      timeout: { request: 15000 },
      throwHttpErrors: false
    });
  } catch (gotErr) {
    return await tryCdpOrThrow({ cdpImpl, enableCdpFallback, gotErr });
  }

  const statusCode = Number(response?.statusCode || 0);
  const body = String(response?.body || '');

  // 429 (Vercel TLS-fingerprint challenge) and 401 (stale cookies) trigger
  // the CDP fallback. Other got-scraping failures bubble up unchanged.
  if (statusCode === 429 || statusCode === 401) {
    const gotErr = new Error(`got-scraping path returned HTTP ${statusCode}: ${body.slice(0, 200)}`);
    return await tryCdpOrThrow({ cdpImpl, enableCdpFallback, gotErr });
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`Unexpected access-token response: ${body.slice(0, 200)}`);
  }

  if (statusCode !== 200 || !data || !data.token) {
    const message = data?.error || data?.message || `HTTP ${statusCode}`;
    throw new Error(`Failed to fetch PropProfessor access token: ${message}`);
  }

  return {
    token: data.token,
    exp: data.exp || Math.floor(now() / 1000) + 600,
    perm: data.perm || {}
  };
}

async function tryCdpOrThrow({ cdpImpl, enableCdpFallback, gotErr }) {
  if (!enableCdpFallback) throw gotErr;
  try {
    return await cdpImpl();
  } catch (cdpErr) {
    const err = /** @type {Error & { cause?: unknown, code?: string }} */ (
      new Error(`Both token refresh paths failed. got-scraping: ${gotErr.message}; CDP: ${cdpErr.message}`)
    );
    err.cause = { gotErr, cdpErr };
    err.code = 'TOKEN_REFRESH_FAILED_BOTH_PATHS';
    throw err;
  }
}

module.exports = {
  ACCESS_TOKEN_URL,
  DEFAULT_AUTH_DIR,
  DEFAULT_AUTH_FILE,
  DEFAULT_USER_AUTH_FILE,
  REPO_AUTH_FILE,
  TOKEN_CACHE_SAFETY_MS,
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
};
