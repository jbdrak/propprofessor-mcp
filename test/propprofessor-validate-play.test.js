'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');
const { createMockClient } = require('./fixtures/mock-client');

function makeClient({
  detailRows: _detailRows = [],
  research: _research = null,
  detailError: _detailError = null
} = {}) {
  return {
    queryScreenOddsBestComps: async () => ({
      game_data: [
        {
          gameId: 'NBA:game-1',
          league: 'NBA',
          market: 'Moneyline',
          updatedAt: new Date(Date.now() - 60 * 1000).toISOString(),
          homeTeam: 'Lakers',
          awayTeam: 'Warriors',
          selections: {
            a: {
              selection1: 'Lakers',
              participant1: 'Lakers',
              selection1Id: 'Moneyline:Lakers',
              selection2: 'Warriors',
              participant2: 'Warriors',
              selection2Id: 'Moneyline:Warriors',
              odds: {
                NoVigApp: { odds1: -118, odds2: 104 },
                Pinnacle: { odds1: -120, odds2: 106 }
              }
            }
          },
          defaultKey: 'a'
        }
      ]
    }),
    queryOddsHistory: async () => ({
      NoVigApp: [
        { odds: -118, start_ts: 1 },
        { odds: -130, start_ts: 2 }
      ]
    })
  };
}

describe('validate_play handler', () => {
  it('returns VALIDATION_ERROR when league is missing', async () => {
    const handlers = createMcpHandlers({ client: makeClient() });
    const result = await handlers.validate_play({ gameId: 'NBA:game-1', selection: 'Lakers' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'VALIDATION_ERROR');
    assert.match(result.error.message, /league/);
  });

  it('returns VALIDATION_ERROR when gameId is missing', async () => {
    const handlers = createMcpHandlers({ client: makeClient() });
    const result = await handlers.validate_play({ league: 'NBA', selection: 'Lakers' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'VALIDATION_ERROR');
    assert.match(result.error.message, /gameId/);
  });

  it('returns VALIDATION_ERROR when selection is missing', async () => {
    const handlers = createMcpHandlers({ client: makeClient() });
    const result = await handlers.validate_play({ league: 'NBA', gameId: 'NBA:game-1' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'VALIDATION_ERROR');
    assert.match(result.error.message, /selection/);
  });

  it('skips research when skipResearch=true and returns verdict', async () => {
    const handlers = createMcpHandlers({ client: makeClient() });
    // Replace player_context to detect if it gets called
    let researchCalled = false;
    handlers.player_context = async () => {
      researchCalled = true;
      return { riskFlag: 'low', tweets: [], news: [] };
    };
    const result = await handlers.validate_play({
      league: 'NBA',
      gameId: 'NBA:game-1',
      selection: 'Lakers',
      skipResearch: true
    });
    assert.equal(result.ok, true);
    assert.equal(researchCalled, false, 'player_context should not be called when skipResearch=true');
    assert.equal(result.research.skipped, true);
    // Verdict is at least PASS or CONSIDER or BET
    assert.ok(['PASS', 'CONSIDER', 'BET'].includes(result.verdict));
  });

  it('downgrades verdict to PASS when riskFlag is "high"', async () => {
    const handlers = createMcpHandlers({ client: makeClient() });
    handlers.player_context = async () => ({
      riskFlag: 'high',
      summary: 'Injury news confirmed',
      tweets: [{ text: 'OUT tonight' }],
      news: [],
      cached: false
    });
    const result = await handlers.validate_play({
      league: 'NBA',
      gameId: 'NBA:game-1',
      selection: 'Lakers',
      book: 'NoVigApp'
    });
    assert.equal(result.ok, true);
    // The verdict should be downgraded to PASS when riskFlag is high,
    // even if the underlying row is otherwise BET/CONSIDER.
    assert.equal(result.verdict, 'PASS', 'verdict should be PASS when riskFlag=high');
    assert.ok(
      result.reasons.some((r) => /high/.test(r)),
      'should mention high risk in reasons'
    );
    assert.equal(result.research.riskFlag, 'high');
  });

  it('downgrades BET to CONSIDER when riskFlag is "medium"', async () => {
    const handlers = createMcpHandlers({ client: makeClient() });
    handlers.player_context = async () => ({
      riskFlag: 'medium',
      summary: 'Some concern',
      tweets: [],
      news: [],
      cached: true
    });
    const result = await handlers.validate_play({
      league: 'NBA',
      gameId: 'NBA:game-1',
      selection: 'Lakers'
    });
    assert.equal(result.ok, true);
    // Verdict can be at most CONSIDER when riskFlag=medium.
    assert.ok(['PASS', 'CONSIDER'].includes(result.verdict), 'verdict should be PASS or CONSIDER');
    if (result.verdict === 'CONSIDER') {
      assert.ok(result.reasons.some((r) => /medium/.test(r)));
    }
  });

  it('returns degraded lookup metadata when no row matches the selection', async () => {
    const handlers = createMcpHandlers({ client: makeClient() });
    handlers.player_context = async () => ({ riskFlag: 'low', tweets: [], news: [] });
    const result = await handlers.validate_play({
      league: 'NBA',
      gameId: 'NBA:game-1',
      selection: 'Nonexistent Player'
    });
    assert.equal(result.ok, true);
    assert.equal(result.play, null);
    assert.equal(result.verdict, 'CONSIDER');
    assert.equal(result.lookupStatus, 'lookup_failed');
    assert.equal(result.reasonType, 'lookup_failure');
    assert.ok(result.reasons.some((r) => /no row matched/.test(r)));
    assert.match(result.verdictSummary.actionableSummary, /couldn't be rehydrated|stale \/ unverified/i);
  });

  it('returns canonical play identity and screen freshness for matched rows', async () => {
    const handlers = createMcpHandlers({ client: makeClient() });
    handlers.player_context = async () => ({ riskFlag: 'low', tweets: [], news: [] });
    const result = await handlers.validate_play({
      league: 'NBA',
      gameId: 'NBA:game-1',
      selection: 'Lakers'
    });

    assert.equal(result.ok, true);
    assert.ok(result.play);
    assert.equal(result.play.playId, 'NBA:game-1::Moneyline::lakers');
    assert.equal(result.play.selectionKey, 'lakers');
    assert.equal(typeof result.play.freshnessSource, 'string');
    assert.ok(result.screenFreshness && typeof result.screenFreshness === 'object');
    assert.equal(typeof result.screenFreshness.newestAgeMs, 'number');
    assert.equal(typeof result.screenFreshness.oldestAgeMs, 'number');
  });

  it('includes a clickable screenUrl deep-link for resolved plays', async () => {
    const handlers = createMcpHandlers({ client: makeClient() });
    handlers.player_context = async () => ({ riskFlag: 'low', tweets: [], news: [] });
    const result = await handlers.validate_play({
      league: 'NBA',
      gameId: 'NBA:game-1',
      selection: 'Lakers',
      book: 'NoVigApp'
    });

    assert.equal(result.ok, true);
    assert.ok(result.play, 'play should be resolved');
    assert.match(
      result.play.screenUrl,
      /^https:\/\/app\.propprofessor\.com\/screen\?market=Moneyline&game=NBA%3Agame-1&league=NBA&participant=Lakers$/
    );
  });

  it('prefers playId when matching a validate_play row', async () => {
    const handlers = createMcpHandlers({ client: makeClient() });
    handlers.player_context = async () => ({ riskFlag: 'low', tweets: [], news: [] });
    const result = await handlers.validate_play({
      league: 'NBA',
      gameId: 'NBA:game-1',
      selection: 'Wrong Name',
      playId: 'NBA:game-1::Moneyline::lakers'
    });

    assert.equal(result.ok, true);
    assert.ok(result.play);
    assert.equal(result.play.selectionKey, 'lakers');
    assert.equal(result.lookupStatus, 'resolved');
  });

  it('detects consensus drift when screen snapshot differs from re-fetched row', async () => {
    const handlers = createMcpHandlers({ client: makeClient() });
    handlers.player_context = async () => ({ riskFlag: 'low', tweets: [], news: [] });
    const result = await handlers.validate_play({
      league: 'NBA',
      gameId: 'NBA:game-1',
      selection: 'Lakers',
      screenConsensusBookCount: 5,
      screenExecutionQuality: 'best'
    });

    assert.equal(result.ok, true);
    // The test client returns consensusBookCount=2 and executionQuality varies,
    // so passing screenConsensusBookCount=5 should trigger drift
    assert.equal(result.consensusDrift, true);
    assert.equal(typeof result.driftReason, 'string');
  });

  it('returns no drift when screen snapshot matches re-fetched row', async () => {
    const handlers = createMcpHandlers({ client: makeClient() });
    handlers.player_context = async () => ({ riskFlag: 'low', tweets: [], news: [] });
    const result = await handlers.validate_play({
      league: 'NBA',
      gameId: 'NBA:game-1',
      selection: 'Lakers'
    });

    assert.equal(result.ok, true);
    assert.equal(result.consensusDrift, false);
    assert.equal(result.driftReason, null);
  });

  it('direct validate_play (no screenConsensusBookCount) does not trigger drift when re-fetched count is non-zero', async () => {
    // Audit finding #3: a direct validate_play call (no screen snapshot) must
    // never spuriously report consensus drift when the re-fetched row has a
    // valid consensus. Only the symmetric case (both defined AND disagree)
    // is drift.
    const handlers = createMcpHandlers({ client: makeClient() });
    handlers.player_context = async () => ({ riskFlag: 'low', tweets: [], news: [] });
    const result = await handlers.validate_play({
      league: 'NBA',
      gameId: 'NBA:game-1',
      selection: 'Lakers'
      // intentionally no screenConsensusBookCount / screenExecutionQuality
    });
    assert.equal(result.ok, true);
    // The mock client returns consensusBookCount=2 — that's a real signal, not drift.
    assert.equal(result.consensusDrift, false);
    assert.equal(result.driftReason, null);
  });

  it('surfaces typed MLB game-context lookup failures without forcing PASS', async () => {
    const handlers = createMcpHandlers({ client: makeClient() });
    handlers.player_context = async () => ({ riskFlag: 'low', tweets: [], news: [] });
    const result = await handlers.validate_play({
      league: 'MLB',
      gameId: 'MLB:PREMATCH:Baltimore_Orioles:Los_Angeles_Angels:1782331620',
      selection: 'Nonexistent Player'
    });

    assert.equal(result.ok, true);
    assert.equal(result.verdict, 'CONSIDER');
    assert.equal(result.lookupStatus, 'lookup_failed');
    assert.equal(result.reasonType, 'lookup_failure');
    // gameContext can succeed (gamePk found on MLB schedule) or fail
    // (schedule_not_found or network error). The key invariant is that
    // a lookup_failed detail row still produces CONSIDER (not PASS).
    assert.ok(result.gameContext, 'gameContext should be present');
    if (result.gameContext.errorType) {
      assert.equal(result.gameContext.errorType, 'schedule_not_found');
    } else {
      // Successful lookup: MLB game context fields present
      assert.ok(result.gameContext.gamePk, 'should have a gamePk');
      assert.ok(result.gameContext.venue, 'should have venue');
    }
  });

  describe('UFC row resolution (Pinnacle-less events)', () => {
    function makeUfcPayload() {
      const now = Date.now();
      return {
        ok: true,
        game_data: [
          {
            id: 'UFC:PREMATCH:Chandler:Ruffy:1781484000:Chandler',
            gameId: 'UFC:PREMATCH:Chandler:Ruffy:1781484000',
            start: new Date(now + 4 * 60 * 60 * 1000).toISOString(),
            league: 'UFC',
            homeTeam: 'Chandler',
            awayTeam: 'Ruffy',
            isLive: false,
            market: 'Moneyline',
            defaultKey: 'null',
            selections: {
              null: {
                selection1: 'Chandler',
                selection2: 'Ruffy',
                selection1Id: 'Moneyline:Chandler',
                selection2Id: 'Moneyline:Ruffy',
                odds: {
                  BetOnline: { book: 'BetOnline', odds1: 415, odds2: -535 },
                  FanDuel: { book: 'FanDuel', odds1: 400, odds2: -550 }
                  // NOTE: no Pinnacle — Pinnacle doesn't post UFC moneylines.
                }
              }
            }
          }
        ]
      };
    }

    it('get_play_details returns rows for UFC when no books param (regression)', async () => {
      const { client } = createMockClient({
        screenPayloads: { 'UFC:Moneyline': makeUfcPayload() }
      });
      const handlers = createMcpHandlers({ client });
      const result = await handlers.get_play_details({
        league: 'UFC',
        gameIds: ['UFC:PREMATCH:Chandler:Ruffy:1781484000'],
        market: 'Moneyline'
      });
      // Should find the row — no longer dropped by Pinnacle-only focusBook.
      assert.equal(result.ok, true);
      assert.ok(Array.isArray(result.result));
      assert.ok(result.result.length > 0, 'should return at least one UFC row');
      // 4 rows = 2 sides (Chandler, Ruffy) × 2 books (BetOnline, FanDuel)
      assert.ok(result.resultMeta.matchedRows > 0, 'should have matched at least one row');
      assert.ok(
        result.result.some((r) =>
          String(r.selection || '')
            .toLowerCase()
            .includes('chandler')
        ),
        'should include Chandler in results'
      );
    });

    it('validate_play finds the matching UFC row when no books param', async () => {
      const { client } = createMockClient({
        screenPayloads: { 'UFC:Moneyline': makeUfcPayload() }
      });
      const handlers = createMcpHandlers({ client });
      handlers.player_context = async () => ({ riskFlag: 'low', tweets: [], news: [], cached: false });
      const result = await handlers.validate_play({
        league: 'UFC',
        gameId: 'UFC:PREMATCH:Chandler:Ruffy:1781484000',
        selection: 'Chandler',
        skipResearch: true
      });
      // The row should be found even though Pinnacle has no odds.
      assert.equal(result.ok, true);
      assert.ok(
        result.play !== null,
        'play should not be null when row is found. reasons: ' + JSON.stringify(result.reasons)
      );
      assert.equal(result.gameId, 'UFC:PREMATCH:Chandler:Ruffy:1781484000');
      assert.ok(result.tier, 'should have a tier assignment');
    });
  });
});
