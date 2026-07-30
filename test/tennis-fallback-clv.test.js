'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeClvFromHistory,
  deriveMovementFromClv,
  verdictFromDisposition,
  assignTierFromClv,
  isTennisAlternateLine,
  resolveOppositeSideConflicts
} = require('../lib/tennis-fallback');

describe('computeClvFromHistory', () => {
  it('returns null for empty array', () => {
    assert.equal(computeClvFromHistory([]), null);
  });

  it('returns null for single entry', () => {
    assert.equal(computeClvFromHistory([{ odds: 100, start_ts: 1 }]), null);
  });

  it('computes positive CLV when odds move toward selection (favorite gets cheaper)', () => {
    // -120 → -110: implied prob went from 54.5% → 52.4% = adverse for favorite
    // Wait, that's wrong. Let me think again.
    // -120 → -110: prob = 120/220=54.5% → 110/210=52.4% = probability DECREASED = adverse
    // Actually for the FAVORITE side, moving from -120 to -110 means the favorite
    // became LESS favored. If you bet the favorite, that's adverse.
    // But if you look at it from the selection's perspective:
    // selection at -120 (54.5% implied) moves to -110 (52.4% implied)
    // CLV = 52.4 - 54.5 = -2.1% → adverse for that selection
    const history = [
      { odds: -120, start_ts: 1 },
      { odds: -110, start_ts: 2 }
    ];
    const clv = computeClvFromHistory(history);
    assert.ok(clv < 0, `expected negative CLV (adverse), got ${clv}`);
  });

  it('computes negative CLV when underdog odds shorten', () => {
    // +150 → +130: prob = 100/250=40% → 100/230=43.5% = probability INCREASED = supportive
    const history = [
      { odds: 150, start_ts: 1 },
      { odds: 130, start_ts: 2 }
    ];
    const clv = computeClvFromHistory(history);
    assert.ok(clv > 0, `expected positive CLV (supportive), got ${clv}`);
  });

  it('computes CLV correctly: -133 → -129 (favorite weakens = adverse)', () => {
    const history = [
      { odds: -133, start_ts: 1 },
      { odds: -129, start_ts: 2 }
    ];
    const clv = computeClvFromHistory(history);
    // 133/233=57.08% → 129/229=56.33% = -0.75%
    assert.ok(Math.abs(clv - -0.75) < 0.1, `expected ~-0.75, got ${clv}`);
  });

  it('sorts by timestamp', () => {
    const history = [
      { odds: -110, start_ts: 2 },
      { odds: -120, start_ts: 1 }
    ];
    const clv = computeClvFromHistory(history);
    // -120 → -110: 120/220=54.5% → 110/210=52.4% = -2.1%
    assert.ok(clv < 0, `expected negative CLV, got ${clv}`);
  });
});

describe('deriveMovementFromClv', () => {
  it('returns supportive_clean for CLV > 2', () => {
    assert.equal(deriveMovementFromClv(3), 'supportive_clean');
  });

  it('returns supportive_bouncy for CLV 0-2', () => {
    assert.equal(deriveMovementFromClv(1), 'supportive_bouncy');
  });

  it('returns adverse_full for CLV < -2', () => {
    assert.equal(deriveMovementFromClv(-3), 'adverse_full');
  });

  it('returns adverse_recent for CLV -2 to 0', () => {
    assert.equal(deriveMovementFromClv(-1), 'adverse_recent');
  });

  it('returns insufficient for null', () => {
    assert.equal(deriveMovementFromClv(null), 'insufficient');
  });

  it('returns insufficient for exactly 0', () => {
    assert.equal(deriveMovementFromClv(0), 'insufficient');
  });
});

describe('verdictFromDisposition', () => {
  it('returns BET for supportive_clean', () => {
    assert.equal(verdictFromDisposition('supportive_clean'), 'BET');
  });

  it('returns BET for supportive_bouncy', () => {
    assert.equal(verdictFromDisposition('supportive_bouncy'), 'BET');
  });

  it('returns CONSIDER for adverse_full', () => {
    assert.equal(verdictFromDisposition('adverse_full'), 'CONSIDER');
  });

  it('returns CONSIDER for adverse_recent', () => {
    assert.equal(verdictFromDisposition('adverse_recent'), 'CONSIDER');
  });

  it('returns CONSIDER for insufficient', () => {
    assert.equal(verdictFromDisposition('insufficient'), 'CONSIDER');
  });
});

describe('assignTierFromClv', () => {
  it('returns TIER 1 for high CLV', () => {
    assert.equal(assignTierFromClv(3, 1), 'TIER 1');
  });

  it('returns TIER 1 for medium CLV', () => {
    assert.equal(assignTierFromClv(2, 1), 'TIER 1');
  });

  it('returns TIER 2 for low CLV', () => {
    assert.equal(assignTierFromClv(0.5, 1), 'TIER 2');
  });

  it('returns TIER 2 for null CLV', () => {
    assert.equal(assignTierFromClv(null, 1), 'TIER 2');
  });
});

describe('isTennisAlternateLine', () => {
  // Moneyline is always standard
  it('returns false for Moneyline regardless of selection text', () => {
    assert.equal(isTennisAlternateLine('Moneyline', 'Djokovic'), false);
  });

  it('returns false for Moneyline with empty selection', () => {
    assert.equal(isTennisAlternateLine('Moneyline', ''), false);
  });

  // Total Games is always standard
  it('returns false for Total Games regardless of line number', () => {
    assert.equal(isTennisAlternateLine('Total Games', 'Over 22.5'), false);
  });

  // Game Handicap
  it('returns false for standard Game Handicap ±1.5', () => {
    assert.equal(isTennisAlternateLine('Game Handicap', 'Djokovic -1.5'), false);
  });

  it('returns false for standard Game Handicap +1.5', () => {
    assert.equal(isTennisAlternateLine('Game Handicap', 'Alcaraz +1.5'), false);
  });

  it('returns false for Game Handicap ±2.5 (also standard)', () => {
    assert.equal(isTennisAlternateLine('Game Handicap', 'Djokovic -2.5'), false);
    assert.equal(isTennisAlternateLine('Game Handicap', 'Alcaraz +2.5'), false);
  });

  it('returns true for expanded Game Handicap +3.5 (alternate)', () => {
    assert.equal(isTennisAlternateLine('Game Handicap', 'Djokovic +3.5'), true);
  });

  it('returns true for expanded Game Handicap -4.5 (alternate)', () => {
    assert.equal(isTennisAlternateLine('Game Handicap', 'Alcaraz -4.5'), true);
  });

  it('returns true for expanded Game Handicap +6.5 (alternate)', () => {
    assert.equal(isTennisAlternateLine('Game Handicap', 'Djokovic +6.5'), true);
  });

  it('returns false for Game Handicap with no numeric line (keep by default)', () => {
    assert.equal(isTennisAlternateLine('Game Handicap', 'Djokovic'), false);
  });

  // Unknown market type
  it('returns false for unknown market type', () => {
    assert.equal(isTennisAlternateLine('Player Props', 'Djokovic Ace Count'), false);
  });
});

describe('resolveOppositeSideConflicts', () => {
  it('passes through non-array input', () => {
    assert.deepEqual(resolveOppositeSideConflicts(null), null);
    assert.deepEqual(resolveOppositeSideConflicts(undefined), undefined);
  });

  it('leaves single BET unchanged', () => {
    const plays = [
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_clean',
        clvProxyPct: 3,
        selection: 'Djokovic'
      }
    ];
    resolveOppositeSideConflicts(plays);
    assert.equal(plays.length, 1);
    assert.equal(plays[0].verdict, 'BET');
  });

  it('downgrades second BET when opposite sides conflict', () => {
    const plays = [
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_clean',
        clvProxyPct: 3,
        selection: 'Djokovic'
      },
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_bouncy',
        clvProxyPct: -3,
        selection: 'Alcaraz'
      }
    ];
    resolveOppositeSideConflicts(plays);
    const bet = plays.filter((p) => p.verdict === 'BET');
    assert.equal(bet.length, 1, 'only one BET should remain');
    assert.equal(bet[0].selection, 'Djokovic', 'clean movement should win');
    const consider = plays.find((p) => p.verdict === 'CONSIDER');
    assert.ok(consider.conflictResolved, 'loser should be flagged');
    assert.ok(consider.conflictNote, 'loser should have a conflict note');
  });

  it('does not interfere with different gameIds', () => {
    const plays = [
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_clean',
        clvProxyPct: 3,
        selection: 'Djokovic'
      },
      {
        gameId: 'g2',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_clean',
        clvProxyPct: 2.5,
        selection: 'Swiatek'
      }
    ];
    resolveOppositeSideConflicts(plays);
    assert.equal(plays.filter((p) => p.verdict === 'BET').length, 2);
  });

  it('does not interfere with different markets', () => {
    const plays = [
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_clean',
        clvProxyPct: 3,
        selection: 'Djokovic'
      },
      {
        gameId: 'g1',
        market: 'Game Handicap',
        verdict: 'BET',
        movementDisposition: 'supportive_clean',
        clvProxyPct: 2.5,
        selection: 'Djokovic -1.5'
      }
    ];
    resolveOppositeSideConflicts(plays);
    assert.equal(plays.filter((p) => p.verdict === 'BET').length, 2);
  });

  it('ignores CONSIDER plays when counting conflicts', () => {
    const plays = [
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_clean',
        clvProxyPct: 3,
        selection: 'Djokovic'
      },
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'CONSIDER',
        movementDisposition: 'adverse_recent',
        clvProxyPct: -1,
        selection: 'Alcaraz'
      }
    ];
    resolveOppositeSideConflicts(plays);
    assert.equal(plays.filter((p) => p.verdict === 'BET').length, 1);
    assert.equal(plays[0].verdict, 'BET');
  });

  it('prefers supportive_clean over supportive_bouncy', () => {
    const plays = [
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_bouncy',
        clvProxyPct: 5,
        selection: 'Djokovic'
      },
      {
        gameId: 'g1',
        market: 'Moneyline',
        verdict: 'BET',
        movementDisposition: 'supportive_clean',
        clvProxyPct: 3,
        selection: 'Alcaraz'
      }
    ];
    resolveOppositeSideConflicts(plays);
    const bet = plays.find((p) => p.verdict === 'BET');
    assert.equal(bet.selection, 'Alcaraz', 'clean should win over bouncy even with lower CLV');
  });
});
