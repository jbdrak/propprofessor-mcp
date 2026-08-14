#!/usr/bin/env node
'use strict';

/**
 * Honest ledger-derived tennis Elo evaluation report (Task 2.3).
 *
 * Reproducible DESCRIPTIVE metrics for settled Tennis Moneyline bets, derived
 * from the v2 record ledger only. Hard rules:
 *
 *   - Only settled (win/loss/push) Tennis Moneyline bets with an immutable
 *     decision-time featureSnapshot are included. Excluded rows are counted
 *     by reason: nonTennis, nonMoneyline, unsettled, noSnapshot,
 *     missingProbability.
 *   - Probabilities are read from the decision-time featureSnapshot ONLY.
 *     Missing historical Elo / missing snapshot fields are never backfilled
 *     from later rows, settlement records, or any current/global data.
 *   - Each explicit probability source is scored separately:
 *       marketFairProbability            — market fair probability
 *       modelWinProbability              — the PP model's win probability
 *                                          (NOT a confidence score)
 *       featureSnapshot.tennis.elo.selectedProbability — Elo selected-player
 *                                          win probability at decision time
 *     A combinedProbability is an arithmetic mean ONLY of the explicitly
 *     present sources, and only when at least two are present. The formula
 *     is labeled in the report; nothing is trained or tuned on this data.
 *   - Brier, log loss, and stable calibration bins reuse
 *     lib/propprofessor-backtest-metrics; the settled join reuses
 *     lib/record-evaluation (joinSettledBets).
 *   - CLV is aggregated only from an explicitly recorded decision-time
 *     clvProxyPct. ROI uses lib/propprofessor-backtest-metrics and only rows
 *     with recorded odds and stake.
 *   - No clock, no network, no file writes. Empty/tiny samples return a
 *     JSON-safe report with caveats; no significance/uplift/improvement
 *     claim is ever generated.
 *
 * Usage:
 *   node scripts/backtest-tennis-elo.js [--ledger <path>] [--json]
 *   --ledger defaults to $PP_RECORD_LEDGER or ~/.propprofessor/tracker/ledger.json
 *
 * Exit codes: 0 success (including empty), 2 usage errors, 1 ledger errors.
 */

const { joinSettledBets, DEFAULT_MIN_SAMPLE } = require('../lib/record-evaluation');
const {
  brierScore,
  logLoss,
  calibrationBins,
  computeBacktestMetrics
} = require('../lib/propprofessor-backtest-metrics');
const { loadLedger, defaultLedgerPath } = require('../lib/record-ledger');

// Explicit decision-time probability sources, scored independently. The
// model source is the PP model's recorded win probability — deliberately NOT
// labeled as a confidence score, which is not a probability.
const PROBABILITY_SOURCES = Object.freeze([
  { field: 'marketFairProbability', label: 'Market fair probability' },
  { field: 'modelWinProbability', label: 'PP model win probability' },
  { field: 'tennisEloSelectedProbability', label: 'Elo selected-player win probability' }
]);

const COMBINED_FIELD = 'combinedProbability';
const COMBINED_LABEL = 'Combined probability (arithmetic mean of explicit sources)';
const COMBINED_FORMULA =
  'Arithmetic mean of the explicitly present decision-time sources ' +
  '(marketFairProbability, modelWinProbability, tennisEloSelectedProbability); ' +
  'computed only when at least two sources are present.';

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function isTennisLeague(value) {
  return typeof value === 'string' && /tennis|atp|wta/i.test(value);
}

function isMoneylineMarket(value) {
  return typeof value === 'string' && (/moneyline/i.test(value) || /^ml$/i.test(value.trim()));
}

function isValidProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isValidClv(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function snapshotOf(row) {
  return row && row.featureSnapshot && typeof row.featureSnapshot === 'object' && !Array.isArray(row.featureSnapshot)
    ? row.featureSnapshot
    : null;
}

/**
 * Decision-time probabilities from the immutable featureSnapshot ONLY.
 * Missing or invalid values become null — never derived, never backfilled.
 */
function probabilityOf(snapshot) {
  if (!snapshot) return { market: null, model: null, elo: null };
  const tennis =
    snapshot.tennis && typeof snapshot.tennis === 'object' && !Array.isArray(snapshot.tennis) ? snapshot.tennis : null;
  const elo = tennis && tennis.elo && typeof tennis.elo === 'object' && !Array.isArray(tennis.elo) ? tennis.elo : null;
  return {
    market: isValidProbability(snapshot.marketFairProbability) ? snapshot.marketFairProbability : null,
    model: isValidProbability(snapshot.modelWinProbability) ? snapshot.modelWinProbability : null,
    elo: isValidProbability(elo && elo.selectedProbability) ? elo.selectedProbability : null
  };
}

/**
 * Arithmetic mean of the explicitly present sources; null unless >= 2
 * sources are present (a one-source "mean" would just duplicate that source).
 */
function combinedOf(probs) {
  const present = [probs.market, probs.model, probs.elo].filter((value) => value !== null);
  if (present.length < 2) return null;
  return round6(present.reduce((sum, value) => sum + value, 0) / present.length);
}

function betIdOf(row) {
  return row.id != null ? row.id : row.betId != null ? row.betId : row.settlement && row.settlement.betId;
}

/**
 * Select the evaluation rows and count exclusions by reason.
 *
 * @param {Object} ledger - v2 ledger
 * @param {Array<Object>} settledRows - joinSettledBets(ledger) output
 * @returns {{included: Array<Object>, byReason: Object<string, number>, total: number}}
 */
function selectRows(ledger, settledRows) {
  const byReason = { nonTennis: 0, nonMoneyline: 0, unsettled: 0, noSnapshot: 0, missingProbability: 0 };
  const settledIds = new Set();
  for (const row of settledRows) {
    const id = betIdOf(row);
    if (id != null) settledIds.add(id);
  }
  // Unsettled: official bets with no settlement whose status is a settled
  // outcome (pending/retirement/none never join). Malformed entries are not
  // bets and are skipped, mirroring joinSettledBets.
  const bets = ledger && Array.isArray(ledger.bets) ? ledger.bets : [];
  for (const bet of bets) {
    if (!bet || typeof bet !== 'object') continue;
    const id = bet.id != null ? bet.id : bet.betId;
    if (id == null || !settledIds.has(id)) byReason.unsettled += 1;
  }

  const included = [];
  for (const row of settledRows) {
    const snapshot = snapshotOf(row);
    const league = snapshot && snapshot.league != null ? snapshot.league : row.league != null ? row.league : null;
    const market = snapshot && snapshot.market != null ? snapshot.market : row.market != null ? row.market : null;
    if (!isTennisLeague(league)) {
      byReason.nonTennis += 1;
      continue;
    }
    if (!isMoneylineMarket(market)) {
      byReason.nonMoneyline += 1;
      continue;
    }
    if (!snapshot) {
      byReason.noSnapshot += 1;
      continue;
    }
    const probs = probabilityOf(snapshot);
    if (probs.market === null && probs.model === null && probs.elo === null) {
      byReason.missingProbability += 1;
      continue;
    }
    included.push(row);
  }

  const total =
    byReason.nonTennis + byReason.nonMoneyline + byReason.unsettled + byReason.noSnapshot + byReason.missingProbability;
  return { included, byReason, total };
}

/**
 * Flat, decision-time-only row projection (deep-cloned, immutable input).
 */
function toRow(row) {
  const snapshot = snapshotOf(row);
  const probs = probabilityOf(snapshot);
  const odds = row.oddsAtDecision != null ? row.oddsAtDecision : row.odds != null ? row.odds : null;
  const stake = row.stake != null ? row.stake : null;
  const settlement = row.settlement && typeof row.settlement === 'object' ? row.settlement : null;
  return {
    betId: betIdOf(row),
    outcome: row.outcome,
    capturedAt: row.capturedAt != null ? row.capturedAt : row.createdAt != null ? row.createdAt : null,
    settledAt: settlement && settlement.settledAt != null ? settlement.settledAt : null,
    odds,
    stake,
    marketFairProbability: probs.market,
    modelWinProbability: probs.model,
    tennisEloSelectedProbability: probs.elo,
    combinedProbability: combinedOf(probs),
    clvProxyPct: snapshot && isValidClv(snapshot.clvProxyPct) ? snapshot.clvProxyPct : null
  };
}

function sortKeyOf(row) {
  const time = Date.parse(row.capturedAt != null ? row.capturedAt : row.settledAt);
  return Number.isNaN(time) ? -Infinity : time;
}

/**
 * Chronological order by decision-time capturedAt (fallback settledAt), with
 * a betId tie-break so output is fully deterministic.
 */
function chronological(a, b) {
  const keyA = sortKeyOf(a);
  const keyB = sortKeyOf(b);
  if (keyA !== keyB) return keyA - keyB;
  return String(a.betId).localeCompare(String(b.betId));
}

/**
 * Score one probability field across the row projections with the shared
 * metrics library. Pushes and missing values are excluded by the metrics
 * contract; coverage and missingProbability quantify the gap.
 */
function scoreSource(rows, field, decided) {
  const scorable = rows.map((row) => ({ outcome: row.outcome, [field]: row[field] }));
  const brier = brierScore(scorable, field);
  const samples = brier.samples;
  return {
    samples,
    coverage: decided > 0 ? round6(samples / decided) : null,
    missingProbability: decided - samples,
    brier,
    logLoss: logLoss(scorable, field),
    calibration: calibrationBins(scorable, field)
  };
}

/**
 * Descriptive agreement/disagreement between market fair and Elo selected-
 * player probabilities. Rows must carry BOTH explicit values to count as a
 * pair. "Side won" counts only decided disagreements and is descriptive.
 */
function computeAgreement(rows) {
  const pairs = rows.filter((row) => row.marketFairProbability !== null && row.tennisEloSelectedProbability !== null);
  if (pairs.length === 0) return null;
  let agree = 0;
  let disagree = 0;
  let decidedDisagreements = 0;
  let marketSideWon = 0;
  let eloSideWon = 0;
  for (const row of pairs) {
    const marketFavors = row.marketFairProbability >= 0.5;
    const eloFavors = row.tennisEloSelectedProbability >= 0.5;
    if (marketFavors === eloFavors) {
      agree += 1;
      continue;
    }
    disagree += 1;
    if (row.outcome === 'push') continue;
    decidedDisagreements += 1;
    const marketWon = marketFavors ? row.outcome === 'win' : row.outcome === 'loss';
    if (marketWon) marketSideWon += 1;
    else eloSideWon += 1;
  }
  return {
    pairs: pairs.length,
    agree,
    disagree,
    decidedDisagreements,
    marketSideWon,
    eloSideWon,
    agreePct: round6(agree / pairs.length)
  };
}

/**
 * Recorded decision-time CLV proxy aggregation (featureSnapshot.clvProxyPct
 * only). Returns null when nothing was explicitly recorded.
 */
function computeClv(rows) {
  const values = rows.map((row) => row.clvProxyPct).filter((value) => value !== null);
  if (values.length === 0) return null;
  return { samples: values.length, meanClvPct: round6(values.reduce((sum, value) => sum + value, 0) / values.length) };
}

/**
 * ROI from recorded odds/stake + settlement only, via the shared metrics
 * library. Rows without a finite nonzero price and positive stake are
 * excluded (never guessed).
 */
function computeRoi(rows) {
  const plays = [];
  for (const row of rows) {
    const odds = Number(row.odds);
    const stake = Number(row.stake);
    if (!Number.isFinite(odds) || odds === 0 || !Number.isFinite(stake) || stake <= 0) continue;
    plays.push({
      odds,
      stake,
      result: row.outcome === 'win' ? 'won' : row.outcome === 'loss' ? 'lost' : 'push'
    });
  }
  if (plays.length === 0) return null;
  return computeBacktestMetrics(plays);
}

function buildCaveats(parts) {
  const { includedCount, decided, minSample, probabilitySources, agreement, clv, roi } = parts;
  const caveats = [
    'Descriptive statistics only — no significance, improvement, or predictive-value claim is made or implied.'
  ];
  if (includedCount === 0) {
    caveats.push(
      'No settled Tennis Moneyline bets with decision-time snapshots and at least one probability source found; report is empty.'
    );
  } else if (decided === 0) {
    caveats.push('No decided (win/loss) Tennis Moneyline outcomes in scope; probability metrics are not computable.');
  } else if (decided < minSample) {
    caveats.push(
      `Sample too small (${decided} decided outcomes < ${minSample} minimum) for reliability claims; treat every metric as descriptive.`
    );
  }
  for (const source of Object.values(probabilitySources)) {
    if (source.missingProbability > 0 && decided > 0) {
      caveats.push(
        `No decision-time ${source.label.toLowerCase()} recorded for ${source.missingProbability} of ${decided} settled rows (coverage ${(source.coverage * 100).toFixed(1)}%).`
      );
    }
  }
  if (agreement === null) caveats.push('No rows with both market fair and Elo probabilities; agreement omitted.');
  if (clv === null)
    caveats.push('No recorded decision-time CLV proxy values (featureSnapshot.clvProxyPct); CLV omitted.');
  if (roi === null) caveats.push('No rows with recorded odds and stake; ROI omitted.');
  return caveats;
}

/**
 * Build the full deterministic evaluation report from a v2 ledger.
 *
 * Pure: no clock, no network, no file access, no input mutation. The output
 * is JSON-safe and byte-deterministic for a given ledger.
 *
 * @param {Object} ledger - v2 ledger (see lib/record-ledger)
 * @param {{minSample?: number}} [opts] - positive integer decided-outcome
 *   floor below which the sample is flagged insufficient (default 30)
 * @returns {Object} report document
 */
function evaluateTennisElo(ledger, opts = {}) {
  const minSample =
    opts && Number.isInteger(opts.minSample) && opts.minSample > 0 ? opts.minSample : DEFAULT_MIN_SAMPLE;
  const settledRows = joinSettledBets(ledger);
  const { included, byReason, total } = selectRows(ledger, settledRows);
  const rows = included.map(toRow).sort(chronological);

  const byOutcome = { win: 0, loss: 0, push: 0 };
  for (const row of rows) byOutcome[row.outcome] += 1;
  const decided = byOutcome.win + byOutcome.loss;

  const probabilitySources = {};
  for (const { field, label } of PROBABILITY_SOURCES) {
    probabilitySources[field] = { label, ...scoreSource(rows, field, decided) };
  }
  probabilitySources[COMBINED_FIELD] = {
    label: COMBINED_LABEL,
    formula: COMBINED_FORMULA,
    ...scoreSource(rows, COMBINED_FIELD, decided)
  };

  const agreement = computeAgreement(rows);
  const clv = computeClv(rows);
  const roi = computeRoi(rows);

  return {
    scope: {
      sport: 'tennis',
      market: 'moneyline',
      source: 'settled v2 ledger rows (decision-time featureSnapshot only)',
      includedRows: rows.length,
      excluded: { total, byReason }
    },
    sample: {
      rows: rows.length,
      byOutcome,
      decided,
      minSample,
      insufficientSample: decided < minSample
    },
    rows,
    probabilitySources,
    agreement,
    clv,
    roi,
    caveats: buildCaveats({ includedCount: rows.length, decided, minSample, probabilitySources, agreement, clv, roi })
  };
}

/**
 * Concise human report. Rows are capped at 10 so large ledgers stay readable;
 * --json prints everything.
 */
function formatHuman(report) {
  const { includedRows, excluded } = report.scope;
  const { decided, byOutcome, minSample, insufficientSample } = report.sample;
  const rows = report.rows;
  const lines = [
    'Tennis Moneyline Elo evaluation (settled v2 ledger rows only)',
    `Rows in scope: ${includedRows} (win ${byOutcome.win} / loss ${byOutcome.loss} / push ${byOutcome.push}) — decided ${decided}`,
    `Excluded: ${excluded.total} (nonTennis ${excluded.byReason.nonTennis}, nonMoneyline ${excluded.byReason.nonMoneyline}, unsettled ${excluded.byReason.unsettled}, noSnapshot ${excluded.byReason.noSnapshot}, missingProbability ${excluded.byReason.missingProbability})`
  ];
  if (insufficientSample) {
    lines.push(`WARNING: sample below the ${minSample} decided minimum — descriptive only, no reliability claim.`);
  }
  lines.push('');
  lines.push('Probability sources (Brier / log loss; calibration via --json):');
  for (const [field, source] of Object.entries(report.probabilitySources)) {
    const brier = source.brier.value === null ? 'n/a' : String(source.brier.value);
    const log = source.logLoss.value === null ? 'n/a' : source.logLoss.value.toFixed(6);
    const coverage = source.coverage === null ? 'n/a' : String(source.coverage);
    lines.push(
      `  ${field}: samples ${source.samples}/${decided} (coverage ${coverage}), Brier ${brier}, logLoss ${log}`
    );
  }
  if (report.agreement) {
    const a = report.agreement;
    lines.push(
      '',
      `Agreement (market vs Elo): ${a.pairs} pairs — agree ${a.agree}, disagree ${a.disagree} ` +
        `(decided disagreements ${a.decidedDisagreements}: market side won ${a.marketSideWon}, Elo side won ${a.eloSideWon})`
    );
  }
  if (report.clv) {
    lines.push(`Recorded CLV proxy: ${report.clv.samples} rows, mean ${report.clv.meanClvPct}%`);
  }
  if (report.roi) {
    lines.push(
      `ROI (recorded odds + stake only): ${report.roi.bets} bets, ${report.roi.wins}-${report.roi.losses}-${report.roi.pushes}, profit ${report.roi.profit}u, ROI ${report.roi.roi}%`
    );
  }
  lines.push('');
  lines.push('Rows (chronological):');
  const shown = rows.slice(0, 10);
  for (const row of shown) {
    const prob = (value) => (value === null ? '-' : String(value));
    lines.push(
      `  ${row.betId} ${row.capturedAt || row.settledAt || '?'} ${row.outcome} ` +
        `mkt ${prob(row.marketFairProbability)} model ${prob(row.modelWinProbability)} elo ${prob(row.tennisEloSelectedProbability)} comb ${prob(row.combinedProbability)}`
    );
  }
  if (rows.length > shown.length) lines.push(`  ... and ${rows.length - shown.length} more rows (see --json)`);
  lines.push('');
  lines.push('Caveats:');
  for (const caveat of report.caveats) lines.push(`- ${caveat}`);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = (Array.isArray(argv) ? argv : []).slice(2);
  const options = { ledger: null, json: false, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--ledger') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--'))
        return { ...options, parseError: 'missing value for --ledger' };
      options.ledger = value;
      i += 1;
    } else if (arg.startsWith('--ledger=')) {
      options.ledger = arg.slice('--ledger='.length);
    } else if (arg.startsWith('--')) {
      return { ...options, parseError: `unknown argument: ${arg}` };
    } else {
      return { ...options, parseError: `unexpected positional argument: ${arg}` };
    }
  }
  return options;
}

function printHelp() {
  console.log(`PropProfessor Tennis Elo evaluation

USAGE
  node scripts/backtest-tennis-elo.js [options]

OPTIONS
  --ledger <path>   v2 record ledger JSON (default: $PP_RECORD_LEDGER or
                    ~/.propprofessor/tracker/ledger.json)
  --json            Print the full report as JSON
  -h, --help        Show this help

DESCRIPTION
  Honest, reproducible descriptive evaluation of settled Tennis Moneyline
  bets from the v2 ledger. Uses only immutable decision-time
  featureSnapshot probabilities: market fair, PP model win probability,
  and Elo selected-player probability. No network, no writes, no clock.
  Empty/tiny samples return caveats; no significance or improvement
  claim is ever generated.

EXAMPLES
  node scripts/backtest-tennis-elo.js --json
  node scripts/backtest-tennis-elo.js --ledger /tmp/ledger.json
`);
}

function main(argv = process.argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return { ok: true };
  }
  if (options.parseError) {
    console.error(`backtest-tennis-elo: ${options.parseError}`);
    process.exitCode = 2;
    return { ok: false, exitCode: 2 };
  }
  const ledgerPath = options.ledger || defaultLedgerPath();
  const loaded = loadLedger({ path: ledgerPath });
  if (!loaded.ok) {
    console.error(`backtest-tennis-elo: ${loaded.error}`);
    process.exitCode = 1;
    return { ok: false, exitCode: 1 };
  }
  const report = evaluateTennisElo(loaded.ledger);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHuman(report));
  }
  return { ok: true, report };
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(`backtest-tennis-elo failed: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  PROBABILITY_SOURCES,
  COMBINED_FIELD,
  evaluateTennisElo,
  formatHuman,
  parseArgs,
  printHelp,
  main
};
