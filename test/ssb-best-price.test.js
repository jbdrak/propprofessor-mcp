'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  findBestPrice,
  matchPlay,
  collectBookOddsFromRow,
  isBetterOdds,
  spreadFromBest
} = require('../lib/ssb-best-price');

describe('isBetterOdds', () => {
  it('prefers higher positive odds', () => {
    assert.equal(isBetterOdds(+150, +130), true);
    assert.equal(isBetterOdds(+130, +150), false);
  });

  it('prefers less negative odds (closer to 0)', () => {
    assert.equal(isBetterOdds(-105, -110), true);
    assert.equal(isBetterOdds(-110, -105), false);
  });

  it('prefers positive over negative', () => {
    assert.equal(isBetterOdds(+100, -110), true);
    assert.equal(isBetterOdds(-110, +100), false);
  });

  it('handles non-finite values', () => {
    assert.equal(isBetterOdds(NaN, -110), false);
    assert.equal(isBetterOdds(-110, NaN), true);
    assert.equal(isBetterOdds(NaN, NaN), false);
  });
});

describe('spreadFromBest', () => {
  it('computes spread for positive odds', () => {
    assert.equal(spreadFromBest(130, 150, 'american'), 20);
    assert.equal(spreadFromBest(150, 150, 'american'), 0);
  });

  it('computes spread for negative odds', () => {
    assert.equal(spreadFromBest(-110, -105, 'american'), 5);
    assert.equal(spreadFromBest(-105, -105, 'american'), 0);
  });

  it('returns null for non-finite', () => {
    assert.equal(spreadFromBest(NaN, -110, 'american'), null);
    assert.equal(spreadFromBest(-110, NaN, 'american'), null);
  });
});

describe('matchPlay', () => {
  const row = {
    game: 'Lakers vs Celtics',
    market: 'Moneyline',
    participant: 'Lakers',
    matchup: 'Lakers vs Celtics'
  };

  it('matches on all criteria', () => {
    assert.equal(matchPlay(row, { game: 'Lakers', market: 'Moneyline', selection: 'Lakers' }), true);
  });

  it('matches partial game name', () => {
    assert.equal(matchPlay(row, { game: 'Celtics', market: '', selection: '' }), true);
  });

  it('matches partial selection', () => {
    assert.equal(matchPlay(row, { selection: 'Laker' }), true);
  });

  it('rejects wrong selection', () => {
    assert.equal(matchPlay(row, { selection: 'Warriors' }), false);
  });

  it('rejects wrong market', () => {
    assert.equal(matchPlay(row, { market: 'Spread' }), false);
  });
});

describe('collectBookOddsFromRow', () => {
  it('extracts odds from selections structure', () => {
    // Real SSB structure: selection.odds[book] = { odds1, odds2 }
    const row = {
      book: 'NoVigApp',
      selections: {
        s1: {
          selection1: 'Lakers',
          selection2: 'Celtics',
          line1: -2.5,
          line2: 2.5,
          odds: {
            NoVigApp: { odds1: -110, odds2: -110 },
            FanDuel: { odds1: -108, odds2: -112 }
          }
        }
      }
    };
    const result = collectBookOddsFromRow(row);
    assert.equal(result.length, 4);
    assert.equal(result[0].book, 'NoVigApp');
    assert.equal(result[0].odds, -110);
    assert.equal(result[1].book, 'NoVigApp');
    assert.equal(result[1].odds, -110);
    assert.equal(result[2].book, 'FanDuel');
    assert.equal(result[2].odds, -108);
  });

  it('handles flat row with direct odds', () => {
    const row = { book: 'Pinnacle', odds: -105, participant: 'Lakers' };
    const result = collectBookOddsFromRow(row);
    assert.equal(result.length, 1);
    assert.equal(result[0].book, 'Pinnacle');
    assert.equal(result[0].odds, -105);
  });
});

describe('findBestPrice', () => {
  const screenPayload = [
    {
      game: 'Lakers vs Celtics',
      market: 'Moneyline',
      participant: 'Lakers',
      selections: {
        s1: {
          selection1: 'Lakers',
          selection2: 'Celtics',
          odds: {
            NoVigApp: { odds1: -130, odds2: +110 },
            FanDuel: { odds1: -135, odds2: +115 },
            DraftKings: { odds1: -128, odds2: +108 }
          }
        }
      }
    }
  ];

  it('returns sorted prices with best first', () => {
    const result = findBestPrice(screenPayload, {
      game: 'Lakers',
      market: 'Moneyline',
      selection: 'Lakers'
    });
    assert.equal(result.found, true);
    assert.equal(result.bestPrice.book, 'DraftKings');
    assert.equal(result.bestPrice.odds, -128);
    assert.equal(result.allPrices[0].book, 'DraftKings');
    assert.equal(result.allPrices[1].book, 'NoVigApp');
    assert.equal(result.allPrices[2].book, 'FanDuel');
  });

  it('computes spread from best', () => {
    const result = findBestPrice(screenPayload, {
      game: 'Lakers',
      market: 'Moneyline',
      selection: 'Lakers'
    });
    assert.equal(result.spread.best, -128);
    assert.equal(result.spread.worst, -135);
    assert.equal(result.spread.totalSpreadCents, 7);
    assert.equal(result.spread.bookCount, 3);
  });

  it('filters by book', () => {
    const result = findBestPrice(screenPayload, {
      game: 'Lakers',
      market: 'Moneyline',
      selection: 'Lakers',
      books: ['NoVigApp', 'FanDuel']
    });
    assert.equal(result.bookCount, 2);
    assert.equal(result.bestPrice.book, 'NoVigApp');
  });

  it('returns not found for empty payload', () => {
    const result = findBestPrice([], { game: 'Lakers', market: 'Moneyline', selection: 'Lakers' });
    assert.equal(result.found, false);
    assert.equal(result.reason, 'empty_payload');
  });

  it('returns not found for no match', () => {
    const result = findBestPrice(screenPayload, { game: 'Warriors', market: 'Moneyline', selection: 'Warriors' });
    assert.equal(result.found, false);
  });

  it('deduplicates by book keeping best odds', () => {
    const payload = [
      {
        game: 'Lakers vs Celtics',
        market: 'Moneyline',
        participant: 'Lakers',
        selections: {
          s1: {
            selection1: 'Lakers',
            odds: { NoVigApp: { odds1: -130 } }
          }
        }
      },
      {
        game: 'Lakers vs Celtics',
        market: 'Moneyline',
        participant: 'Lakers',
        selections: {
          s1: {
            selection1: 'Lakers',
            odds: { NoVigApp: { odds1: -125 } }
          }
        }
      }
    ];
    const result = findBestPrice(payload, { game: 'Lakers', market: 'Moneyline', selection: 'Lakers' });
    assert.equal(result.bookCount, 1);
    assert.equal(result.bestPrice.odds, -125);
  });
});
