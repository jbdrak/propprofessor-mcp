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

  it('direct validate_play uses the current row call without manufacturing a BET from tier', () => {
    const args = baseArgs();
    delete args.screenKaiCall;
    delete args.screenTier;
    delete args.screenOdds;
    delete args.screenMovementDisposition;
    delete args.screenConsensusBookCount;
    delete args.screenExecutionQuality;

    const bet = runVerdict(
      args,
      matchingRow({ kaiCall: 'BET', confidenceTier: 'TIER 1', executionQuality: 'bad', consensusBookCount: 1 })
    );
    assert.equal(bet.verdict, 'BET');
    assert.equal(bet.tier, 'TIER 1');

    const noCall = runVerdict(
      args,
      matchingRow({ kaiCall: undefined, confidenceTier: 'TIER 1', executionQuality: 'best' })
    );
    assert.equal(noCall.verdict, 'PASS');
    assert.equal(noCall.tier, 'TIER 4');
  });

  it('treats research and game context as enrichment without changing the ranker verdict', () => {
    const result = buildValidationVerdict({
      args: baseArgs(),
      matchingRow: matchingRow({ kaiCall: 'BET', confidenceTier: 'TIER 2' }),
      matchedViaGameIdChange: false,
      detailError: null,
      fallbackNote: null,
      gameId: 'NCAAF:GAME:Home:Away:123',
      selection: 'Home',
      research: { riskFlag: 'high' },
      gameContext: { riskFlag: 'high', riskSummary: 'storm' }
    });

    assert.equal(result.verdict, 'BET');
    assert.equal(result.tier, 'TIER 2');
  });

  it('never promotes a screen CONSIDER, PASS, or WATCH from a stronger re-fetch row', () => {
    const currentBet = matchingRow({
      kaiCall: 'BET',
      confidenceTier: 'TIER 1',
      quoteAsOf: '2026-09-06T12:00:00.000Z'
    });
    const consider = runVerdict(baseArgs({ screenKaiCall: 'CONSIDER', screenTier: 'TIER 2' }), currentBet);
    assert.equal(consider.verdict, 'CONSIDER');
    assert.equal(consider.tier, 'TIER 2');

    const pass = runVerdict(baseArgs({ screenKaiCall: 'PASS', screenTier: 'TIER 4' }), currentBet);
    assert.equal(pass.verdict, 'PASS');
    assert.equal(pass.tier, 'TIER 4');

    const watch = runVerdict(baseArgs({ screenKaiCall: 'WATCH', screenTier: 'TIER 2' }), currentBet);
    assert.equal(watch.verdict, 'PASS');
    assert.equal(watch.tier, 'TIER 4');
    assert.equal(watch.confirmation.quoteAsOf, '2026-09-06T12:00:00.000Z');
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
