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

## Basketball: pace-neutral efficiency and shot quality

A modern Four Factors analysis describes offensive rating through shooting, turnover, offensive-rebound, and free-throw factors rather than raw points per game.[5] Its conclusion supports using the factor set as a compact team-quality representation, while the earlier possession-value paper shows why context and shrinkage matter when moving below box-score summaries.[2][5]

**Repo mapping:** Preserve possession estimates, pace-neutral offensive/defensive efficiency, and factor provenance separately from raw scoring. Treat any shot-quality proxy as an additional feature, not as a replacement for calibration.

## American football: drive-level uncertainty

Baldwin et al. argue for drive-level expected points rather than treating individual plays as independent epochs, and their evaluation explicitly preserves drive dependency and uncertainty.[6]

**Repo mapping:** NCAAF/NFL context should preserve drive/season scope and uncertainty metadata. A fourth-down or pace overlay should be gated by resampled confidence, not a single point-estimate win-probability difference.[6]

## NHL: skill-adjusted goaltending

Noel's skill-adjusted NHL expected-goals model separates shooter and goaltender skill, including location and situation, and reports better log loss, Brier score, and ROC-AUC than its baseline, with improvements as high as 5% in the reported experiments.[7]

**Repo mapping:** A confirmed goalie field should not be reduced to raw save percentage. If goalie quality is modeled later, preserve shooter/goalie skill scope and the evaluation metric used for the comparison.[7]

## Soccer: dependence, draws, and red-card shocks

Karlis and Ntzoufras report that bivariate Poisson models improve fit and draw prediction over independent Poisson models, with diagonal inflation improving draw estimation further.[10] A separate open-access hazard-rate study models a red card as a shift in goal-scoring rate, so red-card effects belong in live state transitions rather than a fixed pre-match adjustment.[8]

**Repo mapping:** Keep soccer 1X2, exact-score, and totals calibration separate. Preserve competition scope and treat red cards as timestamped live context; don't inject a generic pre-match red-card penalty.[8][10]

## Tennis: surface is a real context variable

An open-access analysis of women's Grand Slam matches reports statistically significant cross-surface differences in point-distribution categories, with the exception of service side.[9]

**Repo mapping:** Keep surface-specific serve/return features distinct from blended tour rates. If surface data is missing, mark the context unresolved instead of silently using a generic tennis prior.[9]

## NCAAF: transfer-portal roster context

Kovar and Bame-Aldred's working paper compares 2022-23 transfer and recruit production using PFF grades and reports position-specific results: transfer quarterbacks outperform recruits in their sample, while recruits outperform transfers at some defensive positions, including linebacker.[11] That is not a universal transfer premium, and the paper is not a substitute for a league-season holdout test.[11]

Dohrn and Lopez study 124 Division I quarterback transfers around the 2018-19 season. Their extracted results show post-transfer changes in quarterback passing production, while destination national rank and winning-percentage comparisons do not support a blanket team-performance upgrade.[12]

The NCAA says transfer decisions affect academic progress and athletic eligibility and provides division-specific guides and transfer windows.[13] The cfbfastR transfer-portal schema exposes season, position, origin, destination, transfer date, rating, stars, and eligibility status, which is the minimum useful provenance for a roster-change feature.[14]

**Repo mapping:** Add NCAAF transfer context as a timestamped, position-weighted uncertainty input: incoming/outgoing counts, position, prior production, transfer rating, origin/destination, transfer date, eligibility status, and QB continuity.[11][12][13]

Require an eligibility/roster-resolution gate before treating a transfer as available, and widen uncertainty when the portal data is incomplete.[13][14]

Do not award a fixed edge for transfer volume alone.[11][12]

## NCAAF: continuity, availability, and early-season uncertainty

The Indiana University Sports Innovation Institute describes a tiered, pre/post-transfer methodology for relating roster transfer share to player and team performance.[15] The extracted page exposes the research design but not the full result tables, so it is useful as a data-layout and hypothesis source, not as a numeric betting edge.[15]

CBS's 2026 returning-snap dataset explicitly says its continuity metric is not position-weighted and does not account for incoming transfers.[17] That makes it a useful raw input, but not a sufficient preseason prior by itself.

A related peer-reviewed coaching-transition paper is retained for follow-up only; this pass did not extract its result details, so no coaching-change rule is based on it.[16]

**Repo mapping:** Preserve transfer-adjusted returning production, position group, roster turnover, eligibility status, and kickoff-relative information age as separate fields. Widen uncertainty when continuity ignores incoming transfers or when eligibility, injuries, or depth-chart changes remain unresolved.[15][17]

## Limits

These sources motivate evaluation fields and context gates. They do not prove a positive expected value for a PropProfessor signal, a sportsbook, or a particular market. The repository should require chronological, segment-level validation before changing rank weights or sizing logic.

## Sources

[1] https://arxiv.org/abs/2303.06021
[2] https://arxiv.org/pdf/1408.0777
[3] https://arxiv.org/abs/2401.16392
[4] http://hockeyanalytics.com/Research_files/NHL-Expected-Goals-Brian-Macdonald.pdf
[5] https://arxiv.org/html/2305.13032
[6] https://arxiv.org/html/2409.04889v1
[7] https://arxiv.org/abs/2511.07703
[8] https://doi.org/10.1007/s00181-017-1287-5
[9] https://pmc.ncbi.nlm.nih.gov/articles/PMC9266198
[10] https://doi.org/10.1111/1467-9884.00366
[11] https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4722358
[12] https://scholarcommons.sc.edu/context/jiia/article/1304/viewcontent/NCAA_20Transfer_20Portal__Examining_20Quarterback_Transfer_Outcomes_20in_College_20Football.pdf
[13] https://www.ncaa.org/eligibility-center/transfer-rules-and-eligibility
[14] https://cfbfastr.sportsdataverse.org/reference/cfbd_recruiting_transfer_portal.html
[15] https://blogs.iu.edu/iuindysii/2024/05/15/ncaa-transfer-portal-analysis
[16] https://journals.ku.edu/jis/article/view/21131
[17] https://www.cbssports.com/college-football/news/college-football-returning-snap-percentages-2026
