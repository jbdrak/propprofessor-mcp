'use strict';

const {
  INSUFFICIENT_HISTORY_UPGRADE,
  BOUNCY_GREEN_UPGRADE,
  GREEN_GATE,
  GREEN_GATE_MLB
} = require('./propprofessor-consensus-thresholds');

/**
 * Phase 2: Movement Quality Grade & Qualitative Risk Score
 *
 * Synthesizes all existing signals (movementQuality, movementLabel, edge,
 * consensus, steam, executionQuality, CLV) into:
 * 1. movementGrade — green / yellow / red (at-a-glance quality)
 * 2. riskScore — 1–10 (lower = better, 1 = cleanest)
 * 3. kaiCall — BET / CONSIDER / PASS (actionable recommendation)
 *
 * Phase 3+: Tier Stability (Hysteresis)
 * Raw tiers are noisy — small odds movements can flip a play between TIER 2
 * and TIER 3 multiple times in an hour. The stable tier system adds:
 * - Wider tier boundaries with dead zones between tiers
 * - A per-play cache that holds the last assigned tier
 * - Hysteresis: a tier only changes if the new tier is 2+ levels away
 *   OR the risk score moved by 3+ points since last assignment
 */

/**
 * Module-level tier cache for hysteresis.
 * Maps tierCacheKey -> { tier: string, riskScore: number, timestamp: number }
 * Cleared at the start of each MCP tool call to avoid cross-request bleed.
 * @type {Map<string, { tier: string, riskScore: number, timestamp: number }>}
 */
const tierCache = new Map();

/**
 * Module-level score timeline cache for evolving tier computation.
 * Persists across requests (NOT cleared per tool call) to track how each play's
 * risk score and tier evolve over time. Entries older than TIMELINE_WINDOW_MS
 * are purged on each access.
 *
 * Maps tierCacheKey -> Array<{ timestamp: number, riskScore: number, tier: string }>
 * @type {Map<string, Array<{ timestamp: number, riskScore: number, tier: string }>>}
 */
const scoreTimeline = new Map();

/** Max age for cached tier entries (10 minutes). */
const TIER_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

/** Rolling window for score timeline (2 hours). */
const TIMELINE_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Generate a stable cache key for a play from an enriched row.
 *
 * Audit fix (2026-07-11): the key MUST distinguish two different lines on
 * the same game/market (e.g. Under 166.5 vs Under 168.5). Previously the
 * key used only `selection` (which is "Under" for both), so the score
 * timeline's mode-of-observations voted across unrelated lines and
 * reported a misleading "evolving tier". Now we prefer playId (which
 * encodes the line), and fall back to a key that includes `line` for
 * totals/spreads. We also drop the matchup-string fallback when gameId
 * is missing (regression of June 2026 audit finding #2).
 *
 * @param {Object} item — Enriched row
 * @returns {string|null} Cache key or null if insufficient data
 */
function tierCacheKey(item = {}) {
  const row = item.row || item;
  // Canonical: playId encodes league + gameId + market + selection + line.
  if (row.playId) return `playId:${String(row.playId).toLowerCase()}`;
  const gameId = String(row.gameId || '').trim();
  if (!gameId) return null; // no gameId → no cache (was: matchup fallback, which collided)
  const selection = row.selection || row.participant || row.pick || '';
  if (!selection) return null;
  const market = row.market || row.playType || row.betType || '';
  const league = row.league || row.sport || row.gameType || '';
  // Include the line for totals/spreads so distinct lines get distinct keys.
  const line = row.line != null ? `@${row.line}` : '';
  return `${league}|${gameId}|${selection}|${market}${line}`.toLowerCase();
}

/**
 * Clear the tier cache. Called at the start of each MCP tool call
 * so each request computes tiers from scratch but stabilizes within
 * a single multi-league screen (e.g. all_slates across NBA+MLB+NHL).
 * Does NOT clear the score timeline — that persists across requests.
 */
function clearTierCache() {
  tierCache.clear();
}

/**
 * Clear the score timeline cache. Use when you want to reset all
 * historical tier tracking (e.g. new session, config change).
 */
function clearScoreTimeline() {
  scoreTimeline.clear();
}

/**
 * Get the score timeline entries for a play, purging stale entries.
 * @param {string} key - Tier cache key
 * @returns {Array<{ timestamp: number, riskScore: number, tier: string }>}
 */
function getTimelineEntries(key) {
  if (!scoreTimeline.has(key)) return [];
  const now = Date.now();
  const entries = scoreTimeline.get(key).filter((e) => now - e.timestamp <= TIMELINE_WINDOW_MS);
  scoreTimeline.set(key, entries);
  return entries;
}

/**
 * Purge stale entries from the tier cache (older than TIER_CACHE_MAX_AGE_MS).
 */
function purgeStaleTierCache() {
  const now = Date.now();
  for (const [key, entry] of tierCache) {
    if (now - entry.timestamp > TIER_CACHE_MAX_AGE_MS) {
      tierCache.delete(key);
    }
  }
}

/**
 * Grade the overall movement quality into green/yellow/red.
 *
 * @param {Object} item — Enriched row from rankScreenRows output
 * @returns {string} 'green' | 'yellow' | 'red'
 */
function gradeMovementQuality(item = {}) {
  // Tennis rows (from runTennisScreen) use a different field vocabulary than
  // NBA/MLB: `movementGrade` (red/yellow/green) instead of `movementLabel`
  // (adverse/supportive), and `movementDisposition` (adverse_full/supportive_clean)
  // instead of the bare label. Map tennis vocab onto the shared `movementLabel`
  // so the grader's RED/GREEN checks work for both.
  const movementGradeRaw = String(item.movementGrade || '')
    .trim()
    .toLowerCase();
  const movementDisposition = String(item.movementDisposition || '')
    .trim()
    .toLowerCase();
  let movementLabel = String(item.movementLabel || item.movementSummary?.movementLabel || '')
    .trim()
    .toLowerCase();
  if (!movementLabel) {
    if (movementGradeRaw === 'green') movementLabel = 'supportive';
    else if (movementGradeRaw === 'red') movementLabel = 'adverse';
    else if (movementGradeRaw === 'yellow') movementLabel = 'yellow';
    else if (movementDisposition.includes('adverse')) movementLabel = 'adverse';
    else if (movementDisposition.includes('supportive')) movementLabel = 'supportive';
    else {
      const mov = String(item.movement || '')
        .trim()
        .toLowerCase();
      if (mov.includes('adverse')) movementLabel = 'adverse';
      else if (mov.includes('supportive')) movementLabel = 'supportive';
      else if (mov === 'insufficient') movementLabel = 'insufficient_history';
    }
  }
  const movementQuality = String(item.movementQuality || item.movementSummary?.movementQuality || '')
    .trim()
    .toLowerCase();
  const movementQualityScore = Number(item.movementQualityScore ?? item.movementSummary?.movementQualityScore ?? 0);
  const executionQuality = String(item.executionQuality || '')
    .trim()
    .toLowerCase();
  const consensusBookCount = Number(item.consensusBookCount || Object.keys(item.allBookOdds || {}).length || 0);
  const steamMove = Boolean(item.steamMove);
  const clvPct = Number(item.clvProxyPct ?? item.clv ?? 0);
  const league = String(item.league || '').toUpperCase();
  // multiWindowScore is 0 when there's no line history — don't punish absence of data.
  const multiWindowInsufficientData = Boolean(item.multiWindowInsufficientData);
  const multiWindowScore = multiWindowInsufficientData ? null : Number(item.multiWindowScore ?? 0);

  // Check for RED conditions first (hard fails)
  const adverseMovement = movementLabel === 'adverse';
  const badExecution = executionQuality === 'bad' || executionQuality === 'unknown';
  const thinConsensus = consensusBookCount < 2;
  // Only RED for genuinely adverse signals — insufficient history alone is yellow, not red.
  // Previously this was RED, but it buried ~50% of plays with no history data as TIER 4
  // even when they were coin-flip plays. Now only RED when there's a real negative signal.

  if (adverseMovement || (badExecution && thinConsensus)) {
    return 'red';
  }

  // Check for GREEN conditions (all must pass)
  let supportiveLabel = movementLabel === 'supportive' || movementLabel === 'recent_supportive_only';

  // Consensus-as-signal: when odds history is too thin to grade movement
  // (insufficient_history) but 10+ sharp books independently agree on the
  // price, the consensus itself is a reliable directional signal. Common in
  // lower-volume leagues (WNBA, tennis challengers) where line history data
  // is sparse but book agreement is real. Upgrade to supportive for tiering.
  const strongConsensusThreshold = consensusBookCount >= INSUFFICIENT_HISTORY_UPGRADE;
  const insufficientHistory = movementLabel === 'insufficient_history';
  const hasPositiveClv = clvPct > 0;
  const hasPlayableExec = executionQuality === 'best' || executionQuality === 'playable';

  if (insufficientHistory && strongConsensusThreshold && hasPositiveClv && hasPlayableExec) {
    supportiveLabel = true;
  }

  // Bouncy-but-strong: supportive_bouncy = line IS moving the right direction,
  // just with noise in the path. When 12+ books agree AND Pinnacle is in the
  // consensus, the directional signal is real — the noise is just microstructure.
  // Skip the fussy quality/steam/CLV checks; the books ARE the signal.
  const isBouncy = movementLabel === 'supportive_bouncy' || movementDisposition.includes('supportive_bouncy');
  const bouncyStrongConsensus = consensusBookCount >= BOUNCY_GREEN_UPGRADE && Boolean(item.pinnacle);
  if (isBouncy && bouncyStrongConsensus && hasPlayableExec) {
    return 'green';
  }

  const highQuality = movementQuality === 'high' || movementQualityScore >= 0.8;
  const acceptableExecution = executionQuality === 'best' || executionQuality === 'playable';
  const strongConsensus = league === 'MLB' ? consensusBookCount >= GREEN_GATE_MLB : consensusBookCount >= GREEN_GATE;
  const strongSteam = steamMove || movementQualityScore >= 0.7;
  const positiveClv = clvPct > 0 || steamMove;
  // Sustained agreement: 4+ of 6 windows with all sharp books moving the same direction.
  // If no multi-window data is available, do not block GREEN — fall back to existing checks.
  const sustainedAgreement = multiWindowInsufficientData || multiWindowScore === null || multiWindowScore >= 0.66;

  // V-Shaped Recovery Detection
  // When the line went through significant adverse territory (peakAdverseClvPct < -2%)
  // even though endpoints recovered, the movement is less clean than "green" implies.
  // Downgrade green→yellow to flag the uncertainty.
  const peakAdverseClv = Number(item.peakAdverseClvPct ?? item.movementSummary?.peakAdverseClvPct ?? 0);
  const isVShapedRecovery = peakAdverseClv < -2 && positiveClv;

  // Steam-Exempt Green: when movement is supportive, 3+ MLB books agree,
  // CLV is positive, and execution is playable, the directional signal is
  // real even without a detected steam move. Steam is rare in totals/player
  // props — don't penalize clean supportive movement for lack of it.
  const steamExemptGreen =
    supportiveLabel &&
    consensusBookCount >= 3 &&
    positiveClv &&
    acceptableExecution &&
    !isVShapedRecovery &&
    sustainedAgreement;

  if (
    supportiveLabel &&
    highQuality &&
    acceptableExecution &&
    strongConsensus &&
    strongSteam &&
    positiveClv &&
    sustainedAgreement &&
    !isVShapedRecovery
  ) {
    return 'green';
  }

  // Steam-exempt path: skip the highQuality and strongSteam checks when
  // supportive movement + strong consensus + positive CLV are confirmed.
  if (steamExemptGreen) {
    return 'green';
  }

  // YELLOW — everything else that isn't red
  return 'yellow';
}

/**
 * Calculate a qualitative risk score from 1 (cleanest) to 10 (riskiest).
 *
 * Weighted factors:
 * - Base: 5
 * - Movement quality: green=-2, normal=0, red=+3
 * - Edge: >2%=-1, >0.5%=0, <0.5%=+1, none=+2
 * - Consensus: >=10=-1, >=3=0, <3=+1, <2=+2
 * - Execution quality: best=-1, playable=0, bad/unknown=+2
 * - Steam: supportive steam=-1, no steam=0, adverse steam=+3
 * - CLV: >0=-1, 0..-1=0, <-1=+1, <-3=+2
 *
 * @param {Object} item — Enriched row from rankScreenRows output
 * @returns {number} 1–10 risk score (1 = cleanest)
 */
function calculateRiskScore(item = {}) {
  const movementGrade = gradeMovementQuality(item);
  // Mirror gradeMovementQuality's tennis-aware label resolution so steam
  // direction checks below use the same label the grader computed.
  const movementGradeRaw = String(item.movementGrade || '')
    .trim()
    .toLowerCase();
  const movementDisposition = String(item.movementDisposition || '')
    .trim()
    .toLowerCase();
  let movementLabel = String(item.movementLabel || item.movementSummary?.movementLabel || '')
    .trim()
    .toLowerCase();
  if (!movementLabel) {
    if (movementGradeRaw === 'green') movementLabel = 'supportive';
    else if (movementGradeRaw === 'red') movementLabel = 'adverse';
    else if (movementGradeRaw === 'yellow') movementLabel = 'yellow';
    else if (movementDisposition.includes('adverse')) movementLabel = 'adverse';
    else if (movementDisposition.includes('supportive')) movementLabel = 'supportive';
  }
  const executionQuality = String(item.executionQuality || '')
    .trim()
    .toLowerCase();
  const consensusBookCount = Number(item.consensusBookCount || Object.keys(item.allBookOdds || {}).length || 0);
  const steamMove = Boolean(item.steamMove);
  const clvPct = Number(item.clvProxyPct ?? item.clv ?? 0);
  const edge = Number(item.consensusEdge ?? item.edge ?? -999);
  const sharpConfirmed = Boolean(item.sharpBookMovementConfirmed);
  const steamDirection = String(item.steamDirection || '')
    .trim()
    .toLowerCase();
  // multiWindowScore is null when there's no line history — no modifier in that case.
  const multiWindowInsufficientData = Boolean(item.multiWindowInsufficientData);
  const multiWindowScore = multiWindowInsufficientData ? null : Number(item.multiWindowScore ?? 0);

  let score = 5;

  // Movement quality
  if (movementGrade === 'green') score -= 2;
  else if (movementGrade === 'red') score += 3;

  // Edge size
  if (edge > 2) score -= 1;
  else if (edge > 0.5) score += 0;
  else if (edge > 0) score += 1;
  else if (edge === -999 || edge <= 0) score += 2;

  // Consensus depth
  if (consensusBookCount >= 10) score -= 1;
  else if (consensusBookCount >= 5) score += 0;
  else if (consensusBookCount >= 3) score += 1;
  else if (consensusBookCount >= 1) score += 2;
  else score += 3;

  // Execution quality
  if (executionQuality === 'best') score -= 1;
  else if (executionQuality === 'playable') score += 0;
  else score += 2;

  // Steam — strongest future-CLV signal (rapid coordinated sharp money)
  if (steamMove && movementLabel === 'supportive') score -= 2;
  else if (steamMove && steamDirection === 'adverse') score += 3;
  else if (steamMove) score += 0;
  // No steam = neutral, already factored via movement quality

  // Sharp book cross-confirmation — independent sharp books agree.
  // This is a conviction signal: Pinnacle, Circa, BookMaker, BetOnline
  // all moved the same direction = high confidence play.
  if (sharpConfirmed && movementLabel === 'supportive') score -= 1;

  // CLV — strong weighting (primary signal)
  if (clvPct > 3) score -= 2;
  else if (clvPct > 1.5) score -= 1.5;
  else if (clvPct > 0) score -= 1;
  else if (clvPct > -1) score += 0;
  else if (clvPct > -3) score += 1.5;
  else score += 3;

  // Recency weighting: recent movement is more predictive than stale movement.
  // A play that moved 30 minutes ago is a stronger signal than one that moved 10 hours ago.
  const lastMoveAgeMs = Number(item.lastMoveAgeMs ?? 0);
  if (lastMoveAgeMs > 0) {
    const lastMoveAgeHours = lastMoveAgeMs / (1000 * 60 * 60);
    if (lastMoveAgeHours < 1)
      score -= 1; // moved < 1h ago — strong recency
    else if (lastMoveAgeHours < 3)
      score -= 0.5; // moved < 3h ago — moderate recency
    else if (lastMoveAgeHours > 8) score += 0.5; // stale movement — penalty
  }

  // Multi-window consensus: sustained agreement across time windows.
  // Strong signal (>= 0.66) is a sustained-movement bonus; weak/contradictory (<= 0.33) is a penalty.
  // No data = no modifier (don't punish absence of line history).
  if (multiWindowScore !== null) {
    // Graduated brackets: each consensus window is a positive signal.
    // 6/6 (1.0)  → −1.5 (strongest sustained agreement)
    // 5/6 (0.83) → −1.0
    // 4/6 (0.66) → −0.5
    // 3/6 (0.50) →  0   (neutral — exactly half agree)
    // 2/6 (0.33) → +0.5
    // 1/6 (0.16) → +1.0 (near-total disagreement)
    // 0/6 (0.0)  → +1.5
    if (multiWindowScore >= 1.0) score -= 1.5;
    else if (multiWindowScore >= 0.83) score -= 1;
    else if (multiWindowScore >= 0.66) score -= 0.5;
    else if (multiWindowScore >= 0.5) score += 0;
    else if (multiWindowScore >= 0.33) score += 0.5;
    else if (multiWindowScore >= 0.16) score += 1;
    else score += 1.5;
  }

  // Peak adverse midline penalty
  // Severe V-shapes (peakAdverseClvPct < -3%) get +2, moderate (-2% to -3%) get +1
  const priskPeakAdverse = Number(item.peakAdverseClvPct ?? item.movementSummary?.peakAdverseClvPct ?? 0);
  if (priskPeakAdverse < -3) score += 2;
  else if (priskPeakAdverse < -2) score += 1;

  // Clamp to 1–10 and round
  score = Math.round(Math.min(10, Math.max(1, score)));

  // Time-to-start adjustment
  const startMs = item.start ? new Date(item.start).getTime() : null;
  const nowMs = Date.now();
  if (Number.isFinite(startMs)) {
    const hoursUntilStart = (startMs - nowMs) / (1000 * 60 * 60);
    if (hoursUntilStart > 24) {
      score = Math.min(10, score + 1); // far-out play — lines not settled, more news risk
    } else if (hoursUntilStart < 2) {
      score = Math.max(1, score - 1); // imminent play — can validate lineups / surface / weather
    }
  }

  return score;
}

/**
 * Get the Kai call: actionable recommendation based on risk score + grade.
 *
 * @param {Object} item — Enriched row
 * @returns {string} 'BET' | 'CONSIDER' | 'PASS'
 */
/**
 * Shared grade → risk → (tier, call) lookup.
 * Single source of truth — getConfidenceTier and getKaiCall both use this
 * so the tier and call can never contradict each other.
 *
 * @param {string} grade - 'green' | 'yellow' | 'red'
 * @param {number} riskScore - 1-10
 * @returns {{ tier: string, kaiCall: string }}
 */
function gradeRiskToTierAndCall(grade, riskScore) {
  // Red grade always → TIER 4, PASS
  if (grade === 'red') {
    return { tier: 'TIER 4', kaiCall: 'PASS' };
  }

  // Green grade → one-tier upgrade (up to TIER 1)
  if (grade === 'green') {
    if (riskScore <= 2) return { tier: 'TIER 1', kaiCall: 'BET' };
    if (riskScore <= 4) return { tier: 'TIER 2', kaiCall: 'BET' };
    if (riskScore <= 6) return { tier: 'TIER 2', kaiCall: 'CONSIDER' }; // green upgrade from TIER 3
    return { tier: 'TIER 3', kaiCall: 'CONSIDER' };
  }

  // Yellow grade (default)
  if (riskScore <= 3) return { tier: 'TIER 2', kaiCall: 'BET' };
  if (riskScore <= 4) return { tier: 'TIER 2', kaiCall: 'CONSIDER' };
  if (riskScore <= 6) return { tier: 'TIER 3', kaiCall: 'CONSIDER' };
  return { tier: 'TIER 4', kaiCall: 'PASS' };
}

/**
 * Get the Kai call: actionable recommendation based on risk score + grade.
 *
 * @param {Object} item — Enriched row
 * @returns {string} 'BET' | 'CONSIDER' | 'PASS'
 */
function getKaiCall(item = {}) {
  const riskScore = calculateRiskScore(item);
  const grade = gradeMovementQuality(item);

  // Bug fix 2026-06-17: when the ranker fell back to a different book because
  // the focus book had no price, the row's target odds aren't executable on
  // the user's requested book. Cap the verdict at CONSIDER so users see the
  // signal but understand they need to manually check the alternate book.
  // Check both `item.focusBookMissing` (final ranked row) and
  // `item.row?.focusBookMissing` (intermediate ranker state) since the
  // call site at lib/screen-ranker.js getKaiCall(item) passes the
  // intermediate object that holds focusBookMissing on the inner `row`.
  const focusMissing = Boolean(item?.focusBookMissing || item?.row?.focusBookMissing);
  if (focusMissing) {
    if (grade === 'red') return 'PASS';
    if (riskScore <= 6) return 'CONSIDER';
    return 'PASS';
  }

  return gradeRiskToTierAndCall(grade, riskScore).kaiCall;
}

/**
 * Phase 3: Confidence Tier System
 *
 * TIER 1 — Lock: Green movement, risk 1-2, BET call. No hesitation.
 * TIER 2 — Value: Green risk 3-4, or yellow risk 1-4. Worth a bet.
 *   TIER 2 yellow plays with exceptional edge (2.5%+) are promoted to TIER 1.
 * TIER 3 — Speculative: Risk 5-6. Small stake only.
 * TIER 4 — Avoid: Red movement, risk 7+, or PASS call. Skip entirely.
 *
 * Dead zones: Green grade upgrades risk 5-6 from TIER 3 to TIER 2.
 * Red grade or PASS call always forces TIER 4 regardless of score.
 *
 * @param {Object} item — Enriched row
 * @returns {string} 'TIER 1' | 'TIER 2' | 'TIER 3' | 'TIER 4'
 */
function getConfidenceTier(item = {}) {
  const riskScore = calculateRiskScore(item);
  const grade = gradeMovementQuality(item);
  const result = gradeRiskToTierAndCall(grade, riskScore);

  // Guardrails: TIER 1 must be a genuine lock. Downgrade plays that meet the
  // numeric grade/risk threshold but fail real-world quality checks.
  if (result.tier === 'TIER 1') {
    const edge = Number(item.consensusEdge ?? item.edge ?? 0);
    const clvPct = Number(item.clvProxyPct ?? item.clv ?? 0);
    const consensusBookCount = Number(item.consensusBookCount || Object.keys(item.allBookOdds || {}).length || 0);
    const movementLabel = String(item.movementLabel || item.movementSummary?.movementLabel || '')
      .trim()
      .toLowerCase();
    const kaiCall = result.kaiCall;

    if (kaiCall === 'PASS') return 'TIER 4';
    // CLV exemption: strong positive CLV with supportive movement is better than
    // snapshot edge. The line is moving your way — that IS the value.
    const CLV_TIER1_THRESHOLD = 3; // 3¢
    const movementDisposition = String(item.movementDisposition || '')
      .trim()
      .toLowerCase();
    const hasStrongClv = clvPct > CLV_TIER1_THRESHOLD;
    const hasSupportiveMovement = movementLabel === 'supportive' || movementDisposition.includes('supportive');
    if (edge <= 0 && hasStrongClv && hasSupportiveMovement) {
      // CLV confirms the signal — keep TIER 1, bypass edge guardrail
    } else if (edge <= 0) {
      return 'TIER 2';
    }
    if (consensusBookCount < 2) return 'TIER 2';
    if (grade === 'red' || movementLabel === 'adverse' || movementLabel === 'deteriorating') return 'TIER 3';

    // Heavy favorite check: TIER 1 plays with extreme odds (worse than -200)
    // are technically sharp but practically unplayable — one loss wipes out
    // multiple wins. Demote to TIER 2 so they still surface as value plays
    // but aren't presented as locks.
    const odds = Number(item.odds ?? item.targetBookOdds ?? item.targetOdds);
    if (Number.isFinite(odds) && odds < -200) return 'TIER 2';
  }

  // Focus book missing: cap TIER 4 → TIER 3 since the signal exists
  // but the row isn't executable on the user's book.
  const focusMissing = Boolean(item?.focusBookMissing || item?.row?.focusBookMissing);
  if (focusMissing) {
    if (result.tier === 'TIER 4') return 'TIER 3';
    return result.tier;
  }

  // High-edge exemption: yellow-grade plays with exceptional consensus edge
  // (2.5%+) and low risk (riskScore <= 3) are promoted to TIER 1 even when
  // movement is supportive_bouncy (noisy but directionally right). This
  // catches plays like MLB totals with 2.8% edge and 3-book consensus that
  // are penalized by bouncy movement but still represent sharp value.
  // Exempted plays still flow through the TIER 1 guardrails above.
  if (result.tier === 'TIER 2' && grade === 'yellow' && riskScore <= 3) {
    const edge = Number(item.consensusEdge ?? item.edge ?? 0);
    const clvPct = Number(item.clvProxyPct ?? item.clv ?? 0);
    const disposition = String(item.movementDisposition || item.movement || '').toLowerCase();
    const TIER1_HIGH_EDGE_THRESHOLD = 2.5;
    const TIER1_HIGH_CLV_THRESHOLD = 5; // 5¢
    // Insufficient history can't confirm a trend — the whole point is CLV
    // by gametime. No trend data = no TIER 1, regardless of edge or CLV.
    if (disposition.includes('insufficient')) return result.tier;
    // CLV-based promotion: exceptional CLV with supportive movement
    if (clvPct >= TIER1_HIGH_CLV_THRESHOLD && !disposition.includes('adverse')) {
      return 'TIER 1';
    }
    // Edge-based promotion (existing)
    if (edge >= TIER1_HIGH_EDGE_THRESHOLD && !disposition.includes('adverse')) {
      return 'TIER 1';
    }
  }

  return result.tier;
}

/**
 * Stable tier assignment with hysteresis.
 *
 * Solves the "plays keep changing tiers" problem. Small odds movements
 * can flip a play between TIER 2 and TIER 3 repeatedly. This function:
 *
 * 1. Computes the raw tier via getConfidenceTier()
 * 2. Checks if this play was previously assigned a tier (via tierCacheKey)
 * 3. If cached: only updates if the new tier differs by 2+ levels OR
 *    the risk score moved by 3+ points. Otherwise keeps the old tier.
 * 4. Records the snapshot in the score timeline (persists across requests)
 * 5. Returns the evolving tier (mode of the last 2 hours of observations)
 *
 * The hysteresis cache (tierCache) is cleared at the start of each MCP tool call
 * (clearTierCache is invoked in scripts/server/handlers.js before candidate iteration
 * for quick_screen, recommended_bets, screen_ranked, and validate_play), so each call
 * starts from a clean state. The score timeline persists to provide historical context
 * for the rolling-window evolving tier.
 *
 * @param {Object} item — Enriched row
 * @returns {string} 'TIER 1' | 'TIER 2' | 'TIER 3' | 'TIER 4'
 */
function getConfidenceTierStable(item = {}) {
  const rawTier = getConfidenceTier(item);
  const rawRisk = calculateRiskScore(item);
  const key = tierCacheKey(item);

  // No cache key available (missing identifiers) — return raw
  if (!key) return rawTier;

  const now = Date.now();
  purgeStaleTierCache();
  const cached = tierCache.get(key);

  const tierLevel = { 'TIER 1': 1, 'TIER 2': 2, 'TIER 3': 3, 'TIER 4': 4 };

  // Determine the stable tier via hysteresis.
  // If the current state is worse than the historical mode, always use the
  // current state. A TIER 1 label must never mask a deteriorating play.
  let stableTier;
  if (!cached) {
    stableTier = rawTier;
  } else {
    const cachedLevel = tierLevel[cached.tier] || 2;
    const rawLevel = tierLevel[rawTier] || 2;
    const tierDistance = Math.abs(rawLevel - cachedLevel);
    const riskDelta = Math.abs(rawRisk - (cached.riskScore || 0));
    stableTier = tierDistance >= 2 || riskDelta >= 3 ? rawTier : cached.tier;
  }

  // Record in score timeline (persists across requests) before computing mode
  if (!scoreTimeline.has(key)) {
    scoreTimeline.set(key, []);
  }
  const timeline = scoreTimeline.get(key);
  timeline.push({ timestamp: now, riskScore: rawRisk, tier: rawTier });

  // Purge stale timeline entries
  const cutoff = now - TIMELINE_WINDOW_MS;
  while (timeline.length > 0 && timeline[0].timestamp < cutoff) {
    timeline.shift();
  }

  // Compute evolving tier: use mode of raw tiers over the window.
  // If we have fewer than 3 observations, use the hysteresis-stable tier.
  let evolvingTier = stableTier;
  if (timeline.length >= 3) {
    const tierCounts = {};
    for (const entry of timeline) {
      tierCounts[entry.tier] = (tierCounts[entry.tier] || 0) + 1;
    }
    evolvingTier = Object.entries(tierCounts).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      // Tie-break toward the most recent observation's tier.
      return tierLevel[b[0]] - tierLevel[a[0]];
    })[0][0];
  }

  // Safety override: if the current raw tier is worse than the historical
  // mode/hysteresis result, always return the current (worse) tier. This
  // prevents stale TIER 1 badges on plays that have since deteriorated.
  const evolvingLevel = tierLevel[evolvingTier] || 2;
  const rawLevel = tierLevel[rawTier] || 2;
  if (rawLevel > evolvingLevel) {
    stableTier = rawTier;
  } else {
    stableTier = evolvingTier;
  }

  // Update hysteresis cache with the final tier
  tierCache.set(key, { tier: stableTier, riskScore: rawRisk, timestamp: now });

  return stableTier;
}

/**
 * Get the trajectory metadata for a play's tier evolution.
 * Call after getConfidenceTierStable to get insight into how the play
 * is trending over the rolling 2-hour window.
 *
 * @param {Object} item — Enriched row
 * @returns {{ trend: string, volatility: string, dataPoints: number, currentRisk: number, avgRisk: number, riskRange: number }}
 */
function getTierTrajectory(item = {}) {
  const key = tierCacheKey(item);
  if (!key) {
    return { trend: 'unknown', volatility: 'unknown', dataPoints: 0, currentRisk: 0, avgRisk: 0, riskRange: 0 };
  }

  const entries = getTimelineEntries(key);
  if (entries.length < 2) {
    return {
      trend: 'new',
      volatility: 'unknown',
      dataPoints: entries.length,
      currentRisk: entries[0]?.riskScore || 0,
      avgRisk: entries[0]?.riskScore || 0,
      riskRange: 0
    };
  }

  const risks = entries.map((e) => e.riskScore);
  const avgRisk = risks.reduce((s, r) => s + r, 0) / risks.length;
  const riskRange = Math.max(...risks) - Math.min(...risks);

  // Trend: compare last 3 observations to first 3
  const windowSize = Math.min(3, Math.floor(entries.length / 2));
  const recentAvg = risks.slice(-windowSize).reduce((s, r) => s + r, 0) / windowSize;
  const olderAvg = risks.slice(0, windowSize).reduce((s, r) => s + r, 0) / windowSize;
  const riskDelta = recentAvg - olderAvg;

  let trend;
  if (riskDelta <= -2) trend = 'improving';
  else if (riskDelta >= 2) trend = 'deteriorating';
  else trend = 'stable';

  let volatility;
  if (riskRange <= 2) volatility = 'low';
  else if (riskRange <= 4) volatility = 'moderate';
  else volatility = 'high';

  return {
    trend,
    volatility,
    dataPoints: entries.length,
    currentRisk: risks[risks.length - 1],
    avgRisk: Math.round(avgRisk * 10) / 10,
    riskRange
  };
}

/**
 * Build a one-line rationale string for a play.
 *
 * @param {Object} item — Enriched row
 * @returns {string} e.g. "Aliassime: 12 books, 0.99% edge, supportive, best CLV. TIER 2"
 */
function buildRationale(item = {}) {
  const row = item.row || item;
  const name = row.selection || row.participant || row.game || `${row.awayTeam || '?'} @ ${row.homeTeam || '?'}`;
  const edge = Number(item.consensusEdge ?? 0).toFixed(2);
  const books = Number(item.consensusBookCount || 0);
  const label = String(item.movementLabel || item.movementSummary?.movementLabel || row.movementLabel || '').replace(
    /_/g,
    ' '
  );
  const exec = item.executionQuality || 'unknown';
  const clv = Number(item.clvProxyPct ?? 0).toFixed(2);
  const grade = gradeMovementQuality(item);
  const tier = item.confidenceTierLive || item.confidenceTier || getConfidenceTierStable(item);
  const gradeIcon = grade === 'green' ? '🟢' : grade === 'yellow' ? '🟡' : '🔴';

  const parts = [name];
  if (books > 0) parts.push(`${books} books`);
  if (Number(item.consensusEdge) > 0) parts.push(`${edge}% edge`);

  // Movement & CLV always shown so no directional signal is visible at a glance
  const disp = item.movementDisposition || item.movement || '';
  if (disp) parts.push(disp);
  else if (label) parts.push(label);
  if (exec && exec !== 'unknown') parts.push(exec);
  if (Number(item.clvProxyPct) !== 0) parts.push(`${clv}% CLV`);
  else if (Number(item.clvProxyPct) === 0) parts.push(`0% CLV`);

  // Bug fix 2026-06-17: flag rows where the focus book has a price but no
  // comp book has a same-side price (executionQuality was silently 'unknown').
  if (item.compDataMissing) {
    parts.push('unverified (no comp data)');
  }
  if (item.focusBookMissing) {
    parts.push('fallback book');
  }

  parts.push(`${gradeIcon} ${tier}`);

  // Add trajectory context if available
  const trajectory = item.tierTrajectory || getTierTrajectory(item);
  if (trajectory && trajectory.dataPoints >= 3) {
    if (trajectory.trend === 'improving') parts.push('📈 improving');
    else if (trajectory.trend === 'deteriorating') parts.push('📉 deteriorating');
    if (trajectory.volatility === 'high') parts.push('volatile');
  }

  // Add risk factor explanation for high-risk plays
  const risk = item.riskScore || calculateRiskScore(item);
  if (risk >= 5) {
    const factors = [];
    if (edge <= 0) factors.push('no edge');
    if (books < 3) factors.push('thin consensus');
    if (exec === 'bad' || exec === 'unknown') factors.push(`${exec} exec`);
    if (label === 'adverse') factors.push('adverse movement');
    if (factors.length > 0) parts.push(`(${factors.join(', ')})`);
  }

  return parts.join(' — ');
}

/**
 * Phase 4: Staking suggestions based on tier and edge.
 *
 * Standard Kelly-fractional approach:
 *   TIER 1: 2.0% of bankroll (high confidence)
 *   TIER 2: 1.0% of bankroll (solid play)
 *   TIER 3: 0.5% of bankroll (speculative)
 *   TIER 4: 0% (avoid)
 *
 * If the edge is known (>0), scales stake proportionally up to 1.5x for
 * edges >2%, and down to 0.5x for edges <0.5%. Caps total exposure per
 * slate at 25% of bankroll. Warns on correlated bets (same game, same
 * league tournament stacking).
 *
 * @param {Object} options
 * @param {number} options.bankroll — Total bankroll in dollars
 * @param {Array} options.plays — Array of play objects with confidenceTier, consensusEdge, league, game, selection
 * @returns {Object} Staking plan
 */
function suggestStakes({ bankroll = 1000, plays = [] } = {}) {
  if (!Number.isFinite(bankroll) || bankroll <= 0) {
    return { ok: false, error: 'bankroll must be a positive number' };
  }
  if (!Array.isArray(plays) || !plays.length) {
    return { ok: true, totalStake: 0, stakes: [], warnings: ['No plays to stake'] };
  }

  const tierMultiplier = { 'TIER 1': 2.0, 'TIER 2': 1.0, 'TIER 3': 0.5, 'TIER 4': 0 };
  const stakes = [];
  let totalStakePct = 0;
  const warnings = [];
  const gameKeys = new Map(); // game -> count for correlation detection

  for (const play of plays) {
    const tier = play.confidenceTier || getConfidenceTierStable(play);
    const edge = Number(play.consensusEdge ?? 0);
    // Treat explicit null/undefined/missing as "no data"; treat 0 as the literal value.
    const rawClv = play.clvProxyPct;
    const hasClv = rawClv !== null && rawClv !== undefined && Number.isFinite(Number(rawClv));
    const clv = hasClv ? Number(rawClv) : null;
    const basePct = tierMultiplier[tier] || 0;
    if (basePct <= 0) continue;

    // Scale by edge
    let edgeFactor = 1.0;
    if (edge > 2) edgeFactor = 1.5;
    else if (edge > 1) edgeFactor = 1.25;
    else if (edge < 0.5) edgeFactor = 0.5;

    // Scale by CLV: a TIER 1 play with +6% CLV is meaningfully different from
    // a TIER 1 play with +0.5% CLV. Bonus for strong CLV, penalty for weak/null.
    let clvFactor;
    let clvBucket;
    if (!hasClv) {
      clvFactor = 0.5;
      clvBucket = 'no_data';
    } else if (clv >= 5) {
      clvFactor = 1.5;
      clvBucket = 'strong_5plus';
    } else if (clv >= 2) {
      clvFactor = 1.0;
      clvBucket = 'moderate_2to5';
    } else if (clv >= 0.5) {
      clvFactor = 0.75;
      clvBucket = 'weak_0_5to2';
    } else {
      clvFactor = 0.5;
      clvBucket = 'sub_threshold';
    }

    let stakePct = basePct * edgeFactor * clvFactor;
    // Clamp per-play max
    stakePct = Math.min(stakePct, 5.0);

    const stakeDollars = (bankroll * stakePct) / 100;
    totalStakePct += stakePct;

    // Track games for correlation detection
    const gameKey = play.game || play.selection || `${play.awayTeam} @ ${play.homeTeam}`;
    const sportKey = `${play.league || '?'}:${gameKey}`;
    gameKeys.set(sportKey, (gameKeys.get(sportKey) || 0) + 1);

    stakes.push({
      game: gameKey,
      selection: play.selection || play.participant || null,
      league: play.league || null,
      tier,
      edge: edge > 0 ? `${edge.toFixed(2)}%` : null,
      clvPct: hasClv ? Number(clv.toFixed(2)) : null,
      clvBucket,
      clvFactor,
      edgeFactor,
      basePct,
      bankrollPct: Number(stakePct.toFixed(2)),
      stakeDollars: Math.round(stakeDollars),
      rationale: play.rationale || buildRationale(play)
    });
  }

  // Warn on total exposure
  if (totalStakePct > 25) {
    warnings.push(
      `Total exposure ${totalStakePct.toFixed(1)}% exceeds 25% recommended cap. Consider reducing position sizes.`
    );
  }

  // Warn on correlated bets (same game, multiple sides)
  for (const [key, count] of gameKeys) {
    if (count > 1) {
      warnings.push(
        `Correlated bets detected on ${key} (${count} legs). These move together — consider picking one side.`
      );
    }
  }

  const totalStake = stakes.reduce((sum, s) => sum + s.stakeDollars, 0);

  return {
    ok: true,
    bankroll,
    totalStake,
    totalStakePct: Number(totalStakePct.toFixed(2)),
    remainingBankroll: bankroll - totalStake,
    playCount: stakes.length,
    stakes,
    warnings
  };
}

module.exports = {
  gradeMovementQuality,
  calculateRiskScore,
  getKaiCall,
  getConfidenceTier,
  getConfidenceTierStable,
  getTierTrajectory,
  clearTierCache,
  clearScoreTimeline,
  tierCacheKey,
  buildRationale,
  suggestStakes,
  gradeRiskToTierAndCall
};
