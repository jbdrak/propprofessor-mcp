'use strict';

const { localDateKey } = require('./mcp-runtime-config');

/**
 * Find the best matching row from detail rows for a requested selection.
 *
 * Priority order (highest first):
 *   1. playId exact match (when requestedPlayId provided)
 *   2. Exact selection match (with numeric guard)
 *   3. Stripped line match (remove trailing "-1.5", "+110", etc.)
 *   4. Stripped Over/Under match (remove "Over "/"Under " prefix)
 *   5. Nested selection objects (r.selections)
 *   6. Home/away team includes (last resort)
 *
 * NUMERIC GUARD: When the user's selection contains a number (e.g. "22.5"
 * in "Over 22.5"), rows whose selection field STILL contains that number
 * after stripping get priority. This prevents "Over 22.5" from matching a
 * row with selection "Over 24.5" when both exist in the same market.
 *
 * @param {Object[]} detailRows - Screen detail rows
 * @param {string} selection - Requested selection string
 * @param {string} [requestedPlayId] - Optional playId for exact match
 * @param {string} [requestedBook] - Preferred execution book for nested-line odds resolution
 * @returns {Object|null} Best matching row or null
 */
function findBestMatch(detailRows = [], selection = '', requestedPlayId = '', requestedBook = '') {
  if (!Array.isArray(detailRows) || !detailRows.length || (!selection && !requestedPlayId)) return null;

  const selLower = normalizeKey(selection);
  const selNumeric = extractNumeric(selLower);
  const selStrippedLine = stripLine(selLower);
  const selStrippedOU = stripOverUnder(selLower);
  const selStrippedBoth = stripOverUnder(selStrippedLine);

  /** Check if a stored selection passes the numeric guard */
  function passesNumericGuard(stored) {
    if (!selNumeric) return true; // no number in request → no guard
    return stored.includes(selNumeric);
  }

  // Pass 1: playId exact match
  if (requestedPlayId) {
    const match = detailRows.find((r) => String(r.playId || '').trim() === requestedPlayId);
    if (match) return match;
  }

  // Pass 2: exact selection match
  const exact = detailRows.find((r) => {
    const stored = normalizeKey(r.selection || r.participant || '');
    if (stored === selLower) return passesNumericGuard(stored);
    return false;
  });
  if (exact) return exact;

  // Pass 3: stripped line match — strip BOTH sides
  const stripped = detailRows.find((r) => {
    const stored = normalizeKey(r.selection || r.participant || '');
    const storedStripped = stripLine(stored);
    if (!passesNumericGuard(stored)) return false;
    return storedStripped === selStrippedLine;
  });
  if (stripped) return stripped;

  // Pass 4: stripped Over/Under match — strip BOTH sides
  const ouMatch = detailRows.find((r) => {
    const stored = normalizeKey(r.selection || r.participant || '');
    const storedStrippedOU = stripOverUnder(stored);
    if (!passesNumericGuard(stored)) return false;
    return storedStrippedOU === selStrippedOU || storedStrippedOU === selStrippedBoth;
  });
  if (ouMatch) return ouMatch;

  // Pass 5: nested selection objects (r.selections)
  // The detail feed returns each market as ONE container row whose top-level
  // `participant`/`odds` describe a SINGLE representative line (often the
  // market's default), while every line lives under r.selections[line].
  // e.g. WNBA Total Points: participant:"Under 173.5", odds:-143, with
  // selections['166.5'].selection2:"Under 166.5". If we return the container
  // when the nested line matches, the consumer reads 173.5's -143 for a 166.5
  // bet — a wrong-line price. So: when the matched nested line differs from the
  // container's participant, synthesize a FLAT row for that exact line (correct
  // selection + that line's odds) and carry the container's consensus/edge/CLV
  // fields so the validator still has movement context. A container with NO
  // top-level participant (moneyline / tennis, where selections hold the real
  // teams) still matches the old way.
  let nestedMatch = null;
  for (const r of detailRows) {
    if (!r.selections || typeof r.selections !== 'object') continue;
    for (const key of Object.keys(r.selections)) {
      const sel = r.selections[key];
      if (!sel || typeof sel !== 'object') continue;
      const s1 = normalizeKey(sel.selection1 || '');
      const s2 = normalizeKey(sel.selection2 || '');
      const hitExact = s1 === selLower || s2 === selLower;
      const hitLine =
        !passesNumericGuard(s1) && !passesNumericGuard(s2)
          ? false
          : s1 === selStrippedLine || s2 === selStrippedLine || s1 === selStrippedOU || s2 === selStrippedOU;
      if (!hitExact && !hitLine) continue;
      // Prefer the side whose label matches more closely.
      const chosen =
        s1 === selLower || s1 === selStrippedLine || s1 === selStrippedOU ? sel.selection1 : sel.selection2;
      // Resolve that line's odds for the requested (or first available) book.
      const oddsMap = sel.odds && typeof sel.odds === 'object' ? sel.odds : {};
      const bookKey = requestedBook && oddsMap[requestedBook] ? requestedBook : Object.keys(oddsMap)[0];
      const bookOdds = bookKey ? oddsMap[bookKey] : null;
      const containerParticipant = normalizeKey(r.participant || r.selection || '');
      // When the container has no participant/selection (common for totals/spreads
      // where every line lives under selections), an exact hit on a nested key IS
      // the container line — don't flag it as cross-line.
      const lineIsContainer = containerParticipant === normalizeKey(chosen) || (!containerParticipant && hitExact);
      if (lineIsContainer) {
        // Container already describes this exact line — return as-is.
        return r;
      }
      // Different line: build a flat row so the consumer never reads the
      // container's representative odds for the wrong line.
      // CRITICAL: consensusBookCount, edge, CLV, and other aggregate stats
      // on the container describe the CONTAINER's line, not this nested line.
      // Compute the actual book count from the nested line's odds map and
      // zero out the container's aggregates so the validator doesn't silently
      // inherit stats from a different line (e.g. +10's 1-book consensus
      // poisoning +7.5's 11-book deep market).
      const nestedOddsMap = sel.odds && typeof sel.odds === 'object' ? sel.odds : {};
      const nestedBookCount = Object.keys(nestedOddsMap).length;
      nestedMatch = {
        ...r,
        selection: chosen,
        participant: chosen,
        selectionKey: normalizeSelectionKey(chosen),
        // Fix the playId line suffix so downstream output isn't misleading
        // (the container's playId describes a different line).
        playId: (r.playId || '').replace(/::[^:]+$/, '::' + chosen),
        // Pull this line's odds. For totals/spreads odds2 is the Under side.
        odds: bookOdds ? (selLower.startsWith('under') ? bookOdds.odds2 : bookOdds.odds1) : null,
        line: key,
        nestedMatchLine: key,
        matchedContainerParticipant: r.participant || null,
        // Replace the container's aggregate stats with the nested line's reality.
        // The container's consensusBookCount/edge/CLV came from a DIFFERENT line.
        consensusBookCount: nestedBookCount,
        consensusStrength: nestedBookCount >= 6 ? 'strong' : nestedBookCount >= 3 ? 'moderate' : 'weak',
        marketBookCount: nestedBookCount,
        supportBookCount: nestedBookCount,
        // Zero out container-derived aggregates — they're from the wrong line.
        // NOTE: consensusBookCount/edge/CLV are line-specific and must be zeroed.
        // But movement direction (label/grade/quality) is DIRECTIONAL — Over 8.5
        // inherits the same directional signal as Over 8. Preserve it so the
        // tiering system can still assess whether money is moving toward or away
        // from this side, rather than treating every cross-line match as "unknown."
        consensusEdge: null,
        hasConsensus: nestedBookCount >= 2,
        clvProxyPct: null,
        multiWindowScore: r.multiWindowScore || 0,
        movementGrade: r.movementGrade || 'yellow',
        movementLabel: r.movementLabel || 'cross_line_match',
        movementQuality: r.movementQuality || 'unknown',
        movementQualityScore: r.movementQualityScore || 0,
        crossLineMatch: true
      };
      break;
    }
    if (nestedMatch) break;
  }
  if (nestedMatch) return nestedMatch;

  // Pass 6: home/away team includes (last resort — most lossy)
  return (
    detailRows.find((r) => {
      const home = normalizeKey(r.homeTeam || '');
      const away = normalizeKey(r.awayTeam || '');
      return home.includes(selLower) || away.includes(selLower);
    }) || null
  );
}

/**
 * Parse a timestamp-encoded backend gameId into matchup identity + scheduled date.
 *
 * Backend gameIds embed a Unix start timestamp in the last colon-segment, e.g.
 * `MLB:PREMATCH:Chicago_Cubs:Los_Angeles_Dodgers:1785946800` or
 * `Tennis:PREMATCH:Griekspoor:Zverev:1786024800`. The same event can surface
 * under a NEW timestamp (e.g. 1785946800 → 1785954000, a 2-hour shift) when
 * the backend re-keys the game. This extracts the parts validation needs to
 * reconcile the drift.
 *
 * @param {string} gameId - Raw gameId.
 * @returns {{ participants: string[], dateKey: string|null, timestamp: number|null }|null}
 *   Display-name participants (underscores → spaces, original casing), the local
 *   calendar date key of the encoded start, and the numeric timestamp. Null when
 *   the gameId does not carry a parseable `...:<10-digit-ts>` shape.
 */
function parseGameIdIdentity(gameId) {
  const parts = String(gameId || '').split(':');
  if (parts.length < 4) return null;
  const timestamp = parts[parts.length - 1];
  if (!/^\d{10}$/.test(timestamp)) return null;
  const participants = parts
    .slice(2, -1)
    .map((p) =>
      String(p || '')
        .replace(/_/g, ' ')
        .trim()
    )
    .filter(Boolean);
  if (participants.length < 2) return null;
  const tsMs = Number(timestamp) * 1000;
  return { participants, dateKey: localDateKey(tsMs), timestamp: Number(timestamp) };
}

/**
 * Strict identity fallback for when the exact gameId lookup yields no row but
 * the same matchup may still exist under a NEW gameId (timestamp drift).
 *
 * Fail-closed: returns null unless EXACTLY ONE game matches on ALL of
 *  - normalized league
 *  - participants identity (home/away pair, order-insensitive; slugs and
 *    display names compare equal)
 *  - market
 *  - selection (findBestMatch semantics) or the playId-derived selectionKey
 *  - same scheduled calendar date (local tz — same key the card windows use)
 *
 * Ambiguity (two games with the same matchup/date, e.g. a doubleheader) and
 * missing/invalid date or identity data both return null — never a guess.
 *
 * @param {Object[]} detailRows - Rows from a relaxed (participants-based) detail re-fetch.
 * @param {{ league?: string, market?: string, selection?: string, gameId?: string, playId?: string, requestedBook?: string, verifiedDateKey?: string }} [opts]
 * @returns {Object|null} The uniquely-matching row, or null.
 */
function findBestMatchGameIdChanged(detailRows = [], opts = {}) {
  const {
    league = '',
    market = '',
    selection = '',
    gameId = '',
    playId = '',
    requestedBook = '',
    verifiedDateKey = ''
  } = opts;
  if (!Array.isArray(detailRows) || !detailRows.length) return null;
  const identity = parseGameIdIdentity(gameId);
  if (!identity || !identity.dateKey) return null;

  const leagueKey = normalizeKey(league);
  const marketKey = normalizeKey(market);
  const expectedPair = identity.participants.map(identityKey).sort().join('|');

  const candidates = detailRows.filter((r) => {
    if (!r || typeof r !== 'object') return false;
    // League — required on the row; mismatch excludes.
    const rowLeague = normalizeKey(r.league);
    if (!rowLeague || (leagueKey && rowLeague !== leagueKey)) return false;
    // Market — required on the row; mismatch excludes.
    const rowMarket = normalizeKey(r.market);
    if (!rowMarket || (marketKey && rowMarket !== marketKey)) return false;
    // Participants identity — home/away pair, order-insensitive.
    const home = identityKey(r.homeTeam);
    const away = identityKey(r.awayTeam);
    if (!home || !away) return false;
    if ([home, away].sort().join('|') !== expectedPair) return false;
    // Same scheduled calendar date (local tz) — row.start required.
    const rowDate = dateKeyOf(r.start);
    const expectedDate = verifiedDateKey || identity.dateKey;
    if (!rowDate || rowDate !== expectedDate) return false;
    // Cross-check the row's own gameId timestamp when it parses.
    const rowIdentity = parseGameIdIdentity(r.gameId);
    if (rowIdentity && rowIdentity.dateKey && rowIdentity.dateKey !== expectedDate) return false;
    return true;
  });

  if (!candidates.length) return null;

  // Fail closed on game-level ambiguity: more than one distinct gameId with the
  // same matchup+date (doubleheader etc.) cannot be resolved safely.
  const distinctGameIds = new Set(candidates.map((r) => String(r.gameId || '').trim()).filter(Boolean));
  if (distinctGameIds.size !== 1) return null;

  // Narrow by selection. findBestMatch reuses the primary path's selection
  // semantics (exact → stripped line → Over/Under → nested → home/away).
  if (normalizeKey(selection)) {
    return findBestMatch(candidates, selection, '', requestedBook) || null;
  }
  // Selection empty: derive the selectionKey from the playId
  // ([gameId, market, selectionKey].join('::') — gameId contains single colons,
  // so '::' splits cleanly into 3 parts).
  const playParts = String(playId || '').split('::');
  const playSelKey = playParts.length >= 3 ? identityKey(playParts[2]) : '';
  if (!playSelKey) return null;
  const byKey = candidates.filter((r) => {
    const rowKey = identityKey(r.selectionKey) || identityKey(r.selection || r.participant || '');
    return Boolean(rowKey) && rowKey === playSelKey;
  });
  return byKey.length === 1 ? byKey[0] : null;
}

/** Normalize for identity comparison — lowercase, spaces/underscores collapse. */
function identityKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')
    .trim();
}

/** ISO/date value → local calendar date key (same helper the card windows use). */
function dateKeyOf(value) {
  if (value == null || value === '') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? localDateKey(ms) : null;
}

/** Normalize a key for comparison */
function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Strip trailing line/spread: "Harris -1.5" → "Harris", "Over 22.5" → "Over" */
function stripLine(s) {
  return s.replace(/\s*[+-]?\d+(?:\.\d+)?\s*(sets|games)?\s*$/i, '').trim();
}

/** Strip "Over "/"Under " prefix */
function stripOverUnder(s) {
  return s.replace(/^(over|under)\s+/i, '').trim();
}

/** Normalize a selection key (lowercased, spaces→underscores) */
function normalizeSelectionKey(value) {
  return normalizeKey(value).replace(/\s+/g, '_');
}

/** Extract the first numeric portion from a string */
function extractNumeric(s) {
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

module.exports = {
  findBestMatch,
  findBestMatchGameIdChanged,
  parseGameIdIdentity,
  normalizeKey,
  stripLine,
  stripOverUnder,
  extractNumeric,
  normalizeSelectionKey
};
