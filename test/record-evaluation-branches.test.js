'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  joinSettledBets,
  deriveCalibration,
  buildEvaluationRows,
  segmentEvaluationRows,
  validateDecisionTimeIntegrity,
  DEFAULT_MIN_SAMPLE
} = require('../lib/record-evaluation');

const bet = (id, extra = {}) => ({ id, league: 'NBA', market: 'Moneyline', ...extra });

describe('joinSettledBets', () => {
  it('returns [] for null/non-object ledger', () => {
    assert.deepEqual(joinSettledBets(null), []);
    assert.deepEqual(joinSettledBets('x'), []);
  });

  it('joins bets with a settled settlement (win/loss/push)', () => {
    const ledger = {
      bets: [bet('b1'), bet('b2')],
      settlements: [
        { betId: 'b1', status: 'won', settledAt: '2026-01-01' },
        { betId: 'b2', status: 'loss', settledAt: '2026-01-01' }
      ]
    };
    const rows = joinSettledBets(ledger);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].outcome, 'win');
    assert.equal(rows[1].outcome, 'loss');
    assert.equal(rows[0].settlement.status, 'win');
  });

  it('ignores pending/retirement settlements', () => {
    const ledger = {
      bets: [bet('b1')],
      settlements: [{ betId: 'b1', status: 'pending', settledAt: '2026-01-01' }]
    };
    assert.deepEqual(joinSettledBets(ledger), []);
  });

  it('ignores orphan settlements with no matching bet', () => {
    const ledger = {
      bets: [bet('b1')],
      settlements: [{ betId: 'zzz', status: 'win', settledAt: '2026-01-01' }]
    };
    assert.deepEqual(joinSettledBets(ledger), []);
  });

  it('ignores bets with no settled settlement', () => {
    const ledger = { bets: [bet('b1')], settlements: [] };
    assert.deepEqual(joinSettledBets(ledger), []);
  });

  it('picks the latest settledAt when multiple settlements exist', () => {
    const ledger = {
      bets: [bet('b1')],
      settlements: [
        { betId: 'b1', status: 'win', settledAt: '2026-01-01' },
        { betId: 'b1', status: 'loss', settledAt: '2026-02-01' }
      ]
    };
    const rows = joinSettledBets(ledger);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'loss', 'latest settledAt wins');
  });

  it('does not mutate the input ledger', () => {
    const ledger = {
      bets: [bet('b1')],
      settlements: [{ betId: 'b1', status: 'won', settledAt: '2026-01-01' }]
    };
    const before = JSON.stringify(ledger);
    joinSettledBets(ledger);
    assert.equal(JSON.stringify(ledger), before);
  });
});

describe('deriveCalibration', () => {
  it('throws on non-positive-integer minSample', () => {
    assert.throws(() => deriveCalibration({ bets: [], settlements: [] }, { minSample: -1 }), TypeError);
    assert.throws(() => deriveCalibration({ bets: [], settlements: [] }, { minSample: 0 }), TypeError);
    assert.throws(() => deriveCalibration({ bets: [], settlements: [] }, { minSample: 1.5 }), TypeError);
  });

  it('uses default minSample when undefined', () => {
    assert.equal(DEFAULT_MIN_SAMPLE, 30);
    const cal = deriveCalibration({ bets: [], settlements: [] });
    assert.deepEqual(cal, {});
  });

  it('buckets wins/losses/pushes and computes hitRate excluding pushes', () => {
    const ledger = {
      bets: [
        bet('b1', { featureSnapshot: { signalTier: 'TIER 1', movementGrade: 'g1', league: 'NBA', market: 'ML' } }),
        bet('b2', { featureSnapshot: { signalTier: 'TIER 1', movementGrade: 'g1', league: 'NBA', market: 'ML' } }),
        bet('b3', { featureSnapshot: { signalTier: 'TIER 1', movementGrade: 'g1', league: 'NBA', market: 'ML' } })
      ],
      settlements: [
        { betId: 'b1', status: 'win' },
        { betId: 'b2', status: 'loss' },
        { betId: 'b3', status: 'push' }
      ]
    };
    const cal = deriveCalibration(ledger, { minSample: 2 });
    const key = 'TIER 1:g1:NBA:ML';
    assert.equal(cal[key].wins, 1);
    assert.equal(cal[key].losses, 1);
    assert.equal(cal[key].pushes, 1);
    assert.equal(cal[key].sampleSize, 3);
    assert.equal(cal[key].totalDecided, 2);
    assert.equal(cal[key].hitRate, 0.5);
    assert.equal(cal[key].insufficientSample, false);
  });

  it('marks insufficientSample when totalDecided < minSample', () => {
    const ledger = {
      bets: [bet('b1', { featureSnapshot: { signalTier: 'TIER 2', league: 'MLB', market: 'ML' } })],
      settlements: [{ betId: 'b1', status: 'win' }]
    };
    const cal = deriveCalibration(ledger, { minSample: 30 });
    assert.equal(cal['TIER 2:unknown:MLB:ML'].insufficientSample, true);
  });

  it('falls back to legacy top-level fields when featureSnapshot is missing', () => {
    const ledger = {
      bets: [bet('b1', { signalTier: 'TIER 3', league: 'NFL', market: 'SPREAD' })],
      settlements: [{ betId: 'b1', status: 'win' }]
    };
    const cal = deriveCalibration(ledger, { minSample: 1 });
    assert.ok(cal['TIER 3:unknown:NFL:SPREAD']);
  });

  it('falls back to default tiers when nothing recorded', () => {
    const ledger = {
      bets: [bet('b1', { league: undefined, market: undefined })],
      settlements: [{ betId: 'b1', status: 'win' }]
    };
    const cal = deriveCalibration(ledger, { minSample: 1 });
    assert.ok(cal['TIER 4:unknown:?:?']);
  });

  it('hitRate is null when totalDecided is 0 (only pushes)', () => {
    const ledger = {
      bets: [bet('b1', { featureSnapshot: { signalTier: 'TIER 1', league: 'NBA', market: 'ML' } })],
      settlements: [{ betId: 'b1', status: 'push' }]
    };
    const cal = deriveCalibration(ledger, { minSample: 1 });
    assert.equal(cal['TIER 1:unknown:NBA:ML'].hitRate, null);
  });
});

describe('buildEvaluationRows', () => {
  it('returns [] for empty/no settled bets', () => {
    assert.deepEqual(buildEvaluationRows({ bets: [], settlements: [] }), []);
    assert.deepEqual(buildEvaluationRows(null), []);
  });

  it('resolves fields from featureSnapshot, then row, then settlement', () => {
    const ledger = {
      bets: [
        bet('b1', {
          featureSnapshot: {
            league: 'NBA',
            market: 'ML',
            signalQualityScore: 0.8,
            marketFairProbability: 0.5,
            modelWinProbability: 0.55,
            modelMarketEdgePct: 10,
            capturedAt: '2026-01-01',
            decisionTimestamp: '2026-01-01T12:00:00.000Z',
            book: 'NoVigApp',
            line: -1.5,
            closingOdds: -125,
            movementGrade: 'green',
            movementDisposition: 'supportive_clean',
            movementSourceBook: 'Pinnacle',
            correlationGroupId: 'game-1',
            sportContext: { format: 'NBA', paceContext: 'normal' }
          },
          oddsAtDecision: -110,
          stake: 50,
          selection: 'LeBron'
        })
      ],
      settlements: [
        {
          betId: 'b1',
          status: 'win',
          settledAt: '2026-01-02',
          odds: -110,
          stake: 50,
          selection: 'LeBron',
          league: 'NBA',
          market: 'ML'
        }
      ]
    };
    const rows = buildEvaluationRows(ledger);
    const r = rows[0];
    assert.equal(r.betId, 'b1');
    assert.equal(r.league, 'NBA');
    assert.equal(r.market, 'ML');
    assert.equal(r.book, 'NoVigApp');
    assert.equal(r.line, -1.5);
    assert.equal(r.closingOdds, -125);
    assert.equal(r.movementDisposition, 'supportive_clean');
    assert.equal(r.movementSourceBook, 'Pinnacle');
    assert.equal(r.correlationGroupId, 'game-1');
    assert.deepEqual(r.sportContext, { format: 'NBA', paceContext: 'normal' });
    assert.deepEqual(r.sportContextAssessment, {
      status: 'unresolved',
      reasonCodes: ['NBA_AVAILABILITY_MISSING', 'NBA_REST_CONTEXT_MISSING', 'NBA_PACE_CONTEXT_MISSING'],
      requiredFields: ['availabilityConfirmed', 'restConfirmed', 'paceContextConfirmed'],
      missingFields: ['availabilityConfirmed', 'restConfirmed', 'paceContextConfirmed']
    });
    assert.equal(r.signalQualityScore, 0.8);
    assert.equal(r.marketFairProbability, 0.5);
    assert.equal(r.modelWinProbability, 0.55);
    assert.equal(r.modelMarketEdgePct, 10);
    assert.equal(r.outcome, 'win');
  });

  it('falls back to row-level legacy fields when snapshot absent', () => {
    const ledger = {
      bets: [bet('b1', { league: 'NFL', market: 'SPREAD', odds: -120, stake: 100, selection: 'Team A' })],
      settlements: [{ betId: 'b1', status: 'loss', settledAt: '2026-01-02' }]
    };
    const r = buildEvaluationRows(ledger)[0];
    assert.equal(r.league, 'NFL');
    assert.equal(r.odds, -120);
    assert.equal(r.stake, 100);
    assert.equal(r.selection, 'Team A');
  });

  it('falls back to settlement fields when neither snapshot nor row has them', () => {
    const ledger = {
      bets: [
        { id: 'b1', league: undefined, market: undefined, odds: undefined, stake: undefined, selection: undefined }
      ],
      settlements: [
        {
          betId: 'b1',
          status: 'win',
          settledAt: '2026-01-02',
          league: 'UFC',
          market: 'ML',
          odds: 200,
          stake: 25,
          selection: 'Fighter X'
        }
      ]
    };
    const r = buildEvaluationRows(ledger)[0];
    assert.equal(r.league, 'UFC');
    assert.equal(r.odds, 200);
    assert.equal(r.stake, 25);
    assert.equal(r.selection, 'Fighter X');
  });

  it('reads capturedAt from candidateSnapshot when present', () => {
    const ledger = {
      bets: [bet('b1', { candidateSnapshot: { capturedAt: '2026-03-03' }, oddsAtDecision: -110 })],
      settlements: [{ betId: 'b1', status: 'win', settledAt: '2026-03-04' }]
    };
    const r = buildEvaluationRows(ledger)[0];
    assert.equal(r.capturedAt, '2026-03-03');
  });

  it('resolves betId from bet.id, then bet.betId, then settlement.betId', () => {
    const ledger = {
      bets: [{ betId: 'alt-id', league: 'NBA', market: 'ML' }],
      settlements: [{ betId: 'alt-id', status: 'win', settledAt: '2026-01-02' }]
    };
    const r = buildEvaluationRows(ledger)[0];
    assert.equal(r.betId, 'alt-id');
  });
});

describe('segmentEvaluationRows', () => {
  it('keeps sport and market buckets separate and marks small samples', () => {
    const rows = [
      { league: 'MLB', market: 'Moneyline', outcome: 'win' },
      { league: 'MLB', market: 'Moneyline', outcome: 'loss' },
      { league: 'NBA', market: 'Total Points', outcome: 'win' },
      { league: 'NBA', market: 'Total Points', outcome: 'push' }
    ];
    const result = segmentEvaluationRows(rows, { dimensions: ['league', 'market'], minSample: 2 });
    assert.deepEqual(result.dimensions, ['league', 'market']);
    assert.equal(result.segments['MLB|Moneyline'].wins, 1);
    assert.equal(result.segments['MLB|Moneyline'].losses, 1);
    assert.equal(result.segments['MLB|Moneyline'].hitRate, 0.5);
    assert.equal(result.segments['NBA|Total Points'].pushes, 1);
    assert.equal(result.segments['NBA|Total Points'].insufficientSample, true);
  });

  it('does not let missing dimensions collapse into the string undefined', () => {
    const result = segmentEvaluationRows([{ outcome: 'win' }], { dimensions: ['league'] });
    assert.ok(result.segments['?']);
  });
});

describe('validateDecisionTimeIntegrity', () => {
  it('passes a clean decision-time row', () => {
    const result = validateDecisionTimeIntegrity({
      decisionTimestamp: '2026-01-01T12:00:00.000Z',
      settledAt: '2026-01-01T18:00:00.000Z',
      featureSnapshot: { modelWinProbability: 0.55 }
    });
    assert.deepEqual(result, { ok: true, violations: [] });
  });

  it('flags settlement data leaked into the feature snapshot', () => {
    const result = validateDecisionTimeIntegrity({
      decisionTimestamp: '2026-01-01T12:00:00.000Z',
      featureSnapshot: { outcome: 'win', finalScore: '7-6 6-4' }
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.violations, ['featureSnapshot.outcome', 'featureSnapshot.finalScore']);
  });

  it('flags a decision timestamp at or after settlement', () => {
    const result = validateDecisionTimeIntegrity({
      decisionTimestamp: '2026-01-01T18:00:00.000Z',
      settledAt: '2026-01-01T18:00:00.000Z',
      featureSnapshot: {}
    });
    assert.deepEqual(result.violations, ['decisionTimestamp_not_before_settledAt']);
  });
});
