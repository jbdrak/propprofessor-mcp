'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { describeLiquidity } = require('../lib/screen-ranker');

describe('describeLiquidity', () => {
  it('buckets fillable depth for $50-100 tickets', () => {
    assert.equal(describeLiquidity(56), 'thin');
    assert.equal(describeLiquidity(99.9), 'thin');
    assert.equal(describeLiquidity(100), 'playable');
    assert.equal(describeLiquidity(413), 'playable');
    assert.equal(describeLiquidity(1000), 'playable');
    assert.equal(describeLiquidity(7723), 'deep');
  });

  it('returns null when the book does not report liquidity', () => {
    assert.equal(describeLiquidity(0), null);
    assert.equal(describeLiquidity(null), null);
    assert.equal(describeLiquidity(undefined), null);
    assert.equal(describeLiquidity('garbage'), null);
  });
});
