'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mergeRecoveredRows } = require('../lib/propprofessor-ranked-screen-recovery-merge');

describe('mergeRecoveredRows', () => {
  it('hydrates recovery rows, deduplicates canonical IDs, and reports metadata', async () => {
    const hydratedRows = [{ gameId: 'game-1', market: 'Moneyline', selection: 'A' }];
    const recoveryRows = [
      { gameId: 'game-2', market: 'Moneyline', selection: 'B' },
      { gameId: 'game-3', market: 'Moneyline', selection: 'C' }
    ];
    const recoveredRows = [
      { gameId: 'game-1', market: 'Moneyline', selection: 'A' },
      { gameId: 'game-4', market: 'Moneyline', selection: 'D' }
    ];
    const hydrateCalls = [];

    const result = await mergeRecoveredRows({
      hydratedRows,
      recoveryRows,
      skipHistory: false,
      initialHasSupportive: false,
      hydrateOptions: { lookbackHours: 6 },
      args: { preHistoryRecoveryGameBudget: 2 },
      hydrateFn: async (rows, options) => {
        hydrateCalls.push({ rows, options });
        return recoveredRows;
      },
      buildIdFn: (row) => `${row.gameId}:${row.market}:${row.selection}`
    });

    assert.deepEqual(result.allHydratedRows, [...hydratedRows, recoveredRows[1]]);
    assert.deepEqual(result.preHistoryRecoveryMeta, {
      enabled: true,
      recoveredGameCount: 2,
      recoveredRowCount: 2,
      recoveryGameBudget: 2
    });
    assert.deepEqual(hydrateCalls, [{ rows: recoveryRows, options: { lookbackHours: 6 } }]);
  });

  it('skips recovery when history is disabled or initial ranking is supportive', async () => {
    const hydratedRows = [{ gameId: 'game-1' }];
    const hydrateFn = async () => {
      throw new Error('should not hydrate');
    };

    for (const options of [
      { skipHistory: true, initialHasSupportive: false },
      { skipHistory: false, initialHasSupportive: true }
    ]) {
      const result = await mergeRecoveredRows({
        hydratedRows,
        recoveryRows: [{ gameId: 'game-2' }],
        ...options,
        hydrateOptions: {},
        args: {},
        hydrateFn,
        buildIdFn: (row) => row.gameId
      });
      assert.deepEqual(result, { allHydratedRows: hydratedRows, preHistoryRecoveryMeta: null });
    }
  });
});
