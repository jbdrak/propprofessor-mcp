'use strict';

/**
 * Direct tests for lib/propprofessor-validation-pipeline.js (plan Task 4.1).
 *
 * The pipeline is the shared validation core extracted from scripts/server/handlers.js
 * (quick_screen and recommended_bets). These tests exercise it in isolation with
 * fake validate/apply functions — no PropProfessor client, no network.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  runValidationPipeline,
  selectTopGlobal,
  selectTopPerBucket
} = require('../lib/propprofessor-validation-pipeline');

/** Minimal row shaped like a quick_screen candidate / recommended play. */
function makeRow(overrides = {}) {
  return {
    gameId: 'NBA:g1',
    selection: 'Lakers ML',
    market: 'Moneyline',
    kaiCall: 'BET',
    screenScore: 80,
    altLineFiltered: false,
    ...overrides
  };
}

/** Minimal injected applyValidated: records the validation object it received. */
function recordApply() {
  const applied = [];
  return {
    applied,
    fn: (target, validation) => {
      target.appliedValidation = validation;
      target._validated = true;
      applied.push({ target, validation });
    }
  };
}

/** Fake concurrency mapper that records the concurrency option. */
function makeMapWithConcurrency() {
  const state = { concurrency: null, called: 0 };
  state.fn = async (items, worker, opts) => {
    state.called += 1;
    state.concurrency = opts && opts.concurrency;
    const out = [];
    for (let i = 0; i < items.length; i += 1) out.push(await worker(items[i], i));
    return out;
  };
  return state;
}

/** A validator response that blesses a row as BET / TIER 1 (unwrapped). */
function validatorResponse(overrides = {}) {
  return {
    ok: true,
    verdict: 'BET',
    tier: 'TIER 1',
    verdictSummary: { displayTier: 'BET', movementDisposition: 'supportive_clean' },
    play: { consensusBookCount: 9 },
    ...overrides
  };
}

describe('runValidationPipeline', () => {
  it('validates every eligible row with validateAll and returns metadata', async () => {
    const rows = [
      { target: makeRow({ gameId: 'NBA:g1' }), entry: { league: 'NBA', market: 'Moneyline' } },
      { target: makeRow({ gameId: 'NBA:g2' }), entry: { league: 'NBA', market: 'Moneyline' } }
    ];
    const validateCalls = [];
    const apply = recordApply();
    const mapState = makeMapWithConcurrency();
    const result = await runValidationPipeline({
      validate: async (args) => {
        validateCalls.push(args);
        return validatorResponse();
      },
      buildArgs: (t, entry) => ({ league: entry.league, gameId: t.gameId, selection: t.selection }),
      buildCacheKey: (t, entry) => `${t.gameId}::${t.selection}::${entry.market}`,
      rows,
      isEligible: (t) => Boolean(t.gameId && t.selection && !t.altLineFiltered),
      isBet: (t) => t.kaiCall === 'BET',
      selectTargets: selectTopGlobal,
      onNotSelected: () => assert.fail('no rows should be marked not-selected'),
      applyValidated: apply.fn,
      validateAll: true,
      validateTop: 10,
      mapWithConcurrency: mapState.fn
    });

    assert.equal(validateCalls.length, 2);
    assert.equal(apply.applied.length, 2);
    assert.ok(rows.every(({ target }) => target._validated === true));
    assert.deepEqual(result, { eligibleCount: 2, selectedCount: 2, partial: false });
    assert.equal(mapState.concurrency, 5, 'default concurrency must be 5');
  });

  it('keeps one cache entry per gameId::selection::market key while validating each same-key row (byte-identical sync fan-out)', async () => {
    // The original handler loop creates every validation promise synchronously
    // (the cache is only populated after an await), so two rows sharing a key
    // each get their own validate call — verified against the pre-refactor
    // handler. What the key DOES guarantee is identity: identical rows share a
    // key slot and opposing Over/Under rows never collide (see next test).
    const rows = [
      { target: makeRow({ gameId: 'NBA:g1' }), entry: { league: 'NBA', market: 'Moneyline' } },
      { target: makeRow({ gameId: 'NBA:g1' }), entry: { league: 'NBA', market: 'Moneyline' } }
    ];
    const keys = [];
    const validateCalls = [];
    const apply = recordApply();
    const result = await runValidationPipeline({
      validate: async () => {
        validateCalls.push(1);
        return validatorResponse();
      },
      buildArgs: () => ({}),
      buildCacheKey: (t, entry) => {
        const key = `${t.gameId}::${t.selection}::${entry.market}`;
        keys.push(key);
        return key;
      },
      rows,
      isEligible: (t) => Boolean(t.gameId && t.selection && !t.altLineFiltered),
      isBet: (t) => t.kaiCall === 'BET',
      selectTargets: selectTopGlobal,
      onNotSelected: () => assert.fail(),
      applyValidated: apply.fn,
      validateAll: true,
      validateTop: 10,
      mapWithConcurrency: makeMapWithConcurrency().fn
    });

    assert.deepEqual(
      keys,
      ['NBA:g1::Lakers ML::Moneyline', 'NBA:g1::Lakers ML::Moneyline'],
      'key identity must be gameId::selection::market'
    );
    assert.equal(
      validateCalls.length,
      2,
      'each same-key row is validated independently, exactly like the original sync loop'
    );
    assert.equal(apply.applied.length, 2, 'both rows must receive the validated fields');
    assert.ok(rows.every(({ target }) => target._validated === true));
    assert.equal(result.partial, false);
  });

  it('keeps Over and Under on the same game as separate cache entries', async () => {
    const rows = [
      {
        target: makeRow({ gameId: 'NBA:g1', selection: 'Over 220.5', market: 'Total Points' }),
        entry: { league: 'NBA', market: 'Total Points' }
      },
      {
        target: makeRow({ gameId: 'NBA:g1', selection: 'Under 220.5', market: 'Total Points' }),
        entry: { league: 'NBA', market: 'Total Points' }
      }
    ];
    const selectionsValidated = [];
    const apply = recordApply();
    await runValidationPipeline({
      validate: async (args) => {
        selectionsValidated.push(args.selection);
        return validatorResponse();
      },
      buildArgs: (t, entry) => ({ league: entry.league, gameId: t.gameId, selection: t.selection }),
      buildCacheKey: (t, entry) => `${t.gameId}::${t.selection}::${entry.market}`,
      rows,
      isEligible: (t) => Boolean(t.gameId && t.selection && !t.altLineFiltered),
      isBet: (t) => t.kaiCall === 'BET',
      selectTargets: selectTopGlobal,
      onNotSelected: () => assert.fail(),
      applyValidated: apply.fn,
      validateAll: true,
      validateTop: 10,
      mapWithConcurrency: makeMapWithConcurrency().fn
    });

    assert.deepEqual([...selectionsValidated].sort(), ['Over 220.5', 'Under 220.5']);
    assert.equal(apply.applied.length, 2);
  });

  it('normalizes a wrapped result (result.data carrying verdictSummary) before applyValidated', async () => {
    const rows = [{ target: makeRow(), entry: { league: 'NBA', market: 'Moneyline' } }];
    const dataPayload = validatorResponse({ verdict: 'CONSIDER', tier: 'TIER 3' });
    const apply = recordApply();
    await runValidationPipeline({
      validate: async () => ({ ok: true, data: dataPayload }),
      buildArgs: () => ({}),
      buildCacheKey: () => 'k',
      rows,
      isEligible: (t) => Boolean(t.gameId && t.selection && !t.altLineFiltered),
      isBet: (t) => t.kaiCall === 'BET',
      selectTargets: selectTopGlobal,
      onNotSelected: () => assert.fail(),
      applyValidated: apply.fn,
      validateAll: true,
      validateTop: 10,
      mapWithConcurrency: makeMapWithConcurrency().fn
    });

    assert.equal(apply.applied.length, 1);
    assert.equal(apply.applied[0].validation, dataPayload, 'applyValidated must receive the unwrapped data payload');
    assert.equal(rows[0].target._validated, true);
  });

  it('marks validationFailed when the result is invalid (no verdictSummary)', async () => {
    const rows = [{ target: makeRow(), entry: { league: 'NBA', market: 'Moneyline' } }];
    await runValidationPipeline({
      validate: async () => ({ ok: true }),
      buildArgs: () => ({}),
      buildCacheKey: () => 'k',
      rows,
      isEligible: (t) => Boolean(t.gameId && t.selection && !t.altLineFiltered),
      isBet: (t) => t.kaiCall === 'BET',
      selectTargets: selectTopGlobal,
      onNotSelected: () => assert.fail(),
      applyValidated: () => assert.fail('applyValidated must not run for an invalid result'),
      validateAll: true,
      validateTop: 10,
      mapWithConcurrency: makeMapWithConcurrency().fn
    });

    assert.equal(rows[0].target.validationFailed, true);
    assert.equal(rows[0].target._validated, undefined);
  });

  it('marks validationFailed when the validator throws', async () => {
    const rows = [{ target: makeRow(), entry: { league: 'NBA', market: 'Moneyline' } }];
    await runValidationPipeline({
      validate: async () => {
        throw new Error('backend exploded');
      },
      buildArgs: () => ({}),
      buildCacheKey: () => 'k',
      rows,
      isEligible: (t) => Boolean(t.gameId && t.selection && !t.altLineFiltered),
      isBet: (t) => t.kaiCall === 'BET',
      selectTargets: selectTopGlobal,
      onNotSelected: () => assert.fail(),
      applyValidated: () => assert.fail(),
      validateAll: true,
      validateTop: 10,
      mapWithConcurrency: makeMapWithConcurrency().fn
    });

    assert.equal(rows[0].target.validationFailed, true);
    assert.equal(rows[0].target.validationFailureReason, 'backend exploded');
  });

  it('degrades on timeout and clears every timer it created', async () => {
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    const activeTimers = new Set();
    global.setTimeout = (fn, ms, ...rest) => {
      const id = realSetTimeout(fn, ms, ...rest);
      activeTimers.add(id);
      return id;
    };
    global.clearTimeout = (id) => {
      activeTimers.delete(id);
      realClearTimeout(id);
    };

    try {
      const rows = [{ target: makeRow(), entry: { league: 'NBA', market: 'Moneyline' } }];
      await runValidationPipeline({
        // Never settles — the timeout race must win.
        validate: () => new Promise(() => {}),
        buildArgs: () => ({}),
        buildCacheKey: () => 'k',
        rows,
        isEligible: (t) => Boolean(t.gameId && t.selection && !t.altLineFiltered),
        isBet: (t) => t.kaiCall === 'BET',
        selectTargets: selectTopGlobal,
        onNotSelected: () => assert.fail(),
        applyValidated: () => assert.fail('a timed-out row must not be applied as validated'),
        validateAll: true,
        validateTop: 10,
        timeoutMs: 20,
        mapWithConcurrency: makeMapWithConcurrency().fn
      });

      assert.equal(rows[0].target.validationFailed, true, 'timeout must degrade to validationFailed');
      assert.match(rows[0].target.validationFailureReason, /Validation timeout for NBA:g1:Lakers ML/);
      assert.equal(activeTimers.size, 0, 'no timer may survive the pipeline run');
    } finally {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    }
  });

  it('skips ineligible rows (missing ids / altLineFiltered) without validating them', async () => {
    const rows = [
      { target: makeRow({ gameId: 'NBA:g1' }), entry: { league: 'NBA', market: 'Moneyline' } },
      { target: makeRow({ gameId: null }), entry: { league: 'NBA', market: 'Moneyline' } },
      { target: makeRow({ selection: '' }), entry: { league: 'NBA', market: 'Moneyline' } },
      { target: makeRow({ altLineFiltered: true }), entry: { league: 'NBA', market: 'Moneyline' } }
    ];
    const validateCalls = [];
    const apply = recordApply();
    // Ineligible BET rows sit outside the selected set, so they hit the
    // onNotSelected marking path exactly like the original loop (mark BEFORE
    // the eligibility check) — they just never reach the validator.
    const notSelected = [];
    await runValidationPipeline({
      validate: async (args) => {
        validateCalls.push(args);
        return validatorResponse();
      },
      buildArgs: (t) => ({ gameId: t.gameId, selection: t.selection }),
      buildCacheKey: (t) => `${t.gameId}::${t.selection}`,
      rows,
      isEligible: (t) => Boolean(t.gameId && t.selection && !t.altLineFiltered),
      isBet: (t) => t.kaiCall === 'BET',
      selectTargets: selectTopGlobal,
      onNotSelected: (target) => notSelected.push(target),
      applyValidated: apply.fn,
      validateAll: true,
      validateTop: 10,
      mapWithConcurrency: makeMapWithConcurrency().fn
    });

    assert.equal(validateCalls.length, 1, 'only the eligible row may reach the validator');
    assert.equal(apply.applied.length, 1);
    assert.equal(rows[0].target._validated, true);
    assert.equal(rows[1].target._validated, undefined);
    assert.equal(rows[2].target._validated, undefined);
    assert.equal(rows[3].target._validated, undefined);
    assert.deepEqual(
      notSelected.map((t) => t.gameId),
      [null, 'NBA:g1', 'NBA:g1'],
      'the three ineligible BET rows are marked not-selected (null gameId, empty selection, altLineFiltered)'
    );
  });

  it('marks non-selected BET rows through onNotSelected when validateTop limits selection', async () => {
    const rows = [
      {
        target: makeRow({ gameId: 'NBA:g1', kaiCall: 'BET', screenScore: 90 }),
        entry: { league: 'NBA', market: 'Moneyline' }
      },
      {
        target: makeRow({ gameId: 'NBA:g2', kaiCall: 'BET', screenScore: 10 }),
        entry: { league: 'NBA', market: 'Moneyline' }
      },
      {
        target: makeRow({ gameId: 'NBA:g3', kaiCall: 'CONSIDER', screenScore: 5 }),
        entry: { league: 'NBA', market: 'Moneyline' }
      }
    ];
    const validateCalls = [];
    const notSelected = [];
    const apply = recordApply();
    const result = await runValidationPipeline({
      validate: async () => {
        validateCalls.push(1);
        return validatorResponse();
      },
      buildArgs: () => ({}),
      buildCacheKey: (t) => `${t.gameId}::${t.selection}`,
      rows,
      isEligible: (t) => Boolean(t.gameId && t.selection && !t.altLineFiltered),
      isBet: (t) => t.kaiCall === 'BET',
      selectTargets: selectTopGlobal,
      onNotSelected: (target) => notSelected.push(target),
      applyValidated: apply.fn,
      validateAll: false,
      validateTop: 1,
      mapWithConcurrency: makeMapWithConcurrency().fn
    });

    assert.equal(validateCalls.length, 1, 'validateTop:1 must validate exactly one row');
    assert.equal(notSelected.length, 1, 'exactly one BET row must fall outside the budget');
    assert.equal(notSelected[0].gameId, 'NBA:g2', 'the lower-screenScore BET is the one left out');
    assert.equal(apply.applied.length, 1);
    assert.deepEqual(result, { eligibleCount: 2, selectedCount: 1, partial: true });
  });

  it('passes a custom concurrency to mapWithConcurrency', async () => {
    const rows = [{ target: makeRow(), entry: { league: 'NBA', market: 'Moneyline' } }];
    const mapState = makeMapWithConcurrency();
    await runValidationPipeline({
      validate: async () => validatorResponse(),
      buildArgs: () => ({}),
      buildCacheKey: () => 'k',
      rows,
      isEligible: () => true,
      isBet: () => true,
      selectTargets: selectTopGlobal,
      onNotSelected: () => {},
      applyValidated: () => {},
      validateAll: true,
      validateTop: 10,
      concurrency: 3,
      mapWithConcurrency: mapState.fn
    });
    assert.equal(mapState.concurrency, 3);
  });

  it('supports the recommended_bets adapter shape (per-bucket top N over full buckets)', async () => {
    const nba = { league: 'NBA' };
    const wnba = { league: 'WNBA' };
    const rows = [
      { target: makeRow({ gameId: 'NBA:g1', screenScore: 90 }), entry: nba },
      { target: makeRow({ gameId: 'NBA:g2', screenScore: 10 }), entry: nba },
      { target: makeRow({ gameId: 'WNBA:g1', screenScore: 50 }), entry: wnba },
      { target: makeRow({ gameId: 'WNBA:g2', screenScore: 40 }), entry: wnba }
    ];
    const validateCalls = [];
    await runValidationPipeline({
      validate: async () => {
        validateCalls.push(1);
        return validatorResponse();
      },
      buildArgs: (t, entry) => ({ league: entry.league, gameId: t.gameId }),
      buildCacheKey: (t) => `${t.gameId}::${t.selection}`,
      rows,
      isEligible: (t) => Boolean(t.gameId && t.selection && !t.altLineFiltered),
      isBet: (t) => t.kaiCall === 'BET',
      selectTargets: selectTopPerBucket,
      onNotSelected: () => {},
      applyValidated: () => {},
      validateAll: false,
      validateTop: 1,
      mapWithConcurrency: makeMapWithConcurrency().fn
    });

    assert.equal(validateCalls.length, 2, 'per-bucket top-1 must validate one row per bucket');
  });
});

describe('selectTopGlobal (quick_screen selection strategy)', () => {
  const isBet = (t) => t.kaiCall === 'BET';

  it('prioritizes BET candidates, then screenScore, sliced to validateTop', () => {
    const rows = [
      { target: makeRow({ gameId: 'NBA:g1', kaiCall: 'CONSIDER', screenScore: 99 }), entry: {} },
      { target: makeRow({ gameId: 'NBA:g2', kaiCall: 'BET', screenScore: 60 }), entry: {} },
      { target: makeRow({ gameId: 'NBA:g3', kaiCall: 'BET', screenScore: 80 }), entry: {} },
      { target: makeRow({ gameId: 'NBA:g4', kaiCall: 'PASS', screenScore: 100 }), entry: {} }
    ];
    const selected = selectTopGlobal({ rows, eligible: rows, validateAll: false, validateTop: 2, isBet });
    assert.deepEqual(
      selected.map((t) => t.gameId),
      ['NBA:g3', 'NBA:g2'],
      'BETs first (screenScore 80 > 60), PASS/CONSIDER excluded by the slice'
    );
  });

  it('returns every eligible row when validateAll', () => {
    const rows = [
      { target: makeRow({ gameId: 'NBA:g1' }), entry: {} },
      { target: makeRow({ gameId: 'NBA:g2' }), entry: {} }
    ];
    const selected = selectTopGlobal({ rows, eligible: rows, validateAll: true, validateTop: 1, isBet });
    assert.equal(selected.length, 2);
  });

  it('selects only from the eligible subset', () => {
    const rows = [
      { target: makeRow({ gameId: 'NBA:g1', screenScore: 90 }), entry: {} },
      { target: makeRow({ gameId: 'NBA:g2', screenScore: 80, altLineFiltered: true }), entry: {} }
    ];
    const eligible = rows.filter(({ target }) => !target.altLineFiltered);
    const selected = selectTopGlobal({ rows, eligible, validateAll: false, validateTop: 1, isBet });
    assert.deepEqual(
      selected.map((t) => t.gameId),
      ['NBA:g1']
    );
  });
});

describe('selectTopPerBucket (recommended_bets selection strategy)', () => {
  it('takes the top N per bucket by screenScore', () => {
    const nba = { league: 'NBA' };
    const wnba = { league: 'WNBA' };
    const rows = [
      { target: makeRow({ gameId: 'NBA:g1', screenScore: 90 }), entry: nba },
      { target: makeRow({ gameId: 'NBA:g2', screenScore: 10 }), entry: nba },
      { target: makeRow({ gameId: 'WNBA:g1', screenScore: 50 }), entry: wnba },
      { target: makeRow({ gameId: 'WNBA:g2', screenScore: 40 }), entry: wnba }
    ];
    const selected = selectTopPerBucket({ rows, validateAll: false, validateTop: 1 });
    assert.deepEqual(
      selected.map((t) => t.gameId).sort(),
      ['NBA:g1', 'WNBA:g1'],
      'one top row per bucket, not one globally'
    );
  });

  it('returns every row when validateAll', () => {
    const nba = { league: 'NBA' };
    const rows = [
      { target: makeRow({ gameId: 'NBA:g1' }), entry: nba },
      { target: makeRow({ gameId: 'NBA:g2' }), entry: nba }
    ];
    const selected = selectTopPerBucket({ rows, validateAll: true, validateTop: 1 });
    assert.equal(selected.length, 2);
  });

  it('computes the top N over the full bucket, before eligibility filtering', () => {
    // Mirrors recommended_bets: topN is sliced from ALL plays in the bucket;
    // an ineligible row inside topN is skipped downstream, not replaced by
    // the next eligible row.
    const nba = { league: 'NBA' };
    const rows = [
      { target: makeRow({ gameId: 'NBA:g1', screenScore: 90 }), entry: nba },
      { target: makeRow({ gameId: 'NBA:g2', screenScore: 80, altLineFiltered: true }), entry: nba },
      { target: makeRow({ gameId: 'NBA:g3', screenScore: 70 }), entry: nba }
    ];
    const selected = selectTopPerBucket({ rows, validateAll: false, validateTop: 2 });
    assert.deepEqual(
      selected.map((t) => t.gameId),
      ['NBA:g1', 'NBA:g2'],
      'the ineligible row occupies a top-N slot and is not replaced'
    );
  });
});
