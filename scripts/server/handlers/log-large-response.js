'use strict';

const DEFAULT_LARGE_RESPONSE_THRESHOLD_BYTES = 500_000;

/**
 * Log a warning when a quick_screen response exceeds the monitoring threshold.
 *
 * @param {object} response - Response to measure
 * @param {object} [options] - Testable logging options
 * @param {Function} [options.warn=console.warn] - Warning function
 * @param {number} [options.thresholdBytes=500000] - Serialized-size threshold
 * @returns {void}
 */
function logLargeQuickScreenResponse(
  response,
  { warn = console.warn, thresholdBytes = DEFAULT_LARGE_RESPONSE_THRESHOLD_BYTES } = {}
) {
  try {
    const responseSize = JSON.stringify(response).length;
    if (responseSize > thresholdBytes) {
      warn(`[PropProfessor MCP] Large quick_screen response: ${(responseSize / 1024).toFixed(1)}KB`);
    }
  } catch {
    /* ignore */
  }
}

module.exports = { logLargeQuickScreenResponse };
