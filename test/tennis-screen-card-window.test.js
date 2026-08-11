'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { filterTennisRowsByCardWindow } = require('../lib/tennis-fallback');

const NOW = Date.parse('2026-08-10T23:14:20-05:00');

test('tennis fallback next window excludes same-day rows', () => {
  const rows = [
    { game: 'same day', start: '2026-08-11T00:30:00.000Z' },
    { game: 'tomorrow', start: '2026-08-11T15:00:00.000Z' },
    { game: 'day after', start: '2026-08-12T15:00:00.000Z' }
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
    { game: 'same day', start: '2026-08-11T00:30:00.000Z' },
    { game: 'tomorrow', start: '2026-08-11T15:00:00.000Z' }
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