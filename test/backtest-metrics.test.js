'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { playProfit, computeBacktestMetrics } = require('../lib/propprofessor-backtest-metrics');

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
