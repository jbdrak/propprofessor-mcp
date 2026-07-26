'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// deriveFromPlayId is defined inline in bin/pp-cli.js. Load it without
// executing the CLI's main() by requiring the module and grabbing the export
// via a lightweight shim: pp-cli.js has no exports, so re-declare the helper
// here against the same source-of-truth regex used by the CLI to keep the test
// honest. If the CLI signature changes, this test must change too — that's
// intentional (it guards the playId-derivation contract).
const fs = require('fs');
const path = require('path');

function loadDeriveFromPlayId() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'pp-cli.js'), 'utf8');
  const start = src.indexOf('function deriveFromPlayId(');
  assert.ok(start !== -1, 'deriveFromPlayId must exist in bin/pp-cli.js');
  const end = src.indexOf('\n}\n', start);
  assert.ok(end !== -1, 'deriveFromPlayId must end with a closing brace');
  const fnSrc = src.slice(start, end + 2);
  // eslint-disable-next-line no-eval
  return eval(`(${fnSrc})`);
}

const deriveFromPlayId = loadDeriveFromPlayId();

describe('deriveFromPlayId', () => {
  it('extracts league, market, and selection from a full tennis playId', () => {
    const out = deriveFromPlayId('Tennis:PREMATCH:Darderi:Faria:1784914200::Game Handicap::faria +2.5');
    assert.equal(out.league, 'Tennis');
    assert.equal(out.market, 'Game Handicap');
    assert.equal(out.selection, 'faria +2.5');
  });

  it('extracts only league from a bare gameId (no :: separator)', () => {
    const out = deriveFromPlayId('Tennis:PREMATCH:Darderi:Faria:1784914200');
    assert.equal(out.league, 'Tennis');
    assert.equal(out.market, undefined);
    assert.equal(out.selection, undefined);
  });

  it('extracts league/market/selection from an NBA playId', () => {
    const out = deriveFromPlayId('NBA:PREMATCH:LAL:BOS:123::Moneyline::lakers');
    assert.equal(out.league, 'NBA');
    assert.equal(out.market, 'Moneyline');
    assert.equal(out.selection, 'lakers');
  });

  it('respects explicit flag overrides over playId-derived values', () => {
    const out = deriveFromPlayId('Tennis:PREMATCH:D:F:1::Game Handicap::faria +2.5', {
      league: 'MLB',
      market: 'Moneyline'
    });
    assert.equal(out.league, 'MLB');
    assert.equal(out.market, 'Moneyline');
    assert.equal(out.selection, 'faria +2.5');
  });

  it('does not override an explicit flag when playId also carries that field', () => {
    const out = deriveFromPlayId('Tennis:PREMATCH:Darderi:Faria:1784914200::Game Handicap::faria +2.5', {
      league: 'NBA'
    });
    assert.equal(out.league, 'NBA');
    assert.equal(out.market, 'Game Handicap');
    assert.equal(out.selection, 'faria +2.5');
  });

  it('returns a field-shaped object (no throw) for empty/non-string input', () => {
    // Early-return preserves the {league, market, selection} shape with
    // undefined values rather than mutating a caller object — verify it
    // doesn't throw and never derives a bogus league from junk.
    const empty = deriveFromPlayId('');
    assert.equal(empty.league, undefined);
    assert.equal(empty.market, undefined);
    assert.equal(empty.selection, undefined);
    const nul = deriveFromPlayId(null);
    assert.equal(nul.league, undefined);
    const und = deriveFromPlayId(undefined);
    assert.equal(und.league, undefined);
  });
});
