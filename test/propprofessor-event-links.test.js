'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractEventLinkRows, chooseEventLink, groupEventLinks } = require('../lib/propprofessor-event-links');

test('extractEventLinkRows reads bets, rows, and array payloads', () => {
  const rows = [{ gameId: 'g1' }];
  assert.deepEqual(extractEventLinkRows({ bets: rows }), rows);
  assert.deepEqual(extractEventLinkRows({ rows }), rows);
  assert.deepEqual(extractEventLinkRows(rows), rows);
  assert.deepEqual(extractEventLinkRows({}), []);
});

test('chooseEventLink prefers the desktop deep link and supports mobile preference', () => {
  const row = {
    deepLink: 'https://book.test/event/desktop',
    pageUrl: 'https://book.test/event/page',
    mobileLink: 'https://book.test/event/mobile'
  };
  assert.equal(chooseEventLink(row), row.deepLink);
  assert.equal(chooseEventLink(row, { mobile: true }), row.mobileLink);
  assert.equal(chooseEventLink({ pageUrl: row.pageUrl }), row.pageUrl);
});

test('groupEventLinks deduplicates markets into one event link', () => {
  const rows = [
    {
      book: 'NoVigApp',
      league: 'Tennis',
      gameId: 'Tennis:GAME:Navarro:Pegula:1',
      homeTeam: 'Pegula',
      awayTeam: 'Navarro',
      start: '2026-09-08T10:00:00Z',
      market: 'Moneyline',
      selection: 'Navarro',
      deepLink: 'https://novig.com/events/abc/propprofessor'
    },
    {
      book: 'NoVigApp',
      league: 'Tennis',
      gameId: 'Tennis:GAME:Navarro:Pegula:1',
      homeTeam: 'Pegula',
      awayTeam: 'Navarro',
      start: '2026-09-08T10:00:00Z',
      market: 'Total Games',
      selection: 'Under 20.5',
      deepLink: 'https://novig.com/events/abc/propprofessor'
    },
    {
      book: 'NoVigApp',
      league: 'MLB',
      gameId: 'MLB:GAME:A:B:2',
      market: 'Moneyline',
      selection: 'A',
      deepLink: 'https://novig.com/events/def/propprofessor'
    }
  ];

  const events = groupEventLinks(rows, { book: 'NoVigApp', leagues: ['Tennis'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventLink, 'https://novig.com/events/abc/propprofessor');
  assert.equal(events[0].markets.length, 2);
});

test('groupEventLinks applies exact market and limit filters', () => {
  const rows = [
    { book: 'NoVigApp', league: 'Tennis', gameId: 'g1', market: 'Moneyline', deepLink: 'https://novig.com/events/1' },
    { book: 'NoVigApp', league: 'Tennis', gameId: 'g2', market: 'Total Games', deepLink: 'https://novig.com/events/2' }
  ];
  const events = groupEventLinks(rows, { book: 'NoVigApp', markets: ['Total Games'], limit: 1 });
  assert.deepEqual(
    events.map((event) => event.eventLink),
    ['https://novig.com/events/2']
  );
});
