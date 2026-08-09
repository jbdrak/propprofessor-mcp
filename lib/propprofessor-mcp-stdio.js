'use strict';

/**
 * Create a structured error with code, category, status, cause, and recovery hint.
 * All properties beyond `message` are attached on the Error instance for downstream
 * classification and user-facing recovery guidance.
 *
 * @param {Object} [options] - Error descriptor.
 * @param {string} [options.message] - Human-readable error description. Falls back to
 *   'Unexpected PropProfessor MCP error' when omitted.
 * @param {string} [options.code='INTERNAL_ERROR'] - Machine-readable error code
 *   (e.g. 'AUTH_EXPIRED', 'RATE_LIMITED', 'BACKEND_DOWN').
 * @param {string} [options.category='internal'] - Logical category for grouping:
 *   'auth', 'transport', 'backend', 'validation', or 'internal'.
 * @param {number} [options.status] - Optional HTTP-like status code.
 * @param {Error} [options.cause] - The original error that triggered this one.
 * @param {string} [options.recovery] - User-facing recovery instruction.
 * @returns {Error} A classified Error instance with `.code`, `.category`,
 *   `.status`, `.cause`, and `.recovery` properties.
 */
function createCategorizedError({
  message,
  code = 'INTERNAL_ERROR',
  category = 'internal',
  status,
  cause,
  recovery
} = {}) {
  const error =
    /** @type {Error & { code?: string, category?: string, status?: number, cause?: unknown, recovery?: string }} */ (
      new Error(message || 'Unexpected PropProfessor MCP error')
    );
  error.code = code;
  error.category = category;
  if (status !== undefined) error.status = status;
  if (cause !== undefined) error.cause = cause;
  if (recovery !== undefined) error.recovery = recovery;
  return error;
}

function recoveryForCode(code, _category) {
  switch (code) {
    case 'AUTH_EXPIRED':
      return 'Auth session expired. Recovery: PP_LOGIN_HEADLESS=false node /Users/jamesdrake/Documents/workspace/propprofessor-mcp/scripts/pp-login.js (opens interactive Chromium — user must complete Google OAuth on app.propprofessor.com). Fallback: extract cookies from Chrome CDP and write to ~/.propprofessor/auth.json. After either path: rm ~/.propprofessor/token-cache.json to force fresh token fetch.';
    case 'AUTH_REQUIRED':
      return 'No auth file found. First-time setup: PP_LOGIN_HEADLESS=false node /Users/jamesdrake/Documents/workspace/propprofessor-mcp/scripts/pp-login.js (opens interactive Chromium — user completes Google OAuth on app.propprofessor.com). Cookies saved to ~/.propprofessor/auth.json.';
    case 'RATE_LIMITED':
      return 'Wait 60 seconds and retry';
    case 'TOKEN_REFRESH_FAILED_BOTH_PATHS':
      return 'Auth token expired. Run: python3 ~/.hermes/scripts/pp-fresh-auth.py';
    case 'BACKEND_DOWN':
      return 'Try again in a few minutes';
    case 'BACKEND_ERROR':
      return 'Check PropProfessor status or try again later';
    case 'TRANSPORT_ERROR':
      return 'Check MCP transport configuration';
    case 'VALIDATION_ERROR':
      return 'Check the tool arguments and try again';
    case 'VALIDATION_INCOMPLETE':
      return 'Some candidates failed validation; retry with fewer or different leagues';
    case 'MISSING_LEAGUES':
      return 'Pass one or more league names (e.g. leagues: ["NBA", "MLB"])';
    case 'MISSING_PARAMS':
      return 'Check the required parameters for this tool and try again';
    case 'MISSING_BET':
      return 'Pass a bet object with betId, matchId, market, and selection';
    case 'MISSING_ID':
      return 'Pass an id parameter to identify the bet';
    case 'PLAYER_CONTEXT_ERROR':
      return 'Check the player name and sport, then retry';
    case 'LEAGUE_REQUIRED':
      return 'Pass a league parameter (e.g. league: "NBA")';
    case 'BACKEND_TIMEOUT':
      return 'The backend took too long; try reducing lookbackHours or use skipHistory=true';
    case 'NO_DATA':
      return 'No data available for the given criteria; try a different league, market, or time window';
    case 'INTERNAL_ERROR':
    default:
      return 'Check logs or file an issue at github.com/j17drake/propprofessor-mcp';
  }
}

/**
 * Classify a raw error into a structured PropProfessor error with code, category,
 * and recovery guidance. Inspects the error's status code, message text, and any
 * existing `.code` / `.category` properties to decide the best classification.
 *
 * @param {Error|*} error - Any thrown value, Error-like object, or primitive.
 *   Already-categorized errors (with `.category` and `.code`) pass through with
 *   recovery filled in if missing.
 * @returns {Error} An Error instance with `.code`, `.category`, `.status`,
 *   `.cause`, and `.recovery` attached.
 */
function buildSelectionNotFoundError(error, message, lower) {
  if (!lower.includes('no row matched selection')) return null;
  return createCategorizedError({
    message,
    code: 'SELECTION_NOT_FOUND',
    category: 'validation',
    status: error?.status,
    cause: error,
    recovery:
      'The selection was not found in the current snapshot. This is usually a STALE SNAPSHOT — the market moved between the screen call and this validation. Do NOT retry with find_best_price (different matcher — likely also returns no_match). The play has evaporated. If the selection format looks correct (e.g. "Argentina" not "Argentina -1.5"), treat this as "play gone — move on to the next candidate." For context: the screen returns a point-in-time snapshot; by the time you validate, the row may no longer exist.'
  });
}

function buildMarketMismatchError(error, message, lower) {
  const isSoccerMismatch =
    (lower.includes('no candidates') || lower.includes('0 candidates') || lower.includes('empty_payload')) &&
    (lower.includes('soccer') || lower.includes('draw no bet'));
  if (!isSoccerMismatch) return null;
  return createCategorizedError({
    message,
    code: 'MARKET_MISMATCH',
    category: 'validation',
    status: error?.status,
    cause: error,
    recovery:
      'Soccer uses Draw No Bet / Match Handicap / Total Goals — NOT Moneyline / Spread / Total. Call get_market_registry("Soccer") to see available markets.'
  });
}

function categorizeError(error) {
  if (error && error.category && error.code) {
    if (!error.recovery) {
      error.recovery = recoveryForCode(error.code, error.category);
    }
    return error;
  }

  const message = String(error?.message || error || 'Unexpected PropProfessor MCP error');
  const lower = message.toLowerCase();

  // Handle TOKEN_REFRESH_FAILED_BOTH_PATHS — the auth module's combined error
  // when both got-scraping and CDP fallback fail. The message contains the
  // upstream status code (HTTP 401, 429) which we parse to determine the root cause.
  if (error?.code === 'TOKEN_REFRESH_FAILED_BOTH_PATHS' || lower.includes('token refresh failed both paths')) {
    // Check if the root cause is a rate limit (429) vs auth failure (401/other)
    const isRateLimited = lower.includes('http 429') || lower.includes('rate limit');
    return createCategorizedError({
      message,
      code: isRateLimited ? 'RATE_LIMITED' : 'AUTH_EXPIRED',
      category: isRateLimited ? 'transport' : 'auth',
      status: error?.status,
      cause: error,
      recovery:
        error?.recovery ||
        (isRateLimited
          ? 'Wait 60 seconds and retry'
          : 'Auth token expired. Run: python3 ~/.hermes/scripts/pp-fresh-auth.py')
    });
  }

  if (error?.status === 401 || lower.includes('unauthorized')) {
    return createCategorizedError({
      message,
      code: error?.code || 'AUTH_EXPIRED',
      category: 'auth',
      status: error?.status,
      cause: error,
      recovery: error?.recovery || recoveryForCode('AUTH_EXPIRED', 'auth')
    });
  }
  if (lower.includes('auth') || lower.includes('token')) {
    return createCategorizedError({
      message,
      code: error?.code || 'AUTH_REQUIRED',
      category: 'auth',
      status: error?.status,
      cause: error,
      recovery: error?.recovery || recoveryForCode('AUTH_REQUIRED', 'auth')
    });
  }
  if (error?.status === 429 || lower.includes('rate limit')) {
    return createCategorizedError({
      message,
      code: error?.code || 'RATE_LIMITED',
      category: 'transport',
      status: error?.status,
      cause: error,
      recovery: error?.recovery || 'Wait 60 seconds and retry'
    });
  }
  if (
    lower.includes('content-length') ||
    lower.includes('ndjson') ||
    lower.includes('transport') ||
    lower.includes('frame')
  ) {
    return createCategorizedError({
      message,
      code: error?.code || 'TRANSPORT_ERROR',
      category: 'transport',
      status: error?.status,
      cause: error,
      recovery: error?.recovery || 'Check MCP transport configuration'
    });
  }
  if (error?.status === 503 || lower.includes('service unavailable')) {
    return createCategorizedError({
      message,
      code: error?.code || 'BACKEND_DOWN',
      category: 'backend',
      status: error?.status,
      cause: error,
      recovery: error?.recovery || 'Try again in a few minutes'
    });
  }
  if (error?.status >= 500 || lower.includes('backend')) {
    return createCategorizedError({
      message,
      code: error?.code || 'BACKEND_ERROR',
      category: 'backend',
      status: error?.status,
      cause: error,
      recovery: error?.recovery || 'Check PropProfessor status or try again later'
    });
  }
  if (lower.includes('required') || lower.includes('invalid') || lower.includes('unknown tool')) {
    return createCategorizedError({
      message,
      code: error?.code || 'VALIDATION_ERROR',
      category: 'validation',
      status: error?.status,
      cause: error,
      recovery: error?.recovery || 'Check the tool arguments and try again'
    });
  }

  const selectionError = buildSelectionNotFoundError(error, message, lower);
  if (selectionError) return selectionError;

  const marketMismatchError = buildMarketMismatchError(error, message, lower);
  if (marketMismatchError) return marketMismatchError;
  return createCategorizedError({
    message,
    code: error?.code || 'INTERNAL_ERROR',
    category: 'internal',
    status: error?.status,
    cause: error,
    recovery: error?.recovery || 'Check logs or file an issue at github.com/j17drake/propprofessor-mcp'
  });
}

/**
 * Build a JSON-RPC 2.0 success response object.
 *
 * @param {number|string|null} id - Request identifier echoed back to the caller.
 * @param {*} result - The successful response payload.
 * @returns {Object} A JSON-RPC 2.0 success envelope: `{ jsonrpc: '2.0', id, result }`.
 */
function createJsonRpcSuccess(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Build a JSON-RPC 2.0 error response object.
 *
 * @param {number|string|null} id - Request identifier echoed back to the caller.
 * @param {number} code - JSON-RPC error code (e.g. -32601 for MethodNotFound).
 * @param {string} message - Short human-readable error message.
 * @returns {Object} A JSON-RPC 2.0 error envelope:
 *   `{ jsonrpc: '2.0', id, error: { code, message } }`.
 */
function createJsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Encode a JSON payload for STDIO transport. Supports both the standard MCP
 * Content-Length framing and a simpler newline-delimited JSON (NDJSON) mode
 * for debugging (controlled by the `PROPPROFESSOR_MCP_NDJSON` env var).
 *
 * @param {Object} payload - The JSON-serializable object to encode.
 * @param {Object} [options] - Encoding options.
 * @param {boolean} [options.newlineJson] - When `true`, output NDJSON (one
 *   JSON object per line). Defaults to reading `PROPPROFESSOR_MCP_NDJSON` env var.
 * @returns {string} The encoded message string.
 */
function encodeMessage(payload, { newlineJson = process.env.PROPPROFESSOR_MCP_NDJSON === 'true' } = {}) {
  const body = JSON.stringify(payload);
  if (newlineJson) {
    return `${body}\n`;
  }
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

/**
 * Create a chunk-processing function that parses incoming STDIO data into
 * complete JSON messages (standard MCP Content-Length framing or NDJSON).
 * Returns a `onData(chunk)` callback suitable for `process.stdin.on('data', …)`.
 *
 * @param {Function} onMessage - Callback invoked for each successfully parsed
 *   JSON message. Receives the parsed object as its only argument.
 * @param {Object} [options] - Reader options.
 * @param {boolean} [options.allowNewlineJson] - When `true`, also accept
 *   newline-delimited JSON (NDJSON) frames alongside Content-Length frames.
 *   Defaults to reading `PROPPROFESSOR_MCP_NDJSON` or
 *   `PROPPROFESSOR_MCP_DEBUG_NDJSON` env vars.
 * @returns {Function} The `onData(chunk)` handler. Accepts a `Buffer` or
 *   string chunk and internally buffers/parses complete messages.
 */
function createStdioMessageReader(
  onMessage,
  {
    allowNewlineJson = process.env.PROPPROFESSOR_MCP_NDJSON === 'true' ||
      process.env.PROPPROFESSOR_MCP_DEBUG_NDJSON === 'true'
  } = {}
) {
  let buffer = '';

  return function onData(chunk) {
    buffer += chunk.toString('utf8');

    while (buffer.length > 0) {
      const separator = '\r\n\r\n';
      const headerEnd = buffer.indexOf(separator);

      if (headerEnd === -1) {
        if (allowNewlineJson) {
          const newlineIdx = buffer.indexOf('\n');
          if (newlineIdx === -1) return;
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line) {
            try {
              onMessage(JSON.parse(line));
            } catch {
              process.stderr.write(`[propprofessor-mcp] Skipping malformed NDJSON line: ${line.slice(0, 200)}\n`);
            }
          }
          continue;
        }
        return;
      }

      const headerText = buffer.slice(0, headerEnd);
      const contentLengthLine = headerText.split('\r\n').find((line) => /^content-length\s*:/i.test(line));
      if (!contentLengthLine) {
        buffer = buffer.slice(headerEnd + separator.length);
        process.stderr.write('[propprofessor-mcp] Skipping frame with missing Content-Length header\n');
        continue;
      }
      const contentLength = Number(contentLengthLine.split(':').slice(1).join(':').trim());
      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        buffer = buffer.slice(headerEnd + separator.length);
        process.stderr.write(
          `[propprofessor-mcp] Skipping frame with invalid Content-Length header: ${contentLengthLine}\n`
        );
        continue;
      }

      const bodyStart = headerEnd + separator.length;
      const bodyEnd = bodyStart + contentLength;
      if (buffer.length < bodyEnd) return;

      const body = buffer.slice(bodyStart, bodyEnd);
      buffer = buffer.slice(bodyEnd);
      try {
        onMessage(JSON.parse(body));
      } catch {
        process.stderr.write(`[propprofessor-mcp] Skipping frame with malformed JSON body: ${body.slice(0, 200)}\n`);
      }
    }
  };
}

/**
 * Create a write-coalescing function that buffers outgoing messages and flushes
 * on a timer or when the buffer exceeds maxBufferSize.
 *
 * @param {Object} [options] - Coalescing options.
 * @param {number} [options.coalesceMs=1] - Milliseconds to wait before flushing.
 *   If <= 0, writes immediately (passthrough mode).
 * @param {number} [options.maxBufferSize=16384] - Maximum buffer size in bytes
 *   before forcing an immediate flush.
 * @param {Function} [options.writeFn] - Optional custom write function. Defaults to
 *   `process.stdout.write`. Useful for testing.
 * @returns {Function} A `write(data)` function that buffers and flushes data.
 */
function createCoalescingWriter({ coalesceMs = 1, maxBufferSize = 16384, writeFn } = {}) {
  const write = writeFn || process.stdout.write.bind(process.stdout);
  let buffer = '';
  let flushTimer = null;
  let pendingFlush = false;

  function flush() {
    if (pendingFlush) return;
    pendingFlush = true;

    const data = buffer;
    buffer = '';

    // Clear the timer reference since we're flushing
    flushTimer = null;

    // If data is empty, nothing to write
    if (!data) {
      pendingFlush = false;
      return;
    }

    const canContinue = write(data);
    if (!canContinue) {
      // Wait for drain before flushing more
      // Note: drain event handling requires process.stdout, so we check if writeFn was provided
      if (!writeFn && process.stdout && typeof process.stdout.on === 'function') {
        const onDrain = () => {
          process.stdout.off('drain', onDrain);
          pendingFlush = false;
        };
        process.stdout.once('drain', onDrain);
      } else {
        pendingFlush = false;
      }
    } else {
      pendingFlush = false;
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, coalesceMs);
  }

  function writeData(data) {
    // Passthrough mode when coalesceMs <= 0
    if (coalesceMs <= 0) {
      write(data);
      return;
    }

    buffer += data;

    // Check if we need to flush immediately due to buffer size
    if (Buffer.byteLength(buffer, 'utf8') >= maxBufferSize) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush();
    } else {
      scheduleFlush();
    }
  }

  return writeData;
}

module.exports = {
  createCategorizedError,
  categorizeError,
  createJsonRpcSuccess,
  createJsonRpcError,
  encodeMessage,
  createStdioMessageReader,
  createCoalescingWriter
};
