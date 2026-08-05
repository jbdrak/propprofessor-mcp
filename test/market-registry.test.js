'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_LEAGUES, resolveMarketName } = require('../lib/propprofessor-shared-utils');
const { MARKET_REGISTRY, getMarketsForSport } = require('../lib/propprofessor-market-registry');

// Intentional exceptions to the "every default league has a registry entry"
// invariant. Document WHY each league is exceptional so future maintainers
// know the fallback is deliberate, not a drift bug.
const INTENTIONALLY_GENERIC_LEAGUES = {
  NBASL:
    'NBA Summer League shares the NBA odds feed; it intentionally uses the generic ' +
    'fallback markets (Moneyline/Spread/Total) rather than a dedicated registry entry.'
};

test('MLS is a supported league with soccer markets', () => {
  assert.ok(DEFAULT_LEAGUES.includes('MLS'));
  assert.deepEqual(getMarketsForSport('MLS', 'NoVigApp'), ['Draw No Bet', 'Match Handicap', 'Total Goals']);
  assert.deepEqual(getMarketsForSport('mls'), ['Draw No Bet', 'Match Handicap', 'Total Goals']);
});

test('MLS resolves generic market aliases to soccer-style markets', () => {
  assert.deepEqual(resolveMarketName('Moneyline', 'MLS').resolved, 'Draw No Bet');
  assert.deepEqual(resolveMarketName('Spread', 'MLS').resolved, 'Match Handicap');
  assert.deepEqual(resolveMarketName('Total', 'MLS').resolved, 'Total Goals');
  assert.deepEqual(resolveMarketName('Draw No Bet', 'MLS').resolved, 'Draw No Bet');
  assert.deepEqual(resolveMarketName('Match Handicap', 'MLS').resolved, 'Match Handicap');
  assert.deepEqual(resolveMarketName('Total Goals', 'MLS').resolved, 'Total Goals');
});

test('Tennis registry defaults exclude Set Handicap (explicit-only market)', () => {
  assert.deepEqual(getMarketsForSport('Tennis'), ['Moneyline', 'Game Handicap', 'Total Games']);
});

test('every default league has a non-empty market definition', () => {
  for (const league of DEFAULT_LEAGUES) {
    if (INTENTIONALLY_GENERIC_LEAGUES[league]) continue;
    assert.ok(MARKET_REGISTRY[league], `${league} must have a market registry entry`);
    assert.ok(getMarketsForSport(league).length > 0, `${league} must have default markets`);
  }
});

test('every registry entry used by default scanning has a non-empty default market list', () => {
  for (const [league, entry] of Object.entries(MARKET_REGISTRY)) {
    assert.ok(
      Array.isArray(entry.default) && entry.default.length > 0,
      `${league} must define a non-empty "default" market list`
    );
  }
});

test('registry exception list is documented and matches reality', () => {
  // Every DEFAULT_LEAGUES league must either have a registry entry or be a
  // documented exception — no silent drift in either direction.
  const documented = Object.keys(INTENTIONALLY_GENERIC_LEAGUES);
  for (const league of DEFAULT_LEAGUES) {
    const hasEntry = Object.keys(MARKET_REGISTRY).some((k) => k.toUpperCase() === league.toUpperCase());
    if (!hasEntry) {
      assert.ok(
        documented.includes(league),
        `${league} has no registry entry but is not a documented exception: ${documented.join(', ')}`
      );
    }
  }
  // And every documented exception must actually be missing from the registry
  // (so a future registry entry for NBASL forces a conscious decision here).
  for (const league of documented) {
    assert.ok(!MARKET_REGISTRY[league], `${league} is documented as an exception but now has a registry entry`);
  }
});
