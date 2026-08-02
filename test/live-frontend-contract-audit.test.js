'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseArgs,
  redactUrl,
  extractLeagueMap,
  compareLeagueMarketMap,
  checkDeepLinkHydration,
  fetchBundle,
  classifyResponse,
  parseBundleBody,
  auditFrontendContract,
  CliError,
  FORBIDDEN_REPORT_KEYS,
  EXIT_FINDINGS
} = require('../scripts/live-frontend-contract-audit');

const FIXTURES = path.join(__dirname, 'fixtures', 'frontend-contract');
const healthyBundle = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'bundle.json'), 'utf8'));
const mlsMissingBundle = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'bundle-mls-missing.json'), 'utf8'));
const deepLinksFixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'deep-links.json'), 'utf8'));

function jsonOkFetcher(body, status = 200) {
  return async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
}

describe('parseArgs', () => {
  it('defaults to no inputs (no network, nothing scheduled)', () => {
    const options = parseArgs(['node', 'audit']);
    assert.deepEqual(options, { bundlePath: null, url: null, deepLinksPath: null, help: false });
  });

  it('parses --bundle / --url / --deep-links', () => {
    const options = parseArgs([
      'node',
      'audit',
      '--bundle',
      'b.json',
      '--deep-links',
      'd.json',
      '--url',
      'https://host/bundle.json'
    ]);
    assert.equal(options.bundlePath, 'b.json');
    assert.equal(options.url, 'https://host/bundle.json');
    assert.equal(options.deepLinksPath, 'd.json');
    assert.equal(options.help, false);
  });

  it('--help is a no-network flag', () => {
    assert.equal(parseArgs(['node', 'audit', '--help']).help, true);
  });

  it('rejects unknown flags and flag args missing a value', () => {
    assert.throws(() => parseArgs(['node', 'audit', '--watcher']), /unknown flag/);
    assert.throws(() => parseArgs(['node', 'audit', '--bundle']), /requires a file path/);
    assert.throws(() => parseArgs(['node', 'audit', '--url']), /requires a URL/);
  });
});

describe('redactUrl', () => {
  it('strips query strings and fragments so token-ish params are never echoed', () => {
    assert.equal(redactUrl('https://host/bundle.json?session=abc123'), 'https://host/bundle.json');
    assert.equal(redactUrl('https://host/bundle.json#frag'), 'https://host/bundle.json');
  });
});

describe('extractLeagueMap (fixture-driven)', () => {
  it('normalizes league keys to uppercase and markets to lowercase keys', () => {
    const map = extractLeagueMap(healthyBundle);
    assert.ok(map.MLS, 'MLS present in the healthy bundle fixture');
    assert.ok(map.SOCCER);
    assert.ok(map.TENNIS, 'lowercase "tennis" fixture entry normalizes to TENNIS');
    assert.deepEqual(map.MLS.marketKeys, ['draw no bet', 'match handicap', 'total goals']);
    assert.deepEqual(map.MLS.books, ['NoVigApp', 'Fliff']);
  });

  it('treats malformed input as an empty map instead of crashing', () => {
    assert.deepEqual(extractLeagueMap(null), {});
    assert.deepEqual(extractLeagueMap({}), {});
  });
});

describe('compareLeagueMarketMap (fixture-driven)', () => {
  it('healthy bundle fixture satisfies the full registry contract', () => {
    const result = compareLeagueMarketMap(extractLeagueMap(healthyBundle));
    assert.equal(result.issues.length, 0);
    assert.equal(result.counts.findings, 0);
    assert.equal(result.counts['missing-league'], undefined);
    assert.ok(result.counts.matched > 40, `expected >40 matched rows, got ${result.counts.matched}`);
    assert.ok(
      result.rows.some(
        (row) =>
          row.league === 'MLS' && row.market === 'Draw No Bet' && row.book === 'NoVigApp' && row.status === 'matched'
      ),
      'MLS book-specific market row is matched'
    );
    assert.ok(
      result.rows.some((row) => row.league === 'tennis' && row.market === 'Moneyline' && row.status === 'matched'),
      'case-normalized tennis fixture entry resolves against the registry (display keeps bundle spelling)'
    );
  });

  it('mls-missing fixture reports the missing MLS league plus drift rows', () => {
    const result = compareLeagueMarketMap(extractLeagueMap(mlsMissingBundle));
    assert.ok(
      result.rows.some((row) => row.league === 'MLS' && row.status === 'missing-league'),
      'MLS surfaced as missing from the frontend bundle'
    );
    assert.ok(result.issues.some((issue) => issue.type === 'missing-league' && issue.league === 'MLS'));
    assert.ok(
      result.rows.some((row) => row.league === 'Cricket' && row.status === 'unknown-league'),
      'league the registry does not define surfaces as unknown-league'
    );
    assert.ok(
      result.rows.some((row) => row.league === 'NBA' && row.market === 'Player Points' && row.status === 'extra'),
      'frontend-only market surfaces as extra'
    );
    assert.ok(result.counts.findings > 0);
  });

  it('rows carry safe fields only', () => {
    const result = compareLeagueMarketMap(extractLeagueMap(mlsMissingBundle));
    for (const row of result.rows) {
      assert.deepEqual(Object.keys(row).sort(), ['book', 'league', 'market', 'status']);
    }
  });
});

describe('checkDeepLinkHydration (fixture-driven)', () => {
  it('reports hydrated, blank-selector, and absent-selector deep links', () => {
    const map = extractLeagueMap(healthyBundle);
    const result = checkDeepLinkHydration({ deepLinks: deepLinksFixture.deepLinks, leagueMap: map });
    assert.equal(result.rows.length, 3);
    assert.deepEqual(
      result.rows.map((row) => row.status),
      ['ok', 'blank-selector', 'absent-selector']
    );
    assert.deepEqual(
      result.rows.map((row) => row.marketSelector),
      ['hydrated', 'blank', 'absent']
    );
    assert.equal(result.rows[0].path, '/leagues/mls');
    assert.equal(result.counts.findings, 2);
  });

  it('reports missing MLS deep links when the bundle omits MLS', () => {
    const map = extractLeagueMap(mlsMissingBundle);
    const links = [
      ...deepLinksFixture.deepLinks,
      { path: '/leagues/nba', expectedLeague: 'NBA', selectorPresent: false, selectorOptions: 0 }
    ];
    const result = checkDeepLinkHydration({ deepLinks: links, leagueMap: map });
    assert.deepEqual(
      result.rows.map((row) => row.status),
      ['missing-league', 'missing-league', 'missing-league', 'absent-selector']
    );
    assert.ok(
      result.issues.some(
        (issue) => issue.type === 'missing-league' && issue.league === 'MLS' && /\/leagues\/mls/.test(issue.path)
      )
    );
  });

  it('hydrated rows carry safe fields only', () => {
    const result = checkDeepLinkHydration({
      deepLinks: deepLinksFixture.deepLinks,
      leagueMap: extractLeagueMap(healthyBundle)
    });
    for (const row of result.rows) {
      assert.deepEqual(Object.keys(row).sort(), ['league', 'marketSelector', 'path', 'status']);
    }
  });
});

describe('fetchBundle (network optional + mockable)', () => {
  it('returns HTTP status and body from an injected fetcher', async () => {
    const body = JSON.stringify(healthyBundle);
    const result = await fetchBundle('https://host/bundle.json', jsonOkFetcher(body));
    assert.equal(result.ok, true);
    assert.equal(result.httpStatus, 200);
    assert.equal(JSON.parse(result.body).source, healthyBundle.source);
  });

  it('surfaces an auth-wall status without throwing', async () => {
    const result = await fetchBundle('https://host/bundle.json', jsonOkFetcher('', 401));
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 401);
  });

  it('turns network failures into a clean result, never a crash', async () => {
    const result = await fetchBundle('https://host/bundle.json', async () => {
      throw new Error('ECONNREFUSED');
    });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, null);
    assert.match(result.fetchError, /ECONNREFUSED/);
  });
});

describe('classifyResponse', () => {
  it('flags 401/403 as an auth wall', () => {
    assert.equal(classifyResponse({ httpStatus: 401, body: '' }).authBlocked, true);
    assert.equal(classifyResponse({ httpStatus: 403, body: '' }).authBlocked, true);
  });

  it('flags an HTML login page instead of a JSON bundle', () => {
    const loginHtml = '<html><body><form>Sign in to continue</form></body></html>';
    assert.equal(classifyResponse({ httpStatus: 200, body: loginHtml }).authBlocked, true);
  });

  it('passes through JSON bundles', () => {
    assert.equal(classifyResponse({ httpStatus: 200, body: JSON.stringify(healthyBundle) }).authBlocked, false);
  });
});

describe('parseBundleBody', () => {
  it('parses valid JSON and rejects anything else with a clean error', () => {
    assert.equal(parseBundleBody(JSON.stringify({ a: 1 }), 'source').a, 1);
    assert.throws(() => parseBundleBody('<html>login</html>', 'source'), CliError);
  });
});

describe('auditFrontendContract (end-to-end, offline by default)', () => {
  it('healthy local bundle passes with no findings', async () => {
    const report = await auditFrontendContract({ bundlePath: path.join(FIXTURES, 'bundle.json') });
    assert.equal(report.mode, 'manual');
    assert.equal(report.readOnly, true);
    assert.equal(report.authRequired, false);
    assert.equal(report.httpStatus, null);
    assert.equal(report.summary.ok, true);
    assert.equal(report.summary.issueCount, 0);
    assert.ok(report.checks.leagueMarket.rows.length > 0);
    assert.equal(report.checks.deepLinkHydration.skipped, true);
  });

  it('deep-links fixture surfaces blank-selector hydration end-to-end', async () => {
    const report = await auditFrontendContract({
      bundlePath: path.join(FIXTURES, 'bundle.json'),
      deepLinksPath: path.join(FIXTURES, 'deep-links.json')
    });
    assert.equal(report.summary.ok, false);
    assert.equal(report.summary.issueCount, 2);
    assert.ok(report.summary.issues.some((issue) => issue.type === 'blank-selector' && issue.league === 'MLS'));
    assert.ok(report.summary.issues.some((issue) => issue.type === 'absent-selector' && issue.league === 'UFC'));
    assert.equal(report.checks.deepLinkHydration.rows.length, 3);
  });

  it('mls-missing bundle yields findings', async () => {
    const report = await auditFrontendContract({ bundlePath: path.join(FIXTURES, 'bundle-mls-missing.json') });
    assert.equal(report.summary.ok, false);
    assert.ok(report.summary.issues.some((issue) => issue.type === 'missing-league' && issue.league === 'MLS'));
  });

  it('deployed bundle via injected fetcher reports HTTP status', async () => {
    const report = await auditFrontendContract({
      url: 'https://host/bundle.json',
      fetcher: jsonOkFetcher(JSON.stringify(healthyBundle))
    });
    assert.equal(report.httpStatus, 200);
    assert.equal(report.authRequired, false);
    assert.equal(report.summary.ok, true);
  });

  it('auth-walled deployed bundle reports cleanly and suggests --bundle', async () => {
    const report = await auditFrontendContract({
      url: 'https://host/bundle.json?session=abc123',
      fetcher: jsonOkFetcher('', 401)
    });
    assert.equal(report.authRequired, true);
    assert.match(report.authReason, /401/);
    assert.equal(report.checks.leagueMarket.skipped, true);
    assert.equal(report.summary.ok, false);
    assert.ok(report.summary.issues.some((issue) => issue.type === 'auth-required'));
    assert.match(JSON.stringify(report.summary.issues), /--bundle/);
    assert.equal(report.sourceUrl, 'https://host/bundle.json', 'query string redacted from the report');
  });

  it('network failure raises a clean operator error, not secrets', async () => {
    await assert.rejects(
      auditFrontendContract({
        url: 'https://host/bundle.json',
        fetcher: async () => {
          throw new Error('ECONNREFUSED');
        }
      }),
      (error) => error instanceof CliError && /--bundle/.test(error.message)
    );
  });

  it('requires a bundle or url and rejects both', async () => {
    await assert.rejects(auditFrontendContract({}), CliError);
    await assert.rejects(
      auditFrontendContract({
        bundlePath: path.join(FIXTURES, 'bundle.json'),
        url: 'https://host/bundle.json',
        fetcher: jsonOkFetcher('{}')
      }),
      CliError
    );
  });
});

describe('report safety', () => {
  it('the serialized report never carries secret-bearing keys', async () => {
    const report = await auditFrontendContract({
      bundlePath: path.join(FIXTURES, 'bundle-mls-missing.json'),
      deepLinksPath: path.join(FIXTURES, 'deep-links.json')
    });
    assert.doesNotMatch(JSON.stringify(report), FORBIDDEN_REPORT_KEYS);
  });

  it('findings exit code is nonzero and stable', () => {
    assert.equal(EXIT_FINDINGS, 1);
  });
});
