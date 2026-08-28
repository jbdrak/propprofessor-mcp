'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapRecommendedPlay } = require('../scripts/server/handlers/recommended-play');

describe('recommended play mapper', () => {
  it('preserves the market override and overlays matching research', () => {
    const row = {
      selection: 'Player One',
      game: 'Away @ Home',
      market: 'Moneyline',
      _market: 'Player Triples',
      odds: -110,
      gameId: 'game-1'
    };
    const researchResults = [
      {
        player: 'Player One',
        game: 'Away @ Home',
        market: 'player triples',
        riskFlag: 'low',
        riskSummary: 'Clean',
        topTweet: 'No injury news'
      }
    ];

    const mapped = mapRecommendedPlay(row, researchResults);

    assert.equal(mapped.market, 'Player Triples');
    assert.equal(mapped.riskFlag, 'low');
    assert.equal(mapped.riskSummary, 'Clean');
    assert.equal(mapped.topTweet, 'No injury news');
  });

  it('does not add research fields when no row matches', () => {
    const mapped = mapRecommendedPlay({ selection: 'Player One', market: 'Moneyline', _market: 'Moneyline' }, []);

    assert.equal(mapped.market, 'Moneyline');
    assert.equal(mapped.riskFlag, undefined);
    assert.equal(mapped.riskSummary, undefined);
    assert.equal(mapped.topTweet, undefined);
  });
});
