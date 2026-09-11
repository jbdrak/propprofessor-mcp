'use strict';

/**
 * Regression test for Task 4: validate_play must honor the screen-snapshot
 * tier/kaiCall (the row the agent already returned from recommended_bets /
 * quick_screen) instead of re-fetching the screen and flipping the verdict.
 *
 * Before the fix, validate_play re-fetched the screen fresh and used only
 * matchingRow.confidenceTier, completely ignoring any screenTier/screenKaiCall
 * argument. So a screen that returned CONSIDER could be re-validated as BET.
 *
 * We use a payload + odds history that ranks TIER 1 (BET) on a fresh re-fetch,
 * but pass screenTier: 'TIER 2', screenKaiCall: 'CONSIDER' (the snapshot the
 * agent already saw). The verdict must stay CONSIDER.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/ssb-mcp-server');
const { createMockClient } = require('./fixtures/mock-client');

const NOW_SEC = Math.floor(Date.now() / 1000);
const H = 3600;

// Strong sharp movement: all books agree Lakers is the favorite, Pinnacle +
// sharp books steamed from -120 to -150 over the window. This ranks TIER 1 /
// BET on a fresh re-fetch (verified by probe).
const TIER1_PAYLOAD = {
  game_data: [
    {
      gameId: 'nba-tier1-consistency',
      league: 'NBA',
      market: 'Moneyline',
      updatedAt: new Date(Date.now() - 30 * 1000).toISOString(),
      homeTeam: 'Lakers',
      awayTeam: 'Celtics',
      selections: {
        ml: {
          selection1: 'Lakers',
          participant1: 'Lakers',
          selection1Id: 'Moneyline:Lakers',
          selection2: 'Celtics',
          participant2: 'Celtics',
          selection2Id: 'Moneyline:Celtics',
          odds: {
            NoVigApp: { odds1: -150, odds2: 132 },
            Pinnacle: { odds1: -150, odds2: 132 },
            Circa: { odds1: -148, odds2: 130 },
            BetOnline: { odds1: -152, odds2: 134 },
            BookMaker: { odds1: -149, odds2: 131 },
            Heritage: { odds1: -151, odds2: 133 },
            BetOnline2: { odds1: -150, odds2: 132 }
          }
        }
      },
      defaultKey: 'ml'
    }
  ]
};

const TIER1_HISTORY = {
  Pinnacle: [
    { odds: -120, start_ts: NOW_SEC - 6 * H },
    { odds: -128, start_ts: NOW_SEC - 5 * H },
    { odds: -135, start_ts: NOW_SEC - 4 * H },
    { odds: -140, start_ts: NOW_SEC - 3 * H },
    { odds: -145, start_ts: NOW_SEC - 2 * H },
    { odds: -148, start_ts: NOW_SEC - 1 * H },
    { odds: -150, start_ts: NOW_SEC }
  ],
  NoVigApp: [
    { odds: -120, start_ts: NOW_SEC - 6 * H },
    { odds: -135, start_ts: NOW_SEC - 3 * H },
    { odds: -150, start_ts: NOW_SEC }
  ],
  Circa: [
    { odds: -118, start_ts: NOW_SEC - 6 * H },
    { odds: -130, start_ts: NOW_SEC - 3 * H },
    { odds: -148, start_ts: NOW_SEC }
  ],
  BetOnline: [
    { odds: -122, start_ts: NOW_SEC - 6 * H },
    { odds: -142, start_ts: NOW_SEC - 2 * H },
    { odds: -152, start_ts: NOW_SEC }
  ]
};

function makeHandlers() {
  const { client } = createMockClient({
    screenPayloads: { 'NBA:Moneyline': TIER1_PAYLOAD },
    historyByGame: { 'nba-tier1-consistency': TIER1_HISTORY }
  });
  const handlers = createMcpHandlers({ client });
  handlers.player_context = async () => ({ riskFlag: 'low', tweets: [], news: [] });
  return handlers;
}

describe('validate_play honors screen snapshot tier (Task 4)', () => {
  it('refuses a fresh re-fetch upgrade: screenTier=TIER2/CONSIDER stays CONSIDER', async () => {
    const handlers = makeHandlers();
    const result = await handlers.validate_play({
      league: 'NBA',
      gameId: 'nba-tier1-consistency',
      selection: 'Lakers',
      skipResearch: true,
      screenTier: 'TIER 2',
      screenKaiCall: 'CONSIDER'
    });
    assert.equal(result.ok, true);
    // The fresh re-fetch would rank this TIER 1 / BET, but the caller-supplied
    // snapshot (the row the agent already returned) is TIER 2 / CONSIDER.
    assert.equal(result.verdict, 'CONSIDER', 'must not upgrade to BET from a fresh re-fetch');
    assert.equal(result.tier, 'TIER 2', 'tier should reflect the supplied screen snapshot');
  });

  it('control: without screen args, fresh re-fetch verdict is unchanged (BET)', async () => {
    const handlers = makeHandlers();
    const result = await handlers.validate_play({
      league: 'NBA',
      gameId: 'nba-tier1-consistency',
      selection: 'Lakers',
      skipResearch: true
    });
    assert.equal(result.ok, true);
    // Unchanged behavior: no snapshot supplied, so the fresh re-fetch verdict wins.
    assert.equal(result.verdict, 'BET', 'fresh re-fetch of a TIER 1 row should be BET');
  });
});

// History moving *against* Lakers (-120 → -150 over 6h). On a fresh re-fetch
// that should surface adverse_full and downgrade tier to TIER 3.
const ADVERSE_PAYLOAD = {
  game_data: [
    {
      gameId: 'nba-adverse-tier-downgrade',
      league: 'NBA',
      market: 'Moneyline',
      updatedAt: new Date(Date.now() - 30 * 1000).toISOString(),
      homeTeam: 'Lakers',
      awayTeam: 'Celtics',
      selections: {
        ml: {
          selection1: 'Lakers',
          participant1: 'Lakers',
          selection1Id: 'Moneyline:Lakers',
          selection2: 'Celtics',
          participant2: 'Celtics',
          selection2Id: 'Moneyline:Celtics',
          // Lakers favorite across 7 books → deep consensus (ranker gives TIER 2
          // when the caller supplies screenTier, since movement is computed post-rank).
          odds: {
            NoVigApp: { odds1: -150, odds2: 122 },
            Pinnacle: { odds1: -150, odds2: 132 },
            Circa: { odds1: -148, odds2: 130 },
            BetOnline: { odds1: -148, odds2: 134 },
            BookMaker: { odds1: -149, odds2: 131 },
            Heritage: { odds1: -151, odds2: 133 },
            BetOnline2: { odds1: -150, odds2: 132 }
          }
        }
      },
      defaultKey: 'ml'
    }
  ]
};

// Lakers (favorite) line LENGTHENS over 6h: -150 → -120. The favorite becoming
// LESS favored is adverse movement for a Lakers bet. This is the genuine
// end-to-end shape: extractScreenRows + hydrateScreenRowsWithHistory derives
// movementLabel:'adverse' / fullWindowSharpMoveDirection:'adverse' from this.
const ADVERSE_HISTORY_LONG = {
  'nba-adverse-tier-downgrade': {
    Pinnacle: [
      { odds: -150, start_ts: NOW_SEC - 6 * H },
      { odds: -145, start_ts: NOW_SEC - 5 * H },
      { odds: -140, start_ts: NOW_SEC - 4 * H },
      { odds: -135, start_ts: NOW_SEC - 3 * H },
      { odds: -128, start_ts: NOW_SEC - 2 * H },
      { odds: -122, start_ts: NOW_SEC - 1 * H },
      { odds: -120, start_ts: NOW_SEC }
    ]
  }
};

function makeAdverseHandlers() {
  const { client } = createMockClient({
    screenPayloads: { 'NBA:Moneyline': ADVERSE_PAYLOAD },
    historyByGame: ADVERSE_HISTORY_LONG
  });
  const handlers = createMcpHandlers({ client });
  handlers.player_context = async () => ({ riskFlag: 'low', tweets: [], news: [] });
  return handlers;
}

describe('validate_play keeps the screen snapshot authoritative', () => {
  it('does not re-grade a TIER 2 screen snapshot from re-fetched movement', async () => {
    const handlers = makeAdverseHandlers();
    const result = await handlers.validate_play({
      league: 'NBA',
      gameId: 'nba-adverse-tier-downgrade',
      selection: 'Lakers',
      skipResearch: true,
      screenTier: 'TIER 2',
      screenKaiCall: 'CONSIDER',
      screenMovementDisposition: 'supportive_clean',
      screenOdds: -150
    });
    assert.equal(result.ok, true);
    assert.equal(result.tier, 'TIER 2');
    assert.equal(result.verdict, 'CONSIDER');
    assert.equal(result.verdictSummary?.movementDisposition, 'supportive_clean');
  });

  it('adverse movement with no screen snapshot stays at the ranker tier (TIER 4 / PASS)', async () => {
    const handlers = makeAdverseHandlers();
    const result = await handlers.validate_play({
      league: 'NBA',
      gameId: 'nba-adverse-tier-downgrade',
      selection: 'Lakers',
      skipResearch: true
    });
    assert.equal(result.ok, true);
    assert.equal(result.verdict, 'PASS', 'adverse + thin support should be PASS, not BET');
    assert.equal(
      result.verdictSummary?.movementDisposition === 'adverse_recent' ||
        result.verdictSummary?.movementDisposition === 'adverse_full',
      true,
      'movement disposition should be adverse'
    );
  });
});
