'use strict';

/**
 * Build a de-duplicated research batch from the FINAL quick_screen candidate
 * set (post targetTiers / kaiCall / card-window filtering).
 *
 * De-dupes by `${gameId}:${player}` so totals variants (O175.5, O174.5, ...)
 * for the same game don't each spawn a separate player_context call.
 *
 * @param {Array<{league:string,market:string,candidates:Array}>} allCandidates
 * @param {number} [limit=50] - max rows to keep (top N by screenScore)
 * @returns {Array<{player:string,league:string,game:string,start:string|null,market:string,row:object}>}
 */
function buildFinalResearchBatch(allCandidates, limit = 50) {
  const seen = new Set();
  const batch = [];
  const flat = [];
  for (const entry of allCandidates || []) {
    if (!entry.candidates || !entry.candidates.length) continue;
    for (const row of entry.candidates) {
      flat.push({ entry, row });
    }
  }
  flat.sort((a, b) => Number(b.row.screenScore || 0) - Number(a.row.screenScore || 0));
  for (const { entry, row } of flat.slice(0, Math.max(0, limit))) {
    const player = row.selection || row.participant || row.pick;
    if (!player) continue;
    const gameId = row.gameId || '';
    const key = `${gameId}:${String(player).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    batch.push({
      player: String(player).trim(),
      league: String(row.league || entry.league || '').trim(),
      game: row.game || `${row.awayTeam || '?'} @ ${row.homeTeam || '?'}`,
      start: row.start || row.eventStart || null,
      market: String(row.market || entry.market || '').trim(),
      row
    });
  }
  return batch;
}

module.exports = { buildFinalResearchBatch };
