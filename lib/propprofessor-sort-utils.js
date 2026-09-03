'use strict';

const { parseGameStartMs } = require('./propprofessor-shared-utils');

/**
 * Sort ranked-row arrays by a single field.
 *
 * Fields supported: start, edge, tier, consensusBookCount, riskScore.
 * Each field has a sensible default direction (start asc, edge desc, etc.)
 * but callers can override with sortDir='asc'|'desc'.
 *
 * The sort is STABLE (Array.prototype.sort is stable in V8/Node 18+).
 *
 * Missing-field rows ALWAYS go to the end, regardless of sortDir. Rationale:
 * when an agent asks "what's coming up next?" or "biggest edge?", a row with
 * no start time or no edge is useless — it should be the LAST thing the
 * agent sees, not stuck at position 1 of a desc list.
 *
 * To achieve this we wrap the accessor to return a sentinel for missing
 * values, then sort the result so missing rows land at the tail.
 */

// Sentinel: any number larger than any real field value.
const MISSING_NUM = Number.MAX_SAFE_INTEGER;

const SORT_ACCESSORS = {
  start: (r) => {
    const ms = parseGameStartMs(r.start ?? r.startTimestamp);
    return Number.isFinite(ms) ? ms : MISSING_NUM;
  },
  edge: (r) => toNumberOrEpoch(r.edge ?? r.consensusEdge, MISSING_NUM),
  tier: (r) => tierWeight(r.confidenceTier ?? r.tier),
  consensusBookCount: (r) => toNumberOrEpoch(r.consensusBookCount, MISSING_NUM),
  riskScore: (r) => toNumberOrEpoch(r.riskScore, MISSING_NUM)
};

// The direction the user wants.
const DEFAULT_DIR = Object.freeze({
  start: 'asc',
  edge: 'desc',
  tier: 'asc',
  consensusBookCount: 'desc',
  riskScore: 'asc'
});

const VALID_SORT_KEYS = new Set(Object.keys(SORT_ACCESSORS));
const VALID_SORT_DIRS = new Set(['asc', 'desc']);

// Same-tier/movement near-even-moneyline preference: when two candidates are
// effectively equal by the requested sort, prefer the one whose absolute
// odds are closer to even money (100). This surfaces -150/+130 before
// -300/+250 without changing the primary sort semantics.
function nearEvenOddsBonus(row) {
  const raw = row.odds ?? row.targetBookOdds ?? row.currentOdds ?? row.bestAvailableOdds;
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return Number.MAX_SAFE_INTEGER;
  return Math.abs(Math.abs(n) - 100);
}

/**
 * Sort rows by a single field. Returns the input unchanged (same order) when sortBy is missing/invalid or rows is not an array.
 * @param {Object[]} rows
 * @param {Object} [options]
 * @param {string} [options.sortBy] - One of: start, edge, tier, consensusBookCount, riskScore
 * @param {string} [options.sortDir] - 'asc' | 'desc'. Defaults per-field.
 * @returns {Object[]} New sorted array, or the input if no sort applied.
 */
function sortRows(rows, { sortBy, sortDir } = {}) {
  if (!Array.isArray(rows)) return rows;
  if (!sortBy || !VALID_SORT_KEYS.has(sortBy)) return rows;
  const accessor = SORT_ACCESSORS[sortBy];
  const dir = VALID_SORT_DIRS.has(sortDir) ? sortDir : DEFAULT_DIR[sortBy];
  const factor = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    const aMissing = av === MISSING_NUM;
    const bMissing = bv === MISSING_NUM;
    // Always push missing-field rows to the end, regardless of sortDir.
    if (aMissing && !bMissing) return 1;
    if (!aMissing && bMissing) return -1;
    if (aMissing && bMissing) return 0;
    if (av < bv) return -1 * factor;
    if (av > bv) return 1 * factor;
    const aEven = nearEvenOddsBonus(a);
    const bEven = nearEvenOddsBonus(b);
    if (aEven < bEven) return -1;
    if (aEven > bEven) return 1;
    return 0;
  });
}

/**
 * Coerce a value to a finite number. Accepts:
 *  - Finite numbers (returned as-is)
 *  - Numeric strings (parsed via Number())
 *  - ISO date strings (parsed via Date().getTime())
 *  - Anything else → fallback
 */
function toNumberOrEpoch(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    // Try plain number first (fastest path)
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    // Try date parse
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return fallback;
}

function tierWeight(tier) {
  if (!tier) return MISSING_NUM;
  const upper = String(tier).trim().toUpperCase();
  const map = { 'TIER 1': 1, 'TIER 2': 2, 'TIER 3': 3, 'TIER 4': 4 };
  return map[upper] ?? MISSING_NUM;
}

module.exports = {
  sortRows,
  SORT_ACCESSORS,
  DEFAULT_DIR,
  VALID_SORT_KEYS,
  VALID_SORT_DIRS,
  toNumberOrEpoch
};
