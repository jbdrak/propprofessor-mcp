'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createScanHandlers } = require('../scripts/server/handlers/scan');

describe('scan handler', () => {
  it('maps sport and forwards includeProps to quick_screen', async () => {
    const calls = [];
    const ctx = {
      handlers: {
        quick_screen: async (args) => {
          calls.push(args);
          return { ok: true };
        }
      }
    };
    const handlers = createScanHandlers({}, ctx);

    const result = await handlers.scan({ sport: 'mlb', includeProps: true });

    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].league, 'MLB');
    assert.equal(calls[0].includeProps, true);
    assert.equal(calls[0].book, 'NoVigApp');
    assert.equal(calls[0].verbosity, 'bets');
  });
});
