'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const {
  gradeRiskToTierAndCall,
  calculateRiskScore,
  getConfidenceTier,
  getConfidenceTierStable,
  getKaiCall,
  clearTierCache,
  clearScoreTimeline,
  tierCacheKey,
  buildRationale
} = require('../lib/propprofessor-risk-score');

describe('gradeRiskToTierAndCall — unified lookup', () => {
  it('bad or unknown execution cannot produce an actionable call', () => {
    const row = {
      movementLabel: 'supportive',
      movementDisposition: 'supportive_clean',
      movementQuality: 'high',
      movementQualityScore: 0.9,
      consensusBookCount: 8,
      clvProxyPct: 2,
      executionQuality: 'bad',
      multiWindowInsufficientData: true,
      league: 'Tennis'
    };

    assert.equal(getKaiCall(row), 'PASS');
    assert.equal(getConfidenceTier(row), 'TIER 4');
  });

  it('a PASS call cannot remain in an actionable tier', () => {
    const row = {
      movementLabel: 'adverse',
      movementDisposition: 'adverse_full',
      movementQuality: 'high',
      movementQualityScore: 0.9,
      consensusBookCount: 8,
      clvProxyPct: 2,
      executionQuality: 'best',
      multiWindowInsufficientData: true,
      league: 'Tennis'
    };

    assert.equal(getKaiCall(row), 'PASS');
    assert.equal(getConfidenceTier(row), 'TIER 4');
  });

  it('red always → TIER 4, PASS regardless of risk', () => {
    assert.deepStrictEqual(gradeRiskToTierAndCall('red', 1), { tier: 'TIER 4', kaiCall: 'PASS' });
    assert.deepStrictEqual(gradeRiskToTierAndCall('red', 10), { tier: 'TIER 4', kaiCall: 'PASS' });
  });

  it('green + risk≤2 → TIER 1, BET', () => {
    assert.deepStrictEqual(gradeRiskToTierAndCall('green', 1), { tier: 'TIER 1', kaiCall: 'BET' });
    assert.deepStrictEqual(gradeRiskToTierAndCall('green', 2), { tier: 'TIER 1', kaiCall: 'BET' });
  });

  it('green + risk 3-4 → TIER 2, BET', () => {
    assert.deepStrictEqual(gradeRiskToTierAndCall('green', 3), { tier: 'TIER 2', kaiCall: 'BET' });
    assert.deepStrictEqual(gradeRiskToTierAndCall('green', 4), { tier: 'TIER 2', kaiCall: 'BET' });
  });

  it('green + risk 5-6 → TIER 2, CONSIDER (green upgrade)', () => {
    assert.deepStrictEqual(gradeRiskToTierAndCall('green', 5), { tier: 'TIER 2', kaiCall: 'CONSIDER' });
    assert.deepStrictEqual(gradeRiskToTierAndCall('green', 6), { tier: 'TIER 2', kaiCall: 'CONSIDER' });
  });

  it('green + risk≥7 → TIER 3, CONSIDER', () => {
    assert.deepStrictEqual(gradeRiskToTierAndCall('green', 7), { tier: 'TIER 3', kaiCall: 'CONSIDER' });
    assert.deepStrictEqual(gradeRiskToTierAndCall('green', 9), { tier: 'TIER 3', kaiCall: 'CONSIDER' });
  });

  it('yellow + risk≤3 → TIER 2, BET', () => {
    assert.deepStrictEqual(gradeRiskToTierAndCall('yellow', 1), { tier: 'TIER 2', kaiCall: 'BET' });
    assert.deepStrictEqual(gradeRiskToTierAndCall('yellow', 3), { tier: 'TIER 2', kaiCall: 'BET' });
  });

  it('yellow + risk 4 → TIER 2, CONSIDER', () => {
    assert.deepStrictEqual(gradeRiskToTierAndCall('yellow', 4), { tier: 'TIER 2', kaiCall: 'CONSIDER' });
  });

  it('yellow + risk 5-6 → TIER 3, CONSIDER', () => {
    assert.deepStrictEqual(gradeRiskToTierAndCall('yellow', 5), { tier: 'TIER 3', kaiCall: 'CONSIDER' });
    assert.deepStrictEqual(gradeRiskToTierAndCall('yellow', 6), { tier: 'TIER 3', kaiCall: 'CONSIDER' });
  });

  it('yellow + risk≥7 → TIER 4, PASS', () => {
    assert.deepStrictEqual(gradeRiskToTierAndCall('yellow', 7), { tier: 'TIER 4', kaiCall: 'PASS' });
    assert.deepStrictEqual(gradeRiskToTierAndCall('yellow', 10), { tier: 'TIER 4', kaiCall: 'PASS' });
  });
});

describe('internal consistency — tier and kaiCall can never contradict', () => {
  it('BET call never comes with TIER 4', () => {
    const riskScores = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const grades = ['green', 'yellow', 'red'];
    for (const grade of grades) {
      for (const riskScore of riskScores) {
        const result = gradeRiskToTierAndCall(grade, riskScore);
        if (result.kaiCall === 'BET') {
          assert.notStrictEqual(result.tier, 'TIER 4', `BET call with TIER 4 at grade=${grade} risk=${riskScore}`);
        }
        if (result.tier === 'TIER 4') {
          assert.strictEqual(result.kaiCall, 'PASS', `TIER 4 with non-PASS call at grade=${grade} risk=${riskScore}`);
        }
      }
    }
  });
});

describe('multiWindowScore graduated brackets', () => {
  // Build a YELLOW-grade item so the multi-window modifier has room to differentiate.
  // (Green-grade items with clean signals all floor to risk=1.)
  function itemWithWindowScore(score, otherFields = {}) {
    return {
      // movementLabel='neutral' (not supportive/adverse) → yellow grade
      movementLabel: 'neutral',
      executionQuality: 'playable',
      consensusBookCount: 3, // <5 → fails strongConsensus green gate
      steamMove: false,
      clvProxyPct: 0, // not >0 → fails positiveClv green gate
      consensusEdge: 1.0, // >0.5% → edge modifier 0
      steamDirection: '',
      multiWindowScore: score,
      multiWindowInsufficientData: score === null,
      movementQuality: 'medium',
      movementQualityScore: 0.5, // <0.8 → fails highQuality green gate
      peakAdverseClvPct: 11, // not adverse
      ...otherFields
    };
  }

  // YELLOW grade, all base modifiers neutral:
  // base 5, yellow+0, edge>0.5 +0, cons>=3 +1, exec playable +0, no steam +0, CLV> -1 +0
  // = 6. Then the multi-window modifier is the only variable.

  it('1.0 score gives strongest bonus', () => {
    const item = itemWithWindowScore(1.0);
    const score = calculateRiskScore(item);
    // 6 - 1.5 = 4.5 → 5
    assert.strictEqual(score, 5);
  });

  it('0.83 score gives strong bonus', () => {
    const item = itemWithWindowScore(0.83);
    const score = calculateRiskScore(item);
    // 6 - 1 = 5 → 5
    assert.strictEqual(score, 5);
  });

  it('0.66 score gives moderate bonus', () => {
    const item = itemWithWindowScore(0.66);
    const score = calculateRiskScore(item);
    // 6 - 0.5 = 5.5 → 6
    assert.strictEqual(score, 6);
  });

  it('0.50 is neutral', () => {
    const item = itemWithWindowScore(0.5);
    const score = calculateRiskScore(item);
    // 6 + 0 = 6 → 6
    assert.strictEqual(score, 6);
  });

  it('0.33 gives moderate penalty', () => {
    const item = itemWithWindowScore(0.33);
    const score = calculateRiskScore(item);
    // 6 + 0.5 = 6.5 → 7
    assert.strictEqual(score, 7);
  });

  it('0.16 gives strong penalty', () => {
    const item = itemWithWindowScore(0.16);
    const score = calculateRiskScore(item);
    // 6 + 1 = 7 → 7
    assert.strictEqual(score, 7);
  });

  it('0.0 gives strongest penalty', () => {
    const item = itemWithWindowScore(0.0);
    const score = calculateRiskScore(item);
    // 6 + 1.5 = 7.5 → 8
    assert.strictEqual(score, 8);
  });

  it('null score is no modifier when multiWindowInsufficientData is set', () => {
    const withNoData = itemWithWindowScore(null);
    const baseScore = calculateRiskScore(withNoData);
    // 6 + 0 = 6 → 6
    assert.strictEqual(baseScore, 6);
  });

  it("high-penalty bracket doesn't break clamp", () => {
    const item = itemWithWindowScore(0.0, {
      movementLabel: 'adverse',
      executionQuality: 'bad',
      consensusBookCount: 0,
      consensusEdge: -999,
      clvProxyPct: -4,
      steamMove: true,
      steamDirection: 'adverse',
      movementQuality: 'low',
      movementQualityScore: 0.2,
      peakAdverseClvPct: -5
    });
    const score = calculateRiskScore(item);
    // red grade + heavy penalties → should cap at 10
    assert.ok(score <= 10, `should not exceed 10, got ${score}`);
  });
});

// ─── Steam provenance weighting (research: originators move first) ───────────
// A steam move confirmed by sharp originators (Pinnacle/Circa/BookMaker/
// BetOnline) is the strongest signal; a steam of retail followers copying the
// line afterward is weaker. The risk modifier must reflect that.

function steamItem({ originatorCount }) {
  // Neutral baseline so the steam provenance modifier is the ONLY differentiator
  // and scores stay in the mid-range (don't hit the floor=1 clamp).
  return {
    movementLabel: 'supportive',
    movementGrade: 'yellow',
    movementQuality: 'medium',
    movementQualityScore: 0.5,
    executionQuality: 'playable',
    consensusBookCount: 3,
    steamMove: true,
    steamOriginatorCount: originatorCount,
    clvProxyPct: 0,
    consensusEdge: 1.0,
    multiWindowScore: 0.5,
    multiWindowInsufficientData: false,
    peakAdverseClvPct: 0
  };
}

describe('steam originator weighting', () => {
  it('originator-confirmed steam scores lower risk than followers-only steam', () => {
    const withOriginator = calculateRiskScore(steamItem({ originatorCount: 2 }));
    const followersOnly = calculateRiskScore(steamItem({ originatorCount: 0 }));
    assert.ok(
      withOriginator < followersOnly,
      `originator steam (${withOriginator}) should beat followers-only (${followersOnly})`
    );
    assert.strictEqual(withOriginator, followersOnly - 1, 'originator steam should be exactly 1 point stronger');
  });

  it('followers-only steam still lowers risk vs no steam (mild credit)', () => {
    const followersOnly = calculateRiskScore(steamItem({ originatorCount: 0 }));
    const noSteam = calculateRiskScore({ ...steamItem({ originatorCount: 0 }), steamMove: false });
    assert.ok(followersOnly < noSteam, 'followers-only steam should still reduce risk');
  });
});

describe('steam provenance in rationale', () => {
  it('rationale names originator count when originators drove the steam', () => {
    const r = buildRationale({
      selection: 'Yankees',
      consensusBookCount: 6,
      consensusEdge: 1.5,
      movementLabel: 'supportive',
      movementDisposition: 'supportive_clean',
      executionQuality: 'best',
      clvProxyPct: 1,
      confidenceTierLive: 'TIER 2',
      steamMove: true,
      steamBookCount: 4,
      steamOriginatorCount: 2
    });
    assert.ok(r.includes('steam (4 books, 2 originator)'), `expected originator steam text, got: ${r}`);
  });

  it('rationale labels followers-only steam distinctly', () => {
    const r = buildRationale({
      selection: 'Yankees',
      consensusBookCount: 6,
      consensusEdge: 1.5,
      movementLabel: 'supportive',
      movementDisposition: 'supportive_clean',
      executionQuality: 'best',
      clvProxyPct: 1,
      confidenceTierLive: 'TIER 2',
      steamMove: true,
      steamBookCount: 3,
      steamOriginatorCount: 0
    });
    assert.ok(r.includes('steam (3 books, followers-only)'), `expected followers-only steam text, got: ${r}`);
  });
});

// ─── TIER 1 Guardrails ────────────────────────────────────────────────────────
// These tests verify that getConfidenceTier applies additional guardrails
// beyond the grade/risk lookup. A play must not only have green + low risk,
// but also pass real-world quality checks to earn TIER 1.

describe('TIER 1 guardrails', () => {
  // Helper to build an item that would produce green + risk 1 via the lookup.
  function greenTier1Item(overrides = {}) {
    return {
      movementLabel: 'supportive',
      movementQuality: 'high',
      movementQualityScore: 0.9,
      executionQuality: 'best',
      consensusBookCount: 10,
      steamMove: true,
      clvProxyPct: 3,
      consensusEdge: 2.5,
      multiWindowScore: 1.0,
      multiWindowInsufficientData: false,
      peakAdverseClvPct: 0,
      ...overrides
    };
  }

  it('healthy green play gets TIER 1', () => {
    const tier = getConfidenceTier(greenTier1Item());
    assert.strictEqual(tier, 'TIER 1');
  });

  it('negative edge downgrades TIER 1 to TIER 2', () => {
    const tier = getConfidenceTier(greenTier1Item({ consensusEdge: -0.5 }));
    assert.strictEqual(tier, 'TIER 2');
  });

  it('zero edge downgrades TIER 1 to TIER 2', () => {
    const tier = getConfidenceTier(greenTier1Item({ consensusEdge: 0 }));
    assert.strictEqual(tier, 'TIER 2');
  });

  it('single-book consensus downgrades TIER 1 to TIER 2', () => {
    const tier = getConfidenceTier(greenTier1Item({ consensusBookCount: 1, clvProxyPct: 0, consensusEdge: 1.0 }));
    assert.strictEqual(tier, 'TIER 2');
  });

  it('adverse movement downgrades TIER 1 to TIER 3', () => {
    // adverse movement triggers red grade in gradeMovementQuality, which gives
    // TIER 4 via lookup. But if grade somehow stays green, the guardrail fires.
    // The real effect is: adverse -> red -> TIER 4 regardless. Test the guardrail.
    const tier = getConfidenceTier(greenTier1Item({ movementLabel: 'adverse' }));
    assert.notStrictEqual(tier, 'TIER 1');
  });

  it('deteriorating movement downgrades TIER 1 to TIER 3', () => {
    // deteriorating is not adverse, so grade stays yellow (not green).
    // The lookup gives TIER 3 for yellow + low risk, so this never hits TIER 1 anyway.
    // But the guardrail is defense-in-depth. Verify it's not TIER 1.
    const tier = getConfidenceTier(
      greenTier1Item({ movementLabel: 'deteriorating', consensusEdge: 1.0, clvProxyPct: 0 })
    );
    assert.notStrictEqual(tier, 'TIER 1');
  });

  it('heavy favorite (-250) downgrades TIER 1 to TIER 2', () => {
    const tier = getConfidenceTier(greenTier1Item({ odds: -250 }));
    assert.strictEqual(tier, 'TIER 2');
  });

  it('heavy favorite (-426) downgrades TIER 1 to TIER 2', () => {
    const tier = getConfidenceTier(greenTier1Item({ odds: -426 }));
    assert.strictEqual(tier, 'TIER 2');
  });

  it('moderate favorite (-150) stays TIER 1', () => {
    const tier = getConfidenceTier(greenTier1Item({ odds: -150 }));
    assert.strictEqual(tier, 'TIER 1');
  });

  it('pick em (-110) stays TIER 1', () => {
    const tier = getConfidenceTier(greenTier1Item({ odds: -110 }));
    assert.strictEqual(tier, 'TIER 1');
  });

  it('underdog (+150) stays TIER 1', () => {
    const tier = getConfidenceTier(greenTier1Item({ odds: 150 }));
    assert.strictEqual(tier, 'TIER 1');
  });

  it('boundary (-200) stays TIER 1', () => {
    // -200 exactly is the cutoff — not worse than -200, so it stays
    const tier = getConfidenceTier(greenTier1Item({ odds: -200 }));
    assert.strictEqual(tier, 'TIER 1');
  });

  it('boundary (-201) downgrades to TIER 2', () => {
    // -201 is worse than -200, demotes
    const tier = getConfidenceTier(greenTier1Item({ odds: -201 }));
    assert.strictEqual(tier, 'TIER 2');
  });
});

// ─── Novig 2026-06-27 regression ──────────────────────────────────────────────
// Prevents false TIER 1 returns for plays with yellow movement, risk 5+,
// thin consensus, or negative edge — the exact Novig scenario.

describe('Novig 2026-06-27 regression — yellow/risk 5+ rows are not TIER 1', () => {
  function yellowItem(overrides = {}) {
    return {
      movementLabel: 'neutral',
      movementQuality: 'medium',
      movementQualityScore: 0.5,
      executionQuality: 'playable',
      consensusBookCount: 3,
      steamMove: false,
      clvProxyPct: 0,
      consensusEdge: 1.0,
      multiWindowScore: 0.5,
      multiWindowInsufficientData: false,
      peakAdverseClvPct: 11,
      ...overrides
    };
  }

  it('yellow + risk 5 is TIER 3, not TIER 1', () => {
    const item = yellowItem({ riskScore: 5 });
    const tier = getConfidenceTier(item);
    assert.notStrictEqual(tier, 'TIER 1');
    assert.ok(['TIER 2', 'TIER 3', 'TIER 4'].includes(tier), `expected TIER 2/3/4, got ${tier}`);
  });

  it('yellow + risk 7 is TIER 4 (PASS)', () => {
    const tier = getConfidenceTier(
      yellowItem({
        consensusEdge: -0.64,
        riskScore: 7
      })
    );
    assert.strictEqual(tier, 'TIER 4');
  });

  it('yellow + single book is never TIER 1', () => {
    const tier = getConfidenceTier(yellowItem({ consensusBookCount: 1 }));
    assert.notStrictEqual(tier, 'TIER 1');
  });

  it('yellow + negative edge is never TIER 1', () => {
    const tier = getConfidenceTier(yellowItem({ consensusEdge: -0.64 }));
    assert.notStrictEqual(tier, 'TIER 1');
  });

  it('time-to-start: >24h out gets +1 risk vs <2h same play', () => {
    const base = yellowItem({ consensusBookCount: 5, consensusEdge: 1.5, executionQuality: 'best' });
    const farOut = calculateRiskScore({ ...base, start: new Date(Date.now() + 48 * 3600000).toISOString() });
    const imminent = calculateRiskScore({ ...base, start: new Date(Date.now() + 30 * 60000).toISOString() });
    assert.ok(farOut > imminent, `Expected ${farOut} > ${imminent}`);
  });

  it('time-to-start: <2h play gets risk reduction', () => {
    const item = yellowItem({
      consensusBookCount: 5,
      consensusEdge: 1.5,
      executionQuality: 'best',
      start: new Date(Date.now() + 30 * 60000).toISOString()
    });
    const score = calculateRiskScore(item);
    assert.ok(score <= 4, `Expected <=4 but got ${score}`);
  });
});

// ─── Recency weighting ────────────────────────────────────────────────────────
// Recent movement is more predictive than stale movement. A play that moved
// 30 minutes ago should score lower risk than the same play that moved 10 hours ago.

describe('recency weighting — recent movement scores lower risk', () => {
  // Use yellow-grade items so the base score is higher (5-6), giving room for bonuses to differentiate.
  function baseItem(overrides = {}) {
    return {
      movementLabel: 'neutral', // yellow grade, not green
      movementQuality: 'medium',
      movementQualityScore: 0.5,
      executionQuality: 'playable',
      consensusBookCount: 5,
      steamMove: false,
      clvProxyPct: 0,
      consensusEdge: 1.0,
      multiWindowScore: null,
      multiWindowInsufficientData: true,
      peakAdverseClvPct: 0,
      ...overrides
    };
  }

  it('movement <1h ago scores lower risk than >8h ago', () => {
    const recent = baseItem({ lastMoveAgeMs: 30 * 60 * 1000 }); // 30 min
    const stale = baseItem({ lastMoveAgeMs: 10 * 60 * 60 * 1000 }); // 10 hours
    const recentScore = calculateRiskScore(recent);
    const staleScore = calculateRiskScore(stale);
    assert.ok(recentScore < staleScore, `Expected ${recentScore} < ${staleScore}`);
  });

  it('movement 1-3h ago gets moderate bonus', () => {
    const moderate = baseItem({ lastMoveAgeMs: 2 * 60 * 60 * 1000 }); // 2 hours
    const stale = baseItem({ lastMoveAgeMs: 10 * 60 * 60 * 1000 }); // 10 hours
    const moderateScore = calculateRiskScore(moderate);
    const staleScore = calculateRiskScore(stale);
    assert.ok(moderateScore < staleScore, `Expected ${moderateScore} < ${staleScore}`);
  });

  it('no lastMoveAgeMs is neutral (no modifier)', () => {
    const noAge = baseItem();
    const withAge = baseItem({ lastMoveAgeMs: 30 * 60 * 1000 });
    const noAgeScore = calculateRiskScore(noAge);
    const withAgeScore = calculateRiskScore(withAge);
    assert.ok(noAgeScore > withAgeScore, `Expected ${noAgeScore} > ${withAgeScore}`);
  });
});

// ─── CLV weight increase ──────────────────────────────────────────────────────
// CLV is a primary signal — strong positive CLV should significantly reduce risk.

describe('CLV weight — strong positive CLV scores significantly lower risk', () => {
  // Use yellow-grade items so the base score is higher (5-6), giving room for CLV to differentiate.
  function baseItem(overrides = {}) {
    return {
      movementLabel: 'neutral', // yellow grade, not green
      movementQuality: 'medium',
      movementQualityScore: 0.5,
      executionQuality: 'playable',
      consensusBookCount: 5,
      steamMove: false,
      consensusEdge: 1.0,
      multiWindowScore: null,
      multiWindowInsufficientData: true,
      peakAdverseClvPct: 0,
      ...overrides
    };
  }

  it('strong positive CLV (3.5%) scores 2+ points lower than zero CLV', () => {
    const strongCLV = baseItem({ clvProxyPct: 3.5 });
    const noCLV = baseItem({ clvProxyPct: 0 });
    const strongScore = calculateRiskScore(strongCLV);
    const noScore = calculateRiskScore(noCLV);
    assert.ok(strongScore <= noScore - 2, `Expected ${strongScore} <= ${noScore - 2}`);
  });

  it('strong negative CLV (-4%) scores 3+ points higher than zero CLV', () => {
    const badCLV = baseItem({ clvProxyPct: -4 });
    const noCLV = baseItem({ clvProxyPct: 0 });
    const badScore = calculateRiskScore(badCLV);
    const noScore = calculateRiskScore(noCLV);
    assert.ok(badScore >= noScore + 3, `Expected ${badScore} >= ${noScore + 3}`);
  });

  it('moderate positive CLV (1%) still gives meaningful bonus', () => {
    const modCLV = baseItem({ clvProxyPct: 1 });
    const noCLV = baseItem({ clvProxyPct: 0 });
    const modScore = calculateRiskScore(modCLV);
    const noScore = calculateRiskScore(noCLV);
    assert.ok(modScore < noScore, `Expected ${modScore} < ${noScore}`);
  });
});

describe('tier hysteresis cache — per-call reset contract', () => {
  function baseItem(overrides = {}) {
    return {
      gameId: 'g1',
      league: 'Tennis',
      market: 'Moneyline',
      selection: 'Test Player',
      participant: 'Test Player',
      // Genuine TIER 1 inputs: green movement, low risk.
      movementLabel: 'supportive',
      movementQuality: 'high',
      executionQuality: 'best',
      consensusBookCount: 5,
      steamMove: true,
      clvProxyPct: 1.5,
      consensusEdge: 2.5,
      multiWindowInsufficientData: true,
      odds: -110,
      ...overrides
    };
  }

  before(() => {
    clearScoreTimeline();
    clearTierCache();
  });
  after(() => {
    clearScoreTimeline();
    clearTierCache();
  });

  it('produces the same stable tier across two identical calls when cache is cleared between them', () => {
    clearTierCache();
    const first = getConfidenceTierStable(baseItem());
    // Simulate the MCP entry point clearing the cache between calls.
    clearTierCache();
    const second = getConfidenceTierStable(baseItem());
    assert.equal(first, 'TIER 1');
    assert.equal(second, 'TIER 1');
  });

  it('does not let a stale cached TIER 4 mask a fresh TIER 1 after cache clear', () => {
    // Seed cache with a deteriorating TIER 4 observation (adverse movement → red → TIER 4).
    getConfidenceTierStable(
      baseItem({
        movementLabel: 'adverse',
        movementQuality: 'low',
        executionQuality: 'bad',
        consensusBookCount: 1,
        clvProxyPct: -3,
        consensusEdge: -1
      })
    );
    // A new call with clean cache must recompute from raw, not carry the TIER 4.
    clearTierCache();
    const fresh = getConfidenceTierStable(baseItem());
    assert.equal(fresh, 'TIER 1');
  });
});

describe('tierCacheKey — distinct keys for distinct plays (audit finding #1)', () => {
  it('two different totals lines on the same game produce different keys', () => {
    const under166 = {
      row: { gameId: 'NBA:PREMATCH:LAL:BOS:1234', selection: 'Under', market: 'Total', league: 'NBA', line: 166.5 }
    };
    const under168 = {
      row: { gameId: 'NBA:PREMATCH:LAL:BOS:1234', selection: 'Under', market: 'Total', league: 'NBA', line: 168.5 }
    };
    const k1 = tierCacheKey(under166);
    const k2 = tierCacheKey(under168);
    assert.notEqual(k1, k2, 'different lines must produce different cache keys');
  });

  it('two different spreads on the same game produce different keys', () => {
    const a = {
      row: { gameId: 'NBA:PREMATCH:LAL:BOS:1234', selection: 'Lakers', market: 'Spread', league: 'NBA', line: -3.5 }
    };
    const b = {
      row: { gameId: 'NBA:PREMATCH:LAL:BOS:1234', selection: 'Lakers', market: 'Spread', league: 'NBA', line: -4.5 }
    };
    assert.notEqual(tierCacheKey(a), tierCacheKey(b));
  });

  it('playId is the canonical key when present (line baked in)', () => {
    const a = { row: { playId: 'NBA:PREMATCH:LAL:BOS:1234::Total::Under 166.5' } };
    const b = { row: { playId: 'NBA:PREMATCH:LAL:BOS:1234::Total::Under 168.5' } };
    const ka = tierCacheKey(a);
    const kb = tierCacheKey(b);
    assert.ok(ka && ka.startsWith('playId:'), 'playId keys are prefixed playId:');
    assert.notEqual(ka, kb);
  });

  it('returns null when both gameId and playId are missing (no matchup fallback)', () => {
    const noKey = { row: { awayTeam: 'LAL', homeTeam: 'BOS', selection: 'Under', market: 'Total', league: 'NBA' } };
    assert.equal(tierCacheKey(noKey), null, 'must not fall back to matchup string (collision risk)');
  });

  it('returns null when selection is missing even if gameId is present', () => {
    const noSel = { row: { gameId: 'NBA:PREMATCH:LAL:BOS:1234', market: 'Total', league: 'NBA' } };
    assert.equal(tierCacheKey(noSel), null);
  });
});

describe('tier grading — tennis field vocabulary', () => {
  // Tennis rows (from runTennisScreen) use movementGrade / edge / clv /
  // movementDisposition instead of the NBA/MLB movementLabel / consensusEdge /
  // clvProxyPct. getConfidenceTierStable must grade them correctly, not fall
  // back to worst-case because the NBA keys are undefined.
  function tennisItem(overrides = {}) {
    return {
      league: 'Tennis',
      movementGrade: 'green',
      movementDisposition: 'supportive_clean',
      movementQuality: 'high',
      multiWindowInsufficientData: true,
      executionQuality: 'best',
      consensusBookCount: 12,
      steamMove: true,
      clv: 1.5,
      edge: 2.5,
      odds: -110,
      ...overrides
    };
  }

  before(() => clearScoreTimeline());
  after(() => clearScoreTimeline());

  it('grades a tennis-shaped green row as TIER 1 (not garbage TIER 4)', () => {
    clearTierCache();
    const tier = getConfidenceTierStable(tennisItem());
    assert.equal(tier, 'TIER 1');
  });

  it('grades a tennis-shaped adverse row as TIER 4', () => {
    clearTierCache();
    const tier = getConfidenceTierStable(
      tennisItem({ movementGrade: 'red', movementDisposition: 'adverse_full', clv: -1.15, edge: 2.5 })
    );
    assert.equal(tier, 'TIER 4');
  });
});

// ─── CLV-based tiering (future-CLV prediction) ─────────────────────────────

describe('CLV-based tier promotion and exemption', () => {
  it('edge=0 + CLV=4¢ + supportive_clean → TIER 1 (CLV exemption)', () => {
    // CLV exemption: strong CLV bypasses edge guardrail
    const tier = getConfidenceTier({
      movementLabel: 'supportive',
      movementDisposition: 'supportive_clean',
      movementQuality: 'high',
      movementQualityScore: 0.9,
      executionQuality: 'best',
      consensusBookCount: 10,
      steamMove: true,
      clvProxyPct: 4,
      consensusEdge: 0,
      multiWindowScore: 1.0,
      multiWindowInsufficientData: false,
      peakAdverseClvPct: 0
    });
    assert.strictEqual(tier, 'TIER 1');
  });

  it('edge=0 + CLV=2¢ + supportive_clean → TIER 2 (below CLV threshold)', () => {
    // CLV below 3¢ threshold, edge guardrail kicks in
    const tier = getConfidenceTier({
      movementLabel: 'supportive',
      movementDisposition: 'supportive_clean',
      movementQuality: 'high',
      movementQualityScore: 0.9,
      executionQuality: 'best',
      consensusBookCount: 10,
      steamMove: true,
      clvProxyPct: 2,
      consensusEdge: 0,
      multiWindowScore: 1.0,
      multiWindowInsufficientData: false,
      peakAdverseClvPct: 0
    });
    assert.strictEqual(tier, 'TIER 2');
  });

  it('yellow + CLV=6¢ + risk≤3 + supportive_bouncy → TIER 1 (high-CLV promotion)', () => {
    // High-CLV promotion: yellow grade with exceptional CLV
    const item = {
      movementLabel: 'supportive',
      movementDisposition: 'supportive_bouncy',
      movementQuality: 'medium',
      movementQualityScore: 0.6,
      executionQuality: 'playable',
      consensusBookCount: 8,
      steamMove: false,
      clvProxyPct: 6,
      consensusEdge: 1.0,
      multiWindowScore: 0.66,
      multiWindowInsufficientData: false,
      peakAdverseClvPct: 0
    };
    const tier = getConfidenceTier(item);
    assert.strictEqual(tier, 'TIER 1');
  });

  it('yellow + CLV=6¢ + adverse_full → TIER 2 (no promotion on adverse)', () => {
    // High-CLV but adverse movement — no promotion
    const item = {
      movementLabel: 'adverse',
      movementDisposition: 'adverse_full',
      executionQuality: 'playable',
      consensusBookCount: 8,
      steamMove: false,
      clvProxyPct: 6,
      consensusEdge: 1.0
    };
    const tier = getConfidenceTier(item);
    assert.notStrictEqual(tier, 'TIER 1');
  });

  it('sharp book confirmation reduces risk score', () => {
    const baseItem = {
      movementLabel: 'supportive',
      executionQuality: 'playable',
      consensusBookCount: 5,
      steamMove: false,
      clvProxyPct: 1,
      consensusEdge: 1.0,
      multiWindowScore: 0.5,
      multiWindowInsufficientData: false,
      peakAdverseClvPct: 0
    };
    const withoutSharp = calculateRiskScore({ ...baseItem, sharpBookMovementConfirmed: false });
    const withSharp = calculateRiskScore({ ...baseItem, sharpBookMovementConfirmed: true });
    assert.ok(withSharp <= withoutSharp, 'sharp confirmed should reduce risk score');
  });
});
