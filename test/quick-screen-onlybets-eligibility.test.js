'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isCandidateEligibleForValidation } = require('../scripts/server/handlers/quick-screen');

/**
 * Regression: `--only-bets` (-B) used to silently return a strict SUBSET of the
 * real BETs.
 *
 * `isEligible` gated on `!onlyBets || candidate.kaiCall === 'BET'`. Validation
 * is what UPGRADES a candidate to BET, so requiring BET before validating made
 * the upgrade unreachable: any row that would have become a BET was never
 * validated, never earned the verdict, and was filtered out by the onlyBets
 * output filter. Live symptom (2026-09-11, reproducible): `scan ncaaf -b Fliff
 * -B` returned 0 plays where the same scan without -B returned 2; MLB returned
 * 7 instead of 11.
 *
 * The fix drops the BET gate from eligibility. These assertions fail if anyone
 * reintroduces it.
 */
describe('quick_screen validation eligibility', () => {
  it('keeps a candidate eligible regardless of its screen-time BET flag', () => {
    for (const kaiCall of ['BET', 'WATCH', 'PASS', 'CONSIDER', undefined]) {
      assert.equal(
        isCandidateEligibleForValidation({ gameId: 'G1', selection: 'Home', kaiCall }),
        true,
        `a row with kaiCall=${String(kaiCall)} must still be eligible for validation`
      );
    }
  });

  it('still rejects rows that cannot be validated', () => {
    assert.equal(isCandidateEligibleForValidation({ selection: 'Home' }), false, 'missing gameId');
    assert.equal(isCandidateEligibleForValidation({ gameId: 'G1' }), false, 'missing selection');
    assert.equal(
      isCandidateEligibleForValidation({ gameId: 'G1', selection: 'Home', altLineFiltered: true }),
      false,
      'alt-line filtered rows stay ineligible'
    );
    assert.equal(isCandidateEligibleForValidation(null), false, 'null candidate');
    assert.equal(isCandidateEligibleForValidation(undefined), false, 'undefined candidate');
  });
});
