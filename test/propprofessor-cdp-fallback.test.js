'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('node:events');

const { fetchAccessToken, fetchAccessTokenViaCDP, fetchAccessTokenViaEgo } = require('../lib/propprofessor-auth');

let tmpDir;
let authFile;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cdp-test-'));
  authFile = path.join(tmpDir, 'auth.json');
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      cookies: [{ domain: '.propprofessor.com', name: '__Secure-next-auth.session-token', value: 'session-value' }],
      origins: []
    }),
    'utf8'
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Shared stub WebSocket factory. Captures sent messages and feeds back
// pre-canned responses in order. Fires 'open' on next tick.
function makeStubWebSocket(responses) {
  const sent = [];
  const listeners = {};
  let onMessageCb = null;
  let responseIdx = 0;

  function StubWebSocket(url) {
    this.url = url;
    this.sent = sent;
    setImmediate(() => {
      (listeners.open || []).forEach((cb) => cb({}));
    });
    this.addEventListener = function (event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      if (event === 'message') onMessageCb = cb;
    };
    this.removeEventListener = function (event, cb) {
      if (!listeners[event]) return;
      listeners[event] = listeners[event].filter((x) => x !== cb);
      if (event === 'message' && onMessageCb === cb) onMessageCb = null;
    };
    this.send = function (raw) {
      sent.push(JSON.parse(raw));
      const r = responses[responseIdx++];
      if (r && onMessageCb) onMessageCb({ data: JSON.stringify(r) });
    };
    this.close = function () {};
  }
  StubWebSocket._listeners = listeners;
  return { StubWebSocket, sent, listeners };
}

// ===== fetchAccessTokenViaCDP (the new function in isolation) =====

describe('fetchAccessTokenViaCDP', () => {
  it('throws when no WebSocket implementation is available', async () => {
    // globalThis.WebSocket exists in Node 22+, so to test the "no WS" path
    // we monkey-patch it. Restore after.
    const original = globalThis.WebSocket;
    try {
      globalThis.WebSocket = undefined;
      await assert.rejects(
        fetchAccessTokenViaCDP({
          fetchImpl: async () => ({}),
          WebSocketImpl: undefined
        }),
        /WebSocket implementation/
      );
    } finally {
      globalThis.WebSocket = original;
    }
  });

  it('throws when no fetch implementation is available', async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = undefined;
      await assert.rejects(
        fetchAccessTokenViaCDP({
          fetchImpl: undefined,
          WebSocketImpl: function () {}
        }),
        /fetch implementation/
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it('throws when the version endpoint returns non-OK', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await assert.rejects(
      fetchAccessTokenViaCDP({ fetchImpl, WebSocketImpl: function () {} }),
      /CDP version endpoint returned 503/
    );
  });

  it('throws when version response is missing webSocketDebuggerUrl', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ Browser: 'Chrome' })
    });
    await assert.rejects(
      fetchAccessTokenViaCDP({
        fetchImpl,
        WebSocketImpl: function () {}
      }),
      /missing webSocketDebuggerUrl/
    );
  });

  it('JSON-escapes the access-token URL in the Runtime.evaluate expression', async () => {
    // Regression test for the unsafe `${ACCESS_TOKEN_URL}` template
    // interpolation in the Runtime.evaluate expression. The current constant
    // is a hardcoded HTTPS URL with no special characters, but the pattern
    // is fragile — any future change to ACCESS_TOKEN_URL (or a maintainer
    // who adds a second interpolated value) would silently re-introduce a
    // CDP-eval injection. The fix wraps the URL in JSON.stringify before
    // inlining, so we assert the produced expression contains the JSON
    // string literal form (with quotes) rather than the raw URL.
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' })
    });
    const responses = [
      { id: 1, result: { targetInfos: [{ type: 'page', url: 'https://app.propprofessor.com/', targetId: 'T1' }] } },
      { id: 2, result: { sessionId: 'S' } },
      { id: 3, result: { result: { value: JSON.stringify({ token: 't', exp: 1, perm: {} }) } } }
    ];
    const { StubWebSocket, sent } = makeStubWebSocket(responses);
    await fetchAccessTokenViaCDP({ fetchImpl, WebSocketImpl: StubWebSocket });
    const evalCall = sent.find((m) => m.method === 'Runtime.evaluate');
    const expr = evalCall.params.expression;
    // The URL must appear as a JSON-stringified literal (with surrounding
    // double quotes), NOT as a bare concatenation that could be hijacked.
    assert.ok(
      expr.includes('"https://app.propprofessor.com/api/access-token"'),
      `Runtime.evaluate expression should JSON-escape the URL; got: ${expr}`
    );
    assert.ok(
      !expr.includes("'https://app.propprofessor.com/api/access-token'"),
      `Runtime.evaluate expression should not use the old single-quoted interpolation; got: ${expr}`
    );
  });

  it('happy path: version -> ws -> create target -> settle -> fetch -> returns token', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc'
      })
    });
    const responses = [
      // Target.getTargets
      { id: 1, result: { targetInfos: [] } },
      // Target.createTarget
      { id: 2, result: { targetId: 'TARGET_1' } },
      // Target.attachToTarget
      { id: 3, result: { sessionId: 'SESS_1' } },
      // Settle poll: newly created target is already on app.propprofessor.com and loaded
      {
        id: 4,
        result: { result: { value: JSON.stringify({ href: 'https://app.propprofessor.com/', ready: 'complete' }) } }
      },
      // Runtime.evaluate (returns the access token)
      {
        id: 5,
        result: { result: { value: JSON.stringify({ token: 'cdp-jwt', exp: 9999, perm: { sportsbook: true } }) } }
      }
    ];
    const { StubWebSocket, sent } = makeStubWebSocket(responses);

    const result = await fetchAccessTokenViaCDP({
      fetchImpl,
      WebSocketImpl: StubWebSocket,
      cdpTimeoutMs: 1000,
      runtimeTimeoutMs: 1000
    });

    assert.equal(result.token, 'cdp-jwt');
    assert.equal(result.exp, 9999);
    assert.deepEqual(result.perm, { sportsbook: true });
    assert.equal(sent[0].method, 'Target.getTargets');
    assert.equal(sent[1].method, 'Target.createTarget');
    assert.equal(sent[2].method, 'Target.attachToTarget');
    // A settle poll must run before the in-page fetch eval: a freshly created
    // target starts at about:blank (opaque origin) and needs to land on
    // app.propprofessor.com first.
    assert.equal(sent[3].method, 'Runtime.evaluate');
    assert.ok(sent[3].params.expression.includes('location.href'), 'first eval should be the settle poll');
    assert.equal(sent[4].method, 'Runtime.evaluate');
    assert.ok(sent[4].params.expression.includes('api/access-token'), 'fetch eval should come after the settle poll');
    assert.equal(sent[4].sessionId, 'SESS_1');
  });

  it('reuses an existing app.propprofessor.com tab instead of creating one', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' })
    });
    const responses = [
      // Target.getTargets returns an existing tab
      {
        id: 1,
        result: { targetInfos: [{ type: 'page', url: 'https://app.propprofessor.com/screen', targetId: 'EXISTING_1' }] }
      },
      // Target.attachToTarget
      { id: 2, result: { sessionId: 'SESS_X' } },
      // Runtime.evaluate
      { id: 3, result: { result: { value: JSON.stringify({ token: 't', exp: 1, perm: {} }) } } }
    ];
    const { StubWebSocket, sent } = makeStubWebSocket(responses);

    await fetchAccessTokenViaCDP({ fetchImpl, WebSocketImpl: StubWebSocket });
    const sentMethods = sent.map((m) => m.method);
    assert.ok(
      !sentMethods.includes('Target.createTarget'),
      'should not have called Target.createTarget when an existing tab is present'
    );
    assert.ok(sentMethods.includes('Target.attachToTarget'));
  });

  it('uses an explicitly configured versionUrl (e.g. port 9333) for the CDP version endpoint', async () => {
    let fetchedUrl = null;
    const fetchImpl = async (url) => {
      fetchedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/abc' })
      };
    };
    const responses = [
      { id: 1, result: { targetInfos: [{ type: 'page', url: 'https://app.propprofessor.com/', targetId: 'T1' }] } },
      { id: 2, result: { sessionId: 'S' } },
      { id: 3, result: { result: { value: JSON.stringify({ token: 't', exp: 1, perm: {} }) } } }
    ];
    const { StubWebSocket } = makeStubWebSocket(responses);
    await fetchAccessTokenViaCDP({
      versionUrl: 'http://127.0.0.1:9333/json/version',
      fetchImpl,
      WebSocketImpl: StubWebSocket
    });
    assert.equal(fetchedUrl, 'http://127.0.0.1:9333/json/version');
  });

  it('honors PROPPROFESSOR_CDP_VERSION_URL when no option is passed', async () => {
    const previous = process.env.PROPPROFESSOR_CDP_VERSION_URL;
    try {
      process.env.PROPPROFESSOR_CDP_VERSION_URL = 'http://127.0.0.1:9333/json/version';
      let fetchedUrl = null;
      const fetchImpl = async (url) => {
        fetchedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/abc' })
        };
      };
      const responses = [
        { id: 1, result: { targetInfos: [{ type: 'page', url: 'https://app.propprofessor.com/', targetId: 'T1' }] } },
        { id: 2, result: { sessionId: 'S' } },
        { id: 3, result: { result: { value: JSON.stringify({ token: 't', exp: 1, perm: {} }) } } }
      ];
      const { StubWebSocket } = makeStubWebSocket(responses);
      await fetchAccessTokenViaCDP({ fetchImpl, WebSocketImpl: StubWebSocket });
      assert.equal(fetchedUrl, 'http://127.0.0.1:9333/json/version');
    } finally {
      if (previous === undefined) delete process.env.PROPPROFESSOR_CDP_VERSION_URL;
      else process.env.PROPPROFESSOR_CDP_VERSION_URL = previous;
    }
  });

  it('explicit versionUrl wins over PROPPROFESSOR_CDP_VERSION_URL', async () => {
    const previous = process.env.PROPPROFESSOR_CDP_VERSION_URL;
    try {
      process.env.PROPPROFESSOR_CDP_VERSION_URL = 'http://127.0.0.1:9333/json/version';
      let fetchedUrl = null;
      const fetchImpl = async (url) => {
        fetchedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9444/devtools/browser/abc' })
        };
      };
      const responses = [
        { id: 1, result: { targetInfos: [{ type: 'page', url: 'https://app.propprofessor.com/', targetId: 'T1' }] } },
        { id: 2, result: { sessionId: 'S' } },
        { id: 3, result: { result: { value: JSON.stringify({ token: 't', exp: 1, perm: {} }) } } }
      ];
      const { StubWebSocket } = makeStubWebSocket(responses);
      await fetchAccessTokenViaCDP({
        versionUrl: 'http://127.0.0.1:9444/json/version',
        fetchImpl,
        WebSocketImpl: StubWebSocket
      });
      assert.equal(fetchedUrl, 'http://127.0.0.1:9444/json/version');
    } finally {
      if (previous === undefined) delete process.env.PROPPROFESSOR_CDP_VERSION_URL;
      else process.env.PROPPROFESSOR_CDP_VERSION_URL = previous;
    }
  });

  it('defaults to the 127.0.0.1:9222 version endpoint when nothing is configured', async () => {
    const previous = process.env.PROPPROFESSOR_CDP_VERSION_URL;
    try {
      delete process.env.PROPPROFESSOR_CDP_VERSION_URL;
      let fetchedUrl = null;
      const fetchImpl = async (url) => {
        fetchedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' })
        };
      };
      const responses = [
        { id: 1, result: { targetInfos: [{ type: 'page', url: 'https://app.propprofessor.com/', targetId: 'T1' }] } },
        { id: 2, result: { sessionId: 'S' } },
        { id: 3, result: { result: { value: JSON.stringify({ token: 't', exp: 1, perm: {} }) } } }
      ];
      const { StubWebSocket } = makeStubWebSocket(responses);
      await fetchAccessTokenViaCDP({ fetchImpl, WebSocketImpl: StubWebSocket });
      assert.equal(fetchedUrl, 'http://127.0.0.1:9222/json/version');
    } finally {
      if (previous === undefined) delete process.env.PROPPROFESSOR_CDP_VERSION_URL;
      else process.env.PROPPROFESSOR_CDP_VERSION_URL = previous;
    }
  });

  it('waits for a newly created target to settle on app.propprofessor.com before the in-page fetch', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' })
    });
    const responses = [
      // Target.getTargets (no existing PP tab → create)
      { id: 1, result: { targetInfos: [] } },
      // Target.createTarget
      { id: 2, result: { targetId: 'TARGET_1' } },
      // Target.attachToTarget
      { id: 3, result: { sessionId: 'SESS_1' } },
      // Settle poll #1: still at about:blank (opaque origin) — must NOT fetch yet
      { id: 4, result: { result: { value: JSON.stringify({ href: 'about:blank', ready: 'loading' }) } } },
      // Settle poll #2: landed on app.propprofessor.com and loaded
      {
        id: 5,
        result: { result: { value: JSON.stringify({ href: 'https://app.propprofessor.com/', ready: 'complete' }) } }
      },
      // In-page fetch (only after the settled state was observed)
      { id: 6, result: { result: { value: JSON.stringify({ token: 'cdp-jwt', exp: 9999, perm: {} }) } } }
    ];
    const { StubWebSocket, sent } = makeStubWebSocket(responses);

    const result = await fetchAccessTokenViaCDP({
      fetchImpl,
      WebSocketImpl: StubWebSocket,
      cdpTimeoutMs: 1000,
      runtimeTimeoutMs: 1000
    });
    assert.equal(result.token, 'cdp-jwt');

    const evals = sent.filter((m) => m.method === 'Runtime.evaluate');
    assert.equal(evals.length, 3, 'two settle polls + one fetch eval');
    assert.ok(evals[0].params.expression.includes('location.href'), 'poll 1 checks page location');
    assert.ok(evals[1].params.expression.includes('location.href'), 'poll 2 checks page location');
    assert.ok(
      evals[2].params.expression.includes('"https://app.propprofessor.com/api/access-token"'),
      'the fetch eval must run only after the page settled on the app origin'
    );
    const fetchSentIdx = sent.findIndex(
      (m) => m.method === 'Runtime.evaluate' && m.params.expression.includes('api/access-token')
    );
    const settledPollSentIdx = sent.findIndex(
      (m) => m.method === 'Runtime.evaluate' && m.params.expression.includes('location.href')
    );
    assert.ok(
      fetchSentIdx > settledPollSentIdx,
      'fetch eval must be sent after the poll that observed the settled state'
    );
  });

  it('throws a clear bounded error when a created target never settles on the app origin', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' })
    });
    const neverSettled = { result: { value: JSON.stringify({ href: 'about:blank', ready: 'loading' }) } };
    const responses = [
      { id: 1, result: { targetInfos: [] } },
      { id: 2, result: { targetId: 'TARGET_1' } },
      { id: 3, result: { sessionId: 'SESS_1' } },
      { id: 4, result: neverSettled },
      { id: 5, result: neverSettled }
    ];
    const { StubWebSocket } = makeStubWebSocket(responses);
    await assert.rejects(
      fetchAccessTokenViaCDP({
        fetchImpl,
        WebSocketImpl: StubWebSocket,
        cdpTimeoutMs: 1000,
        runtimeTimeoutMs: 250
      }),
      /did not settle on app\.propprofessor\.com/
    );
  });

  it('throws when the in-page fetch returns an error object', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' })
    });
    const responses = [
      { id: 1, result: { targetInfos: [{ type: 'page', url: 'https://app.propprofessor.com/', targetId: 'T1' }] } },
      { id: 2, result: { sessionId: 'S' } },
      { id: 3, result: { result: { value: JSON.stringify({ error: 'browser fetch failed' }) } } }
    ];
    const { StubWebSocket } = makeStubWebSocket(responses);

    await assert.rejects(fetchAccessTokenViaCDP({ fetchImpl, WebSocketImpl: StubWebSocket }), /browser fetch failed/);
  });

  it('throws when the in-page fetch returns no token field', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' })
    });
    const responses = [
      { id: 1, result: { targetInfos: [{ type: 'page', url: 'https://app.propprofessor.com/', targetId: 'T1' }] } },
      { id: 2, result: { sessionId: 'S' } },
      { id: 3, result: { result: { value: JSON.stringify({ unexpected: 'shape' }) } } }
    ];
    const { StubWebSocket } = makeStubWebSocket(responses);

    await assert.rejects(fetchAccessTokenViaCDP({ fetchImpl, WebSocketImpl: StubWebSocket }), /no token/);
  });
});

// ===== fetchAccessToken fallback behavior =====

describe('fetchAccessToken — Vercel 429 self-heal via browser fallbacks (ego → CDP)', () => {
  it('falls back to CDP when got-scraping returns 429 (ego disabled)', async () => {
    const cdpImpl = async () => ({
      token: 'cdp-jwt',
      exp: Math.floor(Date.now() / 1000) + 600,
      perm: { sportsbook: true }
    });
    const result = await fetchAccessToken({
      authFile,
      gotScrapingImpl: async () => ({
        statusCode: 429,
        body: '<html>Vercel security checkpoint</html>'
      }),
      cdpImpl,
      enableEgoFallback: false
    });
    assert.equal(result.token, 'cdp-jwt');
  });

  it('falls back to CDP when got-scraping returns 401 (ego disabled)', async () => {
    const cdpImpl = async () => ({ token: 'cdp-jwt', exp: 9999, perm: {} });
    const result = await fetchAccessToken({
      authFile,
      gotScrapingImpl: async () => ({ statusCode: 401, body: '{"error":"Unauthorized"}' }),
      cdpImpl,
      enableEgoFallback: false
    });
    assert.equal(result.token, 'cdp-jwt');
  });

  it('falls back to CDP when got-scraping throws a network error (ego disabled)', async () => {
    const cdpImpl = async () => ({ token: 'cdp-jwt', exp: 9999, perm: {} });
    const result = await fetchAccessToken({
      authFile,
      gotScrapingImpl: async () => {
        throw new Error('ECONNRESET');
      },
      cdpImpl,
      enableEgoFallback: false
    });
    assert.equal(result.token, 'cdp-jwt');
  });

  it('does NOT call CDP when got-scraping returns 500 (non-retryable, non-Vercel)', async () => {
    let cdpCalled = false;
    const cdpImpl = async () => {
      cdpCalled = true;
      return { token: 'should-not-be-used', exp: 1, perm: {} };
    };
    await assert.rejects(
      fetchAccessToken({
        authFile,
        gotScrapingImpl: async () => ({
          statusCode: 500,
          body: '{"error":"internal server error"}'
        }),
        cdpImpl
      }),
      /Failed to fetch PropProfessor access token/
    );
    assert.equal(cdpCalled, false, 'CDP should not be called for non-429/non-401 failures');
  });

  it('does NOT call CDP when got-scraping succeeds', async () => {
    let cdpCalled = false;
    const cdpImpl = async () => {
      cdpCalled = true;
      return { token: 'should-not-be-used', exp: 1, perm: {} };
    };
    const result = await fetchAccessToken({
      authFile,
      gotScrapingImpl: async () => ({
        statusCode: 200,
        body: JSON.stringify({ token: 'primary-jwt', exp: 9999, perm: { sportsbook: true } })
      }),
      cdpImpl
    });
    assert.equal(result.token, 'primary-jwt');
    assert.equal(cdpCalled, false, 'CDP should not be called when got-scraping succeeds');
  });

  it('throws combined error when BOTH got-scraping and CDP fail', async () => {
    const cdpImpl = async () => {
      throw new Error('CDP: no Chrome running');
    };
    await assert.rejects(
      fetchAccessToken({
        authFile,
        gotScrapingImpl: async () => ({ statusCode: 429, body: 'vercel wall' }),
        cdpImpl,
        enableEgoFallback: false
      }),
      (err) => {
        assert.equal(err.code, 'TOKEN_REFRESH_FAILED_BOTH_PATHS');
        assert.match(err.message, /Both token refresh paths failed/);
        assert.match(err.message, /HTTP 429/);
        assert.match(err.message, /no Chrome running/);
        assert.ok(err.cause && err.cause.gotErr && err.cause.cdpErr);
        return true;
      }
    );
  });

  it('does NOT fall back to CDP when enableCdpFallback is false (got 429)', async () => {
    let cdpCalled = false;
    const cdpImpl = async () => {
      cdpCalled = true;
      return { token: 'x', exp: 1, perm: {} };
    };
    await assert.rejects(
      fetchAccessToken({
        authFile,
        gotScrapingImpl: async () => ({ statusCode: 429, body: 'vercel wall' }),
        cdpImpl,
        enableCdpFallback: false,
        enableEgoFallback: false
      }),
      /HTTP 429/
    );
    assert.equal(cdpCalled, false);
  });

  it('does NOT fall back to CDP when enableCdpFallback is false (got network error)', async () => {
    let cdpCalled = false;
    const cdpImpl = async () => {
      cdpCalled = true;
      return { token: 'x', exp: 1, perm: {} };
    };
    await assert.rejects(
      fetchAccessToken({
        authFile,
        gotScrapingImpl: async () => {
          throw new Error('ECONNRESET');
        },
        cdpImpl,
        enableCdpFallback: false,
        enableEgoFallback: false
      }),
      /ECONNRESET/
    );
    assert.equal(cdpCalled, false);
  });

  it('got-scraping is called exactly once before falling back to CDP (ego disabled)', async () => {
    let gotCalls = 0;
    const cdpImpl = async () => ({ token: 'cdp-jwt', exp: 9999, perm: {} });
    const result = await fetchAccessToken({
      authFile,
      gotScrapingImpl: async () => {
        gotCalls += 1;
        return { statusCode: 429, body: 'vercel wall' };
      },
      cdpImpl,
      enableEgoFallback: false
    });
    assert.equal(result.token, 'cdp-jwt');
    assert.equal(gotCalls, 1, 'got-scraping should be called exactly once before falling back');
  });

  it('tries ego before CDP: ego success short-circuits CDP (got 429)', async () => {
    const order = [];
    const result = await fetchAccessToken({
      authFile,
      gotScrapingImpl: async () => ({ statusCode: 429, body: 'vercel wall' }),
      egoImpl: async () => {
        order.push('ego');
        return { token: 'ego-jwt', exp: Math.floor(Date.now() / 1000) + 600, perm: {} };
      },
      cdpImpl: async () => {
        order.push('cdp');
        return { token: 'cdp-jwt', exp: 9999, perm: {} };
      }
    });
    assert.equal(result.token, 'ego-jwt');
    assert.deepEqual(order, ['ego'], 'ego must be tried first and CDP must not be invoked when ego succeeds');
  });

  it('tries ego before CDP: ego fails then CDP succeeds (got 429)', async () => {
    const order = [];
    const result = await fetchAccessToken({
      authFile,
      gotScrapingImpl: async () => ({ statusCode: 429, body: 'vercel wall' }),
      egoImpl: async () => {
        order.push('ego');
        throw new Error('ego: task space pp-token-refresh is busy');
      },
      cdpImpl: async () => {
        order.push('cdp');
        return { token: 'cdp-jwt', exp: 9999, perm: { sportsbook: true } };
      }
    });
    assert.equal(result.token, 'cdp-jwt');
    assert.deepEqual(order, ['ego', 'cdp'], 'CDP must be tried only after ego fails');
  });

  it('tries ego before CDP: ego fails then CDP succeeds (got 401)', async () => {
    const order = [];
    const result = await fetchAccessToken({
      authFile,
      gotScrapingImpl: async () => ({ statusCode: 401, body: '{"error":"Unauthorized"}' }),
      egoImpl: async () => {
        order.push('ego');
        throw new Error('ego: no ego-browser binary');
      },
      cdpImpl: async () => {
        order.push('cdp');
        return { token: 'cdp-jwt', exp: 9999, perm: {} };
      }
    });
    assert.equal(result.token, 'cdp-jwt');
    assert.deepEqual(order, ['ego', 'cdp']);
  });

  it('tries ego before CDP: ego fails then CDP succeeds (got network error)', async () => {
    const order = [];
    const result = await fetchAccessToken({
      authFile,
      gotScrapingImpl: async () => {
        throw new Error('ECONNRESET');
      },
      egoImpl: async () => {
        order.push('ego');
        throw new Error('ego: timed out');
      },
      cdpImpl: async () => {
        order.push('cdp');
        return { token: 'cdp-jwt', exp: 9999, perm: {} };
      }
    });
    assert.equal(result.token, 'cdp-jwt');
    assert.deepEqual(order, ['ego', 'cdp']);
  });
});

// ===== fetchAccessTokenViaEgo (the ego-browser fallback in isolation) =====

// JWT-shaped fake token: 3 non-empty base64url segments (matching the
// validation fetchAccessTokenViaEgo applies). Never a real credential.
const EGO_FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0b2tlbiJ9.c2lnbmF0dXJl';

// Fake `spawn` for fetchAccessTokenViaEgo tests. Captures the command/args
// and the stdin script, then feeds canned stdout/stderr and an exit code on
// the next tick. Can also simulate a spawn error (missing executable) or a
// hang (never emits 'close') for timeout tests. Tests never invoke the real
// ego-browser binary.
function makeFakeEgoSpawn({ stdout = '', stderr = '', exitCode = 0, spawnError = null, hang = false } = {}) {
  const calls = [];
  function FakeEgoSpawn(command, args, options) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      written: '',
      end(data) {
        if (data !== undefined) this.written += data;
      }
    };
    child.kill = () => {
      child.killed = true;
    };
    const call = { command, args, options, child };
    calls.push(call);
    process.nextTick(() => {
      if (spawnError) {
        child.emit('error', spawnError instanceof Error ? spawnError : new Error(String(spawnError)));
        return;
      }
      if (hang) return;
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', exitCode);
    });
    return child;
  }
  return { FakeEgoSpawn, calls };
}

describe('fetchAccessTokenViaEgo', () => {
  it('spawns ego-browser nodejs, parses the single JSON line, and returns the token', async () => {
    const { FakeEgoSpawn, calls } = makeFakeEgoSpawn({
      stdout: JSON.stringify({ ok: true, token: EGO_FAKE_JWT, exp: 9999, perm: { sportsbook: true } }) + '\n'
    });
    const result = await fetchAccessTokenViaEgo({ spawnImpl: FakeEgoSpawn });
    assert.equal(result.token, EGO_FAKE_JWT);
    assert.equal(result.exp, 9999);
    assert.deepEqual(result.perm, { sportsbook: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'ego-browser');
    assert.deepEqual(calls[0].args, ['nodejs']);
    assert.ok(calls[0].options.stdio, 'should pipe stdio (no shell)');
    const script = calls[0].child.stdin.written;
    assert.ok(
      script.includes('useOrCreateTaskSpace("pp-token-refresh")'),
      'should use the named default task space (ego creates it on first use)'
    );
    assert.ok(
      script.includes("openOrReuseTab('https://app.propprofessor.com/'"),
      'should open/reuse a same-origin tab before browserFetch'
    );
    assert.ok(
      script.includes('"https://app.propprofessor.com/api/access-token"'),
      'should embed the JSON-escaped access-token URL'
    );
    assert.ok(script.includes('process.stdout.write'), 'should emit the response via process.stdout.write');
    assert.ok(!script.includes(EGO_FAKE_JWT), 'the script itself must not contain the token');
  });

  it('parses the JSON response line from the captured stderr channel (ego-browser routes script output there)', async () => {
    const { FakeEgoSpawn } = makeFakeEgoSpawn({
      stderr: JSON.stringify({ ok: true, token: EGO_FAKE_JWT, exp: 9999, perm: {} }) + '\n'
    });
    const result = await fetchAccessTokenViaEgo({ spawnImpl: FakeEgoSpawn });
    assert.equal(result.token, EGO_FAKE_JWT);
  });

  it('uses PROPPROFESSOR_EGO_TASK_SPACE env var for the task space id', async () => {
    const previous = process.env.PROPPROFESSOR_EGO_TASK_SPACE;
    try {
      process.env.PROPPROFESSOR_EGO_TASK_SPACE = '42';
      const { FakeEgoSpawn, calls } = makeFakeEgoSpawn({
        stdout: JSON.stringify({ ok: true, token: EGO_FAKE_JWT, exp: 1, perm: {} }) + '\n'
      });
      await fetchAccessTokenViaEgo({ spawnImpl: FakeEgoSpawn });
      assert.ok(calls[0].child.stdin.written.includes('useOrCreateTaskSpace(42)'));
    } finally {
      if (previous === undefined) delete process.env.PROPPROFESSOR_EGO_TASK_SPACE;
      else process.env.PROPPROFESSOR_EGO_TASK_SPACE = previous;
    }
  });

  it('uses an explicitly passed taskSpaceId option', async () => {
    const { FakeEgoSpawn, calls } = makeFakeEgoSpawn({
      stdout: JSON.stringify({ ok: true, token: EGO_FAKE_JWT, exp: 1, perm: {} }) + '\n'
    });
    const result = await fetchAccessTokenViaEgo({ taskSpaceId: 42, spawnImpl: FakeEgoSpawn });
    assert.equal(result.token, EGO_FAKE_JWT);
    assert.ok(calls[0].child.stdin.written.includes('useOrCreateTaskSpace(42)'));
  });

  it('rejects invalid explicit taskSpaceId values', async () => {
    for (const bad of [0, -3, 7.5, 'abc']) {
      await assert.rejects(
        fetchAccessTokenViaEgo({ taskSpaceId: bad, spawnImpl: makeFakeEgoSpawn().FakeEgoSpawn }),
        /Invalid ego task space id/
      );
    }
  });

  it('rejects invalid PROPPROFESSOR_EGO_TASK_SPACE values', async () => {
    const previous = process.env.PROPPROFESSOR_EGO_TASK_SPACE;
    try {
      process.env.PROPPROFESSOR_EGO_TASK_SPACE = 'abc';
      await assert.rejects(
        fetchAccessTokenViaEgo({ spawnImpl: makeFakeEgoSpawn().FakeEgoSpawn }),
        /Invalid PROPPROFESSOR_EGO_TASK_SPACE value/
      );
    } finally {
      if (previous === undefined) delete process.env.PROPPROFESSOR_EGO_TASK_SPACE;
      else process.env.PROPPROFESSOR_EGO_TASK_SPACE = previous;
    }
  });

  it('rejects when the JSON line has no token', async () => {
    const { FakeEgoSpawn } = makeFakeEgoSpawn({
      stdout: JSON.stringify({ ok: true, exp: 9999 }) + '\n'
    });
    await assert.rejects(fetchAccessTokenViaEgo({ spawnImpl: FakeEgoSpawn }), /no token/);
  });

  it('rejects a truncated/mangled token line — stderr diagnostics must never become token output', async () => {
    // cliLog-style truncation (e.g. "eyJhbG...7890") is not a valid JWT, so
    // it must be rejected rather than surfaced as a token.
    const { FakeEgoSpawn } = makeFakeEgoSpawn({
      stderr: JSON.stringify({ ok: true, token: 'eyJhbG...7890', exp: 1 }) + '\n'
    });
    await assert.rejects(fetchAccessTokenViaEgo({ spawnImpl: FakeEgoSpawn }), /no token/);
  });

  it('rejects when exp is missing or invalid', async () => {
    const { FakeEgoSpawn } = makeFakeEgoSpawn({
      stdout: JSON.stringify({ ok: true, token: EGO_FAKE_JWT, exp: 0 }) + '\n'
    });
    await assert.rejects(fetchAccessTokenViaEgo({ spawnImpl: FakeEgoSpawn }), /invalid exp/);
  });

  it('rejects with the ego-side error when the JSON line reports ok:false', async () => {
    const { FakeEgoSpawn } = makeFakeEgoSpawn({
      stdout: JSON.stringify({ ok: false, error: 'task space pp-token-refresh is busy' }) + '\n'
    });
    await assert.rejects(fetchAccessTokenViaEgo({ spawnImpl: FakeEgoSpawn }), /task space pp-token-refresh is busy/);
  });

  it('rejects with a clear error when the captured output contains no JSON line (malformed output)', async () => {
    const { FakeEgoSpawn } = makeFakeEgoSpawn({ stderr: 'ego runtime banner\nnot json at all\n', exitCode: 1 });
    await assert.rejects(fetchAccessTokenViaEgo({ spawnImpl: FakeEgoSpawn }), /no usable JSON output/);
  });

  it('ignores non-contract stderr noise — only the JSON response line is parsed', async () => {
    const { FakeEgoSpawn } = makeFakeEgoSpawn({
      stdout: JSON.stringify({ ok: true, token: EGO_FAKE_JWT, exp: 9999, perm: {} }) + '\n',
      stderr: 'some noise\n'
    });
    const result = await fetchAccessTokenViaEgo({ spawnImpl: FakeEgoSpawn });
    assert.equal(result.token, EGO_FAKE_JWT);
  });

  it('rejects when ego-browser fails to spawn (missing executable)', async () => {
    const { FakeEgoSpawn } = makeFakeEgoSpawn({
      spawnError: Object.assign(new Error('spawn ego-browser ENOENT'), { code: 'ENOENT' })
    });
    await assert.rejects(fetchAccessTokenViaEgo({ spawnImpl: FakeEgoSpawn }), /Failed to start ego-browser/);
  });

  it('rejects when the spawn implementation throws synchronously', async () => {
    const throwingSpawn = () => {
      throw new Error('boom');
    };
    await assert.rejects(fetchAccessTokenViaEgo({ spawnImpl: throwingSpawn }), /Failed to spawn ego-browser: boom/);
  });

  it('normalizes a null synchronous spawn failure', async () => {
    const throwingSpawn = () => {
      throw null;
    };
    await assert.rejects(fetchAccessTokenViaEgo({ spawnImpl: throwingSpawn }), /Failed to spawn ego-browser: null/);
  });

  it('times out and kills the child when ego-browser hangs', async () => {
    const { FakeEgoSpawn, calls } = makeFakeEgoSpawn({ hang: true });
    await assert.rejects(fetchAccessTokenViaEgo({ spawnImpl: FakeEgoSpawn, timeoutMs: 100 }), /timed out after 100ms/);
    assert.equal(calls[0].child.killed, true, 'should kill the hung child');
  });
});

// ===== fetchAccessToken — ego-browser first, then CDP =====

describe('fetchAccessToken — ego-browser is the first browser fallback (before CDP)', () => {
  it('does NOT call CDP when ego succeeds', async () => {
    let cdpCalled = false;
    const result = await fetchAccessToken({
      authFile,
      gotScrapingImpl: async () => ({ statusCode: 429, body: 'vercel wall' }),
      egoImpl: async () => ({
        token: 'ego-jwt',
        exp: Math.floor(Date.now() / 1000) + 600,
        perm: { sportsbook: true }
      }),
      cdpImpl: async () => {
        cdpCalled = true;
        return { token: 'should-not-be-used', exp: 1, perm: {} };
      }
    });
    assert.equal(result.token, 'ego-jwt');
    assert.equal(cdpCalled, false, 'CDP should not be called when ego succeeds');
  });

  it('does NOT call ego when got-scraping succeeds', async () => {
    let egoCalled = false;
    const result = await fetchAccessToken({
      authFile,
      gotScrapingImpl: async () => ({
        statusCode: 200,
        body: JSON.stringify({ token: 'primary-jwt', exp: 9999, perm: { sportsbook: true } })
      }),
      cdpImpl: async () => {
        throw new Error('should not be called');
      },
      egoImpl: async () => {
        egoCalled = true;
        return { token: 'x', exp: 1, perm: {} };
      }
    });
    assert.equal(result.token, 'primary-jwt');
    assert.equal(egoCalled, false);
  });

  it('throws a combined error including ego failure without exposing tokens', async () => {
    const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0b2tlbiJ9.c2lnbmF0dXJl';
    await assert.rejects(
      fetchAccessToken({
        authFile,
        gotScrapingImpl: async () => ({ statusCode: 429, body: 'vercel wall' }),
        cdpImpl: async () => {
          throw new Error('CDP: no Chrome running');
        },
        egoImpl: async () => {
          throw new Error(`ego: task space busy ${FAKE_JWT}`);
        }
      }),
      (err) => {
        assert.equal(err.code, 'TOKEN_REFRESH_FAILED_BOTH_PATHS');
        assert.match(err.message, /Both token refresh paths failed/);
        assert.match(err.message, /HTTP 429/);
        assert.match(err.message, /no Chrome running/);
        assert.match(err.message, /ego: task space busy/);
        assert.ok(
          err.message.indexOf('ego:') < err.message.indexOf('CDP:'),
          'combined error should list ego before CDP'
        );
        assert.ok(!err.message.includes(FAKE_JWT), 'combined error must not expose token values');
        assert.ok(err.cause && err.cause.gotErr && err.cause.cdpErr && err.cause.egoErr);
        return true;
      }
    );
  });

  it('skips ego when PP_NO_EGO_FALLBACK=1', async () => {
    const previous = process.env.PP_NO_EGO_FALLBACK;
    let egoCalled = false;
    let cdpCalled = false;
    try {
      process.env.PP_NO_EGO_FALLBACK = '1';
      await assert.rejects(
        fetchAccessToken({
          authFile,
          gotScrapingImpl: async () => ({ statusCode: 429, body: 'vercel wall' }),
          cdpImpl: async () => {
            cdpCalled = true;
            throw new Error('CDP: no Chrome running');
          },
          egoImpl: async () => {
            egoCalled = true;
            return { token: 'x', exp: 1, perm: {} };
          }
        }),
        /Both token refresh paths failed/
      );
    } finally {
      if (previous === undefined) delete process.env.PP_NO_EGO_FALLBACK;
      else process.env.PP_NO_EGO_FALLBACK = previous;
    }
    assert.equal(egoCalled, false, 'ego should not be called when PP_NO_EGO_FALLBACK=1');
    assert.equal(cdpCalled, true, 'CDP should still be attempted when ego is disabled');
  });

  it('skips ego when enableEgoFallback is false', async () => {
    let egoCalled = false;
    let cdpCalled = false;
    await assert.rejects(
      fetchAccessToken({
        authFile,
        gotScrapingImpl: async () => ({ statusCode: 429, body: 'vercel wall' }),
        cdpImpl: async () => {
          cdpCalled = true;
          throw new Error('CDP: no Chrome running');
        },
        egoImpl: async () => {
          egoCalled = true;
          return { token: 'x', exp: 1, perm: {} };
        },
        enableEgoFallback: false
      }),
      /Both token refresh paths failed/
    );
    assert.equal(egoCalled, false);
    assert.equal(cdpCalled, true, 'CDP should still be attempted when ego is disabled');
  });
});
