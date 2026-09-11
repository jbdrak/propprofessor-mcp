'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getBacktestSummary } = require('../lib/ssb-picks');

describe('getBacktestSummary', () => {
  it('returns ok + sampleSize + byTier shape', () => {
    const res = getBacktestSummary({ days: 30 });
    assert.equal(res.ok, true);
    assert.equal(typeof res.sampleSize, 'number');
    assert.equal(typeof res.settled, 'number');
    assert.ok(res.byTier, 'byTier should be present');
    assert.equal(typeof res.note, 'string', 'note explains sample status');
  });

  it('notes when there are no settled picks (honest, not fabricated ROI)', () => {
    // With a day window that excludes any picks, total should be 0.
    const res = getBacktestSummary({ days: 0 });
    assert.equal(res.ok, true);
    if (res.sampleSize === 0) {
      assert.match(res.note, /No settled picks/i, 'must not imply ROI from empty sample');
    }
  });
});
