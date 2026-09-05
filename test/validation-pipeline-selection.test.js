'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { selectTopBalanced } = require('../lib/propprofessor-validation-pipeline');

it('selectTopBalanced reserves one validation slot per market bucket', () => {
  const marketA = { league: 'ncaaf', market: 'Moneyline' };
  const marketB = { league: 'ncaaf', market: 'Point Spread' };
  const eligible = [
    { target: { id: 'a1', kaiCall: 'BET', screenScore: 99 }, entry: marketA },
    { target: { id: 'a2', kaiCall: 'BET', screenScore: 98 }, entry: marketA },
    { target: { id: 'b1', kaiCall: 'BET', screenScore: 20 }, entry: marketB }
  ];

  const selected = selectTopBalanced({
    rows: eligible,
    eligible,
    validateAll: false,
    validateTop: 2,
    isBet: (target) => target.kaiCall === 'BET'
  });

  assert.deepEqual(
    selected.map((target) => target.id),
    ['a1', 'b1']
  );
});
