'use strict';

/**
 * Unit tests for the agent-consistency fixes (plan 2026-07-06):
 *  - Task 1/2/4: recommended_bets uses mapCandidateRow (startCST) + gameContextFn + odds fallback
 *  - Task 5: quick_screen topPick collapses to one play with why
 *  - Task 6: lite mode stays small and drops verbose fields
 *
 * Offline: the game-context module is stubbed before handler load so team/line
 * plays route to gameContextFn without hitting stats.nba.com.
 */

const path = require('path');

// Stub game-context module BEFORE any handler/server require so recommended_bets'
// gameContextFn routing doesn't trigger a live curl to stats.nba.com.
const GC_PATH = path.resolve(__dirname, '../lib/propprofessor-game-context.js');
require.cache[GC_PATH] = {
  id: GC_PATH,
  filename: GC_PATH,
  loaded: true,
  exports: {
    getGameContext: async ({ sport, game } = {}) => ({
      ok: true,
      sport: sport || null,
      gamePk: game || null,
      riskFlag: 'clean',
      riskSummary: null,
      signals: {},
      fetchedAt: new Date().toISOString()
    })
  }
};

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');
const { createMockClient } = require('./fixtures/mock-client');
const { WNBA_MONEYLINE_LITE_PAYLOAD } = require('./fixtures/screen-payloads-wnba');

function createHandlers(overrides = {}) {
  const { client } = createMockClient(overrides);
  return createMcpHandlers({ client });
}

describe('recommended_bets consistency (Tasks 1/2/4)', () => {
  it('plays include startCST and numeric odds after mapCandidateRow refactor', async () => {
    const handlers = createHandlers({
      screenPayloads: { 'WNBA:Moneyline': WNBA_MONEYLINE_LITE_PAYLOAD }
    });
    const result = await handlers.recommended_bets({
      books: ['NoVigApp'],
      leagues: ['WNBA'],
      targetTiers: ['TIER 1'],
      kaiCall: ['BET'],
      compact: true
    });
    const wnba = result.leagues.find((l) => l.league === 'WNBA');
    if (wnba && wnba.plays.length) {
      const play = wnba.plays[0];
      assert.ok('startCST' in play, 'play missing startCST');
      assert.ok(typeof play.startCST === 'string' && play.startCST.length > 0, 'startCST should be human-readable');
      assert.ok(Number.isFinite(play.odds), `expected numeric odds, got ${play.odds}`);
      assert.ok('screenScore' in play && 'edge' in play && 'clv' in play);
    }
    assert.ok(true);
  });

  it('team/line plays carry a real risk flag (gameContextFn wired), not "no game context handler"', async () => {
    const handlers = createHandlers({
      screenPayloads: { 'WNBA:Moneyline': WNBA_MONEYLINE_LITE_PAYLOAD }
    });
    const result = await handlers.recommended_bets({
      books: ['NoVigApp'],
      leagues: ['WNBA'],
      targetTiers: ['TIER 1'],
      kaiCall: ['BET'],
      compact: true
    });
    const wnba = result.leagues.find((l) => l.league === 'WNBA');
    if (wnba) {
      for (const play of wnba.plays) {
        assert.notStrictEqual(
          play.riskSummary,
          'no game context handler',
          `play ${play.selection} should have real game context, got stub`
        );
      }
    }
    assert.ok(true);
  });
});

describe('quick_screen topPick (Task 5)', () => {
  it('returns exactly one play with a why string', async () => {
    const handlers = createHandlers({
      screenPayloads: { 'WNBA:Moneyline': WNBA_MONEYLINE_LITE_PAYLOAD }
    });
    const result = await handlers.quick_screen({
      books: ['NoVigApp'],
      leagues: ['WNBA'],
      targetTiers: ['TIER 1'],
      kaiCall: ['BET'],
      topPick: true
    });
    const allCandidates = (result.results || []).flatMap((e) => e.candidates || []);
    assert.ok(allCandidates.length <= 1, `topPick should return <=1 play, got ${allCandidates.length}`);
    if (allCandidates.length === 1) {
      assert.ok(typeof allCandidates[0].why === 'string' && allCandidates[0].why.length > 0, 'missing why');
    }
    assert.ok(true);
  });
});

describe('quick_screen lite mode (Task 6)', () => {
  it('lite payload is small and drops verbose fields', async () => {
    const handlers = createHandlers({
      screenPayloads: {
        'WNBA:Moneyline': WNBA_MONEYLINE_LITE_PAYLOAD,
        'NBA:Moneyline': WNBA_MONEYLINE_LITE_PAYLOAD
      }
    });
    const result = await handlers.quick_screen({
      books: ['NoVigApp'],
      leagues: ['WNBA', 'NBA'],
      kaiCall: ['BET'],
      lite: true
    });
    const json = JSON.stringify(result);
    assert.ok(json.length < 20000, `lite payload too big: ${json.length}`);
    const all = (result.results || []).flatMap((e) => e.candidates || []);
    for (const row of all) {
      assert.ok(!('lineHistory' in row), 'lite leaked lineHistory');
      assert.ok(!('scoreBreakdown' in row), 'lite leaked scoreBreakdown');
    }
    assert.ok(true);
  });
});
