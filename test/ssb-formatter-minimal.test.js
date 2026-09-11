'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');
const {
  formatRecommendedBetsMinimal,
  formatSharpPlaysMinimal,
  formatScreenRankedMinimal,
  formatGetPlayDetailsMinimal
} = require('../lib/ssb-formatter');

describe('minimal verbosity returns parseable JSON with type', () => {
  it('formatRecommendedBetsMinimal returns type=no_plays for empty', () => {
    const result = formatRecommendedBetsMinimal({ leagues: [] });
    assert.strictEqual(result.type, 'no_plays');
    assert.strictEqual(result.count, 0);
    assert.strictEqual(typeof result.summary, 'string');
  });

  it('formatRecommendedBetsMinimal returns type=plays with plays', () => {
    const result = formatRecommendedBetsMinimal({
      leagues: [
        {
          league: 'NBA',
          plays: [
            {
              selection: 'Celtics',
              odds: -150,
              game: 'Celtics vs Heat',
              league: 'NBA',
              market: 'Moneyline',
              confidenceTier: 'TIER 1',
              riskScore: 2,
              rationale: 'Sharp books agree.'
            }
          ]
        }
      ]
    });
    assert.strictEqual(result.type, 'plays');
    assert.strictEqual(result.count, 1);
    assert.ok(result.summary.includes('Celtics'));
  });

  it('every minimal formatter returns {summary, count, type}', () => {
    const funcs = [formatSharpPlaysMinimal, formatScreenRankedMinimal, formatGetPlayDetailsMinimal];
    for (const fn of funcs) {
      const result = fn({ result: [] });
      assert.ok('summary' in result, `${fn.name} missing summary`);
      assert.ok('count' in result, `${fn.name} missing count`);
      assert.ok('type' in result, `${fn.name} missing type`);
    }
  });
});
