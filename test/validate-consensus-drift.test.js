'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');

const fiveBookOdds = {
  NoVigApp: { odds1: 150, odds2: -178 },
  Pinnacle: { odds1: 150, odds2: -178 },
  DraftKings: { odds1: 150, odds2: -178 },
  BetMGM: { odds1: 150, odds2: -178 },
  Circa: { odds1: 150, odds2: -178 },
  BookMaker: { odds1: 150, odds2: -178 }
};
const thinOdds = {
  NoVigApp: { odds1: 150, odds2: -178 },
  DraftKings: { odds1: 150, odds2: -178 }
};

function makePayload(odds, _selectionsKey) {
  const sel = {
    selection1: 'Minnesota Twins -1.5',
    participant1: 'Minnesota Twins -1.5',
    selection1Id: 'Run Line:Minnesota Twins -1.5',
    selection2: 'Los Angeles Angels +1.5',
    participant2: 'Los Angeles Angels +1.5',
    selection2Id: 'Run Line:Los Angeles Angels +1.5',
    odds
  };
  return {
    game_data: [
      {
        gameId: 'MLB:PREMATCH:Los_Angeles_Angels:Minnesota_Twins:1783728600',
        league: 'MLB',
        market: 'Run Line',
        updatedAt: new Date(Date.now() - 60 * 1000).toISOString(),
        homeTeam: 'Los Angeles Angels',
        awayTeam: 'Minnesota Twins',
        selections: { a: sel },
        defaultKey: 'a'
      }
    ]
  };
}

// validate_play makes a SINGLE backend call (get_play_details) — there is no
// separate "screen" call inside it; the screen snapshot arrives via args.
// So for the drift test we just return the thin payload on that one call, and
// for the consistent test we return the full 5-book payload.
function makeClient({ drift }) {
  const odds = drift ? thinOdds : fiveBookOdds;
  return {
    queryScreenOddsBestComps: async () => makePayload(odds),
    queryOddsHistory: async () => ({ NoVigApp: [{ odds: 150, start_ts: 1 }] })
  };
}

function makeGoneClient() {
  let calls = 0;
  return {
    queryScreenOddsBestComps: async () => {
      calls += 1;
      if (calls <= 2) return makePayload(fiveBookOdds);
      return { game_data: [] };
    },
    queryOddsHistory: async () => ({ NoVigApp: [{ odds: 150, start_ts: 1 }] })
  };
}

describe('validate_play consensus-drift downgrade (regression: 5 books on screen → thin on re-fetch)', () => {
  it('downgrades a TIER 1 BET to CONSIDER when re-fetched consensus collapses', async () => {
    const handlers = createMcpHandlers({ client: makeClient({ drift: true }) });
    handlers.player_context = async () => ({ riskFlag: 'low', tweets: [], news: [] });
    const result = await handlers.validate_play({
      league: 'MLB',
      gameId: 'MLB:PREMATCH:Los_Angeles_Angels:Minnesota_Twins:1783728600',
      selection: 'Minnesota Twins -1.5',
      skipResearch: true,
      screenTier: 'TIER 1',
      screenKaiCall: 'BET',
      screenConsensusBookCount: 5,
      screenExecutionQuality: 'best'
    });

    assert.equal(result.ok, true);
    assert.equal(result.consensusDrift, true, 'drift must be detected (5 → thin)');
    assert.equal(result.verdict, 'CONSIDER', 'BET built on a phantom 5-book consensus must downgrade to CONSIDER');
    assert.ok(
      result.reasons.some((r) => /drift/i.test(r)),
      'should mention consensus drift in reasons'
    );
  });

  it('does NOT downgrade when screen and re-fetch agree', async () => {
    const handlers = createMcpHandlers({ client: makeClient({ drift: false }) });
    handlers.player_context = async () => ({ riskFlag: 'low', tweets: [], news: [] });
    const result = await handlers.validate_play({
      league: 'MLB',
      gameId: 'MLB:PREMATCH:Los_Angeles_Angels:Minnesota_Twins:1783728600',
      selection: 'Minnesota Twins -1.5',
      skipResearch: true,
      screenTier: 'TIER 1',
      screenKaiCall: 'BET',
      screenConsensusBookCount: 5,
      screenExecutionQuality: 'best'
    });

    assert.equal(result.ok, true);
    assert.equal(result.consensusDrift, false);
    assert.equal(result.verdict, 'BET');
  });
});

describe('quick_screen merge: lookup_failed does not fabricate a stale consensus count', () => {
  it('sets validatedConsensusBookCount=0 and validatedUnverified=true when the line is gone on re-fetch', async () => {
    const handlers = createMcpHandlers({ client: makeGoneClient() });
    handlers.player_context = async () => ({ riskFlag: 'low', tweets: [], news: [] });
    const result = await handlers.quick_screen({
      books: ['NoVigApp'],
      leagues: ['MLB'],
      markets: ['Run Line'],
      targetTiers: ['TIER 1', 'TIER 2', 'TIER 3', 'TIER 4'],
      validateTop: 10,
      includeResearch: false,
      skipHistory: true
    });

    assert.equal(result.ok, true);
    let cand = null;
    for (const entry of result.results || []) {
      for (const c of entry.candidates || []) {
        if (
          String(c.selection || '')
            .toLowerCase()
            .includes('minnesota twins -1.5')
        )
          cand = c;
      }
    }
    assert.ok(cand, 'the -1.5 candidate from the screen must be present');
    assert.equal(cand.validatedConsensusBookCount, 0, 'must not fabricate a stale consensus count on lookup_failed');
    assert.equal(cand.validatedUnverified, true);
    assert.notEqual(cand.finalVerdict || cand.displayTier, 'BET');
  });
});
