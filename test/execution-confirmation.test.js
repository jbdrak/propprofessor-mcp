'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { confirmExecution } = require('../lib/execution-confirmation');

const rankedRow = { gameId: 'GAME:1', selection: 'Home' };

function confirm(overrides = {}) {
  return confirmExecution({
    rankedOdds: -110,
    currentOdds: -110,
    currentRow: rankedRow,
    quoteAsOf: '2026-09-06T12:00:00.000Z',
    ...overrides
  });
}

test('confirms an exact American quote and preserves current metadata', () => {
  const result = confirm();

  assert.equal(result.status, 'confirmed');
  assert.equal(result.currentOdds, -110);
  assert.equal(result.quoteAsOf, '2026-09-06T12:00:00.000Z');
  assert.equal(result.gameId, 'GAME:1');
  assert.match(result.reason, /exact quote/i);
});

test('confirms American drift through 30 points but moves above 30', () => {
  assert.equal(confirm({ currentOdds: -140 }).status, 'confirmed');
  assert.equal(confirm({ currentOdds: -141 }).status, 'moved');
  assert.match(confirm({ currentOdds: -150 }).reason, /30/);
});

test('confirms NoVig percentage strings through 5 points but moves above 5', () => {
  assert.equal(confirm({ rankedOdds: '96.1%', currentOdds: '91.1%' }).status, 'confirmed');
  assert.equal(confirm({ rankedOdds: '96.1%', currentOdds: '91.0%' }).status, 'moved');
});

test('fails closed for mixed and unparseable price formats', () => {
  assert.equal(confirm({ rankedOdds: -110, currentOdds: '96.1%' }).status, 'ambiguous');
  assert.equal(confirm({ rankedOdds: 'unknown', currentOdds: -110 }).status, 'ambiguous');
});

test('fails closed for missing and malformed quote values', () => {
  const badValues = [
    null,
    undefined,
    '',
    '   ',
    false,
    NaN,
    '96.1junk%',
    '96.1%%',
    '%',
    'junk',
    '-110abc',
    '12,34',
    true,
    {},
    []
  ];
  for (const bad of badValues) {
    assert.equal(confirm({ rankedOdds: bad }).status, 'ambiguous', `ranked=${String(bad)}`);
    assert.equal(confirm({ currentOdds: bad }).status, 'ambiguous', `current=${String(bad)}`);
  }
});

test('status precedence is skipped over error over ambiguity over gone', () => {
  assert.equal(confirm({ skipped: true, lookupError: new Error('timeout'), ambiguous: true, currentRow: null }).status, 'skipped');
  assert.equal(confirm({ lookupError: new Error('timeout'), ambiguous: true, currentRow: null }).status, 'error');
  assert.equal(confirm({ ambiguous: true, currentRow: null }).status, 'ambiguous');
  assert.equal(confirm({ currentRow: null }).status, 'gone');
});

test('allows a safely matched changed game id and reports the current id', () => {
  const result = confirm({
    currentRow: { gameId: 'GAME:2', selection: 'Home' },
    matchedViaGameIdChange: true
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(result.gameId, 'GAME:2');
  assert.match(result.reason, /game id/i);
});

test('expectedGameId mismatch without safe flag is ambiguous', () => {
  assert.equal(confirm({ expectedGameId: 'GAME:1' }).status, 'confirmed');

  const mismatch = confirm({ expectedGameId: 'GAME:9' });
  assert.equal(mismatch.status, 'ambiguous');
  assert.match(mismatch.reason, /game id/i);

  const flagged = confirm({
    currentRow: { gameId: 'GAME:2', selection: 'Home' },
    expectedGameId: 'GAME:1',
    matchedViaGameIdChange: true
  });
  assert.equal(flagged.status, 'confirmed');
  assert.equal(flagged.gameId, 'GAME:2');

  const flaggedMoved = confirm({
    currentRow: { gameId: 'GAME:2', selection: 'Home' },
    expectedGameId: 'GAME:1',
    matchedViaGameIdChange: true,
    currentOdds: -150
  });
  assert.equal(flaggedMoved.status, 'moved');
});

test('rejects invalid American quotes (zero, short odds, decimals, scientific)', () => {
  const badAmerican = [0, -50, 50, 99, -99, 2.5, 1.91, '0', '99', '-50', '2.5', '1.91', '1e3', '-1e2', '+100junk'];
  for (const bad of badAmerican) {
    assert.equal(confirm({ rankedOdds: bad }).status, 'ambiguous', `ranked=${String(bad)}`);
    assert.equal(confirm({ currentOdds: bad }).status, 'ambiguous', `current=${String(bad)}`);
  }
});

test('accepts boundary American odds +100/-100 as numbers and strings', () => {
  assert.equal(confirm({ rankedOdds: 100, currentOdds: 100 }).status, 'confirmed');
  assert.equal(confirm({ rankedOdds: -100, currentOdds: -100 }).status, 'confirmed');
  assert.equal(confirm({ rankedOdds: '+100', currentOdds: '+100' }).status, 'confirmed');
  assert.equal(confirm({ rankedOdds: '-100', currentOdds: '-100' }).status, 'confirmed');
});

test('rounds drift to 4 decimals before comparing and rendering', () => {
  const boundary = confirm({ rankedOdds: '96.15%', currentOdds: '91.15%' });
  assert.equal(boundary.status, 'confirmed');

  const moved = confirm({ rankedOdds: '10.03%', currentOdds: '5.02%' });
  assert.equal(moved.status, 'moved');
  assert.match(moved.reason, /5\.01/);
  assert.ok(!/\d{5,}/.test(moved.reason), `reason must not contain float artifacts: ${moved.reason}`);
});

test('rejects out-of-range and scientific NoVig percentages', () => {
  const badPercent = ['0%', '100%', '-5%', '150%', '1e2%', '96.1e0%'];
  for (const bad of badPercent) {
    assert.equal(confirm({ rankedOdds: bad, currentOdds: '50%' }).status, 'ambiguous', `ranked=${bad}`);
    assert.equal(confirm({ rankedOdds: '50%', currentOdds: bad }).status, 'ambiguous', `current=${bad}`);
  }
});
