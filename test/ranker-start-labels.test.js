'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { describeStartTime } = require('../lib/screen-ranker');

const NOW = Date.parse('2026-09-05T20:00:00Z');

describe('describeStartTime', () => {
  it('labels near-future starts in minutes with CT wall time', () => {
    const r = describeStartTime('2026-09-05T20:15:00Z', { league: 'NCAAF', nowMs: NOW });
    assert.equal(r.startsIn, 'in 15m');
    assert.ok(String(r.startCT).includes('CT'), `expected CT label, got ${r.startCT}`);
    assert.equal(r.startUnverified, false);
  });

  it('labels hours, days, past, and live', () => {
    assert.equal(describeStartTime('2026-09-05T23:00:00Z', { nowMs: NOW }).startsIn, 'in 3h');
    assert.equal(describeStartTime('2026-09-06T20:00:00Z', { nowMs: NOW }).startsIn, 'in 1d');
    assert.equal(describeStartTime('2026-09-05T19:00:00Z', { nowMs: NOW }).startsIn, 'started');
    assert.equal(
      describeStartTime('2026-09-05T19:00:00Z', { isLive: true, nowMs: NOW }).startsIn,
      'LIVE'
    );
  });

  it('flags tennis times unverified and handles garbage input', () => {
    const r = describeStartTime('2026-09-05T23:00:00Z', { league: 'Tennis', nowMs: NOW });
    assert.equal(r.startUnverified, true);
    const bad = describeStartTime('not-a-time', { league: 'NCAAF', nowMs: NOW });
    assert.equal(bad.startCT, null);
    assert.equal(bad.startsIn, null);
  });
});
