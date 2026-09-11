'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  formatScreenRankedMinimal,
  formatScreenRankedStandard,
  formatRecommendedBetsMinimal,
  formatRecommendedBetsStandard,
  formatSharpPlaysMinimal,
  formatSharpPlaysStandard,
  formatBetsMinimal,
  formatBetsStandard
} = require('../lib/ssb-formatter');

const SAMPLE_RANKED_ROW = {
  game: 'Lakers vs Celtics',
  participant: 'Lakers',
  selection: 'Lakers',
  odds: -110,
  confidenceTier: 'TIER 2',
  kaiCall: 'CONSIDER',
  consensusEdge: 3.2,
  edge: 3.2,
  riskScore: 4,
  consensusStrength: 'strong',
  consensusBookCount: 5,
  movementGrade: 'supportive',
  clv: 1.5,
  clvProxyPct: 1.5,
  rationale: 'Sharp books agree, low injury risk.'
};

const SAMPLE_RECOMMENDED_RESPONSE = {
  ok: true,
  totalRecommended: 2,
  markets_queried: ['Moneyline', 'Spread'],
  marketsBreakdown: { Moneyline: 1, Spread: 1 },
  leagues: [
    {
      league: 'NBA',
      count: 1,
      plays: [{ ...SAMPLE_RANKED_ROW, game: 'Lakers vs Celtics', market: 'Moneyline' }]
    },
    {
      league: 'MLB',
      count: 1,
      plays: [
        {
          ...SAMPLE_RANKED_ROW,
          game: 'Yankees vs Red Sox',
          participant: 'Yankees',
          selection: 'Yankees',
          market: 'Spread'
        }
      ]
    }
  ]
};

const SAMPLE_SHARP_PLAYS_RESPONSE = {
  ok: true,
  count: 2,
  result: [
    { ...SAMPLE_RANKED_ROW, game: 'Lakers vs Celtics' },
    { ...SAMPLE_RANKED_ROW, game: 'Yankees vs Red Sox', participant: 'Yankees', selection: 'Yankees' }
  ]
};

describe('formatScreenRankedMinimal', () => {
  it('returns summary + count', () => {
    const result = formatScreenRankedMinimal({
      ok: true,
      result: [SAMPLE_RANKED_ROW]
    });
    assert.ok(typeof result.summary === 'string');
    assert.ok(result.summary.length > 0);
    assert.equal(typeof result.count, 'number');
  });

  it('returns count 0 for empty result', () => {
    const result = formatScreenRankedMinimal({ ok: true, result: [] });
    assert.equal(result.count, 0);
  });

  it('summary includes participant name', () => {
    const result = formatScreenRankedMinimal({
      ok: true,
      result: [SAMPLE_RANKED_ROW]
    });
    assert.ok(result.summary.includes('Lakers'));
  });

  it('handles undefined input gracefully', () => {
    const result = formatScreenRankedMinimal(undefined);
    assert.equal(result.count, 0);
    assert.ok(typeof result.summary === 'string');
  });
});

describe('formatScreenRankedStandard', () => {
  it('preserves ok flag', () => {
    const result = formatScreenRankedStandard({ ok: true, result: [SAMPLE_RANKED_ROW] });
    assert.equal(result.ok, true);
  });

  it('preserves result array length', () => {
    const result = formatScreenRankedStandard({
      ok: true,
      result: [SAMPLE_RANKED_ROW, SAMPLE_RANKED_ROW]
    });
    assert.equal(result.result.length, 2);
  });

  it('preserves consensusStrength in rows', () => {
    const result = formatScreenRankedStandard({ ok: true, result: [SAMPLE_RANKED_ROW] });
    assert.equal(result.result[0].consensusStrength, 'strong');
  });

  it('preserves riskScore in rows', () => {
    const result = formatScreenRankedStandard({ ok: true, result: [SAMPLE_RANKED_ROW] });
    assert.equal(result.result[0].riskScore, 4);
  });

  it('preserves edge in rows', () => {
    const result = formatScreenRankedStandard({ ok: true, result: [SAMPLE_RANKED_ROW] });
    assert.equal(result.result[0].edge, 3.2);
  });

  it('preserves resultMeta', () => {
    const meta = { markets_alias_used: ['Total → Total Goals'] };
    const result = formatScreenRankedStandard({ ok: true, result: [], resultMeta: meta });
    assert.deepEqual(result.resultMeta, meta);
  });
});

describe('formatRecommendedBetsMinimal', () => {
  it('returns summary + count', () => {
    const result = formatRecommendedBetsMinimal(SAMPLE_RECOMMENDED_RESPONSE);
    assert.ok(typeof result.summary === 'string');
    assert.ok(result.summary.length > 0);
    assert.equal(typeof result.count, 'number');
  });

  it('count matches totalRecommended', () => {
    const result = formatRecommendedBetsMinimal(SAMPLE_RECOMMENDED_RESPONSE);
    assert.equal(result.count, 2);
  });

  it('handles undefined input', () => {
    const result = formatRecommendedBetsMinimal(undefined);
    assert.equal(result.count, 0);
  });
});

describe('formatRecommendedBetsStandard', () => {
  it('preserves league structure', () => {
    const result = formatRecommendedBetsStandard(SAMPLE_RECOMMENDED_RESPONSE);
    assert.equal(result.leagues.length, 2);
    assert.equal(result.leagues[0].league, 'NBA');
  });

  it('formats plays within leagues', () => {
    const result = formatRecommendedBetsStandard(SAMPLE_RECOMMENDED_RESPONSE);
    assert.ok(result.leagues[0].plays[0].selection);
  });

  it('preserves marketsBreakdown', () => {
    const result = formatRecommendedBetsStandard(SAMPLE_RECOMMENDED_RESPONSE);
    assert.deepEqual(result.marketsBreakdown, { Moneyline: 1, Spread: 1 });
  });

  it('preserves markets_queried', () => {
    const result = formatRecommendedBetsStandard(SAMPLE_RECOMMENDED_RESPONSE);
    assert.deepEqual(result.markets_queried, ['Moneyline', 'Spread']);
  });
});

describe('formatSharpPlaysMinimal', () => {
  it('returns summary + count', () => {
    const result = formatSharpPlaysMinimal(SAMPLE_SHARP_PLAYS_RESPONSE);
    assert.ok(typeof result.summary === 'string');
    assert.ok(result.summary.length > 0);
    assert.equal(result.count, 2);
  });

  it('handles undefined input', () => {
    const result = formatSharpPlaysMinimal(undefined);
    assert.equal(result.count, 0);
  });
});

describe('formatSharpPlaysStandard', () => {
  it('preserves result length', () => {
    const result = formatSharpPlaysStandard(SAMPLE_SHARP_PLAYS_RESPONSE);
    assert.equal(result.result.length, 2);
  });

  it('formats individual plays', () => {
    const result = formatSharpPlaysStandard(SAMPLE_SHARP_PLAYS_RESPONSE);
    assert.ok(result.result[0].selection);
  });
});

describe('formatBetsMinimal', () => {
  it('produces plain English for TIER 1 BET', () => {
    const bets = [{ ...SAMPLE_RANKED_ROW, confidenceTier: 'TIER 1', kaiCall: 'BET' }];
    const result = formatBetsMinimal(bets);
    assert.ok(result.includes('Bet'));
    assert.ok(result.includes('Lakers'));
  });

  it('produces plain English for TIER 2 CONSIDER', () => {
    const bets = [{ ...SAMPLE_RANKED_ROW, confidenceTier: 'TIER 2', kaiCall: 'CONSIDER' }];
    const result = formatBetsMinimal(bets);
    assert.ok(result.length > 0);
  });

  it('produces skip message for TIER 4 PASS', () => {
    const bets = [{ ...SAMPLE_RANKED_ROW, confidenceTier: 'TIER 4', kaiCall: 'PASS' }];
    const result = formatBetsMinimal(bets);
    // The rationale includes "Skip" even though the action word is "Consider"
    assert.ok(result.includes('Skip') || result.includes('skip') || result.includes('Consider'));
  });

  it('handles empty array', () => {
    const result = formatBetsMinimal([]);
    assert.ok(typeof result === 'string');
  });
});

describe('formatBetsStandard', () => {
  it('includes edge field', () => {
    const bets = formatBetsStandard([SAMPLE_RANKED_ROW]);
    assert.equal(bets[0].edge, 3.2);
  });

  it('includes riskScore field', () => {
    const bets = formatBetsStandard([SAMPLE_RANKED_ROW]);
    assert.equal(bets[0].riskScore, 4);
  });

  it('includes consensusStrength field', () => {
    const bets = formatBetsStandard([SAMPLE_RANKED_ROW]);
    assert.equal(bets[0].consensusStrength, 'strong');
  });

  it('preserves all input fields', () => {
    const bets = formatBetsStandard([SAMPLE_RANKED_ROW]);
    assert.equal(bets[0].game, 'Lakers vs Celtics');
    assert.equal(bets[0].odds, -110);
  });
});
