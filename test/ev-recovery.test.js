'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  hasIncompleteScan,
  shouldRecoverFromEv,
  buildEvRecoveryRequest,
  extractEvRows,
  dedupeEvRows
} = require('../scripts/server/handlers/ev-recovery');

describe('bounded EV recovery helpers', () => {
  it('recovers when the screen path is truncated or empty', () => {
    assert.equal(hasIncompleteScan({ resultMeta: { scanHealth: { incomplete: true } } }), true);
    assert.equal(shouldRecoverFromEv({ resultMeta: { scanHealth: { incomplete: true } }, result: [] }), true);
    assert.equal(shouldRecoverFromEv({ result: [] }), true);
  });

  it('allows explicit opt-out and opt-in', () => {
    const complete = { result: [{ selection: 'A' }], resultMeta: { scanHealth: { incomplete: false } } };
    assert.equal(shouldRecoverFromEv(complete, { includeEv: false }), false);
    assert.equal(shouldRecoverFromEv(complete, { includeEv: true }), true);
  });

  it('builds a bounded pregame EV request without changing odds units', () => {
    assert.deepEqual(
      buildEvRecoveryRequest({ league: 'NCAAF', market: 'Point Spread', books: ['NoVigApp', 'Pinnacle'] }),
      {
        leagues: ['NCAAF'],
        sportsbooks: ['NoVigApp', 'Pinnacle'],
        marketTypes: ['Main Lines'],
        minOdds: -9999,
        maxOdds: 9999,
        minValue: 0,
        maxHoursAway: 48,
        isLive: false
      }
    );
  });

  it('extracts rows from the live /ev-prof envelope', () => {
    const rows = [{ gameId: 'g1' }];
    assert.deepEqual(extractEvRows({ rows, meta: { omitted: 0 } }), rows);
    assert.deepEqual(extractEvRows(rows), rows);
    assert.deepEqual(extractEvRows({}), []);
  });

  it('deduplicates book-level copies of the same exact market', () => {
    const rows = [
      { gameId: 'g1', market: 'Point Spread', selection: 'Team +3.5' },
      { gameId: 'g1', market: 'Point Spread', selection: 'Team +3.5' },
      { gameId: 'g1', market: 'Point Spread', selection: 'Team +4.5' }
    ];
    assert.equal(dedupeEvRows(rows).length, 2);
  });
});
