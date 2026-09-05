'use strict';

/**
 * Handler-level regression for quick_screen rejection diagnostics.
 *
 * Covers the rejection-reason path for screen-passed BETs that validation
 * downgrades: each rejected screened BET must carry a precise
 * validationFailureReason (lost line, insufficient/adverse movement, consensus
 * drift, validator error, or skipped budget), the original scan values
 * (book/side/line/odds) must survive as evidence, and no candidate may be
 * recorded twice (watch dedupe via gameId::selection::market + the
 * validationWatchRecorded guard).
 *
 * These are the rejection-diagnostic seams added in the reliability patch
 * (getValidationFailureReason, collectDowngradedWatchCandidates). They are
 * pure over their inputs, so this test drives them directly without a network.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getValidationFailureReason,
  collectDowngradedWatchCandidates
} = require('../scripts/server/handlers/quick-screen');

// A screen-passed BET candidate with honest original scan provenance.
function screenedBet(over = {}) {
  return {
    gameId: 'G1',
    selection: 'Over 8.5',
    market: 'Total Runs',
    book: 'Pinnacle',
    odds: -120,
    line: 8.5,
    kaiCall: 'BET',
    finalVerdict: 'BET',
    _screenWasBet: true,
    _screenVerdict: 'BET',
    ...over
  };
}

describe('getValidationFailureReason', () => {
  it('names a lost line (validate lookup_failed)', () => {
    assert.equal(
      getValidationFailureReason(screenedBet({ validatedUnverified: true })),
      'validated line disappeared or is no longer priced'
    );
  });

  it('names consensus drift with its reason', () => {
    assert.equal(
      getValidationFailureReason(screenedBet({ validatedConsensusDrift: true, validatedDriftReason: '5 books -> 1' })),
      'validated consensus drift: 5 books -> 1'
    );
  });

  it('names adverse movement disposition', () => {
    assert.equal(
      getValidationFailureReason(screenedBet({ validatedMovementDisposition: 'adverse_full' })),
      'validated movement became adverse'
    );
    assert.equal(
      getValidationFailureReason(screenedBet({ validatedMovementDisposition: 'adverse' })),
      'validated movement became adverse'
    );
  });

  it('names insufficient movement disposition', () => {
    assert.equal(
      getValidationFailureReason(screenedBet({ validatedMovementDisposition: 'insufficient' })),
      'validated movement was insufficient'
    );
  });

  it('names bad execution quality that was not reconciled back to screen', () => {
    assert.equal(
      getValidationFailureReason(screenedBet({ validatedExecQuality: 'bad', validatedReconcileOverridden: false })),
      'validated execution quality was bad'
    );
  });

  it('prefers an explicit validationFailureReason over derived reasons', () => {
    assert.equal(
      getValidationFailureReason(
        screenedBet({
          validationFailureReason: 'shared odds-history budget exhausted before validation',
          validatedUnverified: true
        })
      ),
      'shared odds-history budget exhausted before validation'
    );
  });

  it('falls back to the validator verdict label when downgraded by verdict', () => {
    assert.equal(
      getValidationFailureReason(screenedBet({ validatedVerdict: 'PASS', finalVerdict: 'PASS' })),
      'validator verdict: PASS'
    );
  });

  it('falls back to the final verdict label when only a downgraded final verdict is present', () => {
    assert.equal(getValidationFailureReason(screenedBet({ finalVerdict: 'CONSIDER' })), 'final verdict: CONSIDER');
  });
});

describe('collectDowngradedWatchCandidates', () => {
  it('records a downgraded BET with a precise reason and original scan evidence', () => {
    const lostLineBet = screenedBet({
      validatedUnverified: true,
      finalVerdict: 'CONSIDER'
    });
    const watchCandidates = collectDowngradedWatchCandidates(
      [{ league: 'MLB', market: 'Total Runs', candidates: [lostLineBet] }],
      []
    );

    assert.equal(watchCandidates.length, 1, 'one downgraded BET recorded as a watch candidate');
    const watch = watchCandidates[0];
    assert.equal(watch.validationFailureReason, 'validated line disappeared or is no longer priced');
    assert.equal(watch.originalVerdict, 'BET', 'original screen verdict preserved as evidence');
    assert.equal(watch.book, 'Pinnacle', 'original execution book preserved');
    assert.equal(watch.odds, -120, 'original odds preserved');
    assert.equal(watch.line, 8.5, 'original line preserved');
    assert.equal(watch.official, false, 'watch candidate is never official');
  });

  it('does not re-record a candidate already flagged validationWatchRecorded', () => {
    const alreadyRecorded = screenedBet({
      validatedUnverified: true,
      finalVerdict: 'CONSIDER',
      validationWatchRecorded: true
    });
    const watchCandidates = collectDowngradedWatchCandidates(
      [{ league: 'MLB', market: 'Total Runs', candidates: [alreadyRecorded] }],
      []
    );
    assert.equal(watchCandidates.length, 0, 'already-recorded candidate is not duplicated');
  });

  it('does not record a BET that survived validation (finalVerdict BET)', () => {
    const keptBet = screenedBet({ finalVerdict: 'BET' });
    const watchCandidates = collectDowngradedWatchCandidates(
      [{ league: 'MLB', market: 'Total Runs', candidates: [keptBet] }],
      []
    );
    assert.equal(watchCandidates.length, 0, 'official BETs are not demoted to watch');
  });

  it('skips a candidate that was already in the watch list (dedupe by identity)', () => {
    const betA = screenedBet({ validatedUnverified: true, finalVerdict: 'CONSIDER' });
    const betB = screenedBet({
      gameId: 'G1',
      selection: 'Over 8.5',
      market: 'Total Runs',
      validatedUnverified: true,
      finalVerdict: 'CONSIDER'
    });
    const preexistingWatch = [
      {
        ...betA,
        market: 'Total Runs',
        originalVerdict: 'BET',
        official: false,
        validationFailureReason: 'validated line disappeared or is no longer priced'
      }
    ];
    const watchCandidates = collectDowngradedWatchCandidates(
      [{ league: 'MLB', market: 'Total Runs', candidates: [betB] }],
      preexistingWatch
    );
    assert.equal(watchCandidates.length, 1, 'no duplicate watch entry for the same identity');
    assert.equal(watchCandidates[0], preexistingWatch[0], 'the pre-existing entry is preserved');
  });

  it('records distinct candidates on different selections (no false dedupe)', () => {
    const over = screenedBet({ selection: 'Over 8.5', validatedUnverified: true, finalVerdict: 'CONSIDER' });
    const under = screenedBet({
      selection: 'Under 8.5',
      validatedMovementDisposition: 'adverse_full',
      finalVerdict: 'CONSIDER'
    });
    const watchCandidates = collectDowngradedWatchCandidates(
      [{ league: 'MLB', market: 'Total Runs', candidates: [over, under] }],
      []
    );
    assert.equal(watchCandidates.length, 2, 'both distinct sides are recorded');
    const reasons = watchCandidates.map((c) => c.validationFailureReason).sort();
    assert.deepEqual(reasons, [
      'validated line disappeared or is no longer priced',
      'validated movement became adverse'
    ]);
  });

  it('records a validator-error BET (validationFailed + explicit reason)', () => {
    const errorBet = screenedBet({
      validationFailed: true,
      validationFailureReason: 'Validation timeout for G1:Over 8.5',
      finalVerdict: 'CONSIDER'
    });
    const watchCandidates = collectDowngradedWatchCandidates(
      [{ league: 'MLB', market: 'Total Runs', candidates: [errorBet] }],
      []
    );
    assert.equal(watchCandidates.length, 1);
    assert.equal(
      watchCandidates[0].validationFailureReason,
      'Validation timeout for G1:Over 8.5',
      'validator error reason preserved verbatim'
    );
  });

  it('skips a budget-skipped BET already recorded upstream (no double record)', () => {
    // Budget-skipped BETs are pushed to watchCandidates by onNotSelected
    // (with validationWatchRecorded=true) BEFORE collectDowngradedWatchCandidates
    // runs. The collector must skip them, not re-record a second entry.
    const skippedBet = screenedBet({
      validationSkipped: true,
      validationBudgetSkipped: true,
      validationWatchRecorded: true,
      finalVerdict: 'CONSIDER'
    });
    const preexistingWatch = [
      {
        ...skippedBet,
        market: 'Total Runs',
        originalVerdict: 'BET',
        official: false,
        validationFailureReason: 'validation not selected within validation budget'
      }
    ];
    const watchCandidates = collectDowngradedWatchCandidates(
      [{ league: 'MLB', market: 'Total Runs', candidates: [skippedBet] }],
      preexistingWatch
    );
    assert.equal(watchCandidates.length, 1, 'skipped BET is not double-recorded');
    assert.equal(watchCandidates[0], preexistingWatch[0], 'the upstream entry is preserved');
    assert.equal(watchCandidates[0].validationFailureReason, 'validation not selected within validation budget');
  });
});
