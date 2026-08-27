#!/usr/bin/env node
'use strict';

/**
 * pp — PropProfessor CLI
 * Direct handler access, no MCP transport.
 * Usage: pp <command> [args...]
 */

const PROJECT = __dirname.replace(/\/bin$/, '');
const fs = require('node:fs');
const { createPropProfessorClient } = require(PROJECT + '/lib/propprofessor-api');
const { createMcpHandlers } = require(PROJECT + '/scripts/server/handlers');
const { getLocalTimezone } = require(PROJECT + '/lib/mcp-runtime-config');
const { parseGameStartMs } = require(PROJECT + '/lib/propprofessor-shared-utils');
const { recoverTennisFromScreen } = require(PROJECT + '/lib/tennis-fallback');
const { loadLedger, saveLedger, addRecord, defaultLedgerPath } = require(PROJECT + '/lib/record-ledger');
const { normalizeScanCandidates, buildScanFingerprint } = require(PROJECT + '/lib/record-candidates');
const { promoteCards } = require(PROJECT + '/lib/record-card');
const { enrichScanPolyWallets } = require(PROJECT + '/lib/propprofessor-poly-wallets');
const { analyzeWalletPlays } = require(PROJECT + '/lib/propprofessor-wallet-plays');
const { formatScanDiagnostics } = require(PROJECT + '/lib/scan-diagnostics');
const reviewRecord = require(PROJECT + '/scripts/review-record');

// ── book alias resolution ──────────────────────────────────────
// The backend uses canonical book names (e.g. 'OnyxOdds'), but users
// type common shorthands ('onyx', 'no vig', 'pinnacle'). Resolve to
// canonical before passing to handlers — otherwise the backend
// returns 0 rows for an unknown book key. Mirrors the alias map in
// lib/propprofessor-query-parser.js parseNaturalLanguagePropQuery.
const BOOK_ALIASES = {
  novig: 'NoVigApp',
  novigapp: 'NoVigApp',
  'no vig': 'NoVigApp',
  onyx: 'OnyxOdds',
  onyxodds: 'OnyxOdds',
  'onyx odds': 'OnyxOdds',
  pinnacle: 'Pinnacle',
  fanduel: 'FanDuel',
  draftkings: 'DraftKings',
  betmgm: 'BetMGM',
  betonline: 'BetOnline',
  circa: 'Circa',
  bookmaker: 'BookMaker',
  fliff: 'Fliff',
  rebet: 'Rebet',
  prophet: 'Prophet Exchange',
  thescore: 'theScore',
  underdog: 'Underdog'
};

/**
 * Resolve a user-supplied book name to its canonical backend name.
 * Exact alias match first, then prefix match (so 'no vig' or 'onyx odds'
 * with trailing text still resolve), then a squashed case-insensitive
 * comparison against known canonical names. Unknown names pass through
 * unchanged so the backend can still reject genuinely invalid books.
 */
function resolveBookAlias(raw) {
  if (!raw) return 'NoVigApp';
  const trimmed = String(raw).trim();
  const lower = trimmed.toLowerCase();
  for (const [alias, canonical] of Object.entries(BOOK_ALIASES)) {
    if (lower === alias || lower.startsWith(alias + ' ')) return canonical;
  }
  const squashed = lower.replace(/[^a-z0-9]/g, '');
  for (const canonical of new Set(Object.values(BOOK_ALIASES))) {
    if (canonical.toLowerCase().replace(/[^a-z0-9]/g, '') === squashed) return canonical;
  }
  return trimmed;
}

// ── color support ───────────────────────────────────────────────

const NO_COLOR =
  process.argv.some((a) => a === '--no-color' || a === '--no-colour') ||
  process.env.NO_COLOR === '1' ||
  !process.stdout.isTTY;

const TIER_COLORS = NO_COLOR
  ? {}
  : { 'TIER 1': '\x1b[32m', 'TIER 2': '\x1b[33m', 'TIER 3': '\x1b[36m', 'TIER 4': '\x1b[31m' };
const MOVEMENT_COLORS = NO_COLOR
  ? {}
  : {
      supportive_clean: '\x1b[32m',
      supportive_bouncy: '\x1b[36m',
      insufficient: '\x1b[33m',
      adverse_full: '\x1b[31m',
      adverse_recent: '\x1b[31m'
    };
const R = NO_COLOR ? '' : '\x1b[0m';
const B = NO_COLOR ? '' : '\x1b[1m';
const G = NO_COLOR ? '' : '\x1b[32m';
const Y = NO_COLOR ? '' : '\x1b[33m';
const RED = NO_COLOR ? '' : '\x1b[31m';
const CYAN = NO_COLOR ? '' : '\x1b[36m';

// ── arg parsing ─────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let i = 2;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--no-color' || a === '--no-colour') {
      i++;
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.replace(/^--/, '');
      const val = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
      flags[key] = val;
    } else if (a.startsWith('-')) {
      const short = a.replace(/^-/, '');
      if (short.length === 1) {
        const val = argv[i + 1] && !argv[i + 1].startsWith('--') && !argv[i + 1].startsWith('-') ? argv[++i] : true;
        flags[short] = val;
      } else {
        const k = short[0];
        const v = short.slice(1);
        flags[k] = v || true;
      }
    } else {
      positional.push(a);
    }
    i++;
  }
  return { positional, flags };
}

/**
 * Derive {league, market, selection} from a playId / gameId when the caller
 * didn't pass explicit --league/--market/--selection flags.
 *
 * Two shapes are handled:
 *   1. Full playId: "<League>:PREMATCH:...::<Market>::<selection>"
 *      (gameId :: market :: selection). League = first colon segment of gameId;
 *      market = the segment after the first "::"; selection = the final segment.
 *   2. Bare gameId: "<League>:PREMATCH:..." (no "::"). League = first segment;
 *      market/selection left null so the handler defaults/infers them.
 *
 * This fixes the bug where validate/prices/game hardcoded league=MLB/NBA and
 * silently queried a Tennis playId against the wrong league feed → empty result
 * → "lookup_failed" / "NBA Moneyline" mislabel.
 */
function deriveFromPlayId(id, { league, market, selection } = {}) {
  if (!id || typeof id !== 'string') return { league, market, selection };
  const out = { league, market, selection };
  const hasPlayIdShape = id.includes('::');
  if (hasPlayIdShape) {
    const parts = id.split('::');
    const gameId = parts[0] || '';
    const mkt = (parts[1] || '').trim();
    const sel = (parts.slice(2).join('::') || '').trim();
    if (!out.league) {
      const lg = gameId.split(':')[0];
      if (lg) out.league = lg;
    }
    if (!out.market && mkt) out.market = mkt;
    if (!out.selection && sel) out.selection = sel;
  } else if (!out.league) {
    const lg = id.split(':')[0];
    if (lg) out.league = lg;
  }
  return out;
}

// ── help system ─────────────────────────────────────────────────

const CLI_HELP = {
  '': `pp — PropProfessor CLI

Usage: pp <command> [args...]

Commands:
  scan       Quick screen — find plays across leagues
  validate   Validate a specific play
  game       Get play details for a game
  today      Today's slate + pending picks
  picks      Recent pick history
  log        Log a pick
  record     Review official bets + P&L from the tracker ledger (stats/review/pending)
  record-card  Record a reviewed decision card into the tracker ledger
  player     Player context + injury/risk flags
  prices     Compare prices across books
  rank       Ranked plays for a league
  wallets    Top Polymarket wallets vs a book (bet/pass)
  fantasy    Fantasy optimizer props
  health     Auth + backend health check
  --mcp      Run as MCP stdio server (for Claude Desktop, Cursor, etc.)

Run "pp <command> --help" for command-specific help.
`,
  scan: `pp scan [leagues...] [flags]

Scan for plays across one or more leagues. Defaults to all leagues.

Flags:
  -m, --market <name>       Market filter (comma-separated). Default: all
  -b, --book <name>         Execution book. Default: NoVigApp
  -t, --tier <1|2|1-2>      Tier filter. Default: 1-2 (TIER 1 + TIER 2)
  -B, --only-bets           Show only BET verdict plays
  -M, --movement <type>     Movement filter (supportive, clean, bouncy, adverse)
  -n, --limit <N>           Max results. Default: 50
  --card-window <today|next|all>  Date window. Default: all (keeps pregame matches even if PP's clock stamps them past start)
  --sort <field>            Sort by: start, edge, tier, clv, momentum. Default: start
  --asc                     Sort ascending (default: descending)
  -j, --json                Raw JSON output
  --fast                    Quick scan (5 fastest leagues)
  --validate-all            Full validation on all candidates (slow)
  --tz <IANA>                Timezone for display (default: America/Chicago). Overrides LOCALTIMEZONE env var.
  --no-tennis-fallback       Disable fallback recovery when tennis scan returns 0 plays
  --record-scan              Record scan + normalized candidates to the tracker ledger (PP_RECORD_LEDGER, default ~/.propprofessor/tracker/ledger.json)
  --props                   Include player prop markets (Player Points, etc.) in the scan
  --wallets [N]             Overlay top Polymarket wallets' live positions on plays (default off; N = number of wallets, default 20)
  --no-wallets              Explicitly disable the wallet overlay (only meaningful with --wallets)

Examples:
  pp scan tennis wnba
  pp scan mlb -m "Total Runs" -t 1 -B
  pp scan -M supportive --asc
`,

  validate: `pp validate <playId> [flags]

Validate a specific play by playId.

Flags:
  -l, --league <name>       League (default: MLB)
  -m, --market <name>       Market (default: Moneyline)
  -g, --game-id <id>        Game ID (default: inferred from playId)
  -b, --book <name>         Book (default: NoVigApp)
  -j, --json                Raw JSON output
`,
  game: `pp game <gameId|playId> [flags]

Fetch play details for a game/market combination.

Accepts a bare gameId (broad ranked recheck) or a full playId
"<gameId>::<market>::<selection>" for an exact-line recheck — only the row
matching the exact selection is returned (nested selections preserved).
Use --selection to pin the exact line on a bare gameId.

Flags:
  -l, --league <name>       League (default: MLB)
  -m, --market <name>       Market (default: Total Runs)
  -s, --selection <name>    Exact selection/line filter (e.g. "Over 22.5")
  -b, --book <name>         Book (default: NoVigApp)
  -j, --json                Raw JSON output
`,
  today: `pp today [flags]

Show today's slate and pending picks.

Flags:
  -t, --tier <1|2|1-2>      Tier filter. Default: 1-2
  -n, --limit <N>           Max slate size. Default: 10
  -j, --json                Raw JSON output
  --tz <IANA>                Timezone for display (default: America/Chicago). Overrides LOCALTIMEZONE env var.
`,
  picks: `pp picks [flags]

Show recent logged picks.

Flags:
  -n, --limit <N>           Max results. Default: 10
  -j, --json                Raw JSON output
`,
  log: `pp log <gameId> --league <league> --market <market> --selection <pick> --odds <N> [flags]

Log a pick. Requires: game ID, league, market, selection, odds.

Flags:
  -l, --league <name>       League (required)
  -m, --market <name>       Market (required)
  -s, --selection <text>    Selection / pick text (required)
  -o, --odds <N>            Odds as integer (required)
  -S, --stake <text>        Stake amount (e.g. 2u)
  -k, --kai-call <verdict>  KAI call (BET, CONSIDER, PASS)
  -t, --tier <name>         Confidence tier (TIER 1, TIER 2)
  -n, --notes <text>        Optional notes
  -j, --json                Raw JSON output
`,
  'record-card': `pp record-card <card.json> [flags]

Record a reviewed decision card into the tracker ledger (PP_RECORD_LEDGER,
default ~/.propprofessor/tracker/ledger.json). Promotes explicit BET cards
into official bet records; LEAN/PASS update the candidate without creating
a bet. Idempotent — re-importing an already recorded card is a no-op.

Input (one required, not both):
  <card.json>               Path to a card JSON file (single card or array)
  --json '<payload>'        Inline card JSON (single card or array)

Card fields:
  candidateId           required — candidate id from a recorded scan
  decision              required — BET | LEAN | PASS
  odds                  required for BET — price at decision time
  stake                 required for BET — positive stake amount
  researchSummary       required for BET
  decisionSource        required — who/what produced the decision
  scheduleVerification  required for BET — event time/identity resolved
  lineVerification      required for BET — line/price confirmed
  notes                 optional

Flags:
  -j, --json            Machine-readable JSON result on stdout (bare --json;
                        a string value is the inline card payload)

Exit status:
  0 — all cards recorded (duplicates count as success)
  1 — malformed/missing input or any rejected card; ledger not modified
`,
  record: `pp record <stats|review|pending> [flags]

Review official bets, P&L, and raw candidates from the tracker ledger
(PP_RECORD_LEDGER, default ~/.propprofessor/tracker/ledger.json). Local and
read-only — no network, no ledger writes.

Modes:
  stats    Official W-L-P-V record, American-odds P&L with stake-weighted
           ROI, splits by sport/market/tier/movement/decisionSource,
           candidate counts, unresolved/delayed/retirement counts, and
           settlement source URLs.
  review   stats plus one line per official bet in scope.
  pending  Unresolved/delayed/retirement bets with settlement evidence.

Flags:
  --date YYYY-MM-DD   America/Chicago calendar day of scheduled start
  -j, --json          Machine-readable JSON on stdout

Exit status:
  0 — success (including no-data)
  1 — ledger read errors
  2 — usage errors (unknown mode, malformed --date)
`,
  player: `pp player <name> [flags]

Look up player context, injury flags, and risk summary.

Flags:
  -l, --league <name>       League filter
  -j, --json                Raw JSON output

Examples:
  pp player "Soto"
  pp player "Markkanen" --league NBA
`,
  prices: `pp prices <gameId> [flags]

Compare prices across books for a game and market.

Flags:
  -l, --league <name>       League (default: NBA)
  -m, --market <name>       Market (default: Moneyline)
  -s, --selection <text>    Selection to filter by
  -j, --json                Raw JSON output
`,
  rank: `pp rank <league> [flags]

Show all ranked plays for a league with full movement data.

Flags:
  -m, --market <name>       Market filter
  -b, --book <name>         Book (default: NoVigApp)
  -n, --limit <N>           Max results. Default: 20
  -j, --json                Raw JSON output
`,
  wallets: `pp wallets [N] [flags]

Scan top Polymarket wallets (by lifetime P&L) for live positions, cross-check
each against the execution book, and emit a bet/pass verdict.

Settled (closed) markets are filtered: a stance on a market whose eventSlug
date is before today is dropped, so losing positions never show as stale live
bets.

Flags:
  -b, --book <name>         Book to cross-check. Default: NoVigApp
  -l, --league <name>       Only show stances in this league (e.g. Tennis, MLB)
  --date <date>             Only show stances for this event date: YYYY-MM-DD
                            or 'next' (tomorrow, local time)
  -n, --limit <N>           Number of wallets. Default: 20
  --overlap                 Show only wallets with at least one matched play
  -j, --json                Raw JSON output
`,
  fantasy: `pp fantasy [flags]

Show fantasy optimizer props from PrizePicks, Underdog, etc.

Flags:
  -a, --app <name>          Fantasy app (PrizePicks, Underdog, DraftKings6)
  -l, --league <name>       League filter
  -j, --json                Raw JSON output
`,
  health: `pp health

Check auth + backend health. Always JSON output.
`
};

function printHelp(command) {
  console.log(CLI_HELP[command || ''] || CLI_HELP['']);
}

function die(msg, code = 1) {
  console.error(RED + 'Error:' + R + ' ' + msg);
  process.exit(code);
}

// ── display helpers ─────────────────────────────────────────────

function tierColor(t) {
  return (TIER_COLORS[t] || '') + (t || '?') + R;
}

function verdictSymbol(v) {
  if (!v) return '';
  if (v === 'BET') return G + '● BET' + R;
  if (v === 'CONSIDER') return Y + '◐ CONSIDER' + R;
  if (v === 'PASS') return RED + '○ PASS' + R;
  if (v === 'WON') return G + 'WON' + R;
  if (v === 'LOST') return RED + 'LOST' + R;
  return v;
}

function movementColor(m) {
  if (!m) return '';
  return (MOVEMENT_COLORS[m] || '') + m + R;
}

function clvColor(clv) {
  if (clv == null) return '';
  if (clv > 0) return G + '+' + clv + '¢' + R;
  if (clv < 0) return RED + clv + '¢' + R;
  return clv + '¢';
}

function oddsFmt(n) {
  if (!Number.isFinite(Number(n))) return null;
  const v = Number(n);
  return v > 0 ? `+${v}` : String(v);
}

// Minimum American-odds move (in cents) before a drift counts as a directional
// signal. Exchanges like Novig tick in 1¢ — a 1-2¢ wiggle is noise, not movement,
// and labeling it "recent adverse"/"recent supportive" misleads the read.
const MIN_DRIFT_CENTS = 3;

function openerContextLabel(openingOdds, currentOdds) {
  const open = Number(openingOdds);
  const current = Number(currentOdds);
  if (!Number.isFinite(open) || !Number.isFinite(current) || open === current) return null;
  if (Math.abs(current - open) < MIN_DRIFT_CENTS) return null;
  const direction = current > open ? 'vs open: longer' : 'vs open: shorter';
  return `open ${oddsFmt(open)} -> now ${oddsFmt(current)}  ·  ${direction}`;
}

function momentumLabel(p) {
  // Future-CLV signal label: shows what predicts continued movement
  const parts = [];
  const movementLabel = (p.movementLabel || p.movementDisposition || '').toLowerCase();
  const isSupportive = movementLabel.includes('supportive');
  if (p.steamMove && isSupportive) parts.push(CYAN + 'STEAM' + R);
  if (p.sharpBookMovementConfirmed || p.pinnacle) parts.push(G + 'SHARP' + R);
  const clv = p.clvProxyPct ?? p.clv;
  if (clv > 5) parts.push(G + 'CLV vs open +5¢' + R);
  else if (clv > 3) parts.push(CYAN + 'CLV vs open +3¢' + R);
  if ((p.lastMoveAgeMs || 0) > 0 && (p.lastMoveAgeMs || 0) < 3600000) parts.push(Y + 'FRESH' + R);
  return parts.length ? parts.join(' ') : '';
}

function walletLine(p) {
  // Polymarket smart-wallet overlay for plays that resolve to a side. Only
  // rendered when a live net stance was found (aligned or against) — no
  // data is not a signal. Plain-text, iMessage-safe.
  const w = p.polyWallet;
  if (!w || w.available !== true) return '';
  const parts = [];
  const sideLine = (label, side) => {
    if (!side || side.walletCount === 0) return null;
    const doll = '$' + side.totalDollars.toLocaleString('en-US');
    return label + ' ' + side.walletCount + ' wallet' + (side.walletCount === 1 ? '' : 's') + ', ' + doll;
  };
  const aligned = sideLine('✅', w.aligned);
  const against = sideLine('⚠️', w.against);
  if (aligned) parts.push(aligned);
  if (against) parts.push(against);
  if (!parts.length) return '';
  return '    ' + parts.join(' · ') + '\n';
}

function formatScan(results) {
  if (!results || !results.length) return 'No plays found.';
  let out = '';
  let total = 0;
  for (const r of results) {
    if (!r.plays || !r.plays.length) continue;
    total += r.plays.length;
    out += '\n' + B + r.league + ' › ' + r.market + R + '  (' + r.plays.length + ')\n';
    for (const p of r.plays) {
      const tier = tierColor(p.tier || p.confidenceTier || '?');
      const mv = movementColor(p.movement || p.movementDisposition || '');
      const verdict = verdictSymbol(p.verdict || p.finalVerdict || p.kaiCall || '');
      const oddsStr = p.odds > 0 ? '+' + p.odds : String(p.odds);
      const clvStr = clvColor(p.clv);
      const edgeStr = p.edge != null ? (p.edge >= 0 ? G : RED) + p.edge.toFixed(1) + '%' + R : '';
      out += '  ' + p.selection + ' @ ' + oddsStr + '  |  ' + tier + '  ' + verdict + '\n';
      const details = [];
      if (edgeStr) details.push(edgeStr);
      if (clvStr) details.push('clv ' + clvStr);
      details.push('mv ' + mv);
      if (p.books) details.push(p.books + ' books');
      if (p.executionQuality) details.push('exec:' + p.executionQuality);
      if (p.consensusEdge != null)
        details.push('edge ' + (p.consensusEdge >= 0 ? '+' : '') + (p.consensusEdge * 100).toFixed(1) + '%');
      out += '    ' + details.join('  ·  ') + '\n';
      const openerLine = openerContextLabel(p.openingOdds, p.currentOdds);
      if (openerLine) out += '    ' + openerLine + '\n';
      const momentum = momentumLabel(p);
      if (momentum) out += '    ' + momentum + '\n';
      const matchup = p.game || p.matchup || '';
      if (matchup || p.startCST || p.startDisplay)
        out += '    ' + matchup + '  ' + (p.startCST || p.startDisplay || '') + '\n';
      const walletLineStr = walletLine(p);
      if (walletLineStr) out += walletLineStr;
    }
  }
  out += '\n' + B + total + R + ' plays across ' + results.length + ' markets';
  return out;
}

function formatToday(data) {
  let out = '';
  const slate = data.slate || data.data?.slate || [];
  if (slate.length) {
    // Build a date-range header from actual times
    const allStarts = [];
    for (const p of slate) {
      const ms = parseGameStartMs(p.start || p.startTime);
      if (Number.isFinite(ms)) allStarts.push(ms);
    }
    const tz = getLocalTimezone();
    const fmtDateTime = (ms) => {
      try {
        return new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZoneName: 'shortGeneric'
        }).format(new Date(ms));
      } catch {
        return '';
      }
    };
    if (allStarts.length) {
      const earliest = Math.min(...allStarts);
      const latest = Math.max(...allStarts);
      const rangeStr =
        earliest === latest ? fmtDateTime(earliest) : `${fmtDateTime(earliest)} → ${fmtDateTime(latest)}`;
      out += `\n${B}Today: ${rangeStr}${R}\n`;
    }
    out += B + "Today's slate" + R + ' (' + slate.length + ' plays)\n';
    for (const p of slate) {
      out +=
        '  ' +
        (p.startCST || p.startDisplay || '?') +
        '  ' +
        (p.game || p.matchup) +
        '  ' +
        p.selection +
        '  ' +
        p.odds +
        '  ' +
        tierColor(p.tier || '') +
        '\n';
    }
  } else {
    out += "No plays on today's slate.\n";
  }
  const pending = data.pendingPicks || data.data?.pendingPicks || [];
  if (pending.length) {
    out += '\n' + B + 'Pending picks' + R + ' (' + pending.length + ')\n';
    for (const p of pending.slice(0, 10)) {
      out += '  ' + (p.selection || p.pick) + '  ' + (p.odds || '') + '  ' + (p.status || '') + '\n';
    }
  }
  return out;
}

function formatValidate(data) {
  const d = data.data || data;
  if (!d || !d.selection) return JSON.stringify(data, null, 2);
  let out = '';
  out += B + d.selection + R + '  —  ' + verdictSymbol(d.verdict) + '  ' + tierColor(d.tier) + '\n';
  out += 'odds: ' + (d.play?.odds || '?') + '  |  books: ' + (d.play?.consensusBookCount || '?') + '\n';
  out +=
    'movement: ' +
    movementColor(d.verdictSummary?.movementDisposition || '?') +
    '  |  label: ' +
    (d.play?.movementLabel || '?') +
    '\n';
  out += 'execution: ' + (d.play?.executionQuality || '?') + '\n';
  if (d.verdictSummary?.actionableSummary) out += d.verdictSummary.actionableSummary + '\n';
  if (d.reasons?.length) out += 'reasons: ' + d.reasons.join(', ') + '\n';
  return out;
}

function formatError(err, context) {
  const msg = err?.message || String(err);
  if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('auth') || msg.includes('token')) {
    return 'Auth error: ' + msg + '\nTry "pp health" to check credentials.';
  }
  if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('TIMEOUT') || msg.includes('timed out')) {
    return 'Timeout scanning ' + context + '. Try narrowing leagues or adding --limit N.';
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many')) {
    return 'Rate limited. Wait a moment and try again.';
  }
  return 'Error: ' + msg;
}

// ── scan recording (--record-scan) ─────────────────────────────

/**
 * Persist a scan run and its normalized candidates to the tracker ledger.
 *
 * Idempotent by construction: lib/record-ledger.addRecord derives the scan id
 * from the scan record's content (id/createdAt excluded from the hash), so
 * re-recording an identical scan returns duplicate:true instead of appending.
 * Candidate ids embed the scan id, so a re-run re-uses the same candidate ids
 * and the candidate collection also stays stable.
 *
 * Recording status is reported on stderr only — nothing is written to stdout,
 * so `--json` output remains valid JSON.
 *
 * @param {Array} results - assembled scan results (league/market blocks)
 * @param {Object} [context] - scan inputs used for the scan record
 * @returns {{ok: boolean, duplicate?: boolean, scanId?: string, ledgerPath?: string, added?: number, duplicates?: number, candidates?: number, error?: string}}
 */
function recordScanResults(results, context = {}) {
  const ledgerPath = process.env.PP_RECORD_LEDGER || defaultLedgerPath();
  const loaded = loadLedger();
  if (!loaded.ok) {
    console.error('record-scan: ' + loaded.error);
    return { ok: false, error: loaded.error };
  }
  const ledger = loaded.ledger;
  const playCount = Array.isArray(results)
    ? results.reduce((sum, r) => sum + (Array.isArray(r && r.plays) ? r.plays.length : 0), 0)
    : 0;
  const scanRecord = {
    source: 'pp-cli',
    command: 'scan',
    leagues: context.leagues || null,
    markets: context.markets || null,
    book: context.book || null,
    tiers: context.tiers || null,
    cardWindow: context.cardWindow || null,
    limit: context.limit || null,
    playCount,
    scanFingerprint: buildScanFingerprint(results)
  };
  const scan = addRecord(ledger, 'scans', scanRecord);
  if (!scan.ok) {
    console.error('record-scan: ' + scan.error);
    return { ok: false, error: scan.error };
  }
  const candidates = normalizeScanCandidates(results, { scanId: scan.id });
  let added = 0;
  let duplicates = 0;
  for (const candidate of candidates) {
    const result = addRecord(ledger, 'candidates', candidate);
    if (result.ok && result.duplicate) duplicates += 1;
    else if (result.ok) added += 1;
  }
  const saved = saveLedger(ledger);
  if (!saved.ok) {
    console.error('record-scan: ' + saved.error);
    return { ok: false, error: saved.error };
  }
  const status = scan.duplicate ? 'unchanged (duplicate scan)' : 'recorded';
  console.error(
    `record-scan: ${status} scan ${scan.id} with ${candidates.length} candidate(s) (${added} new, ${duplicates} duplicate) → ${ledgerPath}`
  );
  return {
    ok: true,
    duplicate: scan.duplicate,
    scanId: scan.id,
    ledgerPath,
    added,
    duplicates,
    candidates: candidates.length
  };
}

// ── record-card ────────────────────────────────────────────────

/**
 * Resolve the reviewed-card input for `pp record-card`.
 *
 * Two mutually exclusive input forms:
 *   - positional file: `pp record-card <card.json>`
 *   - inline payload:  `pp record-card --json '<card json>'`
 *
 * A string-valued --json flag is the inline card payload; a bare --json
 * (value true) is the machine-readable output flag, matching every other
 * command's -j/--json behavior.
 *
 * Throws on missing/ambiguous input or malformed JSON — never returns a
 * partially usable card list.
 */
function parseCardInput(positional, flags) {
  const file = positional[1];
  const inline = typeof flags.json === 'string' ? flags.json : null;
  const jsonOut = flags.j === true || flags.json === true;
  if (positional.length > 2) {
    throw new Error('record-card: too many arguments (expected a single card file)');
  }
  if (file && inline !== null) {
    throw new Error('record-card: provide either a card JSON file or --json payload, not both');
  }
  if (!file && inline === null) {
    throw new Error("record-card: no card input — pass a card JSON file or --json '<payload>'");
  }

  let raw;
  let source;
  if (inline !== null) {
    raw = inline;
    source = '--json payload';
  } else {
    source = file;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new Error(
        'record-card: cannot read card file ' + file + ': ' + (error && error.code ? error.code : error.message),
        { cause: error }
      );
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('record-card: invalid JSON in ' + source + ': ' + error.message, { cause: error });
  }
  const cards = Array.isArray(parsed) ? parsed : [parsed];
  if (cards.length === 0) {
    throw new Error('record-card: no cards found in input');
  }
  for (const card of cards) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      throw new Error('record-card: card input must be a JSON object or an array of card objects');
    }
  }
  return { cards, jsonOut };
}

/**
 * `pp record-card <card.json>` / `pp record-card --json '<payload>'`
 *
 * Loads the tracker ledger (PP_RECORD_LEDGER), promotes explicit BET cards
 * into official bet records via lib/record-card, and records LEAN/PASS
 * decisions without creating bets. Idempotent: re-importing an already
 * promoted card is a duplicate no-op.
 *
 * Atomic by construction: the ledger is saved only when every card is valid.
 * Any malformed/missing card rejects the whole batch with a thrown error and
 * leaves the ledger untouched (in-memory promotion is discarded without a
 * save). Human status goes to stderr; stdout stays empty unless --json (or
 * -j) requests machine-readable output.
 */
async function cmdRecordCard(positional, flags) {
  const { cards, jsonOut } = parseCardInput(positional, flags);
  const loaded = loadLedger();
  if (!loaded.ok) throw new Error('record-card: ' + loaded.error);
  const ledger = loaded.ledger;

  const result = promoteCards(ledger, cards);
  const rejected = result.results.filter((r) => !r.ok);
  if (rejected.length) {
    const details = rejected.map((r) => '  - ' + (r.candidateId || '<unknown>') + ': ' + r.error).join('\n');
    throw new Error('record-card: rejected ' + rejected.length + ' card(s); ledger not modified\n' + details);
  }

  const saved = saveLedger(ledger);
  if (!saved.ok) throw new Error('record-card: ' + saved.error);

  for (const r of result.results) {
    if (r.duplicate) {
      console.error('record-card: duplicate ' + r.decision + ' ' + r.candidateId + ' (already recorded)');
    } else if (r.bet) {
      console.error(
        'record-card: BET ' +
          r.candidateId +
          ' → bet ' +
          r.bet.id +
          ' @ ' +
          r.bet.oddsAtDecision +
          ' (stake ' +
          r.bet.stake +
          ')'
      );
    } else {
      console.error('record-card: ' + r.decision + ' ' + r.candidateId + ' → candidate status ' + r.status);
    }
  }
  const summary = result.summary;
  const parts = [];
  if (summary.promoted) parts.push(summary.promoted + ' promoted');
  if (summary.recorded) parts.push(summary.recorded + ' recorded');
  if (summary.duplicates) parts.push(summary.duplicates + ' duplicate(s)');
  console.error('record-card: ' + (parts.join(', ') || 'no changes') + ' → ' + loaded.path);

  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, ledgerPath: loaded.path, summary, results: result.results }, null, 2));
  }
  return { ok: true, summary, results: result.results, ledgerPath: loaded.path };
}

// ── record ──────────────────────────────────────────────────────

/**
 * `pp record <stats|review|pending> [--date YYYY-MM-DD] [--json]`
 *
 * Local, read-only review of the tracker ledger. Delegates to
 * scripts/review-record.js (Task 6): official W-L-P-V, American-odds P&L
 * with stake-weighted ROI, splits, raw candidate counts, and settlement
 * source URLs. No network and no ledger writes — a missing ledger is an
 * empty no-data report, never an error.
 */
async function cmdRecord(positional, flags) {
  const mode = positional[1] || 'stats';
  const date = typeof flags.date === 'string' ? flags.date : undefined;
  const jsonOut = flags.j === true || flags.json === true;
  const result = reviewRecord.runReviewRecord({ mode, date });

  if (jsonOut) {
    console.log(JSON.stringify(result));
  } else if (!result.ok) {
    console.error('record: ' + result.error);
  } else {
    console.log(reviewRecord.formatHuman(result));
  }
  if (!result.ok) process.exitCode = result.exitCode || 1;
  return result;
}

// ── scan ────────────────────────────────────────────────────────

async function applyTennisScanFallback({
  res,
  leagues,
  flags,
  book,
  client,
  marketList,
  cardWindow,
  onlyBets,
  resolvedMovement
}) {
  // Tennis fallback: if tennis was among requested leagues but returned 0
  // plays, try direct screen query.  Works for mixed-league scans too.
  const tennisFallbackEnabled = flags['tennis-fallback'] !== false;
  const isTennisLeague = (leagueName) => String(leagueName || '').toLowerCase() === 'tennis';
  if (tennisFallbackEnabled) {
    const tennisInLeagues = leagues.some(isTennisLeague);
    if (tennisInLeagues) {
      const resultsArr = res.data?.results || res.results || [];
      const tennisResult = resultsArr.find((r) => isTennisLeague(r.league));
      const tennisPlaysCount = tennisResult ? (tennisResult.plays || []).length : 0;
      if (tennisPlaysCount === 0) {
        console.error('Tennis: computing CLV from ' + book + ' price history (no sharp book comparison available)');
        // Size the fallback's history spend to the shared odds-history
        // window (default 300 calls per 5 min, env PP_ODDS_HISTORY_BUDGET).
        // Mixed-sport scans already spent most of the
        // window on the other leagues — take a conservative slice and
        // reserve headroom. Tennis-only scans may use the larger safe
        // default (the fallback still clamps to the remaining window).
        const tennisFallbackRemaining =
          typeof client.oddsHistoryBudgetRemaining === 'function' ? Number(client.oddsHistoryBudgetRemaining()) : 300;
        const mixedSportScan = leagues.some((leagueName) => !isTennisLeague(leagueName));
        const maxHistorySelections = mixedSportScan
          ? Math.max(2, Math.min(20, tennisFallbackRemaining - 10))
          : undefined;
        const tennisPlays = await recoverTennisFromScreen({
          book,
          client,
          markets: marketList,
          cardWindow,
          ...(maxHistorySelections !== undefined ? { maxHistorySelections } : {})
        });
        const fallbackMeta = tennisPlays.fallbackMeta;
        if (fallbackMeta) {
          console.error(
            `[tennis-fallback] candidates=${fallbackMeta.totalCandidates} hydratedSides=${fallbackMeta.historyCalls} skipped=${fallbackMeta.skippedEntries} effectiveMax=${fallbackMeta.effectiveMaxHistorySelections} budgetRemaining=${tennisFallbackRemaining}${maxHistorySelections !== undefined ? ` requestedMax=${maxHistorySelections}` : ''}`
          );
        }
        if (tennisPlays.length) {
          const normalizedFallbackPlays = tennisPlays.map((play) => {
            const movementDisposition = play.movementDisposition || play.movement || 'insufficient';
            // CLV evidence requires a real, non-zero finite number. A
            // numeric zero (flat), null/undefined, or malformed values
            // ('', '0', false, NaN) must never count as evidence.
            const hasClvEvidence =
              typeof play.clvProxyPct === 'number' && Number.isFinite(play.clvProxyPct) && play.clvProxyPct !== 0;
            const supportive =
              movementDisposition === 'supportive_clean' || movementDisposition === 'supportive_bouncy';
            return {
              ...play,
              movementDisposition,
              verdict: play.conflictResolved ? 'CONSIDER' : supportive && hasClvEvidence ? 'BET' : 'CONSIDER'
            };
          });
          const movementMatches = (play) =>
            !resolvedMovement || resolvedMovement.includes(play.movementDisposition || play.movement);
          const filteredPlays = normalizedFallbackPlays.filter(
            (play) => movementMatches(play) && (!onlyBets || play.verdict === 'BET')
          );
          if (filteredPlays.length) {
            const filtered = resultsArr.filter((r) => !isTennisLeague(r.league));
            filtered.push({
              league: 'Tennis',
              market: 'All Markets',
              plays: filteredPlays.sort((a, b) => {
                const aMs = parseGameStartMs(a.start);
                const bMs = parseGameStartMs(b.start);
                if (!Number.isFinite(aMs) && !Number.isFinite(bMs)) return 0;
                if (!Number.isFinite(aMs)) return 1;
                if (!Number.isFinite(bMs)) return -1;
                return aMs - bMs;
              }),
              // Honesty metadata: how many raw candidates the fallback saw
              // and how many it actually hydrated under the history budget.
              ...(fallbackMeta
                ? {
                    fallback: {
                      totalCandidates: fallbackMeta.totalCandidates,
                      hydratedSides: fallbackMeta.historyCalls,
                      skippedEntries: fallbackMeta.skippedEntries,
                      effectiveMaxHistorySelections: fallbackMeta.effectiveMaxHistorySelections
                    }
                  }
                : {})
            });
            // Write back — match where we read from (res.data preferred)
            if (res.data) {
              res.data.results = filtered;
              res.data.totalCount = (res.data.totalCount || 0) + filteredPlays.length;
              res.data.tennisFallbackApplied = true;
            } else {
              res.results = filtered;
              res.tennisFallbackApplied = true;
            }
          }
        }
      }
    }
  }
  return res;
}

function renderScanOutput(res, { flags, leagues, marketList, book, targetTiers, cardWindow, limit }) {
  const jsonOut = flags.j || flags.json || false;
  const results = res.data?.results || res.results || [];
  const scanHealth = res.data?.scanHealth || res.scanHealth || null;
  const watchCandidates = Array.isArray(res.data?.watchCandidates)
    ? res.data.watchCandidates
    : Array.isArray(res.watchCandidates)
      ? res.watchCandidates
      : null;

  // Surface existing diagnostics on the human path: truncated rows, empty
  // league×market pairs, and the tennis-fallback-on-mixed-scan caveat. The
  // pure helper keeps the text testable and shared with JSON consumers.
  const emptySlate = res.data?.emptySlate || res.emptySlate || [];
  const tennisFallbackApplied = Boolean(res.data?.tennisFallbackApplied || res.tennisFallbackApplied);
  const mixedScan = leagues.length > 1 && leagues.some((l) => String(l || '').toLowerCase() !== 'tennis');
  // Preserve the original recovery-hint fallback: prefer a truncated league,
  // then scanHealth.league, then the first requested league.
  const healthForDiagnostics =
    scanHealth && !scanHealth.league && leagues.length ? { ...scanHealth, league: leagues[0] } : scanHealth;
  for (const line of formatScanDiagnostics({
    mixedScan,
    tennisFallbackApplied,
    emptySlate,
    scanHealth: healthForDiagnostics,
    playCount: results.reduce((sum, r) => sum + (r.plays || r.candidates || []).length, 0)
  })) {
    console.error(line);
  }

  // --record-scan: persist this scan + normalized candidates to the tracker
  // ledger. Status goes to stderr; a recording failure must never break the
  // scan output (stdout stays valid JSON under --json).
  if (flags['record-scan'] || flags.recordScan) {
    try {
      recordScanResults(results, {
        leagues,
        markets: marketList,
        book,
        tiers: targetTiers,
        cardWindow,
        limit
      });
    } catch (e) {
      console.error('record-scan: ' + (e && e.message ? e.message : String(e)));
    }
  }
  // Build the date-range header line using actual candidate start times
  const allStarts = [];
  for (const r of results) {
    for (const p of r.plays || r.candidates || []) {
      const ms = parseGameStartMs(p.start || p.startCST);
      if (Number.isFinite(ms)) allStarts.push(ms);
    }
  }
  const localTz = getLocalTimezone();
  const fmtDateTime = (ms) => {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: localTz,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'shortGeneric'
      }).format(new Date(ms));
    } catch {
      return '';
    }
  };
  const windowLabel = cardWindow === 'today' ? 'Today' : cardWindow === 'next' ? 'Next day' : 'All upcoming';
  let rangeHeader = '';
  if (allStarts.length) {
    const earliest = Math.min(...allStarts);
    const latest = Math.max(...allStarts);
    rangeHeader =
      earliest === latest
        ? `${windowLabel}: ${fmtDateTime(earliest)}`
        : `${windowLabel}: ${fmtDateTime(earliest)} → ${fmtDateTime(latest)}`;
  }
  if (jsonOut) {
    const output = {
      results,
      ...(scanHealth ? { scanHealth } : {}),
      ...(watchCandidates ? { watchCandidates } : {}),
      ...(emptySlate && emptySlate.length ? { emptySlate } : {}),
      ...(tennisFallbackApplied ? { tennisFallbackApplied } : {})
    };
    console.log(
      JSON.stringify(
        scanHealth || watchCandidates || emptySlate?.length || tennisFallbackApplied ? output : results,
        null,
        2
      )
    );
  } else {
    if (watchCandidates?.length) {
      console.error(
        `Diagnostic only: ${watchCandidates.length} watch candidate${watchCandidates.length === 1 ? '' : 's'}; never an official BET.`
      );
    }
    if (rangeHeader) console.log(B + rangeHeader + R + '\n');
    console.log(formatScan(results));
    const total = results.reduce((s, r) => s + (r.plays || []).length, 0);
    console.log('\n' + total + ' plays across ' + results.length + ' markets');
  }
}

async function cmdScan(handlers, positional, flags, client) {
  const FAST_LEAGUES = ['MLB', 'Tennis', 'UFC', 'NBA', 'WNBA'];
  let leagues =
    positional.length > 1
      ? positional.slice(1)
      : ['MLB', 'NBA', 'WNBA', 'Tennis', 'UFC', 'NFL', 'NHL', 'Soccer', 'MLS', 'NCAAB', 'NCAAF', 'NBASL'];

  // --fast mode
  if (flags.fast && positional.length <= 1) {
    leagues = FAST_LEAGUES;
    console.error('[fast] scoping to ' + leagues.join(', '));
  }

  const markets = flags.m || flags.market || undefined;
  const marketList = markets ? (Array.isArray(markets) ? markets : markets.split(',')) : undefined;
  const includeProps = flags.props || flags['include-props'] || false;
  const book = resolveBookAlias(flags.b || flags.book || 'NoVigApp');
  const tier = flags.t || flags.tier || undefined;
  const onlyBets = flags.B || flags['only-bets'] || false;
  const sortBy = flags.sort || 'start';
  const sortDir = flags.asc ? 'asc' : 'desc';

  // Map sort aliases to handler field names
  const SORT_FIELD_MAP = {
    clv: 'clvProxyPct',
    momentum: 'riskScore'
  };
  const resolvedSortBy = SORT_FIELD_MAP[sortBy] || sortBy;
  const resolvedSortDir = sortBy === 'momentum' ? 'asc' : sortDir; // momentum = lowest risk first
  const limit = parseInt(flags.n || flags.limit || 50);
  // Default to 'all' so pregame matches survive even when PP's clock stamps
  // them to a non-today UTC day or past their start time. The screen feed is
  // pregame-only — if odds are present the match is still bettable. Pass
  // --card-window today to narrow back to a single UTC day.
  const cardWindow = flags['card-window'] || flags.cardWindow || 'all';
  const tz = flags.tz || flags['tz'] || undefined;
  if (tz) process.env.LOCAL_TIMEZONE = tz;
  const validateAll = flags['validate-all'] || false;

  const targetTiers = tier
    ? tier === '1'
      ? ['TIER 1']
      : tier === '2'
        ? ['TIER 2']
        : ['TIER 1', 'TIER 2']
    : ['TIER 1', 'TIER 2', 'TIER 3'];
  // minFinalTier still controls the onlyBets floor when --tier is explicit.
  const minFinalTier = tier ? (tier === '1' ? 'TIER 1' : tier === '2' ? 'TIER 2' : 'TIER 2') : 'TIER 2';

  const MOVEMENT_ALIASES = {
    supportive: ['supportive_clean', 'supportive_bouncy'],
    clean: ['supportive_clean'],
    bouncy: ['supportive_bouncy'],
    good: ['supportive_clean', 'supportive_bouncy'],
    insufficient: ['insufficient'],
    adverse: ['adverse_full', 'adverse_recent']
  };
  const movement = flags.M || flags.movement || undefined;
  const movementList = movement ? (Array.isArray(movement) ? movement : movement.split(',')) : undefined;
  const resolvedMovement = movementList
    ? movementList.flatMap((m) => MOVEMENT_ALIASES[m] || [m])
    : onlyBets
      ? ['supportive_clean', 'supportive_bouncy']
      : undefined;

  const _ctx = leagues.join(', ');
  console.error(
    'Scanning ' +
      leagues.join(', ') +
      ' on ' +
      book +
      '...' +
      (resolvedMovement ? ' [mv: ' + resolvedMovement.join(',') + ']' : '') +
      (flags.fast ? ' [fast]' : '')
  );

  const startTime = Date.now();
  const spinner = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stderr.write('\r' + ' '.repeat(20) + '\rScanning... ' + elapsed + 's');
  }, 10000);

  try {
    const res = await handlers.quick_screen({
      leagues,
      markets: marketList,
      books: [book],
      includeProps: includeProps || undefined,
      targetTiers,
      onlyBets: onlyBets || undefined,
      minFinalTier,
      movement: resolvedMovement,
      sortBy: resolvedSortBy,
      sortDir: resolvedSortDir,
      limit,
      cardWindow: cardWindow || undefined,
      lite: true,
      verbosity: 'bets',
      validate: validateAll ? true : undefined,
      validateTop: validateAll ? undefined : 10,
      includeResearch: false
    });
    clearInterval(spinner);
    process.stderr.write('\r' + ' '.repeat(30) + '\r');

    await applyTennisScanFallback({
      res,
      leagues,
      flags,
      book,
      client,
      marketList,
      cardWindow,
      onlyBets,
      resolvedMovement
    });

    // Polymarket wallet overlay (top traders by P&L). Pure enrichment —
    // never touches ranking/movement/verdict; a failed fetch degrades to a
    // silent no-op. OPT-IN via --wallets [N]: it adds live network calls to
    // Polymarket on every run, so we don't fire them on a plain scan.
    if ((flags.wallets || flags['wallets']) && !(flags['no-wallets'] || flags.noWallets)) {
      try {
        const results = res.data?.results || res.results || [];
        const wantCount = flags.wallets === true ? undefined : Number(flags.wallets);
        await enrichScanPolyWallets(results, { limit: Number.isFinite(wantCount) && wantCount > 0 ? wantCount : 20 });
        const health = res.data?.scanHealth || res.scanHealth || null;
        if (health && (health.truncated || health.incomplete)) {
          console.error(
            'note: scan truncated — Polymarket wallet overlay may miss some matchups (run `pp wallets` for the wallet-first view).'
          );
        }
      } catch {
        // Enrichment must never break scan output.
      }
    }

    renderScanOutput(res, { flags, leagues, marketList, book, targetTiers, cardWindow, limit });
  } catch (e) {
    clearInterval(spinner);
    process.stderr.write('\r' + ' '.repeat(30) + '\r');
    throw e;
  }
}

// ── validate ────────────────────────────────────────────────────

async function cmdValidate(handlers, positional, flags) {
  const playId = positional[1];
  if (!playId) die('Usage: pp validate <playId> [--league] [--market] [--game-id] [--book]');

  // Derive league/market/selection from the playId unless the user overrode
  // them with flags. PlayId shape: "<League>:...::<Market>::<selection>".
  const derived = deriveFromPlayId(playId, {
    league: flags.l || flags.league,
    market: flags.m || flags.market,
    selection: flags.s || flags.selection
  });
  const league = derived.league || 'MLB';
  const market = derived.market || 'Moneyline';
  const selection = derived.selection || '';
  const gameId = flags.g || flags['game-id'] || playId.replace(/::.*$/, '').replace(/:$/, '');
  const book = resolveBookAlias(flags.b || flags.book || 'NoVigApp');
  const jsonOut = flags.j || flags.json || false;

  console.error('Validating ' + playId.slice(-40) + '...');

  const res = await handlers.validate_play({ league, market, gameId, playId, selection, book });
  if (jsonOut) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(formatValidate(res));
  }
}

// ── game ────────────────────────────────────────────────────────

async function cmdGame(handlers, positional, flags) {
  const playId = positional[1];
  if (!playId) die('Usage: pp game <gameId|playId> [--league] [--market] [--selection] [--book]');

  // Derive league/market/selection from the gameId/playId unless overridden
  // with flags. A full playId "<gameId>::Total Games::over 22.5" yields all
  // three; a bare gameId yields just the league so the handler defaults the
  // rest (preserving the broad recheck behavior).
  const derived = deriveFromPlayId(playId, {
    league: flags.l || flags.league,
    market: flags.m || flags.market,
    selection: flags.s || flags.selection
  });
  const league = derived.league || 'MLB';
  const market = derived.market || flags.m || flags.market || 'Total Runs';
  const selection = derived.selection || '';
  const book = resolveBookAlias(flags.b || flags.book || 'NoVigApp');
  const jsonOut = flags.j || flags.json || false;
  // Strip any "::market::selection" suffix so the handler queries the bare
  // gameId (the backend rows carry the bare gameId on each row).
  const gameId = (flags.g || flags['game-id'] || playId).replace(/::.*$/, '').replace(/:$/, '');

  console.error('Fetching ' + gameId + (selection ? ' [' + selection + ']' : '') + '...');

  const args = { league, market, gameIds: [gameId], books: [book] };
  if (selection) args.selection = selection;
  if (playId.includes('::')) args.playId = playId;
  const res = await handlers.get_play_details(args);

  if (jsonOut) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    const rows = res.result || res.data || [];
    if (!rows.length) {
      if (selection && res.resultMeta?.selectionNotFound) {
        console.log('No exact match for selection "' + selection + '" in ' + gameId + '.');
      } else {
        console.log('No data.');
      }
      return;
    }
    const r = rows[0];
    console.log(B + (r.awayTeam || 'Away') + ' @ ' + (r.homeTeam || 'Home') + R);
    console.log('start: ' + r.start + '  |  market: ' + r.market + '  |  defaultKey: ' + r.defaultKey);
    console.log(
      'movementLabel: ' +
        r.movementLabel +
        '  |  grade: ' +
        r.movementGrade +
        '  |  disposition: ' +
        movementColor(r.movementDisposition)
    );
    const quoteAgeMs = Number(r.lastPointAgeMs);
    if (Number.isFinite(quoteAgeMs) && quoteAgeMs > 10 * 60 * 1000) {
      console.log(
        Y + '⚠ quote is ' + Math.round(quoteAgeMs / 60000) + ' min old — verify current price before betting' + R
      );
    }
    if (selection) {
      console.log('selection: ' + (r.selection || r.pick || '') + '  [' + (r.selectionId || '') + ']');
    }
    if (r.selections) {
      console.log('\n' + B + 'Lines:' + R);
      for (const [key, sel] of Object.entries(r.selections)) {
        const bks = Object.keys(sel.odds || {}).join(', ');
        console.log('  ' + key + ': ' + (sel.selection1 || '') + ' / ' + (sel.selection2 || '') + '  [' + bks + ']');
      }
    }
  }
}

// ── today ───────────────────────────────────────────────────────

async function cmdToday(handlers, positional, flags) {
  const tier = flags.t || flags.tier || undefined;
  const limit = parseInt(flags.n || flags.limit || 10);
  const jsonOut = flags.j || flags.json || false;
  const tz = flags.tz || flags['tz'] || undefined;
  if (tz) process.env.LOCAL_TIMEZONE = tz;
  const args = {};
  if (tier) args.targetTiers = tier === '1' ? ['TIER 1'] : ['TIER 1', 'TIER 2'];
  if (limit) args.limit = limit;
  console.error('Fetching today...');
  const res = await handlers.today(args);
  if (jsonOut) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(formatToday(res));
  }
}

// ── picks ───────────────────────────────────────────────────────

async function cmdPicks(handlers, positional, flags) {
  const limit = parseInt(flags.n || flags.limit || 10);
  const jsonOut = flags.j || flags.json || false;
  console.error('Fetching recent picks...');
  const res = await handlers.get_pick_history({ limit });
  const picks = Array.isArray(res) ? res : res?.data || res?.result || [];
  if (jsonOut) {
    console.log(JSON.stringify(picks, null, 2));
    return;
  }
  if (!picks.length) {
    console.log('No recent picks.');
    return;
  }
  console.log(B + 'Recent picks' + R + ' (' + picks.length + ')');
  for (const p of picks) {
    const verdict = verdictSymbol(p.verdict || p.status || p.outcome || '');
    console.log(
      '  ' +
        (p.game || p.matchup || '') +
        '  ' +
        (p.selection || '') +
        '  ' +
        (p.odds || '') +
        '  ' +
        verdict +
        '  ' +
        (p.startCST || p.startDisplay || '')
    );
    if (p.edge) console.log('    edge: ' + p.edge + '%  |  tier: ' + (p.tier || ''));
  }
}

// ── log ─────────────────────────────────────────────────────────

async function cmdLog(handlers, positional, flags) {
  const gameId = positional[1];
  if (!gameId) die('Usage: pp log <gameId> --league <league> --market <market> --selection <pick> --odds <N>');

  const league = flags.l || flags.league || '';
  const market = flags.m || flags.market || '';
  const selection = flags.s || flags.selection || '';
  const odds = parseInt(flags.o || flags.odds || '');
  const stake = flags.S || flags.stake || '';
  const kaiCall = flags.k || flags['kai-call'] || '';
  const confidenceTier = flags.t || flags.tier || '';
  const notes = flags.n || flags.notes || '';
  const jsonOut = flags.j || flags.json || false;

  if (!league) die('--league is required');
  if (!market) die('--market is required');
  if (!selection) die('--selection is required');
  if (isNaN(odds)) die('--odds is required (integer, e.g. -110 or +120)');

  console.error('Logging pick: ' + selection + ' @ ' + odds + ' (' + league + ' ' + market + ')...');

  const res = await handlers.log_pick({
    game: gameId,
    league,
    market,
    selection,
    odds,
    stake: stake || undefined,
    kaiCall: kaiCall || undefined,
    confidenceTier: confidenceTier || undefined,
    notes: notes || undefined
  });

  if (jsonOut) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    const ok = res?.ok ?? res?.success ?? true;
    if (ok) {
      console.log(G + '✓' + R + ' Pick logged: ' + selection + ' @ ' + odds + ' (' + league + ')');
      if (stake) console.log('  stake: ' + stake);
      if (notes) console.log('  notes: ' + notes);
    } else {
      console.error(RED + 'Failed' + R + ' to log pick: ' + (res?.error || JSON.stringify(res)));
    }
  }
}

// ── player ──────────────────────────────────────────────────────

async function cmdPlayer(handlers, positional, flags) {
  const name = positional.slice(1).join(' ') || flags.n || flags.name;
  if (!name) die('Usage: pp player <name> [--league]');

  const league = flags.l || flags.league || '';
  const jsonOut = flags.j || flags.json || false;

  console.error('Looking up: ' + name + (league ? ' (' + league + ')' : '') + '...');

  const res = await handlers.player_context({
    player: name,
    sport: league || undefined
  });

  if (jsonOut) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const data = res?.data || res?.result || res;
  const player = Array.isArray(data) ? data[0] : data;

  if (!player || !player.name) {
    console.log('No data found for: ' + name);
    return;
  }

  console.log(B + player.name + R + (player.team ? ' — ' + player.team : ''));
  if (player.league) console.log('league: ' + player.league);
  if (player.injuryStatus)
    console.log('injury: ' + (player.injuryStatus === 'Active' ? G : RED) + player.injuryStatus + R);
  if (player.riskFlag) console.log('risk: ' + (player.riskFlag === 'high' ? RED : Y) + player.riskFlag + R);
  if (player.riskSummary) console.log('summary: ' + player.riskSummary);
  if (player.recentForm) console.log('form: ' + player.recentForm);
  if (player.statLine) console.log('stats: ' + player.statLine);
}

// ── prices ──────────────────────────────────────────────────────

async function cmdPrices(handlers, positional, flags) {
  const gameId = positional[1];
  if (!gameId) die('Usage: pp prices <gameId> [--league] [--market] [--selection]');

  // Derive league/market/selection from the playId/gameId unless overridden.
  const derived = deriveFromPlayId(gameId, {
    league: flags.l || flags.league,
    market: flags.m || flags.market,
    selection: flags.s || flags.selection
  });
  const league = derived.league || 'NBA';
  const market = derived.market || flags.m || flags.market || 'Moneyline';
  const selection = derived.selection || flags.s || flags.selection || '';
  // The handler matches rows by bare gameId; if the user passed a full playId
  // (gameId::market::selection) strip it down to the gameId portion.
  const bareGameId = gameId.includes('::') ? gameId.split('::')[0] : gameId;
  const jsonOut = flags.j || flags.json || false;

  console.error('Comparing prices for ' + bareGameId + ' (' + league + ' ' + market + ')...');

  const res = await handlers.find_best_price({
    league,
    market,
    game: bareGameId,
    selection: selection || undefined
  });

  if (jsonOut) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  // Handler returns { ok, data: { found, allPrices[], bestPrice{} } }.
  const data = res?.data || res;
  const prices = data?.allPrices || res?.allPrices || res?.prices || res?.comparison || [];
  const best = data?.bestPrice || res?.bestPrice || res?.best;

  if (Array.isArray(prices) && !prices.length && !best) {
    console.log('No price data found.');
    return;
  }

  console.log(B + 'Price comparison' + R + ' — ' + league + ' ' + market);
  if (Array.isArray(prices)) {
    for (const p of prices) {
      const isBest = best && p.book === best.book && p.odds === best.odds;
      const mark = isBest ? ' ' + G + '← best' + R : '';
      console.log('  ' + (p.book || p.sportsbook || '?') + ': ' + (p.odds || '') + mark);
    }
  }
  if (best) {
    console.log('\n' + G + 'Best: ' + (best.book || best.sportsbook || '') + ' @ ' + best.odds + R);
  }
}

// ── rank ────────────────────────────────────────────────────────

async function cmdRank(handlers, positional, flags) {
  const league = positional[1] || flags.l || flags.league || 'MLB';
  const market = flags.m || flags.market || undefined;
  const book = resolveBookAlias(flags.b || flags.book || 'NoVigApp');
  const limit = parseInt(flags.n || flags.limit || 20);
  const jsonOut = flags.j || flags.json || false;

  console.error('Ranking ' + league + ' on ' + book + '...');

  const res = await handlers.screen_ranked({
    league,
    market: market || undefined,
    books: [book],
    limit,
    verbosity: jsonOut ? 'full' : 'standard',
    includeResearch: false
  });

  if (jsonOut) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const rows = res?.result || res?.data || res?.rows || [];
  if (!rows.length) {
    console.log('No ranked plays for ' + league);
    return;
  }

  console.log(B + league + ' ranked plays' + R + ' (' + rows.length + ' rows / ' + uniqueGames(rows) + ' games)');
  // Group by game so each side's movement sits under its own matchup header.
  // (pp rank returns one row PER SIDE of each market; a flat list made it easy
  //  to misattribute a side's movement to the wrong team. Grouped view fixes it.)
  const order = [];
  const groups = new Map();
  for (const r of rows) {
    const gid = r.gameId || r.homeTeam + '|' + r.awayTeam;
    if (!groups.has(gid)) {
      groups.set(gid, []);
      order.push(gid);
    }
    groups.get(gid).push(r);
  }
  for (const gid of order) {
    const grp = groups.get(gid);
    const g = grp[0];
    const mkts = [...new Set(grp.map((r) => r.market || r.playType || '?'))];
    console.log(
      '\n' +
        B +
        (g.awayTeam || '?') +
        ' @ ' +
        (g.homeTeam || '?') +
        R +
        '  [' +
        mkts.join(',') +
        ']' +
        (g.isLive ? '  ' + RED + 'LIVE' + R : '')
    );
    for (const r of grp) {
      const mv = movementColor(r.movementDisposition || '');
      const tier = tierColor(r.confidenceTier || '?');
      const oddsStr = r.odds > 0 ? '+' + r.odds : String(r.odds);
      let line = '  ' + (r.selection || r.participant || '?') + ' @ ' + oddsStr + '  ' + tier + '  |  mv ' + mv;
      const extra = [];
      if (r.consensusBookCount) extra.push('books ' + r.consensusBookCount);
      if (Number.isFinite(Number(r.liquidityUsd)) && Number(r.liquidityUsd) > 0)
        extra.push('liq $' + Math.round(Number(r.liquidityUsd)).toLocaleString('en-US'));
      if (r.recentClvPct != null)
        extra.push('CLV ' + (Number(r.recentClvPct) >= 0 ? '+' : '') + Number(r.recentClvPct).toFixed(1) + '%');
      if (extra.length) line += '   ' + '[' + extra.join(' | ') + ']';
      if (r.movementSourceBook) line += '  (src ' + r.movementSourceBook + ')';
      console.log(line);
    }
  }
}

function uniqueGames(rows) {
  const s = new Set();
  for (const r of rows) s.add(r.gameId || r.homeTeam + '|' + r.awayTeam);
  return s.size;
}

// ── wallets ──────────────────────────────────────────────────────

/** Render one wallet's stance block for the wallets overlap output. */
function printWalletOverlaps(w, book, overlapOnly) {
  const wallet = w.wallet || {};
  const name = wallet.userName || (wallet.proxyWallet ? wallet.proxyWallet.slice(0, 10) : 'wallet');
  const pnl = wallet.pnl != null ? '$' + Math.round(wallet.pnl).toLocaleString('en-US') : '?';
  console.log('\\n' + B + name + R + '  (lifetime P&L ' + pnl + ')');
  const stances = (w.stances || []).filter((s) => (overlapOnly ? s.matched : true));
  for (const s of stances) {
    if (!s.matched || !s.row) {
      console.log(
        '  ' +
          (s.selection || s.outcome || '?') +
          '  ·  $' +
          (s.dollar || 0).toLocaleString('en-US') +
          ' whale  ·  no ' +
          book +
          ' match  (' +
          (s.title || '') +
          ')'
      );
      continue;
    }
    const row = s.row;
    const oddsStr = row.odds > 0 ? '+' + row.odds : String(row.odds);
    const mv = movementColor(row.movementDisposition || '');
    const clv =
      row.recentClvPct != null
        ? (Number(row.recentClvPct) >= 0 ? '+' : '') + Number(row.recentClvPct).toFixed(1) + '%'
        : '?';
    const v = s.verdict || {};
    const vSym =
      v.verdict === 'BET' ? G + '● BET' + R : v.verdict === 'CONSIDER' ? Y + '◐ CONSIDER' + R : RED + '✕ PASS' + R;
    const tierStr = row.confidenceTier ? Y + row.confidenceTier + R : '';
    const edgeStr =
      row.consensusEdge != null
        ? (Number(row.consensusEdge) >= 0 ? G + '+' : RED) + (Number(row.consensusEdge) * 100).toFixed(1) + '%' + R
        : '';
    const tierEdge = tierStr || edgeStr ? '  ' + tierStr + (tierStr && edgeStr ? '  ' : '') + edgeStr : '';
    const exactMark = s.exact ? '  ' + CYAN + '(exact)' + R : '';
    console.log(
      '  ' +
        (row.selection || s.selection) +
        ' @ ' +
        oddsStr +
        '  ' +
        vSym +
        '  ' +
        mv +
        '  CLV ' +
        clv +
        tierEdge +
        exactMark
    );
    console.log(
      '    whale $' +
        (s.dollar || 0).toLocaleString('en-US') +
        ' on ' +
        (s.selection || '') +
        '  ·  ' +
        (row.game || s.title || '')
    );
    const booksLine = row.consensusBookCount ? 'books ' + row.consensusBookCount + '  ·  ' : '';
    const liq =
      Number.isFinite(Number(row.liquidityUsd)) && Number(row.liquidityUsd) > 0
        ? 'liq $' + Math.round(Number(row.liquidityUsd)).toLocaleString('en-US') + '  ·  '
        : '';
    console.log('    ' + booksLine + liq + (v.reason || ''));
  }
}

function resolveWalletDate(value, now = new Date()) {
  if (value == null || value === '') return undefined;
  const date = String(value).trim().toLowerCase();
  if (date === 'today' || date === 'next') {
    const resolved = new Date(now);
    if (date === 'next') resolved.setDate(resolved.getDate() + 1);
    const y = resolved.getFullYear();
    const m = String(resolved.getMonth() + 1).padStart(2, '0');
    const d = String(resolved.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  throw new Error('Invalid wallet date: expected YYYY-MM-DD, today, or next');
}

async function cmdWallets(handlers, positional, flags) {
  const limit = parseInt(flags.n || flags.limit || positional[1] || 20);
  const book = resolveBookAlias(flags.b || flags.book || 'NoVigApp');
  const jsonOut = flags.j || flags.json || false;
  const overlapOnly = flags.overlap || flags['overlap'] || false;
  const league = flags.l || flags.league || undefined;
  // --date accepts YYYY-MM-DD, 'today', or 'next' (LOCAL time).
  const date = resolveWalletDate(flags.date);

  const filterNote = [league ? 'league ' + league : null, date ? 'date ' + date : null].filter(Boolean).join(', ');
  console.error(
    'Scanning top Polymarket wallets vs ' +
      book +
      (overlapOnly ? ' — overlap only' : '') +
      (filterNote ? ' (' + filterNote + ')' : '') +
      '...'
  );

  const rankFn = async (league, market) => {
    const res = await handlers.screen_ranked({
      league,
      market,
      books: [book],
      limit: 100,
      includeAll: true,
      verbosity: 'full'
    });
    return res?.result || res?.data || res?.rows || [];
  };

  const exactFn = async (league, market, gameId, b) => {
    // Same authoritative path as `pp game`: exact per-game quote with current
    // tier/movement/CLV. Used to re-grade matched wallet stances so degraded
    // broad-scan labels never dictate a verdict.
    const res = await handlers.get_play_details({
      league,
      market,
      gameIds: [gameId],
      books: [b || book]
    });
    return res?.result || res?.data || [];
  };

  const out = await analyzeWalletPlays({
    limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
    book,
    league,
    date,
    rankFn,
    exactFn
  });

  const walletList = Array.isArray(out) ? out : out && Array.isArray(out.wallets) ? out.wallets : [];

  // --overlap: filter to wallets with at least one matched stance
  const overlapWallets = overlapOnly ? walletList.filter((w) => (w.stances || []).some((s) => s.matched)) : walletList;

  if (jsonOut) {
    const result = overlapOnly
      ? { wallets: overlapWallets, droppedByPrefix: out?.droppedByPrefix, nonSportsDropped: out?.nonSportsDropped }
      : out;
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!Array.isArray(overlapWallets) || overlapWallets.length === 0) {
    const totalWallets = walletList.length;
    if (overlapOnly && totalWallets > 0) {
      console.log(
        'No overlap found — ' +
          totalWallets +
          ' wallet' +
          (totalWallets === 1 ? '' : 's') +
          ' have positions, but none matched a ' +
          book +
          ' play.'
      );
    } else {
      console.log('No live Polymarket wallet positions matched the ' + book + ' board.');
    }
    // Diagnostic footer: show dropped stances so the "why 0 wallets?" question
    // has an answer instead of a shrug.
    const dropped = out && Array.isArray(out.droppedByPrefix) ? out.droppedByPrefix : [];
    const nonSports = out && typeof out.nonSportsDropped === 'number' ? out.nonSportsDropped : 0;
    if (dropped.length || nonSports) {
      const total = dropped.reduce((s, d) => s + d.count, 0);
      const parts = [];
      if (total) parts.push(total + ' sport position' + (total === 1 ? '' : 's') + ' — slug prefix not mapped');
      if (nonSports)
        parts.push(
          nonSports + ' non-sport position' + (nonSports === 1 ? '' : 's') + ' (crypto/politics/weather — out of scope)'
        );
      console.error('  (' + parts.join('; ') + '. See `pp wallets --json` for the breakdown.)');
    }
    return;
  }

  if (overlapOnly) {
    const matchedCount = overlapWallets.reduce((s, w) => s + (w.stances || []).filter((x) => x.matched).length, 0);
    console.log(
      Y +
        '  ' +
        matchedCount +
        ' overlap play' +
        (matchedCount === 1 ? '' : 's') +
        ' across ' +
        overlapWallets.length +
        ' wallet' +
        (overlapWallets.length === 1 ? '' : 's') +
        R
    );
    console.log('');
  }

  for (const w of overlapWallets) {
    printWalletOverlaps(w, book, overlapOnly);
  }

  // Per-game whale tally (matched stances only, across all wallets): shows
  // split money in one line ("Fonseca $8.4K for / $9.2K against").
  const tallies = out && Array.isArray(out.gameTallies) ? out.gameTallies : [];
  if (tallies.length) {
    console.log(
      '\n' + B + 'Per-game whale tally' + R + '  (' + tallies.length + ' side' + (tallies.length === 1 ? '' : 's') + ')'
    );
    // Group by game preserving first-seen order (tallies are sorted by usd desc).
    const byGame = new Map();
    for (const t of tallies) {
      const key = t.game;
      if (!byGame.has(key)) byGame.set(key, []);
      byGame.get(key).push(t);
    }
    for (const [game, sides] of byGame) {
      const parts = sides.map((t) => {
        const plural = t.wallets > 1 ? ' (' + t.wallets + ' wallets)' : '';
        return (t.side || '?') + ' $' + Math.round(t.usd).toLocaleString('en-US') + plural;
      });
      console.log('  ' + game + '  →  ' + parts.join('  /  '));
    }
  }

  // Diagnostic footer: show dropped stances so "why did I only see N wallets?"
  // has an answer instead of a shrug.
  const dropped = out && Array.isArray(out.droppedByPrefix) ? out.droppedByPrefix : [];
  const nonSports = out && typeof out.nonSportsDropped === 'number' ? out.nonSportsDropped : 0;
  if (dropped.length || nonSports) {
    const total = dropped.reduce((s, d) => s + d.count, 0);
    console.error('');
    if (total) {
      console.error(
        Y +
          '  ' +
          total +
          ' sport position' +
          (total === 1 ? '' : 's') +
          ' dropped — slug prefix not mapped to a league:' +
          R
      );
      for (const d of dropped.sort((a, b) => b.count - a.count)) {
        console.error(RED + '    ' + d.prefix + R + '  (' + d.count + 'x)  e.g. "' + d.example + '"');
      }
    }
    if (nonSports) {
      console.error(
        Y +
          '  ' +
          nonSports +
          ' non-sport position' +
          (nonSports === 1 ? '' : 's') +
          ' (crypto/politics/weather — out of scope)' +
          R
      );
    }
    console.error('  Run `pp wallets --json` for the full breakdown.');
  }
}

// ── fantasy ─────────────────────────────────────────────────────

async function cmdFantasy(handlers, positional, flags) {
  const app = flags.a || flags.app || undefined;
  const league = flags.l || flags.league || undefined;
  const jsonOut = flags.j || flags.json || false;

  const fantasyApps = app ? (Array.isArray(app) ? app : [app]) : ['PrizePicks', 'Underdog', 'DraftKings6'];
  const leagues = league ? (Array.isArray(league) ? league : [league]) : undefined;

  console.error(
    'Fetching fantasy props: ' + fantasyApps.join(', ') + (leagues ? ' (' + leagues.join(', ') + ')' : '') + '...'
  );

  const res = await handlers.fantasy_optimizer({ fantasyApps, leagues, verbosity: 'standard' });

  if (jsonOut) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const picks = Array.isArray(res) ? res : res?.result || res?.picks || [];
  if (!picks.length) {
    console.log('No fantasy props found.');
    return;
  }

  const byApp = {};
  for (const p of picks) {
    const appName = p.fantasyApp || 'Unknown';
    if (!byApp[appName]) byApp[appName] = [];
    byApp[appName].push(p);
  }

  for (const [appName, appPicks] of Object.entries(byApp)) {
    console.log('\n' + B + appName + R + '  (' + appPicks.length + ' props)');
    for (const p of appPicks.slice(0, 15)) {
      const valStr = p.value ? G + p.value + '%' + R : '';
      const dir = p.selectionType === 'Over' ? 'O' : p.selectionType === 'Under' ? 'U' : '';
      console.log(
        '  ' +
          (p.league || '') +
          '  ' +
          (p.participant || '') +
          ' ' +
          dir +
          (p.line || '') +
          '  ' +
          (p.selection || '') +
          '  ' +
          (p.odds || '') +
          '  ' +
          valStr
      );
    }
    if (appPicks.length > 15) console.log('    ... and ' + (appPicks.length - 15) + ' more');
  }
}

// ── health ──────────────────────────────────────────────────────

async function cmdHealth(handlers) {
  const res = await handlers.health_status();
  console.log(JSON.stringify(res, null, 2));
}

// ── main ────────────────────────────────────────────────────────

async function main() {
  const filteredArgv = process.argv.filter((a) => a !== '--no-color' && a !== '--no-colour');
  const { positional, flags } = parseArgs(filteredArgv);

  // ── MCP server mode ──────────────────────────────
  if (flags.mcp || flags['mcp'] === true) {
    if (flags['mode']) process.env.PROPPROFESSOR_MCP_MODE = flags['mode'];
    if (flags['coalesce-ms']) process.env.PROPPROFESSOR_MCP_STDIO_COALESCE_MS = String(flags['coalesce-ms']);
    const { serveStdio } = require(PROJECT + '/scripts/propprofessor-mcp-server');
    return serveStdio().catch((err) => {
      console.error(err?.stack || err?.message || String(err));
      process.exit(1);
    });
  }

  if (!positional[0]) {
    printHelp('');
    process.exit(0);
  }
  const command = positional[0];

  // Help
  if (flags.h || flags.help) {
    const hasExplicitCmd = positional[0] !== undefined;
    if (hasExplicitCmd && positional[0] !== 'help') {
      printHelp(positional[0]);
    } else {
      printHelp(positional[1] || '');
    }
    process.exit(0);
  }
  if (command === 'help') {
    printHelp(positional[1] || '');
    process.exit(0);
  }

  // Backward compat: old pp-query commands
  const OLD_CMD_MAP = {
    doctor: 'health',
    sync: 'health',
    hide: 'log',
    unhide: 'log',
    hidden: 'picks'
  };
  const resolvedCmd = OLD_CMD_MAP[command];
  if (resolvedCmd) {
    console.error('Note: ' + command + ' is deprecated. Use "' + resolvedCmd + '" instead.');
  }

  const client = createPropProfessorClient();
  const handlers = createMcpHandlers({ client });

  const start = Date.now();

  switch (resolvedCmd || command) {
    case 'scan':
      await cmdScan(handlers, positional, flags, client);
      break;
    case 'validate':
      await cmdValidate(handlers, positional, flags);
      break;
    case 'game':
      await cmdGame(handlers, positional, flags);
      break;
    case 'today':
      await cmdToday(handlers, positional, flags);
      break;
    case 'picks':
      await cmdPicks(handlers, positional, flags);
      break;
    case 'log':
      await cmdLog(handlers, positional, flags);
      break;
    case 'record-card':
      await cmdRecordCard(positional, flags);
      break;
    case 'record':
      await cmdRecord(positional, flags);
      break;
    case 'player':
      await cmdPlayer(handlers, positional, flags);
      break;
    case 'prices':
      await cmdPrices(handlers, positional, flags);
      break;
    case 'rank':
      await cmdRank(handlers, positional, flags);
      break;
    case 'wallets':
      await cmdWallets(handlers, positional, flags);
      break;
    case 'fantasy':
      await cmdFantasy(handlers, positional, flags);
      break;
    case 'health':
      await cmdHealth(handlers);
      break;
    default:
      console.error('Unknown command: ' + (resolvedCmd || command));
      printHelp('');
      process.exit(1);
  }

  console.error('\nDone in ' + ((Date.now() - start) / 1000).toFixed(1) + 's');
}

if (require.main === module) {
  main().catch((e) => {
    const context = process.argv.slice(2).join(' ');
    console.error(formatError(e, context));
    process.exit(1);
  });
}

module.exports = {
  main,
  formatError,
  cmdScan,
  cmdGame,
  renderScanOutput,
  recordScanResults,
  cmdRecordCard,
  cmdRecord,
  resolveWalletDate,
  parseCardInput,
  formatScan,
  momentumLabel,
  openerContextLabel,
  oddsFmt
};
