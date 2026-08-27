'use strict';

/**
 * Verdict + tier reconciliation logic, extracted from the handler god-module
 * (scripts/server/handlers.js) as part of Phase 1 Task 1 of the 10/10 plan.
 *
 * These four pure functions were moved here verbatim so the handler module
 * stops owning bet-verdict reconciliation. Behavior, edge cases, and the
 * PASS -> TIER 4 invariant are preserved exactly. The single source of truth
 * for confidence-tier ordering (TIER_RANK) is centralized here.
 *
 * Dependencies: reconcileValidateOverride from lib/validate-reconcile.js
 * (kept in place — only the verdict reconciliation moved).
 */

const { reconcileValidateOverride } = require('./validate-reconcile');

// Confidence tier rank used by applyFinalVerdict to clamp conflict-downgraded
// rows out of visually-TIER-1 territory during final verdict reconciliation.
const TIER_RANK = { 'TIER 1': 1, 'TIER 2': 2, 'TIER 3': 3, 'TIER 4': 4 };

/**
 * Merge validate_play verdict data into a candidate/play object.
 * Used by both quick_screen and recommended_bets validateTop loops.
 * Sets validatedTier, validatedConsensusBookCount, validatedMovementDisposition,
 * validatedActionableSummary, validatedEdge, validatedClv, validatedGameContext, etc.
 */
function applyValidatedFields(target, validationResult) {
  const verdict = validationResult.verdictSummary;
  // play is null on lookup_failed (line gone / no longer priced). The `|| {}`
  // fallback below would make `!play` evaluate against an object (always
  // truthy), which is why unverified must key off the ORIGINAL null, not the
  // fallback object.
  const playPresent = Boolean(validationResult.play);
  const play = validationResult.play || {};
  const gameCtx = validationResult.gameContext || null;

  target.validatedTier = verdict.displayTier || target.displayTier;
  target.validatedVerdict = validationResult.verdict || null;
  // Real confidence tier (TIER 1/2/3/4) from the validate impl. The verdict's
  // displayTier is BET/CONSIDER/PASS (a different vocabulary) — do NOT confuse
  // it with a confidence tier. finalConfidenceTier must hold a TIER string.
  target.validatedConfidenceTier = validationResult.tier || verdict.displayTier || target.confidenceTier;
  // Lookup_failed (play===null) means the screen row could not be rehydrated
  // from the current feed — the requested line is gone or no longer priced.
  // Do NOT fall back to the screen's (now-stale) consensusBookCount, or agents
  // see a phantom "5 books" on a play that doesn't exist anymore. Mark it
  // 0 + unverified so the drift is visible instead of buried.
  target.validatedConsensusBookCount =
    playPresent && Number.isFinite(Number(play.consensusBookCount)) ? Number(play.consensusBookCount) : 0;
  target.validatedUnverified = !playPresent;
  // Thread consensus drift so applyFinalVerdict can downgrade a BET that
  // was built on a consensus that evaporated between screen and validate.
  target.validatedConsensusDrift = Boolean(validationResult.consensusDrift);
  target.validatedDriftReason = validationResult.driftReason || null;
  // Reconcile the validate re-derivation against the screen snapshot. The
  // validate path re-fetches and re-derives executionQuality + movementDisposition
  // a few seconds later; it must NOT silently override a clean screen signal
  // unless consensus actually drifted (a real, explainable change). See
  // lib/validate-reconcile.js.
  const reconcile = reconcileValidateOverride({
    screenExec: target.executionQuality,
    screenDisposition: target.movementDisposition,
    validateExec: play.executionQuality || target.executionQuality,
    validateDisposition: verdict.movementDisposition || target.movementDisposition,
    consensusDrift: Boolean(validationResult.consensusDrift)
  });
  target.validatedMovementDisposition = reconcile.movementDisposition;
  target.validatedExecQuality = reconcile.executionQuality;
  target.validatedReconcileOverridden = reconcile.overridden;
  target.validatedReconcileReason = reconcile.reason;
  target.validatedRiskFlags = verdict.riskFlags || [];
  target.validatedActionableSummary = verdict.actionableSummary || null;
  target.validatedConsensusSupport = verdict.consensusSupport || null;
  target.rationale = verdict.rationale || null;

  if (gameCtx) {
    target.validatedGameContext = gameCtx;
  }
  if (play) {
    target.validatedEdge = play.consensusEdge ?? target.edge;
    target.validatedClv = play.clvProxyPct ?? target.clv;
    target.validatedOdds = play.odds ?? target.odds;
  }
}

/**
 * Merge the raw screen tier and the validation verdict into ONE authoritative
 * bet/no-bet call (`finalVerdict`) so agents read a single field instead of
 * reconciling a screen BET against a validation PASS by hand.
 *
 * Resolution rule:
 *  - Prefer `validatedVerdict` (it reflects re-fetched consensus + movement).
 *  - Fall back to displayTier / kaiCall when validation didn't run.
 *  - Hard safety override: a validation hard-fail (movement adverse flag or
 *    bad execution quality) can NEVER be a BET — forced to PASS.
 * Also sets `finalConfidenceTier`, `priceDrift`, and `finalWarnings`.
 */
function applyFinalVerdict(target) {
  if (target.validationSkipped === true) {
    delete target.validationFailed;
    delete target.validationFailureReason;
    if (Array.isArray(target.finalWarnings)) {
      target.finalWarnings = target.finalWarnings.filter((warning) => warning !== 'validation-failed');
    }
  }
  const validatedVerdict = target.validatedVerdict || null;
  // validatedTier / displayTier are BET/CONSIDER/PASS verdicts. The real
  // confidence tier (TIER 1/2/3/4) lives in validatedConfidenceTier.
  let validatedTier = target.validatedConfidenceTier || target.confidenceTier || 'TIER 4';
  let verdict = validatedVerdict || target.displayTier || target.kaiCall || 'PASS';

  // Alternate-line guard: these were downgraded by resolveAlternateLines
  // in the screen ranker. The validateTop re-grade can overwrite the tier,
  // but alternate lines must never surface as picks — one line per side.
  if (target.altLineFiltered) {
    verdict = 'PASS';
    validatedTier = 'TIER 4';
  }

  const riskFlags = target.validatedRiskFlags || [];
  // A 'bad' that was reconciled back to the screen signal (overridden, no
  // drift) is NOT a real execution failure — do not hard-PASS on it.
  const execBad = target.validatedExecQuality === 'bad' && target.validatedReconcileOverridden !== true;
  if ((riskFlags.includes('movement adverse') || execBad) && verdict === 'BET') {
    verdict = 'PASS';
  }

  // Insufficient-movement hard guard (2026-08-15): a row whose disposition
  // reads 'insufficient' (no direction data below the consensus floor, or a
  // stale supportive quote) can NEVER be a BET — validation re-derivation
  // must not resurrect the rank-time BET that the screen grade stamped off a
  // green backend label. This mirrors the getKaiCall/getConfidenceTier guards
  // in risk-score.js. Idempotent: only downgrades BET → PASS, never upgrades.
  //
  // Key off validatedMovementDisposition ONLY (not the mapped
  // movementDisposition): mapCandidateRow recomputes the disposition from raw
  // row fields, and a thin stub/validation-skipped row with no direction
  // fields would recompute to 'insufficient' and clobber an explicit
  // supportive_clean — falsely PASSing a legit row. The rank-time
  // getKaiCall/getConfidenceTier guards already PASS insufficient rows at
  // scan time, so this guard only needs to stop validation resurrecting one.
  const validatedDisposition = String(target.validatedMovementDisposition || '')
    .trim()
    .toLowerCase();
  if (verdict === 'BET' && validatedDisposition === 'insufficient') {
    verdict = 'PASS';
  }

  // Consensus-drift / unverified downgrade: if the re-fetch collapsed the
  // screen's consensus (e.g. 5 books → 1) or couldn't re-find the line at
  // all, the pre-validation BET is no longer trustworthy. This mirrors the
  // guard inside runValidatePlayImpl (which already downgrades to CONSIDER
  // there) — applied again here so finalVerdict + the promoted display tier
  // can never ship a stale BET. Idempotent: CONSIDER/PASS are left alone.
  const validationFailed =
    target.validationFailed === true ||
    (!target._validated && !validatedVerdict && target.validationSkipped !== true) ||
    (Array.isArray(target.finalWarnings) && target.finalWarnings.includes('validation-failed'));
  if ((target.validatedConsensusDrift || target.validatedUnverified || validationFailed) && verdict === 'BET') {
    verdict = 'CONSIDER';
  }

  // Conflict resurrection guard: a row already demoted by side-conflict
  // resolution (conflictFlag) or totals-conflict resolution (totalsConflictWith)
  // cannot resurrect to BET via validatedVerdict. The screen ranker already
  // decided these are mutually-exclusive losers. Preserve the deeper demotion:
  // a row downgraded to PASS stays PASS; one at CONSIDER stays at CONSIDER.
  if (target.conflictFlag || target.totalsConflictWith) {
    const conflictLoserVerdict = target.kaiCall === 'PASS' || target.displayTier === 'PASS' ? 'PASS' : 'CONSIDER';
    if (verdict === 'BET' || verdict === 'CONSIDER') {
      verdict = conflictLoserVerdict;
    }
    // Tier clamp: the screen ranker already demoted the loser's tier by one
    // (e.g. TIER 1 → TIER 2). A validated TIER 1 re-grade must not smuggle the
    // loser back to the top of the board — clamp the final tier to at least the
    // screen's demoted tier so a conflict loser can never ship as visually TIER 1.
    if (verdict !== 'BET') {
      const screenTierRank = TIER_RANK[String(target.confidenceTier || '').trim()] || 0;
      const validatedTierRank = TIER_RANK[String(validatedTier || '').trim()] || 4;
      if (screenTierRank > 0 && validatedTierRank < screenTierRank) {
        validatedTier = target.confidenceTier;
      }
    }
  }

  // PASS verdicts always force TIER 4 — a play can't be 'high confidence
  // PASS' in PropProfessor's model. This must happen here (not only in
  // promoteFinalVerdictToDisplay) so that finalConfidenceTier is set
  // consistently with finalVerdict from the start.
  if (verdict === 'PASS') {
    validatedTier = 'TIER 4';
  }

  target.finalVerdict = verdict;
  target.finalConfidenceTier = validatedTier;

  const screenOdds = Number(target.odds);
  const valOdds = Number(target.validatedOdds);
  if (Number.isFinite(screenOdds) && Number.isFinite(valOdds)) {
    const drift = Math.abs(valOdds - screenOdds);
    target.priceDrift = drift;
    if (drift > 30) {
      target.finalWarnings = [...(target.finalWarnings || []), 'price-drift'];
    }
  } else {
    target.priceDrift = null;
  }

  if (target.validatedGameContext && target.validatedGameContext.riskFlag === 'unknown') {
    target.finalWarnings = [...(target.finalWarnings || []), 'unknown-game-context'];
  }
  if (!target._validated && target.validationSkipped !== true) {
    target.finalWarnings = [...(target.finalWarnings || []), 'validation-failed'];
  }
  if (target.validatedConsensusDrift) {
    target.finalWarnings = [...(target.finalWarnings || []), 'consensus-drift'];
  }
  if (target.validatedUnverified) {
    target.finalWarnings = [...(target.finalWarnings || []), 'unverified-line'];
  }
}

/**
 * Post-validation check: flag plays on the same game+market that contradict
 * each other (e.g. Over 173.5 BET alongside Under 179.5 BET for the same game). The system
 * evaluates each line independently, so a match with split market signals
 * can ship TIER 1 plays in opposite directions — which is noise, not
 * signal. This function picks the stronger side per game+market and
 * downgrades the weaker side to CONSIDER.
 *
 * Unlike the old implementation which only caught exact same-line
 * opposites (Over 179.5 vs Under 179.5), this version detects ANY
 * Over-vs-Under conflict regardless of line number.
 */
function flagContradictoryPlays(plays) {
  if (!Array.isArray(plays) || plays.length < 2) return;

  // Group by gameId+market
  const groups = {};
  for (const p of plays) {
    const key = `${p.gameId}||${p.market}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  }

  for (const key of Object.keys(groups)) {
    const group = groups[key];
    if (group.length < 2) continue;

    // Split into over and under buckets
    const overPlays = [];
    const underPlays = [];
    for (const p of group) {
      const sel = String(p.selection || '').toLowerCase();
      if (sel.startsWith('over')) overPlays.push(p);
      else if (sel.startsWith('under')) underPlays.push(p);
      // Non-total plays (ML/spread) don't have over/under, skip them
    }

    if (overPlays.length === 0 || underPlays.length === 0) continue;
    // Both sides are present — need to pick one

    // Score each side by movement quality
    function movementScore(play) {
      const m = String(play.movementDisposition || '');
      if (m === 'supportive_clean') return 3;
      if (m === 'supportive_bouncy') return 2;
      if (m === 'insufficient') return 1;
      return -1; // adverse_full or unknown
    }

    const overMovScore = overPlays.reduce((s, p) => s + movementScore(p), 0);
    const underMovScore = underPlays.reduce((s, p) => s + movementScore(p), 0);
    const overBestEdge = Math.max(...overPlays.map((p) => Number(p.edge || 0)));
    const underBestEdge = Math.max(...underPlays.map((p) => Number(p.edge || 0)));

    // Primary: side with more total movement score wins.
    // Tie-breaker: best edge.
    let weakerPlays, strongerPlays, detail;
    if (overMovScore > underMovScore) {
      weakerPlays = underPlays;
      strongerPlays = overPlays;
      detail = 'under-side';
    } else if (underMovScore > overMovScore) {
      weakerPlays = overPlays;
      strongerPlays = underPlays;
      detail = 'over-side';
    } else if (overBestEdge > underBestEdge) {
      weakerPlays = underPlays;
      strongerPlays = overPlays;
      detail = 'under-side (tie-broken by edge)';
    } else {
      weakerPlays = overPlays;
      strongerPlays = underPlays;
      detail = 'over-side (tie-broken by edge)';
    }

    // Downgrade all plays on the weaker side
    for (const w of weakerPlays) {
      w.finalWarnings = [...(w.finalWarnings || []), `contradictory-signal:${detail}`];
      if (w.finalVerdict === 'BET' || w.kaiCall === 'BET') {
        w.finalVerdict = 'CONSIDER';
        w.finalConfidenceTier = 'TIER 2';
        w.displayTier = 'CONSIDER';
        w.kaiCall = 'CONSIDER';
      }
    }

    // Contradictory Over/Under = market hasn't settled. Downgrade the stronger
    // side ONLY if the weaker side also shows supportive movement. If the weaker
    // side is adverse, the market IS picking a direction — let the stronger side
    // keep its tier. Both supportive = noise. One supportive + one adverse = signal.
    const weakerAllSupportive = weakerPlays.every((p) => {
      const m = String(p.movementDisposition || p.movement || '').toLowerCase();
      return m.includes('supportive');
    });

    for (const s of strongerPlays) {
      s.finalWarnings = [...(s.finalWarnings || []), `contradictory-signal:opposing:${detail}`];
      if (weakerAllSupportive && (s.finalVerdict === 'BET' || s.kaiCall === 'BET')) {
        s.finalVerdict = 'CONSIDER';
        s.finalConfidenceTier = 'TIER 2';
        s.displayTier = 'CONSIDER';
        s.kaiCall = 'CONSIDER';
      }
    }
  }
}

/**
 * Promote the authoritative merged verdict (finalVerdict / finalConfidenceTier)
 * into the agent-facing display fields (displayTier, confidenceTier, kaiCall)
 * so consumers that read the PRIMARY fields — not the buried finalVerdict —
 * see the validated call. Without this, an adverse-movement play ships as
 * displayTier BET because the screen's snapshot always won, and the tier
 * filters (targetTiers) keyed off confidenceTier, so PASS-level validated
 * plays leaked through as TIER 1 BETs.
 *
 * Only promotes when validation actually ran (_validated) and produced a
 * finalVerdict. If validation didn't run, the screen snapshot stands.
 */
function promoteFinalVerdictToDisplay(target) {
  if (!target._validated) return;
  if (!target.finalVerdict) return;
  // finalVerdict is the single authoritative bet/no-bet call.
  target.displayTier = target.finalVerdict;
  target.kaiCall = target.finalVerdict;
  if (target.finalConfidenceTier) {
    target.confidenceTier = target.finalConfidenceTier;
  }
  // GUARD: a PASS verdict always forces TIER 4 regardless of any
  // stale TIER 1/2/3 that may have leaked from the screen snapshot.
  // Without this, promoteFinalVerdictToDisplay would ship TIER 1 + PASS
  // (structurally impossible per gradeRiskToTierAndCall's contract).
  if (target.finalVerdict === 'PASS') {
    target.confidenceTier = 'TIER 4';
  }
  // Add quick summary for agent decision-making
  const odds = target.odds ? ` at ${target.odds}` : '';
  const selection = target.selection || target.participant || target.pick || '';
  target.summary = `${target.finalVerdict} ${selection}${odds}`.trim();
}

module.exports = {
  TIER_RANK,
  applyValidatedFields,
  applyFinalVerdict,
  flagContradictoryPlays,
  promoteFinalVerdictToDisplay
};
