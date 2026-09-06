'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { rankScreenRows } = require('../lib/screen-ranker');

function spreadRow(selection, books) {
  const allBookOdds = {};
  for (const b of books) allBookOdds[b] = { book: b, odds1: -110, odds2: -110 };
  return {
    book: 'NoVigApp',
    league: 'NCAAF',
    gameId: 'NCAAF:GAME:Villanova:Penn_State:1788636600',
    game: 'Villanova vs Penn State',
    homeTeam: 'Penn State',
    awayTeam: 'Villanova',
    participant: 'Villanova',
    selection,
    market: 'Point Spread',
    selection1: selection,
    participant1: 'Villanova',
    selection1Id: `Point Spread:${selection}`,
    selection2: 'Penn State +26.5',
    participant2: 'Penn State',
    selection2Id: 'Point Spread:Penn State',
    odds: -110,
    lineHistory: [{ odds: -110, time: '2026-09-05T12:00:00Z' }],
    allBookOdds
  };
}

describe('rankScreenRows alternate-line drop', () => {
  it('drops alt spread variants with includeAll:true, keeps the main line', () => {
    const ranked = rankScreenRows(
      [
        spreadRow('Villanova -26.5', ['NoVigApp', 'Pinnacle', 'Circa']),
        spreadRow('Villanova -27.5', ['NoVigApp']),
        spreadRow('Villanova -25.5', ['NoVigApp'])
      ],
      { preferredBook: 'NoVigApp', limit: 20, includeAll: true }
    );

    assert.ok(Array.isArray(ranked), 'expected an array');
    assert.equal(ranked.filter((r) => r.altLineFiltered).length, 0, 'no alt-line rows should survive in output');
    assert.ok(
      ranked.some((r) => String(r.selection || '').includes('26.5')),
      'main line Villanova -26.5 should survive'
    );
    assert.equal(ranked.droppedAltLineCount, 2, 'expected 2 dropped alt lines');
  });
});
