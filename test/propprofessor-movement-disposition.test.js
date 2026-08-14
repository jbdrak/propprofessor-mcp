'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeMovementDisposition, computeMovementSummary } = require('../lib/propprofessor-movement-disposition');

describe('computeMovementDisposition', () => {
  it('returns supportive_clean for green grade + supportive label', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'green',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive',
        peakAdverseClvPct: 0.5
      }),
      'supportive_clean'
    );
  });

  it('downgrades a stale supportive quote to insufficient (last point > 10 min old)', () => {
    // Regression: 2026-08-14 Broncos ML -178 was quoted supportive_clean from
    // a 17-min-old history point while the live market had moved to -163/-160.
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'green',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive',
        peakAdverseClvPct: 0.5,
        lastPointAgeMs: 17 * 60 * 1000
      }),
      'insufficient'
    );
  });

  it('keeps a fresh supportive quote clean (last point under 10 min old)', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'green',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive',
        peakAdverseClvPct: 0.5,
        lastPointAgeMs: 3 * 60 * 1000
      }),
      'supportive_clean'
    );
  });

  it('keeps adverse on a stale quote (adverse is a pass either way)', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'red',
        movementLabel: 'adverse',
        recentSharpMoveDirection: 'adverse',
        fullWindowSharpMoveDirection: 'adverse',
        lastPointAgeMs: 30 * 60 * 1000
      }),
      'adverse_full'
    );
  });

  it('returns supportive_bouncy for green grade + V-shaped recovery', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'green',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive',
        peakAdverseClvPct: -3.2
      }),
      'supportive_bouncy'
    );
  });

  it('returns adverse_recent when recentSharpMoveDirection is adverse', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'adverse',
        fullWindowSharpMoveDirection: 'supportive'
      }),
      'adverse_recent'
    );
  });

  it('returns adverse_full for red grade', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'red',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'adverse',
        fullWindowSharpMoveDirection: 'adverse'
      }),
      'adverse_full'
    );
  });

  it('returns insufficient when no history available', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'insufficient_history',
        recentSharpMoveDirection: 'insufficient_history',
        fullWindowSharpMoveDirection: 'insufficient_history'
      }),
      'insufficient'
    );
  });

  it('returns supportive_bouncy for yellow grade + supportive', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive'
      }),
      'supportive_bouncy'
    );
  });

  it('returns adverse_recent for mixed label + adverse recent', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'mixed',
        recentSharpMoveDirection: 'adverse',
        fullWindowSharpMoveDirection: 'supportive'
      }),
      'adverse_recent'
    );
  });

  it('returns supportive_bouncy for mixed label + supportive recent', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'mixed',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive'
      }),
      'supportive_bouncy'
    );
  });

  it('returns adverse_full for adverse label', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'red',
        movementLabel: 'adverse',
        recentSharpMoveDirection: 'adverse',
        fullWindowSharpMoveDirection: 'adverse'
      }),
      'adverse_full'
    );
  });

  it('returns supportive_bouncy for recent_supportive_only + yellow grade', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'recent_supportive_only',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive'
      }),
      'supportive_bouncy'
    );
  });

  it('returns supportive_clean for recent_supportive_only + green grade', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'green',
        movementLabel: 'recent_supportive_only',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive'
      }),
      'supportive_clean'
    );
  });

  it('returns insufficient when only fullDir insufficient but recent is ok', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'insufficient_history',
        recentSharpMoveDirection: 'insufficient_history',
        fullWindowSharpMoveDirection: 'insufficient_history'
      }),
      'insufficient'
    );
  });

  it('returns insufficient for null/undefined row', () => {
    assert.equal(computeMovementDisposition(null), 'insufficient');
    assert.equal(computeMovementDisposition(undefined), 'insufficient');
    assert.equal(computeMovementDisposition({}), 'insufficient');
  });

  it('upgrades insufficient_history to supportive_bouncy when sharp money confirmed', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'insufficient_history',
        recentSharpMoveDirection: 'insufficient_history',
        fullWindowSharpMoveDirection: 'insufficient_history',
        sharpBookMovementConfirmed: true,
        sharpBookMovementSource: 'Pinnacle'
      }),
      'supportive_bouncy'
    );
  });

  it('still returns insufficient when not sharp-confirmed (no regression)', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'insufficient_history',
        recentSharpMoveDirection: 'insufficient_history',
        fullWindowSharpMoveDirection: 'insufficient_history',
        sharpBookMovementConfirmed: false
      }),
      'insufficient'
    );
  });

  it('upgrades mixed-with-no-recent-direction to supportive_bouncy when sharp confirmed', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'mixed',
        recentSharpMoveDirection: 'insufficient_history',
        fullWindowSharpMoveDirection: 'insufficient_history',
        sharpBookMovementConfirmed: true
      }),
      'supportive_bouncy'
    );
  });

  it('upgrades both-windows-mixed to supportive_bouncy when sharp confirmed (production shape)', () => {
    // Production tennis rows report recentDir AND fullDir both 'mixed'
    // (not 'insufficient_history'). The mixed branch must still honor
    // sharpBookMovementConfirmed via the shared insufficient() helper.
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'mixed',
        recentSharpMoveDirection: 'mixed',
        fullWindowSharpMoveDirection: 'mixed',
        sharpBookMovementConfirmed: true,
        sharpBookMovementSource: 'Pinnacle'
      }),
      'supportive_bouncy'
    );
  });

  it('keeps both-windows-mixed as insufficient when not sharp-confirmed', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'mixed',
        recentSharpMoveDirection: 'mixed',
        fullWindowSharpMoveDirection: 'mixed',
        sharpBookMovementConfirmed: false
      }),
      'insufficient'
    );
  });

  it('does NOT override adverse_recent even when sharp confirmed', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'adverse',
        fullWindowSharpMoveDirection: 'supportive',
        sharpBookMovementConfirmed: true
      }),
      'adverse_recent'
    );
  });
});

describe('computeMovementSummary', () => {
  const supportiveRow = (consensusEdge) => ({
    movementGrade: 'green',
    movementLabel: 'supportive',
    recentSharpMoveDirection: 'supportive',
    fullWindowSharpMoveDirection: 'supportive',
    consensusEdge
  });

  // consensusEdge is ALREADY percentage points (screen-row-expander computes
  // (consensusProb - preferredProb) * 100). Rendering it as edge*100 produces
  // a 100x display bug (2.5 -> '250.0% edge').
  it('renders consensusEdge 2.5 as 2.5% edge (not 250.0%)', () => {
    const summary = computeMovementSummary(supportiveRow(2.5), {
      movementDisposition: 'supportive_clean',
      selection: 'Under 166.5'
    });
    assert.ok(summary.includes('2.5% edge'), `summary was: ${summary}`);
    assert.ok(!summary.includes('250.0%'), `summary was: ${summary}`);
  });

  it('renders consensusEdge 11.5 as 11.5% edge (not 1150.0%)', () => {
    const summary = computeMovementSummary(supportiveRow(11.5), {
      movementDisposition: 'supportive_clean',
      selection: 'Under 166.5'
    });
    assert.ok(summary.includes('11.5% edge'), `summary was: ${summary}`);
    assert.ok(!summary.includes('1150.0%'), `summary was: ${summary}`);
  });

  it('omits edge text when consensusEdge is null/undefined', () => {
    for (const edge of [null, undefined]) {
      const summary = computeMovementSummary(supportiveRow(edge), {
        movementDisposition: 'supportive_clean',
        selection: 'Under 166.5'
      });
      assert.ok(summary, 'summary should be a string');
      assert.ok(!summary.includes('% edge'), `summary was: ${summary}`);
    }
  });

  it('preserves a real zero edge as 0.0% edge', () => {
    const summary = computeMovementSummary(supportiveRow(0), {
      movementDisposition: 'supportive_clean',
      selection: 'Under 166.5'
    });
    assert.ok(summary.includes('(0.0% edge)'), `summary was: ${summary}`);
  });
});
