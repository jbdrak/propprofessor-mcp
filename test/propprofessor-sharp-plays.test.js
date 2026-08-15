'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSharpPlaysFromRankedRows,
  buildUfcShortlist,
  filterUfcRowsForCard,
  parseRowStartMs,
  resolveSharpPlayMarkets,
  resolveSharpPlayMarketsByLeague,
  resolveSharpPlayMarketsForLeague,
  resolveTargetBook,
  resolveTargetBooks,
  summarizeSharpPlayRows
} = require('../lib/propprofessor-sharp-plays');
const { compactRow } = require('../lib/propprofessor-shared-utils');

describe('UFC card/date filtering helpers', () => {
  it('parses a row start time from a start field', () => {
    assert.equal(parseRowStartMs({ start: '2025-05-09T18:30:00Z' }), Date.parse('2025-05-09T18:30:00Z'));
    assert.equal(parseRowStartMs({ start: 1746815400000 }), 1746815400000);
    assert.equal(parseRowStartMs({}), null);
  });

  it('keeps upcoming rows by default and drops past rows when dates are known', () => {
    const now = Date.parse('2025-05-09T12:00:00Z');
    const rows = [
      { scanLeague: 'UFC', participant: 'Future', start: '2025-05-09T18:00:00Z' },
      { scanLeague: 'UFC', participant: 'Past', start: '2025-05-08T18:00:00Z' },
      { scanLeague: 'UFC', participant: 'Unknown' }
    ];

    const filtered = filterUfcRowsForCard(rows, { nowMs: now });
    assert.deepEqual(
      filtered.map((row) => row.participant),
      ['Future', 'Unknown']
    );
  });

  it('uses the configured local timezone for today and next card windows', () => {
    const now = Date.parse('2025-05-10T04:00:00Z');
    const rows = [
      { scanLeague: 'UFC', participant: 'Local Next', start: '2025-05-10T05:00:00Z' },
      { scanLeague: 'UFC', participant: 'Following Day', start: '2025-05-11T05:00:00Z' }
    ];

    assert.deepEqual(
      filterUfcRowsForCard(rows, { nowMs: now, cardWindow: 'today', timezone: 'America/Chicago' }).map(
        (row) => row.participant
      ),
      []
    );
    assert.deepEqual(
      filterUfcRowsForCard(rows, { nowMs: now, cardWindow: 'next', timezone: 'America/Chicago' }).map(
        (row) => row.participant
      ),
      ['Local Next']
    );
  });

  it("filters to today's card window", () => {
    const now = Date.parse('2025-05-09T12:00:00Z');
    const rows = [
      { scanLeague: 'UFC', participant: 'Today', start: '2025-05-09T20:00:00Z' },
      { scanLeague: 'UFC', participant: 'Tomorrow', start: '2025-05-10T01:00:00Z' },
      { scanLeague: 'UFC', participant: 'Unknown' }
    ];

    const filtered = filterUfcRowsForCard(rows, { nowMs: now, cardWindow: 'today', timezone: 'UTC' });
    assert.deepEqual(
      filtered.map((row) => row.participant),
      ['Today']
    );
  });

  it('filters by an explicit event date', () => {
    const rows = [
      { scanLeague: 'UFC', participant: 'Target', start: '2025-05-10T02:00:00Z' },
      { scanLeague: 'UFC', participant: 'Other', start: '2025-05-11T02:00:00Z' },
      { scanLeague: 'UFC', participant: 'Unknown' }
    ];

    const filtered = filterUfcRowsForCard(rows, {
      nowMs: Date.parse('2025-05-09T12:00:00Z'),
      eventDate: '2025-05-10',
      timezone: 'UTC',
      upcomingOnly: true
    });
    assert.deepEqual(
      filtered.map((row) => row.participant),
      ['Target']
    );
  });

  it('keeps strict eventDate filters composable with upcomingOnly and maxHoursAway', () => {
    const now = Date.parse('2025-05-10T08:00:00Z');
    const rows = [
      { scanLeague: 'UFC', participant: 'Future Within Range', start: '2025-05-10T10:00:00Z' },
      { scanLeague: 'UFC', participant: 'Past Same Day', start: '2025-05-10T02:00:00Z' },
      { scanLeague: 'UFC', participant: 'Future Too Far', start: '2025-05-10T18:30:00Z' }
    ];

    const filtered = filterUfcRowsForCard(rows, {
      nowMs: now,
      eventDate: '2025-05-10',
      upcomingOnly: true,
      maxHoursAway: 4
    });

    assert.deepEqual(
      filtered.map((row) => row.participant),
      ['Future Within Range']
    );
  });

  it('keeps strict cardWindow filters composable with maxHoursAway when upcomingOnly is false', () => {
    const now = Date.parse('2025-05-10T08:00:00Z');
    const rows = [
      { scanLeague: 'UFC', participant: 'Within Range', start: '2025-05-10T10:00:00Z' },
      { scanLeague: 'UFC', participant: 'Too Far Past', start: '2025-05-10T02:00:00Z' },
      { scanLeague: 'UFC', participant: 'Wrong Day', start: '2025-05-11T02:00:00Z' }
    ];

    const filtered = filterUfcRowsForCard(rows, {
      nowMs: now,
      cardWindow: 'today',
      upcomingOnly: false,
      maxHoursAway: 4
    });

    assert.deepEqual(
      filtered.map((row) => row.participant),
      ['Within Range']
    );
  });

  it('treats cardWindow next as the next UTC day and excludes malformed starts', () => {
    const now = Date.parse('2025-05-09T23:30:00Z');
    const rows = [
      { scanLeague: 'UFC', participant: 'Next UTC Day', start: '2025-05-10T00:15:00Z' },
      { scanLeague: 'UFC', participant: 'Still Today UTC', start: '2025-05-09T23:45:00Z' },
      { scanLeague: 'UFC', participant: 'Malformed', start: 'not-a-date' }
    ];

    const filtered = filterUfcRowsForCard(rows, { nowMs: now, cardWindow: 'next', timezone: 'UTC' });
    assert.deepEqual(
      filtered.map((row) => row.participant),
      ['Next UTC Day']
    );
  });
});

describe('sharp play target book helpers', () => {
  it('resolves multiple target books while preserving legacy single-book fallback', () => {
    assert.deepEqual(resolveTargetBooks({ targetBooks: ['Fliff', 'Novig', 'NoVigApp', ''] }), ['Fliff', 'NoVigApp']);
    assert.deepEqual(resolveTargetBooks({ targetBooksCsv: 'Fliff,NoVig' }), ['Fliff', 'NoVigApp']);
    assert.deepEqual(resolveTargetBooks({ book: 'Rebet' }), ['Rebet']);
    assert.equal(resolveTargetBook({ targetBooks: ['Fliff', 'NoVigApp'] }), 'Fliff');
  });

  it('dedupes sharp plays by execution book plus play identity, not game only', () => {
    const base = {
      gameId: 'same-game',
      game: 'Stub Away vs Stub Home',
      scanLeague: 'NBA',
      scanMarket: 'Moneyline',
      pick: 'Stub Home',
      consensusBookCount: 2,
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'Pinnacle',
      movementLabel: 'supportive',
      movementQualityScore: 1,
      consensusEdge: 2,
      gatePassed: true
    };

    const result = buildSharpPlaysFromRankedRows(
      [
        { ...base, book: 'NoVigApp', targetBook: 'NoVigApp', odds: 116 },
        { ...base, book: 'Fliff', targetBook: 'Fliff', odds: 108 }
      ],
      {
        targetBook: 'NoVigApp',
        minConsensusBookCount: 1,
        strict: true,
        limit: 10
      }
    );

    assert.equal(result.length, 2);
    assert.deepEqual(result.map((row) => row.book).sort(), ['Fliff', 'NoVigApp']);
  });

  it('summarizes strict empty-state diagnostics and counts target-book movement failures', () => {
    const summary = summarizeSharpPlayRows(
      [
        {
          gameId: 'nba-1',
          scanLeague: 'NBA',
          scanMarket: 'Moneyline',
          pick: 'Minnesota Timberwolves',
          odds: 175,
          consensusBookCount: 5,
          lineHistoryUsable: true,
          movementMode: 'same_book',
          movementSourceBook: 'NoVigApp',
          movementLabel: 'supportive',
          movementQualityScore: 1,
          consensusEdge: 2.5,
          gatePassed: true,
          executionBook: 'NoVigApp',
          targetBook: 'NoVigApp'
        },
        {
          gameId: 'mlb-1',
          scanLeague: 'MLB',
          scanMarket: 'Moneyline',
          pick: 'Los Angeles Dodgers',
          odds: -167,
          consensusBookCount: 6,
          lineHistoryUsable: true,
          movementMode: 'same_book',
          movementSourceBook: 'NoVigApp',
          movementLabel: 'supportive',
          movementQualityScore: 0.9,
          consensusEdge: 2.2,
          gatePassed: true,
          executionBook: 'NoVigApp',
          targetBook: 'NoVigApp'
        },
        {
          gameId: 'nba-2',
          scanLeague: 'NBA',
          scanMarket: 'Moneyline',
          pick: 'Boston Celtics',
          odds: 132,
          consensusBookCount: 4,
          lineHistoryUsable: true,
          movementMode: 'same_book',
          movementSourceBook: 'Pinnacle',
          movementLabel: 'adverse',
          movementQualityScore: 0.85,
          consensusEdge: 1.4,
          gatePassed: true,
          executionBook: 'NoVigApp',
          targetBook: 'NoVigApp'
        },
        {
          gameId: 'nba-3',
          scanLeague: 'NBA',
          scanMarket: 'Moneyline',
          pick: 'Chicago Bulls',
          odds: 145,
          consensusBookCount: 1,
          lineHistoryUsable: true,
          movementMode: 'same_book',
          movementSourceBook: 'Pinnacle',
          movementLabel: 'supportive',
          movementQualityScore: 0.8,
          consensusEdge: 1.1,
          gatePassed: true,
          executionBook: 'NoVigApp',
          targetBook: 'NoVigApp'
        }
      ],
      {
        targetBook: 'NoVigApp',
        minConsensusBookCount: 2,
        strict: true,
        limit: 10
      }
    );

    assert.equal(summary.classificationSummary.totalRowsClassified, 4);
    assert.equal(summary.classificationSummary.verdictCounts['Pass'], 4);
    assert.equal(summary.classificationSummary.passReasonCounts.movement_not_supportive_adverse, 1);
    assert.equal(summary.classificationSummary.passReasonCounts.movement_source_is_target_book, 2);
    assert.equal(summary.classificationSummary.passReasonCounts.consensus_book_count_below_2, 1);
    assert.ok(summary.topNearMisses.length >= 1);
  });

  it('keeps existing filtered-row behavior unchanged when diagnostics are added', () => {
    const rows = [
      {
        gameId: 'nba-bet-1',
        scanLeague: 'NBA',
        scanMarket: 'Moneyline',
        pick: 'Phoenix Suns',
        odds: 118,
        consensusBookCount: 3,
        lineHistoryUsable: true,
        movementMode: 'same_book',
        movementSourceBook: 'Pinnacle',
        movementLabel: 'supportive',
        movementQualityScore: 1,
        consensusEdge: 2.4,
        gatePassed: true,
        executionBook: 'NoVigApp',
        targetBook: 'NoVigApp'
      },
      {
        gameId: 'nba-pass-1',
        scanLeague: 'NBA',
        scanMarket: 'Moneyline',
        pick: 'Dallas Mavericks',
        odds: 155,
        consensusBookCount: 4,
        lineHistoryUsable: true,
        movementMode: 'same_book',
        movementSourceBook: 'NoVigApp',
        movementLabel: 'supportive',
        movementQualityScore: 1,
        consensusEdge: 2.4,
        gatePassed: true,
        executionBook: 'NoVigApp',
        targetBook: 'NoVigApp'
      }
    ];

    const filtered = buildSharpPlaysFromRankedRows(rows, {
      targetBook: 'NoVigApp',
      minConsensusBookCount: 2,
      strict: true,
      limit: 10
    });
    const summary = summarizeSharpPlayRows(rows, {
      targetBook: 'NoVigApp',
      minConsensusBookCount: 2,
      strict: true,
      limit: 10
    });

    assert.deepEqual(summary.filteredRows.map(compactRow), filtered);
    assert.ok(filtered.length >= 1);
    assert.equal(filtered[0].pick, 'Phoenix Suns');
    assert.ok(summary.classificationSummary.verdictCounts['Bet candidate'] >= 1);
  });

  it('dodgers regression: independent Pinnacle movement is not labeled as target-book-only', () => {
    const row = {
      gameId: 'mlb-dodgers-reg',
      scanLeague: 'MLB',
      scanMarket: 'Moneyline',
      market: 'Moneyline',
      pick: 'Los Angeles Dodgers',
      odds: -167,
      currentOdds: -167,
      targetBookOdds: -167,
      bestAvailableOdds: -171,
      consensusBookCount: 2,
      marketBookCount: 2,
      supportBookCount: 2,
      executionQuality: 'playable',
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'Pinnacle',
      movementLabel: 'supportive',
      movementQualityScore: 1,
      consensusEdge: 1.6,
      gatePassed: true,
      targetBook: 'NoVigApp',
      executionBook: 'NoVigApp'
    };

    const summary = summarizeSharpPlayRows([row], {
      targetBook: 'NoVigApp',
      minConsensusBookCount: 2,
      strict: true,
      limit: 10
    });

    assert.equal(summary.filteredRows.length, 1);
    assert.equal(summary.filteredRows[0].verdict, 'Bet candidate');
    assert.equal(summary.classificationSummary.passReasonCounts.movement_source_is_target_book, undefined);
    assert.deepEqual(summary.topNearMisses, []);
  });

  it('avalanche regression: insufficient history reports history failures, not target-book-only movement', () => {
    const summary = summarizeSharpPlayRows(
      [
        {
          gameId: 'nhl-avalanche-reg',
          scanLeague: 'NHL',
          scanMarket: 'Moneyline',
          market: 'Moneyline',
          pick: 'Colorado Avalanche',
          odds: -118,
          currentOdds: -118,
          targetBookOdds: -118,
          bestAvailableOdds: -120,
          consensusBookCount: 2,
          marketBookCount: 2,
          supportBookCount: 2,
          executionQuality: 'playable',
          lineHistoryUsable: false,
          movementMode: null,
          movementSourceBook: null,
          movementLabel: 'insufficient_history',
          movementQualityScore: 0,
          consensusEdge: 1.1,
          gatePassed: true,
          targetBook: 'NoVigApp',
          executionBook: 'NoVigApp'
        }
      ],
      {
        targetBook: 'NoVigApp',
        minConsensusBookCount: 2,
        strict: true,
        limit: 10
      }
    );

    assert.equal(summary.filteredRows.length, 0);
    assert.equal(summary.classificationSummary.verdictCounts['Pass'], 1);
    assert.equal(summary.classificationSummary.passReasonCounts.no_usable_line_history, 1);
    assert.equal(summary.classificationSummary.passReasonCounts.missing_movement_source_book, 1);
    assert.equal(summary.topNearMisses.length, 1);
    assert.equal(summary.topNearMisses[0].pick, 'Colorado Avalanche');
  });

  it('dodgers regression: independent Pinnacle movement is not labeled as target-book-only', () => {
    const row = {
      gameId: 'mlb-dodgers-reg',
      scanLeague: 'MLB',
      scanMarket: 'Moneyline',
      market: 'Moneyline',
      pick: 'Los Angeles Dodgers',
      odds: -167,
      currentOdds: -167,
      targetBookOdds: -167,
      bestAvailableOdds: -171,
      consensusBookCount: 2,
      marketBookCount: 2,
      supportBookCount: 2,
      executionQuality: 'playable',
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'Pinnacle',
      movementLabel: 'supportive',
      movementQualityScore: 1,
      consensusEdge: 1.6,
      gatePassed: true,
      targetBook: 'NoVigApp',
      executionBook: 'NoVigApp'
    };

    const summary = summarizeSharpPlayRows([row], {
      targetBook: 'NoVigApp',
      minConsensusBookCount: 2,
      strict: true,
      limit: 10
    });

    assert.equal(summary.filteredRows.length, 1);
    assert.equal(summary.filteredRows[0].verdict, 'Bet candidate');
    assert.equal(summary.classificationSummary.passReasonCounts.movement_source_is_target_book, undefined);
    assert.deepEqual(summary.topNearMisses, []);
  });

  it('avalanche regression: insufficient history reports history failures, not target-book-only movement', () => {
    const summary = summarizeSharpPlayRows(
      [
        {
          gameId: 'nhl-avalanche-reg',
          scanLeague: 'NHL',
          scanMarket: 'Moneyline',
          market: 'Moneyline',
          pick: 'Colorado Avalanche',
          odds: -118,
          currentOdds: -118,
          targetBookOdds: -118,
          bestAvailableOdds: -120,
          consensusBookCount: 2,
          marketBookCount: 2,
          supportBookCount: 2,
          executionQuality: 'playable',
          lineHistoryUsable: false,
          movementMode: null,
          movementSourceBook: null,
          movementLabel: 'insufficient_history',
          movementQualityScore: 0,
          consensusEdge: 1.1,
          gatePassed: true,
          targetBook: 'NoVigApp',
          executionBook: 'NoVigApp'
        }
      ],
      {
        targetBook: 'NoVigApp',
        minConsensusBookCount: 2,
        strict: true,
        limit: 10
      }
    );

    assert.equal(summary.filteredRows.length, 0);
    assert.equal(summary.classificationSummary.verdictCounts['Pass'], 1);
    assert.equal(summary.classificationSummary.passReasonCounts.no_usable_line_history, 1);
    assert.equal(summary.classificationSummary.passReasonCounts.missing_movement_source_book, 1);
    assert.equal(summary.topNearMisses.length, 1);
    assert.equal(summary.topNearMisses[0].pick, 'Colorado Avalanche');
  });

  it('builds a UFC shortlist with lean fallback rows when strict sharp support is thin', () => {
    const shortlist = buildUfcShortlist(
      [
        {
          gameId: 'ufc-1',
          game: 'Costa vs Allen',
          scanLeague: 'UFC',
          market: 'Moneyline',
          participant: 'Costa',
          odds: 133,
          screenScore: 12.76,
          consensusBookCount: 9,
          consensusEdge: 2.8,
          movementLabel: 'insufficient_history',
          lineHistoryUsable: false,
          gatePassed: true,
          targetBook: 'NoVigApp',
          executionBook: 'NoVigApp',
          start: '2025-05-10T02:00:00Z'
        },
        {
          gameId: 'ufc-2',
          game: 'Gomis vs Peek',
          scanLeague: 'UFC',
          market: 'Moneyline',
          participant: 'Gomis',
          odds: 151,
          screenScore: 5.471,
          consensusBookCount: 4,
          consensusEdge: 1.6,
          movementLabel: 'supportive',
          movementMode: 'same_book',
          movementSourceBook: 'Pinnacle',
          movementQualityScore: 1,
          lineHistoryUsable: true,
          gatePassed: true,
          targetBook: 'NoVigApp',
          executionBook: 'NoVigApp',
          start: '2025-05-09T02:00:00Z'
        },
        {
          gameId: 'ufc-3',
          game: 'Carpenter vs Reyes',
          scanLeague: 'UFC',
          market: 'Moneyline',
          participant: 'Carpenter',
          odds: 162,
          screenScore: 4.795,
          consensusBookCount: 4,
          consensusEdge: 0.9,
          movementLabel: 'adverse',
          lineHistoryUsable: true,
          gatePassed: true,
          targetBook: 'NoVigApp',
          executionBook: 'NoVigApp',
          start: '2025-05-09T03:00:00Z'
        }
      ],
      {
        targetBook: 'NoVigApp',
        minConsensusBookCount: 2,
        limit: 5,
        strict: true,
        eventDate: '2025-05-10',
        timezone: 'UTC',
        nowMs: Date.parse('2025-05-09T12:00:00Z'),
        upcomingOnly: false
      }
    );

    assert.equal(shortlist.league, 'UFC');
    assert.equal(shortlist.officialCount, 0);
    assert.equal(shortlist.leanCount, 1);
    assert.equal(shortlist.passCount, 0);
    assert.deepEqual(shortlist.bestBets, []);
    assert.equal(shortlist.bestLooks[0].participant, 'Costa');
    assert.equal(shortlist.bestLooks[0].shortlistVerdict, 'Lean');
    assert.equal(shortlist.bestLooks[0].shortlistCardWindow, 'eventDate');
    assert.equal(shortlist.bestLooks[0].shortlistEventDate, '2025-05-10');
    assert.match(shortlist.summaryText, /Best UFC looks/i);
    assert.equal(shortlist.shortlistMeta.cardWindow, 'eventDate');
    assert.equal(shortlist.shortlistMeta.eventDate, '2025-05-10');
    assert.equal(shortlist.shortlistMeta.filteredCount, 1);
  });

  it('only returns rows from the requested UFC card window', () => {
    const shortlist = buildUfcShortlist(
      [
        {
          gameId: 'ufc-today',
          scanLeague: 'UFC',
          participant: 'Today Row',
          odds: 125,
          screenScore: 4,
          consensusBookCount: 3,
          consensusEdge: 1,
          movementLabel: 'supportive',
          movementMode: 'same_book',
          movementSourceBook: 'Pinnacle',
          movementQualityScore: 1,
          lineHistoryUsable: true,
          gatePassed: true,
          executionBook: 'NoVigApp',
          targetBook: 'NoVigApp',
          start: '2025-05-09T16:00:00Z'
        },
        {
          gameId: 'ufc-next',
          scanLeague: 'UFC',
          participant: 'Next Row',
          odds: 125,
          screenScore: 5,
          consensusBookCount: 3,
          consensusEdge: 1,
          movementLabel: 'supportive',
          movementMode: 'same_book',
          movementSourceBook: 'Pinnacle',
          movementQualityScore: 1,
          lineHistoryUsable: true,
          gatePassed: true,
          executionBook: 'NoVigApp',
          targetBook: 'NoVigApp',
          start: '2025-05-10T02:00:00Z'
        }
      ],
      {
        targetBook: 'NoVigApp',
        cardWindow: 'today',
        timezone: 'UTC',
        nowMs: Date.parse('2025-05-09T12:00:00Z'),
        limit: 10,
        strict: true,
        upcomingOnly: false
      }
    );

    assert.equal(shortlist.bestBets.length + shortlist.bestLooks.length + shortlist.bestPasses.length, 1);
    assert.equal(shortlist.bestBets[0].participant, 'Today Row');
    assert.equal(shortlist.shortlistMeta.cardWindow, 'today');
    assert.equal(shortlist.shortlistMeta.filteredCount, 1);
  });
});

describe('prop market classification with marketBookCount and executionQuality', () => {
  const { classifySharpPlay } = require('../lib/propprofessor-sharp-plays');

  it('classifies prop with independent sharp movement and playable price as Bet candidate', () => {
    const row = {
      gameId: 'mlb-prop-1',
      scanLeague: 'MLB',
      scanMarket: 'Pitcher Outs Recorded',
      pick: 'Kyle Freeland Over 17.5',
      odds: 100,
      consensusBookCount: 0,
      marketBookCount: 2,
      supportBookCount: 2,
      executionQuality: 'playable',
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'Pinnacle',
      movementLabel: 'supportive',
      movementQualityScore: 1,
      consensusEdge: 1.5,
      gatePassed: true
    };

    const classification = classifySharpPlay(row, {
      targetBook: 'NoVigApp',
      strict: true,
      minConsensusBookCount: 2
    });

    assert.equal(classification.verdict, 'Bet candidate');
    assert.deepEqual(classification.passReasons, []);
    assert.equal(classification.support.movementIsSharpSourced, true);
  });

  it('still passes target-book-only movement even with good market and execution', () => {
    const row = {
      gameId: 'mlb-prop-2',
      scanLeague: 'MLB',
      scanMarket: 'Pitcher Outs Recorded',
      pick: 'Tigers ML',
      odds: -110,
      consensusBookCount: 3,
      marketBookCount: 3,
      supportBookCount: 3,
      executionQuality: 'best',
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'NoVigApp',
      movementLabel: 'supportive',
      movementQualityScore: 1,
      consensusEdge: 2,
      gatePassed: true
    };

    const classification = classifySharpPlay(row, {
      targetBook: 'NoVigApp',
      strict: true,
      minConsensusBookCount: 2
    });

    assert.equal(classification.verdict, 'Pass');
    assert.ok(classification.passReasons.some((r) => /movement_source_is_target_book/.test(r)));
  });

  it('allows target-book movement when requireIndependentSharpMovement is false', () => {
    const row = {
      gameId: 'mlb-prop-2b',
      scanLeague: 'MLB',
      scanMarket: 'Pitcher Outs Recorded',
      pick: 'Tigers ML',
      odds: -110,
      consensusBookCount: 3,
      marketBookCount: 3,
      supportBookCount: 3,
      executionQuality: 'best',
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'NoVigApp',
      movementLabel: 'supportive',
      movementQualityScore: 1,
      consensusEdge: 2,
      gatePassed: true
    };

    const classification = classifySharpPlay(row, {
      targetBook: 'NoVigApp',
      strict: true,
      minConsensusBookCount: 2,
      requireIndependentSharpMovement: false
    });

    assert.equal(classification.verdict, 'Bet candidate');
    assert.ok(!classification.passReasons.some((r) => /movement_source_is_target_book/.test(r)));
    assert.equal(classification.support.movementIsSharpSourced, true);
    assert.equal(classification.support.sourceIsTargetBook, true);
  });

  it('passes prop with bad execution quality even with sharp movement', () => {
    const row = {
      gameId: 'nba-prop-1',
      scanLeague: 'NBA',
      scanMarket: 'Player Points',
      pick: 'Player C Over 5.5',
      odds: -130,
      consensusBookCount: 2,
      marketBookCount: 2,
      supportBookCount: 2,
      executionQuality: 'bad',
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'Pinnacle',
      movementLabel: 'supportive',
      movementQualityScore: 1,
      consensusEdge: 1,
      gatePassed: true
    };

    const classification = classifySharpPlay(row, {
      targetBook: 'NoVigApp',
      strict: true,
      minConsensusBookCount: 2
    });

    assert.equal(classification.verdict, 'Pass');
    assert.ok(classification.passReasons.some((r) => /playable_price_failed/.test(r)));
  });

  it('uses consensusBookCount for non-prop markets even when marketBookCount is present', () => {
    const row = {
      gameId: 'nba-ml-1',
      scanLeague: 'NBA',
      scanMarket: 'Moneyline',
      pick: 'Boston Celtics',
      odds: -150,
      consensusBookCount: 1,
      marketBookCount: 3,
      supportBookCount: 3,
      executionQuality: 'playable',
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'Pinnacle',
      movementLabel: 'supportive',
      movementQualityScore: 1,
      consensusEdge: 1.5,
      gatePassed: true
    };

    const classification = classifySharpPlay(row, {
      targetBook: 'NoVigApp',
      strict: true,
      minConsensusBookCount: 2
    });

    assert.equal(classification.verdict, 'Pass');
    assert.ok(classification.passReasons.some((r) => /consensus_metric_only_failure/.test(r)));
    assert.ok(!classification.passReasons.some((r) => /consensus_book_count_below/.test(r)));
  });

  it('respects requireBestPrice option to demand the best available odds', () => {
    const row = {
      gameId: 'mlb-prop-bp',
      scanLeague: 'MLB',
      scanMarket: 'Pitcher Outs Recorded',
      pick: 'Player A Over 10.5',
      odds: -108,
      consensusBookCount: 2,
      marketBookCount: 2,
      supportBookCount: 2,
      executionQuality: 'playable',
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'Pinnacle',
      movementLabel: 'supportive',
      movementQualityScore: 1,
      consensusEdge: 1,
      gatePassed: true
    };

    const strictBest = classifySharpPlay(row, {
      targetBook: 'NoVigApp',
      strict: true,
      requireBestPrice: true
    });
    assert.equal(strictBest.verdict, 'Pass');
    assert.ok(strictBest.passReasons.some((r) => /playable_price_failed/.test(r)));

    const playable = classifySharpPlay(row, {
      targetBook: 'NoVigApp',
      strict: true,
      requireBestPrice: false
    });
    assert.equal(playable.verdict, 'Bet candidate');
  });

  it('respects minMarketBookCount and minSupportBookCount overrides', () => {
    const row = {
      gameId: 'mlb-prop-mm',
      scanLeague: 'MLB',
      scanMarket: 'Pitcher Outs Recorded',
      pick: 'Player B Over 8.5',
      odds: -110,
      consensusBookCount: 0,
      marketBookCount: 1,
      supportBookCount: 1,
      executionQuality: 'best',
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'Pinnacle',
      movementLabel: 'supportive',
      movementQualityScore: 1,
      consensusEdge: 0.5,
      gatePassed: true
    };

    const defaultThresholds = classifySharpPlay(row, {
      targetBook: 'NoVigApp',
      strict: true
    });
    assert.equal(defaultThresholds.verdict, 'Pass');
    assert.ok(defaultThresholds.passReasons.some((r) => /insufficient_market_availability/.test(r)));

    const loweredThresholds = classifySharpPlay(row, {
      targetBook: 'NoVigApp',
      strict: true,
      minMarketBookCount: 1,
      minSupportBookCount: 1
    });
    assert.equal(loweredThresholds.verdict, 'Bet candidate');
  });
});

describe('end-to-end regression fixtures for verified live cases', () => {
  const { classifySharpPlay } = require('../lib/propprofessor-sharp-plays');

  it('kyle_freeland_over_17_5_outs_fixture: becomes Bet candidate with independent movement', () => {
    const row = {
      gameId: 'mlb-kyle-reg',
      scanLeague: 'MLB',
      scanMarket: 'Pitcher Outs Recorded',
      market: 'Pitcher Outs Recorded',
      pick: 'Kyle Freeland Over 17.5',
      odds: 100,
      consensusBookCount: 2,
      marketBookCount: 2,
      supportBookCount: 2,
      executionQuality: 'best',
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'Pinnacle',
      movementLabel: 'supportive',
      movementQualityScore: 1,
      consensusEdge: 2,
      gatePassed: true
    };

    const classification = classifySharpPlay(row, {
      targetBook: 'NoVigApp',
      strict: true,
      minConsensusBookCount: 2
    });

    assert.equal(classification.verdict, 'Bet candidate');
    assert.deepEqual(classification.passReasons, []);
  });

  it('spencer_strider_over_15_5_outs_fixture: becomes Bet candidate with independent movement', () => {
    const row = {
      gameId: 'mlb-strider-reg',
      scanLeague: 'MLB',
      scanMarket: 'Pitcher Outs Recorded',
      market: 'Pitcher Outs Recorded',
      pick: 'Spencer Strider Over 15.5',
      odds: -110,
      consensusBookCount: 2,
      marketBookCount: 2,
      supportBookCount: 2,
      executionQuality: 'best',
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'Pinnacle',
      movementLabel: 'supportive',
      movementQualityScore: 1,
      consensusEdge: 1.5,
      gatePassed: true
    };

    const classification = classifySharpPlay(row, {
      targetBook: 'NoVigApp',
      strict: true,
      minConsensusBookCount: 2
    });

    assert.equal(classification.verdict, 'Bet candidate');
    assert.deepEqual(classification.passReasons, []);
  });

  it('jared_mccain_over_7_5_points_fixture: becomes Bet candidate with independent movement', () => {
    const row = {
      gameId: 'nba-mccain-reg',
      scanLeague: 'NBA',
      scanMarket: 'Player Points',
      market: 'Player Points',
      pick: 'Jared McCain Over 7.5',
      odds: -112,
      consensusBookCount: 2,
      marketBookCount: 2,
      supportBookCount: 2,
      executionQuality: 'best',
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'FanDuel',
      movementLabel: 'supportive',
      movementQualityScore: 1,
      consensusEdge: 1.8,
      gatePassed: true
    };

    const classification = classifySharpPlay(row, {
      targetBook: 'NoVigApp',
      strict: true,
      minConsensusBookCount: 2
    });

    assert.equal(classification.verdict, 'Bet candidate');
    assert.deepEqual(classification.passReasons, []);
  });

  it('tigers_ml_target_book_only_movement_fixture: still Pass because movement source is target book', () => {
    const row = {
      gameId: 'mlb-tigers-reg',
      scanLeague: 'MLB',
      scanMarket: 'Moneyline',
      pick: 'Detroit Tigers',
      odds: 135,
      consensusBookCount: 2,
      marketBookCount: 2,
      supportBookCount: 2,
      executionQuality: 'best',
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'NoVigApp',
      movementLabel: 'supportive',
      movementQualityScore: 1,
      consensusEdge: 2.5,
      gatePassed: true
    };

    const classification = classifySharpPlay(row, {
      targetBook: 'NoVigApp',
      strict: true,
      minConsensusBookCount: 2
    });

    assert.equal(classification.verdict, 'Pass');
    assert.ok(classification.passReasons.some((r) => /movement_source_is_target_book/.test(r)));
  });

  it('tigers_ml_target_book_only_movement_fixture: becomes Bet candidate when requireIndependentSharpMovement is false', () => {
    const row = {
      gameId: 'mlb-tigers-reg',
      scanLeague: 'MLB',
      scanMarket: 'Moneyline',
      pick: 'Detroit Tigers',
      odds: 135,
      consensusBookCount: 2,
      marketBookCount: 2,
      supportBookCount: 2,
      executionQuality: 'best',
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'NoVigApp',
      movementLabel: 'supportive',
      movementQualityScore: 1,
      consensusEdge: 2.5,
      gatePassed: true
    };

    const classification = classifySharpPlay(row, {
      targetBook: 'NoVigApp',
      strict: true,
      minConsensusBookCount: 2,
      requireIndependentSharpMovement: false
    });

    assert.equal(classification.verdict, 'Bet candidate');
    assert.equal(classification.support.movementIsSharpSourced, true);
    assert.equal(classification.support.sourceIsTargetBook, true);
  });

  it('prop with consensusBookCount=0 but marketBookCount=2 still passes classification', () => {
    const row = {
      gameId: 'mlb-edge-case',
      scanLeague: 'MLB',
      scanMarket: 'Pitcher Outs Recorded',
      market: 'Pitcher Outs Recorded',
      pick: 'Edge Case Over 10.5',
      odds: -105,
      consensusBookCount: 0,
      marketBookCount: 2,
      supportBookCount: 2,
      executionQuality: 'playable',
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'Pinnacle',
      movementLabel: 'supportive',
      movementQualityScore: 1,
      consensusEdge: 0.5,
      gatePassed: true
    };

    const classification = classifySharpPlay(row, {
      targetBook: 'NoVigApp',
      strict: true,
      minConsensusBookCount: 2
    });

    assert.equal(classification.verdict, 'Bet candidate');
  });
});

describe('sharp play per-league market resolution', () => {
  it('resolves per-league registry defaults when no explicit markets are given', () => {
    assert.deepEqual(resolveSharpPlayMarkets({ league: 'Tennis' }), ['Moneyline', 'Total Games', 'Set Handicap']);
    assert.deepEqual(resolveSharpPlayMarkets({ league: 'UFC' }), ['Moneyline', 'Total Rounds']);
    assert.deepEqual(resolveSharpPlayMarkets({ league: 'MLB' }), ['Moneyline', 'Run Line', 'Total Runs']);
    assert.deepEqual(resolveSharpPlayMarkets({ league: 'Soccer', book: 'NoVigApp' }), [
      'Draw No Bet',
      'Match Handicap',
      'Total Goals'
    ]);
  });

  it('uses a single-element leagues array as league context', () => {
    assert.deepEqual(resolveSharpPlayMarkets({ leagues: ['Tennis'] }), ['Moneyline', 'Total Games', 'Set Handicap']);
  });

  it('keeps the generic Moneyline/Spread/Total fallback when no league context exists', () => {
    assert.deepEqual(resolveSharpPlayMarkets({}), ['Moneyline', 'Spread', 'Total']);
  });

  it('honors explicit markets even with league context', () => {
    assert.deepEqual(resolveSharpPlayMarkets({ league: 'Tennis', markets: ['Moneyline'] }), ['Moneyline']);
    assert.deepEqual(resolveSharpPlayMarkets({ league: 'MLB', market: 'Run Line' }), ['Run Line']);
  });

  it('normalizes league names case-insensitively for per-league defaults', () => {
    assert.deepEqual(resolveSharpPlayMarkets({ league: 'tennis' }), ['Moneyline', 'Total Games', 'Set Handicap']);
  });

  it('resolveSharpPlayMarketsForLeague resolves one league with book-aware defaults', () => {
    assert.deepEqual(resolveSharpPlayMarketsForLeague({ book: 'NoVigApp' }, 'Soccer'), [
      'Draw No Bet',
      'Match Handicap',
      'Total Goals'
    ]);
    assert.deepEqual(resolveSharpPlayMarketsForLeague({}, 'Tennis'), ['Moneyline', 'Total Games', 'Set Handicap']);
    assert.deepEqual(resolveSharpPlayMarketsForLeague({ markets: ['Moneyline'] }, 'UFC'), ['Moneyline']);
  });

  it('resolveSharpPlayMarketsByLeague maps every league to its own default markets', () => {
    assert.deepEqual(resolveSharpPlayMarketsByLeague({ book: 'NoVigApp' }, ['NBA', 'Tennis', 'Soccer']), {
      NBA: ['Moneyline', 'Point Spread', 'Total Points'],
      Tennis: ['Moneyline', 'Total Games', 'Set Handicap'],
      Soccer: ['Draw No Bet', 'Match Handicap', 'Total Goals']
    });
  });

  it('resolveSharpPlayMarketsByLeague honors explicit markets for every league', () => {
    assert.deepEqual(resolveSharpPlayMarketsByLeague({ markets: ['Moneyline'] }, ['Tennis', 'UFC']), {
      Tennis: ['Moneyline'],
      UFC: ['Moneyline']
    });
  });
});
