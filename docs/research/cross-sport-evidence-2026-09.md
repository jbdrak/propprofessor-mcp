# Cross-Sport Evidence Addendum

Updated: 2026-09-06

This addendum records a small verified evidence pass for the multi-sport evaluation layer. These papers support measurement and feature design. They do not establish that any particular betting strategy is profitable.

## Basketball: calibration before accuracy

Walsh and Joshi study NBA betting models and report that, on average and in the best case, selecting a predictive model by calibration rather than accuracy produces greater profits.[1] The paper also treats full Kelly as too aggressive and evaluates a conservative fractional-Kelly alternative.[1]

**Repo mapping:** Keep Brier score, log loss, and reliability metrics beside hit rate and ROI.[1] Do not promote a model or tier because of accuracy alone.[1] Keep bankroll-target tracking separate from probability quality and do not turn a target into an automatic sizing rule.[1]

## Basketball: possession-level state value

Cervone, D'Amour, Bornn, and Goldsberry define expected possession value as the expected points at the end of a possession, using a stochastic process over continuous player movement and discrete events such as shots and turnovers.[2] Their hierarchical spatiotemporal specification shares information across players, and the paper reports that shrinkage improved log-likelihood relative to the corresponding no-shrinkage configuration.[2]

**Repo mapping:** Treat pace and raw points-per-game as summaries, not complete possession models.[2] If future basketball features are added, preserve the possession context and sample-size/shrinkage provenance rather than presenting a sparse player rate as a stable edge.[2]

## NFL and NCAAF: home advantage needs segmentation

Benz, Bliss, and Lopez use nearly two decades of NFL, NCAA, and high-school football data in a uniform analysis of American-football home advantage.[3] The scope itself supports separating NFL and college calibration and avoiding an unexplained single home-field constant across leagues and eras.[3]

**Repo mapping:** Preserve league, venue/home-away identity, era or season, and kickoff-relative timestamp in the decision snapshot.[3] Evaluate NFL and NCAAF home-field effects in separate chronological segments before changing a spread baseline.[3]

## NHL: expected goals and low-scoring variance

Macdonald's NHL expected-goals paper notes that low scoring makes goals noisy, compares goals with shots, Fenwick, and Corsi, and reports models using additional variables such as faceoffs and hits that outperform earlier models on mean squared error.[4] It also uses ridge regression for adjusted plus-minus estimates based on expected goals and other inputs.[4]

**Repo mapping:** Keep goalie identity/quality separate from skater chance generation, and don't treat raw goals or shot volume as interchangeable with expected chance quality.[4] Any future NHL feature should retain the training window and regularization/provenance metadata so sparse samples aren't mistaken for stable skill.[4]

## Limits

These sources motivate evaluation fields and context gates. They do not prove a positive expected value for a PropProfessor signal, a sportsbook, or a particular market. The repository should require chronological, segment-level validation before changing rank weights or sizing logic.

## Sources

[1] Walsh, C. and Joshi, A., _Machine learning for sports betting: should model selection be based on accuracy or calibration?_ https://arxiv.org/abs/2303.06021
[2] Cervone, D., D'Amour, A., Bornn, L., and Goldsberry, K., _A Multiresolution Stochastic Process Model for Predicting Basketball Possession Outcomes_ https://arxiv.org/pdf/1408.0777
[3] Benz, L. S., Bliss, T. J., and Lopez, M. J., _A comprehensive survey of the home advantage in American football_ https://arxiv.org/abs/2401.16392
[4] Macdonald, B., _An Expected Goals Model for Evaluating NHL Teams and Players_ http://hockeyanalytics.com/Research_files/NHL-Expected-Goals-Brian-Macdonald.pdf
