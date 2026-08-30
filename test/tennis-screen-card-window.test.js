'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { filterTennisRowsByCardWindow } = require('../lib/tennis-fallback');

const NOW = Date.parse('2026-08-29T23:00:00-05:00');

test('tennis fallback next window excludes same-day rows', () => {
  const rows = [
    { game: 'same day', start: '2026-08-29T00:30:00.000Z' },
    { game: 'tomorrow', start: '2026-08-30T15:00:00.000Z' },
    { game: 'day after', start: '2026-08-31T15:00:00.000Z' }
  ];

  assert.deepEqual(
    filterTennisRowsByCardWindow(rows, 'next', {
      nowMs: NOW,
      timezone: 'America/Chicago'
    }).map((row) => row.game),
    ['tomorrow']
  );
});

test('tennis fallback all window preserves every dated row', () => {
  const rows = [
    { game: 'same day', start: '2026-08-29T00:30:00.000Z' },
    { game: 'tomorrow', start: '2026-08-30T15:00:00.000Z' }
  ];

  assert.equal(filterTennisRowsByCardWindow(rows, 'all').length, 2);
});

test('strict tennis card windows drop rows without a parseable start', () => {
  assert.deepEqual(
    filterTennisRowsByCardWindow([{ game: 'unknown' }], 'next', {
      nowMs: NOW,
      timezone: 'America/Chicago'
    }),
    []
  );
});

test('tennis card window next excludes date-only rows shifted one local day by UTC midnight', () => {
  // now = Aug 29 23:00 CDT = Aug 30 04:00 UTC -> today=Aug29, next=Aug30 (Chicago).
  // A bare '2026-08-31' start is parsed as UTC midnight, which in Chicago is
  // Aug 30 — so it must NOT leak into the next (Aug 30) window.
  const rows = [
    { game: 'bare Aug31', start: '2026-08-31' },
    { game: 'iso Aug30', start: '2026-08-30T19:00:00Z' }
  ];

  assert.deepEqual(
    filterTennisRowsByCardWindow(rows, 'next', {
      nowMs: NOW,
      timezone: 'America/Chicago'
    }).map((row) => row.game),
    ['iso Aug30']
  );
});

test('tennis card window next includes date-only row on the next local day', () => {
  // now = Aug 29 23:00 CDT -> next = Aug 30 (Chicago). A date-only start of
  // '2026-08-30' denotes that calendar day and must be included.
  const rows = [{ game: 'bare Aug30', start: '2026-08-30' }];

  assert.deepEqual(
    filterTennisRowsByCardWindow(rows, 'next', {
      nowMs: NOW,
      timezone: 'America/Chicago'
    }).map((row) => row.game),
    ['bare Aug30']
  );
});

test('tennis card window today includes date-only row on the same local day', () => {
  // now = Aug 29 23:00 CDT -> today = Aug 29 (Chicago). A date-only start of
  // '2026-08-29' denotes that calendar day and must be included.
  const rows = [{ game: 'bare Aug29', start: '2026-08-29' }];

  assert.deepEqual(
    filterTennisRowsByCardWindow(rows, 'today', {
      nowMs: NOW,
      timezone: 'America/Chicago'
    }).map((row) => row.game),
    ['bare Aug29']
  );
});
