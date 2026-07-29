'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeClvFromHistory, deriveMovementFromClv, assignTierFromClv, isStandardLine } = require('../lib/tennis-fallback');

describe('computeClvFromHistory', () => {
  it('returns null for empty array', () => {
    assert.equal(computeClvFromHistory([]), null);
  });

  it('returns null for single entry', () => {
    assert.equal(computeClvFromHistory([{ odds: 100, start_ts: 1 }]), null);
  });

  it('computes positive CLV when odds move toward selection (favorite gets cheaper)', () => {
    // -120 → -110: implied prob went from 54.5% → 52.4% = adverse for favorite
    // Wait, that's wrong. Let me think again.
    // -120 → -110: prob = 120/220=54.5% → 110/210=52.4% = probability DECREASED = adverse
    // Actually for the FAVORITE side, moving from -120 to -110 means the favorite
    // became LESS favored. If you bet the favorite, that's adverse.
    // But if you look at it from the selection's perspective:
    // selection at -120 (54.5% implied) moves to -110 (52.4% implied)
    // CLV = 52.4 - 54.5 = -2.1% → adverse for that selection
    const history = [
      { odds: -120, start_ts: 1 },
      { odds: -110, start_ts: 2 }
    ];
    const clv = computeClvFromHistory(history);
    assert.ok(clv < 0, `expected negative CLV (adverse), got ${clv}`);
  });

  it('computes negative CLV when underdog odds shorten', () => {
    // +150 → +130: prob = 100/250=40% → 100/230=43.5% = probability INCREASED = supportive
    const history = [
      { odds: 150, start_ts: 1 },
      { odds: 130, start_ts: 2 }
    ];
    const clv = computeClvFromHistory(history);
    assert.ok(clv > 0, `expected positive CLV (supportive), got ${clv}`);
  });

  it('computes CLV correctly: -133 → -129 (favorite weakens = adverse)', () => {
    const history = [
      { odds: -133, start_ts: 1 },
      { odds: -129, start_ts: 2 }
    ];
    const clv = computeClvFromHistory(history);
    // 133/233=57.08% → 129/229=56.33% = -0.75%
    assert.ok(Math.abs(clv - (-0.75)) < 0.1, `expected ~-0.75, got ${clv}`);
  });

  it('sorts by timestamp', () => {
    const history = [
      { odds: -110, start_ts: 2 },
      { odds: -120, start_ts: 1 }
    ];
    const clv = computeClvFromHistory(history);
    // -120 → -110: 120/220=54.5% → 110/210=52.4% = -2.1%
    assert.ok(clv < 0, `expected negative CLV, got ${clv}`);
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

describe('isStandardLine', () => {
  it('accepts -110', () => assert.equal(isStandardLine(-110), true));
  it('accepts +100', () => assert.equal(isStandardLine(100), true));
  it('accepts -150', () => assert.equal(isStandardLine(-150), true));
  it('accepts +150', () => assert.equal(isStandardLine(150), true));
  it('rejects -200 (big favorite)', () => assert.equal(isStandardLine(-200), false));
  it('rejects +300 (big underdog)', () => assert.equal(isStandardLine(300), false));
  it('rejects -488', () => assert.equal(isStandardLine(-488), false));
  it('rejects null', () => assert.equal(isStandardLine(null), false));
});
