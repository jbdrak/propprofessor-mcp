'use strict';

function eventKey(row) {
  const matchup = String(row?.game || row?.matchup || '').trim().toLowerCase();
  if (matchup) return matchup.replace(/\s+/g, ' ');
  return String(row?.gameId || '').trim();
}

/**
 * Filter out alternate lines — per game, per market type, keep only the
 * main line (the one with the most consensus books). Alternate spreads
 * (-12.5, -18.5, +3.5 run lines) and alternate totals (line numbers away
 * from the consensus) have lower book counts and get downgraded to TIER 4
 * so they never surface as recommended picks.
 *
 * "Main lines are the ones being traded, not offered."
 */
function resolveAlternateLines(ranked, { debug = false } = {}) {
  if (!Array.isArray(ranked)) return ranked;

  // Per game, per market, find the "main" line number.
  // For spreads: the line number with the most books in either direction.
  // For totals: the line number with the most books (regardless of O/U).
  const mainLines = new Map(); // key: gameId|market → { lineNumber, books }

  for (const row of ranked) {
    const market = String(row.market || row.screenMarket || '').toLowerCase();
    // Only process spread and total markets
    const isSpread =
      market === 'point spread' || market === 'run line' || market === 'game handicap' || market === 'spread';
    const isTotal = market === 'total runs' || market === 'total points' || market === 'total games';
    if (!isSpread && !isTotal) continue;

    const gameId = eventKey(row);
    if (!gameId) continue;

    // Extract the line number (e.g. "Fever -9.5" → 9.5, "Under 7.5" → 7.5)
    const match = (row.selection || row.participant || '').match(/(\d+\.?\d*)/);
    const lineNumber = match ? parseFloat(match[1]) : null;
    if (lineNumber === null || isNaN(lineNumber)) continue;

    const key = `${gameId}|${market}`;
    const current = mainLines.get(key);

    const bookCount = row.consensusBookCount || Object.keys(row.allBookOdds || {}).length || 0;
    if (!current || bookCount > current.books) {
      mainLines.set(key, {
        lineNumber,
        books: bookCount,
        selection: row.selection
      });
    }
  }

  // Now downgrade any line that doesn't match the main line number
  for (const row of ranked) {
    const market = String(row.market || row.screenMarket || '').toLowerCase();
    const isSpread =
      market === 'point spread' || market === 'run line' || market === 'game handicap' || market === 'spread';
    const isTotal = market === 'total runs' || market === 'total points' || market === 'total games';
    if (!isSpread && !isTotal) continue;

    const gameId = eventKey(row);
    const match = (row.selection || row.participant || '').match(/(\d+\.?\d*)/);
    const lineNumber = match ? parseFloat(match[1]) : null;

    const key = `${gameId}|${market}`;
    const main = mainLines.get(key);
    if (!main) continue;

    // If this row's line number doesn't match the main line, downgrade
    if (lineNumber !== main.lineNumber) {
      row.confidenceTier = 'TIER 4';
      row.kaiCall = 'PASS';
      if (row.displayTier) row.displayTier = 'PASS';
      row.altLineFiltered = true;
      row.altLineReason = `Alternate ${market} (${lineNumber}), main is ${main.selection} (${main.books} books)`;
      if (debug) {
        process.stderr.write(
          `[screen-ranker] altLineFilter: downgraded "${row.selection}" → TIER 4, ` +
            `main="${main.selection}" (${main.books} books) gameId=${gameId}\n`
        );
      }
    }
    // Standalone expanded Game Handicap lines (tennis) that are the only
    // line offered — even as the "main" line, ±3.5/±4.5/±6.5 are alternates.
    // Standard tennis GH is ±1.5 (sometimes ±2.5). Anything beyond is expanded.
    else if (market === 'game handicap' && lineNumber > 2.5) {
      row.confidenceTier = 'TIER 4';
      row.kaiCall = 'PASS';
      if (row.displayTier) row.displayTier = 'PASS';
      row.altLineFiltered = true;
      row.altLineReason = `Standalone expanded Game Handicap (${lineNumber}), exceeds ±2.5 range`;
      if (debug) {
        process.stderr.write(
          `[screen-ranker] altLineFilter: standalone expanded GH "${row.selection}" (${lineNumber}) → TIER 4\n`
        );
      }
    }
  }
  return ranked;
}

module.exports = { resolveAlternateLines };
