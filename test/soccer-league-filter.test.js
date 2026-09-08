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
