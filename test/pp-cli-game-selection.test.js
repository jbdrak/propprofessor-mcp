'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { cmdGame } = require('../bin/pp-cli');

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
});
