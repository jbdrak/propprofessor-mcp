'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { normalizeRow } = require('../lib/ssb-shared-utils');

describe('normalizeRow', () => {
  it('lifts selections.null contents to top level', () => {
    const input = {
      selections: { null: { selection1: 'Lakers', selection2: 'Celtics', odds1: -135, odds2: 125 } },
      defaultKey: 'null',
      market: 'Moneyline'
    };
    const result = normalizeRow(input);

    // selection1, selection2, odds1, odds2 should be lifted to top level
    assert.strictEqual(result.selection1, 'Lakers', 'selection1 should be lifted to top level');
    assert.strictEqual(result.selection2, 'Celtics', 'selection2 should be lifted to top level');
    assert.strictEqual(result.odds1, -135, 'odds1 should be lifted to top level');
    assert.strictEqual(result.odds2, 125, 'odds2 should be lifted to top level');

    // selections.null key should be gone
    assert.strictEqual(result.selections?.null, undefined, 'selections.null key should be removed');
  });

  it('drops defaultKey when it is "null"', () => {
    const input = {
      selections: { null: { selection1: 'Lakers', odds1: -135 } },
      defaultKey: 'null',
      market: 'Moneyline'
    };
    const result = normalizeRow(input);

    assert.strictEqual(result.defaultKey, undefined, 'defaultKey should be removed when it is the string "null"');
  });

  it('preserves player prop selections', () => {
    const input = {
      selections: { 'LeBron James': { selection: 'Over', odds: -110 } },
      defaultKey: 'LeBron James',
      market: 'Player Points'
    };
    const result = normalizeRow(input);

    // Player prop selections should NOT be modified
    assert.ok(result.selections?.['LeBron James'], 'selections.LeBron James should be preserved');
    assert.strictEqual(result.defaultKey, 'LeBron James', 'defaultKey should be preserved for player props');
    assert.strictEqual(result.market, 'Player Points', 'market should be preserved');
  });

  it('handles rows without selections', () => {
    const input = {
      selection: 'Lakers',
      odds: -135,
      market: 'Moneyline'
    };
    const result = normalizeRow(input);

    assert.strictEqual(result.selection, 'Lakers', 'selection should be preserved');
    assert.strictEqual(result.odds, -135, 'odds should be preserved');
  });

  it('does not mutate input', () => {
    const input = {
      selections: { null: { selection1: 'Lakers', odds1: -135 } },
      defaultKey: 'null',
      market: 'Moneyline'
    };
    const originalSelections = JSON.stringify(input.selections);
    const originalDefaultKey = input.defaultKey;

    normalizeRow(input);

    assert.strictEqual(JSON.stringify(input.selections), originalSelections, 'input.selections should not be mutated');
    assert.strictEqual(input.defaultKey, originalDefaultKey, 'input.defaultKey should not be mutated');
  });

  it('handles selections.null with odds map', () => {
    const input = {
      selections: {
        null: {
          selection1: 'Over',
          selection2: 'Under',
          odds: {
            Pinnacle: { odds1: -110, odds2: -110 }
          }
        }
      },
      defaultKey: 'null',
      market: 'Total Points',
      game: 'Lakers vs Celtics'
    };
    const result = normalizeRow(input);

    assert.strictEqual(result.selection1, 'Over', 'selection1 should be lifted');
    assert.strictEqual(result.selection2, 'Under', 'selection2 should be lifted');
    assert.deepStrictEqual(result.odds, { Pinnacle: { odds1: -110, odds2: -110 } }, 'odds should be lifted');
    assert.strictEqual(result.market, 'Total Points', 'market should be preserved');
    assert.strictEqual(result.game, 'Lakers vs Celtics', 'game should be preserved');
    assert.strictEqual(result.selections?.null, undefined, 'selections.null should be removed');
  });
});
