'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { recoverTennisFromScreen } = require('../lib/tennis-fallback');

const NOW_SEC = Math.floor(Date.now() / 1000);
const HOUR = 3600;

/** Supportive Pinnacle/Circa/NoVigApp history: -150 → -175 over 6h. */
function supportiveHistory() {
  return {
    Pinnacle: [
      { odds: -150, start_ts: NOW_SEC - 6 * HOUR },
      { odds: -175, start_ts: NOW_SEC }
    ],
    Circa: [
      { odds: -150, start_ts: NOW_SEC - 6 * HOUR },
      { odds: -175, start_ts: NOW_SEC - 2 * HOUR },
      { odds: -175, start_ts: NOW_SEC }
    ],
    NoVigApp: [
      { odds: -150, start_ts: NOW_SEC - 4 * HOUR },
      { odds: -175, start_ts: NOW_SEC }
    ]
  };
}

/**
 * One game carrying a single two-sided selection for the given market.
 * Odds are deliberately varied per game so the current-market shortlist
 * score is well-defined and deterministic.
 */
function makeGame(gameId, market, edgeIndex) {
  const selectionKey = market === 'Moneyline' ? 'ml' : market === 'Total Games' ? 'tg' : 'sh';
  const homeOdds = -100 - edgeIndex * 5;
  return {
    gameId,
    awayTeam: `${gameId} Away`,
    homeTeam: `${gameId} Home`,
    start: new Date(Date.now() + 86400000).toISOString(),
    selections: {
      [selectionKey]: {
        selection1: `${gameId} Home`,
        selection1Id: `${market}:${gameId}_Home`,
        participant1: `${gameId} Home`,
        selection2: `${gameId} Away`,
        selection2Id: `${market}:${gameId}_Away`,
        participant2: `${gameId} Away`,
        odds: {
          NoVigApp: { odds1: homeOdds, odds2: -110 },
          Pinnacle: { odds1: -115, odds2: -115 }
        }
      }
    }
  };
}

/** Mock client: hundreds of raw candidates, live remaining-budget, and a
 * history endpoint that returns supportive history for every selection. */
function makeHugeClient({ remaining }) {
  const gamesByMarket = {
    Moneyline: Array.from({ length: 120 }, (_, index) => makeGame(`ml-${index}`, 'Moneyline', index)),
    'Total Games': Array.from({ length: 120 }, (_, index) => makeGame(`tg-${index}`, 'Total Games', index))
  };
  const historyCalls = [];
  const client = {
    historyCalls,
    oddsHistoryBudgetRemaining: () => remaining,
    queryScreenOdds({ market }) {
      return Promise.resolve({ game_data: gamesByMarket[market] || [] });
    },
    queryOddsHistory({ gameId, selectionId }) {
      historyCalls.push({ gameId, selectionId });
      return Promise.resolve(supportiveHistory());
    }
  };
  return client;
}

describe('recoverTennisFromScreen — bounded history budget', () => {
  it('hydrates only the configured side budget from hundreds of raw candidates', async () => {
    const client = makeHugeClient({ remaining: 40 });
    // 240 raw candidates (120 games × 2 markets × 1 entry) → would be 480
    // history calls without the shortlist. Declared cap 30 sides.
    const plays = await recoverTennisFromScreen({
      client,
      book: 'NoVigApp',
      markets: ['Moneyline', 'Total Games'],
      maxHistorySelections: 30,
      skipTimeCorrection: true
    });

    const meta = plays.fallbackMeta;
    assert.equal(meta.totalCandidates, 240);
    assert.equal(meta.skippedEntries, 240 - meta.hydratedEntries);
    assert.ok(meta.historyCalls <= 30, `history calls must respect maxHistorySelections, got ${meta.historyCalls}`);
    assert.ok(meta.historyCalls <= meta.effectiveMaxHistorySelections);
    assert.equal(client.historyCalls.length, meta.historyCalls, 'fallbackMeta.historyCalls must match actual calls');
    assert.ok(plays.length > 0, 'bounded fallback should still produce plays');
    assert.ok(plays.length <= meta.historyCalls, 'one play per hydrated side');

    // Market fairness: the round-robin shortlist must cover BOTH markets.
    const mlGames = new Set(client.historyCalls.map((call) => call.gameId).filter((id) => id.startsWith('ml-')));
    const tgGames = new Set(client.historyCalls.map((call) => call.gameId).filter((id) => id.startsWith('tg-')));
    assert.ok(mlGames.size > 0, 'Moneyline must be represented');
    assert.ok(tgGames.size > 0, 'Total Games must be represented');

    // Mock history exists for every hydrated side → some non-insufficient rows.
    const nonInsufficient = plays.filter((play) => play.movementDisposition !== 'insufficient');
    assert.ok(nonInsufficient.length > 0, `expected non-insufficient rows, got ${nonInsufficient.length}`);
    assert.ok(
      nonInsufficient.some((play) => play.movementDisposition.includes('supportive')),
      'supportive CLV should surface from the mock history'
    );

    // No budget exception: a fully bounded fallback must never throw
    // ODDS_HISTORY_BUDGET_EXHAUSTED (and never exceed the remaining window).
    assert.ok(meta.effectiveMaxHistorySelections <= 40, 'effective budget must respect the live window');
  });

  it('still clamps to the live remaining window with a margin', async () => {
    const client = makeHugeClient({ remaining: 6 });
    const plays = await recoverTennisFromScreen({
      client,
      book: 'NoVigApp',
      markets: ['Moneyline', 'Total Games'],
      maxHistorySelections: 60,
      skipTimeCorrection: true
    });
    const meta = plays.fallbackMeta;
    // remaining 6 - margin 2 = effectiveMax 4 sides.
    assert.equal(meta.effectiveMaxHistorySelections, 4);
    assert.equal(meta.historyCalls, 4);
    assert.equal(client.historyCalls.length, 4);
  });
});

describe('recoverTennisFromScreen — default side budget', () => {
  it('uses the 300-side default when the shared window permits it', async () => {
    const client = makeHugeClient({ remaining: 400 });
    const plays = await recoverTennisFromScreen({
      client,
      book: 'NoVigApp',
      markets: ['Moneyline', 'Total Games'],
      skipTimeCorrection: true
    });
    const meta = plays.fallbackMeta;
    assert.equal(meta.effectiveMaxHistorySelections, 300);
    assert.equal(meta.historyCalls, 300);
    assert.equal(client.historyCalls.length, 300);
  });
});

describe('recoverTennisFromScreen — effectiveMax 0/1/2/3 side budgets', () => {
  // remaining = effectiveMax + 2 (the fallback reserves a 2-call margin).
  async function runWithEffectiveMax(effectiveMax, markets) {
    const client = makeHugeClient({ remaining: effectiveMax + 2 });
    const plays = await recoverTennisFromScreen({
      client,
      book: 'NoVigApp',
      markets: markets || ['Moneyline', 'Total Games'],
      maxHistorySelections: 100,
      skipTimeCorrection: true
    });
    return { plays, meta: plays.fallbackMeta, historyCalls: client.historyCalls };
  }

  it('effectiveMax=0 hydrates nothing and makes zero history calls', async () => {
    const { plays, meta, historyCalls } = await runWithEffectiveMax(0);
    assert.equal(meta.effectiveMaxHistorySelections, 0);
    assert.equal(meta.historyCalls, 0);
    assert.equal(historyCalls.length, 0);
    assert.equal(plays.length, 0);
  });

  it('effectiveMax=1 hydrates exactly ONE side (never a paired double-hydration)', async () => {
    const { plays, meta, historyCalls } = await runWithEffectiveMax(1);
    assert.equal(meta.effectiveMaxHistorySelections, 1);
    assert.equal(meta.historyCalls, 1, 'effectiveMax=1 must make exactly one history call');
    assert.equal(historyCalls.length, 1);
    assert.equal(plays.length, 1);
  });

  it('effectiveMax=2 hydrates both sides of one paired entry', async () => {
    const { plays, meta, historyCalls } = await runWithEffectiveMax(2);
    assert.equal(meta.historyCalls, 2);
    assert.equal(historyCalls.length, 2);
    assert.equal(plays.length, 2);
    // Both plays belong to the same game+market pair.
    assert.equal(plays[0].gameId, plays[1].gameId);
    assert.equal(plays[0].market, plays[1].market);
    assert.notEqual(historyCalls[0].selectionId, historyCalls[1].selectionId);
  });

  it('effectiveMax=3 spends the odd call on the strongest side of the next entry', async () => {
    const { plays, meta, historyCalls } = await runWithEffectiveMax(3);
    assert.equal(meta.historyCalls, 3);
    assert.equal(historyCalls.length, 3);
    assert.equal(plays.length, 3);
    // Entry 1 fully paired (2 sides), entry 2 single side (3rd call).
    const gameCount = new Set(plays.map((play) => play.gameId)).size;
    assert.equal(gameCount, 2);
  });
});
