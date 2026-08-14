#!/usr/bin/env node
'use strict';

/**
 * Offline portfolio fixture: scan row -> immutable candidate -> reviewed bet ->
 * supplied result -> ledger-derived evaluation. No files, network, or clocks.
 */

const assert = require('node:assert/strict');
const { createLedger, addRecord } = require('../lib/record-ledger');
const { normalizeScanCandidates } = require('../lib/record-candidates');
const { promoteCard } = require('../lib/record-card');
const { solve } = require('../lib/record-settlement');
const { buildEvaluationRows, deriveCalibration } = require('../lib/record-evaluation');

function runExample() {
  const ledger = createLedger();
  const scanId = 'fixture-scan-2026-08-14';
  const capturedAt = '2026-08-14T12:00:00.000Z';

  addRecord(
    ledger,
    'scans',
    { id: scanId, source: 'offline-fixture', recordedAt: capturedAt },
    { now: () => capturedAt }
  );

  const play = {
    gameId: 'fixture-tennis-001',
    game: 'Ada Player vs Bea Player',
    league: 'Tennis',
    market: 'Moneyline',
    selection: 'Ada Player',
    odds: -110,
    start: '2026-08-15T15:00:00.000Z',
    signalTier: 'TIER 2',
    movementGrade: 'supportive',
    finalVerdict: 'BET',
    marketFairProbability: 0.52,
    modelWinProbability: 0.56,
    elo: {
      available: true,
      selectedProbability: 0.54,
      modelVersion: 'tennis-elo@1.0.0',
      asOf: '2026-08-14',
      coverage: 'available'
    }
  };

  const [candidate] = normalizeScanCandidates([{ league: 'Tennis', market: 'Moneyline', plays: [play] }], {
    scanId,
    capturedAt
  });
  candidate.scanId = scanId;
  addRecord(ledger, 'candidates', candidate, { now: () => capturedAt });

  // Prove the recorded decision snapshot doesn't follow later source mutation.
  play.elo.selectedProbability = 0.99;
  assert.equal(candidate.featureSnapshot.tennis.elo.selectedProbability, 0.54);

  const promotion = promoteCard(
    ledger,
    {
      candidateId: candidate.candidateId,
      decision: 'BET',
      odds: -110,
      stake: 10,
      researchSummary: 'Synthetic fixture only; no predictive claim.',
      decisionSource: 'offline-example',
      scheduleVerification: { source: 'fixture', verified: true },
      lineVerification: { source: 'fixture', verified: true }
    },
    { now: () => '2026-08-14T12:05:00.000Z' }
  );
  assert.equal(promotion.ok, true);

  const settlement = solve(ledger, {
    now: () => '2026-08-15T18:00:00.000Z',
    resultData: {
      provider: 'offline-fixture',
      sourceUrl: 'https://example.invalid/offline-fixture',
      events: [
        {
          eventId: 'fixture-tennis-001',
          homeTeam: 'Ada Player',
          awayTeam: 'Bea Player',
          winner: 'Ada Player',
          status: 'final',
          date: '2026-08-15T15:00:00.000Z'
        }
      ]
    }
  });
  assert.equal(settlement.settled.length, 1);

  const rows = buildEvaluationRows(ledger);
  const calibration = deriveCalibration(ledger, { minSample: 30 });
  const bucket = Object.values(calibration)[0] || null;
  const officialSnapshot = ledger.bets[0].featureSnapshot;

  return {
    flow: {
      candidates: ledger.candidates.length,
      officialBets: ledger.bets.length,
      settlements: ledger.settlements.length,
      evaluationRows: rows.length
    },
    decisionSnapshot: {
      schemaVersion: officialSnapshot.schemaVersion,
      marketFairProbability: rows[0].marketFairProbability,
      modelWinProbability: rows[0].modelWinProbability,
      eloProbability: rows[0].tennisElo.selectedProbability
    },
    outcome: rows[0].outcome,
    calibration: bucket,
    caveat: 'Synthetic one-bet fixture. Insufficient sample; no accuracy, significance, or uplift claim.'
  };
}

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(runExample(), null, 2)}\n`);
}

module.exports = { runExample };
