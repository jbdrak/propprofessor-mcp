'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const evaluation = require('../lib/record-evaluation');

// Wave B2: derived evaluation from the settled v2 ledger.
// Pure CommonJS — no IO, no network, no clock. All fixtures are synthetic.

function makeLedger(overrides = {}) {
  return {
    version: 2,
    scans: [],
    candidates: [],
    bets: [],
    settlements: [],
    ...overrides
  };
}

function makeBet(id, overrides = {}) {
  return {
    id,
    candidateId: `cand-${id}`,
    gameId: `game-${id}`,
    league: 'MLB',
    market: 'Moneyline',
    selection: 'Yankees',
    oddsAtDecision: -120,
    stake: 50,
    status: 'pending',
    featureSnapshot: {
      schemaVersion: 1,
      capturedAt: '2026-08-05T16:00:00.000Z',
      signalTier: 'TIER 1',
      confidenceTier: 'TIER 1',
      signalQualityScore: 87,
      movementGrade: 'green',
      marketFairProbability: 0.55,
      modelWinProbability: 0.62,
      modelMarketEdgePct: 7.2,
      tennis: null
    },
    ...overrides
  };
}

function makeSettlement(betId, status, settledAt, overrides = {}) {
  return {
    betId,
    candidateId: `cand-${betId}`,
    league: 'MLB',
    market: 'Moneyline',
    selection: 'Yankees',
    odds: -120,
    stake: 50,
    status,
    outcome: status,
    result: status,
    isSettled: true,
    settledAt,
    sourceUrl: 'https://site.api.espn.com/example',
    ...overrides
  };
}

describe('joinSettledBets', () => {
  it('joins each settled bet with its settlement row (1:1)', () => {
    const ledger = makeLedger({
      bets: [makeBet('b1'), makeBet('b2')],
      settlements: [
        makeSettlement('b1', 'win', '2026-08-06T01:00:00.000Z'),
        makeSettlement('b2', 'loss', '2026-08-06T02:00:00.000Z')
      ]
    });
    const rows = evaluation.joinSettledBets(ledger);
    assert.equal(rows.length, 2);
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    assert.equal(byId.b1.settlement.status, 'win');
    assert.equal(byId.b1.outcome, 'win');
    assert.equal(byId.b1.settlement.settledAt, '2026-08-06T01:00:00.000Z');
    assert.equal(byId.b2.outcome, 'loss');
  });

  it('keeps the settlement with the latest settledAt when a betId has several', () => {
    const ledger = makeLedger({
      bets: [makeBet('b1')],
      settlements: [
        makeSettlement('b1', 'loss', '2026-08-06T01:00:00.000Z'),
        makeSettlement('b1', 'win', '2026-08-06T03:00:00.000Z'),
        makeSettlement('b1', 'push', '2026-08-06T02:00:00.000Z')
      ]
    });
    const rows = evaluation.joinSettledBets(ledger);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'win');
    assert.equal(rows[0].settlement.settledAt, '2026-08-06T03:00:00.000Z');
  });

  it('resolves equal settledAt ties to the last settlement encountered in array order', () => {
    const ledger = makeLedger({
      bets: [makeBet('b1')],
      settlements: [
        makeSettlement('b1', 'loss', '2026-08-06T01:00:00.000Z'),
        makeSettlement('b1', 'win', '2026-08-06T01:00:00.000Z')
      ]
    });
    const rows = evaluation.joinSettledBets(ledger);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'win');
  });

  it('ignores pending and retirement settlements entirely', () => {
    const ledger = makeLedger({
      bets: [makeBet('b1'), makeBet('b2'), makeBet('b3')],
      settlements: [
        makeSettlement('b1', 'retirement', '2026-08-06T01:00:00.000Z', { isSettled: false }),
        makeSettlement('b2', 'pending', '2026-08-06T02:00:00.000Z', { isSettled: false }),
        makeSettlement('b3', 'win', '2026-08-06T03:00:00.000Z')
      ]
    });
    const rows = evaluation.joinSettledBets(ledger);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'b3');
  });

  it('treats a later pending settlement as ignored, not as a blocker for an earlier settled one', () => {
    const ledger = makeLedger({
      bets: [makeBet('b1')],
      settlements: [
        makeSettlement('b1', 'loss', '2026-08-06T01:00:00.000Z'),
        makeSettlement('b1', 'pending', '2026-08-07T01:00:00.000Z', { isSettled: false })
      ]
    });
    const rows = evaluation.joinSettledBets(ledger);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'loss');
  });

  it('normalizes won/lost aliases to win/loss', () => {
    const ledger = makeLedger({
      bets: [makeBet('b1'), makeBet('b2')],
      settlements: [
        makeSettlement('b1', 'won', '2026-08-06T01:00:00.000Z'),
        makeSettlement('b2', 'lost', '2026-08-06T01:00:00.000Z')
      ]
    });
    const rows = evaluation.joinSettledBets(ledger);
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    assert.equal(byId.b1.outcome, 'win');
    assert.equal(byId.b1.settlement.status, 'win');
    assert.equal(byId.b2.outcome, 'loss');
  });

  it('drops bets that have no settled settlement and drops orphan settlement rows with no bet', () => {
    const ledger = makeLedger({
      bets: [makeBet('b1'), makeBet('b2')],
      settlements: [
        makeSettlement('b1', 'win', '2026-08-06T01:00:00.000Z'),
        makeSettlement('orphan', 'win', '2026-08-06T01:00:00.000Z')
      ]
    });
    const rows = evaluation.joinSettledBets(ledger);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'b1');
  });

  it('deep clones: mutating output never mutates the ledger and vice versa', () => {
    const ledger = makeLedger({
      bets: [makeBet('b1')],
      settlements: [makeSettlement('b1', 'win', '2026-08-06T01:00:00.000Z')]
    });
    const rows = evaluation.joinSettledBets(ledger);
    rows[0].settlement.status = 'loss';
    rows[0].featureSnapshot.signalTier = 'MUTATED';
    assert.equal(ledger.settlements[0].status, 'win');
    assert.equal(ledger.bets[0].featureSnapshot.signalTier, 'TIER 1');

    ledger.bets[0].stake = 999;
    const again = evaluation.joinSettledBets(ledger);
    assert.equal(again[0].stake, 999);
    assert.equal(rows[0].stake, 50);
  });

  it('returns [] for empty or missing collections and for null input', () => {
    assert.deepEqual(evaluation.joinSettledBets(makeLedger()), []);
    assert.deepEqual(evaluation.joinSettledBets({}), []);
    assert.deepEqual(evaluation.joinSettledBets(null), []);
    assert.deepEqual(evaluation.joinSettledBets(undefined), []);
  });
});

describe('deriveCalibration', () => {
  it('keys by signalTier:movementGrade:league:market and counts wins/losses/pushes', () => {
    const ledger = makeLedger({
      bets: [makeBet('b1'), makeBet('b2'), makeBet('b3'), makeBet('b4'), makeBet('b5')],
      settlements: [
        makeSettlement('b1', 'win', '2026-08-06T01:00:00.000Z'),
        makeSettlement('b2', 'win', '2026-08-06T01:00:00.000Z'),
        makeSettlement('b3', 'loss', '2026-08-06T01:00:00.000Z'),
        makeSettlement('b4', 'push', '2026-08-06T01:00:00.000Z'),
        makeSettlement('b5', 'win', '2026-08-06T01:00:00.000Z')
      ]
    });
    const calibration = evaluation.deriveCalibration(ledger, { minSample: 1 });
    const key = 'TIER 1:green:MLB:Moneyline';
    assert.deepEqual(calibration[key].wins, 3);
    assert.deepEqual(calibration[key].losses, 1);
    assert.deepEqual(calibration[key].pushes, 1);
    assert.deepEqual(calibration[key].sampleSize, 5);
    assert.deepEqual(calibration[key].totalDecided, 4);
  });

  it('hitRate is wins over decided bets (pushes excluded from the denominator) and null when no decided bets', () => {
    const won = makeLedger({
      bets: [makeBet('b1'), makeBet('b2'), makeBet('b3'), makeBet('b4')],
      settlements: [
        makeSettlement('b1', 'win', '2026-08-06T01:00:00.000Z'),
        makeSettlement('b2', 'win', '2026-08-06T01:00:00.000Z'),
        makeSettlement('b3', 'loss', '2026-08-06T01:00:00.000Z'),
        makeSettlement('b4', 'push', '2026-08-06T01:00:00.000Z')
      ]
    });
    const calibration = evaluation.deriveCalibration(won, { minSample: 1 });
    assert.ok(Math.abs(calibration['TIER 1:green:MLB:Moneyline'].hitRate - 2 / 3) < 1e-9);

    const allPushes = makeLedger({
      bets: [makeBet('b1'), makeBet('b2')],
      settlements: [
        makeSettlement('b1', 'push', '2026-08-06T01:00:00.000Z'),
        makeSettlement('b2', 'push', '2026-08-06T01:00:00.000Z')
      ]
    });
    const pushOnly = evaluation.deriveCalibration(allPushes, { minSample: 1 });
    assert.equal(pushOnly['TIER 1:green:MLB:Moneyline'].hitRate, null);
  });

  it('reads signalTier and movementGrade from featureSnapshot first, top-level legacy fields as fallback', () => {
    const snapshotted = makeLedger({
      bets: [makeBet('b1')],
      settlements: [makeSettlement('b1', 'win', '2026-08-06T01:00:00.000Z')]
    });
    const fromSnapshot = evaluation.deriveCalibration(snapshotted, { minSample: 1 });
    assert.ok(fromSnapshot['TIER 1:green:MLB:Moneyline']);

    const legacy = makeLedger({
      bets: [
        makeBet('b1', {
          featureSnapshot: null,
          signalTier: 'TIER 2',
          confidenceTier: 'TIER 2',
          movementGrade: 'yellow'
        })
      ],
      settlements: [makeSettlement('b1', 'win', '2026-08-06T01:00:00.000Z')]
    });
    const fromLegacy = evaluation.deriveCalibration(legacy, { minSample: 1 });
    assert.ok(fromLegacy['TIER 2:yellow:MLB:Moneyline']);
  });

  it('marks insufficientSample when decided outcomes are below minSample', () => {
    const small = makeLedger({
      bets: [makeBet('b1')],
      settlements: [makeSettlement('b1', 'win', '2026-08-06T01:00:00.000Z')]
    });
    const calibration = evaluation.deriveCalibration(small); // default minSample 30
    const key = 'TIER 1:green:MLB:Moneyline';
    assert.equal(calibration[key].sampleSize, 1);
    assert.equal(calibration[key].totalDecided, 1);
    assert.equal(calibration[key].insufficientSample, true);

    const enough = evaluation.deriveCalibration(small, { minSample: 1 });
    assert.equal(enough[key].insufficientSample, false);
  });

  it('insufficientSample uses the totalDecided floor, not the sampleSize floor', () => {
    const key = 'TIER 1:green:MLB:Moneyline';
    const settledAt = (i) => `2026-08-06T00:00:${String(i).padStart(2, '0')}.000Z`;
    const wins = (count) =>
      Array.from({ length: count }, (_, i) => [makeBet(`b${i + 1}`), makeSettlement(`b${i + 1}`, 'win', settledAt(i))]);

    // 30 pushes, 0 decided: sampleSize reaches minSample but no decided
    // outcome does — still insufficient.
    const pushesOnly = makeLedger({
      bets: Array.from({ length: 30 }, (_, i) => makeBet(`p${i + 1}`)),
      settlements: Array.from({ length: 30 }, (_, i) => makeSettlement(`p${i + 1}`, 'push', settledAt(i)))
    });
    const fromPushes = evaluation.deriveCalibration(pushesOnly); // default minSample 30
    assert.equal(fromPushes[key].sampleSize, 30);
    assert.equal(fromPushes[key].totalDecided, 0);
    assert.equal(fromPushes[key].insufficientSample, true);

    // 29 wins + 1 push: sampleSize 30 clears the floor, totalDecided 29 does not.
    const twentyNineWins = makeLedger({
      bets: [...wins(29).map(([bet]) => bet), makeBet('z30')],
      settlements: [...wins(29).map(([, settlement]) => settlement), makeSettlement('z30', 'push', settledAt(30))]
    });
    const fromTwentyNine = evaluation.deriveCalibration(twentyNineWins);
    assert.equal(fromTwentyNine[key].sampleSize, 30);
    assert.equal(fromTwentyNine[key].totalDecided, 29);
    assert.equal(fromTwentyNine[key].insufficientSample, true);

    // 30 decided outcomes plus pushes: totalDecided clears the floor.
    const thirtyDecided = makeLedger({
      bets: [...wins(30).map(([bet]) => bet), makeBet('z31')],
      settlements: [...wins(30).map(([, settlement]) => settlement), makeSettlement('z31', 'push', settledAt(31))]
    });
    const fromThirty = evaluation.deriveCalibration(thirtyDecided);
    assert.equal(fromThirty[key].sampleSize, 31);
    assert.equal(fromThirty[key].totalDecided, 30);
    assert.equal(fromThirty[key].insufficientSample, false);
  });

  it('validates minSample: must be a positive integer', () => {
    const ledger = makeLedger();
    for (const bad of [0, -1, 1.5, NaN, '10', null, true]) {
      assert.throws(() => evaluation.deriveCalibration(ledger, { minSample: bad }), /positive integer/);
    }
    // Absent/undefined falls back to the documented default of 30.
    assert.doesNotThrow(() => evaluation.deriveCalibration(ledger, {}));
    assert.doesNotThrow(() => evaluation.deriveCalibration(ledger));
  });

  it('returns {} for empty or missing collections and for null input', () => {
    assert.deepEqual(evaluation.deriveCalibration(makeLedger(), { minSample: 1 }), {});
    assert.deepEqual(evaluation.deriveCalibration({}, { minSample: 1 }), {});
    assert.deepEqual(evaluation.deriveCalibration(null, { minSample: 1 }), {});
  });
});

describe('buildEvaluationRows', () => {
  it('projects the full evaluation row with decision-time snapshot fields', () => {
    const ledger = makeLedger({
      bets: [makeBet('b1')],
      settlements: [makeSettlement('b1', 'win', '2026-08-06T01:00:00.000Z')]
    });
    const rows = evaluation.buildEvaluationRows(ledger);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      betId: 'b1',
      league: 'MLB',
      market: 'Moneyline',
      selection: 'Yankees',
      odds: -120,
      stake: 50,
      outcome: 'win',
      capturedAt: '2026-08-05T16:00:00.000Z',
      settledAt: '2026-08-06T01:00:00.000Z',
      signalTier: 'TIER 1',
      confidenceTier: 'TIER 1',
      signalQualityScore: 87,
      marketFairProbability: 0.55,
      modelWinProbability: 0.62,
      modelMarketEdgePct: 7.2
    });
  });

  it('falls back to top-level legacy fields and nulls unavailable fields without deriving', () => {
    const ledger = makeLedger({
      bets: [
        makeBet('b1', {
          featureSnapshot: null,
          signalTier: 'TIER 3',
          confidenceTier: 'TIER 3'
        })
      ],
      settlements: [makeSettlement('b1', 'loss', '2026-08-06T01:00:00.000Z')]
    });
    const rows = evaluation.buildEvaluationRows(ledger);
    assert.equal(rows[0].signalTier, 'TIER 3');
    assert.equal(rows[0].confidenceTier, 'TIER 3');
    assert.equal(rows[0].signalQualityScore, null);
    assert.equal(rows[0].marketFairProbability, null);
    assert.equal(rows[0].modelWinProbability, null);
    assert.equal(rows[0].modelMarketEdgePct, null);
    assert.equal(rows[0].capturedAt, null);
  });

  it('does not derive probabilities: explicit-only fields stay null when the snapshot omits them', () => {
    const ledger = makeLedger({
      bets: [
        makeBet('b1', {
          featureSnapshot: {
            schemaVersion: 1,
            capturedAt: '2026-08-05T16:00:00.000Z',
            signalTier: 'TIER 1',
            confidenceTier: 'TIER 1',
            signalQualityScore: 50
          }
        })
      ],
      settlements: [makeSettlement('b1', 'push', '2026-08-06T01:00:00.000Z')]
    });
    const rows = evaluation.buildEvaluationRows(ledger);
    assert.equal(rows[0].marketFairProbability, null);
    assert.equal(rows[0].modelWinProbability, null);
    assert.equal(rows[0].modelMarketEdgePct, null);
    assert.equal(rows[0].outcome, 'push');
  });

  it('returns [] for empty or missing collections and for null input', () => {
    assert.deepEqual(evaluation.buildEvaluationRows(makeLedger()), []);
    assert.deepEqual(evaluation.buildEvaluationRows({}), []);
    assert.deepEqual(evaluation.buildEvaluationRows(null), []);
  });
});
