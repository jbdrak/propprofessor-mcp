'use strict';

const { computeMovementDisposition } = require('../../../lib/propprofessor-movement-disposition');

const STATUS_MESSAGES = {
  supportive_clean: 'all signals aligned — green movement, supportive direction, clean path',
  supportive_bouncy: 'direction is right but path was rocky — yellow grade or V-shaped recovery',
  adverse_recent: 'recent movement turned adverse — the direction went against the play recently',
  adverse_full: 'full-window direction is adverse — do not bet',
  insufficient: 'not enough data to evaluate movement quality'
};

function resolveBaseVerdict({
  args,
  matchingRow,
  matchedViaGameIdChange,
  detailError,
  fallbackNote,
  gameId,
  selection
}) {
  const reasons = [];
  const screenTier = args.screenTier || (matchingRow && matchingRow.screenTier);
  const screenKaiCall = args.screenKaiCall || (matchingRow && matchingRow.screenKaiCall);
  let tier = screenTier || matchingRow?.confidenceTier || null;
  if (!tier) {
    const kaiCall = screenKaiCall || matchingRow?.kaiCall;
    if (kaiCall === 'BET') tier = 'TIER 1';
    else if (kaiCall === 'CONSIDER') tier = 'TIER 2';
    else tier = 'TIER 4';
  }

  let consensusDrift = false;
  let driftReason = null;
  if (matchingRow) {
    const screenCbk = Number(args.screenConsensusBookCount);
    const screenExec = String(args.screenExecutionQuality || '');
    const currentCbk = Number(matchingRow.consensusBookCount || 0);
    const currentExec = String(matchingRow.executionQuality || '');

    if (Number.isFinite(screenCbk) && screenCbk > 0) {
      const absDrop = screenCbk - currentCbk;
      const pctDrop = screenCbk > 0 ? absDrop / screenCbk : 0;
      if (absDrop >= 4 && pctDrop > 0.25) {
        consensusDrift = true;
        driftReason = `consensus collapsed (${screenCbk} → ${currentCbk} books)`;
      }
    }
    if (
      !consensusDrift &&
      screenExec &&
      screenExec !== 'unknown' &&
      screenExec !== currentExec &&
      currentExec === 'bad'
    ) {
      consensusDrift = true;
      driftReason = 'execution quality changed';
    }
  }

  let lookupStatus = 'resolved';
  let reasonType = 'signal';
  let verdict;
  if (matchingRow) {
    if (matchedViaGameIdChange) {
      lookupStatus = 'gameId_changed';
      reasonType = 'gameId_changed';
      reasons.push(`gameId changed (${gameId} → ${matchingRow.gameId}); matched by league/market/selection/date`);
    }
    // The screen ranker is the authoritative tier→call source. Its kaiCall
    // already encodes grade+risk semantics (TIER 2 green/yellow plays are
    // BET-able; TIER 3 is speculative). Validation must NOT silently demote
    // a screen BET to CONSIDER just because the re-fetch re-derived a lower
    // confidence tier — that was demoting every TIER 2 BET (5-book consensus,
    // supportive movement) into a CONSIDER and starving the card. Prefer the
    // screen's kaiCall; only real drift/adverse movement (checked below and
    // in applyFinalVerdict) overrides it.
    if (screenKaiCall === 'BET' || (matchingRow && matchingRow.kaiCall === 'BET')) {
      verdict = 'BET';
    } else if (screenKaiCall === 'CONSIDER' || (matchingRow && matchingRow.kaiCall === 'CONSIDER')) {
      verdict = 'CONSIDER';
    } else if (tier === 'TIER 1') {
      verdict = 'BET';
    } else if (tier === 'TIER 2' || tier === 'TIER 3') {
      verdict = 'CONSIDER';
    } else {
      verdict = 'PASS';
      reasons.push('TIER 4 (no signal)');
    }

    if (consensusDrift && verdict === 'BET') {
      verdict = 'CONSIDER';
      reasons.push(`consensus drift: ${driftReason} (re-fetch disagrees with screen snapshot)`);
    }

    const exec = String(matchingRow.executionQuality || '');
    if (exec === 'bad') {
      verdict = 'PASS';
      reasons.push('execution quality is "bad" on the requested book');
    } else if (exec === 'playable') {
      reasons.push('execution quality is "playable" (within 10¢ of best)');
    } else if (exec === 'best') {
      reasons.push('execution quality is "best" (top of market)');
    } else {
      reasons.push(`execution quality is "${exec || 'unknown'}"`);
    }

    const cbk = Number(matchingRow.consensusBookCount || 0);
    if (cbk >= 3) reasons.push(`consensus: ${cbk} comp books agree`);
    else if (cbk >= 1) reasons.push(`consensus: ${cbk} comp book (thin)`);
    else reasons.push('no comp book consensus');
  } else {
    lookupStatus = 'lookup_failed';
    reasonType = 'lookup_failure';
    verdict = 'CONSIDER';
    reasons.push(
      detailError
        ? `screen lookup failed: ${detailError}`
        : `no row matched selection "${selection}" on gameId ${gameId}${
            fallbackNote ? ` (fallback: ${fallbackNote})` : ''
          }`
    );
  }

  if (screenKaiCall && screenKaiCall !== 'BET' && verdict === 'BET') {
    verdict = 'CONSIDER';
    reasons.push(`downgraded to match screen snapshot (${screenKaiCall})`);
  }

  return { verdict, tier, lookupStatus, reasonType, reasons, screenKaiCall, consensusDrift, driftReason };
}

function applyResearchRisk(verdict, reasons, research) {
  if (research && research.riskFlag === 'high') {
    reasons.push('player_context riskFlag = "high"');
    return 'PASS';
  }
  if (research && research.riskFlag === 'medium') {
    reasons.push('player_context riskFlag = "medium" — proceed with caution');
    return verdict === 'BET' ? 'CONSIDER' : verdict;
  }
  if (research && research.riskFlag === 'low') reasons.push('player_context riskFlag = "low"');
  return verdict;
}

function applyGameContextRisk(verdict, reasons, gameContext) {
  if (gameContext && gameContext.riskFlag === 'high') {
    reasons.push(`game_context riskFlag = "high"${gameContext.riskSummary ? ` — ${gameContext.riskSummary}` : ''}`);
    return 'PASS';
  }
  if (gameContext && gameContext.riskFlag === 'medium') {
    reasons.push(`game_context riskFlag = "medium" — ${gameContext.riskSummary || 'proceed with caution'}`);
    return verdict === 'BET' ? 'CONSIDER' : verdict;
  }
  if (gameContext && gameContext.riskFlag === 'low') {
    reasons.push(`game_context riskFlag = "low" — ${gameContext.riskSummary || 'minor flag'}`);
  } else if (gameContext && gameContext.riskFlag === 'unknown' && gameContext.riskSummary) {
    reasons.push(`game_context: ${gameContext.riskSummary}`);
  }
  return verdict;
}

function collectRiskFlags(research, gameContext, disposition) {
  const flags = [];
  if (research?.riskFlag && research.riskFlag !== 'low' && research.riskFlag !== 'clean') {
    flags.push(`player_context: ${research.riskFlag}`);
  }
  if (gameContext?.riskFlag && gameContext.riskFlag !== 'low' && gameContext.riskFlag !== 'clean') {
    flags.push(`game_context: ${gameContext.riskFlag}`);
  }
  if (disposition === 'adverse_recent' || disposition === 'adverse_full') flags.push('movement adverse');
  return flags;
}

function buildActionableSummary({ verdict, lookupStatus, matchingRow, args, disposition, riskFlags }) {
  if (riskFlags.length === 0 && verdict === 'BET') return 'No red flags. Clean play across all checks.';
  if (verdict === 'BET') return `BET with caution — flags: ${riskFlags.join(', ')}`;
  if (lookupStatus === 'lookup_failed') {
    return "Couldn't be rehydrated from the current screen snapshot. Treat as stale / unverified, not an automatic fade.";
  }
  if (verdict !== 'CONSIDER') return 'PASS — one or more hard checks failed.';

  const cbk = Number(matchingRow?.consensusBookCount || 0);
  const edge = Number(matchingRow?.consensusEdge || args.screenConsensusEdge || 0);
  const clv = Number(matchingRow?.clvProxyPct || 0);
  const suffix = riskFlags.length > 0 ? ` — ${riskFlags.join(', ')}` : '';
  let summary;
  if (cbk >= 10 && disposition === 'supportive_clean') {
    summary = `Deep consensus (${cbk} books, ${edge.toFixed(1)}% edge). Clean movement — playable with standard sizing.`;
  } else if (cbk >= 8 && disposition === 'supportive_clean' && edge > 1.5) {
    summary = `Strong signal across deep consensus (${cbk} books, ${edge.toFixed(1)}% edge). Playable with standard sizing.`;
  } else if (cbk >= 8 && disposition === 'supportive_bouncy' && edge > 1.0) {
    summary = `Deep consensus (${cbk} books, ${edge.toFixed(1)}% edge). Direction is right but path was rocky — standard sizing.`;
  } else if (cbk >= 8 && disposition === 'supportive_clean') {
    summary = `Deep consensus (${cbk} books). Clean movement, edge is thin (${edge.toFixed(1)}%) — reduce stake.`;
  } else if (cbk >= 8 && disposition === 'supportive_bouncy') {
    summary = `Deep consensus (${cbk} books). Bouncy movement, edge is thin (${edge.toFixed(1)}%) — reduce stake${suffix}.`;
  } else if (cbk >= 5 && disposition === 'supportive_clean' && edge > 0.5) {
    summary = `Solid signal — ${cbk} books agree, clean movement. Standard sizing${suffix}.`;
  } else if (cbk >= 5 && disposition === 'supportive_bouncy' && edge > 0.5) {
    summary = `Decent consensus (${cbk} books, ${edge.toFixed(1)}% edge). Bouncy but direction is right — reduce stake${suffix}.`;
  } else if (cbk >= 3 && disposition !== 'adverse_recent') {
    summary = `Thin consensus (${cbk} books) but direction is right. Reduce stake or skip${suffix}.`;
  } else if (cbk >= 1) {
    summary = `Marginal — only ${cbk} book${cbk > 1 ? 's' : ''} in consensus. Skip unless you have a strong read${suffix}.`;
  } else {
    summary = `No comp book consensus. Pass${suffix}.`;
  }
  if (clv > 4) summary += ` Strong CLV (${clv.toFixed(1)}%) confirms the move direction.`;
  else if (clv < -4) summary += ` Weak CLV (${clv.toFixed(1)}%) — line moved against you. Reduce stake or pass.`;
  return summary;
}

function buildRationale({ matchingRow, args, disposition, consensusDrift, driftReason }) {
  const parts = [];
  const sharpSource = matchingRow?.sharpBookMovementSource || null;
  if (sharpSource) parts.push(`${sharpSource} confirms`);
  if (disposition === 'supportive_clean') parts.push('clean movement');
  else if (disposition === 'supportive_bouncy') parts.push('direction right, bouncy path');
  else if (disposition === 'adverse_recent' || disposition === 'adverse_full') parts.push('movement went against');
  else if (disposition === 'insufficient') parts.push('no directional signal');
  const cbk = Number(matchingRow?.consensusBookCount || 0);
  if (cbk >= 3) parts.push(`${cbk} books`);
  const edge = Number(matchingRow?.consensusEdge || args.screenConsensusEdge || 0);
  if (edge > 0) parts.push(`+${edge.toFixed(1)}% edge`);
  const clv = Number(matchingRow?.clvProxyPct ?? 0);
  if (clv > 0) parts.push(`+${clv.toFixed(1)}% CLV`);
  else if (clv < 0) parts.push(`${clv.toFixed(1)}% CLV`);
  else parts.push('0% CLV');
  if (consensusDrift && driftReason) parts.push(`drift: ${driftReason}`);
  return parts.length ? parts.join(' · ') : null;
}

function buildValidationVerdict({
  args,
  matchingRow,
  matchedViaGameIdChange,
  detailError,
  fallbackNote,
  gameId,
  selection,
  research,
  gameContext
}) {
  const base = resolveBaseVerdict({
    args,
    matchingRow,
    matchedViaGameIdChange,
    detailError,
    fallbackNote,
    gameId,
    selection
  });
  let { verdict, tier } = base;
  const reasons = base.reasons;
  verdict = applyResearchRisk(verdict, reasons, research);
  verdict = applyGameContextRisk(verdict, reasons, gameContext);

  const rowForDisposition = matchingRow ? { ...matchingRow } : null;
  if (rowForDisposition && !rowForDisposition.sharpBookMovementConfirmed && args.screenSharpBookConfirmed) {
    rowForDisposition.sharpBookMovementConfirmed = true;
  }
  const disposition = rowForDisposition ? computeMovementDisposition(rowForDisposition) : 'insufficient';
  if ((disposition === 'adverse_recent' || disposition === 'adverse_full') && tier !== 'TIER 4') {
    tier = 'TIER 3';
    reasons.push(`movement ${disposition} — tier downgraded from screen snapshot`);
  }

  const riskFlags = collectRiskFlags(research, gameContext, disposition);
  const actionableSummary = buildActionableSummary({
    verdict,
    lookupStatus: base.lookupStatus,
    matchingRow,
    args,
    disposition,
    riskFlags
  });
  const verdictSummary = {
    displayTier: verdict === 'BET' ? 'BET' : verdict === 'CONSIDER' ? 'CONSIDER' : 'PASS',
    movementDisposition: disposition,
    movementStatus: STATUS_MESSAGES[disposition] || 'unknown',
    executionQuality: matchingRow?.executionQuality || null,
    consensusSupport: matchingRow?.consensusBookCount > 0 ? `${matchingRow.consensusBookCount} books` : 'no consensus',
    riskFlags,
    actionableSummary,
    rationale: buildRationale({
      matchingRow,
      args,
      disposition,
      consensusDrift: base.consensusDrift,
      driftReason: base.driftReason
    })
  };

  return {
    verdict,
    tier,
    lookupStatus: base.lookupStatus,
    reasonType: base.reasonType,
    reasons,
    verdictSummary,
    consensusDrift: base.consensusDrift,
    driftReason: base.driftReason
  };
}

module.exports = { buildValidationVerdict };
