'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runBacktest, generateScenario, setRandomSeed, resetRandomSeed } = require('../scripts/backtest-synthetic');

describe('synthetic backtest', () => {
  it('generateScenario returns valid scenario with required fields', () => {
    const scenario = generateScenario();

    assert.ok(scenario.screenPayload, 'Has screenPayload');
    assert.ok(scenario.screenPayload.game_data, 'Has game_data');
    assert.ok(scenario.screenPayload.game_data.length === 1, 'One game per scenario');
    assert.ok(scenario.oddsHistory, 'Has oddsHistory');
    assert.ok(scenario.outcome, 'Has outcome (winner team name)');
    assert.ok(scenario.gameId, 'Has gameId');
    assert.ok(scenario.description, 'Has description');

    const game = scenario.screenPayload.game_data[0];
    assert.ok(game.homeTeam, 'Game has homeTeam');
    assert.ok(game.awayTeam, 'Game has awayTeam');
    assert.ok(game.selections, 'Game has selections');
    assert.ok(game.selections.ml, 'Game has ml selection');
    assert.ok(game.selections.ml.odds, 'Game has odds');
  });

  it('generateScenario creates odds for multiple books', () => {
    const scenario = generateScenario();
    const game = scenario.screenPayload.game_data[0];
    const bookCount = Object.keys(game.selections.ml.odds).length;

    assert.ok(bookCount >= 5, `Expected at least 5 books, got ${bookCount}`);
  });

  it('generateScenario creates odds history with multiple data points', () => {
    // Seed for deterministic results — this test asserts on a specific
    // threshold (>= 3 books with history) that was flaky on Math.random().
    setRandomSeed(42);
    try {
      const scenario = generateScenario();
      const historyKeys = Object.keys(scenario.oddsHistory);

      assert.ok(historyKeys.length >= 1, 'Has at least one game history');

      const gameId = scenario.gameId;
      const gameHistory = scenario.oddsHistory[gameId];
      assert.ok(gameHistory, 'History exists for the game');

      // At least some books should have history
      const booksWithHistory = Object.keys(gameHistory).filter((b) => gameHistory[b].length > 0);
      assert.ok(booksWithHistory.length >= 3, `Expected at least 3 books with history, got ${booksWithHistory.length}`);
    } finally {
      resetRandomSeed();
    }
  });

  it('runBacktest produces tier results for 50 scenarios', () => {
    const { results, scenarios, errorCount } = runBacktest({ scenarios: 50 });

    assert.equal(scenarios, 50);
    assert.equal(errorCount, 0);

    // Should have at least TIER 1 or TIER 4 plays (most scenarios produce both)
    const t1 = results['TIER 1'] || { wins: 0, losses: 0 };
    const t4 = results['TIER 4'] || { wins: 0, losses: 0 };
    const totalPlays = t1.wins + t1.losses + t4.wins + t4.losses;

    assert.ok(totalPlays > 0, 'Should have at least some plays across tiers');
  });

  it('runBacktest with 200 scenarios has reasonable tier distribution', () => {
    const { results } = runBacktest({ scenarios: 200 });

    // Count plays per tier
    const tierCounts = {};
    for (const [tier, data] of Object.entries(results)) {
      tierCounts[tier] = data.wins + data.losses;
    }

    // All four tiers should have plays — guards against the "99% TIER 4" failure
    // mode that v1.5.4's check:claims script caught. The scenario mix (15/25/30/30
    // across strong_sharp_move/sharp_move/stable_no_edge/adverse) + per-scenario
    // cache reset should produce a non-degenerate distribution.
    for (const tier of ['TIER 1', 'TIER 2', 'TIER 3', 'TIER 4']) {
      assert.ok(
        tierCounts[tier] > 0,
        `Expected at least one play in ${tier}, got ${tierCounts[tier]}. ` +
          'Backtest may have regressed to the "99% TIER 4" pre-fix failure mode.'
      );
    }
  });

  it('runBacktest produces enough TIER 1 plays for a meaningful hit rate', () => {
    // The v1.5.3 README claimed 55.9% TIER 1 hit rate, but it was based on
    // 3-5 plays — noise. The v1.5.4 fix (more books + strong_sharp_move
    // scenarios + per-scenario cache reset) should produce at least 100 TIER 1
    // plays per 3000 scenarios, making the hit rate statistically meaningful.
    const { results } = runBacktest({ scenarios: 3000 });
    const t1 = results['TIER 1'] || { wins: 0, losses: 0 };
    const t1Total = t1.wins + t1.losses;

    assert.ok(
      t1Total >= 100,
      `Expected at least 100 TIER 1 plays per 3000 scenarios for a meaningful hit rate, got ${t1Total}. ` +
        'Backtest distribution has collapsed — check the scenario mix and cache reset logic.'
    );
  });

  it('runBacktest produces no errors on 100 scenarios', () => {
    const { errorCount } = runBacktest({ scenarios: 100 });
    assert.equal(errorCount, 0, 'No errors should occur during backtest');
  });

  it('TIER 1 hit rate stays above coin-flip across multiple seeds (ranking engine differentiates top tier)', () => {
    // Synthetic validation: the strongest-scenario tier must beat 50% (the
    // moneyline base rate) consistently. Catches regressions where the ranking
    // engine stops rewarding supportive movement + deep consensus + CLV.
    const seeds = [1, 42, 777, 12345, 20260826, 99, 314, 555];
    let aboveCoinflip = 0;
    for (const seed of seeds) {
      setRandomSeed(seed);
      const { results } = runBacktest({ scenarios: 1500 });
      const t1 = results['TIER 1'] || { wins: 0, losses: 0 };
      const total = t1.wins + t1.losses;
      if (total > 0) {
        const rate = t1.wins / total;
        if (rate > 0.5) aboveCoinflip += 1;
      }
    }
    // The engine reliably separates TIER 1 from coin-flip across seeds.
    assert.ok(aboveCoinflip >= seeds.length - 1, `TIER 1 above 50% in ${aboveCoinflip}/${seeds.length} seeds`);
  });
});
