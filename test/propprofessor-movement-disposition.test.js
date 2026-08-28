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

  it('labels aged supportive movement evidence as stale when no current quote is present', () => {
    // Regression: an old movement trail must not be treated as a current
    // execution quote when the live quote is absent.
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'green',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive',
        peakAdverseClvPct: 0.5,
        lastPointAgeMs: 17 * 60 * 1000
      }),
      'stale'
    );
  });

  it('keeps movement direction when the current quote is present but history is aged', () => {
    assert.equal(
      computeMovementDisposition({
        odds: -144,
        currentOdds: -144,
        targetBookOdds: -144,
        liquidityUsd: 232,
        movementGrade: 'green',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive',
        clvProxyPct: 1.1,
        lastPointAgeMs: 72 * 60 * 1000
      }),
      'supportive_clean'
    );
  });

  it('keeps stale disposition when the current quote is absent', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'green',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive',
        clvProxyPct: 1.1,
        lastPointAgeMs: 72 * 60 * 1000
      }),
      'stale'
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

  it('labels stale adverse movement as stale instead of overstating it as adverse_full', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'red',
        movementLabel: 'adverse',
        recentSharpMoveDirection: 'adverse',
        fullWindowSharpMoveDirection: 'adverse',
        lastPointAgeMs: 30 * 60 * 1000
      }),
      'stale'
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

  it('does NOT stamp adverse_full for red grade when movement is supportive (execution-driven red)', () => {
    // Regression 2026-08-15 UFC 330: Makhachev was graded red because Onyx's
    // price (-360) was 60c off the best available (-300), so
    // gradeMovementQuality returned 'red' (bad execution). The disposition
    // short-circuited on grade==='red' and stamped adverse_full even though
    // movementLabel/directions were supportive and CLV was positive. A red
    // grade from execution quality is a playability failure, not a movement
    // signal — the row must grade on its movement fields instead.
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'red',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive',
        clvProxyPct: 0.27
      }),
      'supportive_bouncy'
    );
  });

  it('still returns adverse_full for red grade when movement data confirms adverse', () => {
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

  it('treats red grade + mixed movement as insufficient (execution red, no adverse signal)', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'red',
        movementLabel: 'mixed',
        recentSharpMoveDirection: 'mixed',
        fullWindowSharpMoveDirection: 'mixed',
        clvProxyPct: 0
      }),
      'insufficient'
    );
  });

  it('does not resurrect adverse_full for a red-grade supportive row with stale quote', () => {
    // Stale-quote gate still applies: a supportive disposition on an aged
    // quote downgrades to stale — never adverse_full.
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'red',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive',
        clvProxyPct: 0.27,
        lastPointAgeMs: 30 * 60 * 1000
      }),
      'stale'
    );
  });

  it('keeps a stale supportive quote when 5+ books + non-negative CLV corroborate (UFC 330)', () => {
    // Regression 2026-08-15: OnyxOdds stopped pushing Dern's price for 2.6h
    // while Kalshi/theScore/Caesars refreshed at 10-11 min. The movement
    // source book's quote is old, but the market is live and the supportive
    // read is independently confirmed — must NOT downgrade to insufficient.
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive',
        clvProxyPct: 0.69,
        consensusBookCount: 17,
        lastPointAgeMs: 155 * 60 * 1000
      }),
      'supportive_bouncy'
    );
  });

  it('still downgrades a stale supportive quote when CLV is negative (Broncos shape)', () => {
    // The original stale-quote bug: market moved adverse while the quote
    // aged. Negative CLV means the line moved against the play — the escape
    // must NOT apply.
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'green',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive',
        clvProxyPct: -2.4,
        consensusBookCount: 12,
        lastPointAgeMs: 17 * 60 * 1000
      }),
      'stale'
    );
  });

  it('still downgrades a stale supportive quote when consensus is thin (< 5 books)', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'green',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive',
        clvProxyPct: 1.1,
        consensusBookCount: 3,
        lastPointAgeMs: 20 * 60 * 1000
      }),
      'stale'
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

  it('labels sharp-originator confirmation distinctly from a follower confirmation', () => {
    const fromOriginator = computeMovementSummary(
      {
        ...supportiveRow(1.4),
        sharpBookMovementConfirmed: true,
        sharpBookMovementSource: 'Pinnacle'
      },
      { movementDisposition: 'supportive_bouncy', selection: 'Under 166.5' }
    );
    assert.ok(fromOriginator.includes('sharp-originator confirmation (Pinnacle)'), `summary was: ${fromOriginator}`);

    const fromFollower = computeMovementSummary(
      {
        ...supportiveRow(1.4),
        sharpBookMovementConfirmed: true,
        sharpBookMovementSource: 'DraftKings'
      },
      { movementDisposition: 'supportive_bouncy', selection: 'Under 166.5' }
    );
    assert.ok(fromFollower.includes('confirmed by DraftKings'), `summary was: ${fromFollower}`);
    assert.ok(!fromFollower.includes('sharp-originator'), `summary was: ${fromFollower}`);
  });

  it('surfaces the confirming book in the clean path, distinguishing originator vs follower', () => {
    const fromOriginator = computeMovementSummary(
      {
        ...supportiveRow(1.4),
        sharpBookMovementConfirmed: true,
        sharpBookMovementSource: 'Pinnacle'
      },
      { movementDisposition: 'supportive_clean', selection: 'Under 166.5' }
    );
    assert.ok(fromOriginator.includes('sharp-originator confirmation (Pinnacle)'), `summary was: ${fromOriginator}`);

    const fromFollower = computeMovementSummary(
      {
        ...supportiveRow(1.4),
        sharpBookMovementConfirmed: true,
        sharpBookMovementSource: 'DraftKings'
      },
      { movementDisposition: 'supportive_clean', selection: 'Under 166.5' }
    );
    assert.ok(fromFollower.includes('confirmed by DraftKings'), `summary was: ${fromFollower}`);
    assert.ok(!fromFollower.includes('sharp-originator'), `summary was: ${fromFollower}`);
  });

  it('labels an inferred originator move in the insufficient path', () => {
    const summary = computeMovementSummary(
      {
        movementGrade: 'yellow',
        movementLabel: 'mixed',
        recentSharpMoveDirection: 'insufficient_history',
        fullWindowSharpMoveDirection: 'insufficient_history',
        sharpBookMovementConfirmed: true,
        sharpBookMovementSource: 'Circa'
      },
      { movementDisposition: 'insufficient', selection: 'Under 166.5' }
    );
    assert.ok(summary.includes('sharp originator Circa'), `summary was: ${summary}`);
  });
});

describe('Phase 1 Task 2 — canonical movement-disposition regression fixtures', () => {
  it('single-book tennis history (clv > 0.5) => supportive_bouncy', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive',
        clvProxyPct: 1.2
      }),
      'supportive_bouncy'
    );
  });

  it('single-book tennis history (clv < -0.5) => adverse_full', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'adverse',
        recentSharpMoveDirection: '',
        fullWindowSharpMoveDirection: 'adverse',
        clvProxyPct: -1.2
      }),
      'adverse_full'
    );
  });

  it('single-book tennis history (flat clv) => insufficient', () => {
    assert.equal(computeMovementDisposition({}), 'insufficient');
  });

  it('sharp confirmation upgrades insufficient_history => supportive_bouncy', () => {
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

  it('strong consensus (>=5 books, clv >= 0) upgrades insufficient_history => supportive_bouncy', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'insufficient_history',
        recentSharpMoveDirection: 'insufficient_history',
        fullWindowSharpMoveDirection: 'insufficient_history',
        consensusBookCount: 6,
        clvProxyPct: 0.4
      }),
      'supportive_bouncy'
    );
  });

  it('adverse recent direction => adverse_recent', () => {
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

  it('adverse full-window => adverse_full', () => {
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'yellow',
        movementLabel: 'adverse',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'adverse'
      }),
      'adverse_full'
    );
  });

  it('insufficient history with no confirmation/consensus => insufficient', () => {
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
});
