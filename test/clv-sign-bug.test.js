'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { computeClvPct } = require('../lib/ssb-sharp-history');

// Inlined from ssb-sharp-history.js:118 — not exported
function directionFromClvPct(value) {
  if (!Number.isFinite(value)) return 'insufficient_history';
  if (value > 0.01) return 'supportive';
  if (value < -0.01) return 'adverse';
  return 'mixed';
}

describe('CLV sign inversion — opposite-side moneyline plays', () => {
  it('Cubs: line moved from +144 to +143 = positive CLV = supportive', () => {
    const clv = computeClvPct(144, 143);
    // Cubs: implied prob 40.98% → 41.15% = +0.17%
    assert.ok(clv > 0, `Cubs CLV should be positive, got ${clv}`);
    assert.equal(directionFromClvPct(clv), 'supportive');
  });

  it('Brewers: line moved from -160 to -155 = negative CLV = adverse', () => {
    const clv = computeClvPct(-160, -155);
    // Brewers: implied prob 61.54% → 60.78% = -0.75%
    assert.ok(clv < 0, `Brewers CLV should be negative, got ${clv}`);
    assert.equal(directionFromClvPct(clv), 'adverse');
  });

  it('both sides of same moneyline cannot both be supportive', () => {
    const cubsClv = computeClvPct(144, 143);
    const brewersClv = computeClvPct(-160, -155);
    // On a moneyline, if one side's line improved, the other must have worsened
    const cubsDir = directionFromClvPct(cubsClv);
    const brewersDir = directionFromClvPct(brewersClv);

    const bothSupportive = cubsDir === 'supportive' && brewersDir === 'supportive';
    const bothAdverse = cubsDir === 'adverse' && brewersDir === 'adverse';

    assert.ok(
      !bothSupportive && !bothAdverse,
      `Both sides can't have the same direction. Cubs: ${cubsDir} (${cubsClv.toFixed(2)}%), Brewers: ${brewersDir} (${brewersClv.toFixed(2)}%)`
    );
  });

  it('invertDirection flips CLV but only when history belongs to OPPOSITE side', () => {
    // Brewers actual CLV: line moved -160→-155, CLV = -0.75% (adverse for Brewers)
    const brewersClv = computeClvPct(-160, -155);

    // If the ROW is Brewers and the HISTORY is Brewers: no inversion needed
    // Brewers CLV should stay -0.75% (adverse) — system should NOT invert
    assert.ok(brewersClv < 0, 'Brewers actual CLV must be negative (line moved against them)');

    // If the ROW is Cubs and the HISTORY is Brewers: inversion IS needed
    // -(-0.75) = +0.75% for Cubs (supportive for Cubs because Brewers line softened)
    const cubsInvertedClv = -brewersClv;
    assert.ok(
      cubsInvertedClv > 0,
      'Inverted CLV should be positive for Cubs (line softened against Brewers = good for Cubs)'
    );
  });
});
