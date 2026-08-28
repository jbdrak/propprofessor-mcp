'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  formatBetMinimal,
  formatBetsMinimal,
  formatBetStandard,
  formatBetsStandard,
  formatRecommendedBetsMinimal,
  formatRecommendedBetsStandard,
  formatSharpPlaysMinimal,
  formatScreenRankedMinimal,
  tierToConfidence,
  riskScoreToLabel,
  actionWord,
  formatOdds,
  formatQuickScreenMinimal,
  STANDARD_KEEP_FIELDS,
  STANDARD_STRIP_FIELDS
} = require('../lib/propprofessor-formatter');

// ---------------------------------------------------------------------------
// Helper tests
// ---------------------------------------------------------------------------

describe('tierToConfidence', () => {
  it('maps TIER 1 to high confidence', () => {
    assert.equal(tierToConfidence('TIER 1'), 'high confidence');
  });
  it('maps TIER 2 to moderate confidence', () => {
    assert.equal(tierToConfidence('TIER 2'), 'moderate confidence');
  });
  it('maps TIER 3 to low confidence', () => {
    assert.equal(tierToConfidence('TIER 3'), 'low confidence');
  });
  it('maps unknown/missing to low confidence', () => {
    assert.equal(tierToConfidence(''), 'low confidence');
    assert.equal(tierToConfidence(null), 'low confidence');
    assert.equal(tierToConfidence(undefined), 'low confidence');
  });
});

describe('riskScoreToLabel', () => {
  it('returns high risk for score >= 7', () => {
    assert.equal(riskScoreToLabel(7), 'high risk');
    assert.equal(riskScoreToLabel(10), 'high risk');
  });
  it('returns moderate risk for score 4-6', () => {
    assert.equal(riskScoreToLabel(4), 'moderate risk');
    assert.equal(riskScoreToLabel(6), 'moderate risk');
  });
  it('returns low risk for score < 4', () => {
    assert.equal(riskScoreToLabel(0), 'low risk');
    assert.equal(riskScoreToLabel(3), 'low risk');
  });
  it('handles missing/null as low risk', () => {
    assert.equal(riskScoreToLabel(null), 'low risk');
    assert.equal(riskScoreToLabel(undefined), 'low risk');
  });
});

describe('actionWord', () => {
  it('returns Bet for TIER 1 and TIER 2', () => {
    assert.equal(actionWord('TIER 1'), 'Bet');
    assert.equal(actionWord('TIER 2'), 'Bet');
  });
  it('returns Consider for lower tiers', () => {
    assert.equal(actionWord('TIER 3'), 'Consider');
    assert.equal(actionWord(''), 'Consider');
  });
});

describe('formatOdds', () => {
  it('formats positive American odds with +', () => {
    assert.equal(formatOdds(105), '+105');
    assert.equal(formatOdds(250), '+250');
  });
  it('formats negative American odds with -', () => {
    assert.equal(formatOdds(-110), '-110');
    assert.equal(formatOdds(-200), '-200');
  });
  it('returns empty string for null/undefined', () => {
    assert.equal(formatOdds(null), '');
    assert.equal(formatOdds(undefined), '');
  });
});

// ---------------------------------------------------------------------------
// formatBetMinimal
// ---------------------------------------------------------------------------

describe('formatBetMinimal', () => {
  it('produces a string containing the selection name, odds, and confidence level', () => {
    const bet = {
      selection: 'Bonfim',
      odds: 105,
      game: 'Bonfim vs Muhammad',
      league: 'UFC',
      market: 'Moneyline',
      confidenceTier: 'TIER 1',
      riskScore: 2,
      rationale: 'Sharp books agree, low injury risk.'
    };
    const result = formatBetMinimal(bet);
    assert.equal(typeof result, 'string');
    assert.ok(result.includes('Bonfim'), 'should include selection name');
    assert.ok(result.includes('+105'), 'should include formatted odds');
    assert.ok(result.toLowerCase().includes('high confidence'), 'should include confidence level');
    assert.ok(result.toLowerCase().includes('low risk'), 'should include risk label');
    assert.ok(result.startsWith('Bet '), 'TIER 1 should use "Bet" action word');
  });

  it('includes warning emoji for riskScore >= 7', () => {
    const bet = {
      selection: 'Risky Pick',
      odds: 200,
      confidenceTier: 'TIER 2',
      riskScore: 8
    };
    const result = formatBetMinimal(bet);
    assert.ok(result.includes('⚠️'), 'should include warning emoji for high risk');
  });

  it('does NOT include warning emoji for riskScore < 7', () => {
    const bet = {
      selection: 'Safe Pick',
      odds: -110,
      confidenceTier: 'TIER 1',
      riskScore: 3
    };
    const result = formatBetMinimal(bet);
    assert.ok(!result.includes('⚠️'), 'should not include warning emoji for low risk');
  });

  it('handles empty/missing bet gracefully', () => {
    const result = formatBetMinimal({});
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  it('uses "Consider" for TIER 3', () => {
    const bet = {
      selection: 'Longshot',
      odds: 500,
      confidenceTier: 'TIER 3',
      riskScore: 5
    };
    const result = formatBetMinimal(bet);
    assert.ok(result.startsWith('Consider '), 'TIER 3 should use "Consider"');
    assert.ok(result.toLowerCase().includes('moderate risk'));
  });

  it('includes rationale when provided', () => {
    const bet = {
      selection: 'Test',
      odds: 100,
      rationale: 'Because reasons.'
    };
    const result = formatBetMinimal(bet);
    assert.ok(result.includes('Why: Because reasons.'));
  });

  it('surfaces conflictWith in the rationale (audit finding #5)', () => {
    const bet = {
      selection: 'Celtics +3.5',
      game: 'Lakers vs Celtics',
      league: 'NBA',
      market: 'Spread',
      odds: -110,
      confidenceTier: 'TIER 2',
      kaiCall: 'CONSIDER',
      consensusEdge: 1.5,
      conflictWith: 'Lakers -3.5',
      conflictFlag: true
    };
    const result = formatBetMinimal(bet);
    assert.ok(result.includes('Lakers -3.5'), 'opposing side must be surfaced in output');
    assert.ok(result.includes('opposing side'), 'must explicitly say it was downgraded');
  });

  it('does not add conflict context when conflictWith is absent', () => {
    const bet = {
      selection: 'Celtics +3.5',
      game: 'Lakers vs Celtics',
      league: 'NBA',
      market: 'Spread',
      odds: -110,
      confidenceTier: 'TIER 2',
      kaiCall: 'CONSIDER',
      consensusEdge: 1.5
      // no conflictWith / conflictFlag
    };
    const result = formatBetMinimal(bet);
    assert.ok(!result.includes('opposing side'), 'no conflict → no downgrade message');
  });
});

// ---------------------------------------------------------------------------
// formatBetsMinimal
// ---------------------------------------------------------------------------

describe('formatBetsMinimal', () => {
  it('returns numbered list for multiple bets', () => {
    const bets = [
      { selection: 'A', odds: 100, confidenceTier: 'TIER 1', riskScore: 2 },
      { selection: 'B', odds: -150, confidenceTier: 'TIER 2', riskScore: 5 }
    ];
    const result = formatBetsMinimal(bets);
    assert.ok(result.startsWith('1. '), 'should start with "1."');
    assert.ok(result.includes('2. '), 'should include "2."');
    assert.ok(result.includes('A'));
    assert.ok(result.includes('B'));
  });

  it('returns "No strong plays right now." for empty array', () => {
    assert.equal(formatBetsMinimal([]), 'No strong plays right now.');
  });

  it('returns "No strong plays right now." for non-array input', () => {
    assert.equal(formatBetsMinimal(null), 'No strong plays right now.');
    assert.equal(formatBetsMinimal(undefined), 'No strong plays right now.');
  });
});

// ---------------------------------------------------------------------------
// formatBetStandard
// ---------------------------------------------------------------------------

describe('formatBetStandard', () => {
  it('strips lineHistory and debug fields', () => {
    const bet = {
      selection: 'Test',
      odds: 100,
      lineHistory: [{ timestamp: 1, price: 100 }],
      debug: { verbose: true },
      scoreBreakdown: { a: 1 },
      oddsMap: { book1: 100 }
    };
    const result = formatBetStandard(bet);
    assert.equal(result.lineHistory, undefined, 'lineHistory should be stripped');
    assert.equal(result.debug, undefined, 'debug should be stripped');
    assert.equal(result.scoreBreakdown, undefined, 'scoreBreakdown should be stripped');
    assert.equal(result.oddsMap, undefined, 'oddsMap should be stripped');
  });

  it('keeps key fields (selection, odds, tier, edge, riskScore)', () => {
    const bet = {
      selection: 'Test',
      odds: 105,
      confidenceTier: 'TIER 1',
      consensusEdge: 3.5,
      riskScore: 2,
      game: 'A vs B',
      league: 'NBA',
      market: 'Moneyline',
      movementGrade: 'A',
      kaiCall: 'BET',
      rationale: 'Good play'
    };
    const result = formatBetStandard(bet);
    assert.equal(result.selection, 'Test');
    assert.equal(result.odds, 105);
    assert.equal(result.confidenceTier, 'TIER 1');
    assert.equal(result.consensusEdge, 3.5);
    assert.equal(result.riskScore, 2);
    assert.equal(result.game, 'A vs B');
    assert.equal(result.league, 'NBA');
    assert.equal(result.market, 'Moneyline');
    assert.equal(result.movementGrade, 'A');
    assert.equal(result.kaiCall, 'BET');
    assert.equal(result.rationale, 'Good play');
  });

  it('preserves the non-verbose screenUrl deep link', () => {
    const result = formatBetStandard({
      selection: 'Player X',
      market: 'Player Hits',
      gameId: 'MLB:1',
      screenUrl: 'https://app.propprofessor.com/screen?x=1'
    });
    assert.equal(result.screenUrl, 'https://app.propprofessor.com/screen?x=1');
  });

  it('handles null/undefined input gracefully', () => {
    const result = formatBetStandard(null);
    assert.deepEqual(result, {});
  });

  it('falls back to participant/pick if selection is missing', () => {
    const bet = { participant: 'Player X', odds: 100 };
    const result = formatBetStandard(bet);
    assert.equal(result.selection, 'Player X');
  });
});

// ---------------------------------------------------------------------------
// formatBetsStandard
// ---------------------------------------------------------------------------

describe('formatBetsStandard', () => {
  it('maps formatBetStandard over array', () => {
    const bets = [
      { selection: 'A', odds: 100, lineHistory: [1, 2, 3] },
      { selection: 'B', odds: -110, debug: { x: 1 } }
    ];
    const result = formatBetsStandard(bets);
    assert.equal(result.length, 2);
    assert.equal(result[0].lineHistory, undefined);
    assert.equal(result[1].debug, undefined);
    assert.equal(result[0].selection, 'A');
    assert.equal(result[1].selection, 'B');
  });

  it('returns empty array for non-array input', () => {
    assert.deepEqual(formatBetsStandard(null), []);
    assert.deepEqual(formatBetsStandard(undefined), []);
  });
});

// ---------------------------------------------------------------------------
// Response-level formatters
// ---------------------------------------------------------------------------

describe('formatRecommendedBetsMinimal', () => {
  it('returns summary string and count', () => {
    const response = {
      ok: true,
      totalRecommended: 2,
      leagues: [
        {
          league: 'NBA',
          count: 2,
          plays: [
            { selection: 'Lakers ML', odds: -110, confidenceTier: 'TIER 1', riskScore: 2 },
            { selection: 'Celtics -3', odds: -105, confidenceTier: 'TIER 2', riskScore: 4 }
          ]
        }
      ]
    };
    const result = formatRecommendedBetsMinimal(response);
    assert.equal(result.count, 2);
    assert.equal(typeof result.summary, 'string');
    assert.ok(result.summary.includes('1.'));
    assert.ok(result.summary.includes('2.'));
    assert.ok(result.summary.includes('Lakers ML'));
  });

  it('handles empty response', () => {
    const result = formatRecommendedBetsMinimal({ ok: true, leagues: [] });
    assert.equal(result.count, 0);
    assert.equal(result.summary, 'No strong plays right now.');
  });
});

describe('formatRecommendedBetsStandard', () => {
  it('preserves structure but strips verbose fields from plays', () => {
    const response = {
      ok: true,
      totalRecommended: 1,
      leagues: [
        {
          league: 'NBA',
          count: 1,
          plays: [{ selection: 'Lakers', odds: -110, lineHistory: [1, 2], debug: {}, confidenceTier: 'TIER 1' }]
        }
      ]
    };
    const result = formatRecommendedBetsStandard(response);
    assert.equal(result.ok, true);
    assert.equal(result.leagues[0].plays[0].selection, 'Lakers');
    assert.equal(result.leagues[0].plays[0].lineHistory, undefined);
    assert.equal(result.leagues[0].plays[0].debug, undefined);
  });
});

describe('formatSharpPlaysMinimal', () => {
  it('returns summary and count from result array', () => {
    const response = {
      ok: true,
      count: 1,
      result: [{ selection: 'Play A', odds: 100, confidenceTier: 'TIER 1', riskScore: 1 }]
    };
    const result = formatSharpPlaysMinimal(response);
    assert.equal(result.count, 1);
    assert.ok(result.summary.includes('Play A'));
  });
});

describe('formatScreenRankedMinimal', () => {
  it('returns summary and count from result array', () => {
    const response = {
      ok: true,
      result: [{ selection: 'Screen Play', odds: -150, confidenceTier: 'TIER 2', riskScore: 3 }]
    };
    const result = formatScreenRankedMinimal(response);
    assert.equal(result.count, 1);
    assert.ok(result.summary.includes('Screen Play'));
  });
});

// ---------------------------------------------------------------------------
// Export completeness
// ---------------------------------------------------------------------------

describe('module exports', () => {
  it('exports STANDARD_KEEP_FIELDS and STANDARD_STRIP_FIELDS as Sets', () => {
    assert.ok(STANDARD_KEEP_FIELDS instanceof Set);
    assert.ok(STANDARD_STRIP_FIELDS instanceof Set);
    assert.ok(STANDARD_KEEP_FIELDS.has('selection'));
    assert.ok(STANDARD_KEEP_FIELDS.has('odds'));
    assert.ok(STANDARD_KEEP_FIELDS.has('riskScore'));
    assert.ok(STANDARD_STRIP_FIELDS.has('lineHistory'));
    assert.ok(STANDARD_STRIP_FIELDS.has('debug'));
  });
});

describe('formatQuickScreenMinimal — parseable flag', () => {
  const response = {
    maxPlaysPerGame: 50,
    results: [
      {
        league: 'Tennis',
        market: 'Moneyline',
        candidates: [
          {
            game: 'Gauff vs Muchova',
            selection: 'Gauff',
            odds: -120,
            confidenceTier: 'TIER 1',
            edge: 2.1,
            startCST: 'Thu, Jul 9, 7:00 AM',
            movementDisposition: 'supportive_clean',
            screenScore: 90,
            screenUrl: 'https://app.propprofessor.com/screen?x=1'
          }
        ]
      }
    ]
  };

  it('returns a structured plays array when parseable=true', () => {
    const out = formatQuickScreenMinimal({ ...response, parseable: true });
    assert.ok(Array.isArray(out.plays), 'plays should be an array when parseable');
    assert.equal(out.plays.length, 1);
    assert.equal(out.plays[0].selection, 'Gauff');
    assert.equal(out.plays[0].confidenceTier, 'TIER 1');
    assert.equal(out.plays[0].screenUrl, 'https://app.propprofessor.com/screen?x=1');
    assert.equal(typeof out.summary, 'string');
  });

  it('always includes plays array by default (parseable=true is the new default)', () => {
    const out = formatQuickScreenMinimal(response);
    assert.ok(Array.isArray(out.plays), 'plays should always be included');
    assert.equal(out.plays.length, 1);
    assert.equal(out.plays[0].selection, 'Gauff');
    assert.equal(typeof out.summary, 'string');
  });
});
