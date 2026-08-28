'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { stripLiteResponse } = require('../scripts/server/handlers/strip-lite-response');

describe('stripLiteResponse', () => {
  it('inlines matching research, removes heavy fields, and aggregates active slate', () => {
    const response = {
      research: [
        { player: 'Player One', game: 'Away @ Home', market: 'moneyline', riskFlag: 'low', riskSummary: 'Clean' }
      ],
      results: [
        {
          league: 'NBA',
          market: 'Moneyline',
          candidates: [
            {
              selection: 'Player One',
              game: 'Away @ Home',
              market: 'Moneyline',
              validatedGameContext: { heavy: true },
              validatedEdge: 4,
              validatedClv: 2,
              validatedOdds: -110,
              priceDrift: 1,
              finalWarnings: ['warning'],
              screenUrl: 'https://example.test',
              rationale: ['drop me']
            }
          ]
        }
      ],
      activeSlate: [
        { league: 'NBA', count: 1 },
        { league: 'NBA', count: 2 },
        { league: 'MLB', count: 4 }
      ]
    };

    const result = stripLiteResponse(response);
    const candidate = result.results[0].candidates[0];

    assert.equal(result.research, undefined);
    assert.equal(candidate.riskFlag, 'low');
    assert.equal(candidate.riskSummary, 'Clean');
    for (const field of [
      'validatedGameContext',
      'validatedEdge',
      'validatedClv',
      'validatedOdds',
      'priceDrift',
      'finalWarnings',
      'screenUrl',
      'rationale'
    ]) {
      assert.equal(candidate[field], undefined, `${field} should be removed`);
    }
    assert.deepEqual(result.activeSlate, [
      { league: 'NBA', count: 3 },
      { league: 'MLB', count: 4 }
    ]);
  });
});
