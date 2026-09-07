# Sagarin NCAAF Benchmark - 2026-09-06

Updated: 2026-09-06

## Purpose

This is a short out-of-sample-style snapshot check of Jeff Sagarin's public college-football predictions.[20] It is a benchmark read, not evidence that Sagarin creates positive expected value.[20]

The source was fetched on 2026-09-06 from Sagarin's College Football Ratings page.[20] The page's visible ratings heading still said “through games of August 29,” but its `Predictions_with_Totals_and_Moneylines` rows contained the Sep. 3-6 slate.[20] That stale heading is a source-freshness warning, so the snapshot timestamp and the exact selected method must be stored with any future evaluation.[20]

The evaluation used the regular `Predictions_with_Totals_and_Moneylines` block, not the separate experimental home-away-adjusted block.[20] Final scores came from ESPN's dated college-football scoreboard feeds for Sep. 3 and 4.[21] The Sep. 5 and 6 final scores came from the corresponding dated feeds.[23]

## Verified result

- Sagarin rows in the snapshot: 118.[20]
- Rows matched to an independently verified final score: 90.[20][21][23]
- Unmatched rows excluded from the denominator: 28.[20][21][23]
- Winner predictions correct: 81 of 90, or 90.0%.[20][21][23]
- Predicted-total mean absolute error: 12.6903 points.[20][21][23]
- Per-team predicted-score mean absolute error: 10.2560 points.[20][21][23]

Daily split:

- Sep. 3: 9-2, 81.8%; total MAE 12.9464; per-team score MAE 10.9464.[20][21]
- Sep. 4: 8-0, 100.0%; total MAE 8.6312; per-team score MAE 5.9969.[20][22]
- Sep. 5: 63-5, 92.6%; total MAE 12.9937; per-team score MAE 10.4292.[20][23]
- Sep. 6: 1-2, 33.3%; total MAE 15.7000; per-team score MAE 15.1567.[20][24]

The Sep. 6 misses were meaningful: Sagarin projected Wisconsin over Notre Dame.[20]

It projected Louisville over Ole Miss.[20]

It did get Washington over Washington State correct.[24]

This is why the full-week 90% winner rate should not be presented as a stable model estimate.[20]

The nine matched misses were Rutgers-Massachusetts, Georgia Tech-Colorado, Charlotte-The Citadel, Hawai'i-UNLV, Western Kentucky-Nevada, Oklahoma State-Tulsa, Utah State-Idaho State, Notre Dame-Wisconsin, and Ole Miss-Louisville.[20][23] The list mixes FBS and FCS games and includes large score misses, so a future report must segment competition level and favorite size.[20]

The 28 excluded rows were not counted as losses.[20]

Most were FCS games absent from the selected ESPN scoreboard response; one row was a game without a completed result in the feed.[21][23]

The evaluator must preserve `unmatched` as a separate status rather than silently dropping or grading those rows.[20]

## What the research says

Fair and Oster found that computer ranking systems contain useful information for predicting college-football outcomes, but their combined ranking information added no useful information once the final Las Vegas point spread was included.[28] Their long-run winner accuracy figures are not a direct estimate of this Sagarin snapshot, but they support using the closing market as the primary benchmark.

Coleman's 2025 metamodel uses chronological training/validation and later test seasons. The reported test winner accuracy for the metamodel was 74.14%, slightly above the compared lines, but the paper reports no statistically significant difference among the predictions and the lines.[27] That is the right standard for Sagarin too: a short hit-rate spike is not enough.

Arscott's college-football market-efficiency work finds that team totals and spreads contain score information and can show censoring bias, but that result concerns market construction and a long historical sample, not Sagarin's rating output.[26]

## Repo decision

Sagarin should be stored as an external benchmark feature, not wired directly into live `BET` eligibility.

Required fields for a future adapter:

- source URL and retrieval timestamp;
- prediction snapshot timestamp and season;
- selected method: regular or experimental;
- game date, neutral/home status, predicted scores, predicted total, and probability if available;
- result-source URL and final-score timestamp;
- competition level, market, price band, and matched/unmatched status;
- closing line, de-vigged market probability, CLV, Brier score, log loss, ROI, and drawdown when market data exists.

Evaluation must be chronological and segmented by FBS/FCS, favorite size, market, season phase, and price band. Sagarin's winner accuracy must not be converted into a betting edge without a market-relative test. The current 90-game snapshot is descriptive only.

## Sources

[20] http://sagarin.com/sports/cfsend.htm
[21] https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=20260903&limit=500
[22] https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=20260904&limit=500
[23] https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=20260905&limit=500
[24] https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=20260906&limit=500
[26] https://ideas.repec.org/a/sae/jospec/v24y2023i5p664-689.html
[27] https://journals.sagepub.com/doi/10.1177/22150218251365223
[28] http://depot.som.yale.edu/icf/papers/fileuploads/2377/original/02-35.pdf
