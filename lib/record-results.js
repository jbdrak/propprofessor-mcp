'use strict';

/**
 * Validate the local result-file contract before a settlement run loads or
 * writes the ledger. Event normalization remains in record-settlement.js.
 */
function validateResultPayload(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      errors: ['results must be an object with non-empty top-level provider and sourceUrl']
    };
  }
  if (typeof value.provider !== 'string' || value.provider.trim() === '') errors.push('provider is required');
  if (typeof value.sourceUrl !== 'string' || value.sourceUrl.trim() === '') errors.push('sourceUrl is required');
  if (!Array.isArray(value.events)) errors.push('events must be an array');
  else {
    value.events.forEach((event, index) => {
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        errors.push(`events[${index}] must be an object`);
      }
    });
  }
  return {
    ok: errors.length === 0,
    errors,
    provider: typeof value.provider === 'string' ? value.provider.trim() : null,
    sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl.trim() : null
  };
}

module.exports = { validateResultPayload };
