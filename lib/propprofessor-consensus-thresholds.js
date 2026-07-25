'use strict';

/**
 * Single source of truth for "strong consensus" book-count thresholds.
 *
 * Historically these numbers were copy-pasted as inline literals across
 * movement-disposition, risk-grade, and consensus modules — and they drifted
 * (5, 10, 12, and a per-league 3/5 appeared independently). Centralizing them
 * means "strong consensus" means one thing everywhere and the tuning surface
 * is in one file.
 *
 * Semantic guidance:
 *  - MOVEMENT_DISPOSITION_SUPPORT: thin-history leagues where 5+ books agree
 *    on price → treat as directional signal (computeMovementDisposition).
 *  - INSUFFICIENT_HISTORY_UPGRADE: insufficient_history + edge + playable exec
 *    upgrades to supportive for tiering (gradeMovementQuality).
 *  - BOUNCY_GREEN_UPGRADE: bouncy movement + 12 books incl. Pinnacle → GREEN.
 *  - GREEN_GATE / GREEN_GATE_MLB: minimum consensus depth to allow GREEN grade.
 */

/** consensusBookCount floor to infer direction from price alone (disposition). */
const MOVEMENT_DISPOSITION_SUPPORT = 5;

/**
 * consensusBookCount floor for the insufficient-history → supportive upgrade
 * in the movement grade. Higher than MOVEMENT_DISPOSITION_SUPPORT because the
 * grade gate is stricter than a bare disposition inference.
 */
const INSUFFICIENT_HISTORY_UPGRADE = 10;

/**
 * consensusBookCount floor for the bouncy-but-strong GREEN path, which also
 * requires Pinnacle in the consensus. Highest bar — the line is noisy, so the
 * book agreement must be unambiguous.
 */
const BOUNCY_GREEN_UPGRADE = 12;

/** Minimum consensus depth to allow a GREEN movement grade (non-MLB). */
const GREEN_GATE = 5;

/** Minimum consensus depth to allow a GREEN movement grade for MLB. */
const GREEN_GATE_MLB = 3;

/**
 * Multi-window consensus is "confirmed" only when this fraction of the
 * configured sharp books actually agreed in a window. Below this, the
 * consensus is partial and should not be weighted as full agreement (see
 * computeMultiWindowScore's confirmedBookCount/requiredBookCount).
 */
const PARTIAL_CONSENSUS_CONFIRMED_FRACTION = 0.66;

module.exports = {
  MOVEMENT_DISPOSITION_SUPPORT,
  INSUFFICIENT_HISTORY_UPGRADE,
  BOUNCY_GREEN_UPGRADE,
  GREEN_GATE,
  GREEN_GATE_MLB,
  PARTIAL_CONSENSUS_CONFIRMED_FRACTION
};
