'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildRankedHydrationOptions } = require('../lib/propprofessor-ranked-screen-hydration-options');

describe('buildRankedHydrationOptions', () => {
  it('builds the history options and includes finite pacing overrides', () => {
    assert.deepEqual(
      buildRankedHydrationOptions({
        client: { id: 'client' },
        lookbackHours: 6,
        targetBook: 'NoVigApp',
        sharpBooks: ['Pinnacle'],
        args: { enableHistoryLineFallback: false, historyMinIntervalMs: '0' }
      }),
      {
        client: { id: 'client' },
        lookbackHours: 6,
        preferredBook: 'NoVigApp',
        sharpBooks: ['Pinnacle'],
        historySportsbooks: ['Pinnacle'],
        enableLineFallback: false,
        minIntervalMs: 0
      }
    );
  });

  it('omits invalid pacing overrides and uses the empty preferred book fallback', () => {
    assert.deepEqual(
      buildRankedHydrationOptions({
        client: null,
        lookbackHours: 3,
        targetBook: '',
        sharpBooks: [],
        args: { historyMinIntervalMs: 'not-a-number' }
      }),
      {
        client: null,
        lookbackHours: 3,
        preferredBook: null,
        sharpBooks: [],
        historySportsbooks: [],
        enableLineFallback: true
      }
    );
  });
});
