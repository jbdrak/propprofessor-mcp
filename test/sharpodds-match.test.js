'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeTeamName,
  normalizeLeague,
  normalizeMarketType,
  normalizeSegment,
  normalizeSide,
  matchSharpOddsEvent,
} = require('../lib/sharpodds-match');

const START = '2026-09-01T19:05:00Z';

function request(overrides = {}) {
  return {
    homeTeam: 'Los Angeles Dodgers',
    awayTeam: 'New York Yankees',
    league: 'MLB',
    startTime: START,
    market: { type: 'total', segment: 'full-game', side: 'over', line: 8.5 },
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    event: {
      id: '98765',
      homeTeam: 'Los Angeles Dodgers',
      awayTeam: 'New York Yankees',
      league: 'MLB',
      startTime: START,
    },
    market: { type: 'total', segment: 'full-game', side: 'over', line: 8.5 },
    ...overrides,
  };
}

describe('sharpodds-match normalizers', () => {
  it('normalizes team names for comparison', () => {
    assert.equal(normalizeTeamName('  Los Angeles Dodgers '), 'los angeles dodgers');
    assert.equal(normalizeTeamName('St. Louis Cardinals'), 'st louis cardinals');
    assert.equal(normalizeTeamName(''), null);
    assert.equal(normalizeTeamName(null), null);
  });

  it('treats loose substrings as non-equal', () => {
    assert.notEqual(normalizeTeamName('Yankees'), normalizeTeamName('New York Yankees'));
  });

  it('normalizes leagues and common aliases', () => {
    assert.equal(normalizeLeague('MLB'), normalizeLeague('mlb'));
    assert.equal(normalizeLeague('College Basketball'), normalizeLeague('NCAAB'));
    assert.equal(normalizeLeague(''), null);
  });

  it('normalizes market types, segments, and sides', () => {
    assert.equal(normalizeMarketType('SPREADS'), 'spread');
    assert.equal(normalizeMarketType('ML'), 'moneyline');
    assert.equal(normalizeMarketType('bogus'), null);
    assert.equal(normalizeSegment('FG'), 'full-game');
    assert.equal(normalizeSegment('Game'), 'full-game');
    assert.equal(normalizeSegment('1H'), '1st-half');
    assert.equal(normalizeSegment('mystery-period'), null);
    assert.equal(normalizeSide('O'), 'over');
    assert.equal(normalizeSide('u'), 'under');
    assert.equal(normalizeSide('bogus'), null);
  });
});

describe('sharpodds-match event identity', () => {
  it('matches by stable numeric SharpOdds event ID', () => {
    const result = matchSharpOddsEvent(
      request({ sharpOddsEventId: '98765' }),
      candidate({ event: { id: 98765, homeTeam: 'Los Angeles Dodgers', awayTeam: 'New York Yankees', league: 'MLB', startTime: START } })
    );
    assert.equal(result.matched, true);
    assert.equal(result.matchStrength, 'exact-id');
    assert.ok(result.reasons.includes('id_match'));
  });

  it('fails closed on SharpOdds event ID mismatch even when teams agree', () => {
    const result = matchSharpOddsEvent(request({ sharpOddsEventId: '11111' }), candidate());
    assert.equal(result.matched, false);
    assert.ok(result.reasons.includes('id_mismatch'));
  });

  it('matches reversed display order while preserving feed home/away semantics', () => {
    const result = matchSharpOddsEvent(
      request(),
      candidate({
        event: {
          id: '98765',
          homeTeam: 'New York Yankees',
          awayTeam: 'Los Angeles Dodgers',
          league: 'MLB',
          startTime: START,
        },
      })
    );
    assert.equal(result.matched, true);
    assert.equal(result.order, 'swapped');
    assert.ok(result.reasons.includes('order_swapped'));
  });

  it('maps home/away sides across reversed display order', () => {
    const req = request({ market: { type: 'spread', segment: 'full-game', side: 'away', line: 1.5 } });
    const cand = candidate({
      event: {
        homeTeam: 'New York Yankees',
        awayTeam: 'Los Angeles Dodgers',
        league: 'MLB',
        startTime: START,
      },
      market: { type: 'spread', segment: 'full-game', side: 'home', line: 1.5 },
    });
    const result = matchSharpOddsEvent(req, cand);
    assert.equal(result.matched, true);
    assert.ok(result.reasons.includes('side_match'));
  });

  it('accepts valid normalized team aliases', () => {
    const result = matchSharpOddsEvent(
      request(),
      candidate({
        event: {
          homeTeam: 'LA Dodgers',
          awayTeam: 'NY Yankees',
          league: 'MLB',
          startTime: START,
        },
      })
    );
    assert.equal(result.matched, true);
    assert.ok(result.reasons.includes('teams_match'));
  });

  it('rejects one-team matches', () => {
    const result = matchSharpOddsEvent(
      request(),
      candidate({
        event: {
          homeTeam: 'Los Angeles Dodgers',
          awayTeam: 'Boston Red Sox',
          league: 'MLB',
          startTime: START,
        },
      })
    );
    assert.equal(result.matched, false);
    assert.ok(result.reasons.includes('team_mismatch'));
  });

  it('rejects loose-substring team matches', () => {
    const result = matchSharpOddsEvent(
      request(),
      candidate({
        event: {
          homeTeam: 'Dodgers',
          awayTeam: 'Yankees',
          league: 'MLB',
          startTime: START,
        },
      })
    );
    assert.equal(result.matched, false);
  });

  it('accepts start times within tolerance and rejects those outside it', () => {
    const within = matchSharpOddsEvent(
      request(),
      candidate({
        event: {
          homeTeam: 'Los Angeles Dodgers',
          awayTeam: 'New York Yankees',
          league: 'MLB',
          startTime: '2026-09-01T20:00:00Z',
        },
      })
    );
    assert.equal(within.matched, true);
    assert.ok(within.reasons.includes('time_agree'));

    const outside = matchSharpOddsEvent(
      request(),
      candidate({
        event: {
          homeTeam: 'Los Angeles Dodgers',
          awayTeam: 'New York Yankees',
          league: 'MLB',
          startTime: '2026-09-01T23:00:00Z',
        },
      })
    );
    assert.equal(outside.matched, false);
    assert.ok(outside.reasons.includes('time_mismatch'));
  });

  it('fails closed when either side has no parseable start time', () => {
    const missing = matchSharpOddsEvent(
      request(),
      candidate({
        event: {
          homeTeam: 'Los Angeles Dodgers',
          awayTeam: 'New York Yankees',
          league: 'MLB',
        },
      })
    );
    assert.equal(missing.matched, false);
    assert.ok(missing.reasons.includes('start_time_missing'));

    const requestMissing = matchSharpOddsEvent(request({ startTime: undefined }), candidate());
    assert.equal(requestMissing.matched, false);
    assert.ok(requestMissing.reasons.includes('start_time_missing'));
  });

  it('rejects league mismatches', () => {
    const result = matchSharpOddsEvent(request({ league: 'MLB' }), candidate({
      event: {
        homeTeam: 'Los Angeles Dodgers',
        awayTeam: 'New York Yankees',
        league: 'NFL',
        startTime: START,
      },
    }));
    assert.equal(result.matched, false);
    assert.ok(result.reasons.includes('league_mismatch'));
  });

  it('skips league agreement when one side omits it', () => {
    const result = matchSharpOddsEvent(request({ league: undefined }), candidate());
    assert.equal(result.matched, true);
    assert.ok(result.reasons.includes('league_unconstrained'));
  });
});

describe('sharpodds-match market identity', () => {
  it('rejects segment mismatches (full-game versus period)', () => {
    const result = matchSharpOddsEvent(
      request(),
      candidate({ market: { type: 'total', segment: '1st-half', side: 'over', line: 8.5 } })
    );
    assert.equal(result.matched, false);
    assert.ok(result.reasons.includes('segment_mismatch'));
  });

  it('fails closed on unknown provider segments', () => {
    const result = matchSharpOddsEvent(
      request(),
      candidate({ market: { type: 'total', segment: 'mystery-period', side: 'over', line: 8.5 } })
    );
    assert.equal(result.matched, false);
    assert.ok(result.reasons.includes('segment_unknown'));
  });

  it('rejects market-type mismatches', () => {
    const result = matchSharpOddsEvent(
      request(),
      candidate({ market: { type: 'spread', segment: 'full-game', side: 'away', line: 1.5 } })
    );
    assert.equal(result.matched, false);
    assert.ok(result.reasons.includes('market_mismatch'));
  });

  it('rejects side mismatches', () => {
    const result = matchSharpOddsEvent(
      request(),
      candidate({ market: { type: 'total', segment: 'full-game', side: 'under', line: 8.5 } })
    );
    assert.equal(result.matched, false);
    assert.ok(result.reasons.includes('side_mismatch'));
  });

  it('rejects line mismatches when the provider identifies a line', () => {
    const result = matchSharpOddsEvent(
      request(),
      candidate({ market: { type: 'total', segment: 'full-game', side: 'over', line: 9.5 } })
    );
    assert.equal(result.matched, false);
    assert.ok(result.reasons.includes('line_mismatch'));
  });

  it('passes the line check for moneylines with null lines', () => {
    const req = request({ market: { type: 'moneyline', segment: 'full-game', side: 'away', line: null } });
    const cand = candidate({
      market: { type: 'moneyline', segment: 'full-game', side: 'away', line: null },
    });
    const result = matchSharpOddsEvent(req, cand);
    assert.equal(result.matched, true);
    assert.ok(result.reasons.includes('line_match') || result.reasons.includes('line_unconstrained'));
  });

  it('returns structured diagnostics on success', () => {
    const result = matchSharpOddsEvent(request(), candidate());
    assert.equal(result.matched, true);
    assert.ok(['strong', 'standard'].includes(result.matchStrength));
    assert.ok(Array.isArray(result.reasons) && result.reasons.length > 0);
    assert.equal(result.order, 'aligned');
    assert.equal(typeof result.timeDeltaMs, 'number');
  });
});
