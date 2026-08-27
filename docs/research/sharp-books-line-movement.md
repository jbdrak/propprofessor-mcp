# Sharp Books, Line Movement & Profitability — Research Notes

Research backing the sharp-book origin provenance feature
(`classifySharpBookOrigin`, `detectSteamMove` `originatorCount`, and the
risk-score steam weighting). Sources gathered 2026-08-26. These are
**signal-provenance** labels for our scoring, not win predictions.

## 1. Sharp books and Pinnacle as the fair-value reference

- Pinnacle is the sharpest mainstream book: margins ~**2%** vs 4-5% at retail
  books (DraftKings, FanDuel). It does not limit winners, so professional
  action trades there and its lines are the market's reference for fair odds.
  — betherosports.com (2026-05-15)
- "Pinnacle sets the sharpest odds... Use Pinnacle-anchored edge detection to
  find where soft sportsbooks lag." — theordsapi.com (2026-06-08)

**Originators** (move first on informed action): Pinnacle, Circa, BookMaker,
BetOnline, BetCRIS, Heritage.
**Followers** (copy the line seconds later): DraftKings, FanDuel, BetMGM,
Bet365. A confirmation from an originator is the stronger signal; a move seen
only at a follower may have already repriced.

## 2. Line movement — steam and reverse line movement (RLM)

- "Sharp bettors watch line movement for sharp-money signals: multi-book
  simultaneous moves (**steam**), lines moving opposite to public betting
  percentage (**reverse line movement**), and large single-book moves."
  — sharpapi.io (2026-04-16)
- RLM = "when a line moves away from the side receiving the majority of bets"
  — caused by "a bettor or group of bettors with the money and respect to move
  a line." — actionnetwork.com
- Steam = "sudden, uniform line shift across nearly every sportsbook at once,
  driven by heavy, coordinated syndicate action." — thebettingprofessionals.com
- "Sharps attack early — at the open, limits are low and a fresh line is at its
  most beatable. Then sharp money returns in the final window before lock."
  Ticket count is the crowd; **handle is the bankroll** — sharp action shows in
  dollars, not headcount. — dynatyze.com

## 3. Profitability and Closing Line Value (CLV)

- Case study of 5,000 NFL bets: CLV reached statistical significance at ~100
  bets; **win rate never reached significance over 5,012 bets**. CLV-ROI
  correlation r=0.91. +2.1% avg CLV = "genuine skill, not luck."
  — datafield.dev
- "Sustained positive CLV at Pinnacle is the gold standard of betting skill —
  and the only standard that survives without being limited. High CLV at soft
  books gets you banned; lower CLV at sharp books gets you a long career."
  — wagerlex.com
- "If your average CLV is X% over N bets... your expected ROI approaches X% as
  N grows large. Professional syndicates use CLV as their primary performance
  KPI." — evbets.app
- Academic backing: closing lines, after stripping vig, beat analyst
  projections / models on calibration (Levitt 2004; Snowberg & Wolfers 2010;
  Štrumbelj 2014). Beating the close consistently = extracting real value.

## 4. How this maps to the code

| Research finding                         | Code location                                                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Originator vs follower tiers             | `lib/propprofessor-sharp-books.js` — `SHARP_BOOK_ORIGIN_TIERS`, `classifySharpBookOrigin`, `isSharpOriginator`                            |
| Count originator books in a steam move   | `lib/propprofessor-steam-move.js` — `detectSteamMove` returns `originatorCount` (all return paths)                                        |
| Steam is the strongest future-CLV signal | `lib/propprofessor-risk-score.js` — steam modifier weighted: originator-confirmed `-2`, followers-only `-1`                               |
| Surface which book confirmed the move    | `buildRationale` (`steam (N books, M originator)`) and `computeMovementSummary` (names the confirming book for clean/bouncy/insufficient) |
| Agent-visible provenance                 | `lib/propprofessor-mcp-candidate-mapper.js` — carries `steamMove` / `steamBookCount` / `steamOriginatorCount`                             |

## Honesty note

CLV is a _leading indicator of skill_, not a guarantee of any single bet's
outcome. Most retail bettors run small-negative CLV. Our tool reports these
signals as signal-quality ratings, not win-probability predictions, and does
not claim profitability is proven for any specific play.
