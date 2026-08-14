# Project status and evaluation roadmap

PropProfessor MCP is a manual-first research and recordkeeping tool. It discovers and ranks market signals; it is not presented as an already validated win-probability model.

## Shipped and reproducible

- Passive MCP startup: no automatic PropProfessor screen or Elo refresh requests.
- Local v2 ledger for scans, immutable decision-time candidate features, reviewed official bets, and settlements.
- Ledger-derived calibration and probability scoring. Reports can be rebuilt from the ledger instead of a second mutable calibration file.
- Offline settlement from caller-supplied result data with required provider/source provenance.
- ATP/WTA-separated, surface-aware Tennis Moneyline Elo in **shadow context only**.
- Manual, license-aware Elo CSV importer with source hash, cutoff, import time, and model-version manifest.
- Active documentation claim checks for registered tool count and retired tool names.

Run the complete offline lifecycle fixture:

```bash
node examples/record-settle-evaluate.js
```

It uses one synthetic bet and deliberately reports an insufficient-sample caveat.

## Hard limits

- Elo supports Tennis Moneyline only. It does not model totals or handicaps.
- Elo context can't promote a play, alter `kaiCall`, change a tier, or override a final verdict.
- Missing or ambiguous players produce unavailable coverage; names aren't guessed.
- Historical bets without immutable decision-time probabilities or Elo aren't backfilled from current data.
- Tiny samples don't support significance, calibration, or uplift claims. Reports must show sample and coverage before scores.
- No third-party tennis dataset is bundled. Local source data remains subject to its original license.
- Live scans stay user-triggered. Evaluation, examples, and tests are offline.

## Next evidence gates

1. Accumulate settled Tennis Moneyline records with decision-time market, model, and Elo probabilities.
2. Compare each source independently with Brier score, log loss, and calibration buckets.
3. Track coverage, CLV, and ROI only where the ledger contains the required decision and closing prices.
4. Keep Elo shadow-only until chronological out-of-sample evidence shows stable incremental value on a meaningful sample.
5. Add totals or handicap models only with an appropriate score-distribution design, never by stretching plain Elo beyond Moneyline.
