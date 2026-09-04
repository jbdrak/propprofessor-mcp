'use strict';

// Focused coverage for selectProxyOdds / proxyOdds:
//  - DraftKings preferred over FanDuel
//  - per-side odds maps {odds1,odds2} are read
//  - null when neither proxy book is present
//  - proxyOdds NEVER mutates the executable odds/book fields on the candidate

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { selectProxyOdds } = require('../lib/screen-parser');
const { mapCandidateRow } = require('../lib/propprofessor-mcp-candidate-mapper');

describe('selectProxyOdds (DK/FD retail proxy picker)', () => {
  it('prefers DraftKings over FanDuel when both are present', () => {
    const out = selectProxyOdds({ FanDuel: -108, DraftKings: -110, Pinnacle: -115 });
    assert.deepEqual(out, { book: 'DraftKings', odds: -110 });
  });

  it('falls back to FanDuel when DraftKings is absent', () => {
    const out = selectProxyOdds({ FanDuel: -108, Pinnacle: -115 });
    assert.deepEqual(out, { book: 'FanDuel', odds: -108 });
  });

  it('reads per-side odds maps via odds1 then odds2', () => {
    assert.deepEqual(selectProxyOdds({ DraftKings: { odds1: -120, odds2: 100 } }), {
      book: 'DraftKings',
      odds: -120
    });
    assert.deepEqual(selectProxyOdds({ DraftKings: { odds2: 100 } }), {
      book: 'DraftKings',
      odds: 100
    });
  });

  it('returns null when no proxy book has a parseable number', () => {
    assert.equal(selectProxyOdds({ Pinnacle: -115, Circa: -110 }), null);
    assert.equal(selectProxyOdds({ DraftKings: 'N/A' }), null);
    assert.equal(selectProxyOdds(null), null);
    assert.equal(selectProxyOdds({}), null);
  });
});

describe('mapCandidateRow proxyOdds does not alter executable odds/book', () => {
  const baseRow = {
    gameId: 'MLB:PREMATCH:A:B:1783937400',
    market: 'Moneyline',
    selection: 'A',
    league: 'MLB',
    // Executable execution-book price + venue — must be preserved verbatim.
    odds: -118,
    book: 'NoVigApp',
    // Full per-book map including retail proxies at *different* numbers.
    allBookOdds: { DraftKings: -110, FanDuel: -108, NoVigApp: -118, Pinnacle: -120 }
  };

  it('exposes proxyOdds from the retail proxy book only', () => {
    const out = mapCandidateRow(baseRow);
    assert.equal(out.proxyOdds.book, 'DraftKings');
    assert.equal(out.proxyOdds.odds, -110);
  });

  it('leaves the executable odds and book untouched regardless of proxy values', () => {
    const out = mapCandidateRow(baseRow);
    assert.equal(out.odds, -118, 'executable odds must come from row.odds, not allBookOdds');
    assert.equal(out.book, 'NoVigApp', 'executable book must come from row.book, not allBookOdds');
  });

  it('does not mutate the input row', () => {
    const before = JSON.parse(JSON.stringify(baseRow));
    mapCandidateRow(baseRow);
    assert.deepEqual(baseRow, before, 'mapCandidateRow must not mutate its input');
  });

  it('sets proxyOdds to null when no proxy book posted a line', () => {
    const out = mapCandidateRow({ ...baseRow, allBookOdds: { Pinnacle: -120 } });
    assert.equal(out.proxyOdds, null);
  });
});
