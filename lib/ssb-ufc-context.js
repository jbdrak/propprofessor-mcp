'use strict';

// ---------------------------------------------------------------------------
// Weight class detection
// ---------------------------------------------------------------------------

/** @type {Array<{pattern: RegExp, weightClass: string}>} */
const WEIGHT_CLASS_PATTERNS = [
  // Multi-word patterns first to prevent partial matches of shorter patterns
  { pattern: /\bWomen's\s*Strawweight\b/i, weightClass: "Women's Strawweight" },
  { pattern: /\bWomen's\s*Flyweight\b/i, weightClass: "Women's Flyweight" },
  { pattern: /\bWomen's\s*Bantamweight\b/i, weightClass: "Women's Bantamweight" },
  { pattern: /\bWomen's\s*Featherweight\b/i, weightClass: "Women's Featherweight" },
  { pattern: /\bLight[\s-]*Heavyweight\b/i, weightClass: 'Light Heavyweight' },
  { pattern: /\bSuper\s*Heavyweight\b/i, weightClass: 'Super Heavyweight' },
  // Single-word patterns (ordered longest-first for substring safety)
  { pattern: /\bStrawweight\b/i, weightClass: 'Strawweight' },
  { pattern: /\bFeatherweight\b/i, weightClass: 'Featherweight' },
  { pattern: /\bLightweight\b/i, weightClass: 'Lightweight' },
  { pattern: /\bHeavyweight\b/i, weightClass: 'Heavyweight' },
  { pattern: /\bBantamweight\b/i, weightClass: 'Bantamweight' },
  { pattern: /\bMiddleweight\b/i, weightClass: 'Middleweight' },
  { pattern: /\bWelterweight\b/i, weightClass: 'Welterweight' },
  { pattern: /\bFlyweight\b/i, weightClass: 'Flyweight' },
  { pattern: /\bCatchweight\b/i, weightClass: 'Catchweight' }
];

// ---------------------------------------------------------------------------
// Event type detection
// ---------------------------------------------------------------------------

/** @type {Array<{pattern: RegExp, eventType: string}>} */
const EVENT_TYPE_PATTERNS = [
  // Numbered PPV events: "UFC 300", "UFC 290", "UFC 2", etc.
  { pattern: /\bUFC\s+\d{1,3}\b/i, eventType: 'PPV' },
  // Fight Night
  { pattern: /\bUFC\s+Fight\s+Night\b/i, eventType: 'Fight Night' },
  // ESPN cards (ESPN / ABC)
  { pattern: /\bUFC\s+on\s+ESPN\b/i, eventType: 'ESPN Card' },
  { pattern: /\bUFC\s+on\s+ABC\b/i, eventType: 'ESPN Card' },
  // TUF Finale
  { pattern: /\bTUF\s+Finale\b/i, eventType: 'TUF Finale' },
  // PPV literal mention
  { pattern: /\bUFC\s+PPV\b/i, eventType: 'PPV' }
];

// ---------------------------------------------------------------------------
// Fight importance / card position detection
// ---------------------------------------------------------------------------

/** @type {Array<{pattern: RegExp, importance: string}>} */
const FIGHT_IMPORTANCE_PATTERNS = [
  // Multi-word patterns first to avoid partial matches
  { pattern: /\bEarly\s+Prelim(?:s)?\b/i, importance: 'Early Prelim' },
  { pattern: /\bCo[- ]?Main\b/i, importance: 'Co-Main' },
  { pattern: /\bMain\s+Event\b/i, importance: 'Main Event' },
  { pattern: /\bPrelim(?:s)?\b/i, importance: 'Prelim' }
];

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Detect the event type from an event name string.
 * @param {string} event - Event name to classify.
 * @returns {string} Event type: "PPV", "Fight Night", "ESPN Card", "TUF Finale", or "Unknown".
 */
function detectEventType(event) {
  if (!event || typeof event !== 'string') return 'Unknown';
  for (const { pattern, eventType } of EVENT_TYPE_PATTERNS) {
    if (pattern.test(event)) return eventType;
  }
  return 'Unknown';
}

/**
 * Detect a weight class from a weight class string.
 * @param {string} weightClass - Weight class string to classify.
 * @returns {string|null} Normalized weight class name or null if unknown.
 */
function detectWeightClass(weightClass) {
  if (!weightClass || typeof weightClass !== 'string') return null;
  for (const { pattern, weightClass: wc } of WEIGHT_CLASS_PATTERNS) {
    if (pattern.test(weightClass)) return wc;
  }
  return null;
}

/**
 * Detect fight importance / card position from a description.
 * @param {string} description - Description string to classify.
 * @returns {string|null} Importance level or null if unknown.
 */
function detectFightImportance(description) {
  if (!description || typeof description !== 'string') return null;
  for (const { pattern, importance } of FIGHT_IMPORTANCE_PATTERNS) {
    if (pattern.test(description)) return importance;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Get UFC context for a fight: event type, weight class, fight importance,
 * and risk signal — all purely heuristic based on fight metadata.
 *
 * @param {Object} [opts={}]
 * @param {string} [opts.event] - Event name (e.g. "UFC 300", "UFC Fight Night: Edwards vs Brady").
 * @param {string} [opts.weightClass] - Weight class string (e.g. "Lightweight", "Heavyweight").
 * @param {string} [opts.fighter1] - Name of the first fighter (unused currently, reserved).
 * @param {string} [opts.fighter2] - Name of the second fighter (unused currently, reserved).
 * @param {string} [opts.fightId] - Fight identifier (unused currently, reserved).
 * @returns {{
 *   ok: boolean,
 *   sport: string,
 *   eventType: string,
 *   weightClass: string|null,
 *   fightImportance: string|null,
 *   riskFlag: string,
 *   riskSummary: string|null,
 *   signals: { eventType: string, weightClass: string|null },
 *   fetchedAt: string
 * }}
 */
function getUfcContext(opts = {}) {
  const { event, weightClass: rawWeightClass } = opts;

  // Detect event type
  const eventType = detectEventType(event);

  // Detect weight class
  const detectedWeightClass = rawWeightClass ? detectWeightClass(rawWeightClass) || rawWeightClass : null;

  // Determine risk signal
  let riskFlag;
  let riskSummary;

  if (eventType === 'PPV') {
    // PPV events have more reliable judging and fighters are better prepared
    riskFlag = 'clean';
    riskSummary = detectedWeightClass
      ? `UFC PPV — ${detectedWeightClass} bout. PPV events have the most reliable officiating and fighter preparation.`
      : 'UFC PPV event. Reliable officiating and fighter preparation expected.';
  } else if (eventType === 'Fight Night') {
    // Fight Night main events are still reliable but less scrutinized
    riskFlag = 'low';
    riskSummary = detectedWeightClass
      ? `UFC Fight Night — ${detectedWeightClass} bout. Less oversight than PPV, but still professional.`
      : 'UFC Fight Night event. Less oversight than PPV, but still professional.';
  } else if (eventType === 'ESPN Card') {
    // ESPN cards are similar to Fight Night in terms of production
    riskFlag = 'low';
    riskSummary = detectedWeightClass
      ? `UFC on ESPN/ABC — ${detectedWeightClass} bout. Televised card with moderate oversight.`
      : 'UFC on ESPN/ABC card. Televised with moderate oversight.';
  } else if (eventType === 'TUF Finale') {
    riskFlag = 'low';
    riskSummary = detectedWeightClass
      ? `TUF Finale — ${detectedWeightClass} bout. Lower profile but professional card.`
      : 'TUF Finale event. Lower profile but professional card.';
  } else {
    riskFlag = 'unknown';
    riskSummary = detectedWeightClass
      ? `Unknown event type — ${detectedWeightClass} bout. Unable to assess context reliability.`
      : 'Unknown event type. Unable to assess context reliability.';
  }

  return {
    ok: true,
    sport: 'UFC',
    eventType,
    weightClass: detectedWeightClass,
    fightImportance: null,
    riskFlag,
    riskSummary,
    signals: {
      eventType,
      weightClass: detectedWeightClass
    },
    fetchedAt: new Date().toISOString()
  };
}

module.exports = {
  getUfcContext,
  detectEventType,
  detectWeightClass,
  detectFightImportance,
  WEIGHT_CLASS_PATTERNS,
  EVENT_TYPE_PATTERNS,
  FIGHT_IMPORTANCE_PATTERNS
};
