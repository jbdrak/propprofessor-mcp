'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getTokenCacheFile,
  readTokenCache,
  writeTokenCache,
  isTokenCacheValid,
  clearTokenCache,
  getExplicitAuthFile,
  uniqueAuthPaths,
  ensureAuthParentDirectory,
  installAuthFile,
  resolveAuthFile,
  readAuthState,
  normalizeDomain,
  isSSBDomain,
  isAuthValid,
  getCookieExpiryInfo,
  buildSSBCookieHeader
} = require('../lib/ssb-auth');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-auth-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===== Token cache =====

describe('getTokenCacheFile', () => {
  it('derives cache path from auth file location', () => {
    const authFile = '/some/path/auth.json';
    assert.equal(getTokenCacheFile(authFile), '/some/path/token-cache.json');
  });
});

describe('readTokenCache', () => {
  it('returns null when cache file does not exist', () => {
    assert.equal(readTokenCache(path.join(tmpDir, 'nonexistent')), null);
  });

  it('returns null for corrupt JSON', () => {
    const cacheFile = path.join(tmpDir, 'token-cache.json');
    fs.writeFileSync(cacheFile, 'not-json');
    assert.equal(readTokenCache(path.join(tmpDir, 'auth.json')), null);
  });

  it('returns null when token field is missing', () => {
    const cacheFile = path.join(tmpDir, 'token-cache.json');
    fs.writeFileSync(cacheFile, JSON.stringify({ exp: 9999999999 }));
    assert.equal(readTokenCache(path.join(tmpDir, 'auth.json')), null);
  });

  it('returns cached data when valid', () => {
    const cacheFile = path.join(tmpDir, 'token-cache.json');
    const data = { token: 'tok_123', exp: 9999999999, perm: { read: true } };
    fs.writeFileSync(cacheFile, JSON.stringify(data));
    const result = readTokenCache(path.join(tmpDir, 'auth.json'));
    assert.equal(result.token, 'tok_123');
    assert.equal(result.exp, 9999999999);
  });
});

// Shared test JWT — 3 dot-separated base64url segments (required by writeTokenCache validation)
const TEST_JWT = 'eyJhbGciOiJIUzI1NiJ9.dGVzdA.dGVzdA';

describe('writeTokenCache', () => {
  it('writes token data to cache file', () => {
    const authFile = path.join(tmpDir, 'auth.json');
    writeTokenCache({ token: TEST_JWT, exp: 9999999999, perm: {} }, authFile);
    const cacheFile = getTokenCacheFile(authFile);
    assert.ok(fs.existsSync(cacheFile));
    const written = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.equal(written.token, TEST_JWT);
    assert.equal(written.exp, 9999999999);
    assert.ok(typeof written.cachedAt === 'number');
  });

  it('creates parent directory if needed', () => {
    const authFile = path.join(tmpDir, 'subdir', 'deep', 'auth.json');
    writeTokenCache({ token: TEST_JWT, exp: 1 }, authFile);
    assert.ok(fs.existsSync(getTokenCacheFile(authFile)));
  });

  // SEC-003 (June 8 audit): token cache must be owner read/write only.
  // Skipped on Windows where chmod semantics differ — the test is asserting
  // POSIX 0o600, which is the documented contract for macOS/Linux.
  it('writes token cache with 0o600 permissions', { skip: process.platform === 'win32' }, () => {
    const authFile = path.join(tmpDir, 'auth.json');
    writeTokenCache({ token: TEST_JWT, exp: 9999999999, perm: {} }, authFile);
    const cacheFile = getTokenCacheFile(authFile);
    const stat = fs.statSync(cacheFile);
    // 0o600 = owner rw, group/other none. Mask out the file-type bits
    // (upper bits) so we compare just the 9 permission bits.
    assert.equal(stat.mode & 0o777, 0o600, 'token-cache.json should be owner-only');
  });
});

describe('clearTokenCache', () => {
  it('removes cache file if it exists', () => {
    const authFile = path.join(tmpDir, 'auth.json');
    writeTokenCache({ token: TEST_JWT, exp: 1 }, authFile);
    assert.ok(fs.existsSync(getTokenCacheFile(authFile)));
    clearTokenCache(authFile);
    assert.ok(!fs.existsSync(getTokenCacheFile(authFile)));
  });

  it('does not throw when cache file does not exist', () => {
    clearTokenCache(path.join(tmpDir, 'nonexistent'));
  });
});

describe('isTokenCacheValid', () => {
  it('returns false for null', () => {
    assert.equal(isTokenCacheValid(null), false);
  });

  it('returns false for missing exp', () => {
    assert.equal(isTokenCacheValid({ token: 'x' }), false);
  });

  it('returns false when token is expired', () => {
    assert.equal(isTokenCacheValid({ token: 'x', exp: 1000000 }, 0), false);
  });

  it('returns true when token is far from expiry', () => {
    const farFuture = Math.floor(Date.now() / 1000) + 3600;
    assert.equal(isTokenCacheValid({ token: 'eyJhbGciOiJIUzI1NiJ9.dGVzdA.test', exp: farFuture }), true);
  });

  it('returns false when within safety margin of expiry', () => {
    // exp is in seconds; safetyMs is in milliseconds
    // Token expires in 100ms from now — within the 200ms safety margin
    const almostExpiry = (Date.now() + 100) / 1000;
    assert.equal(isTokenCacheValid({ token: 'x', exp: almostExpiry }, 200), false);
  });
});

// ===== Auth file resolution =====

describe('getExplicitAuthFile', () => {
  it('returns null when AUTH_FILE is not set', () => {
    const original = process.env.AUTH_FILE;
    delete process.env.AUTH_FILE;
    assert.equal(getExplicitAuthFile(), null);
    if (original !== undefined) process.env.AUTH_FILE = original;
  });

  it('returns the AUTH_FILE value when set', () => {
    const original = process.env.AUTH_FILE;
    process.env.AUTH_FILE = '/tmp/test-auth.json';
    assert.equal(getExplicitAuthFile(), '/tmp/test-auth.json');
    if (original !== undefined) process.env.AUTH_FILE = original;
    else delete process.env.AUTH_FILE;
  });

  it('trims whitespace', () => {
    const original = process.env.AUTH_FILE;
    process.env.AUTH_FILE = '  /tmp/test.json  ';
    assert.equal(getExplicitAuthFile(), '/tmp/test.json');
    if (original !== undefined) process.env.AUTH_FILE = original;
    else delete process.env.AUTH_FILE;
  });
});

describe('uniqueAuthPaths', () => {
  it('deduplicates paths', () => {
    assert.deepEqual(uniqueAuthPaths(['/a', '/b', '/a']), ['/a', '/b']);
  });

  it('filters empty strings', () => {
    assert.deepEqual(uniqueAuthPaths(['/a', '', '/b']), ['/a', '/b']);
  });
});

describe('ensureAuthParentDirectory', () => {
  it('creates the directory', () => {
    const dir = path.join(tmpDir, 'new-dir');
    ensureAuthParentDirectory(path.join(dir, 'auth.json'));
    assert.ok(fs.existsSync(dir));
  });
});

describe('installAuthFile', () => {
  it('copies source to destination', () => {
    const source = path.join(tmpDir, 'source-auth.json');
    const dest = path.join(tmpDir, 'dest-auth.json');
    fs.writeFileSync(source, JSON.stringify({ cookies: [] }));
    const result = installAuthFile({ sourceFile: source, destinationFile: dest });
    assert.ok(result.ok);
    assert.ok(fs.existsSync(dest));
    assert.equal(result.usedExistingFile, false);
  });

  it('throws when sourceFile is missing', () => {
    assert.throws(() => installAuthFile({ sourceFile: '' }), /sourceFile is required/);
  });

  it('throws when source file does not exist', () => {
    assert.throws(() => installAuthFile({ sourceFile: '/nonexistent/auth.json' }), /not found/);
  });

  // SEC-003 (June 8 audit): installed auth.json must be 0o600 even if the
  // source was more permissive (e.g. a user's prior export at 0o644).
  it('writes destination with 0o600 permissions', { skip: process.platform === 'win32' }, () => {
    const source = path.join(tmpDir, 'source-loose.json');
    const dest = path.join(tmpDir, 'dest.json');
    // Source intentionally written with loose permissions to prove the
    // install path tightens the destination regardless of source mode.
    fs.writeFileSync(source, JSON.stringify({ cookies: [] }), { mode: 0o644 });
    installAuthFile({ sourceFile: source, destinationFile: dest });
    const stat = fs.statSync(dest);
    assert.equal(stat.mode & 0o777, 0o600, 'installed auth.json should be owner-only');
  });
});

describe('resolveAuthFile', () => {
  it('returns AUTH_FILE env var when set', () => {
    const original = process.env.AUTH_FILE;
    process.env.AUTH_FILE = '/tmp/custom-auth.json';
    assert.equal(resolveAuthFile(), '/tmp/custom-auth.json');
    if (original !== undefined) process.env.AUTH_FILE = original;
    else delete process.env.AUTH_FILE;
  });
});

// ===== Cookie / domain helpers =====

describe('normalizeDomain', () => {
  it('lowercases and trims', () => {
    assert.equal(normalizeDomain('  Propprofessor.COM  '), 'propprofessor.com');
  });

  it('strips leading dots', () => {
    assert.equal(normalizeDomain('.propprofessor.com'), 'propprofessor.com');
  });

  it('returns empty string for empty input', () => {
    assert.equal(normalizeDomain(''), '');
  });
});

describe('isSSBDomain', () => {
  it('matches propprofessor.com', () => {
    assert.equal(isSSBDomain('propprofessor.com'), true);
  });

  it('matches subdomains', () => {
    assert.equal(isSSBDomain('app.propprofessor.com'), true);
    assert.equal(isSSBDomain('backend.propprofessor.com'), true);
  });

  it('matches with leading dot', () => {
    assert.equal(isSSBDomain('.propprofessor.com'), true);
  });

  it('rejects other domains', () => {
    assert.equal(isSSBDomain('example.com'), false);
    assert.equal(isSSBDomain('notpropprofessor.com'), false);
  });
});

describe('isAuthValid', () => {
  it('returns false for null', () => {
    assert.equal(isAuthValid(null), false);
  });

  it('returns false for empty cookies', () => {
    assert.equal(isAuthValid({ cookies: [] }), false);
  });

  it('returns false for non-PP domain cookies', () => {
    assert.equal(isAuthValid({ cookies: [{ domain: 'example.com', value: 'x' }] }), false);
  });

  it('returns true for valid PP cookie with value', () => {
    assert.equal(isAuthValid({ cookies: [{ domain: '.propprofessor.com', value: 'session-token' }] }), true);
  });
});

describe('buildSSBCookieHeader', () => {
  it('builds cookie string from PP cookies only', () => {
    const authState = {
      cookies: [
        { domain: '.propprofessor.com', name: 'session', value: 'abc123' },
        { domain: 'other.com', name: 'other', value: 'xyz' },
        { domain: 'app.propprofessor.com', name: 'token', value: 'def456' }
      ]
    };
    const header = buildSSBCookieHeader(authState);
    assert.equal(header, 'session=abc123; token=def456');
  });

  it('returns empty string for no PP cookies', () => {
    assert.equal(buildSSBCookieHeader({ cookies: [] }), '');
    assert.equal(buildSSBCookieHeader({}), '');
  });
});

// ===== getCookieExpiryInfo =====

describe('getCookieExpiryInfo', () => {
  it('returns no_auth for null', () => {
    const result = getCookieExpiryInfo(null);
    assert.equal(result.status, 'no_auth');
  });

  it('returns no_session_token when session cookie is missing', () => {
    const result = getCookieExpiryInfo({
      cookies: [{ domain: '.propprofessor.com', name: 'other', value: 'x', expires: 9999999999 }]
    });
    assert.equal(result.status, 'no_session_token');
  });

  it('returns expired when session cookie is in the past', () => {
    const nowFn = () => Date.now();
    const pastExpiry = Math.floor(Date.now() / 1000) - 86400; // 1 day ago
    const result = getCookieExpiryInfo(
      {
        cookies: [
          { domain: '.propprofessor.com', name: '__Secure-next-auth.session-token', value: 'x', expires: pastExpiry }
        ]
      },
      nowFn
    );
    assert.equal(result.status, 'expired');
    assert.ok(result.warning.includes('expired'));
  });

  it('returns ok when session is far from expiry', () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 86400 * 30; // 30 days
    const result = getCookieExpiryInfo({
      cookies: [
        { domain: '.propprofessor.com', name: '__Secure-next-auth.session-token', value: 'x', expires: futureExpiry }
      ]
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.warning, null);
  });

  it('returns critical when within 3 days', () => {
    const nearExpiry = Math.floor(Date.now() / 1000) + 86400 * 2; // 2 days
    const result = getCookieExpiryInfo({
      cookies: [
        { domain: '.propprofessor.com', name: '__Secure-next-auth.session-token', value: 'x', expires: nearExpiry }
      ]
    });
    assert.equal(result.status, 'critical');
  });
});

// ===== readAuthState =====

describe('readAuthState', () => {
  it('reads valid JSON auth file', () => {
    const authFile = path.join(tmpDir, 'auth.json');
    const data = { cookies: [{ name: 'session', domain: '.propprofessor.com', value: 'abc' }] };
    fs.writeFileSync(authFile, JSON.stringify(data));
    const result = readAuthState(authFile);
    assert.deepEqual(result.cookies, data.cookies);
  });

  it('throws for missing file', () => {
    assert.throws(() => readAuthState(path.join(tmpDir, 'missing.json')), /not found/);
  });

  it('throws for invalid JSON', () => {
    const authFile = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(authFile, 'not-json');
    assert.throws(() => readAuthState(authFile), /Failed to read/);
  });
});

// ===== Backward compatibility: imports from ssb-api still work =====

describe('backward compat: ssb-api re-exports', () => {
  it('exports all auth functions from ssb-api', () => {
    const api = require('../lib/ssb-api');
    assert.equal(typeof api.isAuthValid, 'function');
    assert.equal(typeof api.resolveAuthFile, 'function');
    assert.equal(typeof api.getCookieExpiryInfo, 'function');
    assert.equal(typeof api.installAuthFile, 'function');
    assert.equal(typeof api.buildSSBCookieHeader, 'function');
    assert.equal(typeof api.readAuthState, 'function');
    assert.equal(typeof api.fetchAccessToken, 'function');
    assert.equal(typeof api.createSSBClient, 'function');
    assert.equal(typeof api.classifySSBHttpError, 'function');
    assert.equal(typeof api.normalizeSelectionId, 'function');
  });
});
