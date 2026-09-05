'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildValidationVerdict } = require('../scripts/server/handlers/validate-play-verdict');

function baseArgs(overrides = {}) {
  return {
    screenTier: 'TIER 2',
    screenKaiCall: 'BET',
    screenOdds: -110,
    screenMovementDisposition: 'supportive_clean',
    screenConsensusBookCount: 12,
    screenExecutionQuality: 'best',
    screenConsensusEdge: 2.5,
    ...overrides
  };
}

function matchingRow(overrides = {}) {
  return {
    gameId: 'NCAAF:GAME:Home:Away:123',
    selection: 'Home',
    odds: -110,
    consensusBookCount: 8, // 4 fewer than screen — drift noise without trust
    executionQuality: 'bad', // would be an instant PASS without trust
    ...overrides
  };
}

function runVerdict(args, row) {
  return buildValidationVerdict({
    args,
    matchingRow: row,
    matchedViaGameIdChange: false,
    detailError: null,
    fallbackNote: null,
    gameId: 'NCAAF:GAME:Home:Away:123',
    selection: 'Home',
    research: null,
    gameContext: null
  });
}

describe('validate scan-sourced trust (fast Novig market)', () => {
  it('keeps a screen BET when the re-fetch confirms the line, despite comp-set noise', () => {
    const result = runVerdict(baseArgs(), matchingRow());
    assert.equal(result.verdict, 'BET');
    assert.equal(result.consensusDrift, false);
  });

  it('trusts NoVig percentage-string prices (96.1% vs 95.5%)', () => {
    const result = runVerdict(
      baseArgs({ screenOdds: '96.1%' }),
      matchingRow({ odds: '95.5%' })
    );
    assert.equal(result.verdict, 'BET');
    assert.equal(result.consensusDrift, false);
  });

  it('downgrades to CONSIDER on a material price move (-110 → -150)', () => {
    const result = runVerdict(baseArgs(), matchingRow({ odds: -150 }));
    assert.equal(result.verdict, 'CONSIDER');
    assert.equal(result.consensusDrift, true);
  });

  it('downgrades to CONSIDER on a material percentage move (96.1% → 88%)', () => {
    const result = runVerdict(
      baseArgs({ screenOdds: '96.1%' }),
      matchingRow({ odds: '88.0%' })
    );
    assert.equal(result.verdict, 'CONSIDER');
    assert.equal(result.consensusDrift, true);
  });

  it('keeps the screen movement read when the re-fetch recomputes noise', () => {
    const result = runVerdict(baseArgs(), matchingRow());
    assert.equal(result.verdictSummary.movementDisposition, 'supportive_clean');
  });

  it('direct validate_play (no screen snapshot) keeps legacy strict behavior', () => {
    const args = baseArgs();
    delete args.screenKaiCall;
    delete args.screenTier;
    delete args.screenOdds;
    delete args.screenMovementDisposition;
    delete args.screenConsensusBookCount;
    delete args.screenExecutionQuality;
    const result = runVerdict(args, matchingRow());
    assert.notEqual(result.verdict, 'BET');
  });

  it('line gone (lookup_failed) still fails closed', () => {
    const result = buildValidationVerdict({
      args: baseArgs(),
      matchingRow: null,
      matchedViaGameIdChange: false,
      detailError: null,
      fallbackNote: null,
      gameId: 'NCAAF:GAME:Home:Away:123',
      selection: 'Home',
      research: null,
      gameContext: null
    });
    assert.equal(result.lookupStatus, 'lookup_failed');
    assert.notEqual(result.verdict, 'BET');
  });
});
