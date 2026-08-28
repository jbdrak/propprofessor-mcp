'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { COMPACT_FIELDS } = require('../lib/propprofessor-mcp-ranked-screen');
const { buildResultMeta } = require('../lib/propprofessor-ranked-screen-meta');

describe('buildResultMeta', () => {
  it('builds the ranked-screen metadata without dropping optional fields', () => {
    const freshness = {
      freshnessFallbackUsed: true,
      timestampSources: ['upstream']
    };
    const ranked = {
      coverageGaps: ['NBA:Total'],
      focusBookMissingRows: [{ gameId: 'game-1' }]
    };
    const preHistoryShortlist = { enabled: true, shortlistedRows: 2 };
    const preHistoryRecovery = { enabled: true, recoveredRowCount: 1 };

    const result = buildResultMeta({
      targetBook: 'NoVigApp',
      sharpBooks: ['Pinnacle'],
      lookbackHoursUsed: 6,
      debug: true,
      freshness,
      warnings: ['degraded'],
      compact: false,
      fields: ['market', 'selection'],
      args: { markets: ['Total'] },
      ranked,
      compactFields: COMPACT_FIELDS,
      preHistoryShortlistMeta: preHistoryShortlist,
      preHistoryRecoveryMeta: preHistoryRecovery
    });

    assert.deepEqual(result, {
      focusBook: 'NoVigApp',
      historySportsbooksRequested: ['Pinnacle'],
      lookbackHoursUsed: 6,
      debugEnabled: true,
      freshnessFallbackUsed: true,
      timestampSources: ['upstream'],
      degradedDataWarningCount: 1,
      compact: false,
      fields: ['market', 'selection'],
      markets_queried: ['Total'],
      coverageGaps: ['NBA:Total'],
      focusBookMissingRowCount: 1,
      preHistoryShortlist,
      preHistoryRecovery
    });
  });

  it('uses compact fields and defaults markets when explicit fields are absent', () => {
    const result = buildResultMeta({
      targetBook: '',
      sharpBooks: [],
      lookbackHoursUsed: 3,
      debug: false,
      freshness: { freshnessFallbackUsed: false, timestampSources: [] },
      warnings: [],
      compact: true,
      fields: null,
      args: {},
      ranked: {},
      compactFields: COMPACT_FIELDS
    });

    assert.equal(result.focusBook, null);
    assert.equal(result.fields, COMPACT_FIELDS);
    assert.deepEqual(result.markets_queried, ['Moneyline']);
    assert.equal(result.coverageGaps.length, 0);
    assert.equal(result.focusBookMissingRowCount, 0);
    assert.equal(result.preHistoryShortlist, undefined);
    assert.equal(result.preHistoryRecovery, undefined);
  });
});
