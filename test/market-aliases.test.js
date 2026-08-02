'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { MARKET_ALIASES, resolveMarketName } = require('../lib/propprofessor-shared-utils');

test('MARKET_ALIASES structure', async (t) => {
  await t.test('is defined', () => {
    assert.ok(MARKET_ALIASES !== undefined && typeof MARKET_ALIASES === 'object');
  });
  await t.test('total exists', () => {
    assert.ok(MARKET_ALIASES.total !== undefined && typeof MARKET_ALIASES.total === 'object');
  });
  await t.test('spread exists', () => {
    assert.ok(MARKET_ALIASES.spread !== undefined && typeof MARKET_ALIASES.spread === 'object');
  });
  await t.test('puck_line exists', () => {
    assert.ok(MARKET_ALIASES.puck_line !== undefined);
  });
  await t.test('run_line exists', () => {
    assert.ok(MARKET_ALIASES.run_line !== undefined);
  });
  await t.test('total_goals exists', () => {
    assert.ok(MARKET_ALIASES.total_goals !== undefined);
  });
  await t.test('total_runs exists', () => {
    assert.ok(MARKET_ALIASES.total_runs !== undefined);
  });
  await t.test('total_points exists', () => {
    assert.ok(MARKET_ALIASES.total_points !== undefined);
  });
});

test('resolveMarketName Total aliases', async (t) => {
  await t.test('"Total" + NHL -> "Total Goals"', () => {
    assert.deepStrictEqual(resolveMarketName('Total', 'NHL'), {
      resolved: 'Total Goals',
      wasAliased: true,
      original: 'Total',
      aliasKey: 'total'
    });
  });
  await t.test('"Total" + MLB -> "Total Runs"', () => {
    assert.deepStrictEqual(resolveMarketName('Total', 'MLB'), {
      resolved: 'Total Runs',
      wasAliased: true,
      original: 'Total',
      aliasKey: 'total'
    });
  });
  await t.test('"Total" + NBA -> "Total Points"', () => {
    assert.deepStrictEqual(resolveMarketName('Total', 'NBA'), {
      resolved: 'Total Points',
      wasAliased: true,
      original: 'Total',
      aliasKey: 'total'
    });
  });
  await t.test('"Total" + WNBA -> "Total Points"', () => {
    assert.deepStrictEqual(resolveMarketName('Total', 'WNBA'), {
      resolved: 'Total Points',
      wasAliased: true,
      original: 'Total',
      aliasKey: 'total'
    });
  });
  await t.test('"Total" + SOCCER -> "Total Goals"', () => {
    assert.deepStrictEqual(resolveMarketName('Total', 'SOCCER'), {
      resolved: 'Total Goals',
      wasAliased: true,
      original: 'Total',
      aliasKey: 'total'
    });
  });
});

test('resolveMarketName Spread aliases', async (t) => {
  await t.test('"Spread" + NHL -> "Puck Line"', () => {
    assert.deepStrictEqual(resolveMarketName('Spread', 'NHL'), {
      resolved: 'Puck Line',
      wasAliased: true,
      original: 'Spread',
      aliasKey: 'spread'
    });
  });
  await t.test('"Spread" + MLB -> "Run Line"', () => {
    assert.deepStrictEqual(resolveMarketName('Spread', 'MLB'), {
      resolved: 'Run Line',
      wasAliased: true,
      original: 'Spread',
      aliasKey: 'spread'
    });
  });
  await t.test('"Spread" + NBA -> "Point Spread"', () => {
    assert.deepStrictEqual(resolveMarketName('Spread', 'NBA'), {
      resolved: 'Point Spread',
      wasAliased: true,
      original: 'Spread',
      aliasKey: 'spread'
    });
  });
  await t.test('"Spread" + WNBA -> "Point Spread"', () => {
    assert.deepStrictEqual(resolveMarketName('Spread', 'WNBA'), {
      resolved: 'Point Spread',
      wasAliased: true,
      original: 'Spread',
      aliasKey: 'spread'
    });
  });
  await t.test('"Spread" + NCAAB -> "Point Spread"', () => {
    assert.deepStrictEqual(resolveMarketName('Spread', 'NCAAB'), {
      resolved: 'Point Spread',
      wasAliased: true,
      original: 'Spread',
      aliasKey: 'spread'
    });
  });
  await t.test('"Spread" + NCAAF -> "Point Spread"', () => {
    assert.deepStrictEqual(resolveMarketName('Spread', 'NCAAF'), {
      resolved: 'Point Spread',
      wasAliased: true,
      original: 'Spread',
      aliasKey: 'spread'
    });
  });
  await t.test('"Spread" + NFL -> "Point Spread"', () => {
    assert.deepStrictEqual(resolveMarketName('Spread', 'NFL'), {
      resolved: 'Point Spread',
      wasAliased: true,
      original: 'Spread',
      aliasKey: 'spread'
    });
  });
  await t.test('"Spread" + SOCCER -> "Match Handicap"', () => {
    assert.deepStrictEqual(resolveMarketName('Spread', 'SOCCER'), {
      resolved: 'Match Handicap',
      wasAliased: true,
      original: 'Spread',
      aliasKey: 'spread'
    });
  });
  await t.test('"Spread" + TENNIS -> "Game Handicap"', () => {
    assert.deepStrictEqual(resolveMarketName('Spread', 'TENNIS'), {
      resolved: 'Game Handicap',
      wasAliased: true,
      original: 'Spread',
      aliasKey: 'spread'
    });
  });
});

test('resolveMarketName Handicap alias', async (t) => {
  await t.test('"Handicap" + NBA -> "Point Spread"', () => {
    assert.deepStrictEqual(resolveMarketName('Handicap', 'NBA'), {
      resolved: 'Point Spread',
      wasAliased: true,
      original: 'Handicap',
      aliasKey: 'handicap'
    });
  });
  await t.test('"Handicap" + WNBA -> "Point Spread"', () => {
    assert.deepStrictEqual(resolveMarketName('Handicap', 'WNBA'), {
      resolved: 'Point Spread',
      wasAliased: true,
      original: 'Handicap',
      aliasKey: 'handicap'
    });
  });
  await t.test('"Handicap" + NHL -> "Puck Line"', () => {
    assert.deepStrictEqual(resolveMarketName('Handicap', 'NHL'), {
      resolved: 'Puck Line',
      wasAliased: true,
      original: 'Handicap',
      aliasKey: 'handicap'
    });
  });
});

test('resolveMarketName case/whitespace/shorthand', async (t) => {
  await t.test('whitespace trimmed + Total -> "Total Goals"', () => {
    assert.deepStrictEqual(resolveMarketName('  total  ', 'NHL'), {
      resolved: 'Total Goals',
      wasAliased: true,
      original: 'total',
      aliasKey: 'total'
    });
  });
  await t.test('uppercase TOTAL -> "Total Goals"', () => {
    assert.deepStrictEqual(resolveMarketName('TOTAL', 'NHL'), {
      resolved: 'Total Goals',
      wasAliased: true,
      original: 'TOTAL',
      aliasKey: 'total'
    });
  });
  await t.test('"rl" + MLB -> "Run Line"', () => {
    assert.deepStrictEqual(resolveMarketName('rl', 'MLB'), {
      resolved: 'Run Line',
      wasAliased: true,
      original: 'rl',
      aliasKey: 'rl'
    });
  });
  await t.test('"pl" + NHL -> "Puck Line"', () => {
    assert.deepStrictEqual(resolveMarketName('pl', 'NHL'), {
      resolved: 'Puck Line',
      wasAliased: true,
      original: 'pl',
      aliasKey: 'pl'
    });
  });
  await t.test('"run line" + MLB -> "Run Line"', () => {
    assert.deepStrictEqual(resolveMarketName('run line', 'MLB'), {
      resolved: 'Run Line',
      wasAliased: true,
      original: 'run line',
      aliasKey: 'run_line'
    });
  });
});

test('resolveMarketName passthrough and defaults', async (t) => {
  await t.test('"Moneyline" + NBA -> passthrough', () => {
    assert.deepStrictEqual(resolveMarketName('Moneyline', 'NBA'), {
      resolved: 'Moneyline',
      wasAliased: false,
      original: 'Moneyline',
      aliasKey: null
    });
  });
  await t.test('"Puck Line" + NHL -> alias recognized, resolved same', () => {
    assert.deepStrictEqual(resolveMarketName('Puck Line', 'NHL'), {
      resolved: 'Puck Line',
      wasAliased: true,
      original: 'Puck Line',
      aliasKey: 'puck_line'
    });
  });
  await t.test('undefined + NBA -> "Moneyline" (default)', () => {
    assert.deepStrictEqual(resolveMarketName(undefined, 'NBA'), {
      resolved: 'Moneyline',
      wasAliased: false,
      original: '',
      aliasKey: null
    });
  });
  await t.test('empty string + NHL -> "Moneyline" (default)', () => {
    assert.deepStrictEqual(resolveMarketName('', 'NHL'), {
      resolved: 'Moneyline',
      wasAliased: false,
      original: '',
      aliasKey: null
    });
  });
  await t.test('unknown market -> passthrough', () => {
    assert.deepStrictEqual(resolveMarketName('Unknown Market', 'NBA'), {
      resolved: 'Unknown Market',
      wasAliased: false,
      original: 'Unknown Market',
      aliasKey: null
    });
  });
});

test('resolveMarketName canonical names with alias entries', async (t) => {
  await t.test('"Total Goals" + NHL -> alias recognized', () => {
    assert.deepStrictEqual(resolveMarketName('Total Goals', 'NHL'), {
      resolved: 'Total Goals',
      wasAliased: true,
      original: 'Total Goals',
      aliasKey: 'total_goals'
    });
  });
  await t.test('"Total Points" + NBA -> alias recognized', () => {
    assert.deepStrictEqual(resolveMarketName('Total Points', 'NBA'), {
      resolved: 'Total Points',
      wasAliased: true,
      original: 'Total Points',
      aliasKey: 'total_points'
    });
  });
});

test('resolveMarketName MLS aliases route to soccer-style markets', async (t) => {
  // MLS mirrors Soccer: Draw No Bet / Match Handicap / Total Goals. Every
  // alias group that routes those markets must carry an MLS key — a missed
  // group silently passes the generic name through and the backend returns
  // nothing. See test/market-registry.test.js for the drift guard.
  await t.test('"Moneyline" + MLS -> "Draw No Bet"', () => {
    assert.deepStrictEqual(resolveMarketName('Moneyline', 'MLS'), {
      resolved: 'Draw No Bet',
      wasAliased: true,
      original: 'Moneyline',
      aliasKey: 'moneyline'
    });
  });
  await t.test('"Spread" + MLS -> "Match Handicap"', () => {
    assert.deepStrictEqual(resolveMarketName('Spread', 'MLS'), {
      resolved: 'Match Handicap',
      wasAliased: true,
      original: 'Spread',
      aliasKey: 'spread'
    });
  });
  await t.test('"Total" + MLS -> "Total Goals"', () => {
    assert.deepStrictEqual(resolveMarketName('Total', 'MLS'), {
      resolved: 'Total Goals',
      wasAliased: true,
      original: 'Total',
      aliasKey: 'total'
    });
  });
  await t.test('"Draw No Bet" + MLS -> "Draw No Bet" (canonical)', () => {
    assert.deepStrictEqual(resolveMarketName('Draw No Bet', 'MLS'), {
      resolved: 'Draw No Bet',
      wasAliased: true,
      original: 'Draw No Bet',
      aliasKey: 'draw_no_bet'
    });
  });
  await t.test('"Match Handicap" + MLS -> "Match Handicap" (canonical)', () => {
    assert.deepStrictEqual(resolveMarketName('Match Handicap', 'MLS'), {
      resolved: 'Match Handicap',
      wasAliased: true,
      original: 'Match Handicap',
      aliasKey: 'match_handicap'
    });
  });
  await t.test('"Total Goals" + MLS -> "Total Goals" (canonical)', () => {
    assert.deepStrictEqual(resolveMarketName('Total Goals', 'MLS'), {
      resolved: 'Total Goals',
      wasAliased: true,
      original: 'Total Goals',
      aliasKey: 'total_goals'
    });
  });
  await t.test('"Handicap" + MLS -> "Match Handicap"', () => {
    assert.deepStrictEqual(resolveMarketName('Handicap', 'MLS'), {
      resolved: 'Match Handicap',
      wasAliased: true,
      original: 'Handicap',
      aliasKey: 'handicap'
    });
  });
  await t.test('"Game Handicap" + MLS -> "Match Handicap"', () => {
    assert.deepStrictEqual(resolveMarketName('Game Handicap', 'MLS'), {
      resolved: 'Match Handicap',
      wasAliased: true,
      original: 'Game Handicap',
      aliasKey: 'game_handicap'
    });
  });
  await t.test('"Over/Under" + MLS -> "Total Goals"', () => {
    assert.deepStrictEqual(resolveMarketName('Over/Under', 'MLS'), {
      resolved: 'Total Goals',
      wasAliased: true,
      original: 'Over/Under',
      aliasKey: 'over/under'
    });
  });
  await t.test('"OU" + MLS -> "Total Goals"', () => {
    assert.deepStrictEqual(resolveMarketName('OU', 'MLS'), {
      resolved: 'Total Goals',
      wasAliased: true,
      original: 'OU',
      aliasKey: 'ou'
    });
  });
  await t.test('"Total Games" + MLS -> "Total Goals"', () => {
    assert.deepStrictEqual(resolveMarketName('Total Games', 'MLS'), {
      resolved: 'Total Goals',
      wasAliased: true,
      original: 'Total Games',
      aliasKey: 'total_games'
    });
  });
});
