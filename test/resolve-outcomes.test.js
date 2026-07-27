'use strict';

/**
 * Tests for resolve-outcomes.js — ESPN auto-resolution pipeline.
 *
 * Mocks globalThis.fetch to return settled ESPN scoreboard data for NBA, MLB,
 * Tennis, and UFC. Verifies:
 *   - getPlayResult returns correct outcomes (win/loss/push/null)
 *   - fetchEspnScoreboard parses all 4 sports correctly
 *   - resolveOutcomes with --espn resolves without manual CSV input
 *   - ledgerToPlays produces metric-engine-compatible output
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveOutcomes, ledgerToPlays, toEngineResult } = require('../scripts/resolve-outcomes');
const {
  getPlayResult,
  fetchEspnScoreboard,
  findMatch,
  nameSimilarity,
  clearCache
} = require('../lib/propprofessor-espn-resolver');

// ─── ESPN Fixture Data ───────────────────────────────────────────────────────

/** NBA scoreboard: Lakers beat Celtics 112-105 */
const NBA_SCOREBOARD = {
  events: [
    {
      competitions: [
        {
          competitors: [
            { homeAway: 'home', team: { displayName: 'Los Angeles Lakers' }, score: '112' },
            { homeAway: 'away', team: { displayName: 'Boston Celtics' }, score: '105' }
          ],
          status: { type: { state: 'post', description: 'Final' } },
          date: '2026-07-26T02:30Z'
        }
      ]
    }
  ]
};

/** MLB scoreboard: Yankees beat Red Sox 5-3 */
const MLB_SCOREBOARD = {
  events: [
    {
      competitions: [
        {
          competitors: [
            { homeAway: 'home', team: { displayName: 'New York Yankees' }, score: '5' },
            { homeAway: 'away', team: { displayName: 'Boston Red Sox' }, score: '3' }
          ],
          status: { type: { state: 'post', description: 'Final' } },
          date: '2026-07-26T23:05Z'
        }
      ]
    }
  ]
};

/** Tennis scoreboard: Djokovic beats Alcaraz 6-4, 3-6, 7-5 */
const TENNIS_ATP_SCOREBOARD = {
  events: [
    {
      competitions: [
        {
          competitors: [
            { homeAway: 'home', athlete: { displayName: 'Novak Djokovic' }, score: '3' },
            { homeAway: 'away', athlete: { displayName: 'Carlos Alcaraz' }, score: '2' }
          ],
          status: { type: { state: 'post', description: 'Final' } },
          date: '2026-07-26T14:00Z'
        }
      ]
    }
  ]
};

const TENNIS_WTA_SCOREBOARD = {
  events: []
};

/** UFC scoreboard: Jones beats Aspinall via decision */
const UFC_SCOREBOARD = {
  events: [
    {
      competitions: [
        {
          competitors: [
            { homeAway: 'home', athlete: { displayName: 'Jon Jones' }, score: '1' },
            { homeAway: 'away', athlete: { displayName: 'Tom Aspinall' }, score: '0' }
          ],
          status: { type: { state: 'post', description: 'Final' } },
          date: '2026-07-26T03:00Z'
        }
      ]
    }
  ]
};

/** An in-progress game (should NOT produce a result) */
const NBA_IN_PROGRESS = {
  events: [
    {
      competitions: [
        {
          competitors: [
            { homeAway: 'home', team: { displayName: 'Miami Heat' }, score: '88' },
            { homeAway: 'away', team: { displayName: 'Chicago Bulls' }, score: '82' }
          ],
          status: { type: { state: 'in', description: 'In Progress' } },
          date: '2026-07-26T01:00Z'
        }
      ]
    }
  ]
};

// ─── Fetch mocking ───────────────────────────────────────────────────────────

let originalFetch;
let _mockResponses = {};

/**
 * Set up mock ESPN scoreboard responses. Keys are URL path suffixes.
 */
function mockFetch() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === 'string' ? url : url?.href || String(url);
    if (urlStr.includes('basketball/nba/scoreboard')) {
      return { ok: true, json: async () => _mockResponses.nba || NBA_SCOREBOARD };
    }
    if (urlStr.includes('baseball/mlb/scoreboard')) {
      return { ok: true, json: async () => _mockResponses.mlb || MLB_SCOREBOARD };
    }
    if (urlStr.includes('tennis/atp/scoreboard')) {
      return { ok: true, json: async () => _mockResponses.tennis_atp || TENNIS_ATP_SCOREBOARD };
    }
    if (urlStr.includes('tennis/wta/scoreboard')) {
      return { ok: true, json: async () => _mockResponses.tennis_wta || TENNIS_WTA_SCOREBOARD };
    }
    if (urlStr.includes('mma/ufc/scoreboard')) {
      return { ok: true, json: async () => _mockResponses.ufc || UFC_SCOREBOARD };
    }
    return { ok: false, status: 404 };
  };
}

function restoreFetch() {
  if (originalFetch) globalThis.fetch = originalFetch;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir;
let tmpSnapshot;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-resolve-test-'));
  tmpSnapshot = path.join(tmpDir, 'snapshots.jsonl');
  _mockResponses = {};
  mockFetch();
  clearCache();
});

afterEach(() => {
  restoreFetch();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSnapshot(plays) {
  const lines = plays.map((p) => JSON.stringify(p)).join('\n') + '\n';
  fs.writeFileSync(tmpSnapshot, lines, 'utf8');
}

/**
 * Build a snapshot play record.
 * @param {Object} overrides
 */
function makePlay(overrides = {}) {
  return {
    playId: 'test-' + Math.random().toString(16).slice(2, 10),
    gameId: 'game-1',
    selection: 'Los Angeles Lakers',
    market: 'Moneyline',
    league: 'NBA',
    book: 'Pinnacle',
    odds: -110,
    tier: 'A',
    kaiCall: 'Sharp',
    screenScore: 0.75,
    timestamp: new Date().toISOString(),
    ...overrides
  };
}

// ─── nameSimilarity ──────────────────────────────────────────────────────────

describe('nameSimilarity', () => {
  it('returns 1.0 for exact match', () => {
    assert.equal(nameSimilarity('Los Angeles Lakers', 'Los Angeles Lakers'), 1.0);
  });

  it('returns 0.9 for substring match', () => {
    assert.equal(nameSimilarity('Lakers', 'Los Angeles Lakers'), 0.9);
  });

  it('returns 0.9 for same last name via substring match', () => {
    assert.equal(nameSimilarity('Novak Djokovic', 'Djokovic'), 0.9);
  });

  it('returns 0 for no match', () => {
    assert.equal(nameSimilarity('Lakers', 'Yankees'), 0);
  });
});

// ─── findMatch ───────────────────────────────────────────────────────────────

describe('findMatch', () => {
  it('finds a competition by team name similarity', () => {
    const comps = [
      {
        homeTeam: 'Los Angeles Lakers',
        awayTeam: 'Boston Celtics',
        homeScore: '112',
        awayScore: '105',
        isFinal: true,
        winner: 'Los Angeles Lakers'
      }
    ];
    const match = findMatch(comps, 'Lakers');
    assert.ok(match);
    assert.equal(match.homeTeam, 'Los Angeles Lakers');
  });

  it('returns null when no match meets threshold', () => {
    const comps = [{ homeTeam: 'Lakers', awayTeam: 'Celtics', isFinal: true, winner: 'Lakers' }];
    assert.equal(findMatch(comps, 'Yankees'), null);
  });
});

// ─── fetchEspnScoreboard ─────────────────────────────────────────────────────

describe('fetchEspnScoreboard', () => {
  it('parses NBA scoreboard into competitions', async () => {
    const comps = await fetchEspnScoreboard('NBA');
    assert.ok(comps.length >= 1);
    const c = comps.find((x) => x.homeTeam === 'Los Angeles Lakers');
    assert.ok(c);
    assert.equal(c.awayTeam, 'Boston Celtics');
    assert.equal(c.homeScore, '112');
    assert.equal(c.awayScore, '105');
    assert.equal(c.isFinal, true);
    assert.equal(c.winner, 'Los Angeles Lakers');
  });

  it('parses MLB scoreboard', async () => {
    const comps = await fetchEspnScoreboard('MLB');
    const c = comps.find((x) => x.homeTeam === 'New York Yankees');
    assert.ok(c);
    assert.equal(c.winner, 'New York Yankees');
  });

  it('parses Tennis scoreboard (ATP + WTA)', async () => {
    const comps = await fetchEspnScoreboard('TENNIS');
    const c = comps.find((x) => x.homeTeam === 'Novak Djokovic');
    assert.ok(c);
    assert.equal(c.awayTeam, 'Carlos Alcaraz');
    assert.equal(c.winner, 'Novak Djokovic');
  });

  it('parses UFC scoreboard', async () => {
    const comps = await fetchEspnScoreboard('UFC');
    const c = comps.find((x) => x.homeTeam === 'Jon Jones');
    assert.ok(c);
    assert.equal(c.awayTeam, 'Tom Aspinall');
    assert.equal(c.winner, 'Jon Jones');
  });

  it('returns empty array for unknown league', async () => {
    const comps = await fetchEspnScoreboard('NFL');
    assert.deepEqual(comps, []);
  });

  it('detects in-progress games (isFinal = false)', async () => {
    _mockResponses.nba = NBA_IN_PROGRESS;
    clearCache();
    const comps = await fetchEspnScoreboard('NBA');
    const c = comps[0];
    assert.equal(c.isFinal, false);
    assert.equal(c.winner, null);
  });
});

// ─── getPlayResult ───────────────────────────────────────────────────────────

describe('getPlayResult', () => {
  it('returns win for a winning Moneyline pick (NBA)', async () => {
    const play = makePlay({ league: 'NBA', selection: 'Lakers' });
    const result = await getPlayResult(play);
    assert.equal(result, 'win');
  });

  it('returns loss for a losing Moneyline pick (NBA)', async () => {
    const play = makePlay({ league: 'NBA', selection: 'Boston Celtics' });
    const result = await getPlayResult(play);
    assert.equal(result, 'loss');
  });

  it('returns null for in-progress games', async () => {
    _mockResponses.nba = NBA_IN_PROGRESS;
    clearCache();
    const play = makePlay({ league: 'NBA', selection: 'Miami Heat' });
    const result = await getPlayResult(play);
    assert.equal(result, null);
  });

  it('returns win for MLB Moneyline', async () => {
    const play = makePlay({ league: 'MLB', selection: 'New York Yankees' });
    const result = await getPlayResult(play);
    assert.equal(result, 'win');
  });

  it('returns loss for MLB Moneyline', async () => {
    const play = makePlay({ league: 'MLB', selection: 'Red Sox' });
    const result = await getPlayResult(play);
    assert.equal(result, 'loss');
  });

  it('returns win for Tennis Moneyline', async () => {
    const play = makePlay({ league: 'TENNIS', selection: 'Djokovic' });
    const result = await getPlayResult(play);
    assert.equal(result, 'win');
  });

  it('returns loss for Tennis Moneyline', async () => {
    const play = makePlay({ league: 'TENNIS', selection: 'Alcaraz' });
    const result = await getPlayResult(play);
    assert.equal(result, 'loss');
  });

  it('returns win for UFC Moneyline', async () => {
    const play = makePlay({ league: 'UFC', selection: 'Jon Jones' });
    const result = await getPlayResult(play);
    assert.equal(result, 'win');
  });

  it('returns loss for UFC Moneyline', async () => {
    const play = makePlay({ league: 'UFC', selection: 'Aspinall' });
    const result = await getPlayResult(play);
    assert.equal(result, 'loss');
  });

  it('returns null when selection does not match any competitor', async () => {
    const play = makePlay({ league: 'NBA', selection: 'Golden State Warriors' });
    const result = await getPlayResult(play);
    assert.equal(result, null);
  });

  it('returns null for unsupported league', async () => {
    const play = makePlay({ league: 'NFL', selection: 'Chiefs' });
    const result = await getPlayResult(play);
    assert.equal(result, null);
  });

  it('returns null when play has no league', async () => {
    const play = makePlay({ league: null, selection: 'Lakers' });
    const result = await getPlayResult(play);
    assert.equal(result, null);
  });
});

// ─── resolveOutcomes (full pipeline) ─────────────────────────────────────────

describe('resolveOutcomes with --espn', () => {
  it('resolves NBA and MLB plays without manual CSV input', async () => {
    const plays = [
      makePlay({ playId: 'p1', league: 'NBA', selection: 'Lakers', odds: -110 }),
      makePlay({ playId: 'p2', league: 'NBA', selection: 'Celtics', odds: -110 }),
      makePlay({ playId: 'p3', league: 'MLB', selection: 'Yankees', odds: -150 }),
      makePlay({ playId: 'p4', league: 'MLB', selection: 'Red Sox', odds: +130 })
    ];
    writeSnapshot(plays);

    const result = await resolveOutcomes({ inFile: tmpSnapshot, espn: true });

    assert.equal(result.resolved, 4);
    assert.equal(result.alreadyResolved, 0);
    assert.equal(result.unresolved, 0);

    const p1 = result.rows.find((r) => r.playId === 'p1');
    const p2 = result.rows.find((r) => r.playId === 'p2');
    const p3 = result.rows.find((r) => r.playId === 'p3');
    const p4 = result.rows.find((r) => r.playId === 'p4');

    assert.equal(p1.result, 'win');
    assert.equal(p2.result, 'loss');
    assert.equal(p3.result, 'win');
    assert.equal(p4.result, 'loss');
    assert.ok(p1.resolvedAt);
  });

  it('resolves Tennis and UFC plays', async () => {
    const plays = [
      makePlay({ playId: 't1', league: 'TENNIS', selection: 'Djokovic', odds: -200 }),
      makePlay({ playId: 't2', league: 'TENNIS', selection: 'Alcaraz', odds: +170 }),
      makePlay({ playId: 'u1', league: 'UFC', selection: 'Jon Jones', odds: -180 }),
      makePlay({ playId: 'u2', league: 'UFC', selection: 'Aspinall', odds: +150 })
    ];
    writeSnapshot(plays);

    const result = await resolveOutcomes({ inFile: tmpSnapshot, espn: true });

    assert.equal(result.resolved, 4);
    assert.equal(result.unresolved, 0);

    const t1 = result.rows.find((r) => r.playId === 't1');
    const t2 = result.rows.find((r) => r.playId === 't2');
    const u1 = result.rows.find((r) => r.playId === 'u1');
    const u2 = result.rows.find((r) => r.playId === 'u2');

    assert.equal(t1.result, 'win');
    assert.equal(t2.result, 'loss');
    assert.equal(u1.result, 'win');
    assert.equal(u2.result, 'loss');
  });

  it('leaves unresolved plays with no result field', async () => {
    const plays = [
      makePlay({ playId: 'p1', league: 'NBA', selection: 'Lakers' }),
      makePlay({ playId: 'p2', league: 'NBA', selection: 'Warriors' })
    ];
    writeSnapshot(plays);

    const result = await resolveOutcomes({ inFile: tmpSnapshot, espn: true });

    assert.equal(result.resolved, 1);
    assert.equal(result.unresolved, 1);

    const p2 = result.rows.find((r) => r.playId === 'p2');
    assert.equal(p2.result, undefined);
  });

  it('skips already-resolved plays', async () => {
    const plays = [
      makePlay({ playId: 'p1', league: 'NBA', selection: 'Lakers', result: 'win' }),
      makePlay({ playId: 'p2', league: 'NBA', selection: 'Celtics' })
    ];
    writeSnapshot(plays);

    const result = await resolveOutcomes({ inFile: tmpSnapshot, espn: true });

    assert.equal(result.alreadyResolved, 1);
    assert.equal(result.resolved, 1);
    assert.equal(result.unresolved, 0);
  });

  it('CSV resolution takes priority over ESPN', async () => {
    const csvPath = path.join(tmpDir, 'results.csv');
    // CSV says p1 was a loss, but ESPN would say win (Lakers won)
    fs.writeFileSync(csvPath, 'playId,result\np1,loss\n', 'utf8');

    const plays = [makePlay({ playId: 'p1', league: 'NBA', selection: 'Lakers' })];
    writeSnapshot(plays);

    const result = await resolveOutcomes({ inFile: tmpSnapshot, resultsCsv: csvPath, espn: true });

    assert.equal(result.resolved, 1);
    const p1 = result.rows.find((r) => r.playId === 'p1');
    assert.equal(p1.result, 'loss', 'CSV result should win over ESPN');
  });

  it('handles mixed leagues in a single run', async () => {
    const plays = [
      makePlay({ playId: 'n1', league: 'NBA', selection: 'Lakers', odds: -110 }),
      makePlay({ playId: 'm1', league: 'MLB', selection: 'Yankees', odds: -150 }),
      makePlay({ playId: 't1', league: 'TENNIS', selection: 'Djokovic', odds: -200 }),
      makePlay({ playId: 'u1', league: 'UFC', selection: 'Jon Jones', odds: -180 })
    ];
    writeSnapshot(plays);

    const result = await resolveOutcomes({ inFile: tmpSnapshot, espn: true });

    assert.equal(result.resolved, 4);
    const rows = result.rows;
    assert.equal(rows.find((r) => r.playId === 'n1').result, 'win');
    assert.equal(rows.find((r) => r.playId === 'm1').result, 'win');
    assert.equal(rows.find((r) => r.playId === 't1').result, 'win');
    assert.equal(rows.find((r) => r.playId === 'u1').result, 'win');
  });

  it('dry run does not write to disk', async () => {
    const plays = [makePlay({ playId: 'p1', league: 'NBA', selection: 'Lakers' })];
    writeSnapshot(plays);
    const before = fs.readFileSync(tmpSnapshot, 'utf8');

    await resolveOutcomes({ inFile: tmpSnapshot, espn: true, dryRun: true });

    const after = fs.readFileSync(tmpSnapshot, 'utf8');
    assert.equal(after, before, 'dryRun should not modify the file');
  });
});

// ─── ledgerToPlays ───────────────────────────────────────────────────────────

describe('ledgerToPlays', () => {
  it('converts resolved rows to metric-engine format', () => {
    const rows = [
      { playId: 'p1', odds: -110, result: 'win' },
      { playId: 'p2', odds: 150, result: 'loss' },
      { playId: 'p3', odds: -105, result: 'push' },
      { playId: 'p4', odds: 200 } // unresolved, should be filtered
    ];

    const plays = ledgerToPlays(rows);
    assert.equal(plays.length, 3);

    assert.equal(plays[0].odds, -110);
    assert.equal(plays[0].stake, 100);
    assert.equal(plays[0].result, 'won');

    assert.equal(plays[1].result, 'lost');
    assert.equal(plays[2].result, 'push');
  });
});

// ─── toEngineResult ──────────────────────────────────────────────────────────

describe('toEngineResult', () => {
  it('maps win -> won', () => assert.equal(toEngineResult('win'), 'won'));
  it('maps loss -> lost', () => assert.equal(toEngineResult('loss'), 'lost'));
  it('maps push -> push', () => assert.equal(toEngineResult('push'), 'push'));
});

// ─── End-to-end: snapshot + resolve + metrics ────────────────────────────────

describe('end-to-end pipeline (snapshot -> resolve -> metrics)', () => {
  it('produces complete metrics-ready output without manual CSV', async () => {
    // Simulate 4 snapshotted plays
    const plays = [
      makePlay({ playId: 'aa', league: 'NBA', selection: 'Lakers', odds: -110 }),
      makePlay({ playId: 'bb', league: 'NBA', selection: 'Celtics', odds: 150 }),
      makePlay({ playId: 'cc', league: 'MLB', selection: 'Yankees', odds: -120 }),
      makePlay({ playId: 'dd', league: 'MLB', selection: 'Red Sox', odds: 130 })
    ];
    writeSnapshot(plays);

    // Resolve via ESPN (no CSV)
    const resolved = await resolveOutcomes({ inFile: tmpSnapshot, espn: true });
    assert.equal(resolved.resolved, 4);

    // Convert to metrics-engine format
    const metricsRows = ledgerToPlays(resolved.rows);
    assert.equal(metricsRows.length, 4);

    // Winners: Lakers, Yankees (2). Losers: Celtics, Red Sox (2).
    const wins = metricsRows.filter((r) => r.result === 'won').length;
    const losses = metricsRows.filter((r) => r.result === 'lost').length;
    assert.equal(wins, 2);
    assert.equal(losses, 2);
  });

  it('skips unresolved plays in ledgerToPlays', async () => {
    const plays = [
      makePlay({ playId: 'a1', league: 'NBA', selection: 'Lakers', odds: -110 }),
      makePlay({ playId: 'a2', league: 'NBA', selection: 'Warriors', odds: 150 })
    ];
    writeSnapshot(plays);

    const resolved = await resolveOutcomes({ inFile: tmpSnapshot, espn: true });
    assert.equal(resolved.resolved, 1);
    assert.equal(resolved.unresolved, 1);

    const metricsRows = ledgerToPlays(resolved.rows);
    assert.equal(metricsRows.length, 1);
    assert.equal(metricsRows[0].result, 'won');
  });
});
