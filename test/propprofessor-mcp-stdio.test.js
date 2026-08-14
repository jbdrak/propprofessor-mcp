'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createCategorizedError,
  categorizeError,
  createJsonRpcSuccess,
  createJsonRpcError,
  encodeMessage,
  createStdioMessageReader
} = require('../lib/propprofessor-mcp-stdio');

describe('createCategorizedError', () => {
  it('creates an error with default code and category', () => {
    const err = createCategorizedError({ message: 'test' });
    assert.ok(err instanceof Error);
    assert.equal(err.message, 'test');
    assert.equal(err.code, 'INTERNAL_ERROR');
    assert.equal(err.category, 'internal');
    assert.equal(err.status, undefined);
    assert.equal(err.cause, undefined);
  });

  it('creates an error with custom code, category, status, and cause', () => {
    const cause = new Error('root');
    const err = createCategorizedError({
      message: 'boom',
      code: 'AUTH_REQUIRED',
      category: 'auth',
      status: 401,
      cause
    });
    assert.equal(err.message, 'boom');
    assert.equal(err.code, 'AUTH_REQUIRED');
    assert.equal(err.category, 'auth');
    assert.equal(err.status, 401);
    assert.equal(err.cause, cause);
  });

  it('uses default message when none provided', () => {
    const err = createCategorizedError();
    assert.equal(err.message, 'Unexpected PropProfessor MCP error');
  });

  it('does not set status or cause when undefined', () => {
    const err = createCategorizedError({ message: 'x', status: undefined, cause: undefined });
    assert.equal(Object.prototype.hasOwnProperty.call(err, 'status'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(err, 'cause'), false);
  });
});

describe('categorizeError', () => {
  it('returns an already-categorized error unchanged', () => {
    const categorized = createCategorizedError({ message: 'done', code: 'X', category: 'auth' });
    const result = categorizeError(categorized);
    assert.equal(result, categorized);
  });

  it('categorizes auth errors via status 401', () => {
    const result = categorizeError({ message: 'nope', status: 401 });
    assert.equal(result.category, 'auth');
    assert.equal(result.code, 'AUTH_EXPIRED');
    assert.equal(result.status, 401);
    assert.ok(result.recovery.includes('PP_LOGIN_HEADLESS'));
  });

  it('categorizes auth errors via "auth" keyword', () => {
    const result = categorizeError(new Error('Authentication failed'));
    assert.equal(result.category, 'auth');
  });

  it('categorizes auth errors via "unauthorized" keyword', () => {
    const result = categorizeError(new Error('User is Unauthorized'));
    assert.equal(result.category, 'auth');
  });

  it('categorizes auth errors via "token" keyword', () => {
    const result = categorizeError(new Error('bad token'));
    assert.equal(result.category, 'auth');
  });

  it('categorizes transport errors via status 429', () => {
    const result = categorizeError({ message: 'slow down', status: 429 });
    assert.equal(result.category, 'transport');
    assert.equal(result.code, 'RATE_LIMITED');
    assert.ok(result.recovery.includes('Wait'));
  });

  it('categorizes transport errors via "content-length" keyword', () => {
    const result = categorizeError(new Error('Content-Length mismatch'));
    assert.equal(result.category, 'transport');
  });

  it('categorizes transport errors via "ndjson" keyword', () => {
    const result = categorizeError(new Error('ndjson parse failure'));
    assert.equal(result.category, 'transport');
  });

  it('categorizes transport errors via "transport" keyword', () => {
    const result = categorizeError(new Error('transport layer broke'));
    assert.equal(result.category, 'transport');
  });

  it('categorizes transport errors via "frame" keyword', () => {
    const result = categorizeError(new Error('bad frame'));
    assert.equal(result.category, 'transport');
  });

  it('categorizes backend errors via status 500', () => {
    const result = categorizeError({ message: 'oops', status: 500 });
    assert.equal(result.category, 'backend');
    assert.equal(result.code, 'BACKEND_ERROR');
  });

  it('categorizes backend errors via status 503', () => {
    const result = categorizeError({ message: 'unavailable', status: 503 });
    assert.equal(result.category, 'backend');
  });

  it('categorizes backend errors via "backend" keyword', () => {
    const result = categorizeError(new Error('backend failure'));
    assert.equal(result.category, 'backend');
  });

  it('categorizes backend errors via "service unavailable" keyword', () => {
    const result = categorizeError(new Error('Service Unavailable'));
    assert.equal(result.category, 'backend');
  });

  it('categorizes validation errors via "required" keyword', () => {
    const result = categorizeError(new Error('field is required'));
    assert.equal(result.category, 'validation');
    assert.equal(result.code, 'VALIDATION_ERROR');
  });

  it('categorizes validation errors via "invalid" keyword', () => {
    const result = categorizeError(new Error('invalid input'));
    assert.equal(result.category, 'validation');
  });

  it('categorizes validation errors via "unknown tool" keyword', () => {
    const result = categorizeError(new Error('Unknown tool: foo'));
    assert.equal(result.category, 'validation');
  });

  it('falls through to internal category', () => {
    const result = categorizeError(new Error('something odd'));
    assert.equal(result.category, 'internal');
    assert.equal(result.code, 'INTERNAL_ERROR');
  });

  it('preserves original error code when present', () => {
    const result = categorizeError({ message: 'boom', code: 'CUSTOM_CODE', status: 401 });
    assert.equal(result.code, 'CUSTOM_CODE');
  });

  it('handles string input', () => {
    const result = categorizeError('plain string');
    assert.equal(result.category, 'internal');
  });
});

describe('createJsonRpcSuccess', () => {
  it('returns a valid jsonrpc 2.0 success response', () => {
    const msg = createJsonRpcSuccess(1, { foo: 'bar' });
    assert.deepEqual(msg, { jsonrpc: '2.0', id: 1, result: { foo: 'bar' } });
  });

  it('uses null id when not provided', () => {
    const msg = createJsonRpcSuccess(null, {});
    assert.equal(msg.id, null);
  });
});

describe('createJsonRpcError', () => {
  it('returns a valid jsonrpc 2.0 error response', () => {
    const msg = createJsonRpcError(2, -32600, 'Invalid Request');
    assert.deepEqual(msg, {
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32600, message: 'Invalid Request' }
    });
  });
});

describe('encodeMessage', () => {
  it('returns Content-Length framed message by default', () => {
    const payload = { jsonrpc: '2.0', id: 1 };
    const encoded = encodeMessage(payload);
    const body = JSON.stringify(payload);
    assert.equal(encoded, `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  });

  it('returns NDJSON when newlineJson is true', () => {
    const payload = { jsonrpc: '2.0', id: 1 };
    const encoded = encodeMessage(payload, { newlineJson: true });
    assert.equal(encoded, `${JSON.stringify(payload)}\n`);
  });

  it('handles multi-byte characters in Content-Length', () => {
    const payload = { text: 'café' };
    const encoded = encodeMessage(payload);
    const body = JSON.stringify(payload);
    const expectedLength = Buffer.byteLength(body, 'utf8');
    assert.match(encoded, /^Content-Length: \d+\r\n\r\n/);
    const declared = Number(encoded.match(/Content-Length: (\d+)/)[1]);
    assert.equal(declared, expectedLength);
  });
});

describe('createStdioMessageReader', () => {
  it('parses Content-Length framed messages', () => {
    const messages = [];
    const reader = createStdioMessageReader((msg) => messages.push(msg), { allowNewlineJson: false });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' });
    const frame = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
    reader(Buffer.from(frame));
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], { jsonrpc: '2.0', id: 1, result: 'ok' });
  });

  it('handles NDJSON when allowed', () => {
    const messages = [];
    const reader = createStdioMessageReader((msg) => messages.push(msg), { allowNewlineJson: true });
    reader(Buffer.from('{"a":1}\n{"b":2}\n'));
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], { a: 1 });
    assert.deepEqual(messages[1], { b: 2 });
  });

  it('skips malformed JSON gracefully without throwing', () => {
    const messages = [];
    const reader = createStdioMessageReader((msg) => messages.push(msg), { allowNewlineJson: true });
    assert.doesNotThrow(() => {
      reader(Buffer.from('not-json\n{"ok":true}\n'));
    });
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], { ok: true });
  });

  it('skips frames with missing Content-Length header', () => {
    const messages = [];
    const reader = createStdioMessageReader((msg) => messages.push(msg), { allowNewlineJson: false });
    const body = JSON.stringify({ a: 1 });
    const frame = `X-Custom: foo\r\n\r\n${body}`;
    assert.doesNotThrow(() => {
      reader(Buffer.from(frame));
    });
    assert.equal(messages.length, 0);
  });

  it('skips frames with invalid Content-Length', () => {
    const messages = [];
    const reader = createStdioMessageReader((msg) => messages.push(msg), { allowNewlineJson: false });
    const body = JSON.stringify({ a: 1 });
    const frame = `Content-Length: abc\r\n\r\n${body}`;
    assert.doesNotThrow(() => {
      reader(Buffer.from(frame));
    });
    assert.equal(messages.length, 0);
  });

  it('skips frames with zero Content-Length', () => {
    const messages = [];
    const reader = createStdioMessageReader((msg) => messages.push(msg), { allowNewlineJson: false });
    const frame = 'Content-Length: 0\r\n\r\n';
    assert.doesNotThrow(() => {
      reader(Buffer.from(frame));
    });
    assert.equal(messages.length, 0);
  });

  it('skips malformed JSON body in framed message', () => {
    const messages = [];
    const reader = createStdioMessageReader((msg) => messages.push(msg), { allowNewlineJson: false });
    const badBody = 'not-json';
    const frame = `Content-Length: ${Buffer.byteLength(badBody, 'utf8')}\r\n\r\n${badBody}`;
    assert.doesNotThrow(() => {
      reader(Buffer.from(frame));
    });
    assert.equal(messages.length, 0);
  });

  it('handles partial frames by buffering', () => {
    const messages = [];
    const reader = createStdioMessageReader((msg) => messages.push(msg), { allowNewlineJson: false });
    const body = JSON.stringify({ hello: 'world' });
    const frame = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
    const half = Math.floor(frame.length / 2);
    reader(Buffer.from(frame.slice(0, half)));
    assert.equal(messages.length, 0);
    reader(Buffer.from(frame.slice(half)));
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], { hello: 'world' });
  });

  it('parses multiple framed messages from a single chunk', () => {
    const messages = [];
    const reader = createStdioMessageReader((msg) => messages.push(msg), { allowNewlineJson: false });
    const body1 = JSON.stringify({ n: 1 });
    const body2 = JSON.stringify({ n: 2 });
    const frame1 = `Content-Length: ${Buffer.byteLength(body1, 'utf8')}\r\n\r\n${body1}`;
    const frame2 = `Content-Length: ${Buffer.byteLength(body2, 'utf8')}\r\n\r\n${body2}`;
    reader(Buffer.from(frame1 + frame2));
    assert.equal(messages.length, 2);
    assert.equal(messages[0].n, 1);
    assert.equal(messages[1].n, 2);
  });
});

describe('portable public recovery paths', () => {
  const fs = require('fs');
  const path = require('path');

  it('AUTH_EXPIRED recovery contains no author-machine absolute path', () => {
    const result = categorizeError({ message: 'nope', status: 401 });
    assert.equal(result.code, 'AUTH_EXPIRED');
    assert.ok(!result.recovery.includes('/Users/'), 'recovery must not contain an absolute /Users path');
    assert.ok(!result.recovery.includes('/Users/jamesdrake'));
    assert.ok(result.recovery.includes('scripts/pp-login.js'), 'recovery must point at package-relative pp-login.js');
  });

  it('AUTH_REQUIRED recovery contains no author-machine absolute path', () => {
    const result = categorizeError(new Error('Authentication required'));
    assert.equal(result.code, 'AUTH_REQUIRED');
    assert.ok(!result.recovery.includes('/Users/'), 'recovery must not contain an absolute /Users path');
    assert.ok(!result.recovery.includes('/Users/jamesdrake'));
    assert.ok(result.recovery.includes('scripts/pp-login.js'), 'recovery must point at package-relative pp-login.js');
  });

  it('TOKEN_REFRESH_FAILED_BOTH_PATHS recovery is portable, not a private ~/.hermes script', () => {
    const result = categorizeError({
      code: 'TOKEN_REFRESH_FAILED_BOTH_PATHS',
      message: 'token refresh failed both paths: http 401'
    });
    assert.equal(result.code, 'AUTH_EXPIRED');
    assert.ok(!result.recovery.includes('~/.hermes'), 'recovery must not reference private ~/.hermes scripts');
    assert.ok(!result.recovery.includes('pp-fresh-auth'));
    assert.ok(!result.recovery.includes('/Users/'), 'recovery must not contain an absolute /Users path');
    assert.ok(result.recovery.includes('scripts/pp-login.js'), 'recovery must point at package-relative pp-login.js');
  });

  it('recovery source contains no author-machine paths', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'propprofessor-mcp-stdio.js'), 'utf8');
    assert.ok(!src.includes('/Users/jamesdrake'), 'source must not hardcode /Users/jamesdrake');
    assert.ok(!src.includes('pp-fresh-auth'), 'source must not reference private ~/.hermes scripts');
  });
});
