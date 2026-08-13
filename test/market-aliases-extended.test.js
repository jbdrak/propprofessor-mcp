'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { MARKET_ALIASES, resolveMarketName } = require('../lib/propprofessor-shared-utils');

const { getAltMarketBooks, getSharpBookComparisonSet } = require('../lib/propprofessor-sharp-books');

const { resolveMarkets } = require('../scripts/server/handlers/handler-utils');

describe('resolveMarkets singular/plural inputs', () => {
  it('resolves singular NBA total exactly like the equivalent array', () => {
    assert.deepEqual(resolveMarkets({ market: 'total' }, 'NBA'), resolveMarkets({ markets: ['total'] }, 'NBA'));
    assert.equal(resolveMarkets({ market: 'total' }, 'NBA').single, 'Total Points');
  });

  it('resolves singular MLB spread exactly like the equivalent array', () => {
    assert.deepEqual(resolveMarkets({ market: 'Spread' }, 'MLB'), resolveMarkets({ markets: ['Spread'] }, 'MLB'));
    assert.equal(resolveMarkets({ market: 'Spread' }, 'MLB').single, 'Run Line');
  });
});

describe('MARKET_ALIASES completeness', () => {
  it('has entries for total, spread, and common aliases', () => {
    assert.ok(MARKET_ALIASES.total, 'Missing total alias');
    assert.ok(MARKET_ALIASES.spread, 'Missing spread alias');
    assert.ok(MARKET_ALIASES.puck_line, 'Missing puck_line alias');
    assert.ok(MARKET_ALIASES.run_line, 'Missing run_line alias');
  });

  it('every alias maps to a non-empty object', () => {
    for (const [alias, map] of Object.entries(MARKET_ALIASES)) {
      assert.ok(typeof map === 'object' && map !== null, `${alias} should be an object`);
      assert.ok(Object.keys(map).length > 0, `${alias} should have at least one entry`);
    }
  });

  it('every alias value is a string', () => {
    for (const [alias, map] of Object.entries(MARKET_ALIASES)) {
      for (const [league, value] of Object.entries(map)) {
        assert.equal(typeof value, 'string', `${alias}.${league} should be a string`);
        assert.ok(value.length > 0, `${alias}.${league} should not be empty`);
      }
    }
  });
});

describe('resolveMarketName — MLB', () => {
  it('Total → Total Runs', () => {
    const r = resolveMarketName('Total', 'MLB');
    assert.equal(r.resolved, 'Total Runs');
    assert.equal(r.wasAliased, true);
  });

  it('Spread → Run Line', () => {
    const r = resolveMarketName('Spread', 'MLB');
    assert.equal(r.resolved, 'Run Line');
    assert.equal(r.wasAliased, true);
  });

  it('Moneyline passes through', () => {
    const r = resolveMarketName('Moneyline', 'MLB');
    assert.equal(r.resolved, 'Moneyline');
    assert.equal(r.wasAliased, false);
  });
});

describe('resolveMarketName — NBA', () => {
  it('Total → Total Points', () => {
    const r = resolveMarketName('Total', 'NBA');
    assert.equal(r.resolved, 'Total Points');
    assert.equal(r.wasAliased, true);
  });

  it('Spread → Point Spread (NBA canonical)', () => {
    const r = resolveMarketName('Spread', 'NBA');
    assert.equal(r.resolved, 'Point Spread');
    assert.equal(r.wasAliased, true);
  });

  it('Handicap → Point Spread (NBA)', () => {
    const r = resolveMarketName('Handicap', 'NBA');
    assert.equal(r.resolved, 'Point Spread');
    assert.equal(r.wasAliased, true);
  });
});

describe('resolveMarketName — WNBA', () => {
  it('Total → Total Points', () => {
    const r = resolveMarketName('Total', 'WNBA');
    assert.equal(r.resolved, 'Total Points');
    assert.equal(r.wasAliased, true);
  });

  it('Spread → Point Spread (WNBA canonical — was "Spread" pre-2026-06-12 fix)', () => {
    const r = resolveMarketName('Spread', 'WNBA');
    assert.equal(r.resolved, 'Point Spread');
    assert.equal(r.wasAliased, true);
  });
});

describe('resolveMarketName — NHL', () => {
  it('Total → Total Goals', () => {
    const r = resolveMarketName('Total', 'NHL');
    assert.equal(r.resolved, 'Total Goals');
    assert.equal(r.wasAliased, true);
  });

  it('Spread → Puck Line', () => {
    const r = resolveMarketName('Spread', 'NHL');
    assert.equal(r.resolved, 'Puck Line');
    assert.equal(r.wasAliased, true);
  });
});

describe('resolveMarketName — SOCCER', () => {
  it('Total → Total Goals', () => {
    const r = resolveMarketName('Total', 'SOCCER');
    assert.equal(r.resolved, 'Total Goals');
    assert.equal(r.wasAliased, true);
  });

  it('Spread → Match Handicap (SOCCER canonical — was "Spread" pre-2026-06-12 fix)', () => {
    const r = resolveMarketName('Spread', 'SOCCER');
    assert.equal(r.resolved, 'Match Handicap');
    assert.equal(r.wasAliased, true);
  });
});

describe('resolveMarketName — UFC', () => {
  it('Total → Total Rounds', () => {
    const r = resolveMarketName('Total', 'UFC');
    assert.equal(r.resolved, 'Total Rounds');
    assert.equal(r.wasAliased, true);
  });
});

describe('resolveMarketName — case insensitivity', () => {
  it('lowercase total resolves for MLB', () => {
    const r = resolveMarketName('total', 'MLB');
    assert.equal(r.resolved, 'Total Runs');
  });

  it('mixed case Total resolves for NHL', () => {
    const r = resolveMarketName('ToTaL', 'NHL');
    assert.equal(r.resolved, 'Total Goals');
  });
});

describe('resolveMarketName — whitespace', () => {
  it('trims whitespace before resolving', () => {
    const r = resolveMarketName('  Total  ', 'MLB');
    assert.equal(r.resolved, 'Total Runs');
    assert.equal(r.original, 'Total');
  });
});

describe('resolveMarketName — unknown markets', () => {
  it('passes through unknown market for MLB', () => {
    const r = resolveMarketName('Player Props', 'MLB');
    assert.equal(r.resolved, 'Player Props');
    assert.equal(r.wasAliased, false);
  });

  it('passes through unknown league with known alias', () => {
    // NFL doesn't have a specific entry, but 'total' alias may have a default
    const r = resolveMarketName('SomeWeirdMarket', 'NFL');
    assert.equal(r.resolved, 'SomeWeirdMarket');
    assert.equal(r.wasAliased, false);
  });

  it('empty string resolves to default (Moneyline)', () => {
    const r = resolveMarketName('', 'MLB');
    assert.equal(r.resolved, 'Moneyline');
    assert.equal(r.wasAliased, false);
  });
});

describe('getAltMarketBooks', () => {
  it('returns books for MLB Run Line', () => {
    const books = getAltMarketBooks({ league: 'MLB', market: 'Run Line' });
    assert.ok(Array.isArray(books));
    assert.ok(books.length >= 5);
    assert.ok(books.includes('Pinnacle'));
    assert.ok(books.includes('DraftKings'));
  });

  it('returns books for NHL Puck Line', () => {
    const books = getAltMarketBooks({ league: 'NHL', market: 'Puck Line' });
    assert.ok(Array.isArray(books));
    assert.ok(books.length >= 5);
  });

  it('returns books for NBA Point Spread', () => {
    const books = getAltMarketBooks({ league: 'NBA', market: 'Point Spread' });
    assert.ok(Array.isArray(books));
    assert.ok(books.length >= 5);
  });

  it('returns books for WNBA Point Spread', () => {
    const books = getAltMarketBooks({ league: 'WNBA', market: 'Point Spread' });
    assert.ok(Array.isArray(books));
    assert.ok(books.length >= 5);
  });

  it('returns null for unknown league', () => {
    const books = getAltMarketBooks({ league: 'NFL', market: 'Point Spread' });
    assert.equal(books, null);
  });

  it('returns null for unknown market in known league', () => {
    const books = getAltMarketBooks({ league: 'MLB', market: 'Player Props' });
    assert.equal(books, null);
  });

  it('returns books for MLB Total (alias for Total Runs)', () => {
    const books = getAltMarketBooks({ league: 'MLB', market: 'Total' });
    assert.ok(Array.isArray(books));
    assert.ok(books.length >= 5);
  });
});

describe('getSharpBookComparisonSet — alt market books', () => {
  it('returns alt-market books for MLB Run Line', () => {
    const books = getSharpBookComparisonSet({ league: 'MLB', market: 'Run Line' });
    assert.ok(books.includes('Pinnacle'));
    assert.ok(books.length >= 5);
  });

  it('returns alt-market books for NHL Puck Line', () => {
    const books = getSharpBookComparisonSet({ league: 'NHL', market: 'Puck Line' });
    assert.ok(books.includes('Pinnacle'));
    assert.ok(books.length >= 5);
  });

  it('returns default sharp books for Moneyline (primary market)', () => {
    const books = getSharpBookComparisonSet({ league: 'MLB', market: 'Moneyline' });
    assert.ok(books.includes('Pinnacle'));
    assert.ok(books.length >= 3);
  });

  it('respects requested books override', () => {
    const books = getSharpBookComparisonSet({
      league: 'MLB',
      market: 'Run Line',
      requestedBooks: ['FanDuel']
    });
    assert.deepEqual(books, ['FanDuel']);
  });
});
