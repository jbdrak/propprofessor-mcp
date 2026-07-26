'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { classifyExecutionQuality } = require('../lib/screen-summary');
const { reconcileValidateOverride } = require('../lib/validate-reconcile');
const { applyValidatedFields, applyFinalVerdict } = require('../scripts/server/handlers');

test('classifyExecutionQuality is exported and callable', () => {
  assert.strictEqual(typeof classifyExecutionQuality, 'function');
  // -190 within 10c of best -190 => playable
  assert.strictEqual(classifyExecutionQuality({ targetOdds: -190, comparisonOdds: [-190, -185, -195] }), 'playable');
});

test('keeps screen playable when validate says bad but no consensus drift', () => {
  const r = reconcileValidateOverride({
    screenExec: 'playable',
    screenDisposition: 'supportive_clean',
    validateExec: 'bad',
    validateDisposition: 'supportive_clean',
    consensusDrift: false
  });
  assert.strictEqual(r.executionQuality, 'playable');
  assert.strictEqual(r.overridden, true);
  assert.match(r.reason, /no consensus drift/);
});

test('accepts validate bad when consensus drifted', () => {
  const r = reconcileValidateOverride({
    screenExec: 'playable',
    screenDisposition: 'supportive_clean',
    validateExec: 'bad',
    validateDisposition: 'supportive_clean',
    consensusDrift: true
  });
  assert.strictEqual(r.executionQuality, 'bad');
  assert.strictEqual(r.overridden, false);
});

test('keeps screen supportive_clean when validate flips adverse but no drift', () => {
  const r = reconcileValidateOverride({
    screenExec: 'playable',
    screenDisposition: 'supportive_clean',
    validateExec: 'playable',
    validateDisposition: 'adverse_recent',
    consensusDrift: false
  });
  assert.strictEqual(r.movementDisposition, 'supportive_clean');
  assert.strictEqual(r.overridden, true);
});

test('accepts adverse disposition when consensus drifted', () => {
  const r = reconcileValidateOverride({
    screenExec: 'playable',
    screenDisposition: 'supportive_clean',
    validateExec: 'playable',
    validateDisposition: 'adverse_recent',
    consensusDrift: true
  });
  assert.strictEqual(r.movementDisposition, 'adverse_recent');
  assert.strictEqual(r.overridden, false);
});

test('passes through when screen and validate agree', () => {
  const r = reconcileValidateOverride({
    screenExec: 'best',
    screenDisposition: 'supportive_clean',
    validateExec: 'best',
    validateDisposition: 'supportive_clean',
    consensusDrift: false
  });
  assert.strictEqual(r.executionQuality, 'best');
  assert.strictEqual(r.movementDisposition, 'supportive_clean');
  assert.strictEqual(r.overridden, false);
});

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
  assert.strictEqual(target.validatedExecQuality, 'playable', 'screen playable must survive a non-drift validate bad');
  assert.strictEqual(target.validatedReconcileOverridden, true);
});

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
  assert.strictEqual(cand.finalVerdict, 'BET', 'screen-blessed BET must survive a non-drift validate bad');
});
