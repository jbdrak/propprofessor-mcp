'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { redactSecrets } = require('../lib/ssb-redact');

describe('redactSecrets', () => {
  describe('Google OAuth tokens', () => {
    it('redacts ya29.* access tokens', () => {
      const token = 'ya29.a0AfH6SMBxxx' + 'A'.repeat(40);
      const input = `Bearer ${token} failed`;
      const output = redactSecrets(input);
      assert.ok(!output.includes(token), 'token must be scrubbed');
      assert.ok(output.includes('[REDACTED]'));
    });

    it('does not match short ya29-shaped strings (false-positive guard)', () => {
      const input = 'ya29.short';
      assert.equal(redactSecrets(input), input);
    });
  });

  describe('SSB session cookies', () => {
    it('redacts pp_session=value in cookie strings', () => {
      const output = redactSecrets('Cookie: pp_session=abc123def456ghi789jkl012; other=ok');
      assert.ok(output.includes('pp_session=[REDACTED]'));
      assert.ok(!output.includes('abc123def456ghi789jkl012'));
      assert.ok(output.includes('other=ok'), 'unrelated values must be preserved');
    });

    it('redacts pp_token=value', () => {
      const output = redactSecrets('Authorization: pp_token=eyJhbGciOi.foo.bar');
      assert.ok(output.includes('pp_token=[REDACTED]'));
    });
  });

  describe('Generic JWTs', () => {
    it('redacts well-formed JWTs (3 base64url segments)', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
        '.' +
        'eyJzdWIiOiIxMjM0NTY3ODkwIn0' +
        '.' +
        'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const input = `Authorization: Bearer ${jwt} failed`;
      const output = redactSecrets(input);
      assert.ok(!output.includes(jwt), 'JWT must be scrubbed');
      assert.ok(output.includes('[REDACTED]'));
    });

    it('does not match arbitrary dot-separated strings', () => {
      const input = 'see version 1.2.3 of the spec';
      assert.equal(redactSecrets(input), input);
    });
  });

  describe('Generic key=value patterns', () => {
    it('redacts apiKey= with long value', () => {
      const output = redactSecrets('config apiKey=sk_test_abcdefghijklmnopqrstuvwxyz123456');
      assert.ok(output.includes('apiKey=' + '[REDACTED]') || output.includes('apiKey=[REDACTED]'));
      assert.ok(!output.includes('sk_test_abcdefghijklmnopqrstuvwxyz123456'));
    });

    it('redacts bearer with long token', () => {
      const output = redactSecrets('bearer ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop');
      assert.ok(!output.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop'));
    });

    it('preserves short values (false-positive guard)', () => {
      const input = 'count=42 name=ok';
      assert.equal(redactSecrets(input), input);
    });
  });

  describe('non-string inputs', () => {
    it('coerces null/undefined to empty string', () => {
      assert.equal(redactSecrets(null), '');
      assert.equal(redactSecrets(undefined), '');
    });

    it('coerces numbers and booleans', () => {
      assert.equal(redactSecrets(42), '42');
      assert.equal(redactSecrets(true), 'true');
    });
  });

  describe('clean input', () => {
    it('returns plain text unchanged', () => {
      const input = 'TypeError: cannot read property foo of undefined at line 42';
      assert.equal(redactSecrets(input), input);
    });
  });

  describe('generic cookie name=value pairs', () => {
    it('redacts a long cookie-shaped value in a Cookie header', () => {
      const output = redactSecrets('Cookie: session_id=abcdefghijklmnopqrstuvwxyz123456; theme=dark');
      assert.ok(!output.includes('abcdefghijklmnopqrstuvwxyz123456'));
      assert.ok(output.includes('session_id=[REDACTED]'));
      assert.ok(output.includes('theme=dark'), 'short value must be preserved');
    });

    it('redacts a JWT-shaped cookie value', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
        '.' +
        'eyJzdWIiOiIxMjM0NTY3ODkwIn0' +
        '.' +
        'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const output = redactSecrets(`Cookie: auth=${jwt}`);
      assert.ok(!output.includes(jwt));
      assert.ok(output.includes('auth=[REDACTED]'));
    });

    it('preserves short query-string-style values', () => {
      const input = 'page=2 limit=10 q=nba';
      assert.equal(redactSecrets(input), input);
    });
  });

  describe('redaction does not crash on weird input', () => {
    it('handles empty string', () => {
      assert.equal(redactSecrets(''), '');
    });

    it('handles string with no matches and special chars', () => {
      const input = '!@#$%^&*()_+-=[]{}|;:,.<>?/`~';
      assert.equal(redactSecrets(input), input);
    });
  });
});
