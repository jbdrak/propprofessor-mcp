'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { filterPayloadByLeagueName, resolveSoccerLeague } = require('../scripts/server/handlers/handler-utils');
const { resolveScreenCommand, parseArgs } = require('../scripts/query-propprofessor');

test('maps named soccer competitions to the Soccer backend and leagueName scope', () => {
  assert.deepEqual(resolveSoccerLeague('EPL'), { league: 'Soccer', leagueName: 'EPL' });
  assert.deepEqual(resolveSoccerLeague('La Liga'), { league: 'Soccer', leagueName: 'La Liga' });
  assert.deepEqual(resolveSoccerLeague('Serie A'), { league: 'Soccer', leagueName: 'Serie A' });
  assert.deepEqual(resolveSoccerLeague('Soccer', 'Serie A'), { league: 'Soccer', leagueName: 'Serie A' });
  assert.deepEqual(resolveSoccerLeague('MLS'), { league: 'Soccer', leagueName: 'MLS' });
  assert.deepEqual(resolveSoccerLeague('Soccer', 'MLS'), { league: 'Soccer', leagueName: 'MLS' });
  assert.deepEqual(resolveSoccerLeague('Soccer'), { league: 'Soccer', leagueName: null });
  assert.deepEqual(resolveScreenCommand('screen', { league: 'EPL' }), {
    command: 'screen',
    league: 'Soccer',
    leagueName: 'EPL'
  });
  assert.deepEqual(
    parseArgs(['node', 'query-propprofessor.js', 'screen', '--league', 'Soccer', '--league-name', 'EPL']),
    {
      command: 'screen',
      opts: { league: 'Soccer', leagueName: 'EPL' }
    }
  );
});

test('routes MLS through the Soccer backend and scopes the response to MLS', async () => {
  const calls = [];
  const row = {
    gameId: 'Soccer:GAME:Austin_FC:Colorado_Rapids:1789000000',
    league: 'Soccer',
    leagueName: 'MLS',
    market: 'Total Goals',
    homeTeam: 'Colorado Rapids',
    awayTeam: 'Austin FC',
    start: new Date(Date.now() + 3600000).toISOString(),
    defaultKey: '2.5',
    selections: {
      2.5: {
        selection1: 'Over 2.5',
        selection2: 'Under 2.5',
        selection1Id: 'Total_Goals:Over_2.5',
        selection2Id: 'Total_Goals:Under_2.5',
        line1: 2.5,
        line2: 2.5,
        odds: { NoVigApp: { odds1: -110, odds2: -110, liquidity1: 100, liquidity2: 100 } }
      }
    }
  };
  const client = {
    queryScreenOddsBestComps: async (request) => {
      calls.push(request);
      return { game_data: [row, { ...row, gameId: 'epl-row', leagueName: 'EPL' }] };
    }
  };
  const ctx = { responseCache: { get: () => null, set: () => {} }, responseCacheTtlMs: 1000 };
  const { runLeagueScreen } = require('../scripts/server/handlers/screen-leagues').createScreenLeaguesHandlers(
    client,
    ctx
  );
  const result = await runLeagueScreen(
    { market: 'Total Goals', books: ['NoVigApp'], compact: true, skipHistory: true },
    'MLS'
  );

  assert.equal(calls[0].league, 'Soccer');
  assert.equal(calls[0].market, 'Total Goals');
  assert.equal(result.league, 'MLS');
  assert.equal(result.resultMeta.backendLeague, 'Soccer');
  assert.ok(result.result.every((candidate) => candidate.league === 'MLS'));
});

test('filters mixed Soccer screen payloads by leagueName without leaking other leagues', () => {
  const payload = {
    game_data: [
      { id: 'epl', league: 'Soccer', leagueName: 'EPL' },
      { id: 'mlb', league: 'MLB', leagueName: 'MLB' },
      { id: 'epl-spaced', league: 'Soccer', leagueName: ' ePl ' }
    ]
  };
  assert.deepEqual(
    filterPayloadByLeagueName(payload, 'EPL').game_data.map((row) => row.id),
    ['epl', 'epl-spaced']
  );
});

test('scopes Serie A rows to backend Soccer with exact leagueName and filters other competitions', () => {
  const resolved = resolveSoccerLeague('Serie A');
  assert.deepEqual(resolved, { league: 'Soccer', leagueName: 'Serie A' });
  const payload = {
    game_data: [
      { id: 'serie-a-1', league: 'Soccer', leagueName: 'Serie A' },
      { id: 'serie-a-spaced', league: 'Soccer', leagueName: ' serie a ' },
      { id: 'epl-1', league: 'Soccer', leagueName: 'EPL' }
    ]
  };
  const filtered = filterPayloadByLeagueName(payload, resolved.leagueName);
  assert.equal(resolved.league, 'Soccer');
  assert.equal(resolved.leagueName, 'Serie A');
  assert.deepEqual(
    filtered.game_data.map((row) => row.id),
    ['serie-a-1', 'serie-a-spaced']
  );
  assert.deepEqual(Object.keys(filtered).sort(), ['game_data']);
});
