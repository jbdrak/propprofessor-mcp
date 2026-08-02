'use strict';

/**
 * Plan Task 6 regression tests: validation/cache must not resurrect totals
 * conflict losers.
 *
 * Guards under test:
 *  - `applyFinalVerdict` honors conflictFlag / totalsConflictWith and clamps
 *    the final tier so a conflict-downgraded play cannot ship as visually
 *    TIER 1.
 *  - Conflict metadata survives candidate mapping (mapCandidateRow) so the
 *    verdict guard actually fires in quick_screen / recommended_bets.
 *  - The recommended_bets validation cache key includes the selection
 *    (gameId::selection::market) so a cached Over verdict can never be
 *    replayed onto the opposing Under line.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');
const { applyFinalVerdict } = require('../scripts/server/handlers');
const { mapCandidateRow } = require('../lib/propprofessor-mcp-candidate-mapper');

/** A "cached validator response" that blesses the row as BET / TIER 1. */
function cachedValidatorResponse(overrides = {}) {
  return {
    ok: true,
    verdict: 'BET',
    tier: 'TIER 1',
    verdictSummary: {
      displayTier: 'BET',
      movementDisposition: 'supportive_clean',
      executionQuality: 'playable',
      riskFlags: [],
      actionableSummary: 'Deep consensus, clean movement.',
      consensusSupport: '9 books'
    },
    play: { consensusBookCount: 9, executionQuality: 'playable', odds: -110, consensusEdge: 1.8, clvProxyPct: 1.2 },
    consensusDrift: false,
    driftReason: null,
    gameContext: null,
    ...overrides
  };
}

/**
 * Two opposing totals on the same game, shaped exactly like the output of
 * resolveTotalsConflicts in lib/screen-ranker.js: the loser is demoted one
 * tier (TIER 1 → TIER 2), demoted to CONSIDER, and carries totalsConflictWith
 * pointing at the winning side.
 */
function totalsConflictFixtureRows() {
  const winner = {
    gameId: 'WNBA:game-2',
    selection: 'Over 168.5',
    market: 'Total Points',
    screenScore: 82,
    odds: -110,
    edge: 2.1,
    consensusEdge: 2.1,
    consensusBookCount: 9,
    confidenceTier: 'TIER 1',
    kaiCall: 'BET',
    displayTier: 'BET',
    movementDisposition: 'supportive_clean',
    executionQuality: 'playable',
    riskScore: 1,
    hoursUntilStart: 5
  };
  const loser = {
    ...winner,
    selection: 'Under 171.5',
    screenScore: 71,
    edge: 1.6,
    consensusEdge: 1.6,
    confidenceTier: 'TIER 2', // screen ranker already demoted TIER 1 → TIER 2
    kaiCall: 'CONSIDER',
    displayTier: 'CONSIDER',
    movementDisposition: 'adverse_full',
    totalsConflictWith: 'Over 168.5'
  };
  return [winner, loser];
}

describe('applyFinalVerdict conflict tier clamp', () => {
  it('clamps a totals-conflict loser out of TIER 1 even when validation re-grades it TIER 1', () => {
    const cand = {
      gameId: 'WNBA:game-2',
      selection: 'Under 171.5',
      totalsConflictWith: 'Over 168.5',
      kaiCall: 'CONSIDER',
      displayTier: 'CONSIDER',
      confidenceTier: 'TIER 2', // screen ranker demotion
      validatedConfidenceTier: 'TIER 1', // validate re-grades back to TIER 1
      validatedVerdict: 'BET', // validate wants to resurrect the loser
      validatedRiskFlags: [],
      validatedConsensusDrift: false,
      validatedUnverified: false
    };
    applyFinalVerdict(cand);
    assert.equal(cand.finalVerdict, 'CONSIDER', 'conflict loser must stay CONSIDER, not resurrect to BET');
    assert.equal(cand.finalConfidenceTier, 'TIER 2', 'conflict loser must not ship as visually TIER 1');
  });

  it('clamps a side-conflict loser to the screen-demoted tier', () => {
    const cand = {
      gameId: 'WNBA:game-1',
      selection: 'Phoenix Mercury',
      conflictFlag: true,
      conflictWith: 'Las Vegas Aces',
      kaiCall: 'CONSIDER',
      displayTier: 'CONSIDER',
      confidenceTier: 'TIER 3',
      validatedConfidenceTier: 'TIER 1',
      validatedVerdict: 'BET',
      validatedRiskFlags: [],
      validatedConsensusDrift: false,
      validatedUnverified: false
    };
    applyFinalVerdict(cand);
    assert.equal(cand.finalVerdict, 'CONSIDER', 'side-conflict loser must not resurrect to BET');
    assert.equal(cand.finalConfidenceTier, 'TIER 3', 'tier clamped to screen-demoted TIER 3, not validated TIER 1');
  });

  it('does not tighten a conflict loser whose validated tier is already worse than the screen demotion', () => {
    const cand = {
      gameId: 'WNBA:game-2',
      selection: 'Under 171.5',
      totalsConflictWith: 'Over 168.5',
      kaiCall: 'CONSIDER',
      displayTier: 'CONSIDER',
      confidenceTier: 'TIER 2',
      validatedConfidenceTier: 'TIER 3',
      validatedVerdict: 'CONSIDER',
      validatedRiskFlags: [],
      validatedConsensusDrift: false,
      validatedUnverified: false
    };
    applyFinalVerdict(cand);
    assert.equal(cand.finalVerdict, 'CONSIDER');
    assert.equal(cand.finalConfidenceTier, 'TIER 3', 'a worse validated tier is respected');
  });
});

describe('mapCandidateRow preserves conflict metadata', () => {
  it('keeps totalsConflictWith / conflictFlag / conflictWith so the verdict guard can fire downstream', () => {
    const [winner, loser] = totalsConflictFixtureRows();
    const mappedWinner = mapCandidateRow(winner);
    const mappedLoser = mapCandidateRow(loser);
    assert.equal(mappedWinner.totalsConflictWith, undefined);
    assert.equal(mappedLoser.totalsConflictWith, 'Over 168.5', 'totals conflict pointer must survive mapping');
    assert.equal(
      mappedLoser.conflictFlag,
      false,
      'conflictFlag is explicit false when only totals conflict is present'
    );
    assert.equal(mappedLoser.conflictWith, null);

    const sideLoser = mapCandidateRow({ ...winner, conflictFlag: true, conflictWith: 'Las Vegas Aces' });
    assert.equal(sideLoser.conflictFlag, true, 'conflictFlag must survive mapping');
    assert.equal(sideLoser.conflictWith, 'Las Vegas Aces', 'conflictWith must survive mapping');
  });
});

describe('recommended_bets: totals conflict losers survive validation (plan Task 6)', () => {
  function makeHandlers() {
    const handlers = createMcpHandlers({ client: {} });
    const [winner, loser] = totalsConflictFixtureRows();
    handlers.screen_ranked = async () => ({ ok: true, result: [winner, loser] });
    handlers.player_context = async () => ({ riskFlag: 'clean', tweets: [], news: [] });
    return { handlers, winner, loser };
  }

  async function runRecommendedBets(handlers) {
    return handlers.recommended_bets({
      leagues: ['WNBA'],
      markets: ['Total Points'],
      bankroll: 1000,
      limit: 10,
      validate: true,
      includeResearch: false,
      hideVerdict: false
    });
  }

  function findPlays(r) {
    const plays = r.leagues[0].plays;
    return {
      over: plays.find((p) => p.selection === 'Over 168.5'),
      under: plays.find((p) => p.selection === 'Under 171.5')
    };
  }

  it('keeps the conflict loser at CONSIDER (clamped out of TIER 1) and the winner at BET when the cached validator blesses both sides as BET/TIER 1', async () => {
    const { handlers } = makeHandlers();
    handlers.runValidatePlayImpl = async () => cachedValidatorResponse();

    const r = await runRecommendedBets(handlers);
    assert.equal(r.ok, true);
    const { over, under } = findPlays(r);
    assert.ok(over && under, 'both opposing totals plays should be returned');

    assert.equal(under.finalVerdict, 'CONSIDER', 'conflict loser stays CONSIDER after validation');
    assert.notEqual(under.finalVerdict, 'BET', 'conflict loser must not resurrect to BET');
    assert.equal(under.finalConfidenceTier, 'TIER 2', 'conflict loser clamped out of visually TIER 1');
    assert.equal(under.displayTier, 'CONSIDER');
    assert.equal(under.kaiCall, 'CONSIDER');

    assert.equal(over.finalVerdict, 'BET', 'conflict winner remains BET');
    assert.equal(over.finalConfidenceTier, 'TIER 1', 'conflict winner keeps TIER 1');
  });

  it('validates Over and Under with separate calls — the cached Over result is never reused for Under', async () => {
    const { handlers } = makeHandlers();
    const validateCalls = [];
    handlers.runValidatePlayImpl = async (client, args) => {
      validateCalls.push(args.selection);
      if (String(args.selection).toLowerCase().startsWith('under')) {
        return cachedValidatorResponse({
          verdict: 'CONSIDER',
          tier: 'TIER 3',
          verdictSummary: { ...cachedValidatorResponse().verdictSummary, displayTier: 'CONSIDER' }
        });
      }
      return cachedValidatorResponse();
    };

    const r = await runRecommendedBets(handlers);
    assert.equal(r.ok, true);
    const { over, under } = findPlays(r);
    assert.ok(over && under);

    // Per-selection cache identity: one validate call per side, each for its
    // own selection (cache key must be gameId::selection::market).
    assert.deepEqual([...validateCalls].sort(), ['Over 168.5', 'Under 171.5']);

    // Under carries Under's own CONSIDER/TIER 3 response — never Over's cached BET.
    assert.equal(under.finalVerdict, 'CONSIDER');
    assert.equal(under.finalConfidenceTier, 'TIER 3');
    assert.equal(over.finalVerdict, 'BET');
    assert.equal(over.finalConfidenceTier, 'TIER 1');
  });
});
