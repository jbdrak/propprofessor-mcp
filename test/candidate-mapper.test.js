'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapCandidateRow } = require('../lib/propprofessor-mcp-candidate-mapper');

describe('mapCandidateRow screenUrl', () => {
  it('builds a screenUrl deep-link when gameId/market/selection present', () => {
    const out = mapCandidateRow({
      gameId: 'WNBA:PREMATCH:Las_Vegas_Aces:Phoenix_Mercury:1783807200',
      market: 'Total Points',
      league: 'WNBA',
      selection: 'Under 166.5',
      start: '2026-07-11T22:00:00.000Z'
    });
    assert.equal(
      out.screenUrl,
      'https://app.propprofessor.com/screen?market=Total%20Points' +
        '&game=WNBA%3APREMATCH%3ALas_Vegas_Aces%3APhoenix_Mercury%3A1783807200' +
        '&league=WNBA&participant=Under%20166.5'
    );
  });

  it('returns null screenUrl when required fields are missing', () => {
    const out = mapCandidateRow({ selection: 'Lakers' });
    assert.equal(out.screenUrl, null);
  });

  it('recomputes movementDisposition via computeMovementDisposition (honors sharpBookMovementConfirmed)', () => {
    const out = mapCandidateRow({
      gameId: 'Tennis:PREMATCH:Rodionov:Tabur:1783937400',
      market: 'Moneyline',
      selection: 'Rodionov',
      movementGrade: 'yellow',
      movementLabel: 'insufficient_history',
      recentSharpMoveDirection: 'insufficient_history',
      fullWindowSharpMoveDirection: 'insufficient_history',
      sharpBookMovementConfirmed: true,
      sharpBookMovementSource: 'Pinnacle',
      confidenceTier: 'TIER 2',
      consensusBookCount: 16
    });
    assert.equal(out.movementDisposition, 'supportive_bouncy');
    assert.equal(out.sharpBookMovementConfirmed, true);
  });

  it('does not trust a stale incoming movementDisposition when the flag is present', () => {
    // Incoming row carries a stale 'insufficient' stamp (pre-tag) — mapper must override it.
    const out = mapCandidateRow({
      gameId: 'Tennis:PREMATCH:Rodionov:Tabur:1783937400',
      market: 'Moneyline',
      selection: 'Rodionov',
      movementDisposition: 'insufficient',
      movementGrade: 'yellow',
      movementLabel: 'insufficient_history',
      recentSharpMoveDirection: 'insufficient_history',
      fullWindowSharpMoveDirection: 'insufficient_history',
      sharpBookMovementConfirmed: true
    });
    assert.equal(out.movementDisposition, 'supportive_bouncy');
  });

  it('recomputed disposition drives staleMovementWarning correctly', () => {
    const out = mapCandidateRow({
      gameId: 'G:1',
      market: 'Moneyline',
      selection: 'X',
      movementDisposition: 'adverse_full', // stale incoming — must be ignored
      movementGrade: 'red',
      movementLabel: 'adverse',
      recentSharpMoveDirection: 'adverse',
      fullWindowSharpMoveDirection: 'adverse',
      sharpBookMovementConfirmed: false,
      confidenceTier: 'TIER 1',
      consensusBookCount: 12
    });
    assert.equal(out.movementDisposition, 'adverse_full');
    assert.equal(out.staleMovementWarning, true);
  });

  it('movementSummary renders consensusEdge as percentage points (no 100x inflation)', () => {
    const out = mapCandidateRow({
      gameId: 'MLB:PREMATCH:TeamA:TeamB:1783937400',
      market: 'Moneyline',
      selection: 'TeamA',
      movementGrade: 'green',
      movementLabel: 'supportive',
      recentSharpMoveDirection: 'supportive',
      fullWindowSharpMoveDirection: 'supportive',
      consensusEdge: 2.5
    });
    assert.equal(out.movementDisposition, 'supportive_clean');
    assert.ok(out.movementSummary.includes('2.5% edge'), `summary was: ${out.movementSummary}`);
    assert.ok(!out.movementSummary.includes('250.0%'), `summary was: ${out.movementSummary}`);
  });
});
