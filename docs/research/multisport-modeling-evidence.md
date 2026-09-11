# Multi-Sport Modeling Evidence

Updated: 2026-09-06

This document records research inputs for SSB's multi-sport evaluation work. These sources inform fields, gates, and evaluation design. They do **not** prove that a particular strategy is profitable.

A separately cited 2026 evidence addendum covers verified basketball, football, and NHL findings: [`cross-sport-evidence-2026-09.md`](./cross-sport-evidence-2026-09.md).

## Cross-sport evaluation

### Calibration beats raw accuracy

Sports betting models should be evaluated with strictly proper probability metrics such as Brier score and log loss, plus reliability bins. Accuracy/hit rate ignores price and confidence.

- Machine learning for sports betting: should model selection be based on accuracy or calibration?
  - https://www.sciencedirect.com/science/article/pii/S266682702400015X
- CEPR Discussion Paper 19486: sports-market efficiency tests depend on correct probability normalization.
  - https://cepr.org/publications/dp19486

**Repo mapping:** `lib/ssb-backtest-metrics.js` already contains Brier, log loss, and calibration bins. Evaluation must segment these metrics by sport, market, price band, and book before changing rank weights.

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

### Prediction-market prices are time-dependent

A 2026 prediction-market study using 23 million moneyline trades reports that calibration changes by time-to-expiry, with sharper distortions near settlement, and that cross-game parlays can have a separate product-level markup. This is relevant to NoVig/exchange-style prices: evaluate them by time-to-expiry and product type instead of treating every displayed percentage as a static probability.

- _Prices, Probabilities, and Parlays: Systematic Bias in Sports Prediction Markets_:
  - https://arxiv.org/html/2607.14430v1

**Repo mapping:** preserve decision-to-start/settlement timing and product type in evaluation rows. Do not pool near-expiry exchange quotes with earlier pregame quotes when measuring calibration or CLV.

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

Macdonald's expected-goals work treats scoring as sparse/noisy and evaluates shot-quality measures rather than raw goals alone.[4] A skill-adjusted shooter/goaltender expected-goals paper reports better performance than its baseline when shooter and goalie skill are modeled, while noting that the skill component is relatively small.[29]

A weighted-shots paper uses logistic regression to estimate the probability that a shot becomes a goal, then uses those weighted shots to evaluate goalies, skaters, and teams.[30]

**Updated repo mapping:** preserve goalie identity, shooter/goalie skill scope, shot-quality features, training window, regularization, and model version separately. Do not treat raw goals, raw shots, or unconfirmed goalies as stable probabilities.[29][30]

## Soccer / MLS

Soccer requires three-way win/draw/loss treatment. Poisson/Dixon-Coles-style goal models are a useful baseline, but lineup, competition scope, and draw calibration must be preserved.

- Dixon-Coles model overview and original-paper references:
  - https://exprysm.com/insights/methodology/dixon-coles-model.html

**Repo mapping:** keep `Soccer` as the backend sport identity while preserving exact `leagueName` competition scope. Never collapse draw/no-draw markets into generic two-way labels.

Dixon and Coles fit a parametric score model to English league and cup data from 1992-95, motivated in part by possible inefficiencies in the football betting market.[31] The practical repo rule is to preserve low-score dependence and validate win/draw/loss calibration separately from totals rather than using independent Poisson scores by default.[31]

Titman, Gregory-Smith, and Paton report that expected goals outperformed raw goals and shots across nearly every evaluation in their top-five-league study, using rolling prior-match inputs.[35] The result supports xG as a strength feature, not as proof of betting ROI.

Red-card research models the expulsion as a match-state change, not a generic team-strength penalty.[33] Later elite-soccer work studies red and yellow cards as time-varying performance shocks.[32] Apply asymmetric, timestamped live adjustments only after the event is confirmed; do not backfill a pre-match feature from a later card.[32][33]

**Updated repo mapping:** keep competition, lineup, draw, card timestamp, score state, and market phase separate. A red card should invalidate or re-price the live state while leaving the original pre-match snapshot frozen.[32][33]

## UFC / MMA

UFC models should be opponent-specific and sparse-data aware. Attack/defense skill decomposition, bout format, weight class, replacement status, weigh-in/weight-cut news, and finish-method distributions matter. Pre-fight accuracy and live-round prediction are different tasks and need separate evaluation.

- FightTracker real-time UFC prediction research:
  - https://doi.org/10.48550/arxiv.2312.11067
- Markov-chain MMA forecasting paper/data description:
  - https://prod-dcd-datasets-public-files-eu-west-1.s3.amazonaws.com/05bdcbd7-50e1-4f75-95e5-693192fd2708

**Repo mapping:** replacement and weight-cut context must be explicit. Do not treat a live model's in-round accuracy as evidence for pre-fight moneyline profitability.

## Fresh evidence pass: soccer, NHL, UFC, and MLB

The following sources were re-checked in a separate web-research pass. These
are evaluation inputs, not claims of betting profitability.

### Soccer / MLS

- Karlis and Ntzoufras' bivariate-Poisson work shows that small dependence
  between competing scores can materially change win/draw/loss probabilities;
  independent Poisson models can understate common draw scores. Validate 1X2
  calibration separately from totals calibration.
  - https://doi.org/10.1111/1467-9884.00366
- MLS publishes an official per-club Player Availability Report with
  OUT/QUESTIONABLE designations. Snapshot it with competition scope and
  confirmed squad information rather than treating a stale roster as current.
  - https://www.mlssoccer.com/league-reports/player-availability-report/

### NHL

- MoneyPuck's pregame model separates goaltending from scoring-chance inputs
  and reports goalie quality metrics such as GSAx/60 and save percentage. Keep
  goalie confirmation as its own timestamped context field.
- Its model also emphasizes shot quality and dependent rebound/flurry effects,
  so raw shots or Corsi alone shouldn't stand in for chance quality.
  - https://moneypuck.com/about.htm

**Caveat:** the MoneyPuck page was extract-verified only in part; search-snippet
figures about home ice and back-to-backs are intentionally not treated as
verified repo rules.

### UFC / MMA

- Short-notice replacement win rates in the reviewed source cluster around
  37-42%, but the samples are confounded by replacement quality, prior booking,
  notice length, and price. Log those fields instead of treating replacement as
  an automatic fade or upgrade.
  - https://agentmma.com/mma-lab/ufc-short-notice-replacement-win-rate
- FightTracker reports roughly 80% accuracy for a round-level, in-fight model,
  which is not evidence for pre-fight moneyline precision. Keep live and
  pre-fight evaluation separate and widen uncertainty for sparse pre-fight data.
  - https://arxiv.org/pdf/2312.11067v1
- Official weigh-in status, catchweight/division, and scheduled rounds change
  the contract being modeled. Preserve those fields before final pricing.
  - https://agentmma.com/mma-lab/ufc-weight-classes-explained

**Caveat:** the replacement and weigh-in pages are secondary sources; the
peer-reviewed FightTracker paper is the stronger modeling source.

### MLB

- FanGraphs distinguishes FIP from ERA and xFIP from FIP: xFIP regresses
  home-run rate toward league-average HR/FB, while xFIP- is needed for
  cross-park/league comparisons. Preserve FIP/xFIP/xFIP- as different fields.
  - https://library.fangraphs.com/pitching/fip/
  - https://library.fangraphs.com/pitching/xfip/
- Baseball Savant's Statcast Park Factors use a 100 = average scale and control
  for batter/pitcher handedness. Use the actual venue factor, not generic park
  reputation.
  - https://baseballsavant.mlb.com/leaderboard/statcast-park-factors

**Caveat:** the cited pages support the metric definitions and park-factor
methodology. Official probable-pitcher timing, bullpen workload, weather, and
umpire effects still need separate timestamped sources before becoming model
features.

## Use and caveats

- Search snippets are discovery, not evidence; use the linked paper/page content before relying on a claim.
- Academic results vary by era, league, book, market, and data availability.
- Niche props and low-liquidity markets may be less efficient but have higher variance and worse execution.
- The repository still needs resolved multi-sport data before any rank/tier weight change can be justified.

## Sources

[4] http://hockeyanalytics.com/Research_files/NHL-Expected-Goals-Brian-Macdonald.pdf
[29] https://arxiv.org/pdf/2511.07703
[30] https://ar5iv.labs.arxiv.org/html/1205.1746
[31] https://www.jstor.org/stable/2986290
[32] https://doi.org/10.1007/s10479-022-04733-0
[33] http://hdl.handle.net/1871/12468
[35] https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0282295
