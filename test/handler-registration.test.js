'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mergeHandlerModule } = require('../scripts/server/handlers/handler-utils');

describe('handler module registration', () => {
  it('rejects an undocumented handler collision before overwriting', () => {
    const original = () => 'original';
    const replacement = () => 'replacement';
    const handlers = { example: original };
    const owners = new Map([['example', 'inline']]);

    assert.throws(
      () => mergeHandlerModule(handlers, owners, 'new-module', { example: replacement }),
      /Duplicate MCP handler "example" from new-module; already registered by inline/
    );
    assert.equal(handlers.example, original);
    assert.equal(owners.get('example'), 'inline');
  });

  it('allows only the documented state-to-context override', () => {
    const stateHandler = () => 'state';
    const contextHandler = () => 'context';
    const handlers = {};
    const owners = new Map();

    mergeHandlerModule(handlers, owners, 'state', { clear_score_timeline: stateHandler });
    mergeHandlerModule(handlers, owners, 'context-plugins', { clear_score_timeline: contextHandler });

    assert.equal(handlers.clear_score_timeline, contextHandler);
    assert.equal(owners.get('clear_score_timeline'), 'context-plugins');
  });
});
