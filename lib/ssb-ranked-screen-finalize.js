'use strict';

/**
 * Apply ranked-screen top-level filtering and compact result-row cleanup.
 *
 * @param {object} baseResponse - Unfiltered ranked-screen response
 * @param {string[]|null} includeList - Optional top-level allowlist
 * @param {(row: object) => object} stripEmptyFields - Result-row cleanup function
 * @returns {object} Final response envelope
 */
function finalizeRankedScreenResponse(baseResponse, includeList, stripEmptyFields) {
  if (includeList) {
    const allowed = new Set(['ok', 'result', ...includeList]);
    const filtered = {};
    for (const key of Object.keys(baseResponse)) {
      if (allowed.has(key)) filtered[key] = baseResponse[key];
    }
    filtered.result = Array.isArray(filtered.result) ? filtered.result.map(stripEmptyFields) : filtered.result;
    return filtered;
  }

  baseResponse.result = Array.isArray(baseResponse.result)
    ? baseResponse.result.map(stripEmptyFields)
    : baseResponse.result;
  return baseResponse;
}

module.exports = { finalizeRankedScreenResponse };
