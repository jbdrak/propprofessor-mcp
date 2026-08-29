# EV-First Discovery Implementation Plan

> **For Hermes:** Implement only after James approves this plan. Keep PropProfessor traffic manual-only.

**Goal:** Make the existing Positive EV board the primary discovery source for normal scan/recommendation flows, without promoting stale EV rows directly to bets.

**Architecture:** Keep `ev_candidates` as the existing upstream EV-board adapter and make it the first attempt inside the league screen path. Normalize EV rows into the existing candidate shape, then run the same exact validation, movement, price, date, and playability gates. If the EV endpoint is empty, unavailable, or fails validation, fall back to the screen path. Preserve source metadata so output can say `screen` versus `ev_board`.

**Tech Stack:** Node.js CommonJS, native `node:test`, existing PropProfessor API/client and ranker.

---

### Task 1: Characterize the current EV and scan contracts

**Files:**
- Inspect only: `scripts/server/handlers/discovery.js`, `scripts/server/handlers/screen-leagues.js`, `scripts/server/handlers/aggregate-screen.js`, `lib/validate-ev-candidates.js`, relevant tests.

**Verification:** Run the existing focused EV and quick-screen tests. Record current response fields, incomplete-scan markers, and the existing dirty worktree. Do not overwrite the two pre-existing modified files: `lib/propprofessor-wallet-plays.js` and `test/wallet-plays.test.js`.

### Task 2: Add a pure EV recovery/merge seam

**Files:**
- Create or modify the smallest existing handler utility module near `scripts/server/handlers/`.
- Test: new focused `node:test` file.

**Behavior:**
- Detect recovery eligibility from explicit `includeEv` or a trustworthy incomplete/truncated screen response.
- Normalize EV rows without changing American odds.
- Preserve `evBoardValue`, `evBoardSource`, original event identity, line, side, and source metadata.
- Deduplicate using game + market + exact selection + numeric line, not only game + selection.
- Never make EV rows actionable by themselves.

### Task 3: Wire EV-first discovery into the normal scan path

**Files:**
- Modify `scripts/server/handlers/screen-leagues.js` or the existing orchestration seam that owns one league/market screen call.
- Modify `scripts/server/handlers/aggregate-screen.js` only if aggregate recovery belongs there.
- Test: focused integration-style handler test with a fake client.

**Behavior:**
- Keep the current screen request as the fallback path.
- Issue one bounded EV-board request before the screen request for the same league/market/date window.
- Use the full comparison-book set for EV calculation, then preserve the requested execution book for validation.
- Fall back to screen only when EV returns no matching rows or cannot validate them.
- Re-apply all caller filters after merge: movement, tiers, `onlyBets`, date/card window, limit, and preferred-book/playability gates.
- Return metadata: `evRecoveryAttempted`, `evRecoveryAdded`, `evRecoveryDropped`, and a safe reason when recovery was skipped or failed.
- Do not add a cron, watcher, polling loop, or automatic recurring refresh.

### Task 4: Prevent stale EV rows from masking better current rows

**Files:**
- Modify `lib/validate-ev-candidates.js` or the shared reconciliation seam only if tests identify a gap.
- Test: regression cases for stale EV + fresh screen, fresh EV + screen truncation, exact-line mismatch, and alternate-line dedupe.

**Behavior:**
- Exact current quote and event identity remain authoritative.
- An EV percentage is discovery context, not a final win-probability claim.
- If exact validation fails, preserve the row only as unresolved/watch metadata, never as an official bet.
- If screen and EV rows represent the same exact market, prefer the fresher exact quote while retaining the EV source value for diagnostics.

### Task 5: Improve user-facing diagnostics

**Files:**
- Modify the existing response metadata/formatter path only as needed.
- Add or update docs/reference note explaining the EV-board recovery behavior.

**Behavior:**
- Make incomplete scans visibly distinct from true zero-result scans.
- State how many EV candidates were recovered and how many survived exact validation.
- Never imply the EV board is sharp movement or a guaranteed probability.

### Task 6: Verification

Run, in order:

```bash
npm test -- --test-name-pattern='ev_candidates|quick_screen|scan|ranked-screen'
npm test
npm run lint
npm run check:types
npm run check:circular
npm run check:claims:quick
npm run check:secrets
```

Then run one bounded manual CLI probe, only if needed, against the current PP account. Report upstream timeout/degradation separately from local test results. Do not commit or push.

---

## Acceptance criteria

- A truncated/incomplete normal scan can recover the Prairie View-style EV rows through the existing EV endpoint.
- Recovered rows still require exact event, line, current quote, pregame, liquidity, and research gates.
- Standard markets are not dropped merely because they came from the EV board.
- Alternate lines remain filtered by market policy, not by price alone.
- Exact duplicate rows do not appear twice.
- A genuine empty slate remains distinguishable from an incomplete scan.
- No scheduled PropProfessor traffic is introduced.
- Existing tests and the full suite pass, or failures are reported honestly.
