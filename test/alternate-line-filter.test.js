'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAlternateLines } = require('../lib/alternate-line-filter');

describe('alternate-line filtering by matchup identity', () => {
  it('groups timestamp-variant game ids as one game', () => {
    const rows = [
      {
        game: 'Athletics vs Baltimore Orioles',
        gameId: 'MLB:PREMATCH:Athletics:Baltimore_Orioles:1788055500',
        market: 'Total Runs',
        selection: 'Over 8.5',
        consensusBookCount: 5
      },
      {
        game: 'Athletics vs Baltimore Orioles',
        gameId: 'MLB:PREMATCH:Athletics:Baltimore_Orioles:1788120300',
        market: 'Total Runs',
        selection: 'Over 7.5',
        consensusBookCount: 2
      }
    ];

    resolveAlternateLines(rows);

    assert.equal(rows[0].altLineFiltered, undefined);
    assert.equal(rows[0].kaiCall, undefined);
    assert.equal(rows[1].altLineFiltered, true);
    assert.equal(rows[1].kaiCall, 'PASS');
  });

  it('falls back to game id when matchup text is absent', () => {
    const rows = [
      { gameId: 'g1', market: 'Total Points', selection: 'Over 210.5', consensusBookCount: 4 },
      { gameId: 'g1', market: 'Total Points', selection: 'Over 208.5', consensusBookCount: 1 }
    ];

    resolveAlternateLines(rows);

    assert.equal(rows[1].altLineFiltered, true);
  });
});
