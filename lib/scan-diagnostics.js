'use strict';

/**
 * Pure scan-diagnostics formatter for pp scan output.
 *
 * Returns human-readable diagnostic lines (stderr material) for a scan
 * result that already carries the raw data: truncation/health info,
 * empty league×market pairs, and the tennis-fallback-on-mixed-scan caveat.
 *
 * Pure by design — no console, no process, no fs — so it can be unit
 * tested and rendered by any caller (CLI stderr, JSON, future UIs).
 */

const MAX_EMPTY_PAIRS_SHOWN = 12;

/**
 * Build diagnostic lines for a scan result.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.mixedScan] - True when the scan covered more than
 *   one league and at least one non-tennis league was requested.
 * @param {boolean} [opts.tennisFallbackApplied] - True when the tennis
 *   fallback actually injected plays into a scan that requested tennis.
 * @param {Array<Object>} [opts.emptySlate] - League×market pairs that
 *   returned zero rows, each with league/market/reason.
 * @param {Object|null} [opts.scanHealth] - quick_screen scanHealth payload
 *   (truncated, incomplete, validationBudgetExhausted, preHistoryShortlist,
 *   validation: {eligible, selected, completedCount}).
 * @param {number} [opts.playCount] - Total plays surviving the final scan
 *   output (after validation + filters). Used to detect the stale-label
 *   case: candidates were found and ranked as BETs, but fresh validation
 *   downgraded every one of them, so the slate LOOKS dead when it isn't.
 * @returns {string[]} Diagnostic lines. Empty array when nothing to say.
 */
function formatScanDiagnostics({
  mixedScan = false,
  tennisFallbackApplied = false,
  emptySlate = [],
  scanHealth = null,
  playCount = 0
} = {}) {
  const lines = [];

  const health = scanHealth && typeof scanHealth === 'object' ? scanHealth : {};
  const healthIncomplete = Boolean(health.incomplete || health.validationBudgetExhausted);
  const healthTruncated = Boolean(health.truncated);
  const leaguesWithIssues = (Array.isArray(health.preHistoryShortlist) ? health.preHistoryShortlist : [])
    .filter((pair) => pair && pair.truncated)
    .map((pair) => pair.league)
    .filter(Boolean);

  if (healthIncomplete || healthTruncated) {
    if (healthTruncated) {
      lines.push(
        `Warning: scan incomplete/truncated${leaguesWithIssues.length ? ` for ${[...new Set(leaguesWithIssues)].join(', ')}` : ''}; some rows were not hydrated.`
      );
    }
    // "Diagnostic only" means the shared validation budget was actually
    // exhausted and BET candidates never got a validate_play call. Plain
    // shortlist truncation (truncated/incomplete without the budget flag)
    // only means some weaker rows weren't hydrated — the plays shown ARE
    // hydrated and carry real CLV/movement evidence, so they are not
    // demoted to watch candidates.
    if (health.validationBudgetExhausted) {
      lines.push(
        'Warning: scan validation budget exhausted; BET candidates are diagnostic only (never official bets).'
      );
      const hintLeague = leaguesWithIssues[0] || health.league;
      if (hintLeague) lines.push(`Recovery: run pp rank ${hintLeague} for a focused scan.`);
    }
  }

  // Stale-label detection: candidates were found and ranked as BETs, but
  // fresh validation downgraded every one (or all were budget-skipped), so
  // the slate LOOKS dead when it isn't. This happens when the shared
  // odds-history budget degrades mid-scan — scan-time movement labels go
  // stale and the validator correctly re-rejects them. Tell the user the
  // plays exist; they just need a re-scan or a focused `pp rank` run.
  const validationEligible = Number(health.validation?.eligible || 0);
  if (validationEligible > 0 && playCount === 0) {
    const hintLeague = leaguesWithIssues[0] || health.league;
    lines.push(
      `${validationEligible} BET candidate${validationEligible === 1 ? '' : 's'} found but ${
        health.validation?.completedCount > 0
          ? 'none survived fresh validation (stale scan labels)'
          : 'skipped (validation budget)'
      }. Re-scan or run pp rank ${hintLeague || '<league>'} for fresh data.`
    );
  }

  if (Array.isArray(emptySlate) && emptySlate.length) {
    const shown = emptySlate.slice(0, MAX_EMPTY_PAIRS_SHOWN);
    for (const pair of shown) {
      if (!pair || (!pair.league && !pair.market)) continue;
      const league = pair.league || '?';
      const market = pair.market || '?';
      lines.push(`No plays: ${league} › ${market}${pair.reason ? ` (${pair.reason})` : ''}`);
    }
    if (emptySlate.length > MAX_EMPTY_PAIRS_SHOWN) {
      lines.push(`…and ${emptySlate.length - MAX_EMPTY_PAIRS_SHOWN} more empty league/market pairs.`);
    }
  }

  if (mixedScan && tennisFallbackApplied) {
    lines.push(
      'Tennis fallback filled this mixed scan; other leagues may be empty or truncated. Run pp rank <league> (or pp scan mlb / pp scan ufc) before treating this as a full slate.'
    );
  }

  return lines;
}

module.exports = { formatScanDiagnostics };
