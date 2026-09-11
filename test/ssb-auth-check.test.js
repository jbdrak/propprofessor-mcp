'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isAuthValid } = require('../lib/ssb-api');

describe('isAuthValid', () => {
  it('returns false for null', () => {
    assert.equal(isAuthValid(null), false);
  });

  it('returns false for undefined', () => {
    assert.equal(isAuthValid(undefined), false);
  });

  it('returns false for an empty object', () => {
    assert.equal(isAuthValid({}), false);
  });

  it('returns false when cookies is an empty array', () => {
    assert.equal(isAuthValid({ cookies: [] }), false);
  });

  it('returns false when no cookie matches the propprofessor.com domain', () => {
    assert.equal(
      isAuthValid({
        cookies: [{ name: 'x', domain: 'other.com', value: 'abc' }]
      }),
      false
    );
  });

  it('returns false when a propprofessor.com cookie has an empty value', () => {
    assert.equal(
      isAuthValid({
        cookies: [{ name: 'session', domain: '.propprofessor.com', value: '' }]
      }),
      false
    );
  });

  it('returns true when a propprofessor.com cookie has a non-empty value', () => {
    assert.equal(
      isAuthValid({
        cookies: [{ name: 'session', domain: '.propprofessor.com', value: 'abc' }]
      }),
      true
    );
  });

  it('returns true when a cookie matches propprofessor.com (without leading dot)', () => {
    assert.equal(
      isAuthValid({
        cookies: [{ name: 'session', domain: 'propprofessor.com', value: 'xyz' }]
      }),
      true
    );
  });

  it('returns true when a subdomain cookie matches', () => {
    assert.equal(
      isAuthValid({
        cookies: [{ name: 'session', domain: '.app.propprofessor.com', value: 'abc' }]
      }),
      true
    );
  });
});
