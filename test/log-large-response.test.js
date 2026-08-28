'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { logLargeQuickScreenResponse } = require('../scripts/server/handlers/log-large-response');

describe('logLargeQuickScreenResponse', () => {
  it('warns when the serialized response exceeds the configured threshold', () => {
    const warnings = [];

    logLargeQuickScreenResponse(
      { payload: 'x'.repeat(12) },
      {
        thresholdBytes: 10,
        warn: (message) => warnings.push(message)
      }
    );

    assert.deepEqual(warnings, ['[PropProfessor MCP] Large quick_screen response: 0.0KB']);
  });

  it('does not warn at or below the configured threshold', () => {
    const warnings = [];
    const response = { payload: 'x' };
    const serializedLength = JSON.stringify(response).length;

    logLargeQuickScreenResponse(response, {
      thresholdBytes: serializedLength,
      warn: (message) => warnings.push(message)
    });

    assert.deepEqual(warnings, []);
  });

  it('swallows serialization errors', () => {
    const warnings = [];
    const response = {};
    response.self = response;

    assert.doesNotThrow(() =>
      logLargeQuickScreenResponse(response, {
        warn: (message) => warnings.push(message)
      })
    );
    assert.deepEqual(warnings, []);
  });
});
