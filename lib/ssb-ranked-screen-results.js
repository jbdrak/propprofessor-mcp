'use strict';

/**
 * Build ranked-screen result rows according to fields/compact/full mode.
 *
 * @param {object} options - Result shaping dependencies and inputs
 * @returns {object[]} Result rows
 */
function buildRankedResultRows({ ranked, fields, compact, filterRowFields, compactResult }) {
  let resultRows;
  if (fields) {
    resultRows = ranked.map((row) => filterRowFields(row, fields));
  } else if (compact) {
    resultRows = compactResult(ranked);
  } else {
    resultRows = ranked;
  }

  if (ranked.focusBookMissingRows) {
    Object.defineProperty(resultRows, 'focusBookMissingRows', {
      value: ranked.focusBookMissingRows,
      enumerable: false,
      writable: false,
      configurable: false
    });
  }
  return resultRows;
}

module.exports = { buildRankedResultRows };
