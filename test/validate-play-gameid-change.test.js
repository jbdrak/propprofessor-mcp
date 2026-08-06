'use strict';

/**
 * Regression tests for the validate_play gameId timestamp-drift fallback.
 *
 * Backend gameIds embed a Unix start timestamp; the same matchup can surface
 * under a NEW timestamp (verified live: Cubs-Dodgers changed from
 * 1785946800 → 1785954000, a 2-hour shift) while the exact old ID returns no
 * rows. validate_play must reconcile by normalized league + participants +
 * market + selection + same scheduled calendar date, label the result
 * gameId_changed, and fail closed when ambiguous or date-mismatched.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');
const {
  findBestMatchGameIdChanged,
  parseGameIdIdentity
} = require('../lib/selection-matcher.js');

const OLD_GAME_ID = 'MLB:PREMATCH:Chicago_Cubs:Los_Angeles_Dodgers:1785946800';
const NEW_GAME_ID = 'MLB:PREMATCH:Chicago_Cubs:Los_Angeles_Dodgers:1785954000';
const NEW_START = '2026-08-05T18:20:00.000Z';
const CUBS = 'Chicago Cubs';
const DODGERS = 'Los Angeles Dodgers';

/** One game_data row, mirroring the live backend payload shape. */
function makeGameRow(gameId, start, { home = CUBS, away = DODGERS, league = 'MLB' } = {}) {
  return {
    gameId,
    league,
    market: 'Moneyline',
    start,
    updatedAt: new Date(Date.now() - 30_000).toISOString(),
    homeTeam: home,
    awayTeam: away,
    defaultKey: 'ml',
    selections: {
      ml: {
        selection1: home,
        participant1: home,
        selection1Id: `Moneyline:${home.replace(/ /g, '_')}`,
        selection2: away,
        participant2: away,
        selection2Id: `Moneyline:${away.replace(/ /g, '_')}`,
        odds: {
          NoVigApp: { odds1: -115, odds2: 105, liquidity1: 1556, liquidity2: 900 }
        }
      }
    }
  };
}

/**
 * Mock client that mirrors the real backend's exact-ID behavior (verified live):
 * querying with a stale gameId returns 0 rows; a participants-only narrow scan
 * returns the matchup under its CURRENT gameId.
 */
function makeClient({ exactRows = [], relaxedRows = [] } = {}) {
  const calls = { queryScreenOddsBestComps: [] };
  const client = {
    calls,
    queryScreenOddsBestComps: async (filters = {}) => {
      calls.queryScreenOddsBestComps.push(filters);
      const games = Array.isArray(filters.games) ? filters.games : [];
      return games.length ? { game_data: exactRows } : { game_data: relaxedRows };
    },
    queryOddsHistory: async () => ({})
  };
  return { client, calls };
}

function makeHandlers(client) {
  const handlers = createMcpHandlers({ client });
  handlers.player_context = async () => ({ riskFlag: 'low', tweets: [], news: [], cached: false });
  return handlers;
}

describe('validate_play gameId timestamp-drift fallback', () => {
  it('reconciles the same matchup under a NEW gameId (2-hour shift) and labels it gameId_changed', async () => {
    const { client, calls } = makeClient({ relaxedRows: [makeGameRow(NEW_GAME_ID, NEW_START)] });
    const handlers = makeHandlers(client);

    const result = await handlers.validate_play({
      league: 'MLB',
      gameId: OLD_GAME_ID,
      selection: CUBS,
      book: 'NoVigApp',
      skipResearch: true,
      skipGameContext: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.lookupStatus, 'gameId_changed', 'fallback must be labeled gameId_changed');
    assert.equal(result.reasonType, 'gameId_changed');
    assert.ok(result.play, 'play should resolve via the fallback, not fail closed');
    assert.equal(result.play.gameId, NEW_GAME_ID, 'play must carry the CURRENT gameId');
    assert.ok(result.play.playId.includes(NEW_GAME_ID), 'playId must carry the CURRENT gameId');
    assert.ok(
      result.reasons.some((r) => /gameId changed/.test(r)),
      'reason should explain the gameId change'
    );
    // The narrow-scan re-fetch must drop the stale games filter and pass participants.
    const relaxedCall = calls.queryScreenOddsBestComps.at(-1);
    assert.deepEqual(relaxedCall.games, [], 'fallback must re-query without the stale gameId');
    assert.deepEqual(relaxedCall.participants, [CUBS, DODGERS], 'fallback must pass participants');
  });

  it('reconciles via playId-derived selectionKey when no selection is passed', async () => {
    const { client, calls } = makeClient({ relaxedRows: [makeGameRow(NEW_GAME_ID, NEW_START)] });
    const handlers = makeHandlers(client);
    const oldPlayId = `${OLD_GAME_ID}::Moneyline::${CUBS.toLowerCase()}`;

    const result = await handlers.validate_play({
      league: 'MLB',
      gameId: OLD_GAME_ID,
      playId: oldPlayId,
      skipResearch: true,
      skipGameContext: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.lookupStatus, 'gameId_changed');
    assert.ok(result.play, 'playId-only validation should resolve via fallback');
    assert.equal(result.play.selectionKey, CUBS.toLowerCase());
    assert.equal(calls.queryScreenOddsBestComps.length, 2, 'exact fetch + one relaxed scan');
  });

  it('stays on the exact path when the requested gameId still resolves', async () => {
    const { client, calls } = makeClient({ exactRows: [makeGameRow(OLD_GAME_ID, NEW_START)] });
    const handlers = makeHandlers(client);

    const result = await handlers.validate_play({
      league: 'MLB',
      gameId: OLD_GAME_ID,
      selection: CUBS,
      skipResearch: true,
      skipGameContext: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.lookupStatus, 'resolved');
    assert.equal(calls.queryScreenOddsBestComps.length, 1, 'no fallback scan when exact match resolves');
  });

  it('fails closed when the relaxed scan finds the matchup on a DIFFERENT calendar date', async () => {
    const { client, calls } = makeClient({
      relaxedRows: [makeGameRow(NEW_GAME_ID, '2026-08-06T18:20:00.000Z')]
    });
    const handlers = makeHandlers(client);

    const result = await handlers.validate_play({
      league: 'MLB',
      gameId: OLD_GAME_ID,
      selection: CUBS,
      skipResearch: true,
      skipGameContext: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.lookupStatus, 'lookup_failed', 'date mismatch must fail closed');
    assert.equal(result.play, null);
    assert.ok(
      result.reasons.some((r) => /no row matched/.test(r) && /fallback:/.test(r)),
      'reason should mention the failed fallback'
    );
    assert.equal(calls.queryScreenOddsBestComps.length, 2, 'fallback was attempted');
  });

  it('fails closed when two games share the matchup and date (doubleheader ambiguity)', async () => {
    const doubleHeaderSecondGameId = 'MLB:PREMATCH:Chicago_Cubs:Los_Angeles_Dodgers:1785961200';
    const { client } = makeClient({
      relaxedRows: [
        makeGameRow(NEW_GAME_ID, NEW_START),
        makeGameRow(doubleHeaderSecondGameId, '2026-08-05T20:20:00.000Z')
      ]
    });
    const handlers = makeHandlers(client);

    const result = await handlers.validate_play({
      league: 'MLB',
      gameId: OLD_GAME_ID,
      selection: CUBS,
      skipResearch: true,
      skipGameContext: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.lookupStatus, 'lookup_failed', 'ambiguous matchup must fail closed');
    assert.equal(result.play, null);
    assert.ok(
      result.reasons.some((r) => /fallback: no unambiguous/.test(r)),
      'reason should say the fallback was ambiguous'
    );
  });

  it('fails closed when the relaxed scan returns a DIFFERENT matchup', async () => {
    const { client, calls } = makeClient({
      relaxedRows: [
        makeGameRow('MLB:PREMATCH:New_York_Yankees:Boston_Red_Sox:1785954000', NEW_START, {
          home: 'New York Yankees',
          away: 'Boston Red Sox'
        })
      ]
    });
    const handlers = makeHandlers(client);

    const result = await handlers.validate_play({
      league: 'MLB',
      gameId: OLD_GAME_ID,
      selection: CUBS,
      skipResearch: true,
      skipGameContext: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.lookupStatus, 'lookup_failed', 'different matchup must fail closed');
    assert.equal(result.play, null);
    assert.equal(calls.queryScreenOddsBestComps.length, 2);
  });

  it('does not scan when the gameId has no parseable identity (non-timestamp ids)', async () => {
    const { client, calls } = makeClient();
    const handlers = makeHandlers(client);

    const result = await handlers.validate_play({
      league: 'NBA',
      gameId: 'NBA:game-1',
      selection: 'Nonexistent Player',
      skipResearch: true,
      skipGameContext: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.lookupStatus, 'lookup_failed');
    assert.equal(calls.queryScreenOddsBestComps.length, 1, 'no fallback scan without timestamp identity');
  });
});

describe('selection-matcher gameId-change primitives', () => {
  it('parseGameIdIdentity extracts participants, timestamp, and local date', () => {
    const id = parseGameIdIdentity(OLD_GAME_ID);
    assert.deepEqual(id.participants, [CUBS, DODGERS]);
    assert.equal(id.timestamp, 1785946800);
    assert.equal(id.dateKey, '2026-08-05');
    assert.equal(parseGameIdIdentity('NBA:game-1'), null);
    assert.equal(parseGameIdIdentity('MLB:PREMATCH:Only_One_Team:1785946800'), null);
  });

  it('matches by identity+date+selection and rejects ambiguity and date drift', () => {
    const rows = [
      { league: 'MLB', market: 'Moneyline', gameId: NEW_GAME_ID, start: NEW_START, homeTeam: CUBS, awayTeam: DODGERS, selection: CUBS, selectionKey: 'chicago cubs' },
      { league: 'MLB', market: 'Moneyline', gameId: NEW_GAME_ID, start: NEW_START, homeTeam: CUBS, awayTeam: DODGERS, selection: DODGERS, selectionKey: 'los angeles dodgers' }
    ];
    const opts = { league: 'MLB', market: 'Moneyline', gameId: OLD_GAME_ID };

    const matched = findBestMatchGameIdChanged(rows, { ...opts, selection: CUBS });
    assert.ok(matched);
    assert.equal(matched.selection, CUBS);

    // Wrong league / wrong date / different matchup / ambiguity all fail closed.
    assert.equal(findBestMatchGameIdChanged(rows, { ...opts, selection: DODGERS, league: 'NBA' }), null);
    assert.equal(
      findBestMatchGameIdChanged(
        [{ ...rows[0], start: '2026-08-06T18:20:00.000Z' }],
        { ...opts, selection: CUBS }
      ),
      null
    );
    assert.equal(
      findBestMatchGameIdChanged(
        [{ ...rows[0], awayTeam: 'Boston Red Sox' }],
        { ...opts, selection: CUBS }
      ),
      null
    );
    // Ambiguity: two distinct gameIds, same matchup + date.
    assert.equal(
      findBestMatchGameIdChanged(
        [
          rows[0],
          {
            ...rows[0],
            gameId: 'MLB:PREMATCH:Chicago_Cubs:Los_Angeles_Dodgers:1785961200',
            start: '2026-08-05T20:20:00.000Z'
          }
        ],
        { ...opts, selection: CUBS }
      ),
      null
    );
  });
});
