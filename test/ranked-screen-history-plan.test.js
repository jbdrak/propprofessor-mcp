'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planPreHistoryHydration } = require('../lib/propprofessor-ranked-screen-history-plan');

describe('planPreHistoryHydration', () => {
  it('keeps the full row set when shortlist mode is unavailable or unnecessary', () => {
    const rows = [{ gameId: 'one' }, { gameId: 'two' }];

    const result = planPreHistoryHydration({
      rows,
      args: { preHistoryShortlist: true },
      targetBook: '',
      canHydrate: false,
      hasExplicitGameFilter: false,
      buildPreHistoryShortlist: () => {
        throw new Error('shortlist should not run');
      },
      getGameBudget: () => 2
    });

    assert.deepEqual(result, {
      hydrationRows: rows,
      recoveryRows: [],
      preHistoryShortlistMeta: null
    });
  });

  it('plans bounded hydration and optional recovery from skipped rows', () => {
    const rows = [{ gameId: 'one' }, { gameId: 'two' }, { gameId: 'three' }];
    const shortlistRows = [rows[0]];
    const skippedRows = [rows[1], rows[2]];
    const calls = [];

    const result = planPreHistoryHydration({
      rows,
      args: {
        preHistoryShortlist: true,
        preHistoryRowBudget: 1,
        preHistoryRecoveryGameBudget: 1,
        preHistoryRecoveryRowBudget: 2
      },
      targetBook: 'Pinnacle',
      canHydrate: true,
      hasExplicitGameFilter: false,
      buildPreHistoryShortlist: (inputRows, options) => {
        calls.push({ inputRows, options });
        return calls.length === 1
          ? { rows: shortlistRows, skippedRows, gameBudget: 2, bucketCount: 1 }
          : { rows: [rows[1]], skippedRows: [rows[2]], gameBudget: 1, bucketCount: 1 };
      },
      getGameBudget: () => 2
    });

    assert.deepEqual(result, {
      hydrationRows: shortlistRows,
      recoveryRows: [rows[1]],
      preHistoryShortlistMeta: {
        enabled: true,
        truncated: true,
        totalRows: 3,
        shortlistedRows: 1,
        skippedRowCount: 2,
        gameBudget: 2,
        marketBucketCount: 1
      }
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].options, {
      gameBudget: 2,
      rowBudget: 1,
      preferredBook: 'Pinnacle'
    });
    assert.deepEqual(calls[1].options, {
      gameBudget: 1,
      rowBudget: 2,
      preferredBook: 'Pinnacle'
    });
  });
});
