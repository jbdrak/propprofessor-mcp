'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildQuickScreenValidationArgs } = require('../scripts/server/handlers/quick-screen');

describe('quick_screen validation book ordering', () => {
  it('puts the execution book first when history books start with a comparison book', () => {
    const args = buildQuickScreenValidationArgs(
      {
        gameId: 'NCAAF:GAME:Home:Away:123',
        selection: 'Home',
        book: 'NoVigApp',
        historySportsbooksRequested: ['4cx', 'Pinnacle', 'NoVigApp']
      },
      { league: 'NCAAF', market: 'Moneyline' },
      { books: ['NoVigApp'] }
    );

    assert.equal(args.books[0], 'NoVigApp');
    assert.deepEqual(args.books, ['NoVigApp', '4cx', 'Pinnacle']);
  });
});
