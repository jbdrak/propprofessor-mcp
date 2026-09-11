'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { classifySSBHttpError, createSSBClient, isAuthValid } = require('../lib/ssb-api');

describe('classifySSBHttpError', () => {
  it('classifies 401 as auth error, retryable', () => {
    const err = classifySSBHttpError({ status: 401, text: 'Unauthorized', source: 'HTTP' });
    assert.equal(err.code, 'SSB_AUTH_ERROR');
    assert.equal(err.retryable, true);
    assert.equal(err.category, 'auth');
    assert.equal(err.status, 401);
  });

  it('classifies 403 as validation error, not retryable', () => {
    const err = classifySSBHttpError({ status: 403, text: 'Forbidden', source: 'HTTP' });
    assert.equal(err.code, 'SSB_REQUEST_ERROR');
    assert.equal(err.retryable, false);
    assert.equal(err.category, 'validation');
  });

  it('classifies 429 as backend error, retryable', () => {
    const err = classifySSBHttpError({ status: 429, text: 'Too Many Requests', source: 'HTTP' });
    assert.equal(err.code, 'SSB_BACKEND_ERROR');
    assert.equal(err.retryable, true);
    assert.equal(err.category, 'backend');
  });

  it('classifies 500 as backend error, retryable', () => {
    const err = classifySSBHttpError({ status: 500, text: 'Internal Server Error', source: 'HTTP' });
    assert.equal(err.code, 'SSB_BACKEND_ERROR');
    assert.equal(err.retryable, true);
    assert.equal(err.category, 'backend');
  });

  it('classifies 502 as backend error, retryable', () => {
    const err = classifySSBHttpError({ status: 502, text: 'Bad Gateway', source: 'HTTP' });
    assert.equal(err.code, 'SSB_BACKEND_ERROR');
    assert.equal(err.retryable, true);
  });

  it('classifies 503 as backend error, retryable', () => {
    const err = classifySSBHttpError({ status: 503, text: 'Service Unavailable', source: 'HTTP' });
    assert.equal(err.code, 'SSB_BACKEND_ERROR');
    assert.equal(err.retryable, true);
  });

  it('classifies 504 as backend error, retryable', () => {
    const err = classifySSBHttpError({ status: 504, text: 'Gateway Timeout', source: 'HTTP' });
    assert.equal(err.code, 'SSB_BACKEND_ERROR');
    assert.equal(err.retryable, true);
  });

  it('classifies 400 as validation error, not retryable', () => {
    const err = classifySSBHttpError({ status: 400, text: 'Bad Request', source: 'HTTP' });
    assert.equal(err.code, 'SSB_REQUEST_ERROR');
    assert.equal(err.retryable, false);
    assert.equal(err.category, 'validation');
  });

  it('classifies 404 as validation error, not retryable', () => {
    const err = classifySSBHttpError({ status: 404, text: 'Not Found', source: 'HTTP' });
    assert.equal(err.code, 'SSB_REQUEST_ERROR');
    assert.equal(err.retryable, false);
  });

  it('includes status in error', () => {
    const err = classifySSBHttpError({ status: 429, text: 'Rate limited', source: 'HTTP' });
    assert.equal(err.status, 429);
  });

  it('classifies unknown 4xx as validation, not retryable', () => {
    const err = classifySSBHttpError({ status: 418, text: "I'm a teapot", source: 'HTTP' });
    assert.equal(err.retryable, false);
    assert.equal(err.category, 'validation');
  });

  it('classifies unknown 5xx as backend, retryable', () => {
    const err = classifySSBHttpError({ status: 555, text: 'Custom', source: 'HTTP' });
    assert.equal(err.retryable, true);
    assert.equal(err.category, 'backend');
  });
});

describe('HTTP retry logic', () => {
  it('retries on 429 up to retryDelays count', async () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-test-'));
    const authFile = path.join(dir, 'auth.json');
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'test-cookie' }]
      })
    );

    const calls = [];
    const client = createSSBClient({
      authFile,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'test', exp: Math.floor(Date.now() / 1000) + 600, perm: {} }),
        statusCode: 200
      }),
      fetchImpl: async (url, opts) => {
        calls.push({ url, opts });
        return { ok: false, status: 429, text: async () => 'Rate limited' };
      },
      now: () => Date.now(),
      retryDelaysMs: [50, 100]
    });
    try {
      await client.queryScreenOdds({});
    } catch {
      // Expected to throw after retries exhausted
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(calls.length >= 2, `Expected >= 2 calls, got ${calls.length}`);
  });
});

describe('isAuthValid', () => {
  it('returns false for null', () => {
    assert.equal(isAuthValid(null), false);
  });

  it('returns false for undefined', () => {
    assert.equal(isAuthValid(undefined), false);
  });

  it('returns false for empty object', () => {
    assert.equal(isAuthValid({}), false);
  });

  it('returns false for missing cookies', () => {
    assert.equal(isAuthValid({ origins: [] }), false);
  });

  it('returns true for valid auth state with SSB cookie', () => {
    assert.equal(
      isAuthValid({
        cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'abc' }]
      }),
      true
    );
  });

  it('returns false for empty cookies array', () => {
    assert.equal(isAuthValid({ cookies: [] }), false);
  });

  it('returns false for cookies with wrong domain', () => {
    assert.equal(
      isAuthValid({
        cookies: [{ domain: '.google.com', name: 'session', value: 'abc' }]
      }),
      false
    );
  });

  it('returns false for non-object input', () => {
    assert.equal(isAuthValid('string'), false);
    assert.equal(isAuthValid(123), false);
    assert.equal(isAuthValid(true), false);
  });
});
