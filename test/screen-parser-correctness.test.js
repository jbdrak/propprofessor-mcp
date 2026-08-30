'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const { extractScreenRows } = require('../lib/screen-parser');

it('does not present soccer feed ordering as verified home and away teams', () => {
  const rows = extractScreenRows([
    {
      gameId: 'Soccer:PREMATCH:Nice:Paris_FC:1788094800',
      league: 'Soccer',
      market: 'Match Handicap',
      homeTeam: 'Nice',
      awayTeam: 'Paris FC',
      selection1: 'Nice +0.5',
      selection2: 'Paris FC -0.5',
      selection1Id: 'Match Handicap:Nice +0.5',
      selection2Id: 'Match Handicap:Paris FC -0.5',
      odds: { NoVigApp: { odds1: -115, odds2: 108 } }
    }
  ]);

  assert.equal(rows[0].venueOrderVerified, false);
  assert.match(rows[0].game, /home\/away unverified/);
  assert.doesNotMatch(rows[0].game, / @ /);
});

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
