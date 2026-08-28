'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { cmdGame } = require('../bin/pp-cli');

async function runGameOutput(row) {
  const originalError = console.error;
  const originalLog = console.log;
  const output = [];
  console.error = () => {};
  console.log = (line = '') => output.push(String(line));
  try {
    await cmdGame(
      {
        get_play_details: async () => ({ result: [row] })
      },
      ['game', 'MLB:PREMATCH:TeamA:TeamB:1786017600'],
      {}
    );
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  return output.join('\n');
}

async function runGame(playId, flags = {}) {
  const calls = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    await cmdGame(
      {
        get_play_details: async (args) => {
          calls.push(args);
          return { result: [] };
        }
      },
      ['game', playId],
      { j: true, ...flags }
    );
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  return calls[0];
}

describe('pp game exact tennis selection propagation', () => {
  it('passes full play identity and exact selection to play details', async () => {
    const playId = 'Tennis:PREMATCH:Kessler:Mcnally:1786017600::Total Games::over 23.5';
    const args = await runGame(playId);

    assert.equal(args.gameIds[0], 'Tennis:PREMATCH:Kessler:Mcnally:1786017600');
    assert.equal(args.league, 'Tennis');
    assert.equal(args.market, 'Total Games');
    assert.equal(args.selection, 'over 23.5');
    assert.equal(args.playId, playId);
  });

  it('passes --selection without narrowing a bare game identity', async () => {
    const args = await runGame('Tennis:PREMATCH:Kessler:Mcnally:1786017600', { s: 'Over 23.5' });

    assert.equal(args.selection, 'Over 23.5');
    assert.equal(args.playId, undefined);
  });

  it('labels old movement history without calling the current quote old', async () => {
    const output = await runGameOutput({
      awayTeam: 'Team A',
      homeTeam: 'Team B',
      start: '2026-08-28T18:00:00Z',
      market: 'Moneyline',
      defaultKey: 'selection1',
      movementLabel: 'supportive',
      movementGrade: 'green',
      movementDisposition: 'supportive_clean',
      odds: -144,
      currentOdds: -144,
      targetBookOdds: -144,
      lastPointAgeMs: 72 * 60 * 1000
    });

    assert.match(output, /movement history is 72 min old/);
    assert.doesNotMatch(output, /quote is 72 min old/);
    assert.doesNotMatch(output, /verify current price/);
  });
});
