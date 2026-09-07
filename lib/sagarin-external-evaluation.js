'use strict';

const { scoreEvaluationRows } = require('./propprofessor-backtest-metrics');
const { segmentEvaluationRows } = require('./record-evaluation');

const WIN = new Set(['win', 'won']);
const LOSS = new Set(['loss', 'lost']);

function outcomeOf(value) {
  if (typeof value !== 'string') return null;
  const valueLower = value.toLowerCase();
  if (WIN.has(valueLower)) return 'win';
  if (LOSS.has(valueLower)) return 'loss';
  return valueLower === 'push' ? 'push' : null;
}

function timestampMs(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function segmentOf(value) {
  const segment = typeof value === 'string' ? value.toUpperCase() : '';
  return segment === 'FBS' || segment === 'FCS' ? segment : 'other';
}

function normalizeRow(raw, index) {
  if (!raw || typeof raw !== 'object') {
    return { index, outcome: null, segment: 'other', status: 'unresolved', unresolvedReason: 'not-an-object' };
  }

  const outcome = outcomeOf(raw.outcome);
  const predictionTimestamp = raw.predictionTimestamp ?? raw.sourceTimestamp;
  const sourceTimestamp = raw.sourceTimestamp;
  const predictionMs = timestampMs(predictionTimestamp);
  const referenceMs = timestampMs(raw.gameTimestamp ?? raw.settledAt);
  let unresolvedReason = null;

  if (outcome === null) unresolvedReason = 'unknown-outcome';
  else if (predictionMs === null) {
    unresolvedReason = predictionTimestamp == null ? 'missing-provenance' : 'invalid-provenance';
  } else if (referenceMs !== null && predictionMs > referenceMs) {
    unresolvedReason = 'stale-post-decision-prediction';
  }

  const row = {
    index,
    outcome,
    segment: segmentOf(raw.segment),
    predictionTimestamp,
    sourceTimestamp
  };
  if (typeof raw.modelWinProbability === 'number' && raw.modelWinProbability >= 0 && raw.modelWinProbability <= 1) {
    row.modelWinProbability = raw.modelWinProbability;
  }

  if (unresolvedReason) {
    row.status = 'unresolved';
    row.unresolvedReason = unresolvedReason;
  } else if (raw.matched === false || raw.status === 'unmatched') {
    row.status = 'unmatched';
  } else {
    row.status = 'matched';
  }
  return row;
}

function normalizeSagarinRows(rows) {
  const normalized = (Array.isArray(rows) ? rows : []).map(normalizeRow);
  normalized.sort((a, b) => {
    const aMs = timestampMs(a.predictionTimestamp);
    const bMs = timestampMs(b.predictionTimestamp);
    if (aMs === null && bMs === null) return a.index - b.index;
    if (aMs === null) return 1;
    if (bMs === null) return -1;
    return aMs - bMs;
  });
  return { rows: normalized, unresolved: normalized.filter((row) => row.status === 'unresolved') };
}

function eligibleRows(rows) {
  return rows.filter((row) => row.status === 'matched' && (row.outcome === 'win' || row.outcome === 'loss'));
}

function counts(rows) {
  return {
    total: rows.length,
    resolved: rows.filter((row) => row.status === 'matched' && (row.outcome === 'win' || row.outcome === 'loss'))
      .length,
    unresolved: rows.filter((row) => row.status === 'unresolved').length,
    unmatched: rows.filter((row) => row.status === 'unmatched').length,
    pushed: rows.filter((row) => row.status === 'matched' && row.outcome === 'push').length
  };
}

function scoreSagarinRows(rows) {
  const normalized = normalizeSagarinRows(rows).rows;
  return {
    scores: scoreEvaluationRows(eligibleRows(normalized), ['modelWinProbability']),
    counts: counts(normalized)
  };
}

function segmentSagarinRows(rows, opts = {}) {
  const normalized = normalizeSagarinRows(rows).rows;
  const segmented = segmentEvaluationRows(eligibleRows(normalized), {
    dimensions: ['segment'],
    ...(Number.isInteger(opts.minSample) ? { minSample: opts.minSample } : {})
  });
  return { ...segmented, counts: counts(normalized) };
}

module.exports = { normalizeSagarinRows, scoreSagarinRows, segmentSagarinRows };
