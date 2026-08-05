#!/usr/bin/env node
'use strict';

/**
 * PropProfessor Token Watchdog — MANUAL ESCAPE HATCH
 *
 * As of v2.1.5 the PropProfessor MCP self-heals automatically: when the
 * server-to-server access-token fetch hits Vercel's TLS-fingerprint
 * challenge (HTTP 429), the MCP falls back to a Chrome DevTools Protocol
 * fetch from a logged-in browser tab. No external schedule is required.
 *
 * This script is preserved as a manual escape hatch. Run it on demand if
 * you want to force a fresh token outside of a normal request:
 *
 *   node scripts/pp-token-watchdog.js          # silent if token is fresh
 *   node scripts/pp-token-watchdog.js --force  # always refresh
 *
 * This script is manual-only: no cron, scheduled workflow, or unattended
 * schedule drives it. PropProfessor is manual-only — run it when you want
 * a forced refresh, not on a timer.
 *
 * Why it still exists:
 * - Manual diagnostics: confirm the CDP path works without going through
 *   a tool call (useful when verifying the self-heal end-to-end).
 * - Bulk token priming: warm the cache ahead of a heavy tool-call session
 *   so the first request doesn't pay the ~1-2s CDP penalty.
 *
 * Why this is no longer needed for production use:
 * - The MCP's server-to-server access-token fetch is 429'd by Vercel
 *   (TLS-fingerprint gating — see propprofessor-mcp/references/
 *   vercel-access-token-block.md).
 * - The self-heal in lib/propprofessor-auth.js does this exact CDP fetch
 *   on demand, with a got-scraping primary path so the common case is
 *   still fast.
 *
 * Exit codes:
 *   0 — healthy (token fresh, no action needed) OR self-heal succeeded
 *   1 — fix attempted but failed (operator should look)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const TOKEN_CACHE = path.join(HOME, '.propprofessor', 'token-cache.json');
const DEFAULT_CDP_VERSION_URL = 'http://127.0.0.1:9222/json/version';
const DEFAULT_CHROME_TABS_URL = 'http://127.0.0.1:9222/json/list';
const ACCESS_TOKEN_URL = 'https://app.propprofessor.com/api/access-token';
const FRESH_THRESHOLD_SEC = 120; // refresh if < 2 min left
const FORCE = process.argv.includes('--force');

// Resolve the CDP endpoints, honoring the same PROPPROFESSOR_CDP_VERSION_URL
// env var used by lib/propprofessor-auth.js. When set, the /json/list URL is
// derived from the configured version endpoint so this script never retains a
// separate hardcoded port. Falls back to the historical 9222 defaults.
function resolveCdpEndpoints() {
  const envUrl = String(process.env.PROPPROFESSOR_CDP_VERSION_URL || '').trim();
  if (!envUrl) return { versionUrl: DEFAULT_CDP_VERSION_URL, tabsUrl: DEFAULT_CHROME_TABS_URL };
  const base = envUrl.replace(/\/json\/version$/, '');
  return { versionUrl: envUrl, tabsUrl: `${base}/json/list` };
}

const CDP = resolveCdpEndpoints();
const CHROME_TABS_URL = CDP.tabsUrl;

function log(msg) {
  process.stderr.write(`[pp-token-watchdog] ${msg}\n`);
}

function isFresh(cache) {
  if (!cache || !cache.exp) return false;
  const now = Math.floor(Date.now() / 1000);
  return cache.exp - now > FRESH_THRESHOLD_SEC;
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(token, exp, perm) {
  const cache = {
    token,
    exp,
    perm: perm || { sportsbook: true, fantasy: true },
    cachedAt: Date.now()
  };
  fs.writeFileSync(TOKEN_CACHE, JSON.stringify(cache, null, 2));
  fs.chmodSync(TOKEN_CACHE, 0o600); // SEC-003
  return cache;
}

function findPropProfessorTabSync() {
  // Hit the /json/list endpoint synchronously to discover tabs. Returns
  // null if Chrome is not reachable. We pick the first tab whose URL
  // contains "propprofessor" — that's the logged-in one.
  try {
    const out = execFileSync('curl', ['-sS', '--max-time', '3', CHROME_TABS_URL], { encoding: 'utf8' });
    const tabs = JSON.parse(out);
    return tabs.find((t) => t.type === 'page' && (t.url || '').includes('app.propprofessor.com')) || null;
  } catch {
    return null;
  }
}

async function fetchTokenViaBrowser() {
  // Browser-context fetch via Chrome DevTools Protocol (CDP).
  // This is the path that solves Vercel's TLS-fingerprint challenge.
  // Node 22+ has built-in WebSocket; no 'ws' package needed.
  const versionRes = await fetch(CDP.versionUrl);
  const { webSocketDebuggerUrl } = await versionRes.json();

  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let id = 0;
  const send = (method, params, sid) =>
    new Promise((resolve, reject) => {
      const reqId = ++id;
      const msg = { id: reqId, method, params: params || {} };
      if (sid) msg.sessionId = sid;
      ws.send(JSON.stringify(msg));
      function onMsg(raw) {
        const r = JSON.parse(typeof raw === 'string' ? raw : raw.data);
        if (r.id === reqId) {
          ws.removeEventListener('message', onMsg);
          if (r.error) return reject(new Error(JSON.stringify(r.error)));
          resolve(r.result || {});
        }
      }
      ws.addEventListener('message', onMsg);
    });

  try {
    const targets = await send('Target.getTargets');
    let tab = (targets.targetInfos || []).find(
      (t) => t.type === 'page' && (t.url || '').includes('app.propprofessor.com')
    );
    let tid = tab && tab.targetId;
    if (!tid) {
      const created = await send('Target.createTarget', { url: 'https://app.propprofessor.com/' });
      tid = created.targetId;
    }

    const sess = await send('Target.attachToTarget', { targetId: tid, flatten: true });
    const sid = sess.sessionId;

    // GET, not POST — POST returns 405.
    const result = await send(
      'Runtime.evaluate',
      {
        expression: `fetch('${ACCESS_TOKEN_URL}', {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      }).then(r => r.json()).then(j => JSON.stringify(j))
        .catch(e => JSON.stringify({ error: String(e && e.message || e) }))`,
        awaitPromise: true,
        returnByValue: true
      },
      sid
    );

    const raw = (result.result || {}).value || '{}';
    const body = JSON.parse(raw);
    if (body.error) throw new Error(body.error);
    if (!body.token) throw new Error('no token in response');
    return body;
  } finally {
    try {
      ws.close();
    } catch {
      /* best effort */
    }
  }
}

function findHermesGatewayPid() {
  // The Hermes gateway is the parent of propprofessor-mcp-server.js.
  // We can also just find it by command line: "hermes_cli.main gateway run"
  try {
    const out = execFileSync('pgrep', ['-f', 'hermes_cli.main gateway run'], { encoding: 'utf8' });
    const pids = out.trim().split('\n').filter(Boolean);
    if (pids.length === 0) return null;
    // Prefer the one whose parent is launchd (PPID 1) — that's the
    // "real" gateway, not a child.
    for (const pid of pids) {
      try {
        const psOut = execFileSync('ps', ['-p', pid, '-o', 'ppid='], { encoding: 'utf8', timeout: 2 });
        if (psOut.trim() === '1') return parseInt(pid, 10);
      } catch {
        // ps may fail for transient processes; fall through
      }
    }
    return parseInt(pids[0], 10);
  } catch {
    return null;
  }
}

function sighupGateway() {
  const pid = findHermesGatewayPid();
  if (!pid) {
    log('no Hermes gateway found — skip SIGHUP');
    return false;
  }
  try {
    process.kill(pid, 'SIGHUP');
    log(`SIGHUP sent to gateway pid=${pid}`);
    return true;
  } catch (e) {
    log(`SIGHUP failed: ${e.message}`);
    return false;
  }
}

async function main() {
  const cache = readCache();

  if (!FORCE && isFresh(cache)) {
    // Healthy — no notification.
    process.exit(0);
  }

  log(
    FORCE
      ? 'force refresh requested'
      : `token expires in ${cache ? cache.exp - Math.floor(Date.now() / 1000) : '?'}s — refreshing`
  );

  // Verify Chrome + a PropProfessor tab are reachable before doing anything.
  const tab = findPropProfessorTabSync();
  if (!tab) {
    log('FAIL: no Chrome tab on app.propprofessor.com. Open the site first.');
    process.exit(1);
  }
  log(`found PP tab: ${tab.url.slice(0, 80)}`);

  // Fetch + write the fresh token.
  let body;
  try {
    body = await fetchTokenViaBrowser();
  } catch (e) {
    log(`FAIL: browser fetch failed: ${e.message}`);
    process.exit(1);
  }
  const written = writeCache(body.token, body.exp, body.perm);
  const lifetime = written.exp - Math.floor(Date.now() / 1000);
  log(`wrote token to ${TOKEN_CACHE} (lifetime ${lifetime}s, 0o600)`);

  // SIGHUP the gateway so the MCP child respawns and reads the new token.
  // In v2.1.5+ the MCP self-heals on demand, so this is only needed if
  // a long-running MCP process is holding a stale in-memory token.
  if (!sighupGateway()) {
    log('WARN: could not SIGHUP gateway — token written but MCP may keep stale in-memory copy until next refresh');
  }

  process.exit(0);
}

main().catch((e) => {
  log(`FAIL: ${e.stack || e.message}`);
  process.exit(1);
});
