'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_AUTH_FILE = path.resolve(__dirname, '..', 'auth.json');
const DEFAULT_AUTH_DIR = path.join(os.homedir(), '.propprofessor');
const DEFAULT_USER_AUTH_FILE = path.join(DEFAULT_AUTH_DIR, 'auth.json');
const ACCESS_TOKEN_URL = 'https://app.propprofessor.com/api/access-token';
const TOKEN_CACHE_SAFETY_MS = 5 * 60 * 1000; // Refresh if within 5 min of expiry

// CDP fallback (second token-refresh path). The version endpoint is
// configurable via `PROPPROFESSOR_CDP_VERSION_URL` so this Mac can point at
// its active Chrome-for-Testing listener (127.0.0.1:9333) instead of the
// historical default port 9222; the default stays 9222 when unset.
const DEFAULT_CDP_VERSION_URL = 'http://127.0.0.1:9222/json/version';
const CDP_SETTLE_POLL_INTERVAL_MS = 200;
const CDP_SETTLE_POLL_EXPRESSION = 'JSON.stringify({ href: location.href, ready: document.readyState })';

// ego-browser fallback (third token-refresh path). Runs `ego-browser nodejs`
// with a script on stdin; the ego task space inherits the user's
// PropProfessor login, so a same-origin browserFetch sails past Vercel's
// TLS-fingerprint challenge that 429s the server-to-server got-scraping path.
const EGO_EXECUTABLE = 'ego-browser';
// Default task space: a NAMED space (not a numeric id). ego's
// useOrCreateTaskSpace(name) creates the space on first use and returns a
// server-assigned numeric id; a numeric default (e.g. 7) only matches an
// existing space and fails with "task space not found" when none exists.
const DEFAULT_EGO_TASK_SPACE = 'pp-token-refresh';
const EGO_TIMEOUT_MS = 30000;

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
    if (!tokenData || !isWellFormedJwt(tokenData.token)) return;

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
  if (!isWellFormedJwt(cached.token)) return false;
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
 * Resolve the CDP version endpoint URL: explicit option wins, then
 * `PROPPROFESSOR_CDP_VERSION_URL`, then the default (127.0.0.1:9222).
 * Mirrors the ego task-space resolution pattern.
 * @param {string|undefined} explicit - Explicit versionUrl option.
 * @returns {string} The version endpoint URL to fetch.
 */
function resolveCdpVersionUrl(explicit) {
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    return String(explicit).trim();
  }
  const envRaw = String(process.env.PROPPROFESSOR_CDP_VERSION_URL || '').trim();
  if (envRaw) return envRaw;
  return DEFAULT_CDP_VERSION_URL;
}

/**
 * Wait (bounded) for a freshly created CDP page target to land on
 * `app.propprofessor.com` with a settled document. A brand-new target starts
 * at about:blank (an opaque origin); a `Runtime.evaluate` issued too early
 * runs the in-page `fetch()` in the wrong origin and dies with
 * "Failed to fetch". Polls `location.href` / `document.readyState` until the
 * target is on the app origin AND loaded, or the deadline expires.
 * @param {Function} send - CDP request helper (request id / session aware).
 * @param {string} sid - Flat session id for the target.
 * @param {number} deadlineMs - Bounded wait budget in ms (shares the runtime
 *   timeout budget so the whole evaluate phase stays within it).
 * @returns {Promise<void>} Resolves once the target is settled.
 * @throws {Error} With a redacted, informative message if the deadline passes.
 */
async function waitForCdpAppOrigin(send, sid, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastState = null;
  for (;;) {
    if (Date.now() >= deadline) {
      const seen = lastState
        ? `last state: href=${JSON.stringify(String(lastState.href).slice(0, 80))}, readyState=${JSON.stringify(lastState.ready)}`
        : 'no readable page state';
      throw new Error(`CDP: created tab did not settle on app.propprofessor.com within ${deadlineMs}ms (${seen})`);
    }
    const poll = await send('Runtime.evaluate', { expression: CDP_SETTLE_POLL_EXPRESSION, returnByValue: true }, sid);
    const raw = (poll.result || {}).value;
    try {
      lastState = JSON.parse(raw);
    } catch {
      lastState = null;
    }
    if (
      lastState &&
      typeof lastState.href === 'string' &&
      lastState.href.includes('app.propprofessor.com') &&
      lastState.ready === 'complete'
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, CDP_SETTLE_POLL_INTERVAL_MS));
  }
}

/**
 * Run the in-page token fetch via Runtime.evaluate on an attached session.
 * GET, not POST — POST returns 405. The expression is built with
 * JSON.stringify on the URL constant so any future change to ACCESS_TOKEN_URL
 * (or an attempt to pass attacker-controlled data through it) is safely
 * escaped rather than interpreted as JavaScript. Runtime.evaluate has no
 * arguments field, so JSON serialization of a constant is the right escape
 * hatch.
 * @param {Function} send - CDP request helper.
 * @param {string} sid - Flat session id for the target.
 * @returns {Promise<Object>} Token object with token, exp, perm.
 */
async function evaluateTokenFetch(send, sid) {
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
}

/**
 * Fetch a PropProfessor access token via Chrome DevTools Protocol from a
 * logged-in browser tab. This is the Vercel-TLS-fingerprint-bypassing path:
 * the MCP's server-to-server `got-scraping` request gets 429'd by Vercel,
 * but a `fetch()` issued from a browser tab that already has the session
 * cookies sails through.
 *
 * Requires Chrome running with remote debugging enabled (default port 9222;
 * override with the `versionUrl` option or `PROPPROFESSOR_CDP_VERSION_URL`).
 * Returns `{ token, exp, perm }` on success; throws on any failure.
 *
 * @param {Object} [options] - Options object.
 * @param {string} [options.versionUrl] - Chrome DevTools version endpoint. Defaults to env `PROPPROFESSOR_CDP_VERSION_URL` or `http://127.0.0.1:9222/json/version`.
 * @param {number} [options.cdpTimeoutMs] - Timeout for the WebSocket connect.
 * @param {number} [options.runtimeTimeoutMs] - Timeout for the settle wait + in-page fetch.
 * @param {Function} [options.fetchImpl] - fetch implementation (injectable for tests).
 * @param {{ new(url: string): { addEventListener: Function, removeEventListener: Function, send: Function, close: Function } }} [options.WebSocketImpl] - WebSocket constructor (injectable for tests).
 * @returns {Promise<Object>} Token object with token, exp, perm.
 */
async function fetchAccessTokenViaCDP({
  versionUrl,
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

  const resolvedVersionUrl = resolveCdpVersionUrl(versionUrl);

  // 1. Discover the browser's WebSocket endpoint.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cdpTimeoutMs);
  let versionRes;
  try {
    versionRes = await fetchImpl(resolvedVersionUrl, { signal: controller.signal });
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
    let createdTab = false;
    if (!tid) {
      const created = await send('Target.createTarget', { url: 'https://app.propprofessor.com/' });
      tid = created.targetId;
      createdTab = true;
    }

    // 4. Attach as a flat session so we can use Runtime.evaluate.
    const sess = await send('Target.attachToTarget', { targetId: tid, flatten: true });
    const sid = sess.sessionId;

    // 4b. A freshly created target starts at about:blank (an opaque origin)
    // and navigates to app.propprofessor.com asynchronously. Runtime.evaluate
    // issued too early runs the fetch in the wrong origin and fails with
    // "Failed to fetch". Wait (bounded, sharing the runtime timeout budget)
    // for the target to land on the app origin with a settled document.
    // Existing tabs are already on the app origin — no wait needed there.
    const settleDeadline = Date.now() + runtimeTimeoutMs;
    if (createdTab) {
      await waitForCdpAppOrigin(send, sid, runtimeTimeoutMs);
    }

    // 5. Run the in-page token fetch (GET, not POST — POST returns 405).
    const runtimeTimer = setTimeout(() => controller.abort(), Math.max(0, settleDeadline - Date.now()));
    try {
      return await evaluateTokenFetch(send, sid);
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

// ===== ego-browser fallback =====

/**
 * Resolve the ego task space to reuse: explicit option wins, then
 * `PROPPROFESSOR_EGO_TASK_SPACE`, then the default named space.
 * Explicit/env values must be a positive integer — a server-assigned task
 * space id (e.g. the `task.id` returned by `useOrCreateTaskSpace`), because
 * numeric ids only match existing spaces. The default is a NAMED space that
 * ego creates on first use, so the fallback works even when no task space
 * exists yet.
 * @param {number|string|undefined} explicit - Explicit task space id.
 * @returns {number|string} Positive integer id, or the default named space.
 */
function resolveEgoTaskSpaceId(explicit) {
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const n = Number(explicit);
    if (Number.isInteger(n) && n > 0) return n;
    throw new Error(`Invalid ego task space id: ${explicit}`);
  }
  const envRaw = String(process.env.PROPPROFESSOR_EGO_TASK_SPACE || '').trim();
  if (envRaw) {
    const n = Number(envRaw);
    if (Number.isInteger(n) && n > 0) return n;
    throw new Error(`Invalid PROPPROFESSOR_EGO_TASK_SPACE value: ${envRaw}`);
  }
  return DEFAULT_EGO_TASK_SPACE;
}

/**
 * Validate that a string looks like a well-formed JWT (3 non-empty
 * base64url segments). Mirrors the validation used before writing the
 * token cache, and doubles as a guard against truncated/mangled token
 * fragments leaking out of diagnostic output.
 * @param {*} token - Candidate token value.
 * @returns {boolean} True if the token has a valid JWT shape.
 */
function isWellFormedJwt(token) {
  if (typeof token !== 'string' || token.length === 0) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return false;
  const b64uRx = /^[A-Za-z0-9_-]+=*$/;
  return parts.every((p) => b64uRx.test(p));
}

/**
 * Redact JWT values and truncated JWT fragments (e.g. "eyJhbG...7890" from
 * a logging helper that shortened the value) from text so tokens never leak
 * into error messages or logs.
 * @param {*} text - Text to redact.
 * @returns {string} Redacted text.
 */
function redactJwt(text) {
  return String(text).replace(/\beyJ[A-Za-z0-9_.-]{6,}/g, '[REDACTED]');
}

/**
 * Build the Node.js script that runs inside `ego-browser nodejs`. The script
 * reuses the given task space, issues a same-origin `browserFetch` to the
 * access-token endpoint, validates token/exp, and emits exactly ONE JSON
 * line: `{ ok: true, token, exp, perm }` on success or `{ ok: false, error }`
 * on failure. The line is written with `process.stdout.write` — NOT `cliLog`,
 * which pretty-prints and truncates long values. (Empirically, ego-browser
 * nodejs routes all script output to the process's stderr and leaves stdout
 * empty; the Node side scans the combined capture for this one contract
 * line, so the token is still never picked up from arbitrary diagnostics.)
 * @param {number|string} taskSpaceId - ego task space id (numeric server id) or name to reuse.
 * @param {string} accessTokenUrl - Access-token endpoint URL.
 * @returns {string} The ego-browser script source.
 */
function buildEgoScript(taskSpaceId, accessTokenUrl) {
  const taskIdLiteral = JSON.stringify(taskSpaceId);
  const urlLiteral = JSON.stringify(accessTokenUrl);
  return [
    'let task;',
    'try {',
    `  task = await useOrCreateTaskSpace(${taskIdLiteral});`,
    // Ensure a same-origin tab exists before browserFetch: a task space with
    // zero tabs has no well-defined page context to fetch from, and the tab
    // must be on app.propprofessor.com for the session cookies to apply.
    "  await openOrReuseTab('https://app.propprofessor.com/', { wait: true, timeout: 20 });",
    `  const raw = await browserFetch(${urlLiteral}, {`,
    "    method: 'GET',",
    "    credentials: 'include',",
    "    headers: { Accept: 'application/json' }",
    '  });',
    "  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;",
    "  if (!data || typeof data.token !== 'string' || data.token.length === 0) {",
    "    throw new Error('ego browserFetch returned no token');",
    '  }',
    "  if (typeof data.exp !== 'number' || !Number.isFinite(data.exp) || data.exp <= 0) {",
    "    throw new Error('ego browserFetch returned invalid exp');",
    '  }',
    '  // Single JSON line via process.stdout.write — the only channel the',
    '  // Node side parses. Never log token values anywhere else.',
    "  process.stdout.write(JSON.stringify({ ok: true, token: data.token, exp: data.exp, perm: data.perm || {} }) + '\\n');",
    '} catch (error) {',
    "  process.stdout.write(JSON.stringify({ ok: false, error: String((error && error.message) || error) }) + '\\n');",
    '} finally {',
    '  // Token refresh is on-demand; do not leave an agent-owned browser space open.',
    '  if (task) {',
    '    try { await completeTaskSpace(task.id, { keep: false }); } catch { /* best effort cleanup */ }',
    '  }',
    '}'
  ].join('\n');
}

/**
 * Parse the captured `ego-browser nodejs` output for the single JSON contract
 * line. ego-browser routes all script output to stderr (stdout stays empty),
 * so both captures are scanned — but ONLY a line matching our `{ ok: ... }`
 * contract is ever treated as token data; anything else on stderr is at most
 * a redacted, truncated snippet in a failure message. Tokens must also have
 * a well-formed JWT shape, so truncated/mangled fragments from diagnostics
 * can never become token output.
 * @param {string} stdout - Captured stdout.
 * @param {string} stderr - Captured stderr.
 * @param {number|null} exitCode - Process exit code.
 * @returns {Object} Token object with token, exp, perm.
 * @throws {Error} If no usable JSON response line is found or it is invalid.
 */
function parseEgoOutput(stdout, stderr, exitCode) {
  const combined = `${String(stdout || '')}\n${String(stderr || '')}`;
  const lines = combined
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    if (parsed.ok === true) {
      if (typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp) || parsed.exp <= 0) {
        throw new Error('ego-browser returned an invalid exp');
      }
      if (!isWellFormedJwt(parsed.token)) {
        throw new Error('ego-browser returned no token');
      }
      return { token: parsed.token, exp: parsed.exp, perm: parsed.perm || {} };
    }
    if (parsed.ok === false) {
      throw new Error(`ego-browser failed: ${redactJwt(String(parsed.error || 'unknown error'))}`);
    }
  }
  const stderrSnippet = redactJwt(
    String(stderr || '')
      .trim()
      .slice(0, 300)
  );
  const codeText = exitCode === null || exitCode === undefined ? 'unknown' : String(exitCode);
  throw new Error(
    `ego-browser produced no usable JSON output (exit code ${codeText})` + (stderrSnippet ? `: ${stderrSnippet}` : '')
  );
}

/**
 * Spawn the ego-browser Node.js runtime without a shell.
 * @param {string} command - Executable to run.
 * @param {string[]} args - Arguments.
 * @param {import('child_process').SpawnOptions} options - Spawn options.
 * @returns {import('child_process').ChildProcess} The spawned child process.
 */
function defaultEgoSpawn(command, args, options) {
  return spawn(command, args, options);
}

/**
 * Fetch a PropProfessor access token through the logged-in ego-browser task
 * space. ego-browser's isolated task-space browser inherits the user's
 * PropProfessor login, so a same-origin `browserFetch` to the access-token
 * endpoint sails past the Vercel TLS-fingerprint challenge that 429s the
 * server-to-server `got-scraping` path — without needing the Chrome CDP
 * port (which may be dead, as when `browser-harness` is unavailable).
 *
 * Spawns `ego-browser nodejs` (no shell) with a small script on stdin. The
 * script reuses the task space id from `PROPPROFESSOR_EGO_TASK_SPACE`
 * (a positive integer — a server-assigned id) or the default named space
 * `pp-token-refresh` (created on first use), opens/reuses a tab on
 * `app.propprofessor.com`, and writes exactly one JSON line via
 * `process.stdout.write` (ego-browser routes script output to stderr; the
 * Node side scans the combined capture for that one contract line — arbitrary
 * diagnostics are never treated as token data). Set `PP_NO_EGO_FALLBACK=1` to
 * disable this fallback.
 *
 * @param {Object} [options] - Options object.
 * @param {number|string} [options.taskSpaceId] - ego task space id to reuse. Defaults to env `PROPPROFESSOR_EGO_TASK_SPACE` or the named default space `pp-token-refresh`.
 * @param {number} [options.timeoutMs] - Max time to wait for ego-browser output. Defaults to 30000.
 * @param {string} [options.accessTokenUrl] - Access-token endpoint URL. Defaults to ACCESS_TOKEN_URL.
 * @param {Function} [options.spawnImpl] - spawn implementation (injectable for tests).
 * @returns {Promise<Object>} Token object with token, exp, perm.
 */
async function fetchAccessTokenViaEgo({
  taskSpaceId,
  timeoutMs = EGO_TIMEOUT_MS,
  accessTokenUrl = ACCESS_TOKEN_URL,
  spawnImpl = defaultEgoSpawn
} = {}) {
  const resolvedTaskSpaceId = resolveEgoTaskSpaceId(taskSpaceId);
  if (typeof spawnImpl !== 'function') {
    throw new Error('ego fallback requires a spawn implementation');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('ego fallback requires a positive timeoutMs');
  }

  const script = buildEgoScript(resolvedTaskSpaceId, accessTokenUrl);

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(EGO_EXECUTABLE, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (spawnError) {
      reject(new Error(`Failed to spawn ego-browser: ${spawnError.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* best effort */
      }
      reject(new Error(`ego-browser timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    if (child.stdout) child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    if (child.stderr) child.stderr.on('data', (chunk) => (stderr += String(chunk)));

    child.on('error', (spawnError) => {
      finish(() => reject(new Error(`Failed to start ego-browser: ${spawnError.message}`)));
    });

    child.on('close', (code) => {
      finish(() => {
        try {
          resolve(parseEgoOutput(stdout, stderr, code));
        } catch (error) {
          reject(error);
        }
      });
    });

    try {
      if (child.stdin) child.stdin.end(script);
    } catch (writeError) {
      finish(() => reject(new Error(`Failed to write ego-browser script: ${writeError.message}`)));
    }
  });
}

/**
 * Fetch a PropProfessor access token using stored auth cookies.
 *
 * Tries the server-to-server `got-scraping` path first. If that path
 * fails (most commonly because Vercel's TLS-fingerprint challenge is
 * 429-ing the request), falls back to the logged-in ego-browser task
 * space, which inherits the user's PropProfessor login and sails past
 * Vercel because the browser already solved the TLS-fingerprint
 * challenge. If ego-browser is not available either, falls back to a
 * Chrome DevTools Protocol fetch from a logged-in browser tab.
 *
 * Set `PP_NO_CDP_FALLBACK=1` to disable the CDP fallback (e.g. in
 * headless / CI environments where Chrome is not available). Set
 * `PP_NO_EGO_FALLBACK=1` to disable the ego-browser fallback.
 *
 * @param {Object} [options] - Options object.
 * @param {string} [options.authFile] - Path to the auth file containing cookies.
 * @param {Function} [options.gotScrapingImpl] - got-scraping implementation for HTTP requests.
 * @param {Function} [options.now] - Function returning current timestamp in milliseconds.
 * @param {boolean} [options.enableCdpFallback] - If false, skip the CDP fallback on got-scraping failure. Defaults to env var `PP_NO_CDP_FALLBACK !== '1'`.
 * @param {Function} [options.cdpImpl] - CDP fallback implementation (injectable for tests).
 * @param {boolean} [options.enableEgoFallback] - If false, skip the ego-browser fallback. Defaults to env var `PP_NO_EGO_FALLBACK !== '1'`.
 * @param {Function} [options.egoImpl] - ego-browser fallback implementation (injectable for tests).
 * @returns {Promise<Object>} Token object with token (string), exp (number), and perm (Object).
 * @throws {Error} If no PropProfessor cookies are found or all token refresh paths fail.
 */
async function fetchAccessToken({
  authFile = resolveAuthFile(),
  gotScrapingImpl = defaultGotScraping,
  now = Date.now,
  enableCdpFallback = process.env.PP_NO_CDP_FALLBACK !== '1',
  cdpImpl = fetchAccessTokenViaCDP,
  enableEgoFallback = process.env.PP_NO_EGO_FALLBACK !== '1',
  egoImpl = fetchAccessTokenViaEgo
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
    return await tryFallbacksOrThrow({ cdpImpl, enableCdpFallback, egoImpl, enableEgoFallback, gotErr });
  }

  const statusCode = Number(response?.statusCode || 0);
  const body = String(response?.body || '');

  // 429 (Vercel TLS-fingerprint challenge) and 401 (stale cookies) trigger
  // the browser fallbacks. Other got-scraping failures bubble up unchanged.
  if (statusCode === 429 || statusCode === 401) {
    const gotErr = new Error(`got-scraping path returned HTTP ${statusCode}: ${body.slice(0, 200)}`);
    return await tryFallbacksOrThrow({ cdpImpl, enableCdpFallback, egoImpl, enableEgoFallback, gotErr });
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

/**
 * Try the browser fallbacks in order — ego-browser first, CDP second —
 * and throw a combined error (without exposing token values) when they all
 * fail. If every fallback is disabled, surface the got-scraping error as-is
 * so callers keep seeing the original failure.
 * @param {Object} options - Options object.
 * @param {Function} options.cdpImpl - CDP fallback implementation.
 * @param {boolean} options.enableCdpFallback - Whether the CDP fallback is enabled.
 * @param {Function} options.egoImpl - ego-browser fallback implementation.
 * @param {boolean} options.enableEgoFallback - Whether the ego fallback is enabled.
 * @param {Error} options.gotErr - The got-scraping failure that triggered the fallbacks.
 * @returns {Promise<Object>} Token object from the first fallback that succeeds.
 */
async function tryFallbacksOrThrow({ cdpImpl, enableCdpFallback, egoImpl, enableEgoFallback, gotErr }) {
  let cdpErr = null;
  let egoErr = null;

  if (enableEgoFallback && typeof egoImpl === 'function') {
    try {
      return await egoImpl();
    } catch (error) {
      egoErr = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (enableCdpFallback) {
    try {
      return await cdpImpl();
    } catch (error) {
      cdpErr = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (!cdpErr && !egoErr) {
    // Every fallback was disabled — surface the got-scraping failure as-is.
    throw gotErr;
  }

  const details = [
    `got-scraping: ${redactJwt(gotErr.message)}`,
    egoErr ? `ego: ${redactJwt(egoErr.message)}` : 'ego: disabled',
    cdpErr ? `CDP: ${redactJwt(cdpErr.message)}` : 'CDP: disabled'
  ];
  const err = /** @type {Error & { cause?: unknown, code?: string }} */ (
    new Error(`Both token refresh paths failed. ${details.join('; ')}`)
  );
  err.cause = { gotErr, cdpErr, egoErr };
  err.code = 'TOKEN_REFRESH_FAILED_BOTH_PATHS';
  throw err;
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
  fetchAccessTokenViaCDP,
  fetchAccessTokenViaEgo
};
