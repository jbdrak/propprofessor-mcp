'use strict';

const fs = require('fs');
const path = require('path');

function defaultPath() {
  const dir = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.ssb-for-agents');
  return path.join(dir, 'sharp-alerts-store.json');
}

function loadStore(storePath) {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveStore(storePath, arr) {
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(arr, null, 2), 'utf8');
  } catch {
    /* non-fatal: alerting still works without persistence */
  }
}

/**
 * Upsert by key=gameId:selection:market.
 * @returns {{ entry:object, isNew:boolean }}
 *   isNew=false when the same key was seen within dedupWindowMs (repeat alert).
 */
function upsert(store, key, now, dedupWindowMs) {
  const existing = store.find((e) => e.key === key);
  if (existing && now - new Date(existing.lastSeen).getTime() < dedupWindowMs) {
    existing.lastSeen = new Date(now).toISOString();
    return { entry: existing, isNew: false };
  }
  const entry = {
    key,
    firstSeen: existing ? existing.firstSeen : new Date(now).toISOString(),
    lastSeen: new Date(now).toISOString()
  };
  if (!existing) store.push(entry);
  else Object.assign(existing, entry);
  return { entry, isNew: !existing };
}

module.exports = { defaultPath, loadStore, saveStore, upsert };
