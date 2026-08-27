# Project status and evaluation roadmap

PropProfessor MCP is a manual-first research and recordkeeping tool. It discovers and ranks market signals; it is not presented as an already validated win-probability model.

## Shipped and reproducible

- Local v2 ledger for scans, immutable decision-time candidate features, reviewed official bets, and settlements.
- Ledger-derived calibration and probability scoring. Reports can be rebuilt from the ledger instead of a second mutable calibration file.
- Offline settlement from caller-supplied result data with required provider/source provenance.
- Active documentation claim checks for registered tool count and retired tool names.

Run the complete offline lifecycle fixture:

```bash
node examples/record-settle-evaluate.js
```

It uses one synthetic bet and deliberately reports an insufficient-sample caveat.

## Hard limits

- Missing or ambiguous players produce unavailable coverage; names aren't guessed.
- Tiny samples don't support significance, calibration, or uplift claims. Reports must show sample and coverage before scores.
- No third-party tennis dataset is bundled. Local source data remains subject to its original license.
- Live scans stay user-triggered. Evaluation, examples, and tests are offline.

## Next evidence gates

1. Compare each source independently with Brier score, log loss, and calibration buckets.
2. Track coverage, CLV, and ROI only where the ledger contains the required decision and closing prices.
