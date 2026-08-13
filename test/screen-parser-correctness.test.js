'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const { extractScreenRows } = require('../lib/screen-parser');

it('does not leak a representative nested container when the requested book is absent', () => {
  const payload = {
    game_data: [
      {
        gameId: 'Tennis:PREMATCH:A:B:1786017600',
        league: 'Tennis',
        market: 'Total Games',
        participant: 'Over 24.5',
        odds: -140,
        selections: {
          22.5: {
            selection1: 'Over 22.5',
            selection2: 'Under 22.5',
            odds: { Pinnacle: { odds1: -110, odds2: -110 } }
          }
        }
      }
    ]
  };
  const rows = extractScreenRows(payload, [{ book: 'NoVigApp' }]);
  assert.equal(rows.length, 0);
});
