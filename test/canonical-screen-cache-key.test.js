'use strict';

// Regression tests: canonicalizeScreenArgs must normalize both the SINGULAR
// league/market shape used by get_play_details / screen_ranked AND the plural
// leagues/markets shape used by quick_screen, so that two different
// (gameId, league, market, books, selection) tuples can never share a cached
// slot.
//
// Defect: the key only captured plural `leagues`/`markets` arrays. When
// callers pass the singular `league`/`market` (as get_play_details does),
// those fields were dropped from the key, so e.g. NBA Moneyline and MLB Total
// Runs for the same gameId/books collapsed to the same canonical key.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeScreenArgs } = require('../lib/propprofessor-shared-utils');

describe('canonicalizeScreenArgs covers singular league/market inputs', () => {
  it('distinguishes NBA Moneyline from MLB Total Runs for the same gameId/books', () => {
    const nba = {
      gameId: 'g1',
      league: 'NBA',
      market: 'Moneyline',
      books: ['NoVigApp']
    };
    const mlb = {
      gameId: 'g1',
      league: 'MLB',
      market: 'Total Runs',
      books: ['NoVigApp']
    };
    assert.notEqual(
      canonicalizeScreenArgs(nba),
      canonicalizeScreenArgs(mlb),
      'NBA Moneyline must not collide with MLB Total Runs (same gameId/books)'
    );
  });

  it('distinguishes singular league/market from a different market on the same game', () => {
    const moneyline = { gameId: 'g1', league: 'NBA', market: 'Moneyline', books: ['NoVigApp'] };
    const spread = { gameId: 'g1', league: 'NBA', market: 'Spread', books: ['NoVigApp'] };
    assert.notEqual(
      canonicalizeScreenArgs(moneyline),
      canonicalizeScreenArgs(spread),
      'same game + different market must not share a canonical key'
    );
  });

  it('treats singular league/market as equivalent to the plural form', () => {
    const singular = { gameId: 'g1', league: 'NBA', market: 'Moneyline', books: ['NoVigApp'] };
    const plural = { gameId: 'g1', leagues: ['NBA'], markets: ['Moneyline'], books: ['NoVigApp'] };
    assert.equal(
      canonicalizeScreenArgs(singular),
      canonicalizeScreenArgs(plural),
      'singular league/market must normalize identically to plural leagues/markets'
    );
  });

  it('distinguishes singular league/market from plural when league differs', () => {
    const singular = { gameId: 'g1', league: 'NBA', market: 'Moneyline', books: ['NoVigApp'] };
    const pluralDifferentLeague = {
      gameId: 'g1',
      leagues: ['MLB'],
      markets: ['Moneyline'],
      books: ['NoVigApp']
    };
    assert.notEqual(
      canonicalizeScreenArgs(singular),
      canonicalizeScreenArgs(pluralDifferentLeague),
      'singular NBA must not collide with plural MLB for the same gameId/books'
    );
  });
});
