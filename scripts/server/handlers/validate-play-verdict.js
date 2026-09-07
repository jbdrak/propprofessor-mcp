'use strict';

const { confirmExecution } = require('../../../lib/execution-confirmation');

const STATUS_MESSAGES = {
  supportive_clean: 'all signals aligned — green movement, supportive direction, clean path',
  supportive_bouncy: 'direction is right but path was rocky — yellow grade or V-shaped recovery',
  adverse_recent: 'recent movement turned adverse — the direction went against the play recently',
  adverse_full: 'full-window direction is adverse — do not bet',
  insufficient: 'not enough data to evaluate movement quality'
};

function tierForKaiCall(kaiCall) {
  if (kaiCall === 'BET') return 'TIER 1';
  if (kaiCall === 'CONSIDER') return 'TIER 2';
  return 'TIER 4';
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
  if (disposition === 'insufficient') {
    return `Comparable movement history is insufficient${cbk ? ` (${cbk} books visible)` : ''}. Treat this as unresolved, not as a directional signal.`;
  }
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
  args = {},
  matchingRow,
  matchedViaGameIdChange,
  detailError,
  fallbackNote,
  gameId,
  selection,
  research,
  gameContext
}) {
  const scanSourced = args.screenKaiCall != null;
  const currentOdds = matchingRow ? (matchingRow.odds ?? matchingRow.currentOdds ?? null) : null;
  const rankedOdds = scanSourced ? (args.screenOdds ?? null) : currentOdds;
  const lookupError = detailError
    ? detailError instanceof Error
      ? detailError
      : new Error(String(detailError))
    : null;
  const confirmation = confirmExecution({
    rankedOdds,
    currentOdds,
    currentRow: matchingRow || null,
    quoteAsOf: matchingRow?.quoteAsOf || matchingRow?.updatedAt || null,
    lookupError,
    matchedViaGameIdChange: Boolean(matchedViaGameIdChange),
    expectedGameId: gameId ?? null
  });

  const reasons = [];
  let lookupStatus = 'resolved';
  let reasonType = 'signal';
  if (matchedViaGameIdChange && matchingRow) {
    lookupStatus = 'gameId_changed';
    reasonType = 'gameId_changed';
    reasons.push(`gameId changed (${gameId} → ${matchingRow.gameId}); matched by league/market/selection/date`);
  }
  if (!matchingRow) {
    lookupStatus = 'lookup_failed';
    reasonType = 'lookup_failure';
    reasons.push(
      detailError
        ? `screen lookup failed: ${detailError instanceof Error ? detailError.message : detailError}`
        : `no row matched selection "${selection}" on gameId ${gameId}${fallbackNote ? ` (fallback: ${fallbackNote})` : ''}`
    );
  }

  let verdict;
  let tier;
  if (scanSourced) {
    verdict = args.screenKaiCall;
    tier = args.screenTier || tierForKaiCall(verdict);
    if (verdict !== 'BET' && verdict !== 'CONSIDER') {
      verdict = 'PASS';
      tier = 'TIER 4';
    }
  } else if (matchingRow) {
    verdict = matchingRow.kaiCall || 'PASS';
    if (verdict !== 'BET' && verdict !== 'CONSIDER') verdict = 'PASS';
    tier = matchingRow.confidenceTier || tierForKaiCall(verdict);
  } else {
    verdict = 'CONSIDER';
    tier = 'TIER 4';
  }
  if (verdict === 'PASS') tier = 'TIER 4';

  const confirmationFailed = ['moved', 'gone', 'ambiguous', 'error'].includes(confirmation.status);
  if (confirmationFailed && verdict === 'BET') {
    verdict = 'CONSIDER';
    reasons.push(`execution ${confirmation.status}: ${confirmation.reason} — downgraded from ranker BET`);
  } else {
    reasons.push(`execution ${confirmation.status}: ${confirmation.reason}`);
  }

  if (research?.riskFlag) {
    reasons.push(`player_context riskFlag = "${research.riskFlag}" (context only, verdict unchanged)`);
  }
  if (gameContext?.riskFlag) {
    reasons.push(
      `game_context riskFlag = "${gameContext.riskFlag}"${gameContext.riskSummary ? ` — ${gameContext.riskSummary}` : ''} (context only, verdict unchanged)`
    );
  }
  const exec = String(matchingRow?.executionQuality || '');
  if (exec) reasons.push(`execution quality is "${exec}" (context only)`);
  const cbk = Number(matchingRow?.consensusBookCount || 0);
  if (matchingRow) {
    if (cbk >= 3) reasons.push(`consensus: ${cbk} comp books agree`);
    else if (cbk >= 1) reasons.push(`consensus: ${cbk} comp book (thin)`);
    else reasons.push('no comp book consensus');
  }

  const consensusDrift = confirmation.status === 'moved';
  const driftReason = consensusDrift ? confirmation.reason : null;
  let disposition = scanSourced
    ? args.screenMovementDisposition || matchingRow?.movementDisposition || 'insufficient'
    : matchingRow?.movementDisposition || 'insufficient';
  const fallbackAdverse =
    !scanSourced &&
    matchingRow &&
    String(matchingRow.movementMode || '').toLowerCase() === 'mixed_books_fallback' &&
    String(disposition).toLowerCase().startsWith('adverse') &&
    !matchingRow.movementSourceBook;
  if (fallbackAdverse) {
    disposition = 'insufficient';
    reasons.push('fallback history was not comparable enough to authorize an adverse movement flip');
    if (verdict === 'BET' || (verdict === 'PASS' && matchingRow.kaiCall === 'PASS')) {
      verdict = 'CONSIDER';
      tier = 'TIER 2';
    }
  }
  const riskFlags = collectRiskFlags(research, gameContext, disposition);
  const verdictSummary = {
    displayTier: verdict === 'BET' ? 'BET' : verdict === 'CONSIDER' ? 'CONSIDER' : 'PASS',
    movementDisposition: disposition,
    movementStatus: STATUS_MESSAGES[disposition] || 'unknown',
    executionQuality: matchingRow?.executionQuality || null,
    consensusSupport: matchingRow?.consensusBookCount > 0 ? `${matchingRow.consensusBookCount} books` : 'no consensus',
    riskFlags,
    actionableSummary: buildActionableSummary({ verdict, lookupStatus, matchingRow, args, disposition, riskFlags }),
    rationale: buildRationale({ matchingRow, args, disposition, consensusDrift, driftReason })
  };

  return {
    verdict,
    tier,
    lookupStatus,
    reasonType,
    reasons,
    verdictSummary,
    consensusDrift,
    driftReason,
    confirmation
  };
}

module.exports = { buildValidationVerdict };
