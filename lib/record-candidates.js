'use strict';

const crypto = require('node:crypto');

/**
 * Normalize scan output into recordable candidate records.
 *
 * Input shapes accepted (Task 2 core):
 *   - top-level array of { league, market, plays: [...] } blocks (the common
 *     scan shape, incl. the injected tennis fallback bucket whose market is
 *     'All Markets' and whose rows carry raw `verdict` instead of
 *     `finalVerdict`/`kaiCall`)
 *   - a wrapped response object: { data: { results }, ... } or { results, ... }
 *
 * Rules:
 *   - Flattens every block; rows missing league/market inherit the block's.
 *   - Market names are preserved exactly (no aliasing — 'Set Handicap' stays
 *     'Set Handicap').
 *   - Raw PP verdicts (BET/CONSIDER/...) remain data fields only; this module
 *     never derives an "official bet" flag or any recommendation decision.
 *   - Missing fields normalize to null; no values are invented.
 *   - Stable candidateId = sha256(scanId|gameId|market|selection|odds),
 *     sliced to 16 hex chars, following the repo's daily-snapshot convention.
 *
 * @param {Array|Object} input - scan results array or wrapped response object
 * @param {Object} [opts] - { scanId } stable id of the scan that produced rows
 * @returns {Array<Object>} flattened, normalized candidate records
 */
function normalizeScanCandidates(input, { scanId } = {}) {
  const blocks = Array.isArray(input)
    ? input
    : Array.isArray(input && input.results)
      ? input.results
      : Array.isArray(input && input.data && input.data.results)
        ? input.data.results
        : [];

  const out = [];
  for (const block of blocks) {
    if (!block || !Array.isArray(block.plays) || block.plays.length === 0) continue;
    for (const play of block.plays) {
      if (!play || typeof play !== 'object') continue;
      out.push(normalizeRow(play, block, scanId));
    }
  }
  return out;
}

function normalizeRow(play, block, scanId) {
  const league = play.league ?? block.league ?? null;
  const market = play.market ?? block.market ?? null;
  const gameId = play.gameId ?? null;
  const selection = play.selection ?? play.participant ?? play.pick ?? null;
  const odds = play.odds ?? play.currentOdds ?? null;
  const books = play.books ?? play.consensusBookCount ?? null;

  return {
    candidateId: buildCandidateId({ scanId, gameId, market, selection, odds }),
    gameId,
    game: play.game ?? null,
    league,
    market,
    selection,
    odds,
    tier: play.tier ?? play.confidenceTier ?? null,
    verdict: play.verdict ?? play.finalVerdict ?? play.kaiCall ?? null,
    movement: play.movement ?? null,
    movementDisposition: play.movementDisposition ?? null,
    edge: play.edge ?? play.consensusEdge ?? null,
    clvProxyPct: play.clvProxyPct ?? play.clv ?? null,
    books,
    consensusBookCount: play.consensusBookCount ?? play.books ?? null,
    start: play.start ?? null,
    startCST: play.startCST ?? null,
    startDisplay: play.startDisplay ?? null,
    startSource: play.startSource ?? null,
    startConfidence: play.startConfidence ?? null
  };
}

/**
 * Stable candidate identity: sha256 of scanId + gameId + market + selection +
 * captured price context (odds), each trimmed, sliced to 16 hex chars. Follows
 * the repo convention in scripts/daily-snapshot.js (buildPlayId).
 * Missing/undefined inputs normalize to '' so identity is stable across
 * null/undefined differences.
 *
 * @param {Object} ctx - { scanId, gameId, market, selection, odds }
 * @returns {string} 16-char hex id
 */
function buildCandidateId({ scanId, gameId, market, selection, odds } = {}) {
  const raw = [scanId, gameId, market, selection, odds].map((v) => String(v == null ? '' : v).trim()).join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function buildScanFingerprint(input) {
  const candidates = normalizeScanCandidates(input, { scanId: null });
  const identities = candidates
    .map((candidate) =>
      [candidate.gameId, candidate.market, candidate.selection, candidate.odds].map((value) =>
        String(value == null ? '' : value).trim()
      )
    )
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return crypto.createHash('sha256').update(JSON.stringify(identities)).digest('hex').slice(0, 16);
}

module.exports = { normalizeScanCandidates, buildCandidateId, buildScanFingerprint };
