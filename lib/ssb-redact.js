// @ts-check
'use strict';

/**
 * Redact known credential shapes from text so they can be safely written to
 * server logs (stderr → journald / Docker / log aggregators). This is a
 * belt-and-suspenders measure alongside the server-side `debug` flag: even
 * when the *agent* doesn't request stack traces, the server still needs to
 * log them for operators, and we never want a real cookie / token / JWT
 * ending up in a log file that may be shipped to a third party.
 *
 * Recognized patterns (intentionally conservative — false positives are
 * fine, false negatives are not):
 *   - Google OAuth / ID tokens: `ya29.<base64url>`
 *   - SSB session cookies: `pp_session=<value>` / `pp_token=<value>`
 *   - Generic JWTs: `<header>.<payload>.<signature>` (3 base64url segments
 *     separated by dots, header is a JWS-header shape)
 *   - Long random-looking strings following `token=`, `apiKey=`, `key=`,
 *     `secret=`, `bearer ` (case-insensitive)
 *
 * Usage:
 *   const safe = redactSecrets(error.stack || error.message);
 *   process.stderr.write(`[ssb-for-agents] ${safe}\n`);
 *
 * The function is pure and safe to call on any string. Returns the input
 * with all matches replaced by `[REDACTED]`.
 */

// Google OAuth access / ID tokens: ya29. followed by 30+ base64url chars.
const GOOGLE_OAUTH_RE = /ya29\.[A-Za-z0-9_-]{20,}/g;

// SSB session cookies and similar session=<value> shapes.
const PP_SESSION_RE = /\b(pp_session|pp_token|pp_auth|ssb_session)=([^\s;]+)/gi;

// JWT shape: three base64url segments separated by dots. Headers start with
// `eyJ` and the regex requires a minimum plausible length for each segment
// so we don't redact trivial strings like "a.b.c".
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

// Generic key/value patterns. We require the value to look like a token
// (long, mostly base64url-ish) so we don't redact code or sentence prose.
const KV_TOKEN_RE =
  /\b(token|api_?key|access_?token|session|bearer|secret)(["']?\s*[:=]\s*["']?)([A-Za-z0-9_=+\-./]{16,})/gi;
// Bearer-prefixed tokens: `bearer <token>` with no separator (HTTP convention).
const BEARER_PREFIX_RE = /\b(bearer)\s+([A-Za-z0-9_=+\-./]{16,})/gi;
// Generic HTTP cookie pairs: only matches short alphanumeric keys (the
// common cookie-name convention), value looks like a real token (>=16 chars,
// no spaces). Deliberately conservative — `name=value` in URLs with short
// values (path segments, query flags) won't match.
const GENERIC_COOKIE_RE =
  /\b([a-z][a-z0-9_-]{1,40})=(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9_=+\-./-]{20,})(;|\s|$)/gi;

function replaceAll(str, re, replacement) {
  return str.replace(re, replacement);
}

/**
 * Redact all recognized credential patterns from a string.
 * @param {string} input - The text to scrub. Non-strings are coerced.
 * @returns {string} The redacted text. Safe to write to logs.
 */
function redactSecrets(input) {
  if (input == null) return '';
  const str = typeof input === 'string' ? input : String(input);
  let out = str;
  out = replaceAll(out, GOOGLE_OAUTH_RE, '[REDACTED]');
  out = replaceAll(out, PP_SESSION_RE, '$1=[REDACTED]');
  out = replaceAll(out, JWT_RE, '[REDACTED]');
  out = replaceAll(out, BEARER_PREFIX_RE, (_match, key, _value) => `${key} [REDACTED]`);
  out = replaceAll(out, KV_TOKEN_RE, (_match, key, sep, _value) => {
    return `${key}${sep}[REDACTED]`;
  });
  out = replaceAll(out, GENERIC_COOKIE_RE, '$1=[REDACTED]$3');
  return out;
}

module.exports = { redactSecrets };
