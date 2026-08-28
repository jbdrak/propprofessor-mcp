'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapCandidateRow } = require('../lib/propprofessor-mcp-candidate-mapper');
const { computeMovementDisposition } = require('../lib/propprofessor-movement-disposition');

// Fixed fixture values (no live request).
// Current NoVig odds -144, side-specific liquidity 232, and an OLD movement
// trail (72 minutes). The point: a present current quote must survive an aged
// movement-history point, and the age we record is MOVEMENT-HISTORY age, not
// quote age.
const CURRENT_ODDS = -144;
const LIQUIDITY_USD = 232;
const AGED_MOVEMENT_HISTORY_MS = 72 * 60 * 1000;

describe('stale movement history must not corrupt the current quote', () => {
  it('preserves current quote fields on the candidate when movement history is aged', () => {
    const out = mapCandidateRow({
      gameId: 'NBA:PREMATCH:Lakers:Warriors:1783937400',
      market: 'Moneyline',
      selection: 'Lakers',
      // Aged movement-history point (72 min). NOT a quote age.
      lastPointAgeMs: AGED_MOVEMENT_HISTORY_MS,
      movementGrade: 'green',
      movementLabel: 'supportive',
      recentSharpMoveDirection: 'supportive',
      fullWindowSharpMoveDirection: 'supportive',
      consensusEdge: 1.5,
      // Present current quote + side-specific liquidity (from the on-demand /screen lookup).
      odds: CURRENT_ODDS,
      currentOdds: CURRENT_ODDS,
      targetBookOdds: CURRENT_ODDS,
      liquidityUsd: LIQUIDITY_USD
    });

    // Quote fields are preserved verbatim — never nulled, never substituted
    // with a comparison-book price, never dropped.
    assert.equal(out.odds, CURRENT_ODDS, 'odds must be preserved');
    assert.equal(out.liquidityUsd, LIQUIDITY_USD, 'side-specific liquidityUsd must be preserved');
  });

  it('exposes movement-history age under an explicit movementHistoryAgeMs alias (not quote age)', () => {
    const out = mapCandidateRow({
      gameId: 'NBA:PREMATCH:Lakers:Warriors:1783937400',
      market: 'Moneyline',
      selection: 'Lakers',
      lastPointAgeMs: AGED_MOVEMENT_HISTORY_MS,
      movementGrade: 'green',
      movementLabel: 'supportive',
      recentSharpMoveDirection: 'supportive',
      fullWindowSharpMoveDirection: 'supportive',
      odds: CURRENT_ODDS,
      currentOdds: CURRENT_ODDS,
      targetBookOdds: CURRENT_ODDS,
      liquidityUsd: LIQUIDITY_USD
    });

    // The age recorded is the age of the newest MOVEMENT-HISTORY point, not
    // the current quote. It must be available under a clearly-named alias so
    // consumers never mistake it for quote freshness.
    assert.equal(
      out.movementHistoryAgeMs,
      AGED_MOVEMENT_HISTORY_MS,
      'movementHistoryAgeMs alias must carry the movement-history age'
    );
  });

  it('keeps the movement disposition when a current quote is present but history is aged', () => {
    // A current quote is authoritative for execution. Aged movement history
    // may be flagged separately, but it must not collapse the movement read.
    const row = {
      movementGrade: 'green',
      movementLabel: 'supportive',
      recentSharpMoveDirection: 'supportive',
      fullWindowSharpMoveDirection: 'supportive',
      lastPointAgeMs: AGED_MOVEMENT_HISTORY_MS,
      // Present current quote — the disposition must NOT touch these.
      odds: CURRENT_ODDS,
      currentOdds: CURRENT_ODDS,
      targetBookOdds: CURRENT_ODDS,
      liquidityUsd: LIQUIDITY_USD
    };
    assert.equal(computeMovementDisposition(row), 'supportive_clean');
    // Disposition reads only movement fields; it must leave the quote intact.
    assert.equal(row.odds, CURRENT_ODDS);
    assert.equal(row.currentOdds, CURRENT_ODDS);
    assert.equal(row.targetBookOdds, CURRENT_ODDS);
    assert.equal(row.liquidityUsd, LIQUIDITY_USD);
  });

  it('does NOT mark a fresh quote stale just because the quote is present', () => {
    // A young movement-history point (< 10 min) with a clean supportive read
    // stays supportive_clean, proving the gate is about movement-history age,
    // never about whether a current quote exists.
    assert.equal(
      computeMovementDisposition({
        movementGrade: 'green',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive',
        lastPointAgeMs: 3 * 60 * 1000,
        odds: CURRENT_ODDS,
        currentOdds: CURRENT_ODDS,
        targetBookOdds: CURRENT_ODDS,
        liquidityUsd: LIQUIDITY_USD
      }),
      'supportive_clean'
    );
  });
});
