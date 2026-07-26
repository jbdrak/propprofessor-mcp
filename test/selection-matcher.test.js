'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  findBestMatch,
  normalizeKey,
  stripLine,
  stripOverUnder,
  extractNumeric
} = require('../lib/selection-matcher.js');

// ── unit tests ──

test('stripLine removes trailing spread', () => {
  assert.strictEqual(stripLine('Harris -1.5'), 'Harris');
  assert.strictEqual(stripLine('Nadal +2.5'), 'Nadal');
  assert.strictEqual(stripLine('Over 22.5'), 'Over');
  assert.strictEqual(stripLine('Under 5.5 games'), 'Under');
  assert.strictEqual(stripLine('Moneyline'), 'Moneyline');
  assert.strictEqual(stripLine(''), '');
});

test('stripOverUnder removes Over/Under prefix', () => {
  assert.strictEqual(stripOverUnder('Over 22.5'), '22.5');
  assert.strictEqual(stripOverUnder('Under 8.5'), '8.5');
  assert.strictEqual(stripOverUnder('Moneyline'), 'Moneyline');
  assert.strictEqual(stripOverUnder(''), '');
});

test('extractNumeric pulls first number', () => {
  assert.strictEqual(extractNumeric('over 22.5'), '22.5');
  assert.strictEqual(extractNumeric('nadal -1.5'), '1.5');
  assert.strictEqual(extractNumeric('moneyline'), null);
});

test('normalizeKey trims and lowercases', () => {
  assert.strictEqual(normalizeKey('  OVER 22.5  '), 'over 22.5');
  assert.strictEqual(normalizeKey(''), '');
});

// ── integration tests ──

test('exact match wins over stripped', () => {
  const rows = [
    { selection: 'Over 22.5', gameId: '1' },
    { selection: 'Over 24.5', gameId: '2' }
  ];
  const result = findBestMatch(rows, 'Over 22.5');
  assert.strictEqual(result.gameId, '1');
});

test('numeric guard prevents cross-line Over/Under match', () => {
  const rows = [
    { selection: 'Over 22.5', gameId: '1' },
    { selection: 'Over 24.5', gameId: '2' }
  ];
  // "Over 22.5" → strippedTo "over" would match both without guard
  const result = findBestMatch(rows, 'Over 24.5');
  assert.strictEqual(result.gameId, '2');
});

test('numeric guard prevents cross-line spread match', () => {
  const rows = [
    { selection: 'Nadal -1.5', participant: 'Nadal', gameId: '1' },
    { selection: 'Nadal -2.5', participant: 'Nadal', gameId: '2' }
  ];
  const result = findBestMatch(rows, 'Nadal -1.5');
  assert.strictEqual(result.gameId, '1');
});

test('fallback to stripped line when exact fails', () => {
  const rows = [{ selection: 'Harris -1.5', gameId: '1' }];
  const result = findBestMatch(rows, 'Harris');
  assert.strictEqual(result.gameId, '1');
});

test('fallback to stripped Over/Under match', () => {
  const rows = [{ selection: 'Under 8.5', gameId: '1' }];
  const result = findBestMatch(rows, 'Under');
  assert.strictEqual(result.gameId, '1');
});

test('playId exact match takes priority', () => {
  const rows = [
    { selection: 'Something Else', playId: 'exact-id', gameId: '2' },
    { selection: 'Over 22.5', gameId: '1' }
  ];
  const result = findBestMatch(rows, 'Over 22.5', 'exact-id');
  assert.strictEqual(result.gameId, '2');
});

test('nested selection match', () => {
  const rows = [
    {
      gameId: 'nested',
      selections: {
        null: {
          selection1: 'PlayerA',
          selection2: 'PlayerB'
        }
      }
    }
  ];
  const result = findBestMatch(rows, 'PlayerB');
  assert.strictEqual(result.gameId, 'nested');
});

test('nested total container must not return wrong-line odds (166.5 vs 173.5)', () => {
  // Repro of the 2026-07-11 WNBA bug: get_play_details returns one container row
  // per market (participant "Under 173.5", odds -143) with every line nested
  // under selections[]. A request for "Under 166.5" must NOT resolve to the
  // container's -143 — it must yield 166.5's own odds (+125).
  const rows = [
    {
      gameId: 'wnba-aces-mercury',
      participant: 'Under 173.5',
      selection: 'Under 173.5',
      odds: -143,
      consensusBookCount: 9,
      executionQuality: 'best',
      selections: {
        166.5: {
          selection1: 'Over 166.5',
          selection2: 'Under 166.5',
          odds: {
            NoVigApp: { book: 'NoVigApp', odds1: -163, odds2: 125, liquidity1: 841, liquidity2: 442 }
          }
        },
        173.5: {
          selection1: 'Over 173.5',
          selection2: 'Under 173.5',
          odds: {
            NoVigApp: { book: 'NoVigApp', odds1: 138, odds2: -143, liquidity1: 0, liquidity2: 0 }
          }
        }
      }
    }
  ];
  const result = findBestMatch(rows, 'Under 166.5', '', 'NoVigApp');
  assert.ok(result, 'expected a match');
  assert.strictEqual(result.selection, 'Under 166.5', 'selection must be the exact requested line, not the container');
  assert.strictEqual(result.odds, 125, 'odds must be 166.5 Under (+125), NOT the container 173.5 (-143)');
  // Cross-line matches intentionally zero container aggregates so a wrong-line
  // consensus cannot poison validation. The nested line's own odds map here has
  // only one book, so consensusBookCount must reflect that.
  assert.strictEqual(
    result.consensusBookCount,
    1,
    'nested line book count replaces container aggregate to avoid consensus poisoning'
  );
});

test('nested total where request IS the container line returns the row as-is', () => {
  const rows = [
    {
      gameId: 'g1',
      participant: 'Under 173.5',
      odds: -143,
      selections: {
        173.5: {
          selection1: 'Over 173.5',
          selection2: 'Under 173.5',
          odds: { NoVigApp: { book: 'NoVigApp', odds1: 138, odds2: -143 } }
        }
      }
    }
  ];
  const result = findBestMatch(rows, 'Under 173.5', '', 'NoVigApp');
  assert.strictEqual(result.odds, -143, 'container line matches as-is');
  assert.strictEqual(result.nestedMatchLine, undefined, 'no synthetic row when line == container');
});

test('home team includes fallback', () => {
  const rows = [{ homeTeam: 'Lakers', awayTeam: 'Celtics', gameId: 'lal-bos' }];
  const result = findBestMatch(rows, 'Celtics');
  assert.strictEqual(result.gameId, 'lal-bos');
});

test('returns null when no match', () => {
  const rows = [{ selection: 'Something', gameId: '1' }];
  assert.strictEqual(findBestMatch(rows, 'Nothing'), null);
});

test('returns null for empty inputs', () => {
  assert.strictEqual(findBestMatch([], 'Anything'), null);
  assert.strictEqual(findBestMatch(null, 'Anything'), null);
});
