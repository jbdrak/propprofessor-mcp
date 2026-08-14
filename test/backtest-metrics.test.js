'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  playProfit,
  computeBacktestMetrics,
  brierScore,
  logLoss,
  calibrationBins,
  americanOddsToProbability,
  scoreEvaluationRows
} = require('../lib/propprofessor-backtest-metrics');

describe('backtest metrics (real P&L / ROI / Sharpe / drawdown)', () => {
  describe('playProfit', () => {
    it('positive odds win returns stake * odds/100', () => {
      assert.equal(playProfit(155, 100, 'won'), 155);
    });
    it('negative odds win returns stake * 100/|odds|', () => {
      assert.equal(playProfit(-140, 100, 'won'), 100 / 1.4);
    });
    it('loss returns -stake', () => {
      assert.equal(playProfit(-110, 100, 'lost'), -100);
    });
    it('push returns 0', () => {
      assert.equal(playProfit(-110, 100, 'push'), 0);
    });
  });

  describe('computeBacktestMetrics — fixture', () => {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures', 'mlb-moneyline-resolved.json'), 'utf8')
    );
    const plays = fixture.resolved.plays;

    it('computes win/loss/push counts', () => {
      const m = computeBacktestMetrics(plays);
      assert.equal(m.bets, 3);
      assert.equal(m.wins, 2);
      assert.equal(m.losses, 1);
      assert.equal(m.pushes, 0);
    });

    it('computes profit = sum of per-play profits', () => {
      // Yankees -140 @100 won = 71.43; Dodgers -110 @100 lost = -100;
      // Braves +155 @100 won = 155 => total = 126.43
      const m = computeBacktestMetrics(plays);
      assert.ok(Math.abs(m.profit - 126.43) < 0.5, `profit was ${m.profit}`);
    });

    it('computes ROI = profit / total staked', () => {
      const m = computeBacktestMetrics(plays);
      // 126.43 / 300 = 42.1%
      assert.ok(m.roi !== null && Math.abs(m.roi - 42.1) < 1, `roi was ${m.roi}`);
    });

    it('computes win rate', () => {
      const m = computeBacktestMetrics(plays);
      assert.equal(m.winRate, 66.7);
    });

    it('returns a Sharpe number (not null) for >1 play', () => {
      const m = computeBacktestMetrics(plays);
      assert.equal(typeof m.sharpe, 'number');
    });

    it('computes max drawdown', () => {
      const m = computeBacktestMetrics(plays);
      // Sequence: +71.43, -100 (running -28.57), +155 (peak 126.43).
      // Drawdown after play2 = running(-28.57) - peak(71.43) = -100.
      assert.equal(m.maxDrawdown, -100);
    });
  });

  describe('computeBacktestMetrics — edge cases', () => {
    it('empty plays returns zeros and nulls', () => {
      const m = computeBacktestMetrics([]);
      assert.equal(m.bets, 0);
      assert.equal(m.profit, 0);
      assert.equal(m.roi, null);
      assert.equal(m.winRate, null);
      assert.equal(m.sharpe, null);
      assert.equal(m.maxDrawdown, 0);
    });

    it('single play returns null Sharpe', () => {
      const m = computeBacktestMetrics([{ odds: -110, stake: 100, result: 'won' }]);
      assert.equal(m.sharpe, null);
    });
  });
});

describe('probability scoring metrics', () => {
  const fixture = [
    { outcome: 'win', probability: 0.75 },
    { outcome: 'loss', probability: 0.4 }
  ];

  it('computes Brier score for known predictions', () => {
    assert.equal(brierScore([{ outcome: 'win', p: 1 }], 'p').value, 0);
    assert.equal(
      brierScore(
        [
          { outcome: 'win', p: 0.5 },
          { outcome: 'loss', p: 0.5 }
        ],
        'p'
      ).value,
      0.25
    );
    assert.equal(brierScore(fixture, 'probability').value, 0.11125);
    assert.equal(brierScore(fixture, 'probability').samples, 2);
  });

  it('keeps at least 6 decimal places of Brier precision', () => {
    // Mean of ((2/3)^2, (1/3)^2, (1/3)^2) = 2/9 = 0.222222… → 0.222222 at 6 dp,
    // but 0.22222 at 5 dp — discriminates against 5-decimal rounding.
    const result = brierScore(
      [
        { outcome: 'win', p: 1 / 3 },
        { outcome: 'loss', p: 1 / 3 },
        { outcome: 'loss', p: 1 / 3 }
      ],
      'p'
    );
    assert.equal(result.value, 0.222222);
    assert.equal(result.samples, 3);
  });

  it('computes log loss for known predictions', () => {
    const result = logLoss(fixture, 'probability');
    assert.ok(result.value !== null && Math.abs(result.value - 0.3992539) < 1e-6);
    assert.equal(result.samples, 2);
  });

  it('defaults epsilon to 1e-15 so a 1e-12 probability is not clamped to 1e-9', () => {
    const result = logLoss([{ outcome: 'win', p: 1e-12 }], 'p');
    assert.equal(result.samples, 1);
    // -ln(1e-12) ≈ 27.6310211; a 1e-9 clamp would give -ln(1e-9) ≈ 20.7232658.
    assert.ok(Math.abs(result.value - 27.6310211) < 1e-6, `value was ${result.value}`);
  });

  it('filters invalid probabilities and pushes', () => {
    const rows = [
      { outcome: 'win', p: 0.5 },
      { outcome: 'loss' },
      { outcome: 'loss', p: null },
      { outcome: 'win', p: '0.5' },
      { outcome: 'win', p: NaN },
      { outcome: 'win', p: -0.1 },
      { outcome: 'win', p: 1.5 },
      { outcome: 'push', p: 0.2 },
      { outcome: 'unknown', p: 0.2 },
      { outcome: 'WON', p: 0.25 },
      { outcome: 'LOST', p: 0.75 }
    ];
    assert.equal(brierScore(rows, 'p').samples, 3);
    assert.equal(logLoss(rows, 'p').samples, 3);
  });

  it('converts American odds to market implied probability', () => {
    assert.ok(Math.abs(americanOddsToProbability(-110) - 0.5238095) < 1e-6);
    assert.equal(americanOddsToProbability(150), 0.4);
    assert.equal(americanOddsToProbability(0), null);
    assert.equal(americanOddsToProbability(NaN), null);
    assert.equal(americanOddsToProbability('abc'), null);
    assert.equal(americanOddsToProbability(-100), 0.5);
    assert.equal(americanOddsToProbability(100), 0.5);
  });

  it('creates fixed calibration bins, omits empty bins, and respects minimum samples', () => {
    const rows = [
      { outcome: 'win', p: 0 },
      { outcome: 'loss', p: 0.09 },
      { outcome: 'win', p: 0.1 },
      { outcome: 'loss', p: 0.19 },
      { outcome: 'win', p: 0.2 },
      { outcome: 'loss', p: 0.99 },
      { outcome: 'push', p: 0.3 }
    ];
    const bins = calibrationBins(rows, 'p', { bins: 5, minSamplesPerBin: 3 });
    assert.deepEqual(bins, [
      {
        lowerBound: 0,
        upperBound: 0.2,
        samples: 4,
        meanPredicted: 0.095,
        observedWinRate: 0.5,
        insufficientSample: false
      },
      {
        lowerBound: 0.2,
        upperBound: 0.4,
        samples: 1,
        meanPredicted: 0.2,
        observedWinRate: 1,
        insufficientSample: true
      },
      { lowerBound: 0.8, upperBound: 1, samples: 1, meanPredicted: 0.99, observedWinRate: 0, insufficientSample: true }
    ]);
    assert.equal(calibrationBins([], 'p').length, 0);
  });

  it('does not flag a single-sample bin as insufficient by default', () => {
    const bins = calibrationBins([{ outcome: 'win', p: 0.25 }], 'p', { bins: 2 });
    assert.equal(bins.length, 1);
    assert.equal(bins[0].samples, 1);
    assert.equal(bins[0].insufficientSample, false);
  });

  it('rounds calibration bin bounds and rates to 6 decimals (stable bins)', () => {
    // 10 default bins: p = 0.25 lands in bin [0.2, 0.3); the raw float
    // upperBound is 0.30000000000000004 and must come out as 0.3.
    const bins = calibrationBins([{ outcome: 'win', p: 0.25 }], 'p');
    assert.equal(bins.length, 1);
    assert.equal(bins[0].lowerBound, 0.2);
    assert.equal(bins[0].upperBound, 0.3);
    assert.equal(bins[0].meanPredicted, 0.25);
    assert.equal(bins[0].observedWinRate, 1);

    // meanPredicted of (1/3 + 1/3 + 1/3) / 3 = 0.333333… → 0.333333;
    // observedWinRate of 2/3 → 0.666667. Both discriminate 6-dp rounding.
    const thirds = calibrationBins(
      [
        { outcome: 'win', p: 1 / 3 },
        { outcome: 'win', p: 1 / 3 },
        { outcome: 'loss', p: 1 / 3 }
      ],
      'p'
    );
    assert.equal(thirds[0].meanPredicted, 0.333333);
    assert.equal(thirds[0].observedWinRate, 0.666667);
  });

  it('returns null values with no eligible data', () => {
    assert.deepEqual(brierScore([{ outcome: 'push', p: 0.5 }], 'p'), { value: null, samples: 0 });
    assert.deepEqual(logLoss([], 'p'), { value: null, samples: 0 });
  });

  it('scores each explicitly requested field independently', () => {
    const rows = [
      { outcome: 'win', modelWinProbability: 0.8, marketImpliedProbability: 0.6 },
      { outcome: 'loss', modelWinProbability: 0.3, marketFairProbability: 0.5 },
      { outcome: 'push', marketImpliedProbability: 0.9 }
    ];
    const scores = scoreEvaluationRows(rows);
    assert.deepEqual(Object.keys(scores).sort(), ['marketFairProbability', 'modelWinProbability']);
    assert.equal(scores.modelWinProbability.brier.samples, 2);
    assert.equal(scores.marketFairProbability.brier.samples, 1);
    assert.equal(scoreEvaluationRows(rows, ['marketImpliedProbability']).marketImpliedProbability.brier.samples, 1);
    assert.deepEqual(scoreEvaluationRows(rows, []), {});
    assert.deepEqual(scoreEvaluationRows(rows, ['missing']), {});
  });

  it('includes per-field calibration bins with explicit samples for every eligible field', () => {
    const rows = [
      { outcome: 'win', modelWinProbability: 0.8, marketImpliedProbability: 0.6 },
      { outcome: 'loss', modelWinProbability: 0.3, marketFairProbability: 0.5 },
      { outcome: 'push', marketImpliedProbability: 0.9 }
    ];
    const scores = scoreEvaluationRows(rows);
    assert.deepEqual(Object.keys(scores.modelWinProbability).sort(), ['brier', 'calibration', 'logLoss']);
    assert.ok(Array.isArray(scores.modelWinProbability.calibration));
    assert.ok(scores.modelWinProbability.calibration.every((b) => typeof b.samples === 'number'));
    assert.equal(
      scores.modelWinProbability.calibration.reduce((s, b) => s + b.samples, 0),
      2
    );
    assert.equal(
      scores.marketFairProbability.calibration.reduce((s, b) => s + b.samples, 0),
      1
    );
    // Fields with zero eligible samples are still omitted entirely — no substitution.
    assert.deepEqual(Object.keys(scoreEvaluationRows(rows, ['missing'])), []);
  });
});
