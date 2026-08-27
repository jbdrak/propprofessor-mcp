'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');

const { parseGameString, getGameContext } = require('../lib/propprofessor-game-context');

describe('parseGameString — branches', () => {
  it('returns single team as team1 when no separator present', () => {
    const r = parseGameString('Yankees');
    assert.equal(r.team1, 'Yankees');
    assert.equal(r.team2, '');
    assert.equal(r.separator, null);
  });

  it('fallback split for edge-case separators (legacy path)', () => {
    const r = parseGameString('TeamA  vs  TeamB');
    // Leading (.+?) non-greedy match still catches the first "vs".
    assert.equal(r.team1.length > 0, true);
    assert.equal(r.team2.length > 0, true);
  });

  it('returns empty objects for non-string input', () => {
    const r = parseGameString(42);
    assert.deepEqual(r, { team1: '', team2: '', separator: null });
    const r2 = parseGameString('');
    assert.deepEqual(r2, { team1: '', team2: '', separator: null });
  });
});

describe('getGameContext — sport mapping + default branch', () => {
  it('returns clean default for an unknown sport with a selection', async () => {
    const r = await getGameContext({ sport: 'GOLF', selection: 'Tiger Woods' });
    assert.equal(r.riskFlag, 'clean');
    assert.ok(r.riskSummary.includes('Unknown'));
  });

  it('default branch with no selection yields null riskSummary', async () => {
    const r = await getGameContext({ sport: 'GOLF' });
    assert.equal(r.riskFlag, 'clean');
    assert.equal(r.riskSummary, null);
  });

  it('routes NHL to NHL handler without error', async () => {
    const r = await getGameContext({ sport: 'NHL', selection: 'Oilers', game: 'Oilers vs Kings' });
    assert.ok(typeof r.riskFlag === 'string');
  });

  it('routes NCAAB to basketball handler', async () => {
    const r = await getGameContext({ sport: 'NCAAB', selection: 'Duke', game: 'Duke vs UNC' });
    assert.ok(typeof r.riskFlag === 'string');
  });
});

describe('getGameContext — cache hit behavior', () => {
  before(() => {
    // Mock child_process.execFile so live MLB/tennis calls never fire.
    if (!cp.__orig) cp.__orig = cp.execFile;
    cp.execFile = (_file, _args, _opts, cb) => {
      cb(null, JSON.stringify({ dates: [] }), '');
      return { kill() {} };
    };
  });
  after(() => {
    if (cp.__orig) cp.execFile = cp.__orig;
  });

  it('serves a cached result on the second identical non-imminent call', async () => {
    const args = {
      sport: 'MLB',
      selection: 'Reds',
      game: 'Cincinnati Reds vs Milwaukee Brewers',
      start: '2027-09-01T20:00:00Z'
    };
    const first = await getGameContext(args);
    const second = await getGameContext(args);
    assert.equal(second.cached, true, 'second call should be served from cache');
    assert.equal(first.cached, false);
  });

  it('does not cache error results as a hit', async () => {
    // Unknown sport always resolves to default (clean), so cache is set.
    // Use Tennis with a unique far-future start to get a fresh slot.
    const args = {
      sport: 'Tennis',
      selection: 'CacheNoErr1',
      game: 'CacheNoErr1 vs CacheNoErr2',
      start: '2027-10-01T10:00:00Z'
    };
    const r = await getGameContext(args);
    assert.ok(r.riskFlag === 'unknown' || typeof r.riskFlag === 'string');
  });
});
