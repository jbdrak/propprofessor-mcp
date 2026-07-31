'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function getSnapshotPath() {
  return process.env.PP_SCAN_SNAPSHOT_FILE || path.join(os.homedir(), '.propprofessor', 'scan-price-snapshot.json');
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

function buildSnapshotKey(play = {}, leagueFallback = null, marketFallback = null) {
  const league = String(play.league || leagueFallback || '').trim();
  const market = String(play.market || marketFallback || '').trim();
  const gameId = String(play.gameId || play.game || play.matchup || '').trim();
  const selection = String(play.selection || play.participant || play.pick || '').trim();
  if (!league || !market || !gameId || !selection) return null;
  return [league, market, gameId, selection].join('|');
}

function annotateResultsWithPreviousSnapshot(results, entries) {
  if (!Array.isArray(results) || !entries || typeof entries !== 'object') return results;
  for (const group of results) {
    const plays = Array.isArray(group?.plays) ? group.plays : [];
    for (const play of plays) {
      const key = buildSnapshotKey(play, group.league, group.market);
      if (!key) continue;
      const previous = entries[key];
      if (!previous || !Number.isFinite(Number(previous.odds))) continue;
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
  getSnapshotPath,
  loadSnapshot,
  saveSnapshot,
  buildSnapshotKey,
  annotateResultsWithPreviousSnapshot,
  buildSnapshotFromResults
};
