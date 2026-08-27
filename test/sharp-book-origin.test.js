'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifySharpBookOrigin,
  isSharpOriginator,
  SHARP_BOOK_ORIGIN_TIERS
} = require('../lib/propprofessor-sharp-books');

describe('classifySharpBookOrigin (line-movement provenance)', () => {
  it('flags the sharp originators that move first on informed action', () => {
    for (const book of ['Pinnacle', 'Circa', 'BookMaker', 'Bookmaker', 'BetOnline', 'BetCRIS', 'Heritage']) {
      assert.equal(classifySharpBookOrigin(book), 'originator', `${book} should be an originator`);
      assert.equal(isSharpOriginator(book), true, `${book} should be an originator boolean`);
    }
  });

  it('flags exchanges (Polymarket/Kalshi) as a distinct tier', () => {
    assert.equal(classifySharpBookOrigin('Polymarket'), 'exchange');
    assert.equal(classifySharpBookOrigin('Kalshi'), 'exchange');
  });

  it('flags no-vig derived books separately', () => {
    assert.equal(classifySharpBookOrigin('NoVigApp'), 'derived');
    assert.equal(classifySharpBookOrigin('OnyxOdds'), 'derived');
  });

  it('flags retail followers that copy the line later', () => {
    for (const book of ['DraftKings', 'FanDuel', 'BetMGM', 'Caesars', 'Bovada']) {
      assert.equal(classifySharpBookOrigin(book), 'follower', `${book} should be a follower`);
      assert.equal(isSharpOriginator(book), false);
    }
  });

  it('is case-insensitive and alias-tolerant', () => {
    assert.equal(classifySharpBookOrigin('pinnacle'), 'originator');
    assert.equal(classifySharpBookOrigin('PINNACLE'), 'originator');
    assert.equal(classifySharpBookOrigin('draftkings'), 'follower');
  });

  it('returns follower for an unknown book rather than fabricating a tier', () => {
    assert.equal(classifySharpBookOrigin('SomeNewBook'), 'follower');
  });

  it('exposes the origin-tier table without collapsing categories', () => {
    const values = Object.values(SHARP_BOOK_ORIGIN_TIERS);
    assert.ok(values.includes('originator'));
    assert.ok(values.includes('exchange'));
    assert.ok(values.includes('derived'));
  });
});
