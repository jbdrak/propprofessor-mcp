'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SHARP_BOOKS,
  NBA_MAIN_MARKET_SHARP_BOOKS,
  NBA_PROP_MARKET_SHARP_BOOKS,
  NFL_MAIN_MARKET_SHARP_BOOKS,
  NFL_PROP_MARKET_SHARP_BOOKS,
  MLB_MAIN_MARKET_SHARP_BOOKS,
  MLB_PROP_MARKET_SHARP_BOOKS,
  MLB_PROP_CIRCA_CONFIDENT_MARKETS,
  getSharpBookComparisonSet,
  getSharpBookContext,
  isNbaLeague,
  isNflLeague,
  isMlbLeague,
  isPrimaryMainMarket,
  isMlbMainMarket,
  isMlbPropMarket,
  normalizeMarket,
  uniqueBooks,
  canonicalizeScreenBookName
} = require('../lib/propprofessor-sharp-books');

describe('uniqueBooks', () => {
  it('deduplicates and trims book names', () => {
    assert.deepEqual(uniqueBooks([' Pinnacle ', 'Pinnacle', ' Circa ', 'Circa']), ['Pinnacle', 'Circa']);
  });

  it('filters out falsy and whitespace-only entries', () => {
    assert.deepEqual(uniqueBooks(['Pinnacle', null, undefined, '', '  ', 0, false]), ['Pinnacle']);
  });

  it('returns empty array for non-array input', () => {
    assert.deepEqual(uniqueBooks('Pinnacle'), []);
    assert.deepEqual(uniqueBooks(null), []);
    assert.deepEqual(uniqueBooks(undefined), []);
  });
});

describe('normalizeMarket', () => {
  it('trims and lowercases market names', () => {
    assert.equal(normalizeMarket('  MONEYLINE  '), 'moneyline');
  });

  it('collapses multiple spaces into one', () => {
    assert.equal(normalizeMarket('player   home    runs'), 'player home runs');
  });

  it('returns empty string for nullish input', () => {
    assert.equal(normalizeMarket(null), '');
    assert.equal(normalizeMarket(undefined), '');
  });
});

describe('isNbaLeague / isNflLeague / isMlbLeague', () => {
  it('matches case-insensitively', () => {
    assert.equal(isNbaLeague('nba'), true);
    assert.equal(isNbaLeague('NBA'), true);
    assert.equal(isNbaLeague('Nba'), true);
    assert.equal(isNflLeague('nfl'), true);
    assert.equal(isNflLeague('NFL'), true);
    assert.equal(isMlbLeague('mlb'), true);
    assert.equal(isMlbLeague('MLB'), true);
  });

  it('rejects wrong leagues', () => {
    assert.equal(isNbaLeague('NFL'), false);
    assert.equal(isNflLeague('NBA'), false);
    assert.equal(isMlbLeague('NHL'), false);
  });

  it('handles nullish input', () => {
    assert.equal(isNbaLeague(null), false);
    assert.equal(isNflLeague(undefined), false);
    assert.equal(isMlbLeague(''), false);
  });
});

describe('isPrimaryMainMarket', () => {
  it('recognizes moneyline, spread, and total', () => {
    assert.equal(isPrimaryMainMarket('moneyline'), true);
    assert.equal(isPrimaryMainMarket('spread'), true);
    assert.equal(isPrimaryMainMarket('point spread'), true);
    assert.equal(isPrimaryMainMarket('total'), true);
    assert.equal(isPrimaryMainMarket('team total'), true);
    assert.equal(isPrimaryMainMarket('total runs'), true);
    assert.equal(isPrimaryMainMarket('run line'), true);
  });

  it('returns false for prop markets', () => {
    assert.equal(isPrimaryMainMarket('player points'), false);
    assert.equal(isPrimaryMainMarket('player strikeouts'), false);
  });

  it('returns true for empty or nullish input', () => {
    assert.equal(isPrimaryMainMarket(''), true);
    assert.equal(isPrimaryMainMarket(null), true);
    assert.equal(isPrimaryMainMarket(undefined), true);
  });
});

describe('isMlbMainMarket', () => {
  it('recognizes standard main markets', () => {
    assert.equal(isMlbMainMarket('moneyline'), true);
    assert.equal(isMlbMainMarket('run line'), true);
    assert.equal(isMlbMainMarket('total'), true);
  });

  it('includes first-inning markets', () => {
    assert.equal(isMlbMainMarket('moneyline - 1st inning'), true);
    assert.equal(isMlbMainMarket('run line - 1st inning'), true);
    assert.equal(isMlbMainMarket('total runs - 1st inning'), true);
    assert.equal(isMlbMainMarket('team total runs - 1st inning'), true);
    assert.equal(isMlbMainMarket('first inning'), true);
  });

  it('returns true for empty input', () => {
    assert.equal(isMlbMainMarket(''), true);
    assert.equal(isMlbMainMarket(null), true);
  });
});

describe('isMlbPropMarket', () => {
  it('returns true for non-main MLB markets', () => {
    assert.equal(isMlbPropMarket('player strikeouts'), true);
    assert.equal(isMlbPropMarket('player home runs'), true);
    assert.equal(isMlbPropMarket('pitcher strikeout'), true);
  });

  it('returns false for main markets', () => {
    assert.equal(isMlbPropMarket('moneyline'), false);
    assert.equal(isMlbPropMarket('total'), false);
    assert.equal(isMlbPropMarket('total runs - 1st inning'), false);
  });

  it('returns false for empty or nullish input', () => {
    assert.equal(isMlbPropMarket(''), false);
    assert.equal(isMlbPropMarket(null), false);
  });
});

describe('getSharpBookComparisonSet', () => {
  it('returns requested books when provided', () => {
    assert.deepEqual(getSharpBookComparisonSet({ requestedBooks: ['Pinnacle', 'Circa'] }), ['Pinnacle', 'Circa']);
  });

  it('returns NBA main set for NBA main markets', () => {
    assert.deepEqual(getSharpBookComparisonSet({ league: 'NBA', market: 'moneyline' }), [
      ...NBA_MAIN_MARKET_SHARP_BOOKS
    ]);
  });

  it('returns NBA prop set for NBA prop markets', () => {
    assert.deepEqual(getSharpBookComparisonSet({ league: 'NBA', market: 'player points' }), [
      ...NBA_PROP_MARKET_SHARP_BOOKS
    ]);
    assert.ok(NBA_PROP_MARKET_SHARP_BOOKS.includes('Prop Builder'));
    assert.ok(!NBA_PROP_MARKET_SHARP_BOOKS.includes('PropBuilder'));
    assert.equal(canonicalizeScreenBookName('Prop Builder'), 'Prop Builder');
    assert.equal(canonicalizeScreenBookName('PropBuilder'), 'Prop Builder');
  });

  it('returns NFL main set for NFL main markets', () => {
    assert.deepEqual(getSharpBookComparisonSet({ league: 'NFL', market: 'spread' }), [...NFL_MAIN_MARKET_SHARP_BOOKS]);
  });

  it('returns NFL prop set for NFL prop markets', () => {
    assert.deepEqual(getSharpBookComparisonSet({ league: 'NFL', market: 'player passing yards' }), [
      ...NFL_PROP_MARKET_SHARP_BOOKS
    ]);
  });

  it('returns MLB main set for MLB main markets', () => {
    assert.deepEqual(getSharpBookComparisonSet({ league: 'MLB', market: 'moneyline' }), [
      ...MLB_MAIN_MARKET_SHARP_BOOKS
    ]);
  });

  it('returns MLB prop set for MLB prop markets', () => {
    assert.deepEqual(getSharpBookComparisonSet({ league: 'MLB', market: 'player strikeouts' }), [
      ...MLB_PROP_MARKET_SHARP_BOOKS
    ]);
  });

  it('returns default set for unknown leagues', () => {
    assert.deepEqual(getSharpBookComparisonSet({ league: 'NHL', market: 'moneyline' }), [...DEFAULT_SHARP_BOOKS]);
  });

  it('returns default set when no arguments provided', () => {
    assert.deepEqual(getSharpBookComparisonSet(), [...DEFAULT_SHARP_BOOKS]);
  });
});

describe('getSharpBookContext', () => {
  it('returns NBA main context', () => {
    const ctx = getSharpBookContext({ league: 'NBA', market: 'moneyline' });
    assert.equal(ctx.key, 'nba_main');
    assert.equal(ctx.label, 'NBA main markets');
    assert.deepEqual(ctx.books, [...NBA_MAIN_MARKET_SHARP_BOOKS]);
    assert.ok(ctx.notes.length > 0);
  });

  it('returns NBA props context', () => {
    const ctx = getSharpBookContext({ league: 'NBA', market: 'player points' });
    assert.equal(ctx.key, 'nba_props');
    assert.equal(ctx.label, 'NBA secondary markets and player props');
    assert.deepEqual(ctx.books, [...NBA_PROP_MARKET_SHARP_BOOKS]);
  });

  it('returns NFL main context', () => {
    const ctx = getSharpBookContext({ league: 'NFL', market: 'spread' });
    assert.equal(ctx.key, 'nfl_main');
    assert.equal(ctx.label, 'NFL main markets');
    assert.deepEqual(ctx.books, [...NFL_MAIN_MARKET_SHARP_BOOKS]);
  });

  it('returns NFL props context', () => {
    const ctx = getSharpBookContext({ league: 'NFL', market: 'player rushing yards' });
    assert.equal(ctx.key, 'nfl_props');
    assert.equal(ctx.label, 'NFL secondary markets and player props');
    assert.deepEqual(ctx.books, [...NFL_PROP_MARKET_SHARP_BOOKS]);
  });

  it('returns MLB main context', () => {
    const ctx = getSharpBookContext({ league: 'MLB', market: 'total' });
    assert.equal(ctx.key, 'mlb_main');
    assert.equal(ctx.label, 'MLB main markets');
    assert.deepEqual(ctx.books, [...MLB_MAIN_MARKET_SHARP_BOOKS]);
  });

  it('returns MLB props context with circa confident markets', () => {
    const ctx = getSharpBookContext({ league: 'MLB', market: 'player strikeouts' });
    assert.equal(ctx.key, 'mlb_props');
    assert.equal(ctx.label, 'MLB secondary markets and player props');
    assert.deepEqual(ctx.books, [...MLB_PROP_MARKET_SHARP_BOOKS]);
    assert.deepEqual(ctx.circaFocusedMarkets, [...MLB_PROP_CIRCA_CONFIDENT_MARKETS]);
  });

  it('returns default context for unknown league', () => {
    const ctx = getSharpBookContext({ league: 'NHL', market: 'moneyline' });
    assert.equal(ctx.key, 'default');
    assert.equal(ctx.label, 'Default sharp comparison set');
    assert.deepEqual(ctx.books, [...DEFAULT_SHARP_BOOKS]);
  });

  it('returns default context when no arguments provided', () => {
    const ctx = getSharpBookContext();
    assert.equal(ctx.key, 'default');
  });
});
