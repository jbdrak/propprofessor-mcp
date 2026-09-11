# Market-Book Availability Matrix

**Source:** Live API investigation 2026-06-10
**Branch:** `release/v1.3.0-market-freshness-overhaul`

## How it works

`getSharpBookComparisonSet()` in `ssb-sharp-books.js` returns the comparison book set for a given league/market combination. For non-primary markets (Run Line, Puck Line, Total Goals, etc.), it now uses `ALT_MARKET_BOOKS` which includes FanDuel and other books that consistently post those markets.

## Availability by league and market

### MLB

| Market     | Books                                                              | Avg book count        |
| ---------- | ------------------------------------------------------------------ | --------------------- |
| Moneyline  | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel, BookMaker | ~5.5                  |
| Run Line   | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel, BookMaker | 2-14 (varies by line) |
| Total Runs | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel            | 2-14 (varies by line) |

### NBA

| Market       | Books                                                              | Avg book count       |
| ------------ | ------------------------------------------------------------------ | -------------------- |
| Moneyline    | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel, BookMaker | ~6.0                 |
| Spread       | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel, BookMaker | ~6.0                 |
| Total Points | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel            | 1-6 (varies by line) |

### NHL

| Market      | Books                                                              | Avg book count        |
| ----------- | ------------------------------------------------------------------ | --------------------- |
| Moneyline   | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel, BookMaker | ~5.5                  |
| Puck Line   | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel, BookMaker | 2-14 (varies by line) |
| Total Goals | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel            | 2-14 (varies by line) |

### WNBA

| Market       | Books                                                   | Avg book count |
| ------------ | ------------------------------------------------------- | -------------- |
| Spread       | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel | ~4.0           |
| Total Points | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel | ~4.0           |

### Soccer

| Market      | Books                                                   | Avg book count |
| ----------- | ------------------------------------------------------- | -------------- |
| Moneyline   | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel | ~5.5           |
| Spread      | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel | ~5.5           |
| Total Goals | Pinnacle, Circa, BetOnline, DraftKings, BetMGM, FanDuel | ~5.5           |

## consensusStrength field

Each ranked row now includes a `consensusStrength` field:

| Value      | Meaning               | Risk implication                 |
| ---------- | --------------------- | -------------------------------- |
| `strong`   | 3+ books agree        | Low risk — validated cross-book  |
| `moderate` | 2 books agree         | Medium risk — limited validation |
| `weak`     | 1 book (no consensus) | High risk — single source        |
| `none`     | 0 books               | No validation available          |

The `consensusBookCount` field (backward-compatible) still shows the raw number. `consensusStrength` is a human-readable classification of that number.

## Key observations

- **Main lines** (Moneyline, main Spread/Total) always have 5+ books → `strong`
- **Standard alt lines** (e.g., -1.5 Run Line, main Total) typically have 3-6 books → `strong`
- **Extreme alt lines** (e.g., -3.5 Run Line) may have only 1-2 books → `moderate` or `weak`
- **Pinnacle** is the primary source for alt lines; FanDuel and DraftKings are secondary
- **Circa** and **BetOnline** rarely post extreme alt lines

## Files changed

- `lib/ssb-sharp-books.js` — Added `ALT_MARKET_BOOKS` map and `getAltMarketBooks()` function
- `lib/screen-summary.js` — Added `classifyConsensusStrength()` and `computeWeightedConsensus()` functions
- `lib/screen-ranker.js` — Added `consensusStrength` field to ranked row output
