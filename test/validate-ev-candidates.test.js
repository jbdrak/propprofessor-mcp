'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const VEC_MODULE = path.resolve(__dirname, '../lib/validate-ev-candidates');

describe('validate-ev-candidates — createOddsHistoryMemoizedQuery', () => {
  it('trims and filters sportsbooks before calling the client', async () => {
    const calls = [];
    const client = {
      queryOddsHistory: async (params) => {
        calls.push(params);
        return { history: [] };
      }
    };
    delete require.cache[VEC_MODULE];
    const { createOddsHistoryMemoizedQuery } = require(VEC_MODULE);
    const q = createOddsHistoryMemoizedQuery(client);
    await q({ gameId: 'g1', selectionId: 's1', sportsbooks: [' Pinnacle ', null, 'DK', ''] });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].sportsbooks, ['Pinnacle', 'DK']);
  });

  it('handles missing sportsbooks array', async () => {
    const calls = [];
    const client = {
      queryOddsHistory: async (params) => {
        calls.push(params);
        return { history: [] };
      }
    };
    delete require.cache[VEC_MODULE];
    const { createOddsHistoryMemoizedQuery } = require(VEC_MODULE);
    const q = createOddsHistoryMemoizedQuery(client);
    await q({ gameId: 'g1', selectionId: 's1' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].sportsbooks, []);
  });

  it('memoizes identical calls (cross-call cache)', async () => {
    const calls = [];
    const client = {
      queryOddsHistory: async (params) => {
        calls.push(params);
        return { history: [] };
      }
    };
    delete require.cache[VEC_MODULE];
    const { createOddsHistoryMemoizedQuery } = require(VEC_MODULE);
    const q = createOddsHistoryMemoizedQuery(client);
    const params = { gameId: 'g1', selectionId: 's1', sportsbooks: ['DK'] };
    await q(params);
    await q(params);
    assert.equal(calls.length, 1, 'second identical call served from cache');
  });
});

describe('validatePositiveEvCandidates — success-path enrichment', () => {
  it('returns ok with ranked rows and resultMeta when history resolves', async () => {
    delete require.cache[VEC_MODULE];
    const { validatePositiveEvCandidates } = require(VEC_MODULE);
    const out = await validatePositiveEvCandidates({
      client: { queryOddsHistory: async () => ({}) },
      candidates: [
        {
          league: 'NBA',
          market: 'Moneyline',
          book: 'DK',
          participant: 'LeBron',
          selection: 'LeBron',
          game: 'LAL vs BOS',
          odds: -110
        }
      ],
      args: { league: 'NBA', market: 'Moneyline', books: ['DK'], limit: 10, debug: false }
    });
    assert.equal(out.ok, true);
    assert.ok(out.count >= 1);
    assert.equal(out.resultMeta.validatedCount, 1);
    assert.equal(out.resultMeta.failedValidationCount, 0);
    assert.equal(out.resultMeta.candidateCount, 1);
  });

  it('filters out non-object candidates before validation', async () => {
    delete require.cache[VEC_MODULE];
    const { validatePositiveEvCandidates } = require(VEC_MODULE);
    const out = await validatePositiveEvCandidates({
      client: { queryOddsHistory: async () => ({}) },
      candidates: [
        null,
        'garbage',
        { league: 'NBA', market: 'Moneyline', book: 'DK', participant: 'X', selection: 'X' }
      ],
      args: { league: 'NBA', market: 'Moneyline', books: ['DK'], limit: 10 }
    });
    // Only the one valid object should reach validation.
    assert.equal(out.resultMeta.candidateCount, 1);
    assert.equal(out.resultMeta.validatedCount, 1);
  });
});
