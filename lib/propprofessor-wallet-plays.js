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

// Polymarket slug prefixes -> canonical league name.
//
// ATP/WTA/ITF singles matches use `atp-*`, `wta-*`, `itf-*` prefixes (not
// `tennis-*`, which is reserved for tournament-winner futures). Liga MX and
// Brazilian soccer use `mex-*` / `bra-*`. Esports use `lol-*` / `cs2-*`.
// Prefixes not listed here resolve to null -> stance silently dropped;
// the diagnostic footer in `pp wallets` reports the drop counts.
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
  atp: 'Tennis',
  wta: 'Tennis',
  itf: 'Tennis',
  ufc: 'UFC',
  soccer: 'Soccer',
  epl: 'Soccer',
  mex: 'Soccer',
  bra: 'Soccer',
  lol: 'LoL',
  cs2: 'CS2'
};

// Date regex for eventSlug trailing segments like `mlb-sea-hou-2026-08-16`.
const DATE_RE = /(\d{4})-(\d{2})-(\d{2})$/;

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

/**
 * Normalized team names found in a matchup title (empty for non-matchup titles).
 * Handles tournament-prefix and market-suffix shapes uniformly:
 *   "Cincinnati Open: Brandon Nakashima vs Daniil Medvedev" -> [BRANDON NAKASHIMA, DANIIL MEDVEDEV]
 *   "Lehecka vs. Fils: Match O/U 22.5"                        -> [LEHECKA, FILS]
 * Each part is truncated at the first ":" so the matchup survives either
 * layout; parts shorter than 3 chars are dropped.
 */
function matchupTeamNorms(title) {
  return String(title || '')
    .split(MATCHUP_SPLIT_RE)
    .map((part) => part.split(':')[0])
    .map((part) => normForMatch(part))
    .filter((part) => part.length >= 3);
}

/** Surname (last whitespace token) of a normalized name; '' when absent. */
function surnameNorm(value) {
  const norm = normForMatch(value);
  if (!norm) return '';
  const tokens = norm.split(/\s+/);
  return tokens[tokens.length - 1] || '';
}

/**
 * Candidate surnames for a name, in preference order. Handles apostrophe names
 * where normalization splits a prefix letter off: "O'Connell" -> normForMatch
 * "O CONNELL" -> candidates ["OCONNELL", "CONNELL"] (second-to-last token is a
 * single letter = the O'/D'/Mc' pattern). Plain names yield one candidate:
 * "Brandon Nakashima" -> ["NAKASHIMA"].
 */
function surnameCandidates(value) {
  const norm = normForMatch(value);
  if (!norm) return [];
  const tokens = norm.split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (!last) return [];
  const joined = tokens.length >= 2 && tokens[tokens.length - 2].length === 1 ? tokens[tokens.length - 2] + last : null;
  return joined && joined !== last ? [joined, last] : [last];
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
        // surname-aware team containment: a team norm matches if one of its
        // candidate surnames appears in the game string ("BRANDON NAKASHIMA"
        // -> NAKASHIMA in "MEDVEDEV VS NAKASHIMA"; "O'CONNELL" -> OCONNELL)
        if (teams.length && !teams.some((t) => surnameCandidates(t).some((sn) => gameNorm.includes(sn)))) continue;
      } else if (teams.length) {
        // no game reference on the row -> cannot confirm the same matchup
        continue;
      }
      // best-effort on the line: only reject when both sides have a number and
      // they are farther apart than a standard half-line step
      if (line !== null && line !== undefined) {
        const rowLine = rowLineFromSelection(row.selection);
        if (rowLine !== null && Math.abs(rowLine - line) > 0.5) continue;
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
  // ...then game containment with a surname-aware strict side check: the stance
  // surname must appear in the game string AND the row's OWN selection must
  // carry that surname ("Brandon Nakashima" <-> row game "Medvedev vs Nakashima"
  // selection "Nakashima"). Checking teamFieldsOf broadly is wrong: the game
  // string contains BOTH players, so a Medvedev stance would "match" a
  // Nakashima row. Same-surname caveat: PP rows carry last names only, so two
  // same-surname players in different matches same day can still cross-match
  // (e.g. Francisco vs Juan Manuel Cerundolo); the game-string check is the
  // only available disambiguator and is applied where data allows.
  const selSurnames = surnameCandidates(selection);
  for (const row of pool) {
    const gameNorm = normForMatch(row.game || '');
    if (!gameNorm) continue;
    if (selSurnames.some((sn) => gameNorm.includes(sn))) {
      const sideOk = selSurnames.includes(surnameNorm(row.selection || ''));
      if (sideOk) return { matched: true, row, marketName };
    }
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
 * @param {string} [opts.league] - only consider stances in this league
 *   ('Tennis', 'MLB', ...; case-insensitive)
 * @param {string} [opts.date] - only consider stances whose eventSlug carries
 *   this trailing date ('YYYY-MM-DD'); non-parsing slugs are dropped
 * @param {Function} [opts.rankFn] - async (league, marketName) -> ranked rows
 * @param {Function} [opts.exactFn] - async (league, marketName, gameId, book) -> exact per-game rows (authoritative tier/movement). When provided, matched stances are re-graded against these exact rows so degraded scan labels never dictate a verdict.
 * @param {Function} [opts.fetchImpl] - injected fetch for the wallet layer
 * @returns {Promise<{ wallets: Array<{ wallet, stances }>, gameTallies: Array<{ game, side, usd, wallets }>, droppedByPrefix: Array<{prefix, count, example}>, nonSportsDropped: number }>}
 */
async function analyzeWalletPlays(opts) {
  const o = opts || {};
  const limit = o.limit == null ? 20 : o.limit;
  const rankFn = typeof o.rankFn === 'function' ? o.rankFn : () => [];
  const exactFn = typeof o.exactFn === 'function' ? o.exactFn : null;
  const book = o.book || 'NoVigApp';
  // --league / --date filters: applied AFTER resolveStance so league names are
  // canonical ('Tennis', 'MLB') and the slug date is the market's own date.
  const wantLeague = o.league ? String(o.league).trim().toLowerCase() : null;
  const wantDate = o.date ? String(o.date).trim() : null; // 'YYYY-MM-DD'

  const wallets = await polyWallets.fetchLeaderboard(limit, o);
  if (!Array.isArray(wallets) || wallets.length === 0)
    return { wallets: [], gameTallies: [], droppedByPrefix: [], nonSportsDropped: 0 };
  const walletRows = await polyWallets.fetchWalletStancesAll(wallets, o);
  if (!Array.isArray(walletRows) || walletRows.length === 0)
    return { wallets: [], gameTallies: [], droppedByPrefix: [], nonSportsDropped: 0 };

  // Diagnostic: track stances dropped because their slug prefix is unmapped.
  // Reported by the CLI footer so "why did I only see 1 wallet?" is answerable.
  const droppedByPrefix = new Map();

  // Prefixes for markets PP doesn't scan (crypto, politics, weather, etc.).
  // These aren't bugs — they're out of scope. Filtering them keeps the footer
  // focused on real gaps (missing sport prefixes) instead of noise.
  const NON_SPORTS_PREFIXES = new Set([
    'what',
    'fed',
    'bitcoin',
    'highest',
    'lowest',
    'elon',
    'kazakhstan',
    'south',
    'spider',
    '2026',
    '2nd',
    'largest',
    'fl',
    'us',
    'republican',
    'iran',
    'strait',
    'the',
    'presidential',
    'who',
    'best',
    '1',
    'bra'
  ]);

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
      if (!resolved) {
        // Track dropped stances by slug prefix for the diagnostic footer.
        const prefix = String(stance.eventSlug || '')
          .split('-')[0]
          .trim()
          .toLowerCase();
        if (prefix) {
          const cur = droppedByPrefix.get(prefix) || { prefix, count: 0, example: '' };
          cur.count++;
          if (!cur.example) cur.example = String(stance.title || '').slice(0, 60);
          droppedByPrefix.set(prefix, cur);
        }
        continue;
      }
      // League filter (applies after resolve so league names are canonical).
      if (wantLeague && resolved.league.toLowerCase() !== wantLeague) continue;
      // Date filter: only keep stances whose eventSlug carries the target date.
      if (wantDate) {
        const slugDate = String(stance.eventSlug || '').match(DATE_RE);
        if (!slugDate || slugDate[0] !== wantDate) continue;
      }
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
        // Re-grade a matched stance from the EXACT per-game quote when an
        // exactFn is provided. The broad-scan screen_ranked row can carry
        // degraded tier/movement labels (the shared odds-history budget gets
        // exhausted mid-scan, dropping rows to TIER 4 / insufficient), while
        // the exact get_play_details lookup returns the authoritative values.
        // This is the same "trust pp game over the scan" rule the manual
        // workflow follows — here it's automatic.
        let displayRow = match.matched ? match.row : undefined;
        let baseVerdict = match.matched ? verdictForRow(match.row) : undefined;
        if (match.matched && typeof exactFn === 'function' && match.row.gameId) {
          try {
            const exactRows = await exactFn(resolved.league, marketName, match.row.gameId, book);
            if (Array.isArray(exactRows)) {
              const exactMatch = matchStanceToRow(stance, exactRows);
              if (exactMatch.matched && exactMatch.row) {
                displayRow = exactMatch.row;
                baseVerdict = verdictForRow(exactMatch.row);
              }
            }
          } catch {
            // exact recheck fails -> fall back to the scan row
          }
        }
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
          row: displayRow,
          exact: match.matched && displayRow !== match.row,
          verdict: baseVerdict
        });
      }
    }

    if (stancesOut.some((s) => s.matched) || stancesOut.some((s) => s.league)) {
      out.push({
        wallet: { proxyWallet: wallet.proxyWallet, userName: wallet.userName, pnl: wallet.pnl },
        stances: stancesOut
      });
    }
  }

  // Filter out non-sports prefixes (crypto, politics, weather) — they're
  // out of scope, not bugs. Keep a count so the CLI footer can mention them.
  const sportsDropped = [];
  let nonSportsCount = 0;
  for (const entry of droppedByPrefix.values()) {
    if (NON_SPORTS_PREFIXES.has(entry.prefix)) {
      nonSportsCount += entry.count;
    } else {
      sportsDropped.push(entry);
    }
  }
  // Per-game whale aggregation: sum matched stance dollars by (game, side)
  // across ALL wallets, so split money ("Fonseca $5.4K for / $9.2K against")
  // is visible in one line instead of buried across wallet sections.
  const tallyByGame = new Map();
  for (const walletEntry of out) {
    for (const s of walletEntry.stances || []) {
      if (!s.matched || !s.row) continue;
      const gameName = s.row.game || s.title || '?';
      const sideName = s.selection || s.outcome || '?';
      const key = gameName + '\u0000' + sideName;
      const cur = tallyByGame.get(key) || { game: gameName, side: sideName, usd: 0, wallets: 0 };
      cur.usd += Number(s.dollar) || 0;
      cur.wallets += 1;
      tallyByGame.set(key, cur);
    }
  }
  const gameTallies = [...tallyByGame.values()]
    .sort((a, b) => b.usd - a.usd)
    .map((t) => ({ ...t, usd: Math.round(t.usd) }));

  return {
    wallets: out,
    gameTallies,
    droppedByPrefix: sportsDropped,
    nonSportsDropped: nonSportsCount
  };
}

module.exports = {
  leagueFromSlug,
  marketKindFromTitle,
  leagueMarketName,
  resolveStance,
  verdictForRow,
  surnameCandidates,
  matchStanceToRow,
  analyzeWalletPlays
};
