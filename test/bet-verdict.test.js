'use strict';

/**
 * Phase 1 Task 1: verdict + tier reconciliation extracted from the handler
 * god-module into lib/bet-verdict.js.
 *
 * These are pure, dependency-light unit tests for the four extracted
 * functions:
 *   - applyValidatedFields        (merge validate_play verdict fields)
 *   - applyFinalVerdict            (authoritative bet/no-bet reconciliation)
 *   - flagContradictoryPlays       (Over/Under contradiction downgrade)
 *   - promoteFinalVerdictToDisplay (promote merged verdict to display fields)
 *
 * They must preserve the exact behavior that used to live in handlers.js,
 * including the central TIER_RANK ordering and the PASS -> TIER 4 invariant.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TIER_RANK,
  applyValidatedFields,
  applyFinalVerdict,
  flagContradictoryPlays,
  promoteFinalVerdictToDisplay
} = require('../lib/bet-verdict');

// ---------------------------------------------------------------------------
// TIER_RANK centralization
// ---------------------------------------------------------------------------

test('TIER_RANK orders confidence tiers 1..4 ascending', () => {
  assert.deepEqual(TIER_RANK, { 'TIER 1': 1, 'TIER 2': 2, 'TIER 3': 3, 'TIER 4': 4 });
});

// ---------------------------------------------------------------------------
// applyValidatedFields
// ---------------------------------------------------------------------------

test('applyValidatedFields keeps screen playable when validate bad has no drift', () => {
  const target = {
    executionQuality: 'playable',
    movementDisposition: 'supportive_clean',
    displayTier: 'BET',
    confidenceTier: 'TIER 1'
  };
  const validationResult = {
    verdict: 'BET',
    tier: 'TIER 1',
    verdictSummary: {
      displayTier: 'BET',
      movementDisposition: 'supportive_clean',
      executionQuality: 'bad',
      consensusSupport: '19 books',
      riskFlags: [],
      actionableSummary: 'x'
    },
    play: { consensusBookCount: 19, executionQuality: 'bad' },
    consensusDrift: false,
    driftReason: null
  };
  applyValidatedFields(target, validationResult);
  assert.equal(target.validatedExecQuality, 'playable', 'screen playable must survive a non-drift validate bad');
  assert.equal(target.validatedReconcileOverridden, true);
});

test('applyValidatedFields marks unverified + 0 book count when line gone', () => {
  const target = { displayTier: 'BET', confidenceTier: 'TIER 1' };
  const validationResult = {
    verdict: 'PASS',
    verdictSummary: { displayTier: 'PASS' },
    play: null, // lookup_failed
    consensusDrift: true,
    driftReason: 'line gone'
  };
  applyValidatedFields(target, validationResult);
  assert.equal(target.validatedUnverified, true, 'play===null => unverified');
  assert.equal(target.validatedConsensusBookCount, 0, 'no phantom book count on missing line');
});

test('applyValidatedFields threads consensus drift + reason', () => {
  const target = { displayTier: 'BET', confidenceTier: 'TIER 1' };
  const validationResult = {
    verdict: 'BET',
    tier: 'TIER 1',
    verdictSummary: { displayTier: 'BET', riskFlags: ['movement adverse'] },
    play: { consensusBookCount: 3, executionQuality: 'playable', odds: -110 },
    consensusDrift: true,
    driftReason: '5 books -> 1'
  };
  applyValidatedFields(target, validationResult);
  assert.equal(target.validatedConsensusDrift, true);
  assert.equal(target.validatedDriftReason, '5 books -> 1');
  assert.equal(target.validatedConsensusSupport, null);
});

// ---------------------------------------------------------------------------
// applyFinalVerdict
// ---------------------------------------------------------------------------

test('applyFinalVerdict does NOT hard-PASS a screen-blessed BET when bad was overridden', () => {
  const cand = {
    validatedVerdict: 'BET',
    validatedConfidenceTier: 'TIER 1',
    confidenceTier: 'TIER 1',
    displayTier: 'BET',
    kaiCall: 'BET',
    validatedRiskFlags: [],
    validatedExecQuality: 'playable',
    validatedReconcileOverridden: true,
    validatedConsensusDrift: false,
    validatedUnverified: false
  };
  applyFinalVerdict(cand);
  assert.equal(cand.finalVerdict, 'BET', 'screen-blessed BET must survive a non-drift validate bad');
});

test('applyFinalVerdict hard-PASSes a BET with adverse movement risk flag', () => {
  const cand = {
    validatedVerdict: 'BET',
    validatedConfidenceTier: 'TIER 1',
    confidenceTier: 'TIER 1',
    displayTier: 'BET',
    kaiCall: 'BET',
    validatedRiskFlags: ['movement adverse'],
    validatedExecQuality: 'playable',
    validatedReconcileOverridden: false,
    validatedConsensusDrift: false,
    validatedUnverified: false
  };
  applyFinalVerdict(cand);
  assert.equal(cand.finalVerdict, 'PASS', 'adverse movement flag forces PASS, never BET');
  assert.equal(cand.finalConfidenceTier, 'TIER 4', 'PASS verdict forces TIER 4');
});

test('applyFinalVerdict prevents a side-conflict loser from resurrecting as BET', () => {
  const cand = {
    conflictFlag: true,
    kaiCall: 'CONSIDER',
    displayTier: 'CONSIDER',
    confidenceTier: 'TIER 2',
    validatedConfidenceTier: 'TIER 1',
    validatedVerdict: 'BET',
    validatedRiskFlags: [],
    validatedConsensusDrift: false,
    validatedUnverified: false
  };
  applyFinalVerdict(cand);
  assert.notEqual(cand.finalVerdict, 'BET', 'conflict loser must not resurrect as BET');
  assert.equal(cand.finalVerdict, 'CONSIDER', 'conflict loser stays at CONSIDER');
});

test('applyFinalVerdict prevents a totals-conflict loser from resurrecting as BET', () => {
  const cand = {
    totalsConflictWith: 'Under 171.5',
    kaiCall: 'CONSIDER',
    displayTier: 'CONSIDER',
    confidenceTier: 'TIER 2',
    validatedConfidenceTier: 'TIER 1',
    validatedVerdict: 'BET',
    validatedRiskFlags: [],
    validatedConsensusDrift: false,
    validatedUnverified: false
  };
  applyFinalVerdict(cand);
  assert.notEqual(cand.finalVerdict, 'BET', 'totals-conflict loser must not resurrect as BET');
  assert.equal(cand.finalVerdict, 'CONSIDER', 'totals-conflict loser stays at CONSIDER');
});

test('applyFinalVerdict preserves deeper PASS demotion on conflict loser', () => {
  const cand = {
    conflictFlag: true,
    kaiCall: 'PASS',
    displayTier: 'PASS',
    confidenceTier: 'TIER 4',
    validatedConfidenceTier: 'TIER 1',
    validatedVerdict: 'BET',
    validatedRiskFlags: [],
    validatedConsensusDrift: false,
    validatedUnverified: false
  };
  applyFinalVerdict(cand);
  assert.equal(cand.finalVerdict, 'PASS', 'already-PASS conflict row stays PASS');
});

test('applyFinalVerdict clamps a totals-conflict loser out of TIER 1 even when re-graded TIER 1', () => {
  const cand = {
    totalsConflictWith: 'Over 168.5',
    kaiCall: 'CONSIDER',
    displayTier: 'CONSIDER',
    confidenceTier: 'TIER 2',
    validatedConfidenceTier: 'TIER 1',
    validatedVerdict: 'BET',
    validatedRiskFlags: [],
    validatedConsensusDrift: false,
    validatedUnverified: false
  };
  applyFinalVerdict(cand);
  assert.equal(cand.finalVerdict, 'CONSIDER');
  assert.equal(cand.finalConfidenceTier, 'TIER 2', 'clamp to screen-demoted tier, not validated TIER 1');
});

test('applyFinalVerdict never leaves a failed-validation screen BET actionable', () => {
  const cand = {
    displayTier: 'BET',
    kaiCall: 'BET',
    confidenceTier: 'TIER 1',
    _validated: false
  };
  applyFinalVerdict(cand);
  assert.equal(cand.finalVerdict, 'CONSIDER');
  assert.ok(cand.finalWarnings.includes('validation-failed'));
});

test('applyFinalVerdict downgrades BET to CONSIDER on consensus drift', () => {
  const cand = {
    displayTier: 'BET',
    kaiCall: 'BET',
    confidenceTier: 'TIER 1',
    validatedConfidenceTier: 'TIER 1',
    validatedVerdict: 'BET',
    validatedRiskFlags: [],
    validatedConsensusDrift: true,
    validatedUnverified: false
  };
  applyFinalVerdict(cand);
  assert.equal(cand.finalVerdict, 'CONSIDER', 'drifted consensus can never ship BET');
  assert.ok(cand.finalWarnings.includes('consensus-drift'));
});

test('applyValidatedFields drops an unreconciled adverse movement risk flag when screen movement is preserved', () => {
  const target = {
    movementDisposition: 'supportive_clean',
    executionQuality: 'playable',
    confidenceTier: 'TIER 1',
    kaiCall: 'BET',
    displayTier: 'BET'
  };
  applyValidatedFields(target, {
    verdict: {
      displayTier: 'BET',
      movementDisposition: 'adverse_full',
      executionQuality: 'playable',
      riskFlags: ['movement adverse'],
      actionableSummary: 'fixture',
      consensusSupport: 'fixture'
    },
    play: { executionQuality: 'playable' },
    verdictSummary: {
      movementDisposition: 'adverse_full',
      executionQuality: 'playable'
    },
    consensusDrift: false
  });
  assert.equal(target.validatedMovementDisposition, 'supportive_clean');
  assert.deepEqual(target.validatedRiskFlags, []);
});

test('applyFinalVerdict downgrades BET to PASS on insufficient movement disposition', () => {
  const cand = {
    displayTier: 'BET',
    kaiCall: 'BET',
    confidenceTier: 'TIER 1',
    validatedConfidenceTier: 'TIER 1',
    validatedVerdict: 'BET',
    validatedRiskFlags: [],
    validatedMovementDisposition: 'insufficient',
    validatedConsensusDrift: false,
    validatedUnverified: false
  };
  applyFinalVerdict(cand);
  assert.equal(cand.finalVerdict, 'PASS', 'insufficient disposition can never be BET');
});

test('applyFinalVerdict forces TIER 4 for every PASS verdict', () => {
  const cand = {
    displayTier: 'CONSIDER',
    kaiCall: 'CONSIDER',
    confidenceTier: 'TIER 1',
    validatedConfidenceTier: 'TIER 1',
    validatedVerdict: 'PASS',
    validatedRiskFlags: []
  };
  applyFinalVerdict(cand);
  assert.equal(cand.finalVerdict, 'PASS');
  assert.equal(cand.finalConfidenceTier, 'TIER 4', 'PASS always forces TIER 4');
});

test('applyFinalVerdict altLineFiltered forces PASS + TIER 4', () => {
  const cand = {
    altLineFiltered: true,
    displayTier: 'BET',
    kaiCall: 'BET',
    confidenceTier: 'TIER 1',
    validatedConfidenceTier: 'TIER 1',
    validatedVerdict: 'BET',
    validatedRiskFlags: []
  };
  applyFinalVerdict(cand);
  assert.equal(cand.finalVerdict, 'PASS');
  assert.equal(cand.finalConfidenceTier, 'TIER 4');
});

test('applyFinalVerdict clears validation-failed state when validation skipped', () => {
  const cand = {
    validationSkipped: true,
    validationFailed: true,
    validationFailureReason: 'x',
    finalWarnings: ['validation-failed'],
    displayTier: 'BET',
    kaiCall: 'BET',
    confidenceTier: 'TIER 1'
  };
  applyFinalVerdict(cand);
  assert.equal(cand.validationFailed, undefined);
  assert.equal(cand.validationFailureReason, undefined);
  assert.ok(!cand.finalWarnings.includes('validation-failed'));
});

test('applyFinalVerdict adds price-drift warning when odds moved > 30 points', () => {
  const cand = {
    odds: -110,
    validatedOdds: -150,
    validatedConfidenceTier: 'TIER 1',
    validatedVerdict: 'BET',
    validatedRiskFlags: [],
    validatedConsensusDrift: false,
    validatedUnverified: false
  };
  applyFinalVerdict(cand);
  assert.equal(cand.priceDrift, 40);
  assert.ok(cand.finalWarnings.includes('price-drift'));
});

test('applyFinalVerdict adds unknown-game-context warning', () => {
  const cand = {
    validatedConfidenceTier: 'TIER 1',
    validatedVerdict: 'BET',
    validatedRiskFlags: [],
    validatedConsensusDrift: false,
    validatedUnverified: false,
    validatedGameContext: { riskFlag: 'unknown' }
  };
  applyFinalVerdict(cand);
  assert.ok(cand.finalWarnings.includes('unknown-game-context'));
});

test('applyFinalVerdict adds unverified-line warning', () => {
  const cand = {
    validatedVerdict: 'CONSIDER',
    validatedConfidenceTier: 'TIER 2',
    validatedRiskFlags: [],
    validatedConsensusDrift: false,
    validatedUnverified: true
  };
  applyFinalVerdict(cand);
  assert.ok(cand.finalWarnings.includes('unverified-line'));
});

// ---------------------------------------------------------------------------
// flagContradictoryPlays
// ---------------------------------------------------------------------------

test('flagContradictoryPlays downgrades the weaker Over/Under side', () => {
  const plays = [
    {
      gameId: 'G1',
      market: 'Total',
      selection: 'Over 170.5',
      movementDisposition: 'supportive_clean',
      edge: 3,
      finalVerdict: 'BET',
      kaiCall: 'BET',
      finalConfidenceTier: 'TIER 1',
      confidenceTier: 'TIER 1',
      displayTier: 'BET'
    },
    {
      gameId: 'G1',
      market: 'Total',
      selection: 'Under 170.5',
      movementDisposition: 'adverse_full',
      edge: 1,
      finalVerdict: 'BET',
      kaiCall: 'BET',
      finalConfidenceTier: 'TIER 1',
      confidenceTier: 'TIER 1',
      displayTier: 'BET'
    }
  ];
  flagContradictoryPlays(plays);
  assert.equal(plays[0].finalVerdict, 'BET', 'stronger side (Over, supportive) kept');
  assert.equal(plays[1].finalVerdict, 'CONSIDER', 'weaker side (Under, adverse) downgraded');
  assert.ok(plays[1].finalWarnings.some((w) => w.startsWith('contradictory-signal:')));
});

test('flagContradictoryPlays is a no-op with fewer than 2 plays', () => {
  const plays = [{ gameId: 'G1', market: 'Total', selection: 'Over 170.5', finalVerdict: 'BET' }];
  flagContradictoryPlays(plays);
  assert.equal(plays[0].finalVerdict, 'BET');
});

test('flagContradictoryPlays downgrades stronger side only when weaker is fully supportive (noise)', () => {
  const plays = [
    {
      gameId: 'G1',
      market: 'Total',
      selection: 'Over 170.5',
      movementDisposition: 'supportive_clean',
      edge: 3,
      finalVerdict: 'BET',
      kaiCall: 'BET',
      finalConfidenceTier: 'TIER 1',
      confidenceTier: 'TIER 1',
      displayTier: 'BET'
    },
    {
      gameId: 'G1',
      market: 'Total',
      selection: 'Under 170.5',
      movementDisposition: 'supportive_bouncy',
      edge: 1,
      finalVerdict: 'BET',
      kaiCall: 'BET',
      finalConfidenceTier: 'TIER 1',
      confidenceTier: 'TIER 1',
      displayTier: 'BET'
    }
  ];
  flagContradictoryPlays(plays);
  // Both supportive => both downgraded (noise).
  assert.equal(plays[0].finalVerdict, 'CONSIDER', 'stronger side also downgraded when both supportive');
  assert.equal(plays[1].finalVerdict, 'CONSIDER');
});

// ---------------------------------------------------------------------------
// promoteFinalVerdictToDisplay
// ---------------------------------------------------------------------------

test('promoteFinalVerdictToDisplay promotes verdict + tier to display fields', () => {
  const target = {
    _validated: true,
    finalVerdict: 'BET',
    finalConfidenceTier: 'TIER 1',
    selection: 'Over 170.5',
    odds: -110
  };
  promoteFinalVerdictToDisplay(target);
  assert.equal(target.displayTier, 'BET');
  assert.equal(target.kaiCall, 'BET');
  assert.equal(target.confidenceTier, 'TIER 1');
  assert.equal(target.summary, 'BET Over 170.5 at -110');
});

test('promoteFinalVerdictToDisplay forces TIER 4 on PASS', () => {
  const target = {
    _validated: true,
    finalVerdict: 'PASS',
    finalConfidenceTier: 'TIER 1', // stale leak from screen
    selection: 'Under 170.5'
  };
  promoteFinalVerdictToDisplay(target);
  assert.equal(target.confidenceTier, 'TIER 4', 'PASS must never ship a non-TIER 4 confidence tier');
});

test('promoteFinalVerdictToDisplay is a no-op before validation ran', () => {
  const target = { _validated: false, finalVerdict: 'BET', finalConfidenceTier: 'TIER 1' };
  promoteFinalVerdictToDisplay(target);
  assert.equal(target.displayTier, undefined);
  assert.equal(target.kaiCall, undefined);
});

test('promoteFinalVerdictToDisplay is a no-op without a finalVerdict', () => {
  const target = { _validated: true, finalConfidenceTier: 'TIER 1' };
  promoteFinalVerdictToDisplay(target);
  assert.equal(target.displayTier, undefined);
});
