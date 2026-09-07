# Multi-Sport Modeling Evidence

Updated: 2026-09-06

This document records research inputs for PropProfessor's multi-sport evaluation work. These sources inform fields, gates, and evaluation design. They do **not** prove that a particular strategy is profitable.

## Cross-sport evaluation

### Calibration beats raw accuracy

Sports betting models should be evaluated with strictly proper probability metrics such as Brier score and log loss, plus reliability bins. Accuracy/hit rate ignores price and confidence.

- Machine learning for sports betting: should model selection be based on accuracy or calibration?
  - https://www.sciencedirect.com/science/article/pii/S266682702400015X
- CEPR Discussion Paper 19486: sports-market efficiency tests depend on correct probability normalization.
  - https://cepr.org/publications/dp19486

**Repo mapping:** `lib/propprofessor-backtest-metrics.js` already contains Brier, log loss, and calibration bins. Evaluation must segment these metrics by sport, market, price band, and book before changing rank weights.

### CLV is a leading signal, not a guarantee

Closing-line movement is useful for judging whether a decision beat the later market, but it must be compared against closing probability and recorded chronologically. CLV cannot replace matchup validation or turn a scan label into a win probability.

- Levitt (2004), _Why are Gambling Markets Organised So Differently from Financial Markets?_
  - https://www.jstor.org/stable/3590076
- Research summary on closing-line efficiency and CLV:
  - https://datafield.dev/sports-betting-textbook/part-03/chapter-11/case-study-02.html

**Repo mapping:** preserve decision-time odds, closing odds, movement source, and timestamp separately. Never feed settlement or closing-only fields into the decision feature snapshot.

### Chronological validation is mandatory

Walk-forward evaluation is safer than random train/test splits for markets whose information set changes over time. A high hit rate can still lose at bad prices; a small positive ROI can be noise.

**Repo mapping:** ledger evaluations need explicit decision timestamps, settlement timestamps, sample-size flags, drawdown, and segment-level reports.

## Tennis

### Format is a hard gate

Men's Grand Slam singles are best-of-five; women's singles and most other tour singles are best-of-three. Derive match probabilities from set-win probabilities using the correct format. Do not reuse a best-of-three total-game model for a men's Slam match.

- ITF Grand Slam Rulebook 2026:
  - https://www.itftennis.com/media/5986/grand-slam-rulebook-2026-f2.pdf
- Tinbergen Institute dynamic ATP forecasting paper:
  - https://papers.tinbergen.nl/18009.pdf
- ATP report: Shelton defeated Tsitsipas 6-2, 6-3, 6-4 at the 2026 US Open.
  - https://www.atptour.com/en/news/shelton-tsitsipas-us-open-2026-r4

### Serve/return estimates need opponent adjustment and shrinkage

Raw season hold/break rates are not enough. Opponent strength, surface, sample size, and current fitness need to be represented. Bayesian or hierarchical shrinkage is preferable for small samples.

- Gollub (2021), _Forecasting serve performance in professional tennis matches_:
  - https://journals.sagepub.com/doi/10.3233/JSA-200345

**Repo mapping:** sport context should carry format, surface, round, recent match length, fatigue/injury status, and source timestamp. Total-game models should derive scoreline distributions instead of trusting movement labels alone.

## MLB

Use pitcher-batter matchup distributions, handedness, lineup order, recent form with shrinkage, weather, and bullpen state. Run-expectancy/state-transition models are more appropriate than raw team runs per game.

- _A data-driven method for in-game decision making in MLB_:
  - https://dl.acm.org/doi/10.1145/2487575.2487660
- Latent-class Markov model for pitcher/batter/base-out states:
  - https://www.jstage.jst.go.jp/article/tqs/7/2/7_69/_pdf/-char/en

**Repo mapping:** lineup, starting pitcher, weather, and bullpen context must be timestamped and marked unresolved when unavailable.

## NBA / WNBA / NCAAB

Normalize team strength per possession. Totals should start with projected possessions multiplied by opponent-adjusted offensive/defensive efficiency, then incorporate availability, rest, pace interaction, and matchup style.

- NBA official stats glossary:
  - https://www.nba.com/stats/help/glossary
- Ken Pomeroy ratings explanation and glossary:
  - https://kenpom.com/blog/ratings-explanation/
  - https://kenpom.com/blog/ratings-glossary/
- Expected possession value research:
  - https://arxiv.org/pdf/1408.0777

**Repo mapping:** raw points-per-game fields should not be treated as interchangeable with possession-normalized ratings. NBA/WNBA availability must be a first-class timestamped context field.

## NFL / NCAAF

Availability and market timing matter. Inactives and late injury news can move prices close to kickoff. Key-number crossings, especially around 3 and 7, deserve explicit line identity and not generic spread treatment. College leagues need separate calibration from NFL.

- NFL market visibility and line-movement study:
  - https://link.springer.com/article/10.1007/s12197-023-09656-5

**Repo mapping:** preserve line, key-number status, kickoff-relative timestamp, and inactive-news state. Do not pool NFL and NCAAF calibration buckets without evidence.

## NHL

Starting goalie confirmation is a material variable and often arrives only near the game. Goal scoring is low-frequency and is naturally modeled with Poisson/Markov-style processes, while special teams and goalie identity matter.

- Sportlogiq starting-goalie model:
  - https://www.sportlogiq.com/2020/08/07/elementor-2557/
- NHL goal/win probability paper:
  - https://ww2.amstat.org/meetings/proceedings/2015/data/assets/pdf/233899.pdf

**Repo mapping:** goalie confirmation must be separate from generic injury context and must not be marked known from a stale probable-starter field.

## Soccer / MLS

Soccer requires three-way win/draw/loss treatment. Poisson/Dixon-Coles-style goal models are a useful baseline, but lineup, competition scope, and draw calibration must be preserved.

- Dixon-Coles model overview and original-paper references:
  - https://exprysm.com/insights/methodology/dixon-coles-model.html

**Repo mapping:** keep `Soccer` as the backend sport identity while preserving exact `leagueName` competition scope. Never collapse draw/no-draw markets into generic two-way labels.

## UFC / MMA

UFC models should be opponent-specific and sparse-data aware. Attack/defense skill decomposition, bout format, weight class, replacement status, weigh-in/weight-cut news, and finish-method distributions matter. Pre-fight accuracy and live-round prediction are different tasks and need separate evaluation.

- FightTracker real-time UFC prediction research:
  - https://doi.org/10.48550/arxiv.2312.11067
- Markov-chain MMA forecasting paper/data description:
  - https://prod-dcd-datasets-public-files-eu-west-1.s3.amazonaws.com/05bdcbd7-50e1-4f75-95e5-693192fd2708

**Repo mapping:** replacement and weight-cut context must be explicit. Do not treat a live model's in-round accuracy as evidence for pre-fight moneyline profitability.

## Use and caveats

- Search snippets are discovery, not evidence; use the linked paper/page content before relying on a claim.
- Academic results vary by era, league, book, market, and data availability.
- Niche props and low-liquidity markets may be less efficient but have higher variance and worse execution.
- The repository still needs resolved multi-sport data before any rank/tier weight change can be justified.
