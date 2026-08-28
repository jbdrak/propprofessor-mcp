'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildRankedResultRows } = require('../lib/propprofessor-ranked-screen-results');

describe('buildRankedResultRows', () => {
  it('uses explicit fields before compact mode and preserves fallback rows', () => {
    const ranked = [{ id: 1 }, { id: 2 }];
    const fallbackRows = [{ id: 'fallback' }];
    ranked.focusBookMissingRows = fallbackRows;

    const result = buildRankedResultRows({
      ranked,
      fields: ['id'],
      compact: true,
      filterRowFields: (row, fields) => ({ ...row, fields }),
      compactResult: () => [{ compact: true }]
    });

    assert.deepEqual(result, [
      { id: 1, fields: ['id'] },
      { id: 2, fields: ['id'] }
    ]);
    assert.deepEqual(result.focusBookMissingRows, fallbackRows);
    assert.equal(Object.keys(result).includes('focusBookMissingRows'), false);
  });

  it('uses compact rows when fields are absent', () => {
    const compactRows = [{ compact: true }];

    const result = buildRankedResultRows({
      ranked: [{ id: 1 }],
      fields: null,
      compact: true,
      filterRowFields: () => {
        throw new Error('fields mapper should not run');
      },
      compactResult: () => compactRows
    });

    assert.equal(result, compactRows);
  });
});
