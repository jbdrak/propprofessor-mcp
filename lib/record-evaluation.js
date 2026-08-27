'use strict';

/**
 * Derived evaluation from the settled v2 ledger (Wave B2).
 *
 * Pure CommonJS: no IO, no network, no clock. All three functions are
 * deterministic functions of the ledger contents alone, so evaluation
 * reports are reproducible from a persisted ledger without a second
 * mutable truth store.
 *
 * Ledger contract (see lib/record-ledger):
 *   { version: 2, scans: [], candidates: [], bets: [], settlements: [] }
 *   - bets[i].id              stable official bet id
 *   - bets[i].featureSnapshot immutable decision-time features (schemaVersion 1)
 *   - settlements[i].betId    1:1 key back to the bet
 *   - settlements[i].status   'win' | 'loss' | 'push' | 'pending' | 'retirement'
 *     ('won'/'lost' legacy aliases are normalized here)
 *
 * Scope:
 *   - joinSettledBets   -> 1:1 bet+settlement rows for settled bets only
 *   - deriveCalibration -> per-signal hit-rate buckets keyed
 *                          `signalTier:movementGrade:league:market`
 *   - buildEvaluationRows -> flat, decision-time evaluation projection
 */

// Settlement statuses that count as decided outcomes. 'won'/'lost' are the
// legacy aliases written by older calibration consumers and are normalized
// to 'win'/'loss'. Everything else ('pending', 'retirement', ...) is not a
// settled outcome and is ignored by every function in this module.
const SETTLED_STATUSES = Object.freeze(['win', 'loss', 'push']);
const STATUS_ALIASES = Object.freeze({ won: 'win', lost: 'loss' });

// Legacy calibration defaults (lib/propprofessor-signal-calibration.js used
// these exact buckets when a signal was not recorded). Retained so derived
// calibration remains a drop-in shape for the legacy API.
const DEFAULT_SIGNAL_TIER = 'TIER 4';
const DEFAULT_MOVEMENT_GRADE = 'unknown';
const DEFAULT_LEAGUE = '?';
const DEFAULT_MARKET = '?';

const DEFAULT_MIN_SAMPLE = 30;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeStatus(status) {
  const normalized = String(status == null ? '' : status)
    .trim()
    .toLowerCase();
  if (STATUS_ALIASES[normalized]) return STATUS_ALIASES[normalized];
  return SETTLED_STATUSES.includes(normalized) ? normalized : null;
}

/**
 * Compare two settledAt timestamps. Returns <0, 0, >0. Unparseable values
 * sort as the oldest (-Infinity) so a recorded timestamp always beats a
 * missing one; identical timestamps compare equal (ties are then resolved
 * to the last settlement encountered in array order).
 */
function compareSettledAt(a, b) {
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  const aValue = Number.isNaN(aTime) ? -Infinity : aTime;
  const bValue = Number.isNaN(bTime) ? -Infinity : bTime;
  if (aValue === bValue) return 0;
  return aValue > bValue ? 1 : -1;
}

function snapshotOf(row) {
  return row && row.featureSnapshot && typeof row.featureSnapshot === 'object' && !Array.isArray(row.featureSnapshot)
    ? row.featureSnapshot
    : null;
}

/**
 * First value present among a snapshot field and a top-level legacy field.
 * Returns null only when neither records the value (never derives).
 */
function pick(snapshot, row, name) {
  if (snapshot && snapshot[name] != null) return snapshot[name];
  if (row && row[name] != null) return row[name];
  return null;
}

/**
 * Join the ledger's bets with their settlements into 1:1 rows for settled
 * bets only.
 *
 * Rules:
 *   - A row exists only for a bet that has at least one settlement whose
 *     status normalizes to 'win' | 'loss' | 'push'. 'won'/'lost' aliases
 *     normalize to 'win'/'loss'.
 *   - 'pending' and 'retirement' settlements are ignored entirely: they
 *     never block an earlier settled outcome and never produce a row.
 *   - When a betId has several settled settlements, the one with the latest
 *     `settledAt` wins; equal `settledAt` ties resolve to the last
 *     settlement encountered in ledger.settlements array order.
 *   - Orphan settlement rows (no matching bet) are NOT joined; bets with no
 *     settled settlement are NOT joined. Join is over actual bets only.
 *   - Output rows are deep clones: `{ ...bet, outcome, settlement }` where
 *     `outcome` is the normalized settled status and `settlement` is the
 *     winning settlement record. The input ledger is never mutated.
 *
 * @param {Object} ledger - v2 ledger (see lib/record-ledger)
 * @returns {Array<Object>} joined bet+settlement rows in bet order
 */
function joinSettledBets(ledger) {
  if (!ledger || typeof ledger !== 'object') return [];
  const bets = Array.isArray(ledger.bets) ? ledger.bets : [];
  const settlements = Array.isArray(ledger.settlements) ? ledger.settlements : [];

  const byBetId = new Map();
  for (const settlement of settlements) {
    if (!settlement || typeof settlement !== 'object') continue;
    const status = normalizeStatus(settlement.status);
    if (!status) continue;
    if (settlement.betId == null || settlement.betId === '') continue;
    const current = byBetId.get(settlement.betId);
    if (!current || compareSettledAt(settlement.settledAt, current.settlement.settledAt) >= 0) {
      byBetId.set(settlement.betId, { settlement, status });
    }
  }

  const rows = [];
  for (const bet of bets) {
    if (!bet || typeof bet !== 'object') continue;
    const betId = bet.id != null ? bet.id : bet.betId;
    if (betId == null) continue;
    const joined = byBetId.get(betId);
    if (!joined) continue;
    rows.push({
      ...clone(bet),
      outcome: joined.status,
      // The settlement clone is canonicalized: status/outcome/result are all
      // set to the normalized settled status (mirrors record-settlement's
      // settled(), which writes all three equal). Every other field stays an
      // exact copy of the stored record.
      settlement: { ...clone(joined.settlement), status: joined.status, outcome: joined.status, result: joined.status }
    });
  }
  return rows;
}

function resolveMinSample(opts) {
  const minSample = opts && opts.minSample !== undefined ? opts.minSample : DEFAULT_MIN_SAMPLE;
  if (!Number.isInteger(minSample) || minSample <= 0) {
    throw new TypeError(`minSample must be a positive integer, got ${String(minSample)}`);
  }
  return minSample;
}

function calibrationComponents(row) {
  const snapshot = snapshotOf(row);
  const signalTier = String(
    pick(snapshot, row, 'signalTier') ??
      pick(snapshot, row, 'confidenceTier') ??
      pick(snapshot, row, 'tier') ??
      DEFAULT_SIGNAL_TIER
  );
  const movementGrade = String(pick(snapshot, row, 'movementGrade') ?? DEFAULT_MOVEMENT_GRADE);
  const league = String(pick(snapshot, row, 'league') ?? row.league ?? DEFAULT_LEAGUE);
  const market = String(pick(snapshot, row, 'market') ?? row.market ?? DEFAULT_MARKET);
  return { signalTier, movementGrade, league, market };
}

/**
 * @typedef {Object} CalibrationBucket
 * @property {number} wins - settled wins
 * @property {number} losses - settled losses
 * @property {number} pushes - settled pushes
 * @property {number} sampleSize - wins + losses + pushes
 * @property {number} totalDecided - wins + losses (pushes excluded)
 * @property {number|null} hitRate - wins / totalDecided, or null when totalDecided is 0
 * @property {boolean} insufficientSample - totalDecided < minSample
 */

/**
 * Derive per-signal calibration from the settled ledger.
 *
 * Key format (legacy-compatible):
 *   `${signalTier}:${movementGrade}:${league}:${market}`
 * Feature values are read from the bet's immutable `featureSnapshot` first,
 * then from top-level bet fields (legacy records without snapshots), with
 * the legacy defaults ('TIER 4', 'unknown', '?', '?') when nothing was
 * recorded. No probability is derived anywhere in this path.
 *
 * Per-key stats:
 *   wins / losses / pushes          raw settled counts (won/lost aliases
 *                                   normalized before counting)
 *   sampleSize                      wins + losses + pushes
 *   totalDecided                    wins + losses — pushes are counted in
 *                                   the sample but EXCLUDED from the hit-rate
 *                                   denominator
 *   hitRate                         wins / totalDecided as a number, or null
 *                                   when totalDecided is 0
 *   insufficientSample              totalDecided < minSample — pushes count
 *                                   toward sampleSize but never satisfy the
 *                                   decided-outcome minimum
 *
 * @param {Object} ledger - v2 ledger
 * @param {Object} [opts]
 * @param {number} [opts.minSample=30] - positive integer; the decided-outcome
 *   floor below which a key is marked insufficientSample
 * @returns {Object<string, CalibrationBucket>}
 * @throws {TypeError} when minSample is not a positive integer
 */
function deriveCalibration(ledger, opts = {}) {
  const minSample = resolveMinSample(opts);
  /** @type {Map<string, CalibrationBucket>} */
  const buckets = new Map();
  for (const row of joinSettledBets(ledger)) {
    const { signalTier, movementGrade, league, market } = calibrationComponents(row);
    const key = `${signalTier}:${movementGrade}:${league}:${market}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        wins: 0,
        losses: 0,
        pushes: 0,
        sampleSize: 0,
        totalDecided: 0,
        hitRate: null,
        insufficientSample: false
      });
    }
    const bucket = buckets.get(key);
    if (row.outcome === 'win') bucket.wins += 1;
    else if (row.outcome === 'loss') bucket.losses += 1;
    else bucket.pushes += 1;
    bucket.sampleSize += 1;
    if (row.outcome !== 'push') bucket.totalDecided += 1;
  }
  /** @type {Record<string, CalibrationBucket>} */
  const calibration = {};
  for (const [key, bucket] of buckets) {
    bucket.hitRate = bucket.totalDecided > 0 ? bucket.wins / bucket.totalDecided : null;
    bucket.insufficientSample = bucket.totalDecided < minSample;
    calibration[key] = bucket;
  }
  return calibration;
}

/**
 * Flat evaluation projection: one row per settled bet, decision-time values
 * only. Every field is copied from a recorded value (featureSnapshot first,
 * top-level legacy fields second) or null when unavailable — nothing is
 * derived. No model-specific fields are inferred or backfilled.
 *
 * Row fields: betId, league, market, selection, odds, stake, outcome,
 * capturedAt, settledAt, signalTier, confidenceTier (alias of signalTier),
 * signalQualityScore, marketFairProbability, modelWinProbability,
 * modelMarketEdgePct.
 *
 * @param {Object} ledger - v2 ledger
 * @returns {Array<Object>} evaluation rows in bet order
 */
function buildEvaluationRows(ledger) {
  const rows = [];
  for (const row of joinSettledBets(ledger)) {
    const snapshot = snapshotOf(row);
    const settlement = row.settlement;
    const components = calibrationComponents(row);
    rows.push({
      betId: row.id != null ? row.id : row.betId != null ? row.betId : settlement.betId,
      league: pick(snapshot, row, 'league') ?? row.league ?? settlement.league ?? null,
      market: pick(snapshot, row, 'market') ?? row.market ?? settlement.market ?? null,
      selection: row.selection ?? settlement.selection ?? null,
      odds:
        row.oddsAtDecision != null
          ? row.oddsAtDecision
          : row.odds != null
            ? row.odds
            : settlement.odds != null
              ? settlement.odds
              : null,
      stake: row.stake != null ? row.stake : settlement.stake != null ? settlement.stake : null,
      outcome: row.outcome,
      capturedAt:
        pick(snapshot, row, 'capturedAt') ??
        (row.candidateSnapshot && typeof row.candidateSnapshot === 'object'
          ? row.candidateSnapshot.capturedAt
          : null) ??
        null,
      settledAt: settlement.settledAt != null ? settlement.settledAt : null,
      signalTier: components.signalTier,
      confidenceTier: components.signalTier,
      signalQualityScore: pick(snapshot, row, 'signalQualityScore') ?? null,
      marketFairProbability: pick(snapshot, row, 'marketFairProbability') ?? null,
      modelWinProbability: pick(snapshot, row, 'modelWinProbability') ?? null,
      modelMarketEdgePct: pick(snapshot, row, 'modelMarketEdgePct') ?? null
    });
  }
  return rows;
}

module.exports = {
  SETTLED_STATUSES,
  DEFAULT_MIN_SAMPLE,
  joinSettledBets,
  deriveCalibration,
  buildEvaluationRows
};
