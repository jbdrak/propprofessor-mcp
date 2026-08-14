'use strict';

/**
 * Task 2.3 — honest ledger-derived tennis Elo evaluation report.
 *
 * Contract under test (scripts/backtest-tennis-elo.js):
 *   - Input is a v2 ledger (in-memory for library tests; --ledger file for
 *     CLI tests). Tests NEVER touch the real default ledger path.
 *   - Only settled Tennis Moneyline rows with an immutable decision-time
 *     featureSnapshot are included. Excluded counts/reasons:
 *     nonTennis, nonMoneyline, unsettled, noSnapshot, missingProbability.
 *   - Probability sources are scored separately and explicitly:
 *     marketFairProbability, modelWinProbability (PP model — never labeled
 *     as confidence), featureSnapshot.tennis.elo.selectedProbability.
 *     A combined probability is an arithmetic mean ONLY of explicitly
 *     present sources and only when >= 2 are present.
 *   - Reuses lib/record-evaluation (joinSettledBets) and
 *     lib/propprofessor-backtest-metrics (brierScore, logLoss,
 *     calibrationBins, computeBacktestMetrics).
 *   - No clock, no network, no file writes from the library; the CLI only
 *     reads the ledger. Deterministic byte output. Empty/tiny samples get
 *     caveats, never significance/uplift/improvement claims.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'scripts', 'backtest-tennis-elo.js');
const eloEval = require('../scripts/backtest-tennis-elo');

// ---------------------------------------------------------------------------
// Fixture helpers (synthetic only — no real user data)
// ---------------------------------------------------------------------------

function makeLedger(bets = [], settlements = []) {
  return { version: 2, scans: [], candidates: [], bets, settlements };
}

function makeBet(id, overrides = {}) {
  return {
    id,
    createdAt: '2026-08-01T12:00:00.000Z',
    capturedAt: '2026-08-01T12:00:00.000Z',
    league: 'Tennis',
    market: 'Moneyline',
    selection: 'Alcaraz',
    oddsAtDecision: -150,
    stake: 100,
    featureSnapshot: {
      schemaVersion: 1,
      capturedAt: '2026-08-01T12:00:00.000Z',
      league: 'Tennis',
      market: 'Moneyline',
      signalTier: 'TIER 1',
      confidenceTier: 'TIER 1',
      marketFairProbability: 0.6,
      modelWinProbability: 0.63,
      tennis: {
        surface: 'hard',
        tour: 'ATP',
        elo: {
          selected: { rating: 1850 },
          opponent: { rating: 1790 },
          selectedProbability: 0.64,
          modelVersion: 'elo-v1'
        },
        coverage: 'verified',
        freshness: 'fresh',
        modelVersion: 'elo-v1'
      },
      clvProxyPct: 2.5
    },
    ...overrides
  };
}

function makeSettlement(betId, status, settledAt = '2026-08-02T00:00:00.000Z', overrides = {}) {
  return { betId, status, settledAt, ...overrides };
}

function withSnapshot(bet, snapshot) {
  return { ...bet, featureSnapshot: { ...bet.featureSnapshot, ...snapshot } };
}

function withElo(bet, elo) {
  return withSnapshot(bet, { tennis: { ...bet.featureSnapshot.tennis, elo } });
}

/** Recursively check that no object key is named like a claim field. */
function assertNoClaimFields(value, pathName = '') {
  if (Array.isArray(value)) {
    for (const item of value) assertNoClaimFields(item, pathName);
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      assert.ok(
        !['significance', 'uplift', 'improvement'].includes(key.toLowerCase()),
        `report must not contain a claim field named '${key}' (at ${pathName})`
      );
      assertNoClaimFields(value[key], `${pathName}.${key}`);
    }
  }
}

function closeTo(actual, expected, tolerance = 1e-9, message = '') {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message} expected ${expected} +/- ${tolerance}, got ${actual}`
  );
}

const closeToLogLoss = (actual, expected) => closeTo(actual, expected, 1e-9, 'logLoss');

// ---------------------------------------------------------------------------
// Library: row selection and exclusions
// ---------------------------------------------------------------------------

describe('evaluateTennisElo — selection and exclusions', () => {
  it('includes only settled Tennis Moneyline rows and counts exclusions by reason', () => {
    const included = makeBet('b1'); // tennis moneyline, all probabilities present
    const nonTennis = makeBet('b2', {
      league: 'NBA',
      featureSnapshot: { ...makeBet('x').featureSnapshot, league: 'NBA' }
    });
    const nonMoneyline = makeBet('b3', {
      market: 'Spread',
      featureSnapshot: { ...makeBet('x').featureSnapshot, market: 'Spread' }
    });
    const unsettled = makeBet('b4');
    const noSnapshot = makeBet('b5', { featureSnapshot: null });
    const noProbability = makeBet('b6', {
      featureSnapshot: {
        schemaVersion: 1,
        capturedAt: '2026-08-01T12:00:00.000Z',
        league: 'Tennis',
        market: 'Moneyline',
        signalTier: 'TIER 1',
        confidenceTier: 'TIER 1'
      }
    });
    const ledger = makeLedger(
      [included, nonTennis, nonMoneyline, unsettled, noSnapshot, noProbability],
      [
        makeSettlement('b1', 'win'),
        makeSettlement('b2', 'win'),
        makeSettlement('b3', 'win'),
        makeSettlement('b4', 'pending'),
        makeSettlement('b5', 'win'),
        makeSettlement('b6', 'win')
      ]
    );
    const report = eloEval.evaluateTennisElo(ledger);
    assert.equal(report.scope.includedRows, 1);
    assert.equal(report.scope.excluded.total, 5);
    assert.deepEqual(report.scope.excluded.byReason, {
      nonTennis: 1,
      nonMoneyline: 1,
      unsettled: 1,
      noSnapshot: 1,
      missingProbability: 1
    });
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].betId, 'b1');
  });

  it('counts unsettled bets without any settlement and with non-settled statuses', () => {
    const noSettlement = makeBet('b1');
    const retired = makeBet('b2');
    const pushed = makeBet('b3');
    const ledger = makeLedger(
      [noSettlement, retired, pushed],
      [makeSettlement('b2', 'retirement'), makeSettlement('b3', 'push')]
    );
    const report = eloEval.evaluateTennisElo(ledger);
    assert.equal(report.scope.excluded.byReason.unsettled, 2);
    assert.equal(report.scope.includedRows, 1);
    assert.equal(report.sample.byOutcome.push, 1);
  });

  it('excludes rows without a decision-time featureSnapshot even when the settlement carries one', () => {
    const bet = makeBet('b1', { featureSnapshot: null });
    const settlement = makeSettlement('b1', 'win', '2026-08-02T00:00:00.000Z', {
      featureSnapshot: { schemaVersion: 1, marketFairProbability: 0.9 }
    });
    const report = eloEval.evaluateTennisElo(makeLedger([bet], [settlement]));
    assert.equal(report.scope.excluded.byReason.noSnapshot, 1);
    assert.equal(report.scope.includedRows, 0);
  });

  it('sorts rows chronologically by capturedAt with settledAt fallback and deterministic ties', () => {
    const late = makeBet('b1', {
      capturedAt: '2026-08-03T12:00:00.000Z',
      createdAt: '2026-08-03T12:00:00.000Z',
      featureSnapshot: { ...makeBet('x').featureSnapshot, capturedAt: '2026-08-03T12:00:00.000Z' }
    });
    const early = makeBet('b2', {
      capturedAt: '2026-08-01T12:00:00.000Z',
      createdAt: '2026-08-01T12:00:00.000Z',
      featureSnapshot: { ...makeBet('x').featureSnapshot, capturedAt: '2026-08-01T12:00:00.000Z' }
    });
    const middle = makeBet('b3', {
      capturedAt: '2026-08-02T12:00:00.000Z',
      createdAt: '2026-08-02T12:00:00.000Z',
      featureSnapshot: { ...makeBet('x').featureSnapshot, capturedAt: '2026-08-02T12:00:00.000Z' }
    });
    const tieA = makeBet('b4', {
      capturedAt: '2026-08-04T12:00:00.000Z',
      featureSnapshot: { ...makeBet('x').featureSnapshot, capturedAt: '2026-08-04T12:00:00.000Z' }
    });
    const tieB = makeBet('b5', {
      capturedAt: '2026-08-04T12:00:00.000Z',
      featureSnapshot: { ...makeBet('x').featureSnapshot, capturedAt: '2026-08-04T12:00:00.000Z' }
    });
    const noCaptured = makeBet('b6', {
      createdAt: null,
      capturedAt: null,
      featureSnapshot: { ...makeBet('x').featureSnapshot, capturedAt: null }
    });
    const ledger = makeLedger(
      [late, early, middle, tieB, tieA, noCaptured],
      [
        makeSettlement('b1', 'win', '2026-08-05T00:00:00.000Z'),
        makeSettlement('b2', 'win', '2026-08-02T00:00:00.000Z'),
        makeSettlement('b3', 'win', '2026-08-03T00:00:00.000Z'),
        makeSettlement('b4', 'win', '2026-08-06T00:00:00.000Z'),
        makeSettlement('b5', 'win', '2026-08-06T00:00:00.000Z'),
        // settledAt fallback for the row with no capturedAt at all.
        makeSettlement('b6', 'win', '2026-08-01T00:00:00.000Z')
      ]
    );
    const report = eloEval.evaluateTennisElo(ledger);
    assert.deepEqual(
      report.rows.map((r) => r.betId),
      ['b6', 'b2', 'b3', 'b1', 'b4', 'b5']
    );
  });
});

// ---------------------------------------------------------------------------
// Library: probability scoring (per-source, no substitution, no backfill)
// ---------------------------------------------------------------------------

describe('evaluateTennisElo — probability sources', () => {
  it('scores each explicit probability source separately with samples, coverage, Brier, log loss, calibration', () => {
    const a1 = withSnapshot(makeBet('a1'), {
      capturedAt: '2026-08-01T12:00:00.000Z',
      marketFairProbability: 0.75,
      modelWinProbability: 0.8,
      tennis: {
        ...makeBet('x').featureSnapshot.tennis,
        elo: { ...makeBet('x').featureSnapshot.tennis.elo, selectedProbability: 0.7 }
      }
    });
    const a2 = withSnapshot(makeBet('a2'), {
      capturedAt: '2026-08-02T12:00:00.000Z',
      marketFairProbability: 0.4,
      modelWinProbability: 0.35,
      tennis: {
        ...makeBet('x').featureSnapshot.tennis,
        elo: { ...makeBet('x').featureSnapshot.tennis.elo, selectedProbability: 0.45 }
      }
    });
    const a3 = withSnapshot(makeBet('a3'), {
      capturedAt: '2026-08-03T12:00:00.000Z',
      marketFairProbability: 0.5,
      modelWinProbability: 0.55,
      tennis: {
        ...makeBet('x').featureSnapshot.tennis,
        elo: { ...makeBet('x').featureSnapshot.tennis.elo, selectedProbability: 0.52 }
      }
    });
    const ledger = makeLedger(
      [a1, a2, a3],
      [
        makeSettlement('a1', 'win', '2026-08-02T00:00:00.000Z'),
        makeSettlement('a2', 'loss', '2026-08-03T00:00:00.000Z'),
        makeSettlement('a3', 'win', '2026-08-04T00:00:00.000Z')
      ]
    );
    const report = eloEval.evaluateTennisElo(ledger);
    assert.equal(report.sample.decided, 3);
    const sources = report.probabilitySources;
    assert.deepEqual(Object.keys(sources).sort(), [
      'combinedProbability',
      'marketFairProbability',
      'modelWinProbability',
      'tennisEloSelectedProbability'
    ]);

    const market = sources.marketFairProbability;
    assert.equal(market.samples, 3);
    assert.equal(market.coverage, 1);
    assert.equal(market.missingProbability, 0);
    assert.equal(market.brier.value, 0.1575);
    assert.equal(market.brier.samples, 3);
    closeToLogLoss(market.logLoss.value, 0.497218); // round6-stable (like Brier)
    assert.ok(market.calibration.length >= 1);
    assert.equal(
      market.calibration.reduce((s, b) => s + b.samples, 0),
      3
    );

    const model = sources.modelWinProbability;
    assert.equal(model.samples, 3);
    assert.equal(model.brier.value, 0.121667);
    closeToLogLoss(model.logLoss.value, 0.417254); // round6-stable (like Brier)

    const elo = sources.tennisEloSelectedProbability;
    assert.equal(elo.samples, 3);
    assert.equal(elo.brier.value, 0.1743);
    closeToLogLoss(elo.logLoss.value, 0.536146); // round6-stable (like Brier)

    const combined = sources.combinedProbability;
    assert.equal(combined.samples, 3);
    assert.equal(combined.brier.value, 0.149904);
    // Combined row probabilities are rounded to 6 dp in the report and the
    // metrics run on those rounded values: rows [0.75, 0.4, 0.523333].
    closeToLogLoss(combined.logLoss.value, 0.4820150008228475);
    assert.match(combined.formula, /arithmetic mean/i);
  });

  it('labels sources explicitly: market fair probability, PP model (not confidence), Elo', () => {
    const report = eloEval.evaluateTennisElo(makeLedger([makeBet('b1')], [makeSettlement('b1', 'win')]));
    const sources = report.probabilitySources;
    assert.match(sources.marketFairProbability.label, /market fair/i);
    assert.match(sources.modelWinProbability.label, /model/i);
    assert.doesNotMatch(sources.modelWinProbability.label, /confidence/i);
    assert.match(sources.tennisEloSelectedProbability.label, /elo/i);
  });

  it('reads Elo probability only from the immutable decision-time snapshot — no backfill, no leakage', () => {
    // Earlier row: Elo ratings recorded but NO selectedProbability at decision time.
    const earlier = withElo(makeBet('e1'), {
      selected: { rating: 1850 },
      opponent: { rating: 1790 }
    });
    // Later row: full Elo probability present.
    const later = makeBet('e2', {
      capturedAt: '2026-08-02T12:00:00.000Z',
      featureSnapshot: {
        ...makeBet('x').featureSnapshot,
        capturedAt: '2026-08-02T12:00:00.000Z',
        marketFairProbability: null, // market absent here — must not borrow row 1's value
        modelWinProbability: 0.63,
        tennis: { ...makeBet('x').featureSnapshot.tennis }
      }
    });
    const ledger = makeLedger(
      [earlier, later],
      [makeSettlement('e1', 'win', '2026-08-03T00:00:00.000Z'), makeSettlement('e2', 'win', '2026-08-04T00:00:00.000Z')]
    );
    const report = eloEval.evaluateTennisElo(ledger);
    assert.equal(report.rows[0].tennisEloSelectedProbability, null);
    assert.equal(report.rows[1].tennisEloSelectedProbability, 0.64);
    const elo = report.probabilitySources.tennisEloSelectedProbability;
    assert.equal(elo.samples, 1);
    assert.equal(elo.coverage, 0.5);
    assert.equal(elo.missingProbability, 1);
    // Market coverage is independent: row 2 lacks market, row 1 has it.
    const market = report.probabilitySources.marketFairProbability;
    assert.equal(market.samples, 1);
    assert.equal(market.missingProbability, 1);
  });

  it('combines probabilities as an arithmetic mean only of explicitly present sources (>= 2)', () => {
    const all = withSnapshot(makeBet('c1'), {
      marketFairProbability: 0.75,
      modelWinProbability: 0.8,
      tennis: {
        ...makeBet('x').featureSnapshot.tennis,
        elo: { ...makeBet('x').featureSnapshot.tennis.elo, selectedProbability: 0.7 }
      }
    });
    const two = withSnapshot(makeBet('c2'), {
      marketFairProbability: 0.4,
      modelWinProbability: null,
      tennis: {
        ...makeBet('x').featureSnapshot.tennis,
        elo: { ...makeBet('x').featureSnapshot.tennis.elo, selectedProbability: 0.45 }
      }
    });
    const one = withSnapshot(makeBet('c3'), {
      marketFairProbability: null,
      modelWinProbability: 0.55,
      tennis: {
        ...makeBet('x').featureSnapshot.tennis,
        elo: { ...makeBet('x').featureSnapshot.tennis.elo, selectedProbability: null }
      }
    });
    const ledger = makeLedger(
      [all, two, one],
      [makeSettlement('c1', 'win'), makeSettlement('c2', 'loss'), makeSettlement('c3', 'win')]
    );
    const report = eloEval.evaluateTennisElo(ledger);
    assert.equal(report.rows[0].combinedProbability, 0.75); // (0.75 + 0.8 + 0.7) / 3
    assert.equal(report.rows[1].combinedProbability, 0.425); // (0.4 + 0.45) / 2
    assert.equal(report.rows[2].combinedProbability, null); // only one explicit source
    assert.equal(report.probabilitySources.combinedProbability.samples, 2);
  });

  it('reports descriptive agreement/disagreement only when market and Elo both exist', () => {
    const r1 = withSnapshot(makeBet('d1'), {
      marketFairProbability: 0.6,
      tennis: {
        ...makeBet('x').featureSnapshot.tennis,
        elo: { ...makeBet('x').featureSnapshot.tennis.elo, selectedProbability: 0.65 }
      }
    });
    const r2 = withSnapshot(makeBet('d2'), {
      marketFairProbability: 0.55,
      tennis: {
        ...makeBet('x').featureSnapshot.tennis,
        elo: { ...makeBet('x').featureSnapshot.tennis.elo, selectedProbability: 0.45 }
      }
    });
    const r3 = withSnapshot(makeBet('d3'), {
      marketFairProbability: 0.3,
      tennis: {
        ...makeBet('x').featureSnapshot.tennis,
        elo: { ...makeBet('x').featureSnapshot.tennis.elo, selectedProbability: 0.7 }
      }
    });
    const r4 = withSnapshot(makeBet('d4'), {
      marketFairProbability: 0.6,
      tennis: {
        ...makeBet('x').featureSnapshot.tennis,
        elo: { ...makeBet('x').featureSnapshot.tennis.elo, selectedProbability: null }
      }
    });
    const ledger = makeLedger(
      [r1, r2, r3, r4],
      [
        makeSettlement('d1', 'win'),
        makeSettlement('d2', 'loss'),
        makeSettlement('d3', 'push'),
        makeSettlement('d4', 'win')
      ]
    );
    const report = eloEval.evaluateTennisElo(ledger);
    assert.deepEqual(report.agreement, {
      pairs: 3,
      agree: 1,
      disagree: 2,
      decidedDisagreements: 1,
      marketSideWon: 0,
      eloSideWon: 1,
      agreePct: 0.333333
    });
  });

  it('aggregates recorded CLV proxy only where explicitly present', () => {
    const withClv = (id, value) => withSnapshot(makeBet(id), { clvProxyPct: value });
    const ledger = makeLedger(
      [withClv('f1', 2.5), withClv('f2', -1.0), withClv('f3', null)],
      [makeSettlement('f1', 'win'), makeSettlement('f2', 'loss'), makeSettlement('f3', 'win')]
    );
    const report = eloEval.evaluateTennisElo(ledger);
    assert.deepEqual(report.clv, { samples: 2, meanClvPct: 0.75 });

    const none = eloEval.evaluateTennisElo(makeLedger([withClv('f4', null)], [makeSettlement('f4', 'win')]));
    assert.equal(none.clv, null);
  });

  it('computes ROI only where actual odds and stake are recorded', () => {
    const priced = makeBet('g1', { oddsAtDecision: -150, stake: 100 });
    const priced2 = makeBet('g2', { oddsAtDecision: -110, stake: 50 });
    const unpriced = makeBet('g3', { oddsAtDecision: null, stake: null });
    const ledger = makeLedger(
      [priced, priced2, unpriced],
      [makeSettlement('g1', 'win'), makeSettlement('g2', 'loss'), makeSettlement('g3', 'loss')]
    );
    const report = eloEval.evaluateTennisElo(ledger);
    assert.ok(report.roi);
    assert.equal(report.roi.bets, 2);
    assert.equal(report.roi.wins, 1);
    assert.equal(report.roi.losses, 1);
    assert.equal(report.roi.pushes, 0);
    assert.equal(report.roi.winRate, 50);
    assert.equal(report.roi.profit, 16.67); // 100 * 100/150 - 50
    assert.equal(report.roi.roi, 11.1); // 16.666.../150 * 100

    const none = eloEval.evaluateTennisElo(makeLedger([unpriced], [makeSettlement('g3', 'loss')]));
    assert.equal(none.roi, null);
  });
});

// ---------------------------------------------------------------------------
// Library: empty/tiny samples, caveats, determinism
// ---------------------------------------------------------------------------

describe('evaluateTennisElo — caveats and determinism', () => {
  it('returns a JSON-safe caveated report for an empty ledger with no claim fields', () => {
    const report = eloEval.evaluateTennisElo(makeLedger());
    assert.equal(report.scope.includedRows, 0);
    assert.equal(report.scope.excluded.total, 0);
    assert.equal(report.sample.rows, 0);
    assert.equal(report.sample.decided, 0);
    assert.equal(report.sample.insufficientSample, true);
    assert.ok(report.caveats.length >= 1);
    for (const source of Object.values(report.probabilitySources)) {
      assert.equal(source.samples, 0);
      assert.equal(source.brier.value, null);
      assert.equal(source.logLoss.value, null);
      assert.deepEqual(source.calibration, []);
    }
    assert.equal(report.agreement, null);
    assert.equal(report.clv, null);
    assert.equal(report.roi, null);
    assertNoClaimFields(report);
    // JSON-safe: round-trips without loss.
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  });

  it('adds caveats on tiny samples and never claims significance or improvement', () => {
    const ledger = makeLedger(
      [makeBet('h1'), makeBet('h2')],
      [makeSettlement('h1', 'win'), makeSettlement('h2', 'loss')]
    );
    const report = eloEval.evaluateTennisElo(ledger);
    assert.equal(report.sample.decided, 2);
    assert.equal(report.sample.insufficientSample, true);
    assert.ok(report.caveats.some((c) => /too small|minimum/i.test(c)));
    assert.ok(report.caveats.some((c) => /descriptive/i.test(c)));
    assertNoClaimFields(report);
  });

  it('produces byte-identical output across calls and ledger clones', () => {
    const ledger = makeLedger(
      [makeBet('i1'), makeBet('i2', { capturedAt: '2026-08-02T12:00:00.000Z' })],
      [makeSettlement('i1', 'win'), makeSettlement('i2', 'loss')]
    );
    const first = JSON.stringify(eloEval.evaluateTennisElo(ledger));
    const clone = JSON.parse(JSON.stringify(ledger));
    const second = JSON.stringify(eloEval.evaluateTennisElo(clone));
    const third = JSON.stringify(eloEval.evaluateTennisElo(ledger));
    assert.equal(second, first);
    assert.equal(third, first);
  });

  it('formats a concise caveated human report', () => {
    const report = eloEval.evaluateTennisElo(makeLedger([makeBet('j1')], [makeSettlement('j1', 'win')]));
    const human = eloEval.formatHuman(report);
    assert.match(human, /Tennis Moneyline/i);
    assert.match(human, /Caveats/i);
    assert.match(human, /descriptive/i);
    assert.ok(human.length < 2000, 'human output must stay concise');
  });
});

// ---------------------------------------------------------------------------
// CLI: --ledger / --json / --help; temp-only files; exit codes
// ---------------------------------------------------------------------------

describe('backtest-tennis-elo CLI', () => {
  let tmpRoot;
  let ledgerPath;
  const fixtureLedger = makeLedger(
    [makeBet('k1'), makeBet('k2', { capturedAt: '2026-08-02T12:00:00.000Z' })],
    [makeSettlement('k1', 'win'), makeSettlement('k2', 'loss')]
  );

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-tennis-elo-'));
    ledgerPath = path.join(tmpRoot, 'ledger.json');
    fs.writeFileSync(ledgerPath, JSON.stringify(fixtureLedger, null, 2));
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function runCli(args, options = {}) {
    return execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...options.env },
      ...options
    });
  }

  it('--help prints usage and exits 0', () => {
    const stdout = runCli(['--help']);
    assert.match(stdout, /USAGE/);
    assert.match(stdout, /--ledger/);
    assert.match(stdout, /--json/);
  });

  it('--json with a temp --ledger file prints the same report as the library', () => {
    const stdout = runCli(['--ledger', ledgerPath, '--json']);
    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed, eloEval.evaluateTennisElo(fixtureLedger));
  });

  it('honors the PP_RECORD_LEDGER default when --ledger is absent', () => {
    const stdout = runCli(['--json'], { env: { PP_RECORD_LEDGER: ledgerPath } });
    assert.deepEqual(JSON.parse(stdout), eloEval.evaluateTennisElo(fixtureLedger));
  });

  it('a nonexistent --ledger path yields an empty caveated report (fresh-ledger convention)', () => {
    const missing = path.join(tmpRoot, 'does-not-exist.json');
    const stdout = runCli(['--ledger', missing, '--json']);
    const report = JSON.parse(stdout);
    assert.equal(report.scope.includedRows, 0);
    assert.ok(report.caveats.length >= 1);
  });

  it('missing --ledger value is a usage error with exit code 2', () => {
    assert.throws(
      () => runCli(['--ledger']),
      (error) => error.status === 2
    );
  });

  it('invalid ledger JSON is a ledger error with exit code 1', () => {
    const bad = path.join(tmpRoot, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    assert.throws(
      () => runCli(['--ledger', bad, '--json']),
      (error) => error.status === 1 && /ledger/i.test(error.stderr || error.stdout || '')
    );
  });

  it('human mode reads the same temp ledger without touching the real default', () => {
    const stdout = runCli(['--ledger', ledgerPath]);
    assert.match(stdout, /Tennis Moneyline/i);
    assert.match(stdout, /k1/);
  });
});
