'use strict';

/**
 * Shared validation pipeline for quick_screen and recommended_bets
 * (plan Task 4.1: extract duplicated validation workflow from
 * scripts/server/handlers.js).
 *
 * Both handlers ran the same validate/cache/timeout/apply loop with only the
 * selection strategy, row vocabulary, and validate-call argument builder
 * differing. This module is the single parameterized copy:
 *
 *  - per-row cache keyed `gameId::selection::market` (keeps opposing
 *    Over/Under lines on the same game separate),
 *  - per-row validation with a bounded timeout (timers always cleared),
 *  - concurrency-bounded fan-out via the injected mapWithConcurrency,
 *  - wrapper-result normalization (`result.data` when it carries
 *    verdictSummary),
 *  - failure degradation (validationFailed / validationFailureReason),
 *  - injected apply functions so verdict/ranker semantics stay in the caller.
 *
 * The module is deliberately pure-ish: the validate function, row descriptors,
 * builders, and apply functions are dependencies, so it is testable with no
 * PropProfessor client and no network.
 */

/**
 * quick_screen selection strategy: pick the top N candidates GLOBALLY across
 * every league/market bucket, BET calls first, then screenScore descending.
 * Selection happens over the eligible subset only (matching the original
 * handler loop), and validateAll selects every eligible row.
 *
 * @param {Object} opts
 * @param {Array<{target: Object, entry: Object}>} opts.rows - All rows.
 * @param {Array<{target: Object, entry: Object}>} opts.eligible - Rows passing isEligible.
 * @param {boolean} opts.validateAll
 * @param {number} opts.validateTop
 * @param {(target: Object) => boolean} opts.isBet
 * @returns {Object[]} Selected target objects.
 */
function selectTopGlobal({ rows: _rows, eligible, validateAll, validateTop, isBet }) {
  if (validateAll) return eligible.map(({ target }) => target);
  return [...eligible]
    .sort((a, b) => {
      const betPriority = Number(isBet(b.target)) - Number(isBet(a.target));
      return betPriority || (Number(b.target.screenScore) || 0) - (Number(a.target.screenScore) || 0);
    })
    .slice(0, validateTop)
    .map(({ target }) => target);
}

/**
 * recommended_bets selection strategy: within each league bucket, take the
 * validateTop plays with the highest screenScore. The top N is computed over
 * the FULL bucket (before eligibility filtering), exactly like the original
 * handler loop — an ineligible row inside the top N is skipped downstream,
 * not replaced by the next eligible row.
 *
 * @param {Object} opts
 * @param {Array<{target: Object, entry: Object}>} opts.rows - All rows.
 * @param {boolean} opts.validateAll
 * @param {number} opts.validateTop
 * @returns {Object[]} Selected target objects.
 */
function selectTopPerBucket({ rows, validateAll, validateTop }) {
  if (validateAll) return rows.map(({ target }) => target);
  const buckets = new Map();
  for (const { target, entry } of rows) {
    if (!buckets.has(entry)) buckets.set(entry, []);
    buckets.get(entry).push(target);
  }
  const selected = [];
  for (const bucketRows of buckets.values()) {
    const sorted = [...bucketRows].sort((a, b) => (b.screenScore || 0) - (a.screenScore || 0));
    selected.push(...sorted.slice(0, validateTop));
  }
  return selected;
}

function selectTopBalanced({ rows: _rows, eligible, validateAll, validateTop, isBet }) {
  if (validateAll) return eligible.map(({ target }) => target);
  if (!Number.isFinite(validateTop) || validateTop <= 0) return [];

  const buckets = new Map();
  for (const row of eligible) {
    const key = row.entry;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }

  const ranked = (bucket) =>
    [...bucket].sort((a, b) => {
      const betPriority = Number(isBet(b.target)) - Number(isBet(a.target));
      return betPriority || (Number(b.target.screenScore) || 0) - (Number(a.target.screenScore) || 0);
    });
  const selected = [];
  const remaining = [];
  for (const bucket of buckets.values()) {
    const bucketRanked = ranked(bucket);
    if (bucketRanked[0]) selected.push(bucketRanked[0].target);
    remaining.push(...bucketRanked.slice(1));
  }
  if (selected.length >= validateTop) return selected.slice(0, validateTop);

  remaining.sort((a, b) => {
    const betPriority = Number(isBet(b.target)) - Number(isBet(a.target));
    return betPriority || (Number(b.target.screenScore) || 0) - (Number(a.target.screenScore) || 0);
  });
  selected.push(...remaining.slice(0, validateTop - selected.length).map(({ target }) => target));
  return selected;
}

/**
 * Run the shared validation pipeline over a set of rows.
 *
 * @param {Object} opts
 * @param {(args: Object) => Promise<Object>} opts.validate - Runs validate_play
 *   with the args returned by buildArgs. May reject or return a wrapped
 *   `{ ok, data }` envelope; the pipeline normalizes `result.data` when it
 *   carries `verdictSummary`.
 * @param {(target: Object, entry: Object) => Object} opts.buildArgs - Builds
 *   the validate args for a row.
 * @param {(target: Object, entry: Object) => string} opts.buildCacheKey - Cache
 *   key; must include gameId, selection, and market (contract: `gameId::selection::market`).
 * @param {Array<{target: Object, entry: Object}>} opts.rows - Every row in every
 *   bucket, in original iteration order.
 * @param {(target: Object) => boolean} opts.isEligible - A row must pass to be
 *   validated (e.g. has gameId+selection and is not altLineFiltered).
 * @param {(target: Object) => boolean} opts.isBet - kaiCall === 'BET'.
 * @param {(sel: Object) => Object[]} opts.selectTargets - Selection strategy
 *   (selectTopGlobal / selectTopPerBucket); called with
 *   `{ rows, eligible, validateAll, validateTop, isBet }`.
 * @param {(target: Object, entry: Object) => void} opts.onNotSelected - Called for each BET row
 *   outside the selected set, before eligibility filtering (matches the
 *   original loop order). Receives the row's entry (league/market) so callers
 *   can stamp the market onto budget-skipped watch candidates.
 * @param {(target: Object, validation: Object) => void} opts.applyValidated -
 *   Merges validated fields and recomputes the final verdict for a row.
 * @param {boolean} opts.validateAll - Validate every eligible row.
 * @param {number} opts.validateTop - Cap on rows validated when validateAll is false.
 * @param {number} [opts.timeoutMs=15000] - Per-row validation timeout.
 * @param {number} [opts.concurrency=5] - Max in-flight validations.
 * @param {(items: Array, worker: Function, opts: Object) => Promise<Array>} opts.mapWithConcurrency
 *   - Concurrency mapper (required dependency, injected for testability).
 * @returns {Promise<{eligibleCount: number, selectedCount: number, partial: boolean}>}
 *   Counts of BET rows (eligible/selected) and whether selection was partial.
 */
async function runValidationPipeline({
  validate,
  buildArgs,
  buildCacheKey,
  rows,
  isEligible,
  isBet,
  selectTargets,
  onNotSelected,
  applyValidated,
  validateAll,
  validateTop,
  timeoutMs = 15000,
  concurrency = 5,
  mapWithConcurrency
}) {
  if (typeof mapWithConcurrency !== 'function') {
    throw new TypeError('runValidationPipeline: mapWithConcurrency is required');
  }

  const eligible = rows.filter(({ target }) => isEligible(target));
  const eligibleBetCount = eligible.filter(({ target }) => isBet(target)).length;
  const selected = selectTargets({ rows, eligible, validateAll, validateTop, isBet });
  const selectedSet = new Set(selected);
  const selectedBetCount = selected.filter((target) => isBet(target)).length;

  // Per-gameId+selection+market identity cache. The original synchronous
  // fan-out creates all promises before results populate this map, so same-key
  // rows validate independently. Preserve that behavior. The selection still
  // MUST be part of the key so Over and Under never share a result.
  const validationCache = new Map();
  const validationJobs = [];

  // Build a lazy validation job (thunk). The promise is created only when the
  // returned function is called, so mapWithConcurrency can cap how many run
  // concurrently. The previous implementation invoked an async IIFE
  // immediately, which started every validation up front and made `concurrency`
  // a no-op.
  function makeValidationJob(jobTarget, jobEntry, jobCacheKey) {
    return async () => {
      try {
        const validatePromise = validate(buildArgs(jobTarget, jobEntry));
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`Validation timeout for ${jobTarget.gameId}:${jobTarget.selection}`)),
            timeoutMs
          );
        });
        try {
          const result = await Promise.race([validatePromise, timeoutPromise]);
          if (jobTarget.gameId && result && result.ok) {
            validationCache.set(jobCacheKey, result);
          }
          return { target: jobTarget, result };
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (err) {
        const errorMessage = err?.message || String(err);
        jobTarget.validationFailed = true;
        jobTarget.validationFailureReason = errorMessage;
        return { target: jobTarget, result: null, error: errorMessage };
      }
    };
  }

  for (const { target, entry } of rows) {
    // Mark budget-skipped BET rows BEFORE the eligibility check, matching the
    // original loop order (a non-selected BET is flagged even when ineligible).
    if (!selectedSet.has(target) && isBet(target)) onNotSelected(target, entry);
    if (!selectedSet.has(target)) continue;
    if (!isEligible(target)) continue;

    const cacheKey = buildCacheKey(target, entry);
    if (validationCache.has(cacheKey)) {
      const cached = validationCache.get(cacheKey);
      if (cached) applyValidated(target, cached);
      continue;
    }

    validationJobs.push(makeValidationJob(target, entry, cacheKey));
  }

  const validationResults = await mapWithConcurrency(validationJobs, async (job) => job(), { concurrency });

  for (const vr of validationResults) {
    const validation = vr.result?.data?.verdictSummary ? vr.result.data : vr.result;
    if (!validation || !validation.ok || !validation.verdictSummary) {
      vr.target.validationFailed = true;
      continue;
    }
    applyValidated(vr.target, validation);
  }

  return {
    eligibleCount: eligibleBetCount,
    selectedCount: selectedBetCount,
    partial: selectedBetCount < eligibleBetCount
  };
}

module.exports = { runValidationPipeline, selectTopGlobal, selectTopPerBucket, selectTopBalanced };
