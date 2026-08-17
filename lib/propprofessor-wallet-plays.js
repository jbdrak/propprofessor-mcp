'use strict';

// lib/propprofessor-wallet-plays.js — pure resolver + matcher + verdict for
// the `pp wallets` command. Turns raw Polymarket wallet stances
// ({ conditionId, title, outcome, dollar, eventSlug }) into ranked-scan rows
// they line up with, and grades those rows (BET/CONSIDER/PASS) with the same
// movement/tier/CLV rules the CLI uses for regular scan plays.
//
// Design notes:
//   - No I/O at module load. Market knowledge comes from the registry
//     (propprofessor-market-registry); stance math is pure string work.
//   - The fetch layer (leaderboard + per-wallet stances) lives in
//     propprofessor-poly-wallets and is bound via the module object at CALL
//     time (not destructured) so tests can swap it without require-order
//     games. `fetchWalletStances` output gains `eventSlug` via a sibling
//     change; this module codes against that contract and tolerates an empty
//     slug (those stances simply don't resolve to a league -> skipped).
//   - rankFn(league, marketName) is injected by the CLI/tool wiring; results
//     are cached per (league, marketName) within a single analysis run.
//   - Matching is deliberately conservative, mirroring the Elo/wallet overlay
//     philosophy: exact selection first, then game-containment with an exact
//     side-field tiebreaker.

const polyWallets = require('./propprofessor-poly-wallets');
const { getMarketsForSport, MARKET_REGISTRY } = require('./propprofessor-market-registry');
const { normForMatch } = polyWallets;

// --- slug -> league -----------------------------------------------------------

const SLUG_LEAGUE_MAP = {
  mlb: 'MLB',
  nba: 'NBA',
  nfl: 'NFL',
  nhl: 'NHL',
  wnba: 'WNBA',
  ncaab: 'NCAAB',
  ncaaf: 'NCAAF',
  nbasl: 'NBASL',
  mls: 'MLS',
  tennis: 'Tennis',
  ufc: 'UFC',
  soccer: 'Soccer',
  epl: 'Soccer'
};

/** League name from an event slug prefix ('mlb-mia-phi-2026-08-17' -> 'MLB'). */
function leagueFromSlug(slug) {
  const prefix = String(slug || '')
    .split('-')[0]
    .trim()
    .toLowerCase();
  if (!prefix) return null;
  return SLUG_LEAGUE_MAP[prefix] || null;
}

// --- title -> market kind ------------------------------------------------------

const OU_TOKEN_RE = /o\/u|\bover\b|\bunder\b/i;
const HAS_DIGIT_RE = /\d/;
const HANDICAP_RE = /\([+-]\d+(?:\.\d+)?\)/;
const MATCHUP_RE = /\s+vs\.?\s+|\s+@\s+/i;

/**
 * Which market family a Polymarket title belongs to:
 * 'moneyline' | 'total' | 'spread' | null (unresolvable).
 */
function marketKindFromTitle(title) {
  const t = String(title || '').trim();
  if (!t) return null;
  if (OU_TOKEN_RE.test(t) && HAS_DIGIT_RE.test(t)) return 'total';
  if (/^spread\s*:/i.test(t) || HANDICAP_RE.test(t)) return 'spread';
  if (MATCHUP_RE.test(t)) return 'moneyline';
  return null;
}

// --- (league, kind) -> market name ----------------------------------------------

const SPREAD_MARKET_RE = /run line|puck line|point spread|game handicap|match handicap|set handicap|spread/i;

/** Canonical market name for a (league, marketKind) pair; null for unknown league. */
function leagueMarketName(league, kind) {
  if (!league || !kind) return null;
  const upper = String(league).toUpperCase();
  const known = Object.keys(MARKET_REGISTRY).some((k) => k.toUpperCase() === upper);
  if (!known) return null;
  const list = getMarketsForSport(league) || [];
  if (kind === 'moneyline') return 'Moneyline';
  if (kind === 'total') {
    const hit = list.find((m) => /total/i.test(m));
    return hit || 'Total';
  }
  if (kind === 'spread') {
    const hit = list.find((m) => SPREAD_MARKET_RE.test(m));
    return hit || 'Spread';
  }
  return null;
}

// --- stance resolution ------------------------------------------------------------

const TOTAL_LINE_RE = /o\/u\s*(\d+(?:\.\d+)?)/i;
const SPREAD_LINE_RE = /\(([+-]?\d+(?:\.\d+)?)\)/;

function parseTotalLine(title) {
  const m = TOTAL_LINE_RE.exec(String(title || ''));
  return m ? Number(m[1]) : null;
}

function parseSpreadLine(title) {
  const m = SPREAD_LINE_RE.exec(String(title || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Resolve a raw wallet stance into { league, marketKind, selection, line }.
 * Returns null whenever any piece is unresolvable.
 */
function resolveStance(stance) {
  const s = stance || {};
  const league = leagueFromSlug(s.eventSlug);
  if (!league) return null;
  const marketKind = marketKindFromTitle(s.title);
  if (!marketKind) return null;
  const outcome = String(s.outcome || '').trim();

  if (marketKind === 'moneyline') {
    if (!outcome) return null;
    return { league, marketKind, selection: outcome, line: null };
  }
  if (marketKind === 'total') {
    const dir = outcome.toLowerCase();
    let selection;
    if (dir === 'over' || dir === 'o') selection = 'Over';
    else if (dir === 'under' || dir === 'u') selection = 'Under';
    else return null;
    const line = parseTotalLine(s.title);
    if (line === null) return null;
    return { league, marketKind, selection, line };
  }
  // spread
  if (!outcome) return null;
  const line = parseSpreadLine(s.title);
  if (line === null) return null;
  return { league, marketKind, selection: outcome, line };
}

// --- verdict -----------------------------------------------------------------------

function formatClvPct(clv) {
  const sign = clv >= 0 ? '+' : '';
  return sign + clv.toFixed(1) + '%';
}

/**
 * Grade a ranked row the same way the CLI grades scan plays.
 * Does NOT price the odds — heavy-odds banding is out of scope here.
 */
function verdictForRow(row) {
  const r = row || {};
  const mov = String(r.movementDisposition || '')
    .trim()
    .toLowerCase();
  const tier = String(r.confidenceTier || '')
    .trim()
    .toUpperCase();
  const clvRaw = r.recentClvPct;
  const clv = typeof clvRaw === 'number' ? clvRaw : String(clvRaw ?? '').trim() === '' ? NaN : Number(clvRaw);

  if (mov.startsWith('adverse')) {
    return { verdict: 'PASS', reason: `adverse movement (${String(r.movementDisposition || '').trim()})` };
  }
  if (mov === 'insufficient' || mov === '') {
    return { verdict: 'PASS', reason: 'insufficient movement data' };
  }
  if (mov === 'supportive_clean' || mov === 'supportive_bouncy') {
    const tierOk = tier === 'TIER 1' || tier === 'TIER 2';
    const clvOk = Number.isFinite(clv) && clv >= 0;
    if (tierOk && clvOk) {
      return { verdict: 'BET', reason: `${mov}, ${tier}, CLV ${formatClvPct(clv)}` };
    }
    const fails = [];
    if (!tierOk) fails.push('tier below TIER 2');
    if (!clvOk) fails.push('CLV below 0%');
    return { verdict: 'CONSIDER', reason: `supportive but ${fails.join(' or ')}` };
  }
  return { verdict: 'PASS', reason: `movement ${mov}` };
}

// --- matching ------------------------------------------------------------------------

const MATCHUP_SPLIT_RE = /\s+vs\.?\s+|\s+@\s+/i;

/** Normalized team names found in a matchup title (empty for non-matchup titles). */
function matchupTeamNorms(title) {
  return String(title || '')
    .split(MATCHUP_SPLIT_RE)
    .map((part) => normForMatch(part))
    .filter((part) => part.length >= 3);
}

/** 'Over 8.5' -> 'over'; 'Under 2.5' -> 'under'; anything else -> null. */
function rowDirection(value) {
  const lc = String(value || '').toLowerCase();
  if (lc.startsWith('over')) return 'over';
  if (lc.startsWith('under')) return 'under';
  return null;
}

/** Best-effort line number out of a total row's selection ('Over 8.5' -> 8.5). */
function rowLineFromSelection(value) {
  const m = /(?:over|under)\s*(\d+(?:\.\d+)?)/i.exec(String(value || ''));
  return m ? Number(m[1]) : null;
}

/** Explicit side fields a row may carry; exact-match tiebreaker for containment. */
function teamFieldsOf(row) {
  return [row.selection, row.homeTeam, row.awayTeam, row.participant1, row.participant2];
}

/**
 * Match one stance against the ranked rows of its market.
 * @returns {{ matched: true, row, marketName } | { matched: false }}
 */
function matchStanceToRow(stance, rows) {
  const resolved = resolveStance(stance);
  if (!resolved) return { matched: false };
  const { league, marketKind, selection, line } = resolved;
  const marketName = leagueMarketName(league, marketKind);
  if (!marketName) return { matched: false };
  const pool = (Array.isArray(rows) ? rows : []).filter(
    (row) => row && String(row.market || '').toLowerCase() === marketName.toLowerCase()
  );
  if (pool.length === 0) return { matched: false };

  if (marketKind === 'total') {
    const want = String(selection).toLowerCase();
    const teams = MATCHUP_SPLIT_RE.test(String(stance.title || '')) ? matchupTeamNorms(stance.title) : [];
    for (const row of pool) {
      if (rowDirection(row.selection) !== want) continue;
      if (row.game) {
        const gameNorm = normForMatch(row.game);
        if (teams.length && !teams.some((t) => gameNorm.includes(t))) continue;
      } else if (teams.length) {
        // no game reference on the row -> cannot confirm the same matchup
        continue;
      }
      // best-effort on the line: only reject when both sides have a number and
      // they are farther apart than a standard half-line step
      if (line !== null && line !== undefined) {
        const rowLine = rowLineFromSelection(row.selection);
        if (rowLine !== null && Math.abs(rowLine - line) > 1) continue;
      }
      return { matched: true, row, marketName };
    }
    return { matched: false };
  }

  // moneyline / spread: prefer an exact selection match...
  const selNorm = normForMatch(selection);
  if (!selNorm) return { matched: false };
  for (const row of pool) {
    if (normForMatch(row.selection || '') === selNorm) return { matched: true, row, marketName };
  }
  // ...then fall back to game containment with an exact side-field tiebreaker.
  for (const row of pool) {
    const gameNorm = normForMatch(row.game || '');
    if (!gameNorm || !gameNorm.includes(selNorm)) continue;
    const sideOk = teamFieldsOf(row).some((f) => f && normForMatch(f) === selNorm);
    if (sideOk) return { matched: true, row, marketName };
  }
  return { matched: false };
}

// --- analysis orchestration ----------------------------------------------------------

/**
 * Fetch top P&L wallets, resolve their stances, and line each stance up with
 * ranked rows from rankFn(league, marketName). Only wallets with at least one
 * matched stance are returned.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=20] - top-N wallets to scan
 * @param {string} [opts.book='NoVigApp'] - accepted for CLI parity; ranking is
 *   book-agnostic here
 * @param {Function} [opts.rankFn] - async (league, marketName) -> ranked rows
 * @param {Function} [opts.fetchImpl] - injected fetch for the wallet layer
 * @returns {Promise<Array<{ wallet, stances }>>}
 */
async function analyzeWalletPlays(opts) {
  const o = opts || {};
  const limit = o.limit == null ? 20 : o.limit;
  const rankFn = typeof o.rankFn === 'function' ? o.rankFn : () => [];

  const wallets = await polyWallets.fetchLeaderboard(limit, o);
  if (!Array.isArray(wallets) || wallets.length === 0) return [];
  const walletRows = await polyWallets.fetchWalletStancesAll(wallets, o);
  if (!Array.isArray(walletRows) || walletRows.length === 0) return [];

  const rankCache = new Map();
  const rowsFor = async (league, marketName) => {
    const key = league + '|' + marketName;
    if (rankCache.has(key)) return rankCache.get(key);
    let rows = [];
    try {
      const got = await rankFn(league, marketName);
      if (Array.isArray(got)) rows = got;
    } catch {
      // a failing rank call degrades to no rows for that market
    }
    rankCache.set(key, rows);
    return rows;
  };

  const out = [];
  for (const row of walletRows) {
    if (!row || !row.wallet || !Array.isArray(row.stances)) continue;
    const wallet = row.wallet;

    // Group resolvable stances by league|marketKind so each market's rows are
    // ranked once, preserving original stance order in the output.
    const groups = new Map();
    const stancesOut = [];
    for (const stance of row.stances) {
      const resolved = resolveStance(stance);
      if (!resolved) continue;
      const gkey = resolved.league + '|' + resolved.marketKind;
      let group = groups.get(gkey);
      if (!group) {
        group = { league: resolved.league, marketKind: resolved.marketKind, stances: [] };
        groups.set(gkey, group);
      }
      group.stances.push({ stance, resolved });
    }

    for (const group of groups.values()) {
      const marketName = leagueMarketName(group.league, group.marketKind);
      if (!marketName) continue;
      const rows = await rowsFor(group.league, marketName);
      for (const { stance, resolved } of group.stances) {
        const match = matchStanceToRow(stance, rows);
        stancesOut.push({
          conditionId: stance.conditionId,
          title: stance.title,
          outcome: stance.outcome,
          dollar: stance.dollar,
          eventSlug: stance.eventSlug,
          league: resolved.league,
          marketKind: resolved.marketKind,
          selection: resolved.selection,
          line: resolved.line,
          matched: match.matched,
          marketName,
          row: match.matched ? match.row : undefined,
          verdict: match.matched ? verdictForRow(match.row) : undefined
        });
      }
    }

    if (stancesOut.some((s) => s.matched)) {
      out.push({
        wallet: { proxyWallet: wallet.proxyWallet, userName: wallet.userName, pnl: wallet.pnl },
        stances: stancesOut
      });
    }
  }
  return out;
}

module.exports = {
  leagueFromSlug,
  marketKindFromTitle,
  leagueMarketName,
  resolveStance,
  verdictForRow,
  matchStanceToRow,
  analyzeWalletPlays
};
