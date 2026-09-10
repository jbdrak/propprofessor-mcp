'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { hydrateScreenRowsWithHistory } = require('../lib/propprofessor-screen-history');
const { classifySharpPlay } = require('../lib/propprofessor-sharp-plays');
const { mapCandidateRow } = require('../lib/propprofessor-mcp-candidate-mapper');
const { compactRow } = require('../lib/propprofessor-mcp-ranked-screen');
const { formatBetCompact, formatBetStandard } = require('../lib/propprofessor-formatter');

const FALLBACK = 'mainstream_fallback';

function fallbackRow(overrides = {}) {
  return {
    gameId: 'game-1',
    playId: 'game-1::Total Games::over 21.5',
    selectionKey: 'over 21.5',
    game: 'Carle vs Vedder',
    market: 'Total Games',
    selection: 'Over 21.5',
    pick: 'Over 21.5',
    odds: -111,
    targetBook: 'NoVigApp',
    book: 'NoVigApp',
    lineHistoryUsable: true,
    lineHistoryAvailable: true,
    movementLabel: 'supportive',
    movementMode: 'comparison_book',
    movementSourceBook: 'FanDuel',
    historyBookTier: FALLBACK,
    executionQuality: 'playable',
    consensusBookCount: 5,
    marketBookCount: 5,
    supportBookCount: 5,
    consensusEdge: 1,
    clvProxyPct: 1,
    confidenceTier: 'TIER 1',
    kaiCall: 'BET',
    ...overrides
  };
}

describe('mainstream fallback provenance pipeline', () => {
  it('preserves historyBookTier through screen hydration success', async () => {
    const row = fallbackRow({ selectionId: 'Total_Games:Over_21.5', historyBookTier: null });
    const hydrated = await hydrateScreenRowsWithHistory([row], {
      client: { queryOddsHistory: async () => ({}) },
      sharpOddsProvider: {
        resolve: async () => ({
          lineHistoryAvailable: true,
          lineHistory: [
            { time: 1, line: 21.5, odds: -113, book: 'FanDuel' },
            { time: 2, line: 21.5, odds: -111, book: 'FanDuel' }
          ],
          lineHistorySource: 'sharpodds',
          historyProvider: 'sharpodds',
          historyBookTier: FALLBACK,
          historySportsbooksRequested: ['FanDuel'],
          movementSourceBook: 'FanDuel',
          movementMode: 'comparison_book'
        })
      },
      preferSharpOddsHistory: true,
      preferredBook: 'NoVigApp',
      sharpBooks: ['Pinnacle'],
      sharpOddsBooks: ['Pinnacle'],
      historySportsbooks: ['Pinnacle'],
      concurrency: 1,
      minIntervalMs: 0
    });
    assert.equal(hydrated[0].historyBookTier, FALLBACK);
    assert.equal(hydrated[0].movementMode, 'comparison_book');
  });

  it('does not classify mainstream fallback movement as sharp-sourced BET evidence', () => {
    const result = classifySharpPlay(fallbackRow(), { targetBook: 'NoVigApp' });
    assert.equal(result.support.movementIsSharpSourced, false);
    assert.notEqual(result.verdict, 'Bet candidate');
    assert.ok(result.passReasons.some((reason) => reason.includes('mainstream')));
  });

  it('cannot bypass the mainstream gate through sharp confirmation metadata', () => {
    const result = classifySharpPlay(fallbackRow({ sharpBookMovementConfirmed: true }), {
      targetBook: 'NoVigApp'
    });
    assert.equal(result.support.movementIsSharpSourced, false);
    assert.notEqual(result.verdict, 'Bet candidate');
  });

  it('still treats a real sharp comparison book as sharp-sourced', () => {
    const result = classifySharpPlay(fallbackRow({ historyBookTier: null, movementSourceBook: 'Pinnacle' }), {
      targetBook: 'NoVigApp'
    });
    assert.equal(result.support.movementIsSharpSourced, true);
  });

  it('preserves historyBookTier through candidate mapping and compact output', () => {
    const row = fallbackRow();
    const mapped = mapCandidateRow(row);
    assert.equal(mapped.historyBookTier, FALLBACK);
    assert.equal(compactRow(row).historyBookTier, FALLBACK);
  });

  it('preserves historyBookTier through bet formatters', () => {
    const row = fallbackRow();
    assert.equal(formatBetCompact(row).historyBookTier, FALLBACK);
    assert.equal(formatBetStandard(row).historyBookTier, FALLBACK);
  });
});
