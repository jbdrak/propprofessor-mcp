'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { stripExactLineHistoryFields } = require('../scripts/server/handlers/strip-exact-line-history');

const HISTORY_FIELDS = [
  'lineHistory',
  'lineHistoryAvailable',
  'lineHistorySource',
  'movementSourceBook',
  'movementMode',
  'movementLabel',
  'movementDisposition',
  'openingOdds',
  'currentOdds',
  'clvProxyPct',
  'movementSummary',
  'normalizedSelectionId',
  'historyMatchKey',
  'historyGameId',
  'lineVariantUsed',
  'exactLineHistorySuppressed'
];

describe('stripExactLineHistoryFields', () => {
  it('strips history fields for exact nested rows', () => {
    const row = Object.fromEntries(HISTORY_FIELDS.map((field) => [field, 'remove']));
    row.lineVariantUsed = 'exact_nested';

    stripExactLineHistoryFields([row]);

    for (const field of HISTORY_FIELDS) assert.equal(row[field], undefined, `${field} should be removed`);
  });

  it('strips history fields for explicitly suppressed rows', () => {
    const row = Object.fromEntries(HISTORY_FIELDS.map((field) => [field, 'remove']));
    row.exactLineHistorySuppressed = true;

    stripExactLineHistoryFields([row]);

    for (const field of HISTORY_FIELDS) assert.equal(row[field], undefined, `${field} should be removed`);
  });

  it('keeps history fields on ordinary rows', () => {
    const row = Object.fromEntries(HISTORY_FIELDS.map((field) => [field, 'keep']));
    row.lineVariantUsed = 'standard';
    row.exactLineHistorySuppressed = false;

    stripExactLineHistoryFields([row]);

    for (const field of HISTORY_FIELDS) {
      const expected =
        field === 'lineVariantUsed' ? 'standard' : field === 'exactLineHistorySuppressed' ? false : 'keep';
      assert.equal(row[field], expected);
    }
  });
});
