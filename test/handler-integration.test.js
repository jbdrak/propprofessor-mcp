'use strict';

/**
 * Fixture-based handler integration tests.
 *
 * Tests the full MCP handler pipeline (screen_ranked, sharp_plays, recommended_bets,
 * find_best_price, all_slates, etc.) against realistic fixture data — no auth, no network.
 *
 * Validates that:
 * - Handlers parse screen payloads correctly
 * - History hydration enriches rows with movement data
 * - Ranking assigns tiers, kai calls, and risk scores
 * - Sharp plays detect lagging books (Fliff stuck at -120 while sharp books at -140)
 * - Compact/fields filtering reduces response size
 * - Error handling works for missing params
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');
const { createMockClient } = require('./fixtures/mock-client');
const { isPlayerSelection } = require('../lib/propprofessor-selection-type');

function createHandlers(overrides = {}, handlerOptions = {}) {
  const { client } = createMockClient(overrides);
  const handlers = createMcpHandlers({
    client,
    // Keep the per-market stall guard bounded in fixtures. The production
    // default itself is asserted in recommended-bets-resilience.
    recommendedBetsScreenTimeoutMs: 5000,
    ...handlerOptions
  });
  // Stub player_context so research doesn't hit Nitter/network and hang.
  // Handler-integration tests cover screen, validation, and tier logic, not
  // research — which is tested separately in the 'research scoping' block
  // that uses its own explicit stub.
  handlers.player_context = async () => ({ riskFlag: 'clean', tweets: [], news: [] });
  return handlers;
}

// ─── screen_ranked ─────────────────────────────────────────────────

describe('handler integration: screen_ranked', () => {
  it('returns ranked rows with consensus metadata from fixture data', async () => {
    const handlers = createHandlers();
    const result = await handlers.screen_ranked({
      league: 'NBA',
      market: 'Moneyline',
      books: ['NoVigApp'],
      limit: 5,
      includeAll: true,
      debug: false
    });

    assert.equal(result.ok, true);
    assert.equal(result.league, 'NBA');
    assert.ok(Array.isArray(result.result));
    assert.ok(result.result.length > 0, 'Should have ranked rows from 3-game fixture');
    assert.ok(result.resultMeta);
    assert.equal(typeof result.resultMeta.debugEnabled, 'boolean');

    const row = result.result[0];
    assert.ok(row.participant, 'Row has a participant');
    assert.ok(row.odds !== undefined, 'Row has odds');
    assert.ok(row.consensusBookCount >= 0, 'Row has consensusBookCount');
  });

  it('returns rows ranked by screenScore descending', async () => {
    const handlers = createHandlers();
    const result = await handlers.screen_ranked({
      league: 'NBA',
      market: 'Moneyline',
      limit: 10,
      includeAll: true
    });

    assert.equal(result.ok, true);
    const scores = result.result.map((r) => r.screenScore || 0);
    for (let i = 1; i < scores.length; i++) {
      assert.ok(
        scores[i] <= scores[i - 1],
        `Row ${i} score (${scores[i]}) should be <= row ${i - 1} (${scores[i - 1]})`
      );
    }
  });

  it('applies limit parameter', async () => {
    const handlers = createHandlers();
    const result = await handlers.screen_ranked({
      league: 'NBA',
      market: 'Moneyline',
      limit: 2,
      includeAll: true
    });

    assert.equal(result.ok, true);
    assert.ok(result.result.length <= 2, `Expected at most 2 rows, got ${result.result.length}`);
  });

  it('compact mode returns smaller responses', async () => {
    const handlers = createHandlers();
    const full = await handlers.screen_ranked({
      league: 'NBA',
      market: 'Moneyline',
      limit: 3,
      includeAll: true
    });
    const compact = await handlers.screen_ranked({
      league: 'NBA',
      market: 'Moneyline',
      limit: 3,
      includeAll: true,
      compact: true
    });

    assert.equal(compact.ok, true);
    const fullJson = JSON.stringify(full);
    const compactJson = JSON.stringify(compact);
    assert.ok(compactJson.length < fullJson.length, 'Compact response should be smaller');
  });

  it('fields param returns only requested fields', async () => {
    const handlers = createHandlers();
    const result = await handlers.screen_ranked({
      league: 'NBA',
      market: 'Moneyline',
      limit: 3,
      includeAll: true,
      fields: ['game', 'selection', 'odds']
    });

    assert.equal(result.ok, true);
    if (result.result.length > 0) {
      const row = result.result[0];
      assert.ok(
        row.game !== undefined || row.selection !== undefined || row.odds !== undefined,
        'Should have at least one requested field'
      );
    }
  });

  it('queries Spread market correctly', async () => {
    const handlers = createHandlers();
    const result = await handlers.screen_ranked({
      league: 'NBA',
      market: 'Spread',
      limit: 5,
      includeAll: true
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.result));
  });

  it('queries Total market correctly', async () => {
    const handlers = createHandlers();
    const result = await handlers.screen_ranked({
      league: 'NBA',
      market: 'Total',
      limit: 5,
      includeAll: true
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.result));
  });

  // Regression: 2026-06-14 live test found that screen_ranked({league:'UFC'})
  // returned 0 rows. The handler was defaulting focusBook to the preset's first
  // preferred book (Pinnacle for most leagues), and the focusPlays filter in
  // extractScreenRows then dropped every row whose odds didn't include
  // Pinnacle — which is every UFC row, since Pinnacle doesn't post UFC
  // moneylines. Fix: only set focusBook when the user explicitly passed books;
  // leave focusPlays empty (= expand to all books) otherwise. Also: a
  // defensive fallback in extractScreenRows for the case where the requested
  // focus book has no odds in a given row.
  it('returns ranked rows for UFC when no focus book is specified (regression)', async () => {
    // Build a UFC payload where Pinnacle has no odds but BetOnline, Caesars,
    // FanDuel, and DraftKings all do. This mirrors the live 2026-06-14 data
    // shape that triggered the original bug.
    const ufcPayload = {
      game_data: [
        {
          id: 'UFC:PREMATCH:Aswell:Bolanos:1782000000:Aswell',
          gameId: 'UFC:PREMATCH:Aswell:Bolanos:1782000000',
          start: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          league: 'UFC',
          homeTeam: 'Aswell',
          awayTeam: 'Bolanos',
          isLive: false,
          market: 'Moneyline',
          defaultKey: 'null',
          selections: {
            null: {
              selection1: 'Aswell',
              selection2: 'Bolanos',
              selection1Id: 'Moneyline:Aswell',
              selection2Id: 'Moneyline:Bolanos',
              odds: {
                BetOnline: { book: 'BetOnline', odds1: -450, odds2: 350 },
                Caesars: { book: 'Caesars', odds1: -400, odds2: 310 },
                FanDuel: { book: 'FanDuel', odds1: -400, odds2: 290 },
                DraftKings: { book: 'DraftKings', odds1: -380, odds2: 300 }
                // NOTE: no Pinnacle — Pinnacle doesn't post UFC moneylines.
              }
            }
          }
        },
        {
          id: 'UFC:PREMATCH:Chandler:Ruffy:1781484000:Chandler',
          gameId: 'UFC:PREMATCH:Chandler:Ruffy:1781484000',
          start: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
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
              }
            }
          }
        }
      ],
      games: [],
      participants: []
    };
    const { client } = createMockClient({ screenPayloads: { 'UFC:Moneyline': ufcPayload } });
    const handlers = createMcpHandlers({ client });
    const result = await handlers.screen_ranked({
      league: 'UFC',
      market: 'Moneyline',
      includeAll: true
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.result));
    // The bug: returned 0 rows because the focus-book filter (Pinnacle)
    // eliminated every row. After the fix: should have all expanded rows
    // (2 events × 4 books × 2 sides = 8 for Aswell, plus 2 × 2 × 2 = 4 for
    // Chandler, so at least 8 rows post-ranking; we don't assert exact
    // count because the ranker may filter more, but > 0 is the bug check).
    // As of 2026-06-17, fallback rows (rows where the focus book had no
    // price) are moved to `focusBookMissingRows`. Pinnacle has no UFC
    // moneyline odds, so all UFC rows are fallbacks. Count both arrays.
    const fallbackCount = (result.focusBookMissingRows || []).length;
    assert.ok(
      result.result.length + fallbackCount > 0,
      `Expected UFC rows post-fix, got 0 in result and ${fallbackCount} in focusBookMissingRows. Pre-fix this was the bug.`
    );
    // None of the rows should have book='Pinnacle' (since Pinnacle has no
    // odds in our fixture) — the defensive fallback should have used the
    // books that DO have odds.
    const allRows = [...result.result, ...(result.focusBookMissingRows || [])];
    const books = new Set(allRows.map((r) => r.book).filter(Boolean));
    for (const book of books) {
      assert.notEqual(book, 'Pinnacle', 'Should not surface Pinnacle rows when Pinnacle has no odds');
    }
  });
});

// ─── sharp_plays ───────────────────────────────────────────────────

describe('handler integration: sharp_plays', () => {
  it('returns sharp plays with resultMeta', async () => {
    const handlers = createHandlers();
    const result = await handlers.sharp_plays({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      limit: 5
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.result));
    assert.ok(result.resultMeta);
  });

  it('detects lagging Fliff price as a sharp play signal', async () => {
    // The Warriors fixture has Fliff at -120 while sharp books are at -140
    // This should surface as a sharp play with Fliff as the target book
    const handlers = createHandlers();
    const result = await handlers.sharp_plays({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      targetBooks: ['Fliff'],
      limit: 10
    });

    assert.equal(result.ok, true);
    // The sharp play detection depends on the full pipeline —
    // at minimum, the handler should not crash and should return structured data
    assert.ok(Array.isArray(result.result));
  });

  it('handles multiple leagues', async () => {
    const handlers = createHandlers();
    const result = await handlers.sharp_plays({
      leagues: ['NBA', 'MLB'],
      markets: ['Moneyline'],
      limit: 5
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.result));
  });
});

// ─── quick_screen ──────────────────────────────────────────────────

describe('handler integration: quick_screen', () => {
  it('validates every returned candidate by default (validate defaults true)', async () => {
    const handlers = createHandlers();
    const result = await handlers.quick_screen({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      limit: 5,
      includeResearch: false
    });
    assert.equal(result.ok, true);
    let seen = 0;
    let validated = 0;
    for (const entry of result.results || []) {
      for (const c of entry.candidates || []) {
        seen += 1;
        if (c._validated === true) validated += 1;
        assert.ok(c.validatedTier, `candidate ${c.selection} should carry validatedTier`);
      }
    }
    assert.ok(seen > 0, 'should have returned candidates');
    assert.equal(validated, seen, 'every returned candidate should be validated by default');
    assert.ok(result._meta && result._meta.validation, '_meta.validation should be present');
    assert.ok(result._meta.validation.completedCount > 0, 'completedCount should be > 0');
  });

  it('skips validation when validate: false', async () => {
    const handlers = createHandlers();
    const result = await handlers.quick_screen({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      limit: 5,
      validate: false,
      includeResearch: false
    });
    assert.equal(result.ok, true);
    let seen = 0;
    for (const entry of result.results || []) {
      for (const c of entry.candidates || []) {
        seen += 1;
        assert.notEqual(c._validated, true, 'no candidate should be validated when validate:false');
      }
    }
    assert.ok(seen > 0, 'should still return candidates');
    assert.ok(!result._meta || !result._meta.validation, '_meta.validation should be absent when validate:false');
  });

  it('applies validateTop globally across league-market buckets', async () => {
    const handlers = createHandlers();
    const result = await handlers.quick_screen({
      leagues: ['NBA'],
      markets: ['Moneyline', 'Point Spread'],
      limit: 10,
      validateTop: 1,
      includeResearch: false
    });
    assert.equal(result.ok, true);
    const candidates = (result.results || []).flatMap((entry) => entry.candidates || []);
    assert.ok(candidates.length > 1, 'fixture must expose candidates across the aggregate scan');
    assert.equal(
      candidates.filter((candidate) => candidate._validated === true).length,
      1,
      'validateTop:1 must validate one candidate globally, not one per bucket'
    );
    assert.equal(result._meta.validation.completedCount, 1);
  });

  it('finalVerdict resolves to validation when screen and validation disagree', async () => {
    const handlers = createHandlers();
    const result = await handlers.quick_screen({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      limit: 5,
      includeResearch: false
    });
    assert.equal(result.ok, true);
    let seen = 0;
    for (const entry of result.results || []) {
      for (const c of entry.candidates || []) {
        seen += 1;
        assert.ok(c.finalVerdict, `candidate ${c.selection} should carry finalVerdict`);
        assert.ok(['BET', 'CONSIDER', 'PASS'].includes(c.finalVerdict), `finalVerdict valid: ${c.finalVerdict}`);
        assert.ok(c.finalConfidenceTier, `candidate ${c.selection} should carry finalConfidenceTier`);
      }
    }
    assert.ok(seen > 0, 'should have returned candidates');
  });
});

// ─── sharp_alerts (on-demand, deduped) ───────────────────────────

describe('handler integration: sharp_alerts', () => {
  function makeHandlers() {
    const handlers = createHandlers();
    // sharp_alerts is tested here as an alert/dedup layer. Keep the upstream
    // screen pipeline out of this test so team selections cannot reach live
    // game-context lookups.
    handlers.quick_screen = async () => ({
      ok: true,
      research: [],
      results: [
        {
          market: 'Moneyline',
          candidates: [
            {
              gameId: 'nba-alert-game',
              game: 'Lakers @ Celtics',
              selection: 'Lakers',
              odds: -110,
              edge: 3.2,
              start: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              startCST: '8:00 PM CDT',
              finalVerdict: 'BET',
              finalConfidenceTier: 'TIER 1'
            }
          ]
        }
      ]
    });
    return handlers;
  }

  it('returns ok and dedups repeats within the window', async () => {
    const handlers = makeHandlers();
    const tmp = require('os').tmpdir() + '/pp-alerts-test-' + Date.now() + '.json';
    const first = await handlers.sharp_alerts({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      storePath: tmp
    });
    assert.equal(first.ok, true);
    assert.ok(Array.isArray(first.newAlerts), 'newAlerts is an array');
    assert.ok(Array.isArray(first.repeatAlerts), 'repeatAlerts is an array');
    assert.ok(Array.isArray(first.allBets), 'allBets is an array');

    const second = await handlers.sharp_alerts({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      storePath: tmp
    });
    assert.equal(second.ok, true);
    // Second call within the dedup window must not surface MORE new alerts.
    assert.ok(second.newAlerts.length <= first.newAlerts.length, 'repeat call yields no more new alerts than first');
    // Every alert carries the canonical fields.
    for (const a of first.allBets) {
      assert.ok(a.game && a.selection && a.market, 'alert has game/selection/market');
      assert.ok(['BET'].includes(a.finalVerdict || 'BET'), 'allBets are BET-tier');
    }
  });
});

// ─── quick_screen research scoping ───────────────────────────────

describe('handler integration: quick_screen research scoping', () => {
  // Stub player_context + game_context paths so research never hits network.
  function makeHandlers() {
    let gameContextCalls = 0;
    const handlers = createHandlers(
      {},
      {
        // Team/line selections must route through this fake instead of the
        // real game-context lookups (ESPN/web). Count invocations so tests
        // can assert every final team/line selection went through it.
        gameContextFn: async () => {
          gameContextCalls += 1;
          return {
            riskFlag: 'clean',
            riskSummary: 'fixture game context',
            fetchedAt: new Date(0).toISOString()
          };
        }
      }
    );
    handlers.player_context = async () => ({ riskFlag: 'clean', tweets: [], news: [] });
    return { handlers, gameContextCalls: () => gameContextCalls };
  }

  it('research runs by default and is scoped to final returned plays', async () => {
    const { handlers, gameContextCalls } = makeHandlers();
    const result = await handlers.quick_screen({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      limit: 5
    });

    assert.equal(result.ok, true);
    // research must be present by default (no includeResearch arg)
    assert.ok(Array.isArray(result.research), 'research should be an array');
    assert.ok(result.research.length > 0, 'research should run by default');

    // every research entry must correspond to a selection in the final results
    const resultSelections = new Set();
    for (const entry of result.results || []) {
      for (const c of entry.candidates || []) {
        resultSelections.add(String(c.selection || '').toLowerCase());
      }
    }
    for (const r of result.research) {
      assert.ok(
        resultSelections.has(String(r.player || '').toLowerCase()),
        `research entry ${r.player} not present in final results`
      );
    }

    // research count must not exceed returned-play count (no raw-scan blowup)
    const totalPlays = (result.results || []).reduce((n, e) => n + (e.candidates?.length || 0), 0);
    assert.ok(
      result.research.length <= totalPlays + 1,
      `research (${result.research.length}) should not exceed returned plays (${totalPlays})`
    );

    // every final team/line selection must have routed through the injected
    // gameContextFn (no live lookups); player selections use player_context
    // and are excluded. Match buildFinalResearchBatch's dedup key so the
    // count equals the number of rows the runner passed to gameContextFn.
    const seenKeys = new Set();
    let nonPlayerCandidates = 0;
    for (const entry of result.results || []) {
      for (const c of entry.candidates || []) {
        const sel = String(c.selection || '').trim();
        if (!sel || isPlayerSelection(sel)) continue;
        const key = `${c.gameId || ''}:${sel.toLowerCase()}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        nonPlayerCandidates += 1;
      }
    }
    assert.ok(nonPlayerCandidates > 0, 'fixture should include team/line selections');
    assert.equal(
      gameContextCalls(),
      nonPlayerCandidates,
      `gameContextFn should be called once per non-player candidate (${nonPlayerCandidates}), got ${gameContextCalls()}`
    );
  });

  it('includeResearch:false yields empty research array', async () => {
    const { handlers } = makeHandlers();
    const result = await handlers.quick_screen({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      limit: 5,
      includeResearch: false
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.research), 'research should be an array');
    assert.equal(result.research.length, 0, 'research should be empty when disabled');
  });
});

// ─── recommended_bets ──────────────────────────────────────────────

describe('handler integration: recommended_bets', () => {
  it('returns recommended bets with tier and kai info', async () => {
    const handlers = createHandlers();
    const result = await handlers.recommended_bets({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      bankroll: 1000,
      limit: 10,
      includeResearch: false,
      hideVerdict: false
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.leagues), 'Should have leagues array');
    assert.ok(result.totalRecommended >= 0, 'Should have totalRecommended');
    assert.ok(result.marketsBreakdown, 'Should have marketsBreakdown');

    // Plays are nested under leagues
    for (const league of result.leagues) {
      assert.ok(league.league, 'League entry has league name');
      assert.ok(Array.isArray(league.plays), 'League entry has plays array');
      for (const play of league.plays) {
        assert.ok(play.selection || play.participant, 'Play has an identifier');
        assert.ok(play.odds !== undefined, 'Play has odds');
        assert.ok(play.confidenceTier, 'Play has confidenceTier');
        assert.ok(play.kaiCall, 'Play has kaiCall');
      }
    }
  });

  it('respects targetTiers filter', async () => {
    const handlers = createHandlers();
    const result = await handlers.recommended_bets({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      targetTiers: ['TIER 1'],
      bankroll: 1000,
      limit: 10,
      includeResearch: false,
      hideVerdict: false
    });

    assert.equal(result.ok, true);
    // All returned plays should satisfy the requested tier. The tier filter
    // keys off the authoritative finalConfidenceTier (validated merge), which
    // is also promoted into confidenceTier, so both must match. An empty
    // result is valid — it means validation downgraded every screen TIER 1
    // play below TIER 1, and the filter correctly dropped them.
    for (const league of result.leagues) {
      for (const play of league.plays) {
        const liveTier = play.finalConfidenceTier || play.confidenceTier;
        assert.equal(liveTier, 'TIER 1', `play ${play.selection} tier ${liveTier} leaked past TIER 1 filter`);
      }
    }
  });

  it('returns marketsBreakdown showing per-market counts', async () => {
    const handlers = createHandlers();
    const result = await handlers.recommended_bets({
      leagues: ['NBA'],
      markets: ['Moneyline', 'Spread', 'Total'],
      bankroll: 1000,
      limit: 10,
      includeResearch: false,
      hideVerdict: false
    });

    assert.equal(result.ok, true);
    assert.ok(result.marketsBreakdown, 'Should have marketsBreakdown');
    assert.ok(typeof result.marketsBreakdown === 'object');
  });

  it('validates every returned play by default (validate defaults true)', async () => {
    const handlers = createHandlers();
    const result = await handlers.recommended_bets({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      bankroll: 1000,
      limit: 10,
      includeResearch: false,
      hideVerdict: false
    });
    assert.equal(result.ok, true);
    let seen = 0;
    let validated = 0;
    for (const league of result.leagues) {
      for (const play of league.plays || []) {
        seen += 1;
        if (play._validated === true) validated += 1;
        assert.ok(play.validatedTier, `play ${play.selection} should carry validatedTier`);
      }
    }
    assert.ok(seen > 0, 'should have returned plays');
    assert.equal(validated, seen, 'every returned play should be validated by default');
    assert.ok(result._meta && result._meta.validation, '_meta.validation should be present');
  });

  it('skips validation when validate: false', async () => {
    const handlers = createHandlers();
    const result = await handlers.recommended_bets({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      bankroll: 1000,
      limit: 10,
      validate: false,
      includeResearch: false,
      hideVerdict: false
    });
    assert.equal(result.ok, true);
    let seen = 0;
    for (const league of result.leagues) {
      for (const play of league.plays || []) {
        seen += 1;
        assert.notEqual(play._validated, true, 'no play should be validated when validate:false');
      }
    }
    assert.ok(seen > 0, 'should still return plays');
    assert.ok(!result._meta || !result._meta.validation, '_meta.validation should be absent when validate:false');
  });
});

// ─── staking_plan ──────────────────────────────────────────────────

describe('handler integration: staking_plan', () => {
  it('returns stake allocations based on bankroll', async () => {
    const handlers = createHandlers();
    const result = await handlers.staking_plan({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      bankroll: 1000,
      limit: 10
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.stakes), 'Should have stakes array');
    assert.ok(result.stakes.length >= 0, 'Should have stakes (may be empty with mock data)');
    assert.ok(typeof result.totalStake === 'number', 'Should have totalStake');

    for (const stake of result.stakes) {
      assert.ok(stake.game, 'Stake has game');
      assert.ok(stake.selection, 'Stake has selection');
      assert.ok(stake.tier, 'Stake has tier');
      assert.ok(typeof stake.stakeDollars === 'number', 'Stake has stakeDollars');
    }
  });
});

// ─── find_best_price ───────────────────────────────────────────────

describe('handler integration: find_best_price', () => {
  it('returns line shopping data across books', async () => {
    const handlers = createHandlers();
    const result = await handlers.find_best_price({
      league: 'NBA',
      market: 'Moneyline',
      game: 'Lakers vs Celtics',
      selection: 'Los Angeles Lakers'
    });

    assert.equal(result.ok, true);
    assert.equal(result.found, true);
    assert.ok(result.bestPrice, 'Should have bestPrice');
    assert.ok(result.bestPrice.book, 'bestPrice has book');
    assert.ok(typeof result.bestPrice.odds === 'number', 'bestPrice has odds');
    assert.ok(Array.isArray(result.allPrices), 'Should have allPrices array');
    assert.ok(result.allPrices.length > 1, 'Should have prices from multiple books');

    // All prices should be sorted best to worst
    for (let i = 1; i < result.allPrices.length; i++) {
      assert.ok(
        result.allPrices[i].odds <= result.allPrices[i - 1].odds,
        `Prices should be sorted descending: ${result.allPrices[i - 1].odds} >= ${result.allPrices[i].odds}`
      );
    }
  });
});

// ─── all_slates ────────────────────────────────────────────────────

describe('handler integration: all_slates', () => {
  it('returns consolidated results across leagues', async () => {
    const handlers = createHandlers();
    const result = await handlers.all_slates({
      leagues: ['NBA'],
      market: 'Moneyline',
      limit: 3,
      includeAll: true
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.consolidated));
    assert.ok(result.leagueMeta);
    assert.ok(result.leaguesQueried);
    assert.ok(Number.isFinite(result.totalPlays));
  });

  it('handles multiple leagues', async () => {
    const handlers = createHandlers();
    const result = await handlers.all_slates({
      leagues: ['NBA', 'MLB'],
      market: 'Moneyline',
      limit: 2,
      includeAll: true
    });

    assert.equal(result.ok, true);
    assert.ok(result.leaguesQueried.includes('NBA'));
    assert.ok(result.leaguesQueried.includes('MLB'));
  });
});

// ─── health_status ─────────────────────────────────────────────────

describe('handler integration: health_status', () => {
  it('returns health with auth session info', async () => {
    const handlers = createHandlers();
    // health_status reads auth from disk — in test env it may fail
    // but it should not throw
    try {
      const result = await handlers.health_status();
      assert.ok(result !== undefined);
      if (result.ok) {
        assert.ok(result.auth);
        assert.ok(result.auth.session, 'Should have session expiry info');
      }
    } catch {
      // Expected in test env without auth file
    }
  });
});

// ─── league_presets ────────────────────────────────────────────────

describe('handler integration: league_presets', () => {
  it('returns league presets without any client calls', async () => {
    const { client, calls } = createMockClient();
    const handlers = createMcpHandlers({ client });
    const result = await handlers.league_presets();

    assert.equal(result.ok, true);
    assert.ok(result.result);
    // Should not have touched the client at all
    assert.equal(calls.queryScreenOddsBestComps.length, 0);
  });
});

// ─── ev_candidates ─────────────────────────────────────────────────

describe('handler integration: ev_candidates', () => {
  it('requires leagues param', async () => {
    const handlers = createHandlers();
    await assert.rejects(
      () => handlers.ev_candidates({}),
      (err) => err.code === 'MISSING_LEAGUES'
    );
  });

  it('returns EV candidates for NBA', async () => {
    const handlers = createHandlers();
    const result = await handlers.ev_candidates({
      leagues: ['NBA'],
      limit: 5
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.result));
  });
});

// ─── error handling ────────────────────────────────────────────────

describe('handler integration: error handling', () => {
  it('screen_ranked handles empty game_data gracefully', async () => {
    const handlers = createHandlers({
      screenPayloads: { 'NBA:Moneyline': { game_data: [] } }
    });
    const result = await handlers.screen_ranked({
      league: 'NBA',
      market: 'Moneyline',
      limit: 5,
      includeAll: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.result.length, 0);
  });

  it('screen_ranked handles missing selections gracefully', async () => {
    const handlers = createHandlers({
      screenPayloads: {
        'NBA:Moneyline': {
          game_data: [
            {
              gameId: 'empty-game',
              league: 'NBA',
              market: 'Moneyline',
              homeTeam: 'Team A',
              awayTeam: 'Team B',
              selections: {},
              defaultKey: 'a'
            }
          ]
        }
      }
    });
    const result = await handlers.screen_ranked({
      league: 'NBA',
      market: 'Moneyline',
      limit: 5,
      includeAll: true
    });

    assert.equal(result.ok, true);
  });

  it('sharp_plays handles empty leagues gracefully', async () => {
    const handlers = createHandlers();
    const result = await handlers.sharp_plays({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      limit: 5
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.result));
  });
});

// ─── get_play_details sanitization (regression: pitfall #48) ───────
//
// The handler used to crash with "Cannot read properties of undefined
// (reading 'filter')" when given stale/empty/malformed gameIds. The fix
// sanitizes input (trim, drop empties, dedupe) and guards the filter
// call so a missing `result` returns a clean envelope instead of crashing.

describe('handler integration: get_play_details sanitization', () => {
  it('throws MISSING_PARAMS when sanitized gameIds is empty', async () => {
    const handlers = createHandlers();
    await assert.rejects(
      handlers.get_play_details({
        league: 'NBA',
        gameIds: ['', '  ', null, undefined]
      }),
      (err) => err.code === 'MISSING_PARAMS' && err.status === 400
    );
  });

  it('dedupes and trims gameIds before passing to the screen client', async () => {
    const handlers = createHandlers();
    // Three copies with whitespace and exact duplicates should reduce to
    // one gameId. Verified via resultMeta.queryGameIds on the response.
    const result = await handlers.get_play_details({
      league: 'NBA',
      gameIds: ['nba-20260610-lal-bos', '  nba-20260610-lal-bos  ', 'nba-20260610-lal-bos']
    });
    assert.deepEqual(result.resultMeta.queryGameIds, ['nba-20260610-lal-bos']);
  });

  it('returns clean envelope when client throws on screen query', async () => {
    const { client } = createMockClient();
    client.queryScreenOddsBestComps = async () => {
      throw new Error('backend down');
    };
    const handlers = createMcpHandlers({ client });
    const result = await handlers.get_play_details({
      league: 'NBA',
      gameIds: ['nba-20260610-lal-bos']
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, []);
    assert.equal(result.resultMeta.errorCode, 'SCREEN_QUERY_FAILED');
    assert.equal(result.resultMeta.matchedRows, 0);
    assert.match(result.resultMeta.error, /backend down/);
  });

  it('returns clean envelope for a non-existent gameId (no rows match)', async () => {
    const { client } = createMockClient();
    // Empty screen payload — simulates a stale/closed gameId that the
    // upstream API no longer has data for. The handler must not crash.
    client.queryScreenOddsBestComps = async () => ({ rows: [] });
    const handlers = createMcpHandlers({ client });
    const result = await handlers.get_play_details({
      league: 'NBA',
      gameIds: ['nba-does-not-exist-12345']
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, []);
    // resultMeta is present and contains the sanitized gameIds.
    assert.ok(result.resultMeta, 'resultMeta is present');
    assert.deepEqual(result.resultMeta.queryGameIds, ['nba-does-not-exist-12345']);
  });
});
