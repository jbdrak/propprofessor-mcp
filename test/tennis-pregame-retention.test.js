'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { rankTennisScreenRows } = require('../lib/screen-tennis');

// Guards the rule: tennis matches stay bettable while the screen still serves
// pregame odds, regardless of PP's (unreliable) start timestamp. The screen
// feed is pregame-only — presence of odds == still pregame == still bettable.
// A future regression that adds a start-time / card-window filter to the tennis
// path would silently drop live pregame matches; these tests catch it.

function tennisCandidate({ start, odds, consensusBookCount = 6, selection = 'Faria +2.5' } = {}) {
  return {
    league: 'Tennis',
    gameId: 'Tennis:PREMATCH:Darderi:Faria:1784914200',
    game: 'Darderi vs Faria',
    selection,
    market: 'Game Handicap',
    start,
    odds,
    consensusBookCount,
    sportsbookData: [
      { book: 'NoVigApp', odds },
      { book: 'Pinnacle', odds: odds - 2 },
      { book: 'BetOnline', odds: odds - 1 }
    ],
    movementDisposition: 'supportive_bouncy',
    confidenceTier: 'TIER 1',
    kaiCall: 'BET',
    consensusEdge: 2.5,
    clvProxyPct: 1.5,
    executionQuality: 'best',
    isActionable: Number.isFinite(odds),
    gatePassed: true
  };
}

describe('tennis pregame retention (odds presence = bettable)', () => {
  it('keeps a tennis row whose start time is in the past but odds are live', () => {
    const pastStart = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
    const rows = [tennisCandidate({ start: pastStart, odds: -104 })];
    const ranked = rankTennisScreenRows(rows, { includeAll: true });
    assert.equal(ranked.length, 1, 'past-start tennis row with live odds must not be dropped');
    assert.equal(ranked[0].selection, 'Faria +2.5');
  });

  it('keeps a tennis row stamped to a non-today UTC day but odds are live', () => {
    const yesterday = new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString();
    const rows = [tennisCandidate({ start: yesterday, odds: -104 })];
    const ranked = rankTennisScreenRows(rows, { includeAll: true });
    assert.equal(ranked.length, 1, 'off-day tennis row with live odds must not be dropped');
  });

  it('keeps a past-start tennis row even through the real ranker gate (includeAll=false)', () => {
    // The default scan path uses includeAll=false and the ranker's gate
    // (consensus/movement). A past-start tennis row with live odds + consensus
    // must still survive — this is the path the CLI actually exercises.
    const pastStart = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const rows = [tennisCandidate({ start: pastStart, odds: -104 })];
    const ranked = rankTennisScreenRows(rows, { includeAll: false });
    assert.equal(ranked.length, 1, 'past-start tennis row must survive the real gate');
    assert.equal(ranked[0].selection, 'Faria +2.5');
  });

  it('retains multiple live pregame rows even when some start times vary widely', () => {
    const rows = [
      tennisCandidate({ start: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), odds: -104, selection: 'A +1.5' }),
      tennisCandidate({ start: new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString(), odds: -110, selection: 'B -2.5' }),
      tennisCandidate({ start: new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString(), odds: -102, selection: 'C +3.5' })
    ];
    const ranked = rankTennisScreenRows(rows, { includeAll: true });
    assert.equal(ranked.length, 3, 'all three live-odds rows must survive regardless of start time');
  });
});
