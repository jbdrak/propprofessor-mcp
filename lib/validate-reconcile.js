'use strict';

/**
 * Reconcile screen-snapshot signals against validate-path re-derivations.
 *
 * The validate path (runValidatePlayImpl) re-fetches and re-derives
 * executionQuality + movementDisposition a few seconds after the screen
 * snapshot, using PP-feed values + computeMovementDisposition on a fresh
 * snapshot. It has historically SILENTLY overridden the screen's clean
 * signal even when nothing material changed (re-derivation noise / a
 * different classifier). This helper keeps the screen's signal unless the
 * re-fetch shows a REAL, explainable change (consensus actually drifted).
 *
 * @param {Object} a
 * @param {string} a.screenExec        executionQuality from the screen snapshot
 * @param {string} a.screenDisposition movementDisposition from the screen snapshot
 * @param {string} a.validateExec      executionQuality from the validate re-fetch
 * @param {string} a.validateDisposition movementDisposition from the validate re-fetch
 * @param {boolean} a.consensusDrift   already-computed screen-vs-refetch drift flag
 * @returns {{executionQuality:string, movementDisposition:string, overridden:boolean, reason:string}}
 */
// @ts-expect-error
function reconcileValidateOverride({
  screenExec = 'unknown',
  screenDisposition = 'insufficient',
  validateExec = 'unknown',
  validateDisposition = 'insufficient',
  consensusDrift = false
} = {}) {
  let overridden = false;
  const reasons = [];

  // --- executionQuality ---
  // Screen used our classifier (classifyExecutionQuality): 'bad' only when
  // >300c off-market. If validate says 'bad' but screen said playable/best
  // and consensus did NOT drift, the validate 'bad' is unconfirmed — keep
  // the screen signal.
  let executionQuality = validateExec;
  const screenAcceptable = screenExec === 'playable' || screenExec === 'best';
  if (validateExec === 'bad' && screenAcceptable && !consensusDrift) {
    executionQuality = screenExec;
    overridden = true;
    reasons.push('validate bad contradicted screen ' + screenExec + '; no consensus drift; kept screen signal');
  }

  // --- movementDisposition ---
  // Keep the screen disposition unless validate shows a MATERIAL downgrade
  // AND consensus actually drifted. Without drift, signal flips on
  // re-derivation are noise — the re-fetched row often lacks computed fields
  // (e.g. sharpBookMovementConfirmed) that the screen snapshot had.
  const adverse = (d) => String(d).startsWith('adverse');
  const supportive = (d) => String(d).startsWith('supportive');
  const screenAdverse = adverse(screenDisposition);
  const screenSupportive = supportive(screenDisposition);
  const validateAdverse = adverse(validateDisposition);
  const validateInsufficient = String(validateDisposition) === 'insufficient';
  let movementDisposition = validateDisposition;
  if (validateAdverse && !screenAdverse && !consensusDrift) {
    movementDisposition = screenDisposition;
    overridden = true;
    reasons.push('adverse disposition on re-fetch without consensus drift; kept screen signal');
  } else if (validateInsufficient && screenSupportive) {
    movementDisposition = screenDisposition;
    overridden = true;
    reasons.push(
      'insufficient on re-fetch (likely missing computed fields) but screen was ' +
        screenDisposition +
        '; kept screen signal'
    );
  }

  return {
    executionQuality,
    movementDisposition,
    overridden,
    reason: reasons.join('; ') || 'screen and validate agree'
  };
}

module.exports = { reconcileValidateOverride };
