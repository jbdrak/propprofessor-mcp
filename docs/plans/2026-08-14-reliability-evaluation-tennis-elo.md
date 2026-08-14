# Reliability, Evaluation, and Tennis Elo Implementation Plan

> **For Hermes:** Use `subagent-driven-development` to implement this plan task-by-task. Use focused Hermes subagents, strict TDD for behavior changes, spec review before quality review, and controller-run final verification. Do not commit, push, publish, restart Hermes, or make live PropProfessor screen calls unless James separately asks.

**Goal:** Remove account/data-safety risks, make settled results usable for honest evaluation, add surface-aware tennis Elo as a shadow Moneyline context signal, remove core validation-pipeline duplication, improve test speed, and repair public documentation/portfolio credibility.

**Architecture:** Preserve the existing manual-only scan workflow and public tool behavior. Make the v2 ledger the authoritative evaluation source, store immutable decision-time feature snapshots, derive calibration reports from settled ledger records, and keep Elo isolated behind a pure module plus a manually refreshed versioned snapshot. Elo must not change consensus edge, tier, or verdict until chronological evaluation proves incremental value.

**Tech stack:** Node.js CommonJS, native `node:test`, c8, ESLint, Prettier, TypeScript check mode, GitHub Actions.

## Non-negotiable constraints

- No scheduled or startup screen polling.
- No live PP screen calls during tests or verification.
- No fabricated Elo values or silent player-name guesses.
- ATP and WTA ratings stay separate.
- Elo v1 applies only to Tennis Moneyline.
- Missing/ambiguous/stale Elo returns explicit unavailable metadata.
- Existing records remain readable; migrations must be additive.
- No prediction-performance claim without point-in-time out-of-sample evidence.
- No commit, push, npm publish, tag, release, or gateway restart.

---

## Phase 1: Account and local-data safety

### Task 1.1: Remove automatic PP startup prewarm

**Objective:** Starting the MCP server must make zero automatic PropProfessor screen requests.

**Files:**

- Modify: `scripts/propprofessor-mcp-server.js`
- Modify or retire: `lib/propprofessor-prewarm.js`
- Modify: `lib/mcp-runtime-config.js`
- Test: `test/propprofessor-prewarm.test.js`
- Test: `test/propprofessor-mcp-server.test.js`

**TDD:**

1. Add a server-start regression test that injects a screen client and proves initialization makes zero screen calls.
2. Run the targeted test and verify RED.
3. Remove startup invocation and make any retained prewarm helper explicitly manual-only.
4. If the helper remains, clear/unref timeout handles and abort in-flight work on timeout.
5. Run targeted tests and verify GREEN.

**Acceptance:** Startup is passive regardless of `PROPPROFESSOR_MCP_PREWARM`; no hidden opt-out is required.

### Task 1.2: Isolate signal-calibration tests from real user data

**Objective:** Tests must never read, wipe, back up, or restore `~/.propprofessor/signal-calibration.json`.

**Files:**

- Modify: `lib/propprofessor-signal-calibration.js`
- Modify: `test/propprofessor-signal-calibration.test.js`

**TDD:**

1. Add a failing test for `PP_SIGNAL_CALIBRATION_FILE` override.
2. Point the test suite at a `mkdtemp` path before requiring the module.
3. Delete real-home backup/restore logic.
4. Verify targeted tests pass with the real file hash unchanged.

**Acceptance:** Forced test termination cannot damage user calibration data.

### Task 1.3: Make recovery paths portable and remove author-machine leakage

**Objective:** Packaged error messages and defaults must work outside James's Mac.

**Files:**

- Modify: `lib/propprofessor-mcp-stdio.js`
- Modify: `lib/propprofessor-source-authority.js`
- Test: matching stdio/source-authority tests

**TDD:**

1. Add regressions rejecting `/Users/jamesdrake` and private Hermes script paths in public recovery text.
2. Use package-relative login paths or stable installation documentation.
3. Use `os.homedir()` or explicit env override for optional watchlist lookup; unavailable local skill files degrade cleanly.
4. Verify no tracked public source contains `/Users/jamesdrake` outside historical plan/changelog context.

---

## Phase 2: Evaluation foundation

### Task 2.1: Define immutable decision-time feature snapshots

**Objective:** Every newly recorded candidate can preserve the signals available when the decision was made.

**Files:**

- Modify: `lib/record-ledger.js`
- Modify: `lib/record-candidates.js`
- Modify: `lib/record-card.js`
- Test: corresponding record-ledger/candidate/card tests

**Fields:**

- `modelVersion`
- `signalTier` / legacy confidence alias
- movement disposition and validation state
- consensus edge and supporting-book count
- execution and no-vig market probabilities when known
- surface and event level
- nested Elo snapshot when available

**Rules:** Snapshot is additive, immutable after record creation, and optional for migrated records.

### Task 2.2: Derive calibration from the settled v2 ledger

**Objective:** Settling a v2 ledger record must make it visible to evaluation without maintaining a second mutable truth store.

**Files:**

- Create: `lib/record-evaluation.js`
- Modify: `lib/record-settlement.js`
- Modify: `lib/propprofessor-signal-calibration.js` only as a compatibility adapter
- Modify: `scripts/review-record.js` if needed
- Test: new and existing settlement/calibration tests

**TDD vertical slices:**

1. Settled snapshot produces tier/movement calibration counts.
2. Push/void/open records are excluded correctly.
3. Migrated records without snapshots appear as explicit `insufficient_data`, not fabricated rows.
4. Legacy calibration API retains its response shape while reading derived data.

**Acceptance:** One authoritative persisted record path; derived reports are reproducible from ledger contents.

### Task 2.3: Add honest evaluation metrics and report command

**Objective:** Produce reproducible descriptive metrics without overstating the current sample.

**Files:**

- Modify: `lib/propprofessor-backtest-metrics.js`
- Create or modify: `scripts/backtest-tennis-elo.js`
- Modify: `package.json`
- Test: synthetic chronological fixtures

**Metrics:** sample size, coverage, Brier score, log loss, calibration buckets, agreement/disagreement outcomes, CLV where closing data exists, ROI only where actual prices and settlement exist.

**Acceptance:** Empty/tiny samples return caveats; no significance or improvement claim is generated automatically.

---

## Phase 3: Tennis Elo shadow model

### Task 3.1: Build a pure surface-aware Elo engine

**Objective:** Compute deterministic ATP/WTA overall and surface ratings from chronological match rows.

**Files:**

- Create: `lib/tennis-elo.js`
- Test: `test/tennis-elo.test.js`

**Behavior:**

- Separate ATP and WTA pools.
- Chronological updates only.
- Overall plus hard/clay/grass ratings.
- Explicit configurable constants with version metadata.
- Probability conversion from rating gap.
- No totals or handicap prediction API.

**TDD cases:** expected winner/loser update, symmetry, surface isolation, chronology rejection/sort contract, ATP/WTA isolation, newcomer behavior, deterministic output.

### Task 3.2: Add a manual, source-verifiable snapshot builder

**Objective:** Produce a versioned static Elo snapshot without network activity at MCP runtime.

**Files:**

- Create: `scripts/refresh-tennis-elo.js`
- Create: `lib/tennis-elo-data/README.md`
- Create: snapshot manifest/schema; generated large data remains gitignored unless licensing and size are appropriate
- Modify: `.gitignore` if needed
- Test: importer fixtures

**Source gate:**

- Verify source license, coverage, date fields, player identifiers, surfaces, ATP/WTA/Challenger coverage, and update stability before adding an automatic downloader.
- If no stable licensable source passes, ship a CSV/JSON importer with documented schema and no bundled third-party data.
- Never scrape at server startup.

**Acceptance:** Manual command writes atomically, records source/as-of/hash/model version, and rejects malformed/future-leaking rows.

### Task 3.3: Resolve players safely

**Objective:** Match PP player names to Elo identities without silent last-name collisions.

**Files:**

- Create: `lib/tennis-player-resolver.js` or keep the resolver private in `tennis-elo.js` if small
- Reuse: `lib/propprofessor-tennis.js` mappings
- Test: collision, accents, initials, suffixes, missing players

**Rules:** exact normalized full name first; explicit alias second; ambiguous last-name-only match is unavailable.

### Task 3.4: Attach Elo to tennis context and fallback rows

**Objective:** Surface Elo as context for Tennis Moneyline without changing ranking or verdicts.

**Files:**

- Modify: `lib/propprofessor-tennis-context.js`
- Modify: `lib/tennis-fallback.js`
- Modify: candidate/formatter modules only where required
- Test: tennis context/fallback/handler integration tests

**Output:** overall/surface/blended ratings, selection win probability, market fair probability when calculable, disagreement, coverage, match count, last match date, as-of, staleness, model version.

**Acceptance:** Elo never modifies `consensusEdge`, `signalTier`, `kaiCall`, or final verdict in v1.

---

## Phase 4: Core validation seam and test runtime

### Task 4.1: Extract the duplicated validate/cache/merge pipeline

**Objective:** `quick_screen` and legacy/internal recommendation paths use one parameterized implementation.

**Files:**

- Create: `lib/propprofessor-validation-pipeline.js`
- Modify: `scripts/server/handlers.js`
- Test: direct pipeline tests plus handler integration

**Approach:** Move only the duplicated validation race/cache/apply workflow and pure verdict transforms. Preserve public response shapes and cache-key semantics. Do not broadly split the whole handler monolith.

### Task 4.2: Profile and remove artificial test waits

**Objective:** Reduce suite wall time without weakening timeout behavior.

**Files:** targeted slow test files and injectable timing seams only.

**Order:**

1. Re-measure after prewarm removal.
2. Fix real leaked handles/fake latency first.
3. Use injectable clocks/timeouts where tests currently wait real seconds.
4. Raise test concurrency only after home-directory file coupling is removed.

**Acceptance:** Same or higher test count and assertions; no production timeout reductions made solely to speed tests.

---

## Phase 5: Documentation, packaging honesty, and portfolio signal

### Task 5.1: Repair public claim drift

**Files:**

- `README.md`
- `docs/METHODOLOGY.md`
- `docs/AGENT_PROMPT.md`
- `docs/HERMES_SKILL.md`
- `docs/RELEASES.md`
- `SECURITY.md`
- `CONTRIBUTING.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `INSTALL.md` only if needed
- `scripts/check-claims.js`

**Verified facts to encode:** 31 active tools; `sharp_plays` is retired as a registered tool and represented by `quick_screen({mode:'sharp'})`; full tests are auth-free; current version line is 2.9.x; npm registry currently returns E404 for `propprofessor-mcp`.

**Rules:** Avoid volatile exact test/coverage/book counts unless `check:claims` validates them. Clarify that release automation is publish-ready but the package is not presently available from npm.

### Task 5.2: Add an end-to-end fixture example and roadmap/status

**Objective:** Show the automation loop and honest evaluation story without live credentials.

**Files:**

- Create: `examples/record-settle-evaluate.js` and fixture data, or a smaller existing-pattern equivalent
- Create/update: concise roadmap/status document
- Modify: README links
- Test: example smoke test

**Flow:** fixture candidate -> record with decision snapshot -> settle -> derive evaluation -> print caveated report.

### Task 5.3: Expand drift checks

**Objective:** CI catches retired-tool references and stale canonical claims in active documentation.

**Files:**

- Modify: `scripts/check-claims.js`
- Test: `test/check-claims.test.js`

**Acceptance:** Historical changelog/release archives are exempted deliberately; active docs fail on forbidden live-tool claims.

---

## Phase 6: Integration review and delivery gate

1. Run targeted tests after each slice.
2. Run parse/load checks for every changed CommonJS module.
3. Run:
   - `npm test`
   - `npm run test:coverage`
   - `npm run lint`
   - `npm run format:check`
   - `npm run check:types`
   - `npm run check:circular`
   - `npm run check:claims`
   - `npm run check:secrets`
   - `npm run check:publish-tree`
4. Run the Elo engine and importer against synthetic fixtures only unless a verified data source passes the source gate.
5. Run the end-to-end record/settle/evaluate fixture.
6. Verify the real calibration file hash is unchanged.
7. Verify no server-start test performs a PP request.
8. Dispatch final Hermes integration reviewer for spec compliance, then code-quality/security review.
9. Review `git diff`, test-count deltas, generated files, and placeholder sweep.
10. Leave the working tree uncommitted. Do not push, publish, tag, or restart.

## Parallelization map

- **Wave A, parallel:** startup/prewarm safety; calibration test isolation; portable recovery paths.
- **Wave B, serial dependency:** ledger snapshots -> derived evaluation -> report metrics.
- **Wave C, parallel after schemas stabilize:** pure Elo engine; source/importer spike; player resolver.
- **Wave D, serial dependency:** Elo context integration after engine/resolver.
- **Wave E, parallel:** validation-pipeline extraction; docs/claim cleanup; test-runtime profiling.
- **Wave F:** end-to-end example, final integration review, controller quality gate.

Subagents touching the same files must run sequentially. The controller owns merges/reconciliation and all final verification.
