'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { categorizeError, createCategorizedError } = require('../lib/ssb-mcp-stdio');
const { createMcpServer } = require('../scripts/ssb-mcp-server');

describe('structured error codes with recovery instructions', () => {
  it('401 error maps to AUTH_EXPIRED with recovery mentioning login command', () => {
    const result = categorizeError({ message: 'Unauthorized', status: 401 });
    assert.equal(result.code, 'AUTH_EXPIRED');
    assert.equal(result.category, 'auth');
    assert.ok(result.recovery.includes('PP_LOGIN_HEADLESS'));
  });

  it('503 error maps to BACKEND_DOWN with recovery mentioning try again', () => {
    const result = categorizeError({ message: 'Service Unavailable', status: 503 });
    assert.equal(result.code, 'BACKEND_DOWN');
    assert.equal(result.category, 'backend');
    assert.match(result.recovery.toLowerCase(), /try again/);
  });

  it('429 error maps to RATE_LIMITED with recovery mentioning Wait', () => {
    const result = categorizeError({ message: 'Too Many Requests', status: 429 });
    assert.equal(result.code, 'RATE_LIMITED');
    assert.equal(result.category, 'transport');
    assert.match(result.recovery, /Wait/);
  });

  it('error with auth keyword maps to AUTH_REQUIRED', () => {
    const result = categorizeError(new Error('Authentication failed'));
    assert.equal(result.code, 'AUTH_REQUIRED');
    assert.equal(result.category, 'auth');
    assert.ok(result.recovery.includes('PP_LOGIN_HEADLESS'));
  });

  it('unknown error maps to INTERNAL_ERROR with recovery mentioning github', () => {
    const result = categorizeError(new Error('something completely unexpected'));
    assert.equal(result.code, 'INTERNAL_ERROR');
    assert.equal(result.category, 'internal');
    assert.ok(result.recovery.includes('github.com'));
  });

  it('500 error maps to BACKEND_ERROR with recovery mentioning status', () => {
    const result = categorizeError({ message: 'Internal Server Error', status: 500 });
    assert.equal(result.code, 'BACKEND_ERROR');
    assert.equal(result.category, 'backend');
    assert.match(result.recovery.toLowerCase(), /status|try again/);
  });

  it('unauthorized keyword maps to AUTH_EXPIRED', () => {
    const result = categorizeError(new Error('User is Unauthorized'));
    assert.equal(result.code, 'AUTH_EXPIRED');
    assert.ok(result.recovery.includes('PP_LOGIN_HEADLESS'));
  });

  it('token keyword maps to AUTH_REQUIRED', () => {
    const result = categorizeError(new Error('bad token'));
    assert.equal(result.code, 'AUTH_REQUIRED');
    assert.ok(result.recovery.includes('PP_LOGIN_HEADLESS'));
  });

  it('service unavailable keyword maps to BACKEND_DOWN', () => {
    const result = categorizeError(new Error('Service Unavailable'));
    assert.equal(result.code, 'BACKEND_DOWN');
    assert.match(result.recovery.toLowerCase(), /try again/);
  });

  it('backend keyword maps to BACKEND_ERROR', () => {
    const result = categorizeError(new Error('backend failure'));
    assert.equal(result.code, 'BACKEND_ERROR');
    assert.match(result.recovery.toLowerCase(), /status|try again/);
  });

  it('createCategorizedError includes recovery field', () => {
    const err = createCategorizedError({
      message: 'test',
      code: 'TEST_CODE',
      category: 'test',
      recovery: 'Do something'
    });
    assert.equal(err.recovery, 'Do something');
  });

  it('createCategorizedError omits recovery when not provided', () => {
    const err = createCategorizedError({ message: 'test', code: 'X', category: 'y' });
    assert.equal(Object.prototype.hasOwnProperty.call(err, 'recovery'), false);
  });

  it('preserves custom recovery on already-categorized errors', () => {
    const err = createCategorizedError({
      message: 'custom',
      code: 'CUSTOM',
      category: 'auth',
      recovery: 'Custom recovery'
    });
    const result = categorizeError(err);
    assert.equal(result.recovery, 'Custom recovery');
  });

  it('MCP server includes recovery in structured error response', async () => {
    const server = createMcpServer({
      handlers: {
        fail_auth: async () => {
          const error = new Error('Unauthorized');
          error.status = 401;
          throw error;
        }
      },
      toolDefinitions: [
        {
          name: 'fail_auth',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }
      ]
    });

    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }
    });

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'fail_auth', arguments: {} }
    });

    assert.equal(response.result.isError, true);
    const errObj = response.result.structuredContent.error;
    assert.equal(errObj.code, 'AUTH_EXPIRED');
    assert.equal(errObj.category, 'auth');
    assert.equal(errObj.status, 401);
    assert.ok(errObj.recovery.includes('PP_LOGIN_HEADLESS'));
  });

  it('MCP server includes recovery for backend errors', async () => {
    const server = createMcpServer({
      handlers: {
        fail_backend: async () => {
          const error = new Error('Service Unavailable');
          error.status = 503;
          throw error;
        }
      },
      toolDefinitions: [
        {
          name: 'fail_backend',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }
      ]
    });

    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }
    });

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'fail_backend', arguments: {} }
    });

    const errObj = response.result.structuredContent.error;
    assert.equal(errObj.code, 'BACKEND_DOWN');
    assert.match(errObj.recovery.toLowerCase(), /try again/);
  });
});
