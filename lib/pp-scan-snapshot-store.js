'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PREVIOUS_SNAPSHOT_TTL_MS = 12 * 60 * 60 * 1000;

function getSnapshotPath() {
  return process.env.PP_SCAN_SNAPSHOT_FILE || path.join(os.homedir(), '.propprofessor', 'scan-price-snapshot.json');
}

function getSnapshotTtlMs() {
  const raw = Number(process.env.PP_SCAN_SNAPSHOT_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PREVIOUS_SNAPSHOT_TTL_MS;
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function loadSnapshot() {
  const filePath = getSnapshotPath();
  const data = safeReadJson(filePath);
  return data.entries && typeof data.entries === 'object' ? data.entries : {};
}

function saveSnapshot(entries) {
  const filePath = getSnapshotPath();
  ensureParentDir(filePath);
  const payload = {
    updatedAt: new Date().toISOString(),
    entries
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function mergeSnapshotEntries(existingEntries, nextEntries) {
  return {
    ...(existingEntries && typeof existingEntries === 'object' ? existingEntries : {}),
    ...(nextEntries && typeof nextEntries === 'object' ? nextEntries : {})
  };
}

function buildSnapshotKey(play = {}, leagueFallback = null, marketFallback = null) {
  const league = String(play.league || leagueFallback || '').trim();
  const market = String(play.market || marketFallback || '').trim();
  const gameId = String(play.gameId || play.game || play.matchup || '').trim();
  const selection = String(play.selection || play.participant || play.pick || '').trim();
  const book = String(play.book || play.sportsbook || play.targetBook || '').trim();
  if (!league || !market || !gameId || !selection || !book) return null;
  return [league, market, gameId, selection, book].join('|');
}

function isFreshSnapshot(previousSeenAt, nowMs = Date.now(), ttlMs = getSnapshotTtlMs()) {
  const seenMs = Date.parse(previousSeenAt || '');
  if (!Number.isFinite(seenMs)) return false;
  return nowMs - seenMs <= ttlMs;
}

function annotateResultsWithPreviousSnapshot(results, entries, options = {}) {
  if (!Array.isArray(results) || !entries || typeof entries !== 'object') return results;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : getSnapshotTtlMs();
  for (const group of results) {
    const plays = Array.isArray(group?.plays) ? group.plays : [];
    for (const play of plays) {
      const key = buildSnapshotKey(play, group.league, group.market);
      if (!key) continue;
      const previous = entries[key];
      if (!previous || !Number.isFinite(Number(previous.odds))) continue;
      if (!isFreshSnapshot(previous.seenAt, nowMs, ttlMs)) continue;
      play.previousSeenOdds = Number(previous.odds);
      play.previousSeenAt = previous.seenAt || null;
    }
  }
  return results;
}

function buildSnapshotFromResults(results, seenAt = new Date().toISOString()) {
  const entries = {};
  if (!Array.isArray(results)) return entries;
  for (const group of results) {
    const plays = Array.isArray(group?.plays) ? group.plays : [];
    for (const play of plays) {
      const key = buildSnapshotKey(play, group.league, group.market);
      const odds = Number(play.odds);
      if (!key || !Number.isFinite(odds)) continue;
      entries[key] = {
        odds,
        seenAt
      };
    }
  }
  return entries;
}

module.exports = {
  DEFAULT_PREVIOUS_SNAPSHOT_TTL_MS,
  getSnapshotPath,
  getSnapshotTtlMs,
  loadSnapshot,
  saveSnapshot,
  mergeSnapshotEntries,
  buildSnapshotKey,
  isFreshSnapshot,
  annotateResultsWithPreviousSnapshot,
  buildSnapshotFromResults
};
