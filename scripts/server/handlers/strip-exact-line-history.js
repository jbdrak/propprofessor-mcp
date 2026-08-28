'use strict';

const EXACT_LINE_HISTORY_FIELDS = [
  'lineHistory',
  'lineHistoryAvailable',
  'lineHistorySource',
  'movementSourceBook',
  'movementMode',
  'movementLabel',
  'movementDisposition',
  'openingOdds',
  'currentOdds',
  'clvProxyPct',
  'movementSummary',
  'normalizedSelectionId',
  'historyMatchKey',
  'historyGameId',
  'lineVariantUsed',
  'exactLineHistorySuppressed'
];

/**
 * Remove misleading broad-history fields from rows that used exact nested lines.
 *
 * @param {object[]} rows - Ranked play-detail rows
 * @returns {object[]} The same rows array after in-place pruning
 */
function stripExactLineHistoryFields(rows) {
  for (const row of rows || []) {
    if (row?.lineVariantUsed !== 'exact_nested' && !row?.exactLineHistorySuppressed) continue;
    for (const field of EXACT_LINE_HISTORY_FIELDS) delete row[field];
  }
  return rows;
}

module.exports = { stripExactLineHistoryFields };
