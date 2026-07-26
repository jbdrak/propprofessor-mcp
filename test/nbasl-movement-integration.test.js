'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeMovementDisposition } = require('../lib/propprofessor-movement-disposition');
const { resolveMarketName } = require('../lib/propprofessor-shared-utils');
const { reconcileValidateOverride } = require('../lib/validate-reconcile');

describe('NBASL movement quality fixes', () => {
  // ── Market aliases ────────────────────────────────────────────────
  it('resolveMarketName resolves Spread to Point Spread for NBASL', () => {
    const result = resolveMarketName('Spread', 'NBASL');
    assert.equal(result.resolved, 'Point Spread');
    assert.equal(result.wasAliased, true);
  });

  it('resolveMarketName resolves Total to Total Points for NBASL', () => {
    const result = resolveMarketName('Total', 'NBASL');
    assert.equal(result.resolved, 'Total Points');
    assert.equal(result.wasAliased, true);
  });

  it('resolveMarketName resolves Over/Under to Total Points for NBASL', () => {
    const result = resolveMarketName('Over/Under', 'NBASL');
    assert.equal(result.resolved, 'Total Points');
    assert.equal(result.wasAliased, true);
  });

  it('resolveMarketName resolves handicap to Point Spread for NBASL', () => {
    const result = resolveMarketName('Handicap', 'NBASL');
    assert.equal(result.resolved, 'Point Spread');
    assert.equal(result.wasAliased, true);
  });

  // ── CLV-sign guard (Task 2) ──────────────────────────────────────
  it('computeMovementDisposition returns adverse_full for supportive label + negative CLV + missing directions', () => {
    // Simulates an NBASL Moneyline side where the feed stamps 'supportive'
    // but the actual CLV is negative — odds moved against this side.
    const result = computeMovementDisposition({
      movementGrade: 'yellow',
      movementLabel: 'supportive',
      openToCurrentClvPct: -0.49,
      // Direction fields are missing/empty (thin NBASL feed)
      recentSharpMoveDirection: '',
      fullWindowSharpMoveDirection: '',
      sharpBookMovementConfirmed: false
    });
    assert.equal(result, 'adverse_full', 'CLV-negative side with thin direction data should be adverse_full');
  });

  it('computeMovementDisposition keeps supportive_bouncy for positive CLV + supportive label + missing directions', () => {
    // Simulates the other side of the same matchup — positive CLV, label is trustworthy.
    const result = computeMovementDisposition({
      movementGrade: 'yellow',
      movementLabel: 'supportive',
      openToCurrentClvPct: 0.98,
      recentSharpMoveDirection: '',
      fullWindowSharpMoveDirection: '',
      sharpBookMovementConfirmed: false
    });
    assert.equal(result, 'supportive_bouncy', 'CLV-positive side with supportive label should stay supportive_bouncy');
  });

  it('computeMovementDisposition does not override when direction fields exist', () => {
    // When the feed HAS direction data, the CLV-sign guard should NOT fire.
    const result = computeMovementDisposition({
      movementGrade: 'yellow',
      movementLabel: 'supportive',
      openToCurrentClvPct: -0.49,
      recentSharpMoveDirection: 'supportive',
      fullWindowSharpMoveDirection: 'supportive',
      sharpBookMovementConfirmed: false
    });
    assert.notEqual(result, 'adverse_full', 'Should not override when direction fields are present');
  });

  it('computeMovementDisposition uses clv fallback when openToCurrentClvPct is missing', () => {
    const result = computeMovementDisposition({
      movementGrade: 'yellow',
      movementLabel: 'supportive',
      clv: -0.33,
      recentSharpMoveDirection: '',
      fullWindowSharpMoveDirection: '',
      sharpBookMovementConfirmed: false
    });
    assert.equal(result, 'adverse_full', 'Should fall back to row.clv when openToCurrentClvPct is absent');
  });

  // ── Reconcile guard (already fixed in a7cd39e) ──────────────────
  it('reconcileValidateOverride keeps screen signal when validate returns insufficient + exec quality noise drift', () => {
    // This tests the a7cd39e fix: screen says supportive_clean, validate says
    // insufficient, consensusDrift=true (from exec quality change, not real drift).
    const result = reconcileValidateOverride({
      screenExec: 'playable',
      screenDisposition: 'supportive_clean',
      validateExec: 'best',
      validateDisposition: 'insufficient',
      consensusDrift: true
    });
    assert.equal(
      result.movementDisposition,
      'supportive_clean',
      'Should keep screen signal even when consensusDrift is exec-quality noise'
    );
    assert.equal(result.overridden, true, 'Should report that the screen signal was kept');
  });

  it('reconcileValidateOverride passes through insufficient when screen is also insufficient', () => {
    // When both screen and validate are insufficient, no override needed.
    const result = reconcileValidateOverride({
      screenExec: 'unknown',
      screenDisposition: 'insufficient',
      validateExec: 'unknown',
      validateDisposition: 'insufficient',
      consensusDrift: false
    });
    assert.equal(result.movementDisposition, 'insufficient', 'Should pass through when both sides are insufficient');
    assert.equal(result.overridden, false);
  });
});
