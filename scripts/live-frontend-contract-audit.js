#!/usr/bin/env node

/**
 * Live frontend contract audit — manual-only, read-only diagnostic.
 *
 * Compares a supplied (--bundle <path>) or deployed (--url <url>) frontend
 * bundle's league/market map against the repo registry
 * (lib/propprofessor-market-registry.js) and runs a fixture-driven deep-link
 * hydration check (missing league / blank selector detection).
 *
 * Safety guarantees:
 *   - Manual only: never invoked by cron, a watcher, or a scheduler. Performs
 *     no polling and installs no recurring timers. Run it when you want it.
 *   - Read-only: makes a single anonymous GET (no credentials, no cookies, no
 *     auth headers) when --url is used, or reads a local JSON file with
 *     --bundle. Never writes to the repo, never logs in.
 *   - Secrets-safe: never reads auth.json / token-cache.json / session files,
 *     never prints cookies, tokens, headers, or response bodies, and redacts
 *     query strings from URLs before reporting them.
 *   - Auth-aware: if the deployed bundle responds 401/403 or with a login
 *     page, the audit reports "requires authentication" and points at a local
 *     --bundle export instead of failing with secrets.
 *
 * Report fields are restricted to safe data: league, market, book, HTTP
 * status, and row counts. See docs/FRONTEND-CONTRACT-AUDIT.md for the bundle
 * and deep-link fixture schemas.
 *
 * Usage:
 *   node scripts/live-frontend-contract-audit.js --bundle path/to/bundle.json
 *   node scripts/live-frontend-contract-audit.js --url https://host/bundle.json
 *   node scripts/live-frontend-contract-audit.js --bundle b.json --deep-links d.json
 *   node scripts/live-frontend-contract-audit.js --help
 *
 * Exit codes: 0 no findings, 1 findings (drift / hydration / auth wall),
 * 2 usage or I/O error.
 */

'use strict';

const fs = require('node:fs');

const { MARKET_REGISTRY, getMarketsForSport } = require('../lib/propprofessor-market-registry');

const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;

const FETCH_TIMEOUT_MS = 10000;
const AUTH_STATUS_CODES = new Set([401, 403]);

// HTML markers that indicate a login wall when the deployed bundle responds
// with an HTML page instead of a JSON bundle. The body is never printed —
// these only decide whether the audit reports "requires authentication".
const LOGIN_PAGE_MARKERS = [
  /\bsign\s*in\b/i,
  /\blog\s*in\b/i,
  /\bpassword\b/i,
  /\bauthenticate\b/i,
  /\bsession expired\b/i
];

// Safety guard: report fields must never carry secret-bearing keys. The test
// suite asserts JSON.stringify(report) never matches this.
const FORBIDDEN_REPORT_KEYS = /cookie|token|password|secret|jwt|session|authorization/i;

class CliError extends Error {}

function normalizeLeagueName(name) {
  return String(name || '')
    .trim()
    .toUpperCase();
}

function normalizeMarketName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// Strip query/fragment so URLs with token-ish parameters are never echoed.
function redactUrl(url) {
  const cleaned = String(url || '').split(/[?#]/)[0];
  return cleaned || '<redacted>';
}

function parseArgs(argv) {
  const options = { bundlePath: null, url: null, deepLinksPath: null, help: false };
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    switch (flag) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--bundle': {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new CliError('--bundle requires a file path');
        options.bundlePath = value;
        break;
      }
      case '--url': {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new CliError('--url requires a URL');
        options.url = value;
        break;
      }
      case '--deep-links': {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new CliError('--deep-links requires a file path');
        options.deepLinksPath = value;
        break;
      }
      default:
        throw new CliError(`unknown flag: ${flag}`);
    }
  }
  return options;
}

/**
 * Normalize a frontend bundle into { LEAGUE_KEY: { original, markets,
 * marketKeys, books } }. League keys are uppercased, market keys lowercased,
 * so comparison against the registry is case-insensitive.
 * @param {Object} bundle - Bundle JSON (see docs/FRONTEND-CONTRACT-AUDIT.md).
 * @returns {Object} Normalized league map.
 */
function extractLeagueMap(bundle) {
  const map = {};
  if (!bundle || !Array.isArray(bundle.leagues)) return map;
  for (const entry of bundle.leagues) {
    const key = normalizeLeagueName(entry && entry.league);
    if (!key) continue;
    const rawMarkets = Array.isArray(entry.markets) ? entry.markets.map(String) : [];
    const rawBooks = Array.isArray(entry.books) ? entry.books.map(String) : [];
    map[key] = {
      original: String(entry.league),
      markets: rawMarkets.filter((m) => m && m.trim()),
      marketKeys: rawMarkets.map(normalizeMarketName).filter(Boolean),
      books: rawBooks.filter((b) => b && b.trim())
    };
  }
  return map;
}

function summarizeRows(rows) {
  const counts = { total: rows.length };
  for (const row of rows) {
    const status = row.status || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }
  counts.clean = (counts.matched || 0) + (counts.ok || 0);
  counts.findings = counts.total - counts.clean;
  return counts;
}

/**
 * Compare a frontend league map against the repo registry. Emits safe rows
 * only: league, market, book, status. Registry leagues missing from the
 * frontend surface as `missing-league` (e.g. a deployed bundle that has not
 * shipped the recently added MLS entry); frontend leagues unknown to the
 * registry surface as `unknown-league`; market-level drift per book surfaces
 * as `missing` / `extra`.
 * @param {Object} frontendMap - Normalized map from extractLeagueMap().
 * @param {Object} [registry] - Registry source of truth (defaults to MARKET_REGISTRY).
 * @returns {{ rows: Array, counts: Object, issues: Array }}
 */
function compareLeagueMarketMap(frontendMap, registry = MARKET_REGISTRY) {
  const rows = [];
  const issues = [];
  // Registry keys are mixed-case ("Soccer", "MLS"); map normalized keys back
  // to their original spelling for case-insensitive membership checks.
  const registryKeyByNormalized = new Map();
  for (const key of Object.keys(registry)) registryKeyByNormalized.set(normalizeLeagueName(key), key);
  const registryKeys = [...registryKeyByNormalized.keys()];

  for (const key of registryKeys) {
    if (frontendMap[key]) continue;
    const display = registryKeyByNormalized.get(key);
    rows.push({ league: display, market: null, book: null, status: 'missing-league' });
    issues.push({
      type: 'missing-league',
      league: display,
      message: `frontend bundle does not expose league "${display}" that the repo registry defines`
    });
  }

  for (const key of Object.keys(frontendMap)) {
    const entry = frontendMap[key];
    const registryKey = registryKeyByNormalized.get(key);
    if (!registryKey) {
      rows.push({ league: entry.original, market: null, book: null, status: 'unknown-league' });
      issues.push({
        type: 'unknown-league',
        league: entry.original,
        message: `frontend exposes league "${entry.original}" that the repo registry does not define`
      });
      continue;
    }
    rows.push({ league: entry.original, market: null, book: null, status: 'matched' });

    const books = entry.books.length > 0 ? entry.books : ['default'];
    for (const book of books) {
      const expectedMarkets = getMarketsForSport(registryKey, book);
      for (const canonical of expectedMarkets) {
        if (entry.marketKeys.includes(normalizeMarketName(canonical))) {
          rows.push({ league: entry.original, market: canonical, book, status: 'matched' });
        } else {
          rows.push({ league: entry.original, market: canonical, book, status: 'missing' });
          issues.push({
            type: 'missing-market',
            league: entry.original,
            market: canonical,
            book,
            message: `frontend league "${entry.original}" is missing market "${canonical}" for book "${book}"`
          });
        }
      }
      const expectedKeys = new Set(expectedMarkets.map(normalizeMarketName));
      for (const original of entry.markets) {
        if (!expectedKeys.has(normalizeMarketName(original))) {
          rows.push({ league: entry.original, market: original, book, status: 'extra' });
          issues.push({
            type: 'extra-market',
            league: entry.original,
            market: original,
            book,
            message: `frontend league "${entry.original}" exposes market "${original}" for book "${book}" that the registry does not define`
          });
        }
      }
    }
  }

  return { rows, counts: summarizeRows(rows), issues };
}

/**
 * Deep-link hydration check — pure fixture-driven abstraction. Given a list
 * of deep links and the frontend league map, reports:
 *   - missing-league: the deep link expects a league the bundle does not expose
 *     (e.g. /leagues/mls when MLS is absent from the deployed bundle);
 *   - blank-selector: the market selector rendered but hydrated with 0 options;
 *   - absent-selector: the market selector never rendered.
 * @param {Object} fixture - { deepLinks: [...], leagueMap: {...} }.
 * @returns {{ rows: Array, counts: Object, issues: Array }}
 */
function checkDeepLinkHydration(fixture) {
  const rows = [];
  const issues = [];
  const deepLinks = fixture && Array.isArray(fixture.deepLinks) ? fixture.deepLinks : [];
  const leagueMap = (fixture && fixture.leagueMap) || {};

  for (const link of deepLinks) {
    const leagueKey = normalizeLeagueName(link.expectedLeague);
    const pathText = String(link.path || '');
    const leagueKnown = Boolean(leagueKey && leagueMap[leagueKey]);
    const selectorPresent = Boolean(link.selectorPresent);
    const selectorOptions = Number(link.selectorOptions) || 0;

    let status;
    if (!leagueKnown) status = 'missing-league';
    else if (!selectorPresent) status = 'absent-selector';
    else if (selectorOptions === 0) status = 'blank-selector';
    else status = 'ok';

    rows.push({
      path: pathText,
      league: leagueKey || String(link.expectedLeague || ''),
      marketSelector: selectorPresent ? (selectorOptions === 0 ? 'blank' : 'hydrated') : 'absent',
      status
    });

    if (status !== 'ok') {
      const detail =
        status === 'missing-league'
          ? `deep link "${pathText}" expects league ${leagueKey} but the frontend bundle does not expose it`
          : status === 'blank-selector'
            ? `deep link "${pathText}" rendered a market selector with 0 options — hydration is blank`
            : `deep link "${pathText}" did not render its market selector`;
      issues.push({ type: status, league: leagueKey, path: pathText, message: detail });
    }
  }

  return { rows, counts: summarizeRows(rows), issues };
}

function loadJsonFile(filePath, what) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new CliError(`cannot read ${what} file "${filePath}"`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError(`${what} file "${filePath}" is not valid JSON`);
  }
}

function loadBundleFromFile(bundlePath) {
  return loadJsonFile(bundlePath, 'bundle');
}

function loadDeepLinksFromFile(deepLinksPath) {
  return loadJsonFile(deepLinksPath, 'deep-links');
}

async function defaultFetcher(url) {
  return fetch(url, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
}

/**
 * Anonymous fetch of a deployed bundle. Network is fully mockable: tests pass
 * an injected fetcher returning { ok, status, text }.
 * @param {string} url
 * @param {Function} [fetcher]
 * @returns {Promise<{ ok: boolean, httpStatus: number|null, body: string, fetchError: string|null }>}
 */
async function fetchBundle(url, fetcher = defaultFetcher) {
  try {
    const response = await fetcher(url);
    const httpStatus = response && typeof response.status === 'number' ? response.status : null;
    const ok = Boolean(response && response.ok);
    const body = response && typeof response.text === 'function' ? await response.text() : '';
    return { ok, httpStatus, body, fetchError: null };
  } catch (error) {
    return { ok: false, httpStatus: null, body: '', fetchError: String((error && error.message) || error) };
  }
}

/**
 * Detect an auth wall from an anonymous fetch result. Never prints the body.
 * @param {{ httpStatus: number|null, body: string }} result
 * @returns {{ authBlocked: boolean, authReason: string|null }}
 */
function classifyResponse({ httpStatus, body }) {
  if (AUTH_STATUS_CODES.has(httpStatus)) {
    return { authBlocked: true, authReason: `deployed frontend requires authentication (HTTP ${httpStatus})` };
  }
  const text = typeof body === 'string' ? body.slice(0, 8000) : '';
  if (text && !text.trim().startsWith('{') && LOGIN_PAGE_MARKERS.some((re) => re.test(text))) {
    return { authBlocked: true, authReason: 'deployed frontend returned a login page instead of a JSON bundle' };
  }
  return { authBlocked: false, authReason: null };
}

function parseBundleBody(body, sourceLabel) {
  try {
    return JSON.parse(body);
  } catch {
    throw new CliError(`"${sourceLabel}" did not return a parseable JSON bundle`);
  }
}

function buildSummary(report) {
  const issues = [];
  let totalRows = 0;
  let findingRows = 0;
  for (const check of Object.values(report.checks)) {
    if (!check || check.skipped) continue;
    totalRows += check.counts.total;
    findingRows += check.counts.findings || 0;
    for (const issue of check.issues || []) issues.push(issue);
  }
  if (report.authRequired) {
    issues.push({
      type: 'auth-required',
      message: `${report.authReason} — export a local bundle and audit it with --bundle <path>`
    });
  }
  return {
    issues,
    issueCount: issues.length,
    rowCount: totalRows,
    findingRowCount: findingRows,
    ok: issues.length === 0
  };
}

/**
 * Run the full audit. Offline by default: --bundle reads a local file and
 * performs no network I/O; --url makes exactly one anonymous fetch (injectable
 * via `fetcher` for tests). Report carries safe fields only.
 * @param {Object} [options]
 * @param {string} [options.bundlePath]
 * @param {string} [options.url]
 * @param {string} [options.deepLinksPath]
 * @param {Function} [options.fetcher]
 * @returns {Promise<Object>} Audit report.
 */
async function auditFrontendContract(options = {}) {
  const { bundlePath, url, deepLinksPath, fetcher } = options;
  if (bundlePath && url) throw new CliError('provide only one of --bundle or --url');
  if (!bundlePath && !url) throw new CliError('provide --bundle <path> or --url <url> (see --help)');

  const report = {
    tool: 'live-frontend-contract-audit',
    mode: 'manual',
    readOnly: true,
    authRequired: false,
    authReason: null,
    httpStatus: null,
    source: null,
    sourceUrl: null,
    fetchedAt: null,
    checks: {},
    summary: null
  };

  const deepLinks = deepLinksPath ? loadDeepLinksFromFile(deepLinksPath).deepLinks : [];
  let leagueMap = {};

  if (bundlePath) {
    report.source = `file:${bundlePath}`;
    leagueMap = extractLeagueMap(loadBundleFromFile(bundlePath));
  } else {
    report.sourceUrl = redactUrl(url);
    report.fetchedAt = new Date().toISOString();
    const fetched = await fetchBundle(url, fetcher);
    report.httpStatus = fetched.httpStatus;
    const auth = classifyResponse(fetched);
    if (auth.authBlocked) {
      report.authRequired = true;
      report.authReason = auth.authReason;
      const reason =
        'deployed frontend requires authentication — export a local bundle and audit it with --bundle <path>';
      report.checks.leagueMarket = { skipped: true, reason };
      report.checks.deepLinkHydration = { skipped: true, reason };
    } else if (!fetched.ok) {
      throw new CliError(
        'could not fetch the deployed frontend bundle (network error); retry or audit a local export with --bundle <path>'
      );
    } else {
      leagueMap = extractLeagueMap(parseBundleBody(fetched.body, redactUrl(url)));
    }
  }

  if (!report.checks.leagueMarket) {
    report.checks.leagueMarket = compareLeagueMarketMap(leagueMap);
  }

  if (!report.checks.deepLinkHydration) {
    report.checks.deepLinkHydration =
      deepLinks.length > 0
        ? checkDeepLinkHydration({ deepLinks, leagueMap })
        : { skipped: true, reason: 'no --deep-links fixture provided' };
  }

  report.summary = buildSummary(report);
  return report;
}

function printUsage() {
  console.log(`Usage:
  node scripts/live-frontend-contract-audit.js --bundle <path> [--deep-links <path>]
  node scripts/live-frontend-contract-audit.js --url <url> [--deep-links <path>]

Manual-only, read-only frontend contract audit. Compares a frontend bundle's
league/market map against the repo registry and runs a fixture-driven
deep-link hydration check (missing league / blank selector).

  --bundle <path>      Local JSON bundle snapshot (offline; no network).
  --url <url>          Deployed bundle URL (one anonymous GET; no auth).
  --deep-links <path>  JSON fixture of deep links to hydration-check.
  --help               Show this help.

Never polls, never schedules, never authenticates, never prints secrets.
See docs/FRONTEND-CONTRACT-AUDIT.md for schemas and exit codes.`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv);
  } catch (error) {
    printUsage();
    console.error(`\n${error.message}`);
    process.exit(EXIT_USAGE);
  }

  if (options.help) {
    printUsage();
    process.exit(EXIT_OK);
  }
  if (!options.bundlePath && !options.url) {
    printUsage();
    console.error(
      '\nProvide --bundle <path> or --url <url>. This audit is manual-only; it never polls, schedules, or authenticates.'
    );
    process.exit(EXIT_USAGE);
  }

  try {
    const report = await auditFrontendContract(options);
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.summary.ok ? EXIT_OK : EXIT_FINDINGS);
  } catch (error) {
    console.error(error.message);
    process.exit(EXIT_USAGE);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(EXIT_USAGE);
  });
}

module.exports = {
  parseArgs,
  redactUrl,
  extractLeagueMap,
  compareLeagueMarketMap,
  checkDeepLinkHydration,
  summarizeRows,
  fetchBundle,
  classifyResponse,
  parseBundleBody,
  auditFrontendContract,
  CliError,
  FORBIDDEN_REPORT_KEYS,
  EXIT_OK,
  EXIT_FINDINGS,
  EXIT_USAGE
};
