'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getScreenSelection,
  getResolvedScreenSelection,
  resolveExtractedScreenSide,
  oddsMapForRow
} = require('../lib/selection-resolver');

describe('getScreenSelection', () => {
  it('returns the selection for the defaultKey', () => {
    const row = { selections: { a: { id: 'a' }, b: { id: 'b' } }, defaultKey: 'b' };
    assert.deepEqual(getScreenSelection(row), { id: 'b' });
  });

  it('falls back to the first key when defaultKey is absent', () => {
    const row = { selections: { a: { id: 'a' }, b: { id: 'b' } } };
    assert.deepEqual(getScreenSelection(row), { id: 'a' });
  });

  it('returns null for null row', () => {
    assert.equal(getScreenSelection(null), null);
  });

  it('returns null when selections is missing', () => {
    assert.equal(getScreenSelection({}), null);
  });

  it('returns null when selections is not an object', () => {
    assert.equal(getScreenSelection({ selections: 'nope' }), null);
  });

  it('returns null for an empty selections map', () => {
    assert.equal(getScreenSelection({ selections: {} }), null);
  });
});

describe('getResolvedScreenSelection — by selectionId', () => {
  const row = {
    selections: {
      s1: { selection1Id: 'A1', selection2Id: 'A2', odds: { DK: { odds1: -110, odds2: 100 } } },
      s2: { selection1Id: 'B1', selection2Id: 'B2', odds: { DK: { odds1: -120, odds2: 110 } } }
    }
  };

  it('matches selection1Id', () => {
    assert.deepEqual(getResolvedScreenSelection({ ...row, selectionId: 'A1' }), row.selections.s1);
  });

  it('matches selection2Id', () => {
    assert.deepEqual(getResolvedScreenSelection({ ...row, selectionId: 'B2' }), row.selections.s2);
  });

  it('matches selection_id / selectionID aliases', () => {
    assert.deepEqual(getResolvedScreenSelection({ ...row, selection_id: 'B1' }), row.selections.s2);
    assert.deepEqual(getResolvedScreenSelection({ ...row, selectionID: 'A2' }), row.selections.s1);
  });

  it('falls through when no id matches', () => {
    const r = getResolvedScreenSelection({ ...row, selectionId: 'ZZ' });
    assert.ok(r === row.selections.s1 || r === row.selections.s2, 'should fall back to first valid selection');
  });
});

describe('getResolvedScreenSelection — by book/odds/line', () => {
  const row = {
    selections: {
      s1: { line1: 22.5, odds: { DK: { odds1: -110, odds2: -105 } } }
    }
  };

  it('matches when book + currentOdds + line align', () => {
    const r = getResolvedScreenSelection({ ...row, book: 'DK', currentOdds: -110, line: 22.5 });
    assert.deepEqual(r, row.selections.s1);
  });

  it('does not match on line mismatch but still returns a valid selection via fallback', () => {
    const r = getResolvedScreenSelection({ ...row, book: 'DK', currentOdds: -110, line: 99 });
    assert.equal(r, row.selections.s1, 'line mismatch skips book/odds match, falls back to default selection');
  });

  it('skips a book whose odds entry is not an object and falls back', () => {
    const row2 = { selections: { s1: { odds: { DK: 'bad' } } } };
    const r = getResolvedScreenSelection({ ...row2, book: 'DK', currentOdds: -110, line: 22.5 });
    assert.equal(r, row2.selections.s1, 'non-object odds entry is skipped, default selection returned');
  });
});

describe('getResolvedScreenSelection — default-key ordering', () => {
  const row = {
    selections: {
      a: { odds: { DK: {} } },
      b: { odds: { DK: {} } }
    },
    defaultKey: 'b'
  };

  it('prefers the defaultKey selection first', () => {
    const r = getResolvedScreenSelection(row);
    assert.deepEqual(r, row.selections.b);
  });
});

describe('resolveExtractedScreenSide', () => {
  const selection = {
    selection1Id: 'A1',
    selection2Id: 'A2',
    selection1: 'Home',
    selection2: 'Away',
    participant1: 'Home',
    participant2: 'Away',
    odds: { DK: { odds1: -110, odds2: 100 } }
  };

  it('returns null for null inputs', () => {
    assert.equal(resolveExtractedScreenSide(null, selection), null);
    assert.equal(resolveExtractedScreenSide({}, null), null);
  });

  it('matches by selectionId', () => {
    const r = resolveExtractedScreenSide({ selectionId: 'A2' }, selection);
    assert.equal(r.oddsKey, 'odds2');
  });

  it('matches by participant name (case-insensitive)', () => {
    const r = resolveExtractedScreenSide({ participant: 'AWAY' }, selection);
    assert.equal(r.oddsKey, 'odds2');
  });

  it('matches by preferred book odds', () => {
    const r = resolveExtractedScreenSide({ book: 'DK', odds: 100 }, selection);
    assert.equal(r.oddsKey, 'odds2');
  });

  it('returns null when nothing matches', () => {
    const r = resolveExtractedScreenSide({ book: 'DK', odds: 9999 }, selection);
    assert.equal(r, null);
  });

  it('prefers selectionId over participant/odds', () => {
    const r = resolveExtractedScreenSide({ selectionId: 'A1', participant: 'Away', odds: 100 }, selection);
    assert.equal(r.oddsKey, 'odds1', 'selectionId match wins');
  });
});

describe('oddsMapForRow', () => {
  it('returns allBookOdds when present', () => {
    const row = { allBookOdds: { DK: -110 } };
    assert.deepEqual(oddsMapForRow(row), { DK: -110 });
  });

  it('falls back to resolved selection odds', () => {
    const row = { selections: { s1: { odds: { DK: -110 } } } };
    assert.deepEqual(oddsMapForRow(row), { DK: -110 });
  });

  it('returns null when no odds available', () => {
    assert.equal(oddsMapForRow({ selections: { s1: {} } }), null);
    assert.equal(oddsMapForRow(null), null);
  });
});
