'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { finalizeRankedScreenResponse } = require('../lib/propprofessor-ranked-screen-finalize');

function stripEmptyFields(row) {
  return { id: row.id };
}

describe('finalizeRankedScreenResponse', () => {
  it('filters top-level keys and compacts result rows when include is provided', () => {
    const response = {
      ok: true,
      result: [{ id: 1, detail: 'drop' }],
      freshness: { source: 'drop' },
      resultMeta: { compact: false },
      league: 'NBA'
    };

    const result = finalizeRankedScreenResponse(response, ['resultMeta'], stripEmptyFields);

    assert.deepEqual(result, {
      ok: true,
      result: [{ id: 1 }],
      resultMeta: { compact: false }
    });
    assert.deepEqual(response.result, [{ id: 1, detail: 'drop' }]);
  });

  it('keeps the full envelope and compacts result rows when include is absent', () => {
    const response = {
      ok: true,
      result: [{ id: 2, detail: 'drop' }],
      freshness: { source: 'keep' }
    };

    const result = finalizeRankedScreenResponse(response, null, stripEmptyFields);

    assert.equal(result, response);
    assert.deepEqual(result, {
      ok: true,
      result: [{ id: 2 }],
      freshness: { source: 'keep' }
    });
  });
});
