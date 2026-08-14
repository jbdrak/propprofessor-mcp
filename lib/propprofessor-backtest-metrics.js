'use strict';

/**
 * Financial backtest metrics for resolved prop bets.
 *
 * The PropProfessor API does not serve historical resolved results, so outcomes
 * are recorded by the user against saved snapshots (scripts/backtest.js
 * --resolve). Each resolved play carries the taken odds, the stake, and the
 * actual result. From that we compute the metrics a bettor actually cares about:
 * P&L, ROI, Sharpe (risk-adjusted return), and max drawdown.
 *
 * All functions here are PURE and unit-tested — no I/O, no live API.
 */

/**
 * Profit (in dollars) for a single resolved play.
 * @param {number} odds - American odds taken (e.g. -110, +150)
 * @param {number} stake - dollars wagered
 * @param {string} result - 'won' | 'lost' | 'push'
 * @returns {number} net profit (negative on a loss, 0 on push)
 */
function playProfit(odds, stake, result) {
  if (result === 'push') return 0;
  if (result === 'lost') return -stake;
  // won
  if (odds > 0) return stake * (odds / 100);
  return stake * (100 / Math.abs(odds));
}

/**
 * Compute aggregate metrics from a list of resolved plays.
 * @param {Array<{odds:number, stake:number, result:string}>} plays
 * @returns {{
 *   bets: number,
 *   wins: number, losses: number, pushes: number,
 *   winRate: number|null,
 *   profit: number,
 *   roi: number|null,
 *   sharpe: number|null,
 *   maxDrawdown: number
 * }}
 */
function computeBacktestMetrics(plays) {
  const safePlays = Array.isArray(plays) ? plays : [];
  const wins = safePlays.filter((p) => p.result === 'won').length;
  const losses = safePlays.filter((p) => p.result === 'lost').length;
  const pushes = safePlays.filter((p) => p.result === 'push').length;
  const decidable = wins + losses;

  let profit = 0;
  let totalStaked = 0;
  for (const p of safePlays) {
    const stake = Number.isFinite(Number(p.stake)) ? Number(p.stake) : 0;
    totalStaked += stake;
    profit += playProfit(Number(p.odds), stake, p.result);
  }

  const roi = totalStaked > 0 ? (profit / totalStaked) * 100 : null;
  const winRate = decidable > 0 ? (wins / decidable) * 100 : null;
  const sharpe = computeSharpe(safePlays);
  const maxDrawdown = computeMaxDrawdown(safePlays);

  return {
    bets: safePlays.length,
    wins,
    losses,
    pushes,
    winRate: winRate === null ? null : Math.round(winRate * 10) / 10,
    profit: Math.round(profit * 100) / 100,
    roi: roi === null ? null : Math.round(roi * 10) / 10,
    sharpe,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100
  };
}

/**
 * Per-play return (as a ratio of stake) used for Sharpe.
 * @returns {number[]} return multiples, one per play (push = 0)
 */
function playReturns(plays) {
  return plays.map((p) => {
    const stake = Number.isFinite(Number(p.stake)) ? Number(p.stake) : 0;
    if (stake === 0) return 0;
    return playProfit(Number(p.odds), stake, p.result) / stake;
  });
}

/**
 * Annualized-ish Sharpe ratio of per-play returns.
 * Uses sample stdev; returns null when fewer than 2 plays or zero variance.
 * @param {Array} plays
 * @returns {number|null}
 */
function computeSharpe(plays) {
  const rets = playReturns(plays);
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const stdev = Math.sqrt(variance);
  if (stdev === 0) return null;
  return Math.round((mean / stdev) * 100) / 100;
}

/**
 * Maximum drawdown: the largest peak-to-trough drop in the running
 * cumulative profit curve.
 * @param {Array} plays
 * @returns {number} a non-positive number (0 means no drawdown)
 */
function computeMaxDrawdown(plays) {
  let peak = 0;
  let running = 0;
  let maxDd = 0;
  for (const p of plays) {
    const stake = Number.isFinite(Number(p.stake)) ? Number(p.stake) : 0;
    running += playProfit(Number(p.odds), stake, p.result);
    if (running > peak) peak = running;
    const dd = running - peak;
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd;
}

/* ---------------------------------------------------------------------------
 * Probability scoring metrics (Wave B3)
 *
 * Brier score, log loss, and calibration bins evaluate how well probability
 * estimates (model, market fair, ELO) track settled binary outcomes. Each row
 * is { outcome: 'win'|'loss' (or 'won'|'lost' aliases), <field>: 0..1, ... }.
 * Pushes, unknown outcomes, and missing/null/out-of-range probabilities are
 * excluded from scoring. A missing probability field is NEVER silently
 * substituted with another field — if a field has no eligible rows its score
 * is omitted entirely.
 * ------------------------------------------------------------------------- */

const WIN_OUTCOMES = new Set(['win', 'won']);
const LOSS_OUTCOMES = new Set(['loss', 'lost']);
const DEFAULT_PROBABILITY_FIELDS = ['marketFairProbability', 'modelWinProbability', 'eloWinProbability'];

/** Round to 6 decimal places for stable reporting (kills 0.30000000000000004 artifacts). */
function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Map a settled outcome to a binary result (1 = win, 0 = loss), or null when
 * the outcome is not decidable (push, unknown, missing).
 * @param {*} outcome
 * @returns {number|null}
 */
function outcomeToBinary(outcome) {
  if (typeof outcome !== 'string') return null;
  const normalized = outcome.toLowerCase();
  if (WIN_OUTCOMES.has(normalized)) return 1;
  if (LOSS_OUTCOMES.has(normalized)) return 0;
  return null;
}

/**
 * A usable probability is a finite number in [0, 1].
 * @param {*} value
 * @returns {boolean}
 */
function isValidProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Reduce rows to the ones that can actually be scored for a probability
 * field: decidable binary outcomes with a valid probability present.
 * @param {Array<{outcome:string}>} rows
 * @param {string} probabilityField
 * @returns {Array<{outcome:number, probability:number}>}
 */
function collectScorableRows(rows, probabilityField) {
  const scorable = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const outcome = outcomeToBinary(row && row.outcome);
    const probability = row ? row[probabilityField] : undefined;
    if (outcome !== null && isValidProbability(probability)) {
      scorable.push({ outcome, probability });
    }
  }
  return scorable;
}

/**
 * Brier score: mean squared error of predicted probability vs binary outcome.
 * Lower is better; 0 is a perfect forecast. The mean is rounded to 6 decimal
 * places to keep results stable for reporting without discarding precision.
 * @param {Array<{outcome: string}>} rows
 * @param {string} probabilityField
 * @returns {{value: number|null, samples: number}}
 */
function brierScore(rows, probabilityField) {
  const scorable = collectScorableRows(rows, probabilityField);
  if (scorable.length === 0) return { value: null, samples: 0 };
  let sum = 0;
  for (const { outcome, probability } of scorable) {
    sum += (outcome - probability) ** 2;
  }
  return { value: round6(sum / scorable.length), samples: scorable.length };
}

/**
 * Log loss (binary cross-entropy): -mean(ln(p) for wins, ln(1-p) for losses).
 * Lower is better. Probabilities are clamped to [epsilon, 1-epsilon] so a
 * single overconfident 0/1 prediction cannot blow the score to Infinity.
 * Default epsilon is 1e-15 — tiny but still-valid probabilities (e.g. 1e-12)
 * pass through unclamped instead of being flattened to a 1e-9 floor.
 * @param {Array<{outcome: string}>} rows
 * @param {string} probabilityField
 * @param {{epsilon?: number}} [opts]
 * @returns {{value: number|null, samples: number}}
 */
function logLoss(rows, probabilityField, opts) {
  const scorable = collectScorableRows(rows, probabilityField);
  if (scorable.length === 0) return { value: null, samples: 0 };
  const requested = opts && Number.isFinite(opts.epsilon) && opts.epsilon > 0 ? opts.epsilon : 1e-15;
  const epsilon = Math.min(requested, 0.5);
  let sum = 0;
  for (const { outcome, probability } of scorable) {
    const clamped = Math.min(Math.max(probability, epsilon), 1 - epsilon);
    sum += outcome === 1 ? -Math.log(clamped) : -Math.log(1 - clamped);
  }
  return { value: round6(sum / scorable.length), samples: scorable.length };
}

/**
 * Convert American odds to the MARKET IMPLIED probability — vig included.
 * E.g. -110 → 0.5238, +150 → 0.4. This is deliberately NOT a no-vig/fair
 * probability; de-vigging is out of scope here.
 * @param {number} odds - American odds (e.g. -110, +150); 0 is invalid
 * @returns {number|null} implied probability in [0, 1], or null when invalid
 */
function americanOddsToProbability(odds) {
  if (typeof odds !== 'number' || !Number.isFinite(odds) || odds === 0) return null;
  if (odds > 0) return 100 / (odds + 100);
  return -odds / (100 - odds);
}

/**
 * Fixed-width calibration bins over [0, 1]. Empty bins are omitted; bins with
 * fewer than minSamplesPerBin rows are flagged insufficientSample so callers
 * can discount noisy buckets. Default minSamplesPerBin is 1 (a single sample
 * is NOT insufficient by default). lowerBound/upperBound/meanPredicted/
 * observedWinRate are rounded to 6 decimals for stable output.
 * @param {Array<{outcome: string}>} rows
 * @param {string} probabilityField
 * @param {{bins?: number, minSamplesPerBin?: number}} [opts]
 * @returns {Array<{lowerBound:number, upperBound:number, samples:number,
 *   meanPredicted:number, observedWinRate:number, insufficientSample:boolean}>}
 */
function calibrationBins(rows, probabilityField, opts) {
  const scorable = collectScorableRows(rows, probabilityField);
  if (scorable.length === 0) return [];
  const binCount = opts && Number.isInteger(opts.bins) && opts.bins > 0 ? opts.bins : 10;
  const minSamples =
    opts && Number.isInteger(opts.minSamplesPerBin) && opts.minSamplesPerBin >= 0 ? opts.minSamplesPerBin : 1;
  const width = 1 / binCount;

  const bins = [];
  for (let i = 0; i < binCount; i += 1) {
    bins.push({
      lowerBound: round6(i * width),
      upperBound: round6((i + 1) * width),
      samples: 0,
      sumPredicted: 0,
      wins: 0
    });
  }

  for (const { outcome, probability } of scorable) {
    const index = Math.min(Math.floor(probability / width), binCount - 1); // p === 1 lands in the last bin
    bins[index].samples += 1;
    bins[index].sumPredicted += probability;
    if (outcome === 1) bins[index].wins += 1;
  }

  const result = [];
  for (const bin of bins) {
    if (bin.samples === 0) continue;
    result.push({
      lowerBound: bin.lowerBound,
      upperBound: bin.upperBound,
      samples: bin.samples,
      meanPredicted: round6(bin.sumPredicted / bin.samples),
      observedWinRate: round6(bin.wins / bin.samples),
      insufficientSample: bin.samples < minSamples
    });
  }
  return result;
}

/**
 * Score every requested probability field against settled outcomes. Each
 * eligible field carries {brier, logLoss, calibration} where calibration is
 * the default-option bin table (bins with explicit sample counts). Fields
 * with no eligible rows are omitted entirely — a missing field is never
 * silently substituted with another probability source.
 * @param {Array<{outcome: string}>} rows
 * @param {string[]} [probabilityFields] - defaults to marketFairProbability,
 *   modelWinProbability, eloWinProbability
 * @returns {Object<string, {brier: {value:number|null, samples:number},
 *   logLoss: {value:number|null, samples:number},
 *   calibration: Array<{lowerBound:number, upperBound:number, samples:number,
 *     meanPredicted:number, observedWinRate:number, insufficientSample:boolean}>}>}
 */
function scoreEvaluationRows(rows, probabilityFields) {
  const fields = Array.isArray(probabilityFields) ? probabilityFields : DEFAULT_PROBABILITY_FIELDS;
  /** @type {Object<string, {brier: {value: number|null, samples: number}, logLoss: {value: number|null, samples: number}, calibration: Array<{lowerBound: number, upperBound: number, samples: number, meanPredicted: number, observedWinRate: number, insufficientSample: boolean}>}>} */
  const scores = {};
  for (const field of fields) {
    const brier = brierScore(rows, field);
    if (brier.samples === 0) continue;
    scores[field] = { brier, logLoss: logLoss(rows, field), calibration: calibrationBins(rows, field) };
  }
  return scores;
}

module.exports = {
  playProfit,
  computeBacktestMetrics,
  computeSharpe,
  computeMaxDrawdown,
  playReturns,
  brierScore,
  logLoss,
  calibrationBins,
  americanOddsToProbability,
  scoreEvaluationRows
};
