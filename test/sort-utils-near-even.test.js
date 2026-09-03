'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sortRows } = require('../lib/propprofessor-sort-utils');

const baseOdds = (odds) => ({
  odds,
  gameId: 'game',
  selection: 'pick',
  confidenceTier: 'TIER 1',
  riskScore: 3,
  consensusBookCount: 7,
  edge: 2.0
});

describe('sortRows near-even-odds tie break', () => {
  it('same tier prefers the side whose absolute odds are closer to even money', () => {
    const nearEven = baseOdds(-125);
    const farEven = baseOdds(-310);
    const rows = [farEven, nearEven];
    const out = sortRows(rows, { sortBy: 'tier', sortDir: 'asc' });
    assert.equal(out[0], nearEven, 'closer-to-even should rise');
  });

  it('different tiers still beats near-even-odds', () => {
    const nearEven = { ...baseOdds(-125), confidenceTier: 'TIER 2' };
    const farEven = { ...baseOdds(-310), confidenceTier: 'TIER 1' };
    const rows = [nearEven, farEven];
    const out = sortRows(rows, { sortBy: 'tier', sortDir: 'asc' });
    assert.equal(out[0], farEven, 'TIER1 should still outrank TIER2');
  });

  it('handles +odds and missing odds gracefully', () => {
    const positive = baseOdds(115);
    const missing = baseOdds(null);
    delete missing.odds;
    const rows = [missing, positive];
    const out = sortRows(rows, { sortBy: 'tier', sortDir: 'asc' });
    assert.equal(out[0], positive, 'positive odds should outrank missing odds');
  });

  it('compares negative odds by distance from even money', () => {
    const nearEven = baseOdds(-110);
    const farther = baseOdds(130);
    const rows = [farther, nearEven];
    const out = sortRows(rows, { sortBy: 'tier', sortDir: 'asc' });
    assert.equal(out[0], nearEven, '-110 is closer to even than +130');
  });

  it('uses a non-negative distance for negative odds below -100', () => {
    const nearEven = baseOdds(-90);
    const farther = baseOdds(130);
    const rows = [farther, nearEven];
    const out = sortRows(rows, { sortBy: 'tier', sortDir: 'asc' });
    assert.equal(out[0], nearEven, '-90 is closer to even than +130');
  });
});
