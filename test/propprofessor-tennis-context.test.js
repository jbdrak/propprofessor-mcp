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
    if (key.includes('propprofessor-tennis-context') || key.includes('propprofessor-game-context')) {
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

  it('Case 3 — resolves a non-circuit matchup during a Grand Slam week', () => {
    const { resolveTournamentFromMatchup } = require('../lib/propprofessor-tennis-context');
    const r = resolveTournamentFromMatchup('Tubello vs Jeanjean', '2026-07-10T15:30:00.000Z');
    assert.ok(r, 'Slam-week matchup must resolve, not return null');
    assert.equal(r.slug, 'wimbledon');
    assert.equal(r.surface, 'Grass');
    assert.equal(r.level, 'Grand Slam');
  });

  it('Case 3 — does NOT over-resolve an ambiguous multi-event week', () => {
    const { resolveTournamentFromMatchup } = require('../lib/propprofessor-tennis-context');
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
      tournament: 'Dart vs Sonmez',
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
    assert.equal(result.surface, 'Grass');
    assert.equal(result.level, 'Grand Slam');
    assert.equal(result.signals.resolvedFromMatchup, false);
    assert.equal(result.tournament, null);
  });
});

describe('PLAYER_CIRCUIT coverage (regression)', () => {
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
    assert.ok(sched.PLAYER_CIRCUIT['Sabalenka'], 'Sabalenka missing from merged map');
    assert.ok(sched.PLAYER_CIRCUIT['Djokovic'], 'Djokovic missing from merged map');
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
    const w1 = sched.getWeekForDate('2026-06-22');
    assert.ok(w1);
    assert.equal(w1.start, '2026-06-22');
    const w2 = sched.getWeekForDate('2026-06-25');
    assert.equal(w2.start, '2026-06-22');
    const w3 = sched.getWeekForDate('2026-06-28');
    assert.equal(w3.start, '2026-06-22');
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

// =========================================================================
// Tennis Elo shadow context integration
// =========================================================================

// ---------------------------------------------------------------------------
// Helper: build engine-format snapshot via tennis-elo buildRatings
// ---------------------------------------------------------------------------

let eloEngine;
try {
  eloEngine = require('../lib/tennis-elo');
} catch {
  eloEngine = null;
}

const ENGINE_SNAPSHOT_AVAILABLE = Boolean(
  eloEngine && typeof eloEngine.buildRatings === 'function' && typeof eloEngine.predictMatch === 'function'
);

/**
 * Build a minimal engine-format snapshot with two players (A beats B).
 */
function makeEngineSnapshot(overrides) {
  const { buildRatings } = eloEngine;
  const matches = [
    { tour: 'atp', winner: 'Player A', loser: 'Player B', surface: 'hard', date: '2024-06-01', status: 'completed' }
  ];
  const snapshot = buildRatings(matches, overrides);
  const resolver = (_snap, { tour, name }) => {
    if (!name || typeof name !== 'string') return { available: false, reason: 'missing_name' };
    const pool = snapshot.pools && snapshot.pools[tour];
    if (!pool) return { available: false, reason: 'unknown_tour' };
    for (const key of Object.keys(pool)) {
      if (key === name) return { available: true, tour, id: key, name: pool[key].name || key, matchedBy: 'exact_name' };
    }
    return { available: false, reason: 'unknown_player' };
  };
  return { snapshot, resolver };
}

/**
 * Build a data-format snapshot manually (no I/O). Two ATP players on hard.
 */
function makeDataSnapshot(overrides) {
  const sw = overrides && overrides.surfaceWeight != null ? overrides.surfaceWeight : 0.5;
  const msm = overrides && overrides.minSurfaceMatches != null ? overrides.minSurfaceMatches : 5;
  return {
    schemaVersion: 1,
    modelVersion: 'test-elo-1.0',
    manifest: {
      schemaVersion: 1,
      generator: 'test',
      sourcePath: 'synthetic',
      sourceUrl: null,
      license: 'test',
      asOf: '2024-12-31',
      importedAt: '2025-01-01T00:00:00Z',
      modelVersion: 'test-elo-1.0',
      sha256: 'abc123',
      rowCount: 10,
      matchCount: 10,
      playerCount: 2
    },
    players: {
      ATP: {
        'PLAYER A': {
          name: 'Player A',
          overall: 1600,
          surfaces: {
            hard: { rating: 1620, matches: 10 },
            clay: { rating: 1580, matches: 2 },
            grass: { rating: 1600, matches: 0 }
          },
          totalMatches: 10,
          lastMatchDate: '2024-12-30'
        },
        'PLAYER B': {
          name: 'Player B',
          overall: 1400,
          surfaces: {
            hard: { rating: 1380, matches: 10 },
            clay: { rating: 1420, matches: 2 },
            grass: { rating: 1400, matches: 0 }
          },
          totalMatches: 10,
          lastMatchDate: '2024-12-30'
        }
      },
      WTA: {}
    },
    aliasIndex: { ATP: {}, WTA: {} },
    engine: { constants: { k: 32, surfaceWeight: sw, minSurfaceMatches: msm, allowRetirement: false } }
  };
}

/**
 * Fake resolver that resolves against a data-format snapshot.
 */
function dataResolver(snapshot) {
  return (_snap, { tour, name }) => {
    const upperName = String(name).trim().toUpperCase().replace(/\s+/g, ' ');
    const pool = snapshot.players && snapshot.players[tour.toUpperCase()];
    if (!pool) return { available: false, reason: 'unknown_tour' };
    if (Object.prototype.hasOwnProperty.call(pool, upperName)) {
      return {
        available: true,
        tour: tour.toUpperCase(),
        id: upperName,
        name: pool[upperName].name || upperName,
        matchedBy: 'exact_name'
      };
    }
    return { available: false, reason: 'unknown_player' };
  };
}

// =========================================================================
// getTennisEloContext — pure helper
// =========================================================================

describe('getTennisEloContext', () => {
  beforeEach(() => clearModuleCache());

  it('exports getTennisEloContext', () => {
    const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
    assert.equal(typeof getTennisEloContext, 'function');
  });

  describe('unavailable paths', () => {
    it('returns missing_opts for non-object input', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      assert.deepEqual(getTennisEloContext(), { available: false, coverage: 'missing_opts', reason: 'missing_opts' });
      assert.deepEqual(getTennisEloContext(null), {
        available: false,
        coverage: 'missing_opts',
        reason: 'missing_opts'
      });
    });

    it('returns snapshot_unavailable when loadSnapshot fails', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'A',
        player2: 'B',
        surface: null,
        loadSnapshot: () => ({ available: false, reason: 'not_found' })
      });
      assert.equal(r.available, false);
      assert.equal(r.coverage, 'snapshot_unavailable');
      assert.equal(r.reason, 'not_found');
    });

    it('returns snapshot_load_error when loadSnapshot throws', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'A',
        player2: 'B',
        surface: null,
        loadSnapshot: () => {
          throw new Error('disk error');
        }
      });
      assert.equal(r.available, false);
      assert.equal(r.coverage, 'snapshot_load_error');
      assert.equal(r.reason, 'snapshot_load_error');
    });

    it('returns tour_unknown for unknown tour', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const r = getTennisEloContext({
        tour: 'college',
        player1: 'A',
        player2: 'B',
        surface: null,
        snapshot: makeDataSnapshot()
      });
      assert.equal(r.available, false);
      assert.equal(r.coverage, 'tour_unknown');
      assert.equal(r.tour, 'college');
    });

    it('returns tour_unknown for null tour', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const r = getTennisEloContext({
        tour: null,
        player1: 'A',
        player2: 'B',
        surface: null,
        snapshot: makeDataSnapshot()
      });
      assert.equal(r.available, false);
      assert.equal(r.coverage, 'tour_unknown');
    });

    it('returns player_unresolved when resolver fails for player1', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Unknown Player',
        player2: 'Player A',
        surface: null,
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r.available, false);
      assert.equal(r.coverage, 'player_unresolved');
      assert.ok(r.reason.includes('player1'));
      assert.equal(r.player1.resolved, false);
      assert.equal(r.player1.reason, 'unknown_player');
      assert.equal(r.player2.name, 'Player A');
    });

    it('returns player_unresolved when resolver fails for player2', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Unknown X',
        surface: null,
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r.available, false);
      assert.equal(r.coverage, 'player_unresolved');
      assert.ok(r.reason.includes('player2'));
    });

    it('returns player_unresolved when resolver fails (player not in snapshot)', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      // Player C doesn't exist in the data snapshot — resolver catches it
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player C',
        surface: null,
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r.available, false);
      assert.equal(r.coverage, 'player_unresolved');
      assert.ok(r.reason.includes('player2'));
    });

    it('returns asof_before_snapshot when asOf is before snapshot cutoff', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot(); // asOf = 2024-12-31
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: 'hard',
        asOf: '2024-01-01T00:00:00Z',
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r.available, false);
      assert.equal(r.reason, 'asof_before_snapshot');
    });
  });

  describe('available paths (data-format snapshot)', () => {
    it('returns available with probabilities from final ratings', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: 'hard',
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r.available, true);
      assert.equal(r.coverage, 'full');
      assert.equal(r.reason, null);
      assert.equal(r.tour, 'atp');
      assert.equal(r.surface, 'hard');
      assert.equal(r.player1.name, 'Player A');
      assert.equal(r.player1.id, 'PLAYER A');
      assert.equal(r.player1.matchedBy, 'exact_name');
      assert.equal(r.player2.name, 'Player B');
      assert.equal(r.player2.id, 'PLAYER B');
      assert.ok(r.probabilities.player1 > 0.5, `expected prob1 > 0.5, got ${r.probabilities.player1}`);
      assert.ok(r.probabilities.player2 < 0.5);
      assert.ok(Math.abs(r.probabilities.player1 + r.probabilities.player2 - 1) < 1e-9);
      assert.equal(r.modelVersion, 'test-elo-1.0');
    });

    it('uses surface blend when both players have enough surface matches', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: 'hard',
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r.ratings.player1.blended, true);
      assert.notEqual(r.ratings.player1.effective, r.ratings.player1.overall);
    });

    it('does not blend when surface matches below threshold', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot({ minSurfaceMatches: 20 });
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: 'hard',
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r.ratings.player1.blended, false);
      assert.equal(r.ratings.player1.effective, r.ratings.player1.overall);
    });

    it('uses overall ratings when surface is null (unknown surface)', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: null,
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r.surface, null);
      assert.equal(r.ratings.player1.blended, false);
      assert.equal(r.ratings.player1.effective, 1600);
      assert.equal(r.ratings.player2.effective, 1400);
    });

    it('includes snapshot provenance', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: null,
        snapshot: ds,
        resolvePlayer: dataResolver(ds),
        now: new Date('2025-01-08T00:00:00Z').getTime()
      });
      assert.equal(r.snapshot.asOf, '2024-12-31');
      assert.equal(r.snapshot.importedAt, '2025-01-01T00:00:00Z');
      assert.equal(r.snapshot.license, 'test');
      assert.equal(r.snapshot.sha256, 'abc123');
      assert.equal(r.snapshot.matchCount, 10);
      assert.equal(r.snapshot.playerCount, 2);
      assert.equal(r.snapshot.freshness.ageDays, 7);
      assert.equal(r.snapshot.freshness.stale, false);
    });

    it('marks stale when ageDays > 14', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: null,
        snapshot: ds,
        resolvePlayer: dataResolver(ds),
        now: new Date('2025-02-01T00:00:00Z').getTime()
      });
      assert.ok(r.snapshot.freshness.ageDays > 14);
      assert.equal(r.snapshot.freshness.stale, true);
    });

    it('reports freshness null (never false) when importedAt is invalid', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      ds.manifest.importedAt = 'not-a-date';
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: null,
        snapshot: ds,
        resolvePlayer: dataResolver(ds),
        now: new Date('2025-02-01T00:00:00Z').getTime()
      });
      assert.equal(r.snapshot.freshness.ageDays, null);
      assert.equal(r.snapshot.freshness.stale, null, 'invalid importedAt must not silently report not-stale');
    });

    it('returns matchCounts and lastMatchDate', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: null,
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r.matchCounts.player1, 10);
      assert.equal(r.matchCounts.player2, 10);
      assert.equal(r.lastMatchDate.player1, '2024-12-30');
      assert.equal(r.lastMatchDate.player2, '2024-12-30');
    });
  });

  describe('available paths (engine-format snapshot)', () => {
    it('returns available with probabilities via real predictMatch', () => {
      if (!ENGINE_SNAPSHOT_AVAILABLE) return;
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const { snapshot, resolver } = makeEngineSnapshot();
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: 'hard',
        snapshot,
        resolvePlayer: resolver,
        predictMatch: eloEngine.predictMatch
      });
      assert.equal(r.available, true);
      assert.equal(r.coverage, 'full');
      assert.equal(r.tour, 'atp');
      assert.ok(r.probabilities.player1 > 0.5);
      assert.ok(Math.abs(r.probabilities.player1 + r.probabilities.player2 - 1) < 1e-9);
      assert.equal(r.modelVersion, 'tennis-elo-1.1.0');
    });

    it('honors asOf boundary via real predictMatch replay', () => {
      if (!ENGINE_SNAPSHOT_AVAILABLE) return;
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const snapshot = eloEngine.buildRatings([
        {
          tour: 'atp',
          winner: 'Player A',
          loser: 'Player B',
          surface: 'hard',
          date: '2024-06-01',
          status: 'completed'
        },
        { tour: 'atp', winner: 'Player B', loser: 'Player A', surface: 'hard', date: '2024-06-15', status: 'completed' }
      ]);
      const resolver = (_snap, { tour, name }) => {
        const pool = snapshot.pools && snapshot.pools[tour];
        if (!pool || !pool[name]) return { available: false, reason: 'unknown_player' };
        return { available: true, tour, id: name, name, matchedBy: 'exact_name' };
      };
      const r1 = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: null,
        asOf: '2024-06-10',
        snapshot,
        resolvePlayer: resolver,
        predictMatch: eloEngine.predictMatch
      });
      assert.equal(r1.available, true);
      const r2 = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: null,
        asOf: '2024-06-20',
        snapshot,
        resolvePlayer: resolver,
        predictMatch: eloEngine.predictMatch
      });
      assert.equal(r2.available, true);
      assert.notEqual(
        Math.round(r1.probabilities.player1 * 10000),
        Math.round(r2.probabilities.player1 * 10000),
        'asOf boundary should produce different predictions'
      );
    });
  });

  describe('selectedProbability and disagreement', () => {
    it('returns selectedProbability when selection matches player1', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: 'hard',
        selection: 'Player A',
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r.selectedProbability, r.probabilities.player1);
      assert.equal(r.disagreement, null);
    });

    it('returns selectedProbability when selection matches player2', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: 'hard',
        selection: 'Player B',
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r.selectedProbability, r.probabilities.player2);
    });

    it('returns null selectedProbability when selection does not match', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: 'hard',
        selection: 'Player C',
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r.selectedProbability, null);
    });

    it('computes disagreement when marketFairProbability is explicit and selection matches', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: 'hard',
        selection: 'Player A',
        marketFairProbability: 0.5,
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(typeof r.disagreement, 'number');
      assert.ok(Math.abs(r.disagreement - (r.probabilities.player1 - 0.5)) < 0.001);
    });

    it('returns null disagreement when selection does not match (ambiguous)', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: 'hard',
        selection: 'Player C',
        marketFairProbability: 0.5,
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r.disagreement, null);
    });

    it('returns null marketFairProbability when not provided', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: null,
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r.marketFairProbability, null);
    });

    it('ignores marketFairProbability out of [0,1] range', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r1 = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: null,
        selection: 'Player A',
        marketFairProbability: 1.5,
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r1.marketFairProbability, null);
      const r2 = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: null,
        selection: 'Player A',
        marketFairProbability: -0.1,
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r2.marketFairProbability, null);
    });
  });

  describe('no ranker/verdict fields', () => {
    it('does not contain consensusEdge, confidenceTier, signalTier, kaiCall, displayTier, finalVerdict', () => {
      const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = getTennisEloContext({
        tour: 'atp',
        player1: 'Player A',
        player2: 'Player B',
        surface: 'hard',
        snapshot: ds,
        resolvePlayer: dataResolver(ds)
      });
      assert.equal(r.consensusEdge, undefined);
      assert.equal(r.confidenceTier, undefined);
      assert.equal(r.signalTier, undefined);
      assert.equal(r.kaiCall, undefined);
      assert.equal(r.displayTier, undefined);
      assert.equal(r.finalVerdict, undefined);
    });
  });
});

// =========================================================================
// getTennisContext — Elo integration
// =========================================================================

describe('getTennisContext — Elo integration', () => {
  beforeEach(() => clearModuleCache());

  describe('market gating', () => {
    it('returns elo unavailable with market_unknown when no market is provided', async () => {
      const { getTennisContext } = require('../lib/propprofessor-tennis-context');
      const loadSpy = () => {
        throw new Error('loadSnapshot should NOT be called');
      };
      const r = await getTennisContext({
        player1: 'A',
        player2: 'B',
        tournament: 'Wimbledon',
        tour: 'atp',
        eloDeps: { loadSnapshot: loadSpy }
      });
      assert.equal(r.elo.available, false);
      assert.equal(r.elo.coverage, 'market_unknown');
      assert.equal(r.signals.eloAvailable, false);
    });

    it('returns elo available false with unsupported_market for non-ML market', async () => {
      mockCurlSuccess(EMPTY_RSS);
      const { getTennisContext } = require('../lib/propprofessor-tennis-context');
      const loadSpy = () => {
        throw new Error('should not be called');
      };
      const r = await getTennisContext({
        player1: 'A',
        player2: 'B',
        tournament: 'Wimbledon',
        tour: 'atp',
        market: 'Total Games',
        eloDeps: { loadSnapshot: loadSpy }
      });
      assert.equal(r.elo.available, false);
      assert.equal(r.elo.coverage, 'unsupported_market');
      assert.equal(r.signals.eloAvailable, false);
    });

    it('accepts Moneyline (case-insensitive, space/underscore tolerant)', async () => {
      mockCurlSuccess(EMPTY_RSS);
      const { getTennisContext } = require('../lib/propprofessor-tennis-context');
      const r1 = await getTennisContext({
        player1: 'A',
        player2: 'B',
        tournament: 'Wimbledon',
        tour: 'atp',
        market: 'Moneyline',
        eloDeps: { loadSnapshot: () => ({ available: false, reason: 'test' }) }
      });
      assert.equal(r1.elo.coverage, 'snapshot_unavailable');

      clearModuleCache();
      mockCurlSuccess(EMPTY_RSS);
      const r2 = await getTennisContext({
        player1: 'A',
        player2: 'B',
        tournament: 'Wimbledon',
        tour: 'atp',
        market: ' money_line ',
        eloDeps: { loadSnapshot: () => ({ available: false, reason: 'test' }) }
      });
      assert.equal(r2.elo.coverage, 'snapshot_unavailable');
    });
  });

  describe('elo available path', () => {
    it('returns elo available true with full probabilities', async () => {
      mockCurlSuccess(EMPTY_RSS);
      const { getTennisContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = await getTennisContext({
        player1: 'Player A',
        player2: 'Player B',
        tournament: 'Wimbledon',
        start: '2025-01-01T12:00:00Z',
        tour: 'atp',
        market: 'Moneyline',
        eloDeps: {
          snapshot: ds,
          resolvePlayer: dataResolver(ds)
        }
      });
      assert.equal(r.elo.available, true);
      assert.equal(r.elo.coverage, 'full');
      assert.equal(r.elo.tour, 'atp');
      assert.equal(r.signals.eloAvailable, true);
      assert.ok(r.elo.probabilities.player1 > 0);
      assert.ok(r.elo.probabilities.player2 > 0);
    });

    it('uses explicit tour override', async () => {
      mockCurlSuccess(EMPTY_RSS);
      const { getTennisContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = await getTennisContext({
        player1: 'Player A',
        player2: 'Player B',
        tournament: 'Wimbledon',
        market: 'Moneyline',
        tour: 'wta',
        eloDeps: {
          snapshot: ds,
          resolvePlayer: dataResolver(ds)
        }
      });
      assert.equal(r.elo.available, false);
      assert.equal(r.elo.tour, 'wta');
    });

    it('derives tour from level string containing ATP', async () => {
      mockCurlSuccess(EMPTY_RSS);
      const { getTennisContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = await getTennisContext({
        player1: 'Player A',
        player2: 'Player B',
        tournament: 'Rotterdam Open',
        market: 'Moneyline',
        eloDeps: { snapshot: ds, resolvePlayer: dataResolver(ds) }
      });
      assert.equal(r.elo.tour, 'atp');
    });
  });

  describe('additive-only regression', () => {
    it('riskFlag and riskSummary are identical with and without elo', async () => {
      mockCurlSuccess(EMPTY_RSS);
      const { getTennisContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r1 = await getTennisContext({
        player1: 'Player A',
        player2: 'Player B',
        tournament: 'Wimbledon',
        start: '2025-01-01T12:00:00Z'
      });
      clearModuleCache();
      mockCurlSuccess(EMPTY_RSS);
      const r2 = await getTennisContext({
        player1: 'Player A',
        player2: 'Player B',
        tournament: 'Wimbledon',
        start: '2025-01-01T12:00:00Z',
        tour: 'atp',
        market: 'Moneyline',
        eloDeps: { snapshot: ds, resolvePlayer: dataResolver(ds) }
      });
      assert.equal(r2.riskFlag, r1.riskFlag, 'riskFlag must be identical');
      assert.equal(r2.riskSummary, r1.riskSummary, 'riskSummary must be identical');
      assert.equal(r2.surface, r1.surface, 'surface must be identical');
      assert.equal(r2.level, r1.level, 'level must be identical');
      assert.equal(r2.tournament, r1.tournament, 'tournament must be identical');
      assert.equal(r1.signals.eloAvailable, false);
      assert.equal(r2.signals.eloAvailable, true);
    });
  });

  describe('selection threading and explicit-only fair probability', () => {
    it('populates selectedProbability when selection exactly matches a resolved player', async () => {
      mockCurlSuccess(EMPTY_RSS);
      const { getTennisContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = await getTennisContext({
        player1: 'Player A',
        player2: 'Player B',
        tournament: 'Wimbledon',
        start: '2025-01-01T12:00:00Z',
        tour: 'atp',
        market: 'Moneyline',
        selection: 'Player A',
        eloDeps: { snapshot: ds, resolvePlayer: dataResolver(ds) }
      });
      assert.equal(r.elo.available, true);
      assert.equal(r.elo.selectedProbability, r.elo.probabilities.player1);
      assert.equal(r.elo.marketFairProbability, null, 'never derive marketFairProbability from odds');
      assert.equal(r.elo.disagreement, null, 'disagreement requires an explicit marketFairProbability');
    });

    it('keeps explicit marketFairProbability when the caller supplies it', async () => {
      mockCurlSuccess(EMPTY_RSS);
      const { getTennisContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = await getTennisContext({
        player1: 'Player A',
        player2: 'Player B',
        tournament: 'Wimbledon',
        start: '2025-01-01T12:00:00Z',
        tour: 'atp',
        market: 'Moneyline',
        selection: 'Player A',
        marketFairProbability: 0.55,
        eloDeps: { snapshot: ds, resolvePlayer: dataResolver(ds) }
      });
      assert.equal(r.elo.marketFairProbability, 0.55);
      assert.equal(typeof r.elo.disagreement, 'number');
    });
  });

  describe('verdict/tier invariant with Elo', () => {
    it('full context result never exposes consensusEdge/signalTier/kaiCall/displayTier/finalVerdict when elo is available', async () => {
      mockCurlSuccess(EMPTY_RSS);
      const { getTennisContext } = require('../lib/propprofessor-tennis-context');
      const ds = makeDataSnapshot();
      const r = await getTennisContext({
        player1: 'Player A',
        player2: 'Player B',
        tournament: 'Wimbledon',
        start: '2025-01-01T12:00:00Z',
        tour: 'atp',
        market: 'Moneyline',
        eloDeps: { snapshot: ds, resolvePlayer: dataResolver(ds) }
      });
      assert.equal(r.elo.available, true);
      assert.equal(r.consensusEdge, undefined);
      assert.equal(r.signalTier, undefined);
      assert.equal(r.kaiCall, undefined);
      assert.equal(r.displayTier, undefined);
      assert.equal(r.finalVerdict, undefined);
      assert.equal(r.confidenceTier, undefined);
    });
  });

  describe('elo available false with missing snapshot (default load)', () => {
    it('returns snapshot_unavailable when default loadSnapshot finds no file', async () => {
      mockCurlSuccess(EMPTY_RSS);
      // Hermetic: pin the snapshot path to a nonexistent file so this test
      // does not depend on ambient machine state (a real snapshot on disk
      // makes the default load succeed and resolvePlayer return
      // 'player_unresolved' for the fake players instead).
      const prev = process.env.PP_TENNIS_ELO_SNAPSHOT;
      process.env.PP_TENNIS_ELO_SNAPSHOT = '/nonexistent/tennis-elo-snapshot.json';
      try {
        const { getTennisContext } = require('../lib/propprofessor-tennis-context');
        const r = await getTennisContext({
          player1: 'Player A',
          player2: 'Player B',
          tournament: 'Wimbledon',
          start: '2025-01-01T12:00:00Z',
          tour: 'atp',
          market: 'Moneyline'
        });
        assert.equal(r.elo.available, false);
        assert.equal(r.elo.coverage, 'snapshot_unavailable');
      } finally {
        if (prev === undefined) delete process.env.PP_TENNIS_ELO_SNAPSHOT;
        else process.env.PP_TENNIS_ELO_SNAPSHOT = prev;
      }
    });
  });
});

// =========================================================================
// Game-context market threading
// =========================================================================

describe('getGameContext — tennis market threading', () => {
  beforeEach(() => clearModuleCache());

  it('threads market from getGameContext to getTennisContext for Tennis', async () => {
    // When market:'Moneyline' is passed, elo coverage should NOT be
    // 'market_unknown' (which would mean market was lost). The tour may
    // be unknown for Grand Slams (neither 'ATP' nor 'WTA' in level),
    // but that still proves market was threaded.
    const mod = require('../lib/propprofessor-game-context');
    const r = await mod.getGameContext({
      sport: 'Tennis',
      selection: 'Djokovic',
      game: 'Wimbledon',
      market: 'Moneyline'
    });
    assert.notEqual(r.elo.coverage, 'market_unknown', 'market must be threaded from getGameContext');
    assert.equal(r.signals.eloAvailable, false);
  });

  it('without market, getGameContext Tennis returns elo market_unknown', async () => {
    const mod = require('../lib/propprofessor-game-context');
    const r = await mod.getGameContext({
      sport: 'Tennis',
      selection: 'Djokovic',
      game: 'Wimbledon'
    });
    assert.equal(r.elo.available, false);
    assert.equal(r.elo.coverage, 'market_unknown');
  });
});

// =========================================================================
// Elo module isolation
// =========================================================================

describe('Elo module isolation', () => {
  it('lib/tennis-elo.js does not import ranker or verdict modules', () => {
    const fs = require('node:fs');
    const eloSource = fs.readFileSync(require('node:path').join(__dirname, '..', 'lib', 'tennis-elo.js'), 'utf8');
    assert.ok(!eloSource.includes("require('./screen-ranker')"), 'tennis-elo must not require screen-ranker');
    assert.ok(!eloSource.includes("require('./propprofessor-analysis')"), 'tennis-elo must not require analysis');
    assert.ok(!eloSource.includes("require('./propprofessor-risk-score')"), 'tennis-elo must not require risk-score');
    assert.ok(
      !eloSource.includes("require('./propprofessor-signal-calibration')"),
      'tennis-elo must not require signal-calibration'
    );
  });

  it('lib/tennis-elo-data.js does not import ranker or verdict modules', () => {
    const fs = require('node:fs');
    const dataSource = fs.readFileSync(require('node:path').join(__dirname, '..', 'lib', 'tennis-elo-data.js'), 'utf8');
    assert.ok(!dataSource.includes("require('./screen-ranker')"), 'tennis-elo-data must not require screen-ranker');
    assert.ok(!dataSource.includes("require('./propprofessor-analysis')"), 'tennis-elo-data must not require analysis');
    assert.ok(
      !dataSource.includes("require('./propprofessor-risk-score')"),
      'tennis-elo-data must not require risk-score'
    );
    assert.ok(
      !dataSource.includes("require('./propprofessor-signal-calibration')"),
      'tennis-elo-data must not require signal-calibration'
    );
  });

  it('lib/propprofessor-tennis-context.js getTennisEloContext has no ranker/verdict fields', () => {
    const { getTennisEloContext } = require('../lib/propprofessor-tennis-context');
    if (!ENGINE_SNAPSHOT_AVAILABLE) return;
    const { snapshot, resolver } = makeEngineSnapshot();
    const r = getTennisEloContext({
      tour: 'atp',
      player1: 'Player A',
      player2: 'Player B',
      surface: 'hard',
      snapshot,
      resolvePlayer: resolver,
      predictMatch: eloEngine.predictMatch
    });
    assert.equal(r.consensusEdge, undefined);
    assert.equal(r.confidenceTier, undefined);
    assert.equal(r.signalTier, undefined);
    assert.equal(r.kaiCall, undefined);
    assert.equal(r.displayTier, undefined);
    assert.equal(r.finalVerdict, undefined);
  });
});
