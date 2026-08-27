'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  expandScreenRow,
  rankScreenRows,
  isEdgePlausible,
  resolveGameConflicts,
  resolveTotalsConflicts,
  baseTeamFromSelection,
  isSideMarket
} = require('../lib/screen-ranker');

describe('screen-ranker (direct unit tests)', () => {
  describe('legacy CLV fallback', () => {
    it('uses positive CLV when a two-point underdog price shortens from +145 to +122', () => {
      const [ranked] = rankScreenRows(
        [
          {
            book: 'NoVigApp',
            league: 'NBA',
            homeTeam: 'Lakers',
            awayTeam: 'Warriors',
            participant: 'Lakers',
            selection: 'Lakers',
            market: 'Moneyline',
            selection1: 'Lakers',
            participant1: 'Lakers',
            selection1Id: 'Moneyline:Lakers',
            selection2: 'Warriors',
            participant2: 'Warriors',
            selection2Id: 'Moneyline:Warriors',
            odds: 122,
            lineHistory: [
              { odds: 145, time: '2026-08-13T12:00:00Z' },
              { odds: 122, time: '2026-08-13T18:00:00Z' }
            ],
            allBookOdds: {
              NoVigApp: { book: 'NoVigApp', odds1: 122, odds2: -145 }
            }
          }
        ],
        { preferredBook: 'NoVigApp', limit: 10, includeAll: true }
      );

      assert.ok(ranked);
      assert.ok(ranked.clvProxyPct > 0, `expected positive CLV, got ${ranked.clvProxyPct}`);
      assert.equal(ranked.movementLabel, 'supportive');
    });
  });

  describe('expandScreenRow', () => {
    it('expands a row with multi-book odds into a consensus-enriched row', () => {
      const row = {
        book: 'NoVigApp',
        homeTeam: 'Lakers',
        awayTeam: 'Warriors',
        participant: 'Lakers',
        selection: 'Lakers',
        market: 'Moneyline',
        selection1: 'Lakers',
        participant1: 'Lakers',
        selection1Id: 'Moneyline:Lakers',
        selection2: 'Warriors',
        participant2: 'Warriors',
        selection2Id: 'Moneyline:Warriors',
        allBookOdds: {
          NoVigApp: { book: 'NoVigApp', odds1: -118, odds2: 104 },
          Pinnacle: { book: 'Pinnacle', odds1: -120, odds2: 106 },
          Polymarket: { book: 'Polymarket', odds1: -125, odds2: 110 }
        }
      };
      const [out] = expandScreenRow(row, { preferredBook: 'NoVigApp' });
      assert.equal(out.book, 'NoVigApp');
      assert.equal(out.odds, -118);
      assert.equal(out.consensusBookCount, 2);
    });

    it('drops rows where the preferred book has no price when requirePreferredBook=true', () => {
      // Audit 2026-06-15: regression test for the bug where a row whose
      // allBookOdds only contains Pinnacle/Polymarket/Kalshi was being
      // reported as "Fliff -117" with a non-Fliff book's odds. The fix
      // drops the row entirely when the preferred book is missing.
      const row = {
        book: 'Pinnacle',
        homeTeam: 'Lakers',
        awayTeam: 'Warriors',
        participant: 'Lakers',
        selection: 'Lakers',
        market: 'Moneyline',
        selection1: 'Lakers',
        participant1: 'Lakers',
        selection1Id: 'Moneyline:Lakers',
        selection2: 'Warriors',
        participant2: 'Warriors',
        selection2Id: 'Moneyline:Warriors',
        allBookOdds: {
          Pinnacle: { book: 'Pinnacle', odds1: -120, odds2: 106 },
          Polymarket: { book: 'Polymarket', odds1: -125, odds2: 110 },
          Kalshi: { book: 'Kalshi', odds1: -118, odds2: 104 }
          // No Fliff in this map — Fliff never posted a price for this match
        }
      };
      const out = expandScreenRow(row, {
        preferredBook: 'Fliff',
        requirePreferredBook: true
      });
      assert.deepEqual(out, [], 'row should be dropped when preferred book is unavailable');
    });

    it('keeps the row when the preferred book is unavailable but requirePreferredBook=false (default)', () => {
      // Without requirePreferredBook, the ranker falls back to the row's
      // source book for the odds. This is the legacy behavior — kept for
      // callers that explicitly want "any book with consensus" rather than
      // "plays on this specific book".
      const row = {
        book: 'Pinnacle',
        homeTeam: 'Lakers',
        awayTeam: 'Warriors',
        participant: 'Lakers',
        selection: 'Lakers',
        market: 'Moneyline',
        selection1: 'Lakers',
        participant1: 'Lakers',
        selection1Id: 'Moneyline:Lakers',
        selection2: 'Warriors',
        participant2: 'Warriors',
        selection2Id: 'Moneyline:Warriors',
        allBookOdds: {
          Pinnacle: { book: 'Pinnacle', odds1: -120, odds2: 106 },
          Polymarket: { book: 'Polymarket', odds1: -125, odds2: 110 }
        }
      };
      const [out] = expandScreenRow(row, { preferredBook: 'Fliff' });
      assert.ok(out, 'row should be kept when requirePreferredBook is not set');
      assert.equal(out.odds, -120, 'falls back to row source book (Pinnacle) when Fliff unavailable');
    });

    it('reconstructs the lifted-selections shape when row.selections is undefined but allBookOdds is present', () => {
      // v2.1.6 fix: the ranker reconstructs selections: { null: { ..., odds: allBookOdds } }
      // so the main path can find the odds map.
      const row = {
        book: 'NoVigApp',
        homeTeam: 'Lakers',
        awayTeam: 'Warriors',
        participant: 'Lakers',
        selection: 'Lakers',
        market: 'Moneyline',
        selection1: 'Lakers',
        participant1: 'Lakers',
        selection1Id: 'Moneyline:Lakers',
        selection2: 'Warriors',
        participant2: 'Warriors',
        selection2Id: 'Moneyline:Warriors',
        allBookOdds: {
          NoVigApp: { book: 'NoVigApp', odds1: -118, odds2: 104 },
          Pinnacle: { book: 'Pinnacle', odds1: -120, odds2: 106 }
        }
      };
      const [out] = expandScreenRow(row, { preferredBook: 'NoVigApp' });
      assert.equal(out.odds, -118);
      assert.equal(out.consensusBookCount, 1);
    });
  });

  describe('rankScreenRows with requirePreferredBook', () => {
    it('filters out non-preferred rows when requirePreferredBook=true', () => {
      const rows = [
        {
          // Fliff has a price
          book: 'Fliff',
          homeTeam: 'A',
          awayTeam: 'B',
          participant: 'A',
          market: 'Moneyline',
          selection1: 'A',
          participant1: 'A',
          selection1Id: 'Moneyline:A',
          selection2: 'B',
          participant2: 'B',
          selection2Id: 'Moneyline:B',
          allBookOdds: {
            Fliff: { book: 'Fliff', odds1: 100, odds2: -120 },
            Pinnacle: { book: 'Pinnacle', odds1: 102, odds2: -122 }
          }
        },
        {
          // Fliff has NO price — only Pinnacle posted this match
          book: 'Pinnacle',
          homeTeam: 'C',
          awayTeam: 'D',
          participant: 'C',
          market: 'Moneyline',
          selection1: 'C',
          participant1: 'C',
          selection1Id: 'Moneyline:C',
          selection2: 'D',
          participant2: 'D',
          selection2Id: 'Moneyline:D',
          allBookOdds: {
            Pinnacle: { book: 'Pinnacle', odds1: -110, odds2: -110 }
          }
        }
      ];
      const ranked = rankScreenRows(rows, {
        limit: 10,
        preferredBooks: ['Fliff', 'Pinnacle', 'Polymarket', 'Kalshi', 'BetOnline', 'Circa'],
        includeAll: true,
        requirePreferredBook: true
      });
      assert.equal(ranked.length, 1, 'only the row with Fliff price should remain');
      assert.equal(ranked[0].homeTeam, 'A');
      assert.equal(ranked[0].odds, 100);
    });

    it('keeps all rows when requirePreferredBook=false (default), moves fallback to focusBookMissingRows when requirePreferredBook=true', () => {
      // As of 2026-06-21, fallback rows are only partitioned into
      // focusBookMissingRows when requirePreferredBook=true (user explicitly
      // requested a book). With requirePreferredBook=false (default), the
      // fallback row stays in the main array. Both paths keep coverageGaps.
      const rows = [
        {
          book: 'Pinnacle',
          homeTeam: 'C',
          awayTeam: 'D',
          participant: 'C',
          market: 'Moneyline',
          selection1: 'C',
          participant1: 'C',
          selection1Id: 'Moneyline:C',
          selection2: 'D',
          participant2: 'D',
          selection2Id: 'Moneyline:D',
          allBookOdds: {
            Pinnacle: { book: 'Pinnacle', odds1: -110, odds2: -110 }
          }
        }
      ];
      // With requirePreferredBook=false (default): fallback row stays in main result
      const rankedDefault = rankScreenRows(rows, {
        limit: 10,
        preferredBooks: ['Fliff', 'Pinnacle', 'Polymarket'],
        includeAll: true
      });
      assert.ok(rankedDefault.length > 0, 'main array includes the fallback row when requirePreferredBook=false');
      assert.equal(rankedDefault[0].book, 'Pinnacle', 'fallback row has the actual book');
      assert.equal(rankedDefault[0].focusBookMissingReason, 'no price for Fliff');
      // With requirePreferredBook=true: row is dropped (expandScreenRow returns [])
      const rankedStrict = rankScreenRows(rows, {
        limit: 10,
        preferredBooks: ['Fliff', 'Pinnacle', 'Polymarket'],
        includeAll: true,
        requirePreferredBook: true
      });
      assert.equal(rankedStrict.length, 0, 'main array excludes the dropped row when requirePreferredBook=true');
    });
  });

  describe('rankScreenRows with playableOnly', () => {
    it('keeps "playable" execution rows under playableOnly (10¢ from best)', () => {
      // Audit 2026-06-15: user wants "playable" Fliff plays — within normal
      // market range, not wildly off-market. The playableOnly flag drops
      // "bad" execution rows (where the user's book is 10+ cents worse than
      // the comp consensus) but keeps "playable" and "best" rows even when
      // the consensus edge is negative.
      // For negative odds: targetOdds=-115, best=-105 means target is 10¢
      // worse (you risk more), which classifies as "playable".
      const rows = [
        {
          book: 'Fliff',
          homeTeam: 'A',
          awayTeam: 'B',
          participant: 'A',
          market: 'Moneyline',
          selection1: 'A',
          participant1: 'A',
          selection1Id: 'Moneyline:A',
          selection2: 'B',
          participant2: 'B',
          selection2Id: 'Moneyline:B',
          allBookOdds: {
            Fliff: { book: 'Fliff', odds1: -115, odds2: -130 },
            Pinnacle: { book: 'Pinnacle', odds1: -105, odds2: -140 }
          }
        }
      ];
      const ranked = rankScreenRows(rows, {
        limit: 10,
        preferredBooks: ['Fliff', 'Pinnacle'],
        includeAll: true,
        playableOnly: true
      });
      assert.equal(ranked.length, 1, 'playable row is kept under playableOnly');
      assert.equal(ranked[0].executionQuality, 'playable');
    });

    it('drops "bad" execution rows under playableOnly (15¢+ from best)', () => {
      // Fliff is 20¢ worse than consensus best — should classify as "bad"
      // and be dropped under playableOnly.
      const rows = [
        {
          book: 'Fliff',
          homeTeam: 'A',
          awayTeam: 'B',
          participant: 'A',
          market: 'Moneyline',
          selection1: 'A',
          participant1: 'A',
          selection1Id: 'Moneyline:A',
          selection2: 'B',
          participant2: 'B',
          selection2Id: 'Moneyline:B',
          allBookOdds: {
            Fliff: { book: 'Fliff', odds1: -125, odds2: -130 },
            Pinnacle: { book: 'Pinnacle', odds1: -105, odds2: -140 }
          }
        }
      ];
      const ranked = rankScreenRows(rows, {
        limit: 10,
        preferredBooks: ['Fliff', 'Pinnacle'],
        includeAll: true,
        playableOnly: true
      });
      assert.equal(ranked.length, 0, 'bad execution row should be dropped under playableOnly');
    });

    it('keeps "bad" execution rows when playableOnly is not set (default)', () => {
      // Without playableOnly, the ranker surfaces all rows. The execution
      // quality is still computed and exposed as a field, but it's not used
      // as a filter. Callers who don't pass playableOnly get the full
      // (ranker-gated) view.
      const rows = [
        {
          book: 'Fliff',
          homeTeam: 'A',
          awayTeam: 'B',
          participant: 'A',
          market: 'Moneyline',
          selection1: 'A',
          participant1: 'A',
          selection1Id: 'Moneyline:A',
          selection2: 'B',
          participant2: 'B',
          selection2Id: 'Moneyline:B',
          allBookOdds: {
            Fliff: { book: 'Fliff', odds1: -125, odds2: -130 },
            Pinnacle: { book: 'Pinnacle', odds1: -105, odds2: -140 }
          }
        }
      ];
      const ranked = rankScreenRows(rows, {
        limit: 10,
        preferredBooks: ['Fliff', 'Pinnacle'],
        includeAll: true
      });
      assert.equal(ranked.length, 1, 'row kept under default settings (no playableOnly filter)');
      assert.equal(ranked[0].executionQuality, 'bad');
    });

    it('keeps "best" execution rows under playableOnly', () => {
      // Fliff is the best price on this match — execution quality is "best",
      // should be kept under playableOnly.
      const rows = [
        {
          book: 'Fliff',
          homeTeam: 'A',
          awayTeam: 'B',
          participant: 'A',
          market: 'Moneyline',
          selection1: 'A',
          participant1: 'A',
          selection1Id: 'Moneyline:A',
          selection2: 'B',
          participant2: 'B',
          selection2Id: 'Moneyline:B',
          allBookOdds: {
            Fliff: { book: 'Fliff', odds1: -110, odds2: -130 },
            Pinnacle: { book: 'Pinnacle', odds1: -115, odds2: -135 }
          }
        }
      ];
      const ranked = rankScreenRows(rows, {
        limit: 10,
        preferredBooks: ['Fliff', 'Pinnacle'],
        includeAll: true,
        playableOnly: true
      });
      assert.equal(ranked.length, 1);
      assert.equal(ranked[0].executionQuality, 'best');
    });
  });

  describe('focus-book coverage gaps', () => {
    it('flags a row as focusBookMissing when the focus book has no price and ranker falls back to a different book', () => {
      // P0 fix: when the user asks for --book NoVigApp but the screen
      // endpoint only returns Pinnacle/FanDuel for this match, the ranker
      // used to silently fall through and report `book: 'Pinnacle'` as if it
      // were NoVigApp. Now the row carries focusBookMissing: true and the
      // ranker's coverageGaps surface the missing coverage.
      // Odds chosen to produce consensusEdge large enough to clear the NBA gate.
      const row = {
        book: 'Pinnacle',
        league: 'NBA',
        homeTeam: 'Lakers',
        awayTeam: 'Warriors',
        participant: 'Lakers',
        selection: 'Lakers',
        market: 'Moneyline',
        selection1: 'Lakers',
        participant1: 'Lakers',
        selection1Id: 'Moneyline:Lakers',
        selection2: 'Warriors',
        participant2: 'Warriors',
        selection2Id: 'Moneyline:Warriors',
        lineHistory: [],
        allBookOdds: {
          Pinnacle: { book: 'Pinnacle', odds1: -110, odds2: -110 },
          FanDuel: { book: 'FanDuel', odds1: -150, odds2: 130 }
          // No NoVigApp — that's the gap
        }
      };
      const ranked = rankScreenRows([row], {
        preferredBook: 'NoVigApp',
        requirePreferredBook: false,
        limit: 10
      });
      // As of 2026-06-21, fallback rows stay in the main result when
      // requirePreferredBook=false (no explicit user book request).
      // The row carries focusBookMissing=true so callers can detect it.
      assert.ok(ranked.length > 0, 'main array includes the fallback row');
      assert.equal(ranked[0].focusBookMissing, true, 'row carries focusBookMissing flag');
      assert.equal(ranked[0].focusBookMissingReason, 'no price for NoVigApp');
      assert.equal(ranked[0].book, 'Pinnacle', 'fallback row reports the book it fell back to');
      assert.equal(ranked.coverageGaps.length, 1, 'should record one coverage gap');
      assert.equal(ranked.coverageGaps[0].preferredBook, 'NoVigApp');
      assert.deepEqual(ranked.coverageGaps[0].availableBooks.sort(), ['FanDuel', 'Pinnacle']);
      assert.equal(ranked.coverageGaps[0].matchup, 'Warriors vs Lakers');
      assert.equal(ranked.coverageGaps[0].reason, 'no_price_fallback');
      assert.equal(ranked.coverageGaps[0].focusBookMissingReason, 'no price for NoVigApp');
      // The fallback row is in the main array (not focusBookMissingRows)
      // since requirePreferredBook=false. focusBookMissing is set on the row.
      assert.equal(ranked[0].focusBookMissing, true, 'fallback row has focusBookMissing flag');
      assert.equal(ranked[0].focusBookMissingReason, 'no price for NoVigApp');
    });

    it('records a coverage gap for rows dropped because the focus book has no price (requirePreferredBook=true)', () => {
      const row = {
        book: 'Pinnacle',
        league: 'NBA',
        homeTeam: 'Celtics',
        awayTeam: 'Heat',
        participant: 'Celtics',
        market: 'Moneyline',
        selection1: 'Celtics',
        participant1: 'Celtics',
        selection1Id: 'Moneyline:Celtics',
        selection2: 'Heat',
        participant2: 'Heat',
        selection2Id: 'Moneyline:Heat',
        allBookOdds: {
          Pinnacle: { book: 'Pinnacle', odds1: -150, odds2: 130 }
        }
      };
      const ranked = rankScreenRows([row], {
        preferredBook: 'NoVigApp',
        requirePreferredBook: true,
        limit: 10
      });
      assert.equal(ranked.length, 0, 'row should be dropped');
      assert.equal(ranked.coverageGaps.length, 1, 'dropped row should still be reported as a coverage gap');
      assert.equal(ranked.coverageGaps[0].reason, 'no_price_dropped');
      assert.equal(ranked.coverageGaps[0].preferredBook, 'NoVigApp');
      assert.deepEqual(ranked.coverageGaps[0].availableBooks, ['Pinnacle']);
    });

    it('does not record a coverage gap when the focus book has a price', () => {
      const row = {
        book: 'NoVigApp',
        league: 'NBA',
        homeTeam: 'Bulls',
        awayTeam: 'Knicks',
        participant: 'Bulls',
        market: 'Moneyline',
        selection1: 'Bulls',
        participant1: 'Bulls',
        selection1Id: 'Moneyline:Bulls',
        selection2: 'Knicks',
        participant2: 'Knicks',
        selection2Id: 'Moneyline:Knicks',
        allBookOdds: {
          NoVigApp: { book: 'NoVigApp', odds1: -110, odds2: -110 },
          Pinnacle: { book: 'Pinnacle', odds1: -150, odds2: 130 }
        }
      };
      const ranked = rankScreenRows([row], { preferredBook: 'NoVigApp', limit: 10 });
      assert.equal(ranked.length, 1);
      assert.equal(ranked[0].focusBookMissing, false);
      assert.equal(ranked.coverageGaps.length, 0, 'no gap when focus book has a price');
    });

    it('attaches coverageGaps and focusBookMissingRows as non-enumerable properties', () => {
      const row = {
        book: 'Pinnacle',
        league: 'NBA',
        homeTeam: 'A',
        awayTeam: 'B',
        participant: 'A',
        market: 'Moneyline',
        selection1: 'A',
        participant1: 'A',
        selection1Id: 'Moneyline:A',
        selection2: 'B',
        participant2: 'B',
        selection2Id: 'Moneyline:B',
        allBookOdds: {
          Pinnacle: { book: 'Pinnacle', odds1: -110, odds2: -110 },
          FanDuel: { book: 'FanDuel', odds1: -150, odds2: 130 }
        }
      };
      // With requirePreferredBook=true — simulates explicit user book request.
      const ranked = rankScreenRows([row], {
        preferredBook: 'NoVigApp',
        limit: 10,
        requirePreferredBook: true
      });
      // With requirePreferredBook=true, expandScreenRow drops the row entirely
      // (NoVigApp has no odds in allBookOdds) — it never reaches the partition
      // step. The main array is empty, focusBookMissingRows stays undefined,
      // and coverageGaps captures the missing coverage.
      assert.equal(ranked.length, 0);
      assert.equal(
        ranked.focusBookMissingRows,
        undefined,
        'with requirePreferredBook=true, row is dropped before partition — focusBookMissingRows stays undefined'
      );
      // coverageGaps is still populated by the expandScreenRow-returns-[] branch
      assert.ok(Array.isArray(ranked.coverageGaps));
      assert.ok(ranked.coverageGaps.length > 0, 'should have at least one coverage gap');
      // JSON.stringify should not include coverageGaps (non-enumerable)
      const json = JSON.stringify(ranked);
      assert.ok(!json.includes('coverageGaps'), 'coverageGaps should not be in JSON output');
      // But the property is still accessible
      assert.ok(Array.isArray(ranked.coverageGaps));
      // And Object.keys should not include them
      assert.ok(!Object.keys(ranked).includes('coverageGaps'));
      assert.ok(!Object.keys(ranked).includes('focusBookMissingRows'));
    });
  });

  describe('side-resolution fallback (Bug #1, 2026-06-17)', () => {
    it('picks up the price from the alternate odds key when the resolved side is non-finite', () => {
      // Regression: Charaeva had NoVigApp at -1036 on odds1, but resolveExtractedScreenSide
      // returned odds2 (the empty side). The row was being created with
      // targetBookOdds: null even though the price was on the book. Now we flip
      // to the alternate side and surface the real price.
      const row = {
        book: 'NoVigApp',
        league: 'Tennis',
        homeTeam: 'Kulikova',
        awayTeam: 'Charaeva',
        participant: 'Charaeva',
        selection: 'Charaeva',
        market: 'Moneyline',
        selection1: 'Charaeva',
        participant1: 'Charaeva',
        selection1Id: 'Moneyline:Charaeva',
        selection2: 'Kulikova',
        participant2: 'Kulikova',
        selection2Id: 'Moneyline:Kulikova',
        // The selection ID will resolve to odds2 (Kulikova's side), but the
        // real price for Charaeva is on odds1.
        allBookOdds: {
          NoVigApp: { book: 'NoVigApp', odds1: -1036, odds2: 480 }
        }
      };
      const [out] = expandScreenRow(row, { preferredBook: 'NoVigApp' });
      assert.equal(out.targetBookOdds, -1036, 'should pick up the price from odds1 even when side resolved to odds2');
      assert.equal(out.odds, -1036);
      assert.equal(out.currentOdds, -1036);
    });

    it('does not flip the side when the resolved side already has a finite price', () => {
      // Normal case: both sides are finite, the side we picked wins.
      const row = {
        book: 'NoVigApp',
        league: 'Tennis',
        homeTeam: 'A',
        awayTeam: 'B',
        participant: 'A',
        selection: 'A',
        market: 'Moneyline',
        selection1: 'A',
        participant1: 'A',
        selection1Id: 'Moneyline:A',
        selection2: 'B',
        participant2: 'B',
        selection2Id: 'Moneyline:B',
        allBookOdds: {
          NoVigApp: { book: 'NoVigApp', odds1: -150, odds2: 130 }
        }
      };
      const [out] = expandScreenRow(row, { preferredBook: 'NoVigApp' });
      assert.equal(out.targetBookOdds, -150);
    });
  });

  describe('compDataMissing flag (Bug #3, 2026-06-17)', () => {
    it('flags compDataMissing when the focus book has a price but no comp book has a same-side price', () => {
      // Ferro/Olmo case: NoVigApp posted the only price, so we have nothing
      // to compare execution quality against. Previously executionQuality
      // was silently 'unknown' with no explanation. Now the row carries an
      // explicit compDataMissing: true flag.
      const row = {
        book: 'NoVigApp',
        league: 'Tennis',
        homeTeam: 'Ferro',
        awayTeam: 'Gorgodze',
        participant: 'Ferro',
        selection: 'Ferro',
        market: 'Moneyline',
        selection1: 'Ferro',
        participant1: 'Ferro',
        selection1Id: 'Moneyline:Ferro',
        selection2: 'Gorgodze',
        participant2: 'Gorgodze',
        selection2Id: 'Moneyline:Gorgodze',
        allBookOdds: {
          NoVigApp: { book: 'NoVigApp', odds1: -517, odds2: 380 }
        }
      };
      const ranked = rankScreenRows([row], { preferredBook: 'NoVigApp', limit: 10, includeAll: true });
      assert.equal(ranked.length, 1);
      assert.equal(ranked[0].compDataMissing, true);
      assert.equal(ranked[0].executionQuality, 'unknown');
    });

    it('does not flag compDataMissing when comp books have a same-side price', () => {
      const row = {
        book: 'NoVigApp',
        league: 'Tennis',
        homeTeam: 'A',
        awayTeam: 'B',
        participant: 'A',
        selection: 'A',
        market: 'Moneyline',
        selection1: 'A',
        participant1: 'A',
        selection1Id: 'Moneyline:A',
        selection2: 'B',
        participant2: 'B',
        selection2Id: 'Moneyline:B',
        allBookOdds: {
          NoVigApp: { book: 'NoVigApp', odds1: -110, odds2: -110 },
          Pinnacle: { book: 'Pinnacle', odds1: -112, odds2: -108 }
        }
      };
      const ranked = rankScreenRows([row], { preferredBook: 'NoVigApp', limit: 10 });
      assert.equal(ranked.length, 1);
      assert.equal(ranked[0].compDataMissing, false);
    });
  });
});

const { getKaiCall } = require('../lib/propprofessor-risk-score');

describe('getKaiCall (Bug #2, 2026-06-17)', () => {
  it('caps verdict at CONSIDER for rows with focusBookMissing=true even when risk is low', () => {
    // Regression: a TIER 1/2 BET verdict on a row where the focus book has no
    // price implies the user can place the bet on the focus book. When
    // focusBookMissing is true, the row fell back to a different book, so
    // the verdict is misleading. Now it caps at CONSIDER.
    const item = {
      focusBookMissing: true,
      consensusBookCount: 8,
      executionQuality: 'best',
      movementLabel: 'supportive',
      movementQuality: 'high',
      multiWindowScore: 1.0,
      consensusEdge: 2.0,
      clvProxyPct: 5.0,
      consensusWindowCount: 6,
      totalConsensusWindows: 6,
      hasConsensus: true,
      steamMove: true,
      steamBooks: ['Pinnacle', 'BetOnline', 'Circa']
    };
    const call = getKaiCall(item);
    assert.notEqual(call, 'BET', 'focusBookMissing rows should not get BET — user cannot execute on focus book');
    assert.equal(call, 'CONSIDER');
  });

  it('also caps CONSIDER when focusBookMissing lives on item.row (intermediate ranker state)', () => {
    // The call site in lib/screen-ranker.js passes the intermediate ranker
    // object to getKaiCall, which has focusBookMissing on item.row (the
    // raw row from expandScreenRow), not at the top level. The check must
    // look at both locations.
    const item = {
      row: { focusBookMissing: true },
      consensusBookCount: 8,
      executionQuality: 'best',
      movementLabel: 'supportive',
      movementQuality: 'high',
      multiWindowScore: 1.0,
      consensusEdge: 2.0,
      clvProxyPct: 5.0,
      consensusWindowCount: 6,
      totalConsensusWindows: 6,
      hasConsensus: true,
      steamMove: true,
      steamBooks: ['Pinnacle', 'BetOnline', 'Circa']
    };
    assert.equal(getKaiCall(item), 'CONSIDER');
  });

  it('still returns BET for focusBookMissing=false rows with green grade and low risk', () => {
    const item = {
      focusBookMissing: false,
      consensusBookCount: 8,
      executionQuality: 'best',
      movementLabel: 'supportive',
      movementQuality: 'high',
      multiWindowScore: 1.0,
      consensusEdge: 2.0,
      clvProxyPct: 5.0,
      consensusWindowCount: 6,
      totalConsensusWindows: 6,
      hasConsensus: true,
      steamMove: true,
      steamBooks: ['Pinnacle', 'BetOnline', 'Circa']
    };
    assert.equal(getKaiCall(item), 'BET');
  });
});

describe('isEdgePlausible', () => {
  it('rejects phantom edge from single off-market book', () => {
    assert.equal(
      isEdgePlausible({ consensusEdge: 33, consensusBookCount: 1, targetOdds: -185, bestAvailableOdds: -4900 }),
      false
    );
  });
  it('allows small edge from deep consensus', () => {
    assert.equal(
      isEdgePlausible({ consensusEdge: 2.0, consensusBookCount: 11, targetOdds: -110, bestAvailableOdds: -112 }),
      true
    );
  });
  it('allows null edge (nothing to judge)', () => {
    assert.equal(isEdgePlausible({ consensusEdge: null }), true);
  });
});

describe('expandScreenRow edge sanity', () => {
  it('nulls a phantom consensus edge from a single stale off-market book and tags the row implausible', () => {
    // Preferred book -185, only one other book at -4900 (off-market/stale).
    // That single off-market comp produces a +33% "edge" that is not real.
    const row = {
      book: 'NoVigApp',
      homeTeam: 'Lakers',
      awayTeam: 'Warriors',
      participant: 'Lakers',
      selection: 'Lakers',
      market: 'Moneyline',
      selection1: 'Lakers',
      participant1: 'Lakers',
      selection1Id: 'Moneyline:Lakers',
      selection2: 'Warriors',
      participant2: 'Warriors',
      selection2Id: 'Moneyline:Warriors',
      selections: {
        null: {
          selection1: 'Lakers',
          participant1: 'Lakers',
          selectionType1: 'team',
          selection1Id: 'Moneyline:Lakers',
          line1: null,
          selection2: 'Warriors',
          participant2: 'Warriors',
          selectionType2: 'team',
          selection2Id: 'Moneyline:Warriors',
          line2: null,
          odds: {
            NoVigApp: { odds1: -185, odds2: 175 },
            OffMarket: { odds1: -4900, odds2: 4800 }
          }
        }
      },
      allBookOdds: {
        NoVigApp: { odds1: -185, odds2: 175 },
        OffMarket: { odds1: -4900, odds2: 4800 }
      }
    };
    const [out] = expandScreenRow(row, { preferredBook: 'NoVigApp' });
    assert.equal(out.consensusEdge, null, 'phantom edge should be nulled');
    assert.equal(out.edgeSanityFlag, 'implausible', 'row should be tagged implausible');
    assert.equal(out.consensusBookCount, 1);
  });

  it('keeps a real edge from on-market consensus and tags the row ok', () => {
    // target -110, comps at -112 / -108 — a genuine thin sharp edge.
    const row = {
      book: 'NoVigApp',
      homeTeam: 'Lakers',
      awayTeam: 'Warriors',
      participant: 'Lakers',
      selection: 'Lakers',
      market: 'Moneyline',
      selection1: 'Lakers',
      participant1: 'Lakers',
      selection1Id: 'Moneyline:Lakers',
      selection2: 'Warriors',
      participant2: 'Warriors',
      selection2Id: 'Moneyline:Warriors',
      selections: {
        null: {
          selection1: 'Lakers',
          participant1: 'Lakers',
          selectionType1: 'team',
          selection1Id: 'Moneyline:Lakers',
          line1: null,
          selection2: 'Warriors',
          participant2: 'Warriors',
          selectionType2: 'team',
          selection2Id: 'Moneyline:Warriors',
          line2: null,
          odds: {
            NoVigApp: { odds1: -110, odds2: 104 },
            Pinnacle: { odds1: -112, odds2: 106 },
            DraftKings: { odds1: -108, odds2: 100 }
          }
        }
      },
      allBookOdds: {
        NoVigApp: { odds1: -110, odds2: 104 },
        Pinnacle: { odds1: -112, odds2: 106 },
        DraftKings: { odds1: -108, odds2: 100 }
      }
    };
    const [out] = expandScreenRow(row, { preferredBook: 'NoVigApp' });
    assert.ok(Number.isFinite(out.consensusEdge), 'on-market edge should be a finite number');
    assert.equal(out.edgeSanityFlag, 'ok', 'row should be tagged ok');
  });
});

describe('game-conflict resolution (resolveGameConflicts)', () => {
  it('downgrades an opposite-sided TIER 1 bet that loses to a higher-edge same-game pick', () => {
    const ranked = [
      {
        gameId: 'MLB:PREMATCH:Cleveland_Guardians:Minnesota_Twins:1783618800',
        game: 'Cleveland Guardians vs Minnesota Twins',
        selection: 'Minnesota Twins',
        market: 'Moneyline',
        confidenceTier: 'TIER 1',
        kaiCall: 'BET',
        consensusEdge: 1.18,
        screenScore: 4.7
      },
      {
        gameId: 'MLB:PREMATCH:Cleveland_Guardians:Minnesota_Twins:1783618800',
        game: 'Cleveland Guardians vs Minnesota Twins',
        selection: 'Cleveland Guardians -1.5',
        market: 'Run Line',
        confidenceTier: 'TIER 1',
        kaiCall: 'BET',
        consensusEdge: 1.59,
        screenScore: 6.1
      }
    ];
    const out = resolveGameConflicts(ranked);
    const twins = out.find((r) => r.selection === 'Minnesota Twins');
    const guards = out.find((r) => r.selection.includes('Cleveland'));
    assert.equal(guards.confidenceTier, 'TIER 1', 'higher-edge Guardians -1.5 wins the game');
    assert.equal(twins.confidenceTier, 'TIER 2', 'opposite Twins ML demoted one tier');
    assert.equal(twins.kaiCall, 'CONSIDER', 'demoted pick drops from BET to CONSIDER');
    assert.equal(twins.conflictWith, 'Cleveland Guardians -1.5', 'points at the winning side');
    assert.equal(twins.conflictFlag, true, 'flag is set so the UI can explain the demotion');
  });

  it('does NOT demote both sides when they are on different games', () => {
    const ranked = [
      {
        gameId: 'g1',
        selection: 'Team A',
        market: 'Moneyline',
        confidenceTier: 'TIER 1',
        kaiCall: 'BET',
        consensusEdge: 2.0,
        screenScore: 9
      },
      {
        gameId: 'g2',
        selection: 'Team B',
        market: 'Moneyline',
        confidenceTier: 'TIER 1',
        kaiCall: 'BET',
        consensusEdge: 2.0,
        screenScore: 9
      }
    ];
    const out = resolveGameConflicts(ranked);
    assert.equal(out[0].confidenceTier, 'TIER 1');
    assert.equal(out[1].confidenceTier, 'TIER 1');
    assert.equal(out[0].conflictFlag, undefined);
    assert.equal(out[1].conflictFlag, undefined);
  });

  it('audit finding #6: missing consensusEdge loses to a real-edge opposing side (not the other way around)', () => {
    // Previously `?? -999` made missing-edge the WORST possible pick, so a
    // TIER 1 missing-edge side would lose to a TIER 3 with real edge. Now
    // missing sorts below any real edge, but a TIER 1 missing-edge still
    // beats a TIER 3 real-edge (because tier is the primary sort key).
    const ranked = [
      {
        gameId: 'NBA:edge1',
        game: 'Lakers vs Celtics',
        selection: 'Lakers',
        market: 'Moneyline',
        confidenceTier: 'TIER 1',
        kaiCall: 'BET'
        // no consensusEdge
      },
      {
        gameId: 'NBA:edge1',
        game: 'Lakers vs Celtics',
        selection: 'Celtics',
        market: 'Moneyline',
        confidenceTier: 'TIER 2',
        kaiCall: 'CONSIDER',
        consensusEdge: 0.5,
        screenScore: 5
      }
    ];
    const out = resolveGameConflicts(ranked);
    const lakers = out.find((r) => r.selection === 'Lakers');
    const celtics = out.find((r) => r.selection === 'Celtics');
    assert.equal(lakers.confidenceTier, 'TIER 1', 'TIER 1 with missing edge still wins the conflict');
    assert.equal(lakers.conflictFlag, undefined, 'winner is not flagged');
    assert.equal(celtics.confidenceTier, 'TIER 3', 'TIER 2 with real edge gets demoted one tier');
    assert.equal(celtics.conflictWith, 'Lakers', 'points at the missing-edge winner');
  });

  it('ignores totals — Under 168.5 and Under 171.5 on the same game are not conflicting sides', () => {
    const ranked = [
      {
        gameId: 'WNBA:samegame',
        selection: 'Under 168.5',
        market: 'Total Points',
        confidenceTier: 'TIER 1',
        kaiCall: 'BET',
        consensusEdge: 1.9,
        screenScore: 10.5
      },
      {
        gameId: 'WNBA:samegame',
        selection: 'Under 171.5',
        market: 'Total Points',
        confidenceTier: 'TIER 1',
        kaiCall: 'BET',
        consensusEdge: 2.2,
        screenScore: 7.0
      }
    ];
    const out = resolveGameConflicts(ranked);
    assert.equal(out[0].confidenceTier, 'TIER 1');
    assert.equal(out[1].confidenceTier, 'TIER 1');
    assert.equal(out[0].conflictFlag, undefined);
  });

  it('leaves a PASS row alone (no conflict resolution on non-actionable picks)', () => {
    const ranked = [
      {
        gameId: 'g',
        selection: 'Team A',
        market: 'Moneyline',
        confidenceTier: 'TIER 1',
        kaiCall: 'BET',
        consensusEdge: 3.0,
        screenScore: 12
      },
      {
        gameId: 'g',
        selection: 'Team B',
        market: 'Moneyline',
        confidenceTier: 'TIER 1',
        kaiCall: 'PASS',
        consensusEdge: 3.0,
        screenScore: 12
      }
    ];
    const out = resolveGameConflicts(ranked);
    const pass = out.find((r) => r.kaiCall === 'PASS');
    assert.equal(pass.confidenceTier, 'TIER 1', 'already-PASS row is untouched');
  });

  it('downgrades an intra-team duplicate where the same team appears twice at different handicaps in the same market', () => {
    // Regression: MLB Run Line with both "Rays -1.5" (BET) and "Rays +1.5" (BET)
    // in the same game+market. resolveGameConflicts must catch this even though
    // baseTeamFromSelection normalises both to "tampa bay rays" (same team) and
    // the cross-team check (teams.size >= 2) can't see it.
    const ranked = [
      {
        game: 'Tampa Bay Rays vs Texas Rangers',
        market: 'Run Line',
        selection: 'Tampa Bay Rays -1.5',
        confidenceTier: 'TIER 1',
        kaiCall: 'BET',
        consensusEdge: 0.53,
        screenScore: 7.2
      },
      {
        game: 'Tampa Bay Rays vs Texas Rangers',
        market: 'Run Line',
        selection: 'Tampa Bay Rays +1.5',
        confidenceTier: 'TIER 2',
        kaiCall: 'BET',
        consensusEdge: 0.55,
        screenScore: 6.5
      }
    ];
    const out = resolveGameConflicts(ranked);
    const fav = out.find((r) => r.selection === 'Tampa Bay Rays -1.5');
    const dog = out.find((r) => r.selection === 'Tampa Bay Rays +1.5');
    assert.equal(fav.confidenceTier, 'TIER 1', 'best (TIER 1) entry is kept');
    assert.equal(fav.kaiCall, 'BET', 'best entry stays BET');
    assert.equal(fav.conflictFlag, undefined, 'winner is not flagged');
    assert.notEqual(dog.confidenceTier, 'TIER 2', 'duplicate is NOT kept at its original tier');
    assert.ok(dog.conflictFlag, 'duplicate row is flagged as a conflict');
    assert.match(dog.conflictWith || '', /intra-team/i, 'duplicate explains the conflict source');
  });

  it('baseTeamFromSelection strips line suffixes and parenthetical tags', () => {
    assert.equal(baseTeamFromSelection('Cleveland Guardians -1.5'), 'cleveland guardians');
    assert.equal(baseTeamFromSelection('Minnesota Twins'), 'minnesota twins');
    assert.equal(baseTeamFromSelection('Morocco (Draw No Bet)'), 'morocco');
    assert.equal(isSideMarket('Moneyline'), true);
    assert.equal(isSideMarket('Run Line'), true);
    assert.equal(isSideMarket('Total Points'), false);
    assert.equal(isSideMarket('Total Games'), false);
  });
});

describe('totals-conflict resolution (resolveTotalsConflicts)', () => {
  it('does not demote same-direction totals on the same game', () => {
    const ranked = [
      {
        gameId: 'WNBA:game-1',
        market: 'Total Points',
        selection: 'Over 168.5',
        confidenceTier: 'TIER 1',
        kaiCall: 'BET',
        consensusEdge: 2.1
      },
      {
        gameId: 'WNBA:game-1',
        market: 'Total Points',
        selection: 'Over 171.5',
        confidenceTier: 'TIER 2',
        kaiCall: 'BET',
        consensusEdge: 1.6
      }
    ];

    resolveTotalsConflicts(ranked);

    assert.equal(ranked[0].kaiCall, 'BET', 'higher-edge Over 168.5 stays BET');
    assert.equal(ranked[1].kaiCall, 'BET', 'Over 171.5 stays BET — same direction, no conflict');
    assert.equal(ranked[0].totalsConflictWith, undefined);
    assert.equal(ranked[1].totalsConflictWith, undefined);
    assert.equal(ranked[0].confidenceTier, 'TIER 1');
    assert.equal(ranked[1].confidenceTier, 'TIER 2');
  });

  it('demotes opposite-direction totals on the same game', () => {
    const ranked = [
      {
        gameId: 'WNBA:game-2',
        market: 'Total Points',
        selection: 'Over 168.5',
        confidenceTier: 'TIER 1',
        kaiCall: 'BET',
        consensusEdge: 2.1
      },
      {
        gameId: 'WNBA:game-2',
        market: 'Total Points',
        selection: 'Under 171.5',
        confidenceTier: 'TIER 2',
        kaiCall: 'BET',
        consensusEdge: 1.6
      }
    ];

    resolveTotalsConflicts(ranked);

    assert.equal(ranked[0].kaiCall, 'BET', 'higher-edge Over stays BET');
    assert.equal(ranked[1].kaiCall, 'CONSIDER', 'Under gets demoted');
    assert.equal(ranked[1].totalsConflictWith, 'Over 168.5');
  });

  it('does not demote same-direction totals on different lines but same game', () => {
    const ranked = [
      {
        gameId: 'MLB:game-3',
        market: 'Total Runs',
        selection: 'Under 8.5',
        confidenceTier: 'TIER 1',
        kaiCall: 'BET',
        consensusEdge: 1.9
      },
      {
        gameId: 'MLB:game-3',
        market: 'Total Runs',
        selection: 'Under 9.5',
        confidenceTier: 'TIER 2',
        kaiCall: 'BET',
        consensusEdge: 2.2
      }
    ];

    resolveTotalsConflicts(ranked);

    assert.equal(ranked[0].kaiCall, 'BET');
    assert.equal(ranked[1].kaiCall, 'BET');
    assert.equal(ranked[0].totalsConflictWith, undefined);
    assert.equal(ranked[1].totalsConflictWith, undefined);
  });

  it('keeps a same-direction alternate when an opposing row is demoted (3-row game)', () => {
    const ranked = [
      {
        gameId: 'NBA:game-4',
        market: 'Total Points',
        selection: 'Over 168.5',
        confidenceTier: 'TIER 1',
        kaiCall: 'BET',
        consensusEdge: 2.1
      },
      {
        gameId: 'NBA:game-4',
        market: 'Total Points',
        selection: 'Over 171.5',
        confidenceTier: 'TIER 2',
        kaiCall: 'BET',
        consensusEdge: 1.6
      },
      {
        gameId: 'NBA:game-4',
        market: 'Total Points',
        selection: 'Under 165.5',
        confidenceTier: 'TIER 3',
        kaiCall: 'BET',
        consensusEdge: 0.9
      }
    ];

    resolveTotalsConflicts(ranked);

    assert.equal(ranked[0].kaiCall, 'BET', 'best Over stays BET');
    assert.equal(ranked[1].kaiCall, 'BET', 'same-direction Over 171.5 survives the conflict');
    assert.equal(ranked[1].totalsConflictWith, undefined, 'same-direction row is not a conflict loser');
    assert.equal(ranked[1].confidenceTier, 'TIER 2', 'same-direction row is not demoted');
    assert.equal(ranked[2].kaiCall, 'CONSIDER', 'opposing Under is demoted');
    assert.equal(ranked[2].totalsConflictWith, 'Over 168.5');
  });

  it('keeps a bad execution row non-actionable and PASS', () => {
    const [row] = rankScreenRows(
      [
        {
          book: 'NoVigApp',
          league: 'Tennis',
          market: 'Moneyline',
          gameId: 'Tennis:PREMATCH:A:B:1',
          game: 'A vs B',
          selection: 'A',
          participant: 'A',
          selection1: 'A',
          participant1: 'A',
          selection1Id: 'Moneyline:A',
          selection2: 'B',
          participant2: 'B',
          selection2Id: 'Moneyline:B',
          allBookOdds: {
            NoVigApp: { odds1: -500, odds2: 350 },
            Pinnacle: { odds1: -120, odds2: 100 },
            Polymarket: { odds1: -125, odds2: 105 }
          }
        }
      ],
      {
        preferredBooks: ['NoVigApp', 'Pinnacle', 'Polymarket'],
        includeAll: true,
        limit: 10
      }
    );

    assert.equal(row.executionQuality, 'bad');
    assert.equal(row.isActionable, false);
    assert.equal(row.kaiCall, 'PASS');
    assert.equal(row.confidenceTier, 'TIER 4');
  });

  it('PASS rows cannot win or be demoted in a totals conflict', () => {
    const ranked = [
      {
        gameId: 'MLB:game-5',
        market: 'Total Runs',
        selection: 'Over 8.5',
        confidenceTier: 'TIER 2',
        kaiCall: 'BET',
        consensusEdge: 1.0
      },
      {
        gameId: 'MLB:game-5',
        market: 'Total Runs',
        selection: 'Under 9.5',
        confidenceTier: 'TIER 1',
        kaiCall: 'PASS',
        consensusEdge: 5.0
      }
    ];

    resolveTotalsConflicts(ranked);

    assert.equal(ranked[0].kaiCall, 'BET', 'BET row is not demoted by a PASS row');
    assert.equal(ranked[0].totalsConflictWith, undefined, 'PASS row never wins');
    assert.equal(ranked[1].kaiCall, 'PASS', 'PASS row stays PASS');
    assert.equal(ranked[1].confidenceTier, 'TIER 1', 'PASS row is not demoted');
    assert.equal(ranked[1].totalsConflictWith, undefined);
  });

  it('unknown-direction rows cannot win or be demoted in a totals conflict', () => {
    const ranked = [
      {
        gameId: 'NBA:game-6',
        market: 'Total Points',
        selection: 'Under 165.5',
        confidenceTier: 'TIER 1',
        kaiCall: 'BET',
        consensusEdge: 2.0
      },
      {
        gameId: 'NBA:game-6',
        market: 'Total Points',
        selection: 'Over 168.5',
        confidenceTier: 'TIER 2',
        kaiCall: 'BET',
        consensusEdge: 1.0
      },
      {
        gameId: 'NBA:game-6',
        market: 'Total Points',
        selection: 'Total 170',
        confidenceTier: 'TIER 1',
        kaiCall: 'BET',
        consensusEdge: 4.0
      }
    ];

    resolveTotalsConflicts(ranked);

    assert.equal(ranked[0].kaiCall, 'BET', 'Under 165.5 wins by consensus edge');
    assert.equal(ranked[1].kaiCall, 'CONSIDER', 'opposing Over is demoted');
    assert.equal(ranked[1].totalsConflictWith, 'Under 165.5');
    assert.equal(ranked[2].kaiCall, 'BET', 'unknown-direction row is untouched');
    assert.equal(ranked[2].confidenceTier, 'TIER 1', 'unknown-direction row is not demoted');
    assert.equal(ranked[2].totalsConflictWith, undefined, 'unknown-direction row does not win');
  });
});

describe('screen-ranker — steam originator provenance end-to-end', () => {
  // Simulate 3 sharp ORIGINATOR books (Pinnacle/Circa/BookMaker) all moving the
  // same direction within the steam window. The pipeline must carry
  // steamOriginatorCount through to the ranked row and surface it in rationale.
  const now = Date.now();
  const mk = (book, price) => ({ book, odds: price, time: new Date(now - 60 * 1000).toISOString() });
  const mk2 = (book, price) => ({ book, odds: price, time: new Date(now - 30 * 1000).toISOString() });

  const row = {
    book: 'NoVigApp',
    league: 'NBA',
    homeTeam: 'Lakers',
    awayTeam: 'Warriors',
    participant: 'Lakers',
    selection: 'Lakers',
    market: 'Moneyline',
    selection1: 'Lakers',
    participant1: 'Lakers',
    selection1Id: 'Moneyline:Lakers',
    selection2: 'Warriors',
    participant2: 'Warriors',
    selection2Id: 'Moneyline:Warriors',
    odds: -130,
    lineHistory: [
      mk('Pinnacle', -145),
      mk2('Pinnacle', -130),
      mk('Circa', -148),
      mk2('Circa', -131),
      mk('BookMaker', -150),
      mk2('BookMaker', -133)
    ],
    allBookOdds: {
      Pinnacle: { book: 'Pinnacle', odds1: -130, odds2: 110 },
      Circa: { book: 'Circa', odds1: -131, odds2: 111 },
      BookMaker: { book: 'BookMaker', odds1: -133, odds2: 113 },
      NoVigApp: { book: 'NoVigApp', odds1: -130, odds2: 110 }
    }
  };

  it('threads steamOriginatorCount and originator rationale through rankScreenRows', () => {
    const [ranked] = rankScreenRows([row], { preferredBook: 'NoVigApp', limit: 10, includeAll: true });
    assert.ok(ranked, 'row should rank');
    assert.equal(ranked.steamMove, true, '3 originators moving same direction = steam');
    assert.equal(ranked.steamBookCount, 3, '3 books moved');
    assert.equal(ranked.steamOriginatorCount, 3, 'all 3 are originators');
    assert.ok(
      String(ranked.rationale || '').includes('steam (3 books, 3 originator)'),
      `rationale should name originator steam, got: ${ranked.rationale}`
    );
  });
});
