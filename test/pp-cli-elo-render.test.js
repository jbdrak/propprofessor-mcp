'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// eloContextLabel is internal to bin/pp-cli.js; it is NOT exported. Instead
// we verify the rendering contract end-to-end through renderScanOutput,
// which IS exported: a Tennis Moneyline play with an attached elo context
// must render the "elo X% vs mkt Y%" line, and plays without elo must not.

const cli = require('../bin/pp-cli');

function captureStdout(fn) {
  const orig = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

function makeEloPlay(overrides = {}) {
  return {
    selection: 'Bucsa',
    odds: -111,
    game: 'Chwalinska vs Bucsa',
    market: 'Moneyline',
    tier: 'TIER 1',
    movement: 'supportive_bouncy',
    edge: 2.6,
    ...overrides
  };
}

const ELO_CTX = {
  available: true,
  coverage: 'full',
  tour: 'atp',
  player1: { name: 'Maja Chwalinska', id: 'MAJA CHWALINSKA', matchedBy: 'exact_name' },
  player2: { name: 'Cristina Bucsa', id: 'CRISTINA BUCSA', matchedBy: 'exact_name' },
  probabilities: { player1: 0.2966, player2: 0.7034 },
  selectedProbability: 0.7034,
  marketFairProbability: 0.5265,
  disagreement: 0.1769
};

function renderResults(plays, extraFlags = {}) {
  const res = {
    data: {
      results: [
        { league: 'Tennis', market: 'All Markets', plays }
      ]
    }
  };
  return captureStdout(() =>
    cli.renderScanOutput(res, {
      flags: { ...extraFlags },
      leagues: ['Tennis'],
      marketList: undefined,
      book: 'NoVigApp',
      targetTiers: ['TIER 1', 'TIER 2'],
      cardWindow: 'all',
      limit: 50
    })
  );
}

describe('renderScanOutput elo line', () => {
  it('renders the elo vs market line when elo context is attached', () => {
    const play = makeEloPlay();
    play.elo = ELO_CTX;
    const out = renderResults([play]);
    assert.match(out, /elo 70% vs mkt 53% · \+18/);
  });

  it('does not render an elo line when elo is unavailable', () => {
    const play = makeEloPlay();
    play.elo = { available: false, coverage: 'player_unresolved' };
    const out = renderResults([play]);
    assert.doesNotMatch(out, /elo \d+% vs mkt/);
  });

  it('does not render an elo line when elo is absent entirely', () => {
    const out = renderResults([makeEloPlay()]);
    assert.doesNotMatch(out, /elo \d+% vs mkt/);
  });

  it('renders negative disagreement with a minus sign', () => {
    const play = makeEloPlay();
    play.elo = { ...ELO_CTX, selectedProbability: 0.40, disagreement: -0.1265 };
    const out = renderResults([play]);
    assert.match(out, /elo 40% vs mkt 53% · -13/);
  });
});
