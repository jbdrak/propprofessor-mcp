'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeClvFromHistory, deriveMovementFromClv, assignTierFromClv } = require('../lib/tennis-fallback');

describe('computeClvFromHistory', () => {
  it('returns null for empty array', () => {
    assert.equal(computeClvFromHistory([]), null);
  });

  it('returns null for single entry', () => {
    assert.equal(computeClvFromHistory([{ odds: 100, start_ts: 1 }]), null);
  });

  it('computes positive CLV when odds increase', () => {
    const history = [
      { odds: 100, start_ts: 1 },
      { odds: 110, start_ts: 2 }
    ];
    const clv = computeClvFromHistory(history);
    assert.ok(Math.abs(clv - 10) < 0.01, `expected ~10, got ${clv}`);
  });

  it('computes negative CLV when odds decrease', () => {
    const history = [
      { odds: 120, start_ts: 1 },
      { odds: 100, start_ts: 2 }
    ];
    const clv = computeClvFromHistory(history);
    assert.ok(Math.abs(clv - (-16.67)) < 0.1, `expected ~-16.67, got ${clv}`);
  });

  it('sorts by timestamp', () => {
    const history = [
      { odds: 110, start_ts: 2 },
      { odds: 100, start_ts: 1 }
    ];
    const clv = computeClvFromHistory(history);
    assert.ok(Math.abs(clv - 10) < 0.01, `expected ~10, got ${clv}`);
  });
});

describe('deriveMovementFromClv', () => {
  it('returns supportive_clean for CLV > 2', () => {
    assert.equal(deriveMovementFromClv(3), 'supportive_clean');
  });

  it('returns supportive_bouncy for CLV 0-2', () => {
    assert.equal(deriveMovementFromClv(1), 'supportive_bouncy');
  });

  it('returns adverse_full for CLV < -2', () => {
    assert.equal(deriveMovementFromClv(-3), 'adverse_full');
  });

  it('returns adverse_recent for CLV -2 to 0', () => {
    assert.equal(deriveMovementFromClv(-1), 'adverse_recent');
  });

  it('returns insufficient for null', () => {
    assert.equal(deriveMovementFromClv(null), 'insufficient');
  });

  it('returns insufficient for exactly 0', () => {
    assert.equal(deriveMovementFromClv(0), 'insufficient');
  });
});

describe('assignTierFromClv', () => {
  it('returns TIER 1 for high CLV', () => {
    assert.equal(assignTierFromClv(3, 1), 'TIER 1');
  });

  it('returns TIER 1 for medium CLV', () => {
    assert.equal(assignTierFromClv(2, 1), 'TIER 1');
  });

  it('returns TIER 2 for low CLV', () => {
    assert.equal(assignTierFromClv(0.5, 1), 'TIER 2');
  });

  it('returns TIER 2 for null CLV', () => {
    assert.equal(assignTierFromClv(null, 1), 'TIER 2');
  });
});
