'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeScanCandidates, buildCandidateId } = require('../lib/record-candidates');

// Focused Task 2 tests: normalize scan output into recordable candidates.
// No recommendation logic, no official-bet creation, deterministic IDs.

describe('normalizeScanCandidates', () => {
  it('flattens all league/market blocks, including tennis fallback rows', () => {
    const blocks = [
      {
        league: 'MLB',
        market: 'Moneyline',
        plays: [
          { gameId: 'g1', game: 'NYY @ BOS', selection: 'Yankees', odds: -120 },
          { gameId: 'g2', game: 'HOU @ TEX', selection: 'Astros', odds: +150 }
        ]
      },
      {
        league: 'Tennis',
        market: 'All Markets',
        plays: [
          {
            gameId: 'tennis-game-1',
            game: 'Djokovic N vs Alcaraz C',
            market: 'Moneyline',
            selection: 'Djokovic N',
            odds: -120,
            verdict: 'BET',
            source: 'tennis_fallback (Pinnacle)'
          }
        ]
      }
    ];
    const out = normalizeScanCandidates(blocks, { scanId: 'scan-1' });
    assert.equal(out.length, 3);
    // Block-level league/market inherited onto plays that lack them.
    assert.equal(out[0].league, 'MLB');
    assert.equal(out[0].market, 'Moneyline');
    assert.equal(out[1].league, 'MLB');
    // Tennis fallback row keeps its own row-level market, block market otherwise.
    assert.equal(out[2].league, 'Tennis');
    assert.equal(out[2].market, 'Moneyline');
  });

  it('preserves market names exactly, including Set Handicap', () => {
    const out = normalizeScanCandidates(
      [
        {
          league: 'Tennis',
          market: 'Set Handicap',
          plays: [{ gameId: 't1', selection: 'Djokovic N -2.5 sets', odds: -110 }]
        },
        {
          league: 'NBA',
          market: 'Point Spread',
          plays: [{ gameId: 'n1', selection: 'Lakers +4.5', odds: -110 }]
        }
      ],
      { scanId: 'scan-set-handicap' }
    );
    assert.equal(out[0].market, 'Set Handicap');
    assert.equal(out[1].market, 'Point Spread');
  });

  it('preserves the full field set and normalizes missing fields to null', () => {
    const out = normalizeScanCandidates(
      [
        {
          league: 'MLB',
          market: 'Moneyline',
          plays: [
            {
              gameId: 'g1',
              game: 'NYY @ BOS',
              selection: 'Yankees',
              odds: -120,
              tier: 'TIER 1',
              verdict: 'BET',
              movement: 'up',
              movementDisposition: 'supportive_clean',
              edge: 2.1,
              clvProxyPct: 1.8,
              books: 12,
              consensusBookCount: 12,
              start: '2026-08-05T18:00:00.000Z',
              startCST: '1:00 PM',
              startDisplay: '1:00 PM CDT',
              startSource: 'pp-mcp (unverified)',
              startConfidence: 0.3
            }
          ]
        }
      ],
      { scanId: 'scan-full' }
    );
    const r = out[0];
    assert.equal(r.gameId, 'g1');
    assert.equal(r.game, 'NYY @ BOS');
    assert.equal(r.league, 'MLB');
    assert.equal(r.market, 'Moneyline');
    assert.equal(r.selection, 'Yankees');
    assert.equal(r.odds, -120);
    assert.equal(r.tier, 'TIER 1');
    assert.equal(r.verdict, 'BET');
    assert.equal(r.movement, 'up');
    assert.equal(r.movementDisposition, 'supportive_clean');
    assert.equal(r.edge, 2.1);
    assert.equal(r.clvProxyPct, 1.8);
    assert.equal(r.books, 12);
    assert.equal(r.consensusBookCount, 12);
    assert.equal(r.start, '2026-08-05T18:00:00.000Z');
    assert.equal(r.startCST, '1:00 PM');
    assert.equal(r.startDisplay, '1:00 PM CDT');
    assert.equal(r.startSource, 'pp-mcp (unverified)');
    assert.equal(r.startConfidence, 0.3);

    // Missing fields are null, never invented.
    const sparse = normalizeScanCandidates([{ league: 'NBA', market: 'Spread', plays: [{ selection: 'Lakers' }] }], {
      scanId: 'scan-sparse'
    })[0];
    assert.equal(sparse.gameId, null);
    assert.equal(sparse.game, null);
    assert.equal(sparse.odds, null);
    assert.equal(sparse.tier, null);
    assert.equal(sparse.verdict, null);
    assert.equal(sparse.movement, null);
    assert.equal(sparse.movementDisposition, null);
    assert.equal(sparse.edge, null);
    assert.equal(sparse.clvProxyPct, null);
    assert.equal(sparse.books, null);
    assert.equal(sparse.consensusBookCount, null);
    assert.equal(sparse.start, null);
    assert.equal(sparse.startCST, null);
    assert.equal(sparse.startDisplay, null);
    assert.equal(sparse.startSource, null);
    assert.equal(sparse.startConfidence, null);
  });

  it('keeps BET/CONSIDER verdicts as raw data and never creates an official bet', () => {
    const out = normalizeScanCandidates(
      [
        {
          league: 'Tennis',
          market: 'All Markets',
          plays: [
            { gameId: 't1', selection: 'Djokovic N', odds: -120, verdict: 'BET' },
            { gameId: 't2', selection: 'Nakashima', odds: -110, verdict: 'CONSIDER' },
            { gameId: 't3', selection: 'Alcaraz C', odds: +100 }
          ]
        }
      ],
      { scanId: 'scan-verdicts' }
    );
    assert.equal(out[0].verdict, 'BET');
    assert.equal(out[1].verdict, 'CONSIDER');
    assert.equal(out[2].verdict, null);
    // Record shape is exactly the documented field set — no bet flag, no
    // recommendation/decision field derived from the raw verdict.
    assert.deepEqual(Object.keys(out[0]).sort(), [
      'books',
      'candidateId',
      'clvProxyPct',
      'consensusBookCount',
      'edge',
      'game',
      'gameId',
      'league',
      'market',
      'movement',
      'movementDisposition',
      'odds',
      'selection',
      'start',
      'startCST',
      'startConfidence',
      'startDisplay',
      'startSource',
      'tier',
      'verdict'
    ]);
  });

  it('accepts a wrapped res shape ({data:{results}} or {results}) in addition to a bare array', () => {
    const block = { league: 'MLB', market: 'Moneyline', plays: [{ gameId: 'g1', selection: 'Yankees', odds: -120 }] };
    const fromData = normalizeScanCandidates({ data: { results: [block] } }, { scanId: 's' });
    const fromRes = normalizeScanCandidates({ results: [block] }, { scanId: 's' });
    const fromArray = normalizeScanCandidates([block], { scanId: 's' });
    assert.equal(fromData.length, 1);
    assert.equal(fromRes.length, 1);
    assert.equal(fromArray.length, 1);
    assert.deepEqual(fromData[0].candidateId, fromArray[0].candidateId);
    assert.deepEqual(fromRes[0].candidateId, fromArray[0].candidateId);
  });

  it('skips blocks with no plays and returns [] for empty input', () => {
    const out = normalizeScanCandidates(
      [
        { league: 'MLB', market: 'Moneyline', plays: [] },
        { league: 'NBA', market: 'Spread', plays: [{ gameId: 'g1', selection: 'Lakers', odds: -110 }] },
        { league: 'Tennis', market: 'All Markets', plays: [] }
      ],
      { scanId: 'scan-empties' }
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].league, 'NBA');
    assert.deepEqual(normalizeScanCandidates([], { scanId: 's' }), []);
    assert.deepEqual(normalizeScanCandidates(null, { scanId: 's' }), []);
    assert.deepEqual(normalizeScanCandidates({}, { scanId: 's' }), []);
  });

  it('inherits block-level league/market onto plays that carry their own conflicting values', () => {
    // Row-level values win; block-level values are the fallback, not an override.
    const out = normalizeScanCandidates(
      [
        {
          league: 'Tennis',
          market: 'All Markets',
          plays: [{ gameId: 't1', league: 'Tennis', market: 'Set Handicap', selection: 'Djokovic N -2.5', odds: -110 }]
        }
      ],
      { scanId: 'scan-inherit' }
    );
    assert.equal(out[0].league, 'Tennis');
    assert.equal(out[0].market, 'Set Handicap');
  });
});

describe('buildCandidateId', () => {
  const base = { scanId: 'scan-1', gameId: 'g1', market: 'Moneyline', selection: 'Yankees', odds: -120 };

  it('is deterministic for identical inputs', () => {
    assert.equal(buildCandidateId(base), buildCandidateId(base));
  });

  it('varies with scan ID', () => {
    assert.notEqual(buildCandidateId(base), buildCandidateId({ ...base, scanId: 'scan-2' }));
  });

  it('varies with game ID, market, selection, and captured price context', () => {
    assert.notEqual(buildCandidateId(base), buildCandidateId({ ...base, gameId: 'g2' }));
    assert.notEqual(buildCandidateId(base), buildCandidateId({ ...base, market: 'Spread' }));
    assert.notEqual(buildCandidateId(base), buildCandidateId({ ...base, selection: 'Red Sox' }));
    assert.notEqual(buildCandidateId(base), buildCandidateId({ ...base, odds: -110 }));
  });

  it('produces a 16-char hex id following the repo sha256 convention', () => {
    const id = buildCandidateId(base);
    assert.match(id, /^[0-9a-f]{16}$/);
  });

  it('is stable for missing optional fields (null/undefined normalize the same)', () => {
    assert.equal(
      buildCandidateId({ scanId: 's', gameId: 'g', market: null, selection: 'X', odds: undefined }),
      buildCandidateId({ scanId: 's', gameId: 'g', market: undefined, selection: 'X', odds: null })
    );
  });
});
