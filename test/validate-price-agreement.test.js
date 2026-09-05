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
    consensusBookCount: 8, // 4 fewer than screen — would be drift without price agreement
    executionQuality: 'bad', // would be an instant PASS without price agreement
    ...overrides
  };
}

describe('validate price-agreement trust', () => {
  it('keeps a screen BET when the re-fetch agrees on price despite comp-set noise', () => {
    const result = buildValidationVerdict({
      args: baseArgs(),
      matchingRow: matchingRow(),
      matchedViaGameIdChange: false,
      detailError: null,
      fallbackNote: null,
      gameId: 'NCAAF:GAME:Home:Away:123',
      selection: 'Home',
      research: null,
      gameContext: null
    });
    assert.equal(result.verdict, 'BET');
    assert.equal(result.consensusDrift, false);
  });

  it('still downgrades when the re-fetch price actually moved', () => {
    const result = buildValidationVerdict({
      args: baseArgs(),
      matchingRow: matchingRow({ odds: -150 }),
      matchedViaGameIdChange: false,
      detailError: null,
      fallbackNote: null,
      gameId: 'NCAAF:GAME:Home:Away:123',
      selection: 'Home',
      research: null,
      gameContext: null
    });
    // -110 → -150 is a 40-point move: drift + exec-bad downgrades apply
    assert.notEqual(result.verdict, 'BET');
  });

  it('keeps old behavior when no screen odds were passed (direct validate_play)', () => {
    const args = baseArgs();
    delete args.screenOdds;
    const result = buildValidationVerdict({
      args,
      matchingRow: matchingRow(),
      matchedViaGameIdChange: false,
      detailError: null,
      fallbackNote: null,
      gameId: 'NCAAF:GAME:Home:Away:123',
      selection: 'Home',
      research: null,
      gameContext: null
    });
    assert.notEqual(result.verdict, 'BET');
  });

  it('trusts NoVig percentage-string prices (96.1% vs 95.5% agree)', () => {
    const result = buildValidationVerdict({
      args: baseArgs({ screenOdds: '96.1%' }),
      matchingRow: matchingRow({ odds: '95.5%' }),
      matchedViaGameIdChange: false,
      detailError: null,
      fallbackNote: null,
      gameId: 'NCAAF:GAME:Home:Away:123',
      selection: 'Home',
      research: null,
      gameContext: null
    });
    assert.equal(result.verdict, 'BET');
    assert.equal(result.consensusDrift, false);
  });

  it('still downgrades when percentage prices actually moved (96.1% vs 88%)', () => {
    const result = buildValidationVerdict({
      args: baseArgs({ screenOdds: '96.1%' }),
      matchingRow: matchingRow({ odds: '88.0%' }),
      matchedViaGameIdChange: false,
      detailError: null,
      fallbackNote: null,
      gameId: 'NCAAF:GAME:Home:Away:123',
      selection: 'Home',
      research: null,
      gameContext: null
    });
    assert.notEqual(result.verdict, 'BET');
  });
});
