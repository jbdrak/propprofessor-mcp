# Ranking Methodology

This document is the deep dive on how the ranking pipeline assigns a tier and a risk score to every play. The README has a [brief summary](../README.md#how-the-ranking-works); this is the full math.

## Overview

The system assigns every play a **tier** (1–4) and a **risk score** (1–10). The pipeline runs in 5 steps:

1. **Grade the movement** (green / yellow / red)
2. **Score the risk** (1–10 weighted factors)
3. **Assign the raw tier** (lookup table)
4. **Apply hysteresis** (prevent tier thrashing)
5. **Cross-reference sharp books** (filter target-book noise)

After all 5 steps, the play is exposed via 27 MCP tools with the tier, risk score, kaiCall (`BET` / `CONSIDER` / `PASS`), and a human-readable rationale string.

---

## Step 1: Grade the movement

Each play gets a **movement grade**: green, yellow, or red.

### Green grade (all must be true)

- Supportive movement direction (sharp books moving the same way)
- High movement quality (score ≥ 0.8)
- Acceptable execution quality (best or playable)
- Strong consensus (5+ books agree)
- Strong steam signal or high movement quality
- Positive CLV (closing line value proxy)
- Sustained agreement across 4+ of 6 time windows (1h, 2h, 6h, 12h, 24h, 48h)

### Red grade (any of)

- Adverse movement direction
- Bad execution quality AND thin consensus (1 book or fewer)

### Yellow grade (default)

Everything that isn't red and doesn't meet all green criteria. This is the most common grade — it means the play has some signal but the conditions aren't all clean.

---

## Step 2: Score the risk

A weighted score, base 5, modified by:

| Factor                | Modifier |
| --------------------- | -------- |
| Movement green        | −2       |
| Movement red          | +3       |
| Edge > 2%             | −1       |
| Edge > 0.5%           | 0        |
| Edge > 0%             | +1       |
| Edge ≤ 0% or missing  | +2       |
| Consensus ≥ 10 books  | −1       |
| Consensus 5–9 books   | 0        |
| Consensus 3–4 books   | +1       |
| Consensus 1–2 books   | +2       |
| Consensus 0 books     | +3       |
| Execution best        | −1       |
| Execution playable    | 0        |
| Execution bad/unknown | +2       |
| Supportive steam      | −1       |
| Adverse steam         | +3       |
| CLV > 2%              | −1       |
| CLV > 0%              | −0.5     |
| CLV > −1%             | 0        |
| CLV > −3%             | +1       |
| CLV ≤ −3%             | +2       |
| Peak adverse < −3%    | +2       |
| Peak adverse < −2%    | +1       |
| Multi-window ≥ 0.83   | −1       |
| Multi-window ≥ 0.66   | −0.5     |
| Multi-window ≥ 0.50   | 0        |
| Multi-window ≤ 0.33   | +0.5     |
| Multi-window ≤ 0.16   | +1       |
| Multi-window = 0.0    | +1.5     |
| Multi-window no data  | 0        |

An edge of `-999` is the sentinel for "no edge data available" — it maps to the +2 penalty.

Final score is clamped to **1 (cleanest) to 10 (riskiest)** and rounded.

**How to read the score:**

- **1–2:** very clean signal, all dimensions firing
- **3–4:** good signal, a couple of minor flags
- **5–6:** mixed signal, some flags present
- **7–10:** noisy or conflicting signal, multiple flags

---

## Step 3: Assign the tier

| Grade                | Risk score | Tier                          |
| -------------------- | ---------- | ----------------------------- |
| Green                | ≤ 2        | TIER 1                        |
| Green                | 3–4        | TIER 2                        |
| Green                | 5–6        | TIER 2 (promoted from TIER 3) |
| Green                | 7+         | TIER 3                        |
| Yellow               | ≤ 4        | TIER 2                        |
| Yellow               | 5–6        | TIER 3                        |
| Yellow               | 7+         | TIER 4                        |
| Red or PASS kai call | any        | TIER 4                        |

**Dead zones:** the green promotion at risk 5–6 (yellow would say TIER 3, green upgrades to TIER 2) is a deliberate choice — a clean movement signal can overcome a moderate risk score.

**Hard overrides:** red grade or PASS kai call always → TIER 4, regardless of risk score.

---

## Step 4: Hysteresis

`getConfidenceTierStable()` wraps the raw tier in a hysteresis layer so a play doesn't bounce between TIER 2 and TIER 3 every time odds shift by 1 cent. The stable tier only updates if:

- The raw tier differs by 2+ levels from the cached tier, OR
- The risk score moves by 3+ points since last assignment

Plus a **2-hour rolling window** — the returned tier is the mode of all raw tiers observed in the last 2 hours, which captures the trajectory.

**Implementation note:** the tier cache and score timeline are module-level globals in `lib/propprofessor-risk-score.js`. Any batch test (backtest, eval suite) calling the ranking pipeline repeatedly MUST call `clearTierCache()` + `clearScoreTimeline()` per iteration, else the hysteresis carries over and the test converges to TIER 4. (This was the bug behind v1.5.5's "99% TIER 4 plays" symptom.)

---

## Step 5: Sharp book cross-reference

For `quick_screen` with `mode: "sharp"` or a `targetTiers` filter, each play is cross-referenced against individual sharp book screens (Pinnacle, Circa, BookMaker, BetOnline). A play only gets "Bet candidate" status if a non-target sharp book **independently** shows supportive movement on the same game+selection. This filters out target books whose own self-sourced movement is unreliable.

The cross-reference happens against the four sharpest non-target books. If at least one of them independently moved in the same direction as the target book, the play is marked as having independent sharp confirmation.

---

## The kaiCall

The kaiCall is a one-word summary. **In v1.6.0's pivot, treat it as a signal-quality rating, not a recommendation:**

| kaiCall    | Meaning                                              |
| ---------- | ---------------------------------------------------- |
| `BET`      | Strong signal across all dimensions. TIER 1 + clean. |
| `CONSIDER` | TIER 2 with acceptable risk. Worth looking at.       |
| `PASS`     | TIER 3/4, or red flags present. Skip.                |

**Important:** `BET` here means "the signal data is strong and the algorithm is confident about what it's flagging" — NOT "you should place this bet." The pivot to sharp-money signal feed (v1.6.0) reframes the kaiCall as a signal-quality rating.

---

## What this means in practice

When the system flags a TIER 1 play, you can trust that:

- Multiple sharp books are moving in a coordinated direction (not noise)
- The target book is meaningfully stale (positive edge was real at one point)
- The risk factors (steam, consensus, execution quality) all line up

When the system flags a TIER 4 play, you can trust that:

- The signal is unreliable (adverse movement, bad execution, thin consensus)
- The kaiCall will be `PASS`
- This is the inverse — TIER 4 ≤ TIER 2 hit rate holds (v1.5.1 fix)

What you **can't** trust from the system alone: that any flagged play will win. The TIER 1 hit rate is ~50% on a 580-play synthetic sample — essentially chance on outcomes. The signal is reliable; the outcome prediction is not.

---

## Source code references

- Tier + risk score: [`lib/propprofessor-risk-score.js`](../lib/propprofessor-risk-score.js)
- Ranking logic: [`lib/screen-ranker.js`](../lib/screen-ranker.js)
- Tool definitions: [`lib/propprofessor-tool-definitions.js`](../lib/propprofessor-tool-definitions.js)
- Backtest: [`scripts/backtest-synthetic.js`](../scripts/backtest-synthetic.js)
- Backtest methodology: [`BACKTESTING.md`](./BACKTESTING.md)

---

## Design Notes

### Steam direction contract

The steam move signal (`steamMove`, `steamDirection`) is computed by `detectSteamMove` in `lib/propprofessor-steam-move.js` and consumed by `calculateRiskScore`. The direction is relative to the current pick's selection. `calculateRiskScore` only penalizes steam when `steamDirection === 'adverse'` — null or undefined directions receive no penalty. The contract is implicit (the detector returns `null` when it can't determine direction), not validated by the consumer.

### Staking: Kelly-inspired, not mathematically rigorous

The `suggestStakes` function uses flat tier multipliers (TIER 1 → 2%, TIER 2 → 1%, TIER 3 → 0.5%) scaled by `edgeFactor` and `clvFactor`, but does not incorporate the actual odds value into the stake calculation. A true Kelly Criterion would use `edge / (decimalOdds - 1)`. The current approach is intentionally simpler — "Kelly-inspired fractional staking" suitable for casual use, not mathematical portfolio optimization.

### Multi-window threshold

The green movement grade gate requires `multiWindowScore >= 0.66` (4/6 windows). The risk score modifier uses graduated brackets (0.0 → +1.5 through 1.0 → −1.5). The gate is intentionally coarser than the risk modifier — a play with 3/6 windows falls to yellow grade but gets no risk penalty, which is correct: the signal is weaker but not actively adverse.

### kaiCall/tier consistency

The `gradeRiskToTierAndCall` function is the single source of truth for tier and kaiCall assignment. Both `getKaiCall` and `getConfidenceTier` delegate to it, making contradiction between tier and call structurally impossible. The focus-book-missing cap (TIER 4 → TIER 3, PASS → CONSIDER for the kaiCall) is the only divergence — it acknowledges that a non-executable signal is weaker but still informative.
