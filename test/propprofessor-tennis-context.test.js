'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');

// RSS fixture — 2 tennis articles about a matchup
const TENNIS_NEWS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Tennis News</title>
<item>
  <title><![CDATA[Alcaraz vs Sinner: Preview and prediction - Tennis Channel]]></title>
  <link>https://www.tennis.com/alcaraz-sinner-preview</link>
  <pubDate>Sun, 21 Jun 2026 10:00:00 GMT</pubDate>
  <source url="https://www.tennis.com">Tennis Channel</source>
</item>
<item>
  <title>Alcaraz beats Sinner in 5-set thriller at Roland Garros</title>
  <link>https://www.espn.com/tennis/story/_/id/12345</link>
  <pubDate>Sun, 21 Jun 2026 12:30:00 GMT</pubDate>
  <source>ESPN</source>
</item>
</channel></rss>`;

const EMPTY_RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Empty</title></channel></rss>`;

let originalExecFile = null;

function mockCurlSuccess(stdout) {
  cp.execFile = (file, args, arg3, arg4) => {
    const cb = typeof arg3 === 'function' ? arg3 : arg4;
    cb(null, stdout, '');
  };
}

function mockCurlFailure(errMsg) {
  cp.execFile = (file, args, arg3, arg4) => {
    const cb = typeof arg3 === 'function' ? arg3 : arg4;
    cb(new Error(errMsg));
  };
}

function clearModuleCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('propprofessor-tennis-context')) {
      delete require.cache[key];
    }
  }
}

before(() => {
  originalExecFile = cp.execFile;
});

after(() => {
  cp.execFile = originalExecFile;
});

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  it('exports getTennisContext, guessSurfaceFromTournament, guessMatchLevel', () => {
    const mod = require('../lib/propprofessor-tennis-context');
    assert.equal(typeof mod.getTennisContext, 'function');
    assert.equal(typeof mod.guessSurfaceFromTournament, 'function');
    assert.equal(typeof mod.guessMatchLevel, 'function');
  });
});

// ---------------------------------------------------------------------------
// guessSurfaceFromTournament
// ---------------------------------------------------------------------------

describe('guessSurfaceFromTournament', () => {
  beforeEach(() => clearModuleCache());

  it('returns null for empty / non-string input', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament(), null);
    assert.equal(guessSurfaceFromTournament(null), null);
    assert.equal(guessSurfaceFromTournament(''), null);
    assert.equal(guessSurfaceFromTournament(42), null);
  });

  // -- Clay --
  it('detects Roland Garros / French Open as Clay', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('Roland Garros'), 'Clay');
    assert.equal(guessSurfaceFromTournament('French Open'), 'Clay');
  });

  it('detects Monte Carlo as Clay', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('Monte Carlo Masters'), 'Clay');
  });

  it('detects Madrid Open as Clay', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('Mutua Madrid Open'), 'Clay');
  });

  it('detects Italian Open as Clay', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('Italian Open'), 'Clay');
  });

  it('detects generic Clay mention', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('Some Clay Tournament'), 'Clay');
  });

  // -- Grass --
  it('detects Wimbledon as Grass', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('Wimbledon'), 'Grass');
  });

  it("detects Queen's Club as Grass", () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament("Queen's Club Championships"), 'Grass');
  });

  it('detects Halle as Grass', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('Halle Open'), 'Grass');
  });

  it('detects generic Grass mention', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('Grass Court Championships'), 'Grass');
  });

  // -- Hardcourt --
  it('detects Australian Open as Hardcourt', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('Australian Open'), 'Hardcourt');
  });

  it('detects US Open as Hardcourt', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('US Open'), 'Hardcourt');
  });

  it('detects Indian Wells as Hardcourt', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('Indian Wells Masters'), 'Hardcourt');
  });

  it('detects Miami Open as Hardcourt', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('Miami Open'), 'Hardcourt');
  });

  it('detects generic Hardcourt mention', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('Hardcourt Championship'), 'Hardcourt');
  });

  // -- Indoor --
  it('detects Paris Masters as Indoor', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('Rolex Paris Masters'), 'Indoor');
  });

  it('detects Basel as Indoor', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('Swiss Indoors Basel'), 'Indoor');
  });

  it('detects generic Indoor mention', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('Indoor Championships'), 'Indoor');
  });

  // -- Unknown --
  it('returns null for unrecognised tournament', () => {
    const { guessSurfaceFromTournament } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessSurfaceFromTournament('Mystery Cup 2026'), null);
  });
});

// ---------------------------------------------------------------------------
// guessMatchLevel
// ---------------------------------------------------------------------------

describe('guessMatchLevel', () => {
  beforeEach(() => clearModuleCache());

  it('returns null for empty / non-string input', () => {
    const { guessMatchLevel } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessMatchLevel(), null);
    assert.equal(guessMatchLevel(null), null);
    assert.equal(guessMatchLevel(''), null);
  });

  it('detects Grand Slams', () => {
    const { guessMatchLevel } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessMatchLevel('Australian Open'), 'Grand Slam');
    assert.equal(guessMatchLevel('French Open'), 'Grand Slam');
    assert.equal(guessMatchLevel('Roland Garros'), 'Grand Slam');
    assert.equal(guessMatchLevel('Wimbledon'), 'Grand Slam');
    assert.equal(guessMatchLevel('US Open'), 'Grand Slam');
  });

  it('detects Masters 1000', () => {
    const { guessMatchLevel } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessMatchLevel('Indian Wells Masters'), 'Masters');
    assert.equal(guessMatchLevel('Miami Open'), 'Masters');
    assert.equal(guessMatchLevel('Monte Carlo Masters'), 'Masters');
    assert.equal(guessMatchLevel('Madrid Open'), 'Masters');
    assert.equal(guessMatchLevel('Italian Open Rome'), 'Masters');
    assert.equal(guessMatchLevel('Rogers Cup'), 'Masters');
    assert.equal(guessMatchLevel('Rolex Paris Masters'), 'Masters');
  });

  it('detects ATP 500', () => {
    const { guessMatchLevel } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessMatchLevel('Rotterdam Open'), 'ATP 500');
    assert.equal(guessMatchLevel('Rio Open'), 'ATP 500');
    assert.equal(guessMatchLevel('Dubai Tennis Championships'), 'ATP 500');
    assert.equal(guessMatchLevel('Barcelona Open'), 'ATP 500');
    assert.equal(guessMatchLevel("Queen's Club Championships"), 'ATP 500');
    assert.equal(guessMatchLevel('Halle Open'), 'ATP 500');
    assert.equal(guessMatchLevel('Hamburg Open'), 'ATP 500');
    assert.equal(guessMatchLevel('Citi Open Washington'), 'ATP 500');
    assert.equal(guessMatchLevel('Swiss Indoors Basel'), 'ATP 500');
    assert.equal(guessMatchLevel('Erste Bank Open Vienna'), 'ATP 500');
  });

  it('detects literal "ATP 250" mention', () => {
    const { guessMatchLevel } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessMatchLevel('ATP 250 Event'), 'ATP 250');
  });

  it('detects Challenger', () => {
    const { guessMatchLevel } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessMatchLevel('Prague Challenger'), 'Challenger');
  });

  it('detects ITF Futures', () => {
    const { guessMatchLevel } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessMatchLevel('M15 Monastir'), 'ITF Futures');
    assert.equal(guessMatchLevel('ITF World Tennis Tour M25'), 'ITF Futures');
    assert.equal(guessMatchLevel('Futures USA F15'), 'ITF Futures');
  });

  it('defaults Open/International/Cup to ATP 250', () => {
    const { guessMatchLevel } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessMatchLevel('Mystery Open'), 'ATP 250');
    assert.equal(guessMatchLevel('Some International'), 'ATP 250');
    assert.equal(guessMatchLevel('Random Cup'), 'ATP 250');
  });

  it('returns null for unrecognised tournament', () => {
    const { guessMatchLevel } = require('../lib/propprofessor-tennis-context');
    assert.equal(guessMatchLevel('Random Friendly Match'), null);
  });
});

// ---------------------------------------------------------------------------
// getTennisContext
// ---------------------------------------------------------------------------

describe('getTennisContext', () => {
  beforeEach(() => clearModuleCache());

  it('returns unknown surface and null level for empty params', async () => {
    const { getTennisContext } = require('../lib/propprofessor-tennis-context');
    const result = await getTennisContext({});
    assert.equal(result.ok, true);
    assert.equal(result.sport, 'Tennis');
    assert.equal(result.surface, 'unknown');
    assert.equal(result.level, null);
    assert.equal(result.matchupNewsCount, 0);
    assert.equal(result.riskFlag, 'unknown');
    assert.ok(result.riskSummary);
    assert.equal(result.signals.surface, 'unknown');
    assert.equal(result.signals.level, null);
    assert.equal(result.signals.matchupArticles, false);
    assert.equal(result.cached, false);
    assert.ok(result.fetchedAt);
  });

  it('guesses surface and level from tournament name', async () => {
    mockCurlSuccess(EMPTY_RSS);
    const { getTennisContext } = require('../lib/propprofessor-tennis-context');
    const result = await getTennisContext({
      player1: 'Carlos Alcaraz',
      player2: 'Jannik Sinner',
      tournament: 'Roland Garros'
    });
    assert.equal(result.surface, 'Clay');
    assert.equal(result.level, 'Grand Slam');
    assert.equal(result.riskFlag, 'clean');
    assert.equal(result.riskSummary, null);
    assert.equal(result.signals.surface, 'Clay');
    assert.equal(result.signals.level, 'Grand Slam');
  });

  it('uses explicit surface override', async () => {
    mockCurlSuccess(EMPTY_RSS);
    const { getTennisContext } = require('../lib/propprofessor-tennis-context');
    const result = await getTennisContext({
      tournament: 'Wimbledon',
      surface: 'Grass'
    });
    assert.equal(result.surface, 'Grass');
  });

  it('reports riskFlag unknown when surface cannot be determined', async () => {
    mockCurlSuccess(EMPTY_RSS);
    const { getTennisContext } = require('../lib/propprofessor-tennis-context');
    const result = await getTennisContext({ tournament: 'Unknown Event 2026' });
    assert.equal(result.surface, 'unknown');
    assert.equal(result.riskFlag, 'unknown');
    assert.ok(result.riskSummary.includes('surface'));
  });

  it('fetches matchup news when player1 and player2 are provided', async () => {
    mockCurlSuccess(TENNIS_NEWS_FIXTURE);
    const { getTennisContext } = require('../lib/propprofessor-tennis-context');
    const result = await getTennisContext({
      player1: 'Carlos Alcaraz',
      player2: 'Jannik Sinner',
      tournament: 'Roland Garros'
    });
    assert.equal(result.matchupNewsCount, 2);
    assert.equal(result.signals.matchupArticles, true);
  });

  it('returns 0 matchupNewsCount when news fetch fails', async () => {
    mockCurlFailure('Network error');
    const { getTennisContext } = require('../lib/propprofessor-tennis-context');
    const result = await getTennisContext({
      player1: 'Carlos Alcaraz',
      player2: 'Jannik Sinner',
      tournament: 'Wimbledon'
    });
    assert.equal(result.matchupNewsCount, 0);
    assert.equal(result.signals.matchupArticles, false);
    assert.equal(result.surface, 'Grass');
    assert.equal(result.level, 'Grand Slam');
  });

  it('returns sport: Tennis in all cases', async () => {
    const { getTennisContext } = require('../lib/propprofessor-tennis-context');
    const result = await getTennisContext({});
    assert.equal(result.sport, 'Tennis');
  });

  it('has fetchedAt as valid ISO string', async () => {
    const { getTennisContext } = require('../lib/propprofessor-tennis-context');
    const result = await getTennisContext({});
    assert.equal(typeof result.fetchedAt, 'string');
    assert.ok(result.fetchedAt.length > 0);
    assert.ok(!isNaN(Date.parse(result.fetchedAt)));
  });

  it('sets cached to false', async () => {
    const { getTennisContext } = require('../lib/propprofessor-tennis-context');
    const result = await getTennisContext({});
    assert.equal(result.cached, false);
  });
});

// ---------------------------------------------------------------------------
// Matchup-to-tournament resolution (added 2026-06-22)
// ---------------------------------------------------------------------------
//
// The live validate_play pipeline passes `tournament: "Dart vs Sonmez"`
// (a matchup) instead of an actual tourney name. These tests confirm the
// new resolver turns the matchup into a real tournament + surface + level
// when the schedule data has a match for that week and player circuit.

describe('looksLikeMatchup', () => {
  beforeEach(() => clearModuleCache());

  it('returns true for "Dart vs Sonmez"', () => {
    const { looksLikeMatchup } = require('../lib/propprofessor-tennis-context');
    assert.equal(looksLikeMatchup('Dart vs Sonmez'), true);
  });

  it('returns true for "Bergs vs Munar"', () => {
    const { looksLikeMatchup } = require('../lib/propprofessor-tennis-context');
    assert.equal(looksLikeMatchup('Bergs vs Munar'), true);
  });

  it('returns true for "Lakers @ Celtics"', () => {
    const { looksLikeMatchup } = require('../lib/propprofessor-tennis-context');
    assert.equal(looksLikeMatchup('Lakers @ Celtics'), true);
  });

  it('returns false for a real tournament name like "Wimbledon"', () => {
    const { looksLikeMatchup } = require('../lib/propprofessor-tennis-context');
    assert.equal(looksLikeMatchup('Wimbledon'), false);
  });

  it('returns false for "Roland Garros"', () => {
    const { looksLikeMatchup } = require('../lib/propprofessor-tennis-context');
    assert.equal(looksLikeMatchup('Roland Garros'), false);
  });

  it('returns false for null / empty', () => {
    const { looksLikeMatchup } = require('../lib/propprofessor-tennis-context');
    assert.equal(looksLikeMatchup(null), false);
    assert.equal(looksLikeMatchup(''), false);
    assert.equal(looksLikeMatchup(undefined), false);
  });
});

describe('parseMatchup', () => {
  beforeEach(() => clearModuleCache());

  it('splits " vs " into two players', () => {
    const { parseMatchup } = require('../lib/propprofessor-tennis-context');
    const r = parseMatchup('Dart vs Sonmez');
    assert.equal(r.player1, 'Dart');
    assert.equal(r.player2, 'Sonmez');
  });

  it('splits " @ " and " at " too', () => {
    const { parseMatchup } = require('../lib/propprofessor-tennis-context');
    assert.deepEqual(parseMatchup('Lakers @ Celtics'), { player1: 'Lakers', player2: 'Celtics' });
    assert.deepEqual(parseMatchup('Lakers at Celtics'), { player1: 'Lakers', player2: 'Celtics' });
  });

  it('returns empty player2 for unparseable input', () => {
    const { parseMatchup } = require('../lib/propprofessor-tennis-context');
    assert.equal(parseMatchup('').player1, '');
    assert.equal(parseMatchup('Solo').player2, '');
  });
});

describe('resolveTournamentFromMatchup', () => {
  beforeEach(() => clearModuleCache());

  it('resolves Dart vs Sonmez (2026-06-22) to Eastbourne (WTA grass)', () => {
    const { resolveTournamentFromMatchup } = require('../lib/propprofessor-tennis-context');
    const r = resolveTournamentFromMatchup('Dart vs Sonmez', '2026-06-22T10:00:00.000Z');
    assert.ok(r, 'expected a resolved tourney');
    assert.equal(r.tour, 'wta');
    assert.equal(r.slug, 'eastbourne');
    assert.equal(r.surface, 'Grass');
    assert.equal(r.level, 'WTA 250');
    assert.equal(r.city, 'Eastbourne');
    assert.equal(r.weekStart, '2026-06-22');
  });

  it('resolves Kasatkina vs Kessler (2026-06-22) to Bad Homburg (WTA 500 grass)', () => {
    const { resolveTournamentFromMatchup } = require('../lib/propprofessor-tennis-context');
    const r = resolveTournamentFromMatchup('Kasatkina vs Kessler', '2026-06-22T12:00:00.000Z');
    assert.ok(r, 'expected a resolved tourney');
    assert.equal(r.slug, 'bad-homburg');
    assert.equal(r.surface, 'Grass');
    assert.equal(r.level, 'WTA 500');
  });

  it('resolves Munar matches (2026-06-22) to Eastbourne (ATP 250 grass)', () => {
    const { resolveTournamentFromMatchup } = require('../lib/propprofessor-tennis-context');
    const r = resolveTournamentFromMatchup('Bergs vs Munar', '2026-06-22T15:00:00.000Z');
    assert.ok(r, 'expected a resolved tourney');
    assert.equal(r.slug, 'eastbourne');
    assert.equal(r.surface, 'Grass');
    assert.equal(r.level, 'ATP 250');
  });

  it('resolves Popyrin matches (2026-06-22) to Eastbourne (ATP 250 grass)', () => {
    const { resolveTournamentFromMatchup } = require('../lib/propprofessor-tennis-context');
    const r = resolveTournamentFromMatchup('Choinski vs Popyrin', '2026-06-22T13:30:00.000Z');
    assert.ok(r, 'expected a resolved tourney');
    assert.equal(r.slug, 'eastbourne');
    assert.equal(r.surface, 'Grass');
    assert.equal(r.level, 'ATP 250');
  });

  it('resolves to a Wimbledon match for early July', () => {
    const { resolveTournamentFromMatchup } = require('../lib/propprofessor-tennis-context');
    const r = resolveTournamentFromMatchup('Dart vs Someone', '2026-06-29T10:00:00.000Z');
    assert.ok(r, 'expected a resolved tourney');
    assert.equal(r.slug, 'wimbledon');
    assert.equal(r.surface, 'Grass');
    assert.equal(r.level, 'Grand Slam');
  });

  it('returns null for a date outside the schedule', () => {
    const { resolveTournamentFromMatchup } = require('../lib/propprofessor-tennis-context');
    const r = resolveTournamentFromMatchup('Dart vs Sonmez', '2027-01-15T10:00:00.000Z');
    assert.equal(r, null);
  });

  it('returns null when no player circuit hint matches', () => {
    const { resolveTournamentFromMatchup } = require('../lib/propprofessor-tennis-context');
    const r = resolveTournamentFromMatchup('Unknownplayer1 vs Unknownplayer2', '2026-06-22T10:00:00.000Z');
    assert.equal(r, null);
  });

  it('Case 3 — resolves a non-circuit matchup during a Grand Slam week (kills false "unknown")', () => {
    const { resolveTournamentFromMatchup } = require('../lib/propprofessor-tennis-context');
    // Two unranked WTA players, Wimbledon week, neither in PLAYER_CIRCUIT.
    const r = resolveTournamentFromMatchup('Tubello vs Jeanjean', '2026-07-10T15:30:00.000Z');
    assert.ok(r, 'Slam-week matchup must resolve, not return null');
    assert.equal(r.slug, 'wimbledon');
    assert.equal(r.surface, 'Grass');
    assert.equal(r.level, 'Grand Slam');
  });

  it('Case 3 — does NOT over-resolve an ambiguous multi-event week', () => {
    const { resolveTournamentFromMatchup } = require('../lib/propprofessor-tennis-context');
    // July 20 week: 4 events (Kitzbuhel, Winston-Salem, Athens, Prague), no circuit hint.
    const r = resolveTournamentFromMatchup('Nobody vs Nobody', '2026-07-22T10:00:00.000Z');
    assert.equal(r, null, 'ambiguous week must stay null rather than guess a wrong surface');
  });
});

describe('getTennisContext — matchup resolution integration', () => {
  beforeEach(() => clearModuleCache());

  it('returns Grass + WTA 250 for "Dart vs Sonmez" with start=2026-06-22', async () => {
    mockCurlSuccess(EMPTY_RSS);
    const { getTennisContext } = require('../lib/propprofessor-tennis-context');
    const result = await getTennisContext({
      player1: 'Dart',
      player2: 'Sonmez',
      tournament: 'Dart vs Sonmez', // matchup, not a real tourney name
      start: '2026-06-22T10:00:00.000Z'
    });
    assert.equal(result.surface, 'Grass');
    assert.equal(result.level, 'WTA 250');
    assert.equal(result.riskFlag, 'clean');
    assert.equal(result.riskSummary, null);
    assert.equal(result.signals.resolvedFromMatchup, true);
    assert.equal(result.tournament, 'Lexus Eastbourne Open');
    assert.equal(result.city, 'Eastbourne');
    assert.equal(result.tour, 'wta');
  });

  it('returns Grass + ATP 500 for "Choinski vs Popyrin" with start=2026-06-22', async () => {
    mockCurlSuccess(EMPTY_RSS);
    const { getTennisContext } = require('../lib/propprofessor-tennis-context');
    const result = await getTennisContext({
      player1: 'Choinski',
      player2: 'Popyrin',
      tournament: 'Choinski vs Popyrin',
      start: '2026-06-22T13:30:00.000Z'
    });
    assert.equal(result.surface, 'Grass');
    assert.equal(result.level, 'ATP 250');
    assert.equal(result.tournament, 'Lexus Eastbourne Open');
  });

  it('falls back to unknown when no resolver match (no player circuit hint)', async () => {
    mockCurlSuccess(EMPTY_RSS);
    const { getTennisContext } = require('../lib/propprofessor-tennis-context');
    const result = await getTennisContext({
      player1: 'Unknownplayer1',
      player2: 'Unknownplayer2',
      tournament: 'Unknownplayer1 vs Unknownplayer2',
      start: '2026-06-22T10:00:00.000Z'
    });
    assert.equal(result.surface, 'unknown');
    assert.equal(result.riskFlag, 'unknown');
    assert.equal(result.signals.resolvedFromMatchup, false);
    assert.equal(result.tournament, null);
  });

  it('falls back to unknown when start is missing (no resolution attempt)', async () => {
    mockCurlSuccess(EMPTY_RSS);
    const { getTennisContext } = require('../lib/propprofessor-tennis-context');
    const result = await getTennisContext({
      player1: 'Dart',
      player2: 'Sonmez',
      tournament: 'Dart vs Sonmez'
      // no start
    });
    assert.equal(result.surface, 'unknown');
    assert.equal(result.riskFlag, 'unknown');
  });

  it('does not attempt resolution when tournament is a real tourney name', async () => {
    mockCurlSuccess(EMPTY_RSS);
    const { getTennisContext } = require('../lib/propprofessor-tennis-context');
    const result = await getTennisContext({
      player1: 'Alcaraz',
      player2: 'Sinner',
      tournament: 'Wimbledon',
      start: '2026-06-22T10:00:00.000Z'
    });
    // Wimbledon is a real tourney name → pattern matchers work directly
    assert.equal(result.surface, 'Grass');
    assert.equal(result.level, 'Grand Slam');
    assert.equal(result.signals.resolvedFromMatchup, false);
    // tournament field is only set when resolved FROM a matchup
    assert.equal(result.tournament, null);
  });
});

describe('PLAYER_CIRCUIT coverage (regression)', () => {
  // Each entry: a matchup + start that's live in 2026 grass swing.
  // The resolver MUST return non-null for these — covers today's slate.
  const KNOWN_MATCHUPS = [
    { matchup: 'Samsonova vs Svitolina', start: '2026-06-23T15:30:00.000Z', expectedSlug: 'bad-homburg' },
    { matchup: 'Djere vs Zheng', start: '2026-06-23T09:00:00.000Z', expectedSlugAny: ['halle', 'eastbourne'] },
    { matchup: 'Bondar vs Udvardy', start: '2026-06-23T12:30:00.000Z', expectedSlugAny: ['eastbourne', 'nottingham'] },
    { matchup: 'Sabalenka vs Rybakina', start: '2026-06-22T12:00:00.000Z', expectedSlugAny: ['bad-homburg', 'berlin'] },
    { matchup: 'Alcaraz vs Sinner', start: '2026-06-22T12:00:00.000Z', expectedSlugAny: ['queens', 'halle'] },
    {
      matchup: 'Buse vs Tsitsipas',
      start: '2026-06-22T09:00:00.000Z',
      expectedSlugAny: ['halle', 'eastbourne', 'mallorca']
    },
    { matchup: 'Bronzetti vs Inglis', start: '2026-06-23T09:00:00.000Z', expectedSlug: 'bad-homburg' },
    {
      matchup: 'Monnet vs Prozorova',
      start: '2026-06-23T09:00:00.000Z',
      expectedSlugAny: ['bad-homburg', 'eastbourne']
    },
    { matchup: 'Gojo vs Smith', start: '2026-06-23T09:00:00.000Z', expectedSlugAny: ['halle', 'eastbourne'] }
  ];
  for (const tc of KNOWN_MATCHUPS) {
    it(`resolves ${tc.matchup} @ ${tc.start} (regression)`, () => {
      const ctx = require('../lib/propprofessor-tennis-context');
      const r = ctx.resolveTournamentFromMatchup(tc.matchup, tc.start);
      assert.ok(r, `expected non-null resolution for ${tc.matchup}, got null`);
      if (tc.expectedSlug) assert.equal(r.slug, tc.expectedSlug, `wrong slug for ${tc.matchup}`);
      if (tc.expectedSlugAny)
        assert.ok(
          tc.expectedSlugAny.includes(r.slug),
          `${tc.matchup} → ${r.slug} not in ${JSON.stringify(tc.expectedSlugAny)}`
        );
    });
  }
});

describe('PLAYER_CIRCUIT cache merge', () => {
  it('merged map contains both static and cache entries', () => {
    const sched = require('../lib/tennis-schedule-data/weekly-schedule-2026');
    // Static entries are always there
    assert.ok(sched.PLAYER_CIRCUIT['Sabalenka'], 'Sabalenka missing from merged map');
    assert.ok(sched.PLAYER_CIRCUIT['Djokovic'], 'Djokovic missing from merged map');
    // STATIC map exposes the pre-merge static entries for inspection
    assert.ok(sched.PLAYER_CIRCUIT_STATIC, 'PLAYER_CIRCUIT_STATIC not exported');
    assert.ok(sched.PLAYER_CIRCUIT_STATIC['Sabalenka'], 'Sabalenka missing from static map');
  });

  it('reloadCircuitCache() returns the current cache object', () => {
    const sched = require('../lib/tennis-schedule-data/weekly-schedule-2026');
    const result = sched.reloadCircuitCache();
    assert.ok(typeof result === 'object');
  });
});

describe('Tour alignment (regression)', () => {
  // Eastbourne hosts both ATP 250 and WTA 250 in the same week. A
  // matchup with both players' circuit hints tagged "atp" must resolve
  // to the ATP version, not the WTA version (or vice versa).
  it('Djere vs Zheng (both ATP) → ATP Eastbourne, not WTA', () => {
    const ctx = require('../lib/propprofessor-tennis-context');
    const r = ctx.resolveTournamentFromMatchup('Djere vs Zheng', '2026-06-23T09:00:00.000Z');
    assert.ok(r);
    assert.equal(r.tour, 'atp', `Djere vs Zheng should resolve to ATP, got ${r.tour}`);
    assert.equal(r.slug, 'eastbourne');
    assert.equal(r.level, 'ATP 250');
  });

  it('Samsonova vs Svitolina (both WTA) → WTA Bad Homburg', () => {
    const ctx = require('../lib/propprofessor-tennis-context');
    const r = ctx.resolveTournamentFromMatchup('Samsonova vs Svitolina', '2026-06-23T15:30:00.000Z');
    assert.ok(r);
    assert.equal(r.tour, 'wta', `Samsonova vs Svitolina should resolve to WTA, got ${r.tour}`);
    assert.equal(r.slug, 'bad-homburg');
    assert.equal(r.level, 'WTA 500');
  });

  it('listTourneysForWeek returns both ATP and WTA versions of Eastbourne', () => {
    const sched = require('../lib/tennis-schedule-data/weekly-schedule-2026');
    const t = sched.listTourneysForWeek('2026-06-23T09:00:00.000Z');
    const eastbourne = t.filter((x) => x.slug === 'eastbourne');
    assert.equal(eastbourne.length, 2, `expected 2 Eastbourne entries (ATP + WTA), got ${eastbourne.length}`);
    assert.ok(
      eastbourne.find((x) => x.tour === 'atp'),
      'no ATP Eastbourne entry'
    );
    assert.ok(
      eastbourne.find((x) => x.tour === 'wta'),
      'no WTA Eastbourne entry'
    );
  });
});

describe('weekly-schedule-2026 helpers', () => {
  beforeEach(() => clearModuleCache());

  it('getWeekForDate returns the schedule entry for the Monday of that week', () => {
    const sched = require('../lib/tennis-schedule-data/weekly-schedule-2026');
    // 2026-06-22 is a Monday itself
    const w1 = sched.getWeekForDate('2026-06-22');
    assert.ok(w1);
    assert.equal(w1.start, '2026-06-22');
    // 2026-06-25 (Thursday) → same week
    const w2 = sched.getWeekForDate('2026-06-25');
    assert.equal(w2.start, '2026-06-22');
    // 2026-06-28 (Sunday) → same week
    const w3 = sched.getWeekForDate('2026-06-28');
    assert.equal(w3.start, '2026-06-22');
    // 2026-06-29 (Monday) → new week
    const w4 = sched.getWeekForDate('2026-06-29');
    assert.equal(w4.start, '2026-06-29');
  });

  it('getWeekForDate returns null for a date outside the schedule', () => {
    const sched = require('../lib/tennis-schedule-data/weekly-schedule-2026');
    assert.equal(sched.getWeekForDate('2027-01-15'), null);
    assert.equal(sched.getWeekForDate('not a date'), null);
  });

  it('listTourneysForWeek returns ATP + WTA + Challenger for week of 2026-06-22', () => {
    const sched = require('../lib/tennis-schedule-data/weekly-schedule-2026');
    const tourneys = sched.listTourneysForWeek('2026-06-22T15:00:00.000Z');
    const slugs = tourneys.map((t) => t.slug);
    assert.ok(slugs.includes('halle'), 'expected halle');
    assert.ok(slugs.includes('mallorca'), 'expected mallorca');
    assert.ok(slugs.includes('bad-homburg'), 'expected bad-homburg');
    assert.ok(slugs.includes('eastbourne'), 'expected eastbourne');
    assert.ok(slugs.includes('ilkley'), 'expected ilkley');
  });

  it('listTourneysForWeek returns [] for a date outside the schedule', () => {
    const sched = require('../lib/tennis-schedule-data/weekly-schedule-2026');
    assert.deepEqual(sched.listTourneysForWeek('2027-01-15T00:00:00.000Z'), []);
  });
});
