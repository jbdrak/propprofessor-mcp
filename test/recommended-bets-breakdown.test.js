'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeMarketsBreakdown } = require('../scripts/server/handlers/recommended-bets-breakdown');

describe('computeMarketsBreakdown', () => {
  it('counts markets across league entries and uses unknown for missing markets', () => {
    const result = computeMarketsBreakdown([
      { plays: [{ market: 'Moneyline' }, { market: 'Moneyline' }, { market: 'Total' }] },
      { plays: [{ market: 'Total' }, { selection: 'Team A' }] },
      { plays: [] }
    ]);

    assert.deepEqual(result, { Moneyline: 2, Total: 2, unknown: 1 });
  });

  it('returns an empty object when entries have no plays', () => {
    assert.deepEqual(computeMarketsBreakdown([{ count: 0 }, null, {}]), {});
  });
});
