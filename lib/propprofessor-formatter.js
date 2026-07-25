'use strict';

/**
 * Verbosity formatters for bet data.
 *
 * Converts raw bet objects into different output formats:
 * - minimal: Plain English for casual bettors
 * - standard: Structured data with verbose fields stripped (for intermediate bettors)
 * - full: Raw output (no transformation)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a confidence tier string to a human-readable confidence label.
 *
 * @param {string|*} tier - Confidence tier value (e.g. 'TIER 1', 'TIER 2').
 * @returns {string} Human-readable label: 'high confidence', 'moderate confidence', or 'low confidence'.
 */
function tierToConfidence(tier) {
  const t = String(tier || '').toUpperCase();
  if (t === 'TIER 1') return 'high confidence';
  if (t === 'TIER 2') return 'moderate confidence';
  return 'low confidence';
}

/**
 * Convert a numeric risk score into a human-readable risk label.
 *
 * @param {number|*} riskScore - Numeric risk score (0-10 scale).
 * @returns {string} Risk label: 'high risk', 'moderate risk', or 'low risk'.
 */
function riskScoreToLabel(riskScore) {
  const score = Number.isFinite(Number(riskScore)) ? Number(riskScore) : 0;
  if (score >= 7) return 'high risk';
  if (score >= 4) return 'moderate risk';
  return 'low risk';
}

/**
 * Determine the action verb based on the confidence tier.
 *
 * @param {string|*} tier - Confidence tier value (e.g. 'TIER 1', 'TIER 2').
 * @returns {string} Action verb: 'Bet' for tiers 1-2, 'Consider' otherwise.
 */
function actionWord(tier) {
  const t = String(tier || '').toUpperCase();
  if (t === 'TIER 1' || t === 'TIER 2') return 'Bet';
  return 'Consider';
}

/**
 * Format American odds with a leading '+' for positive values.
 *
 * @param {number|string|null|undefined} odds - American odds value.
 * @returns {string} Formatted odds string (e.g. '+105', '-120'), or empty string if invalid.
 */
function formatOdds(odds) {
  if (odds === null || odds === undefined || odds === '') return '';
  const n = Number(odds);
  if (!Number.isFinite(n)) return String(odds);
  // American odds: positive gets '+', negative keeps '-'
  return n > 0 ? `+${Math.round(n)}` : String(Math.round(n));
}

function safeString(val, fallback = '') {
  if (val === null || val === undefined) return fallback;
  return String(val);
}

// ---------------------------------------------------------------------------
// Minimal formatter (casual bettors)
// ---------------------------------------------------------------------------

/**
 * Generate a plain-English rationale string for minimal mode.
 *
 * @param {Object} bet - Bet object with selection, edge, confidenceTier, kaiCall, riskScore.
 * @returns {string} Plain-English rationale.
 */
function toRationale(bet = {}) {
  const selection = safeString(bet.selection || bet.participant || bet.pick, 'selection');
  const edge = bet.edge != null ? bet.edge : bet.consensusEdge;
  const edgeStr = Number.isFinite(Number(edge)) ? Number(edge).toFixed(1) : '?';
  const tier = String(bet.confidenceTier || bet.tier || '').toUpperCase();
  const kai = String(bet.kaiCall || '').toUpperCase();

  let base;
  if (tier === 'TIER 1' && kai === 'BET') {
    base = `Strong bet on ${selection}. ${edgeStr}% edge, low risk.`;
  } else if (tier === 'TIER 2' && kai === 'CONSIDER') {
    base = `Consider ${selection}. ${edgeStr}% edge, moderate risk.`;
  } else {
    base = `Skip ${selection}. Insufficient edge or high risk.`;
  }

  // Audit fix (2026-07-11): surface conflict context so the user knows WHY
  // a play was downgraded from TIER 1 BET to TIER 2 CONSIDER. resolveGameConflicts
  // sets `conflictWith` (opposing side that won) and `conflictFlag` (boolean).
  if (bet.conflictWith && (bet.conflictFlag || (kai !== 'BET' && tier !== 'TIER 1'))) {
    base += ` Downgraded — opposing side "${bet.conflictWith}" is the sharper pick on the same game.`;
  }
  return base;
}

/**
 * Format a single bet as a plain-English sentence.
 *
 * Example output:
 *   "Bet Bonfim at +105 (Bonfim vs Muhammad, UFC Moneyline). High confidence, low risk. Why: Sharp books agree, low injury risk."
 *
 * High-risk bets (riskScore >= 7) get a warning emoji (⚠️).
 *
 * @param {Object} [bet={}] - Bet object with fields like selection, odds, game, league, market, tier, riskScore, rationale.
 * @param {string} [bet.selection] - The player/team name to bet on.
 * @param {string} [bet.participant] - Alternative participant name (fallback for selection).
 * @param {string} [bet.pick] - Alternative pick name (fallback for selection).
 * @param {number} [bet.odds] - American odds for the bet.
 * @param {number} [bet.targetBookOdds] - Target book odds (fallback for odds).
 * @param {string} [bet.game] - Game/matchup description.
 * @param {string} [bet.league] - League name (e.g. 'NBA', 'UFC').
 * @param {string} [bet.market] - Market type (e.g. 'Moneyline').
 * @param {string} [bet.confidenceTier] - Confidence tier (e.g. 'TIER 1').
 * @param {string} [bet.tier] - Shorthand tier (fallback for confidenceTier).
 * @param {number} [bet.riskScore] - Risk score (0-10).
 * @param {string} [bet.rationale] - Explanation text.
 * @returns {string} Plain-English bet description sentence.
 */
function formatBetMinimal(bet = {}) {
  const selection = safeString(bet.selection || bet.participant || bet.pick, 'Unknown selection');
  const odds = formatOdds(bet.odds ?? bet.targetBookOdds);
  const game = safeString(bet.game, '');
  const league = safeString(bet.league, '');
  const market = safeString(bet.market, '');
  const tier = safeString(bet.confidenceTier || bet.tier, '');
  const riskScore = bet.riskScore;
  const rationale = safeString(bet.rationale || toRationale(bet), '');

  const confidence = tierToConfidence(tier);
  const riskLabel = riskScoreToLabel(riskScore);
  const action = actionWord(tier);

  const oddsStr = odds ? ` at ${odds}` : '';
  const gameStr = game ? ` (${game}${league || market ? `, ${[league, market].filter(Boolean).join(' ')}` : ''})` : '';
  const warning = Number.isFinite(Number(riskScore)) && Number(riskScore) >= 7 ? ' ⚠️' : '';

  const startTimeStr = bet.startCST ? `${bet.startCST}${bet.startNote ? ` (${bet.startNote})` : ''} — ` : '';

  let sentence = `${startTimeStr}${action} ${selection}${oddsStr}${gameStr}. ${capitalize(confidence)}, ${riskLabel}.${warning}`;
  if (rationale) {
    sentence += ` Why: ${rationale}`;
  }
  return sentence.trim();
}

/**
 * Format an array of bets as a numbered list.
 * Returns "No strong plays right now." if the array is empty.
 *
 * @param {Object[]} [bets=[]] - Array of bet objects to format.
 * @param {...*} bets[n] - Individual bet objects (see formatBetMinimal for structure).
 * @returns {string} Numbered list of bet sentences, or a fallback message if empty.
 */
function formatBetsMinimal(bets = []) {
  if (!Array.isArray(bets) || bets.length === 0) {
    return 'No strong plays right now.';
  }
  return bets.map((bet, i) => `${i + 1}. ${formatBetMinimal(bet)}`).join('\n');
}

// ---------------------------------------------------------------------------
// Standard formatter (intermediate bettors)
// ---------------------------------------------------------------------------

/**
 * Fields to keep in the standard output. Everything else (lineHistory,
 * scoreBreakdown, debug, oddsMap, etc.) is stripped.
 */
// ---------------------------------------------------------------------------
// Bets mode: agent-optimized compact shape (~10 fields per candidate).
// Disposition + verdict are consolidated into single fields so agents never
// reconcile kaiCall / displayTier / finalVerdict / validatedTier.
// ---------------------------------------------------------------------------

/** Resolve the single authoritative verdict for bets mode. */
function consolidateVerdict(candidate) {
  if (candidate.finalVerdict) return candidate.finalVerdict;
  if (candidate.displayTier) return candidate.displayTier;
  return candidate.kaiCall || 'PASS';
}

/** Map one candidate to the bets-mode shape. */
function formatBetCompact(bet = {}) {
  if (!bet || typeof bet !== 'object') return {};
  return {
    game: bet.game || `${bet.awayTeam || '?'} @ ${bet.homeTeam || '?'}`,
    startCST: bet.startCST || null,
    startNote: bet.startNote || null,
    selection: bet.selection || bet.participant || bet.pick || null,
    odds: bet.odds ?? bet.targetBookOdds ?? null,
    market: bet.market || null,
    league: bet.league || null,
    verdict: bet.finalVerdict || consolidateVerdict(bet),
    tier: bet.finalConfidenceTier || bet.confidenceTier || null,
    displayTier: bet.displayTier || null,
    movement: bet.validatedMovementDisposition || bet.movementDisposition || null,
    edge: bet.edge ?? bet.consensusEdge ?? null,
    books: bet.consensusBookCount ?? bet.validatedConsensusBookCount ?? 0,
    pinnacle: bet.sharpBookMovementConfirmed || false,
    steamMove: bet.steamMove || false,
    clvProxyPct: bet.clvProxyPct ?? bet.clv ?? null,
    lastMoveAgeMs: bet.lastMoveAgeMs ?? null,
    risk: bet.riskScore ?? null,
    rationale: bet.rationale || bet.validatedActionableSummary || null,
    flags: bet.validatedRiskFlags || [],
    finalConfidenceTier: bet.finalConfidenceTier || null,
    finalVerdict: bet.finalVerdict || null,
    kaiCall: bet.kaiCall || null,
    priceDrift: bet.priceDrift ?? null,
    finalWarnings: bet.finalWarnings || [],
    playId: bet.playId || null,
    selectionKey: bet.selectionKey || null
  };
}

/** Map an array of bets to the compact shape. */
function formatBetsCompact(bets = []) {
  if (!Array.isArray(bets)) return [];
  return bets.map(formatBetCompact);
}

/** Format a quick_screen response for bets mode. */
function formatQuickScreenBets(response = {}) {
  return {
    ok: true,
    totalCandidates: response.totalCandidates ?? 0,
    tierStats: response.tierStats || null,
    results: Array.isArray(response.results)
      ? response.results.map((entry) => {
          const plays = Array.isArray(entry.candidates) ? formatBetsCompact(entry.candidates) : [];
          // Carry league + market from the entry so each play is self-contained
          for (const p of plays) {
            p.league = entry.league || null;
            p.market = entry.market || null;
          }
          return { league: entry.league, market: entry.market, plays };
        })
      : []
  };
}

const STANDARD_KEEP_FIELDS = new Set([
  'selection',
  'participant',
  'pick',
  'odds',
  'targetBookOdds',
  'game',
  'gameId',
  'league',
  'market',
  'movementDisposition',
  'start',
  'startCST',
  'startNote',
  'tier',
  'confidenceTier',
  'displayTier',
  // Authoritative merged verdict (screen + validation). Keep so the
  // standard verbosity surfaces the real bet/no-bet call, not just the
  // screen snapshot.
  'finalVerdict',
  'finalConfidenceTier',
  'edge',
  'consensusEdge',
  'riskScore',
  'movementGrade',
  'kaiCall',
  'rationale',
  'consensusScore',
  'consensusBookCount',
  'screenScore',
  'executionQuality',
  'clv',
  'clvProxyPct',
  'consensusStrength',
  'tierTrajectory',
  'playId',
  'selectionKey',
  'homeTeam',
  'awayTeam',
  'isLive',
  'hoursUntilStart'
]);

/**
 * Fields that are explicitly verbose and must be stripped even if not in
 * the keep-list (belt-and-suspenders).
 */
const STANDARD_STRIP_FIELDS = new Set([
  'lineHistory',
  'scoreBreakdown',
  'debug',
  'oddsMap',
  'filteredLineHistory',
  'movementDebug',
  'passReasons',
  'nearMissDetails'
]);

/**
 * Format a single bet for standard output: keep key fields, strip verbose
 * debug payloads.
 *
 * @param {Object} [bet={}] - Raw bet object with optional verbose debug fields.
 * @param {string} [bet.selection] - The player/team name.
 * @param {string} [bet.participant] - Alternative participant name.
 * @param {string} [bet.pick] - Alternative pick name.
 * @param {number} [bet.odds] - American odds.
 * @param {number} [bet.targetBookOdds] - Target book odds.
 * @param {number} [bet.consensusEdge] - Consensus edge value.
 * @param {string} [bet.confidenceTier] - Confidence tier string.
 * @param {string} [bet.lineHistory] - Verbose line history (stripped).
 * @param {string} [bet.scoreBreakdown] - Verbose score breakdown (stripped).
 * @param {string} [bet.debug] - Verbose debug info (stripped).
 * @returns {Object} Filtered bet object containing only standard keep-fields.
 */
function formatBetStandard(bet = {}) {
  if (!bet || typeof bet !== 'object') return {};
  const out = {};
  for (const key of Object.keys(bet)) {
    if (STANDARD_STRIP_FIELDS.has(key)) continue;
    if (STANDARD_KEEP_FIELDS.has(key)) {
      out[key] = bet[key];
    }
  }
  // Ensure the key fields the spec calls out are always present (with safe defaults)
  if (out.selection === undefined && bet.participant !== undefined) out.selection = bet.participant;
  if (out.selection === undefined && bet.pick !== undefined) out.selection = bet.pick;
  if (out.odds === undefined && bet.targetBookOdds !== undefined) out.odds = bet.targetBookOdds;
  if (out.tier === undefined && bet.confidenceTier !== undefined) out.tier = bet.confidenceTier;
  if (out.edge === undefined && bet.consensusEdge !== undefined) out.edge = bet.consensusEdge;
  return out;
}

/**
 * Format an array of bets for standard output.
 *
 * @param {Object[]} [bets=[]] - Array of raw bet objects.
 * @returns {Object[]} Array of filtered bet objects with verbose fields stripped.
 */
function formatBetsStandard(bets = []) {
  if (!Array.isArray(bets)) return [];
  return bets.map(formatBetStandard);
}

// ---------------------------------------------------------------------------
// Response-level formatters
// ---------------------------------------------------------------------------

/**
 * Format a recommended_bets response for minimal output.
 *
 * @param {Object} [response={}] - Recommended bets API response.
 * @param {boolean} [response.ok] - Success flag.
 * @param {number} [response.totalRecommended] - Total recommended count.
 * @param {Object[]} [response.leagues] - Array of per-league result objects.
 * @param {string} [response.leagues[].league] - League name.
 * @param {number} [response.leagues[].count] - Number of plays for this league.
 * @param {Object[]} [response.leagues[].plays] - Array of bet objects for this league.
 * @returns {{summary: string, count: number}} Object with a plain-English summary string and total count.
 */
function formatRecommendedBetsMinimal(response = {}) {
  const leagues = Array.isArray(response.leagues) ? response.leagues : [];
  const allPlays = leagues.flatMap((l) =>
    Array.isArray(l.plays) ? l.plays.map((p) => ({ ...p, league: l.league })) : []
  );
  const summary = formatBetsMinimal(allPlays);
  return {
    summary,
    count: allPlays.length,
    type: allPlays.length > 0 ? 'plays' : 'no_plays'
  };
}

/**
 * Format a recommended_bets response for standard output.
 * Keeps league grouping but strips verbose fields from each play.
 *
 * @param {Object} [response={}] - Recommended bets API response.
 * @param {boolean} [response.ok] - Success flag.
 * @param {number} [response.totalRecommended] - Total recommended count.
 * @param {Object[]} [response.leagues] - Array of per-league result objects.
 * @param {*} response... - All other response fields are preserved.
 * @returns {Object} Response object with league plays filtered through standard formatting.
 */
function formatRecommendedBetsStandard(response = {}) {
  const leagues = Array.isArray(response.leagues) ? response.leagues : [];
  return {
    ...response,
    leagues: leagues.map((l) => ({
      ...l,
      plays: Array.isArray(l.plays) ? formatBetsStandard(l.plays) : []
    }))
  };
}

/**
 * Format a sharp_plays response for minimal output.
 *
 * @param {Object} [response={}] - Sharp plays API response.
 * @param {boolean} [response.ok] - Success flag.
 * @param {number} [response.count] - Number of plays.
 * @param {Object[]} [response.result] - Array of bet objects.
 * @returns {{summary: string, count: number}} Object with a plain-English summary string and total count.
 */
function formatSharpPlaysMinimal(response = {}) {
  const result = Array.isArray(response.result) ? response.result : [];
  const summary = formatBetsMinimal(result);
  return {
    summary,
    count: result.length,
    type: result.length > 0 ? 'plays' : 'no_plays'
  };
}

/**
 * Format a sharp_plays response for standard output.
 *
 * @param {Object} [response={}] - Sharp plays API response.
 * @param {boolean} [response.ok] - Success flag.
 * @param {number} [response.count] - Number of plays.
 * @param {Object[]} [response.result] - Array of raw bet objects.
 * @param {*} response... - All other response fields are preserved.
 * @returns {Object} Response object with result array filtered through standard formatting.
 */
function formatSharpPlaysStandard(response = {}) {
  return {
    ...response,
    result: Array.isArray(response.result) ? formatBetsStandard(response.result) : []
  };
}

/**
 * Format a screen_ranked response for minimal output.
 *
 * @param {Object} [response={}] - Screen ranked API response.
 * @param {boolean} [response.ok] - Success flag.
 * @param {Object[]} [response.result] - Array of ranked bet objects.
 * @returns {{summary: string, count: number}} Object with a plain-English summary string and total count.
 */
function formatScreenRankedMinimal(response = {}) {
  const result = Array.isArray(response.result) ? response.result : [];
  const summary = formatBetsMinimal(result);
  return {
    summary,
    count: result.length,
    type: result.length > 0 ? 'plays' : 'no_plays'
  };
}

/**
 * Format a screen_ranked response for standard output.
 *
 * @param {Object} [response={}] - Screen ranked API response.
 * @param {boolean} [response.ok] - Success flag.
 * @param {Object[]} [response.result] - Array of raw ranked bet objects.
 * @param {*} response... - All other response fields are preserved.
 * @returns {Object} Response object with result array filtered through standard formatting.
 */
function formatScreenRankedStandard(response = {}) {
  return {
    ...response,
    result: Array.isArray(response.result) ? formatBetsStandard(response.result) : []
  };
}

/**
 * Format a quick_screen response for minimal output.
 * Flattens all candidates across league/market groups.
 *
 * @param {Object} [response={}] - quick_screen API response.
 * @param {Object[]} [response.results] - Array of per-league/market result objects.
 * @param {string} [response.results[].league] - League name.
 * @param {string} [response.results[].market] - Market name.
 * @param {Object[]} [response.results[].candidates] - Array of candidate objects.
 * @returns {{summary: string, count: number}} Object with a plain-English summary string and total count.
 */
function formatQuickScreenMinimal(response = {}) {
  const results = Array.isArray(response.results) ? response.results : [];
  const allPlays = results.flatMap((entry) =>
    Array.isArray(entry.candidates)
      ? entry.candidates.map((c) => ({ ...c, league: entry.league, market: entry.market }))
      : []
  );

  if (!allPlays.length) {
    return { summary: 'No strong plays right now.', count: 0, type: 'no_plays' };
  }

  // Group by league then by game, cap at 2 plays per game to prevent truncation
  const byLeague = {};
  for (const play of allPlays) {
    const league = play.league || 'Unknown';
    if (!byLeague[league]) byLeague[league] = {};
    const game = play.game || 'Unknown';
    if (!byLeague[league][game]) byLeague[league][game] = [];
    byLeague[league][game].push(play);
  }

  const lines = [];
  for (const [league, games] of Object.entries(byLeague)) {
    lines.push(`\n── ${league} ──`);
    const gameEntries = Object.entries(games);
    for (const [, plays] of gameEntries) {
      // Show at most `cap` plays per game (highest screenScore first)
      // to keep output scannable. The agent can drill down with league/market filters
      // or raise maxPlaysPerGame for full coverage. Standard verbosity ignores this cap.
      const cap = Number.isFinite(Number(response.maxPlaysPerGame)) ? Number(response.maxPlaysPerGame) : 2;
      const sorted = [...plays].sort((a, b) => (Number(b.screenScore) || 0) - (Number(a.screenScore) || 0));
      const shown = sorted.slice(0, cap);
      for (const p of shown) {
        const selection = p.selection || '?';
        const odds = p.odds != null ? `${p.odds > 0 ? '+' : ''}${p.odds}` : 'N/A';
        const tier = p.confidenceTier || '';
        const edge = p.edge != null ? `${Number(p.edge).toFixed(1)}%` : '';
        const timeNote = p.startNote ? ` (${p.startNote})` : '';
        const time = p.startCST ? `${p.startCST}${timeNote}` : '';
        const game = p.game || '';
        const movement = p.movementDisposition || '';
        const timePrefix = time ? `${time} ` : '';
        lines.push(`${timePrefix}${game}: ${selection} at ${odds} | ${edge} | ${movement} | ${tier}`);
      }
      if (plays.length > shown.length) {
        lines.push(`  ... and ${plays.length - shown.length} more plays for this game`);
      }
    }
  }

  const summary = lines.join('\n');
  const out = { summary, count: allPlays.length, type: 'plays' };
  // Always include the structured plays array alongside the summary.
  // Agents need parseable data by default — the summary is the human-readable
  // annotation, the plays array is the machine-readable data.
  out.plays = allPlays.map((p) => ({
    league: p.league,
    market: p.market,
    game: p.game,
    gameId: p.gameId,
    playId: p.playId,
    selectionKey: p.selectionKey,
    selection: p.selection,
    odds: p.odds,
    confidenceTier: p.confidenceTier,
    finalConfidenceTier: p.finalConfidenceTier,
    displayTier: p.displayTier,
    finalVerdict: p.finalVerdict,
    edge: p.edge,
    startCST: p.startCST,
    startNote: p.startNote,
    hoursUntilStart: p.hoursUntilStart,
    movementDisposition: p.movementDisposition || p.validatedMovementDisposition,
    kaiCall: p.kaiCall,
    riskScore: p.riskScore,
    consensusBookCount: p.consensusBookCount ?? null,
    rationale: p.rationale || p.validatedActionableSummary
  }));
  if (response.cardWindowFallthrough) out.cardWindowFallthrough = true;
  if (response.nextDayMerged) {
    out.nextDayMerged = true;
    out.nextDayDate = response.nextDayDate || null;
    out.cardWindow = response.cardWindow || 'today';
  }
  return out;
}

/**
 * Format a quick_screen response for standard output.
 * Keeps the league/market grouping but strips verbose fields from each candidate.
 *
 * @param {Object} [response={}] - quick_screen API response.
 * @param {Object[]} [response.results] - Array of per-league/market result objects.
 * @param {*} response... - All other response fields are preserved.
 * @returns {Object} Response object with candidates filtered through standard formatting.
 */
function formatQuickScreenStandard(response = {}) {
  const out = {
    ...response,
    results: Array.isArray(response.results)
      ? response.results.map((entry) => ({
          ...entry,
          candidates: Array.isArray(entry.candidates) ? formatBetsStandard(entry.candidates) : []
        }))
      : []
  };
  // Carry the honest day-span flags so consumers see when next-day rows were merged
  if (response.cardWindowFallthrough) out.cardWindowFallthrough = true;
  if (response.nextDayMerged) {
    out.nextDayMerged = true;
    out.nextDayDate = response.nextDayDate || null;
  }
  return out;
}

/**
 * Format a get_play_details response for minimal output.
 *
 * @param {Object} [response={}] - get_play_details API response.
 * @param {boolean} [response.ok] - Success flag.
 * @param {Object[]} [response.result] - Array of detailed bet row objects.
 * @returns {{summary: string, count: number}} Object with a plain-English summary string and total count.
 */
function formatGetPlayDetailsMinimal(response = {}) {
  const result = Array.isArray(response.result) ? response.result : [];
  const summary = formatBetsMinimal(result);
  return {
    summary,
    count: result.length,
    type: result.length > 0 ? 'plays' : 'no_plays',
    matchedRows: response.resultMeta?.matchedRows ?? result.length
  };
}

/**
 * Format a get_play_details response for standard output.
 * Strips verbose payloads but keeps structured data rows.
 *
 * @param {Object} [response={}] - get_play_details API response.
 * @param {boolean} [response.ok] - Success flag.
 * @param {Object[]} [response.result] - Array of raw detailed bet row objects.
 * @param {*} response... - All other response fields are preserved.
 * @returns {Object} Response object with result array and resultMeta filtered through standard formatting.
 */
function formatGetPlayDetailsStandard(response = {}) {
  return {
    ...response,
    result: Array.isArray(response.result) ? formatBetsStandard(response.result) : []
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function capitalize(str) {
  const s = String(str || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = {
  // Single-bet formatters
  formatBetMinimal,
  formatBetStandard,
  formatBetCompact,
  // Array formatters
  formatBetsMinimal,
  formatBetsStandard,
  formatBetsCompact,
  // Response-level formatters
  formatGetPlayDetailsMinimal,
  formatGetPlayDetailsStandard,
  formatRecommendedBetsMinimal,
  formatRecommendedBetsStandard,
  formatSharpPlaysMinimal,
  formatSharpPlaysStandard,
  formatScreenRankedMinimal,
  formatScreenRankedStandard,
  formatQuickScreenMinimal,
  formatQuickScreenStandard,
  formatQuickScreenBets,
  // Helpers (exported for testing)
  tierToConfidence,
  riskScoreToLabel,
  actionWord,
  formatOdds,
  consolidateVerdict,
  STANDARD_KEEP_FIELDS,
  STANDARD_STRIP_FIELDS
};
