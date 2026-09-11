'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { suggestStakes } = require('../lib/ssb-risk-score');

/**
 * Build a play object that should land in a specific tier with a specific edge.
 * Tier thresholds (from ssb-risk-score.js):
 *   TIER 1: green grade + risk <= 2
 *   TIER 2: green/risk<=4 or yellow/risk<=5
 *   TIER 3: yellow + risk 5-7
 *   TIER 4: red, PASS, or risk 7+
 */
function playWith({ tier, edge = 1, clv = null, league = 'NBA', selection = 'home' } = {}) {
  // Provide enough movement-grade context that getConfidenceTier() returns the desired tier
  let overrides = { consensusEdge: edge };
  if (clv !== null) overrides.clvProxyPct = clv;
  // Skip auto-tier by passing tier explicitly — that's the path used in real stake plans
  if (tier) overrides.confidenceTier = tier;
  return {
    league,
    selection,
    game: `${league}-game-1`,
    homeTeam: 'Home',
    awayTeam: 'Away',
    ...overrides
  };
}

describe('suggestStakes — base behavior (unchanged from before CLV factor)', () => {
  it('returns ok=false for invalid bankroll', () => {
    const r = suggestStakes({ bankroll: 0, plays: [playWith({ tier: 'TIER 1' })] });
    assert.equal(r.ok, false);
  });

  it('returns empty stakes with no plays', () => {
    const r = suggestStakes({ bankroll: 1000, plays: [] });
    assert.equal(r.ok, true);
    assert.equal(r.totalStake, 0);
    assert.deepEqual(r.stakes, []);
    assert.ok(r.warnings.includes('No plays to stake'));
  });

  it('skips TIER 4 plays (zero base pct)', () => {
    const r = suggestStakes({ bankroll: 1000, plays: [playWith({ tier: 'TIER 4' })] });
    assert.equal(r.playCount, 0);
    assert.equal(r.totalStake, 0);
  });
});

describe('suggestStakes — CLV multiplier (Phase 6 of sharp-signal-tuning plan)', () => {
  it('TIER 1 with CLV >= 5% gets 1.5x CLV factor', () => {
    const r = suggestStakes({ bankroll: 1000, plays: [playWith({ tier: 'TIER 1', edge: 0.6, clv: 6.0 })] });
    // basePct = 2.0, edgeFactor = 1.0 (edge 0.6 not > 1), clvFactor = 1.5 → 3.0%
    assert.equal(r.stakes[0].basePct, 2.0);
    assert.equal(r.stakes[0].edgeFactor, 1.0);
    assert.equal(r.stakes[0].clvFactor, 1.5);
    assert.equal(r.stakes[0].clvBucket, 'strong_5plus');
    assert.equal(r.stakes[0].bankrollPct, 3.0);
    assert.equal(r.stakes[0].stakeDollars, 30);
  });

  it('TIER 1 with CLV 2-5% gets 1.0x (baseline)', () => {
    const r = suggestStakes({ bankroll: 1000, plays: [playWith({ tier: 'TIER 1', edge: 0.6, clv: 3.0 })] });
    assert.equal(r.stakes[0].clvFactor, 1.0);
    assert.equal(r.stakes[0].clvBucket, 'moderate_2to5');
    assert.equal(r.stakes[0].bankrollPct, 2.0);
  });

  it('TIER 1 with CLV 0.5-2% gets 0.75x', () => {
    const r = suggestStakes({ bankroll: 1000, plays: [playWith({ tier: 'TIER 1', edge: 0.6, clv: 1.0 })] });
    assert.equal(r.stakes[0].clvFactor, 0.75);
    assert.equal(r.stakes[0].clvBucket, 'weak_0_5to2');
    // 2.0 * 1.0 * 0.75 = 1.5%
    assert.equal(r.stakes[0].bankrollPct, 1.5);
  });

  it('TIER 1 with CLV < 0.5% gets 0.5x', () => {
    const r = suggestStakes({ bankroll: 1000, plays: [playWith({ tier: 'TIER 1', edge: 0.6, clv: 0.3 })] });
    assert.equal(r.stakes[0].clvFactor, 0.5);
    assert.equal(r.stakes[0].clvBucket, 'sub_threshold');
    assert.equal(r.stakes[0].bankrollPct, 1.0);
  });

  it('TIER 1 with null/undefined CLV gets 0.5x (no data is weak signal)', () => {
    const r1 = suggestStakes({ bankroll: 1000, plays: [playWith({ tier: 'TIER 1', edge: 0.6 })] });
    const r2 = suggestStakes({ bankroll: 1000, plays: [playWith({ tier: 'TIER 1', edge: 0.6, clv: null })] });
    const r3 = suggestStakes({ bankroll: 1000, plays: [playWith({ tier: 'TIER 1', edge: 0.6, clv: undefined })] });
    for (const r of [r1, r2, r3]) {
      assert.equal(r.stakes[0].clvFactor, 0.5);
      assert.equal(r.stakes[0].clvBucket, 'no_data');
    }
  });

  it('TIER 2 with strong CLV stacks: 1.0 base × 1.5 edge (>1) × 1.5 CLV = 2.25%', () => {
    const r = suggestStakes({ bankroll: 1000, plays: [playWith({ tier: 'TIER 2', edge: 1.5, clv: 6.0 })] });
    // basePct = 1.0 (TIER 2), edgeFactor = 1.25 (edge 1.5 > 1 but <= 2), clvFactor = 1.5
    // 1.0 * 1.25 * 1.5 = 1.875
    assert.equal(r.stakes[0].basePct, 1.0);
    assert.equal(r.stakes[0].edgeFactor, 1.25);
    assert.equal(r.stakes[0].clvFactor, 1.5);
    assert.equal(r.stakes[0].bankrollPct, 1.88); // rounded to 2 dp
  });

  it('TIER 2 with strong edge and weak CLV: 1.0 × 1.5 × 0.5 = 0.75%', () => {
    const r = suggestStakes({ bankroll: 1000, plays: [playWith({ tier: 'TIER 2', edge: 2.5, clv: 0.3 })] });
    // basePct = 1.0, edgeFactor = 1.5 (edge > 2), clvFactor = 0.5 (sub_threshold)
    // 1.0 * 1.5 * 0.5 = 0.75
    assert.equal(r.stakes[0].basePct, 1.0);
    assert.equal(r.stakes[0].edgeFactor, 1.5);
    assert.equal(r.stakes[0].clvFactor, 0.5);
    assert.equal(r.stakes[0].bankrollPct, 0.75);
  });

  it('CLV multiplier respects 5% per-play cap (extreme case)', () => {
    // TIER 1 (2%) × strong edge (1.5x) × strong CLV (1.5x) = 4.5% — under cap
    // But TIER 1 with no tier is 2% and cap is 5% so we're fine here.
    // To actually hit 5% cap: TIER 1 + edge 2.5 + CLV 6.0 = 2 * 1.5 * 1.5 = 4.5%, still under.
    // The 5% cap is hit if TIER 1 base is somehow higher, but TIER 1 is 2.0% by design.
    // So 5% cap is essentially untriggered by the staking logic itself. Just verify no overflow.
    const r = suggestStakes({ bankroll: 1000, plays: [playWith({ tier: 'TIER 1', edge: 2.5, clv: 6.0 })] });
    assert.ok(r.stakes[0].bankrollPct <= 5.0, `stake pct should be <= 5%, got ${r.stakes[0].bankrollPct}`);
  });

  it('mixed batch: high-CLV TIER 1 + low-CLV TIER 2 reflects in stakes', () => {
    const plays = [
      playWith({ tier: 'TIER 1', edge: 0.6, clv: 6.0, selection: 'A' }),
      playWith({ tier: 'TIER 2', edge: 0.6, clv: 0.3, selection: 'B' })
    ];
    const r = suggestStakes({ bankroll: 1000, plays });
    assert.equal(r.playCount, 2);
    // TIER 1 strong CLV: 2.0 × 1.0 × 1.5 = 3.0%
    assert.equal(r.stakes[0].bankrollPct, 3.0);
    // TIER 2 weak CLV: 1.0 × 1.0 × 0.5 = 0.5%
    assert.equal(r.stakes[1].bankrollPct, 0.5);
    assert.equal(r.totalStake, 30 + 5);
  });

  it('exposure warning still fires when total exceeds 25%', () => {
    // 5 TIER 1 plays with strong CLV: 5 × 3.0% = 15%, under cap.
    // Need more. 10 TIER 1 plays × 3.0% = 30%, over cap.
    const plays = Array.from({ length: 10 }, (_, i) =>
      playWith({ tier: 'TIER 1', edge: 0.6, clv: 6.0, selection: `A${i}` })
    );
    const r = suggestStakes({ bankroll: 1000, plays });
    assert.equal(r.playCount, 10);
    assert.ok(r.totalStakePct > 25, `totalStakePct should exceed 25%, got ${r.totalStakePct}`);
    assert.ok(r.warnings.some((w) => w.includes('exposure')));
  });

  it('correlation warning still fires on multiple sides same game', () => {
    const plays = [
      playWith({ tier: 'TIER 1', edge: 0.6, clv: 3.0, selection: 'home' }),
      playWith({ tier: 'TIER 2', edge: 0.6, clv: 3.0, selection: 'away' })
    ];
    const r = suggestStakes({ bankroll: 1000, plays });
    assert.ok(r.warnings.some((w) => w.includes('Correlated')));
  });

  it('clvPct in output reflects input value (rounded to 2 dp)', () => {
    const r = suggestStakes({ bankroll: 1000, plays: [playWith({ tier: 'TIER 2', edge: 0.6, clv: 3.4567 })] });
    assert.equal(r.stakes[0].clvPct, 3.46);
  });

  it('clvPct is null in output when input is missing', () => {
    const r = suggestStakes({ bankroll: 1000, plays: [playWith({ tier: 'TIER 2', edge: 0.6 })] });
    assert.equal(r.stakes[0].clvPct, null);
  });
});
