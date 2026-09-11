'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { installAuthFile } = require('../lib/ssb-api');

const repoRoot = path.join(__dirname, '..');
const expectedUserAuthFile = path.join(os.homedir(), '.ssb', 'auth.json');
const expectedRepoAuthFile = path.join(repoRoot, 'auth.json');

describe('ssb API auth file resolution', () => {
  it('defaults auth.json to the user-level path when AUTH_FILE is unset', () => {
    const script = `const fs = require('fs'); const os = require('os'); const path = require('path'); const originalExistsSync = fs.existsSync; fs.existsSync = file => String(file) === path.join(os.homedir(), '.ssb', 'auth.json'); const { DEFAULT_AUTH_FILE } = require(${JSON.stringify(path.join(repoRoot, 'lib', 'ssb-api'))}); console.log(DEFAULT_AUTH_FILE); fs.existsSync = originalExistsSync;`;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: '/tmp',
      encoding: 'utf8',
      env: { ...process.env, AUTH_FILE: '' }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expectedUserAuthFile);
  });

  it('honors AUTH_FILE when explicitly provided', () => {
    const customAuthFile = path.join('/tmp', 'custom-pp-auth.json');
    const script = `const { DEFAULT_AUTH_FILE } = require(${JSON.stringify(path.join(repoRoot, 'lib', 'ssb-api'))}); console.log(DEFAULT_AUTH_FILE);`;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: '/tmp',
      encoding: 'utf8',
      env: { ...process.env, AUTH_FILE: customAuthFile }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), customAuthFile);
  });

  it('exposes the fallback auth file search order', () => {
    const script = `const { getAuthFileCandidates } = require(${JSON.stringify(path.join(repoRoot, 'lib', 'ssb-api'))}); console.log(JSON.stringify(getAuthFileCandidates()));`;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: '/tmp',
      encoding: 'utf8',
      env: { ...process.env, AUTH_FILE: '' }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), [expectedUserAuthFile, expectedRepoAuthFile]);
  });

  it('can install a saved auth file into the user-level default location', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-auth-install-'));
    const sourceFile = path.join(tempDir, 'source-auth.json');
    const destinationFile = path.join(tempDir, '.ssb', 'auth.json');
    fs.writeFileSync(
      sourceFile,
      JSON.stringify({ cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'abc' }] }),
      'utf8'
    );

    try {
      const result = installAuthFile({ sourceFile, destinationFile });
      assert.equal(result.ok, true);
      assert.equal(result.destinationFile, destinationFile);
      assert.equal(fs.existsSync(destinationFile), true);
      assert.match(fs.readFileSync(destinationFile, 'utf8'), /session/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('getCookieExpiryInfo', () => {
  const { getCookieExpiryInfo } = require('../lib/ssb-api');

  function makeAuth(sessionTokenExpiry) {
    return {
      cookies: [
        {
          name: '__Secure-next-auth.session-token',
          value: 'tok_abc123',
          domain: 'app.propprofessor.com',
          expires: sessionTokenExpiry,
          session: false
        },
        {
          name: 'intercom-session-om1bixtq',
          value: 'ic_val',
          domain: '.propprofessor.com',
          expires: sessionTokenExpiry + 86400 * 365,
          session: false
        }
      ]
    };
  }

  it('returns ok status when session has >7 days remaining', () => {
    const nowSec = Date.now() / 1000;
    const expiry = nowSec + 86400 * 20; // 20 days from now
    const info = getCookieExpiryInfo(makeAuth(expiry), () => nowSec * 1000);
    assert.equal(info.status, 'ok');
    assert.equal(info.warning, null);
    assert.ok(info.daysRemaining > 19);
    assert.ok(info.daysRemaining < 21);
  });

  it('returns warning status when session has 3-7 days remaining', () => {
    const nowSec = Date.now() / 1000;
    const expiry = nowSec + 86400 * 5; // 5 days
    const info = getCookieExpiryInfo(makeAuth(expiry), () => nowSec * 1000);
    assert.equal(info.status, 'warning');
    assert.match(info.warning, /Consider re-login/);
    assert.ok(info.daysRemaining >= 4.9 && info.daysRemaining <= 5.1);
  });

  it('returns critical status when session has <=3 days remaining', () => {
    const nowSec = Date.now() / 1000;
    const expiry = nowSec + 86400 * 2; // 2 days
    const info = getCookieExpiryInfo(makeAuth(expiry), () => nowSec * 1000);
    assert.equal(info.status, 'critical');
    assert.match(info.warning, /pp-query login soon/);
  });

  it('returns expired status when session has <=0 days remaining', () => {
    const nowSec = Date.now() / 1000;
    const expiry = nowSec - 86400 * 3; // expired 3 days ago
    const info = getCookieExpiryInfo(makeAuth(expiry), () => nowSec * 1000);
    assert.equal(info.status, 'expired');
    assert.match(info.warning, /expired.*day.*ago/);
    assert.ok(info.daysRemaining < 0);
  });

  it('returns no_auth when auth is null', () => {
    const info = getCookieExpiryInfo(null, Date.now);
    assert.equal(info.status, 'no_auth');
    assert.equal(info.sessionExpiry, null);
  });

  it('returns no_session_token when session cookie is missing', () => {
    const auth = {
      cookies: [
        { name: 'intercom-session-x', value: 'v', domain: '.propprofessor.com', expires: 9999999999, session: false }
      ]
    };
    const info = getCookieExpiryInfo(auth, Date.now);
    assert.equal(info.status, 'no_session_token');
  });

  it('returns browser_session_only when only session cookies exist (expires -1)', () => {
    const auth = {
      cookies: [
        {
          name: '__Secure-next-auth.session-token',
          value: 'tok',
          domain: 'app.propprofessor.com',
          expires: -1,
          session: true
        }
      ]
    };
    const info = getCookieExpiryInfo(auth, Date.now);
    assert.equal(info.status, 'browser_session_only');
  });

  it('includes allCookieExpiries with per-cookie breakdown', () => {
    const nowSec = Date.now() / 1000;
    const expiry = nowSec + 86400 * 15;
    const info = getCookieExpiryInfo(makeAuth(expiry), () => nowSec * 1000);
    assert.ok(Array.isArray(info.allCookieExpiries));
    assert.equal(info.allCookieExpiries.length, 2); // session token + intercom
    assert.ok(info.allCookieExpiries[0].name);
    assert.ok(info.allCookieExpiries[0].expires);
    assert.ok(typeof info.allCookieExpiries[0].daysRemaining === 'number');
  });
});
