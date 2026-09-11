'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatQuickScreenMinimal, formatQuickScreenStandard, formatQuickScreenBets } = require('../lib/ssb-formatter');

// Agent-facing parity on a single quick_screen response: the three verbosity
// formatters must agree on the identity fields agents use to chain tool calls.
// If one formatter emits `gameId` and another emits `game`, validation chaining
// breaks silently.

const sample = {
  ok: true,
  targetBook: 'Fliff',
  targetBooks: ['Fliff'],
  leagues: ['NBA', 'MLB'],
  markets: ['Moneyline'],
  workflow: 'Fliff target book. Sharp movement cross-referenced.',
  cardWindowFallthrough: true,
  nextDayMerged: true,
  nextDayDate: '2026-04-08',
  cardWindow: 'today',
  preHistoryShortlist: [{ league: 'NBA', market: 'Moneyline', shortlistedRows: 1 }],
  totalsRecoveryApplied: true,
  totalCandidates: 2,
  tierStats: { TIER_1: 1, TIER_2: 1 },
  activeSlate: [{ league: 'NBA', market: 'Moneyline', count: 1, error: null }],
  emptySlate: [{ league: 'MLB', market: 'Totals', reason: 'no candidates returned' }],
  warnings: ['Some games have already started. Live odds may be stale.'],
  results: [
    {
      league: 'NBA',
      market: 'Moneyline',
      perPairDiagnostics: [{ league: 'NBA', market: 'Moneyline', targetBookSelections: 1 }],
      candidates: [
        {
          game: 'Lakers vs Celtics',
          gameId: 'nba-2026-test',
          selection: 'Lakers',
          participant: 'Lakers',
          odds: -110,
          targetBookOdds: -112,
          bestAvailableOdds: -108,
          executionQuality: 'playable',
          currentOdds: -115,
          market: 'Moneyline',
          league: 'NBA',
          start: new Date(Date.now() + 2 * 3600000).toISOString(),
          startCST: 'Apr 7, 2026, 7:00 PM CDT',
          edge: 3.2,
          consensusEdge: 3.2,
          movementDisposition: 'supportive_clean',
          movementSourceBook: 'Pinnacle',
          movementMode: 'comparison_book',
          historyProvider: 'sharpodds',
          historyReason: null,
          historyWarning: null,
          movementEvidenceAged: true,
          movementHistoryAgeMs: 72 * 60 * 1000,
          validatedMovementDisposition: 'supportive_clean',
          finalVerdict: 'BET',
          finalConfidenceTier: 'TIER 1',
          confidenceTier: 'TIER 1',
          displayTier: 'BET',
          kaiCall: 'BET',
          riskScore: 2,
          playId: 'Moneyline:Lakers',
          selectionKey: 'lakers',
          consensusBookCount: 7,
          validatedConsensusBookCount: 7,
          validatedActionableSummary: 'Deep consensus, clean movement.',
          validatedRiskFlags: [],
          validatedTier: 'TIER 1'
        }
      ]
    }
  ]
};

describe('quick_screen verbosity field parity', () => {
  const minimal = formatQuickScreenMinimal(sample);
  const standard = formatQuickScreenStandard(sample);
  const bets = formatQuickScreenBets(sample);

  it('minimal response preserves one-call agent identity fields', async () => {
    assert.equal(minimal.type, 'plays', 'minimal should preserve a machine-readable plays array');
    const row = Array.isArray(minimal.plays) ? minimal.plays[0] : null;
    assert.ok(row, 'minimal.plays[0] should exist');
    assert.ok(row.game || row.gameId, 'minimal should expose game or gameId');
    assert.ok(row.selection, 'minimal should expose selection');
    assert.equal(row.targetBook, 'Fliff');
    assert.equal(row.targetBookOdds, -112);
    assert.equal(row.bestAvailableOdds, -108);
    assert.equal(row.executionQuality, 'playable');
    assert.equal(row.movementSourceBook, 'Pinnacle');
    assert.equal(row.movementMode, 'comparison_book');
    assert.equal(row.historyProvider, 'sharpodds');
    assert.ok('confidenceTier' in row, 'minimal should expose confidenceTier');
    assert.ok('edge' in row, 'minimal should expose edge');
    assert.ok('movementDisposition' in row, 'minimal should expose movementDisposition');
  });

  it('standard row keeps identity fields', async () => {
    const row = standard.results?.[0]?.candidates?.[0];
    assert.ok(row, 'standard should return candidates');
    assert.ok(row.game || row.gameId, 'standard should expose game or gameId');
    assert.equal(row.targetBook, 'Fliff');
    assert.equal(row.bestAvailableOdds, -108);
    assert.ok(row.selection, 'standard should expose selection');
    assert.ok('confidenceTier' in row || 'finalConfidenceTier' in row, 'standard should expose tier');
    assert.ok('finalVerdict' in row, 'standard should expose finalVerdict');
    assert.ok('movementDisposition' in row, 'standard should expose movementDisposition');
  });

  it('keeps movement disposition and current odds but hides movement-age diagnostics', async () => {
    const minimalRow = minimal.plays?.[0];
    const standardRow = standard.results?.[0]?.candidates?.[0];
    for (const row of [minimalRow, standardRow]) {
      assert.equal(row.odds, -110);
      assert.equal(row.movementDisposition, 'supportive_clean');
      assert.equal('lastPointAgeMs' in row, false);
      assert.equal('movementHistoryAgeMs' in row, false);
      assert.equal('movementEvidenceAged' in row, false);
    }
  });

  it('bets row keeps identity fields', async () => {
    const row = bets.results?.[0]?.plays?.[0];
    assert.ok(row, 'bets should return plays');
    assert.equal(row.odds, -110);
    assert.equal(row.targetBook, 'Fliff');
    assert.equal(row.targetBookOdds, -112);
    assert.equal(row.bestAvailableOdds, -108);
    assert.equal(row.executionQuality, 'playable');
    assert.equal(row.movementSourceBook, 'Pinnacle');
    assert.equal(row.movementMode, 'comparison_book');
    assert.equal(row.historyProvider, 'sharpodds');
    assert.ok(row.game || row.gameId, 'bets should expose game or gameId');
    assert.ok(row.selection, 'bets should expose selection');
    assert.ok('tier' in row, 'bets should expose tier');
    assert.ok('verdict' in row, 'bets should expose verdict');
    assert.ok('movement' in row, 'bets should expose movement');
    assert.ok('rationale' in row, 'bets should expose rationale/actionableSummary');
  });

  it('bets output keeps named-book identity and pair diagnostics', async () => {
    assert.equal(bets.targetBook, 'Fliff');
    assert.deepEqual(bets.targetBooks, ['Fliff']);
    assert.deepEqual(bets.leagues, ['NBA', 'MLB']);
    assert.deepEqual(bets.markets, ['Moneyline']);
    assert.equal(bets.workflow, sample.workflow);
    assert.deepEqual(bets.results[0].perPairDiagnostics, sample.results[0].perPairDiagnostics);
    assert.equal(bets.cardWindowFallthrough, true);
    assert.equal(bets.nextDayMerged, true);
    assert.equal(bets.nextDayDate, '2026-04-08');
    assert.equal(bets.cardWindow, 'today');
    assert.deepEqual(bets.preHistoryShortlist, sample.preHistoryShortlist);
    assert.equal(bets.totalsRecoveryApplied, true);
  });

  it('bets output keeps emptySlate/activeSlate/warnings diagnostics', async () => {
    assert.deepEqual(bets.activeSlate, sample.activeSlate);
    assert.deepEqual(bets.emptySlate, sample.emptySlate);
    assert.deepEqual(bets.warnings, sample.warnings);
  });
});
