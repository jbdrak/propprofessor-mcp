# Backtesting the Tier System

This document explains how to validate that the PropProfessor confidence tier
system (TIER 1 – TIER 4) actually predicts outcomes.

## Purpose

The tier system ranks plays by confidence:

| Tier   | Meaning                                                      |
| ------ | ------------------------------------------------------------ |
| TIER 1 | Green movement grade + low risk score (≤ 2). Strongest play. |
| TIER 2 | Green grade + moderate risk, or low risk without green.      |
| TIER 3 | Moderate risk score (3–7), no red flags.                     |
| TIER 4 | Red movement grade or PASS kai call. Avoid.                  |

The backtest script checks whether TIER 1 plays actually hit more often than
TIER 4 plays. If they don't, the tier methodology needs revision.

## Running the script

```bash
node scripts/backtest.js [league] [market] [days]
```

### Arguments

| Argument | Default     | Description                          |
| -------- | ----------- | ------------------------------------ |
| league   | `MLB`       | League name (e.g. `NBA`, `Tennis`)   |
| market   | `Moneyline` | Market type (e.g. `Spread`, `Total`) |
| days     | `30`        | Lookback window in days              |

### Examples

```bash
# Default: MLB Moneyline, last 30 days
node scripts/backtest.js

# NBA Moneyline, last 7 days
node scripts/backtest.js NBA Moneyline 7

# Tennis, all markets
node scripts/backtest.js Tennis Moneyline 14
```

## Understanding the output

```text
Backtesting MLB Moneyline for the last 30 days... (ILLUSTRATIVE — synthetic output)

Tier		Total	Wins	Losses	Push	Hit Rate
----		-----	----	------	----	--------
TIER 1		12	8	3	1	72.7%
TIER 2		24	14	9	1	60.9%
TIER 3		18	7	10	1	41.2%
TIER 4		6	1	5	0	16.7%

✓ Backtest complete.
```

> The table above is an **illustrative sample of the output format**, not a
> real result. It does not come from settled bets and says nothing about
> profitability. The `/screen` endpoint returns live odds, not resolved
> outcomes, so the metric fields (Wins / Losses / Hit Rate here) are only
> populated when you supply a resolved snapshot yourself — see
> "Scoring real outcomes" below.

## Limitations

### The screen endpoint returns current odds, not historical results

The PropProfessor `/screen` endpoint is designed for live odds screening. It
does not expose a "settled bets" feed. When the script finds no resolved bets,
it exits with `reason: no_historical_data`.

This is expected behavior — the API is not a historical database.

### Workarounds

1. **Run periodically and persist snapshots.** Use `scripts/export-ranked-screen.js`
   to save daily snapshots, then resolve outcomes against a separate results
   feed (e.g. a sports data API).

2. **Use the screen-history module.** The `propprofessor-screen-history` module
   can persist line history. Combine it with a results resolver to build a
   local backtest dataset.

3. **Manual tracking.** Run the script daily, log the TIER assignments, then
   check outcomes manually after games settle.

## What to look for (on your own resolved data)

These thresholds apply once you have **real resolved outcomes** from snapshots
you tracked — they are NOT statements about the tool's profitability:

- **TIER 1 hit rate > 60%**: Your tracked sample differentiates well. The signal is doing its job as a quality rating.
- **TIER 1 hit rate ≈ TIER 3**: Tier system isn't differentiating in your sample. Review risk-score weights.
- **TIER 4 hit rate > TIER 2**: Red flags are wrong in your sample. Revisit movement grading.

> Profitability is **UNPROVEN**. No settled-results backtest has been published
> yet (a results pipeline is being built separately). Treat any hit-rate or
> ROI number as a candidate metric to validate yourself, not as proof of edge.

## Related files

- `scripts/backtest.js` — the CLI script
- `lib/propprofessor-risk-score.js` — tier calculation logic
- `lib/propprofessor-screen-utils.js` — row extraction
- `scripts/export-ranked-screen.js` — snapshot exporter for manual tracking
- `lib/propprofessor-backtest-metrics.js` — P&L / ROI / Sharpe / max-drawdown engine

## Scoring real outcomes (P&L / ROI / Sharpe / drawdown)

The synthetic script validates the _engine_. To score _real resolved
outcomes_, resolve a snapshot with per-play outcomes and run the metrics engine:

```bash
# 1. Capture a pre-game snapshot
node scripts/backtest.js --snapshot MLB Moneyline

# 2. After games settle, attach per-play outcomes to the snapshot file:
#    resolved.plays = [{ "participant": "Yankees", "odds": -140, "stake": 100, "result": "won" }, ...]

# 3. Score it
node scripts/backtest.js --metrics 2026-06-10-mlb-moneyline.resolved.json
```

`computeBacktestMetrics(plays)` returns:

| Field         | Meaning                                                 |
| ------------- | ------------------------------------------------------- |
| `profit`      | Net P&L in dollars (sum of per-play profit)             |
| `roi`         | `profit / totalStaked * 100`                            |
| `winRate`     | Decided bets won / (won + lost)                         |
| `sharpe`      | Mean per-play return ÷ sample stdev (null if < 2 plays) |
| `maxDrawdown` | Largest peak-to-trough drop in the cumulative P&L curve |

> The PropProfessor API does **not** provide historical settled results, so
> there is no bundled "profitable" history. Any published numbers must come
> from snapshots you resolved yourself.

## Daily snapshot + outcome-resolution pipeline (real P&L over time)

The hand-authored fixture validates the _engine_. To accrue _real_ metrics,
run the daily snapshot pipeline and resolve outcomes as games settle. This
writes a JSONL ledger (`data/snapshots.jsonl`) of every recommended play, then
attaches settled results so `computeBacktestMetrics` can score an ever-growing
history.

### 1. Capture a daily snapshot

```bash
# Default provider = live handlers.recommended_bets, writes data/snapshots.jsonl
node scripts/daily-snapshot.js

# Limit leagues / write to a custom file (also accepts --market)
node scripts/daily-snapshot.js --leagues NBA,MLB --out /tmp/snap.jsonl
```

Each line captures: `playId` (stable sha256 of gameId+selection+market+book),
`gameId`, `selection`, `market`, `league`, `book`, `odds`, `tier`, `kaiCall`,
`screenScore`, `timestamp` (ISO), and `result` (absent until resolved). The
script is **idempotent per UTC day** — re-running it in the same UTC day will
not duplicate a `playId` already snapshotted today. It is **mock-friendly**:
`takeDailySnapshot({ getPlays })` accepts an injected play source, so it is
fully testable without network access.

### 2. Resolve outcomes (CSV fallback — reliable, no live endpoint needed)

The PropProfessor API does **not** expose a settled-results feed, so the
pipeline is designed around a manual CSV you maintain:

```bash
# columns: playId,result  (result ∈ win|loss|push; optional odds,stake)
node scripts/resolve-outcomes.js --csv results.csv
```

The CSV's `playId` column must match the `playId` emitted by the snapshot.
Unresolved plays get `result` + `resolvedAt` written back into the ledger
_in place_. Plays whose `playId` is absent from the CSV stay unresolved.

> Optional live path: `--live` calls an injected `liveGetPlayResult(play)`
> resolver. There is no built-in client method for settlement today, so live
> resolution only runs when a resolver is supplied. The CSV path is the
> supported default.

### 3. Score the resolved history with the metrics engine

```js
const { computeBacktestMetrics } = require('./lib/propprofessor-backtest-metrics');
const { resolveOutcomes, ledgerToPlays } = require('./scripts/resolve-outcomes');

const { rows } = await resolveOutcomes({ inFile: 'data/snapshots.jsonl' });
const plays = ledgerToPlays(rows); // -> [{ odds, stake, result: 'won'|'lost'|'push' }]
const m = computeBacktestMetrics(plays);
// m.profit, m.roi, m.sharpe, m.maxDrawdown, m.winRate ...
```

`ledgerToPlays` translates the snapshot's canonical `win|loss|push` vocabulary
into the engine's `won|lost|push`. Run this after each resolution to watch
P&L / ROI / Sharpe / max drawdown accrue as your real settled results accumulate.

### Files

- `scripts/daily-snapshot.js` — JSONL snapshot capture (idempotent, mock-friendly)
- `scripts/resolve-outcomes.js` — CSV (and optional live) outcome resolution, in place
- `data/snapshots.jsonl` — the append-only play ledger (created on first run)
- `test/pipeline.test.js` — end-to-end test (mocked plays → CSV resolve → metrics)
