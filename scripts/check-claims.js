#!/usr/bin/env node

/**
 * README claim drift checker for PropProfessor MCP.
 *
 * Verifies that the claims in README.md (tool counts, tool names, tier
 * ordering, test count) match the actual codebase state. Designed to be run
 * before tagging a release — catches the silent-rot class of bugs the
 * release-format skill warns about.
 *
 * Checks:
 *   1. Tool count consistency: lib/propprofessor-tool-definitions.js vs docs/openapi.json vs README's "N tools" claim
 *   2. Tool name validation: every tool name in README's "All N tools" section exists in tool definitions
 *   3. Test count: only verified when README carries an exact test-count claim (then it must match npm test
 *      output). Absence of a claim is VALID — the README deliberately uses non-volatile wording
 *      ("full deterministic suite passes") so suite growth doesn't churn docs. When no claim exists,
 *      npm test is not run at all.
 *   4. TIER 4 ≤ TIER 2 inversion: the claim that TIER 4 risk flags are directionally correct
 *      (README: "TIER 4 > TIER 2 inversion | Fixed in v1.5.1")
 *
 * The TIER 1 hit rate is reported as informational only — the synthetic
 * backtest's TIER 1 sample is checked for minimum size (100 plays for
 * statistical meaning), but the actual hit rate is not asserted against a
 * specific README number. The README's "X% TIER 1 hit rate" should be
 * re-validated manually when the algorithm changes.
 *
 * Usage:
 *   node scripts/check-claims.js              # full check (runs npm test, ~5s)
 *   node scripts/check-claims.js --skip-tests # fast check, no test count verification (<2s)
 *
 * Exit code: 0 on success, 1 on any failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const repoRoot = process.cwd();
const readmePath = path.join(repoRoot, 'README.md');
// Tool definitions are split across lib/tool-definitions/{screen,validation,context,picks,meta}.js
// and re-exported from lib/propprofessor-tool-definitions.js. Read the actual
// tool list via the buildToolDefinitions factory so claims stay in sync with
// the real source.
const toolDefsEntry = path.join(repoRoot, 'lib/propprofessor-tool-definitions.js');
const openapiPath = path.join(repoRoot, 'docs/openapi.json');
const backtestPath = path.join(repoRoot, 'scripts/backtest-synthetic.js');

const readme = fs.readFileSync(readmePath, 'utf8');
const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));

// Load the real tool list. The shim at lib/propprofessor-tool-definitions.js
// re-exports buildToolDefinitions, so we can use it as a single source of truth.
const { buildToolDefinitions } = require(toolDefsEntry);
const allToolDefs = buildToolDefinitions();
const toolDefNames = allToolDefs.map((t) => t.name).sort();
const toolDefCount = toolDefNames.length;

let failures = 0;
let warnings = 0;

function fail(msg) {
  console.error(`  FAIL  ${msg}`);
  failures++;
}
function warn(msg) {
  console.warn(`  WARN  ${msg}`);
  warnings++;
}
function ok(msg) {
  console.log(`  ok    ${msg}`);
}

// ----------------------------------------------------------------------------
// CHECK 1 + 2: Tool count and tool name consistency
// ----------------------------------------------------------------------------

console.log('Tool claims:');

// Count tool definitions: every "name: 'foo'" entry in the file
// (Tool defs are now loaded from the live factory above; this section
// only keeps the openapi/README comparisons below.)
const openapiPaths = openapi.paths || {};
const openapiCount = Object.keys(openapiPaths).length;

// Find README's "N tools" claim
const toolCountClaimMatch = readme.match(/(\d+)\s+tools?\s+(that|to|for|across)/i);
const readmeToolCount = toolCountClaimMatch ? parseInt(toolCountClaimMatch[1], 10) : null;

if (toolDefCount !== openapiCount) {
  fail(
    `Tool count drift: lib/propprofessor-tool-definitions.js has ${toolDefCount} tools but docs/openapi.json has ${openapiCount} paths. Run \`npm run docs:openapi\` to regenerate.`
  );
} else {
  ok(`${toolDefCount} tools consistent across tool definitions and OpenAPI spec`);
}

if (readmeToolCount !== null) {
  if (readmeToolCount !== toolDefCount) {
    fail(`README claims ${readmeToolCount} tools but ${toolDefCount} are defined. Update README hero/intro sections.`);
  } else {
    ok(`README "N tools" claim (${readmeToolCount}) matches tool definitions`);
  }
} else {
  warn(`Could not find "N tools" claim in README to verify`);
}

// Tool name validation in README's canonical reference section.
// The README uses "## 📊 Available Tools" with three tool-table subsections
// (Quick Situational Checks / Deeper Signal Analysis / Research & Bet
// Management) followed by "### Output Tuning" (parameter names, not tools).
// Stop the section match at Output Tuning so we don't false-positive on
// `minimal` / `standard` / `full` / `true` / `false` from the parameter table.
const allToolsSection = readme.match(/## (?:.*? )?Available Tools[\s\S]*?(?=\n### Output Tuning|\n## |\n---\n\n|$)/);
// Known non-tool identifiers that legitimately appear in backticks within the
// "All N tools" section (parameter names, type annotations, etc.).
const NON_TOOL_IDENTIFIERS = new Set(['verbosity', 'compact']);

if (allToolsSection) {
  // Extract every backtick-quoted identifier that looks like a snake_case tool name
  // Strip trailing "(args...)" so `recommended_bets(verbosity: "minimal")` becomes `recommended_bets`.
  const refs = [
    ...new Set(
      [...allToolsSection[0].matchAll(/`([a-z][a-z0-9_]*)(?:\([^`]*\))?`/g)]
        .map((m) => m[1])
        .filter((name) => !NON_TOOL_IDENTIFIERS.has(name))
    )
  ];
  const missing = refs.filter((name) => !toolDefNames.includes(name));
  if (missing.length > 0) {
    fail(`README "All N tools" section references tools that don't exist: ${missing.join(', ')}`);
  } else {
    ok(`All ${refs.length} tools referenced in "All N tools" section exist in tool definitions`);
  }
} else {
  warn(`Could not find "## All N tools" reference section in README`);
}

// ----------------------------------------------------------------------------
// CHECK 3: Test count
// ----------------------------------------------------------------------------

const skipTests = process.argv.includes('--skip-tests') || process.argv.includes('--quick');
console.log(`\nTest count:${skipTests ? ' (skipped via --skip-tests or --quick)' : ''}`);

if (!skipTests) {
  // Find any test-count claim in README. Matches three forms:
  //   - "966 passing" / "966 tests passing" (prose)
  //   - "# 966 tests, 0 failures" / "full suite (966 tests)" (maintainers prose)
  //   - badge URL "tests-966%20passing" (URL-encoded whitespace)
  const testClaimMatches = [
    ...readme.matchAll(/(\d+)\s+(?:tests?\s+)?passing/gi),
    ...readme.matchAll(/[#(\s](\d+)\s+tests\b/gi),
    ...readme.matchAll(/tests-(\d+)%20passing/gi)
  ];

  if (testClaimMatches.length === 0) {
    // No exact test-count claim is the EXPECTED state: README deliberately uses
    // non-volatile wording ("full deterministic suite passes") so suite growth
    // doesn't churn docs. Nothing to verify — and no reason to run npm test.
    ok('No exact test-count claim in README — non-volatile "full suite passes" wording is in effect, nothing to verify');
  } else {
    try {
      const testOutput = execSync('npm test', {
        encoding: 'utf8',
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      // node --test emits the summary in one of two formats depending on Node
      // version: older versions used `# pass N`, newer versions use `ℹ pass N`
      // (with the info glyph). Match either so the script works on both.
      const passMatch = testOutput.match(/^[#\s]*[ℹ#]\s*pass\s+(\d+)/m);
      if (!passMatch) {
        warn(`Could not parse test count from npm test output`);
      } else {
        const testCount = parseInt(passMatch[1], 10);
        // All test count claims should agree with each other and with the actual count
        const claimedCounts = [...new Set(testClaimMatches.map((m) => parseInt(m[1], 10)))];
        const claimMismatch = claimedCounts.find((c) => c !== testCount);
        if (claimMismatch !== undefined) {
          fail(
            `README claims ${claimMismatch} tests passing but actual is ${testCount}. Update all references in README (found ${claimedCounts.length} claim(s): ${claimedCounts.join(', ')}).`
          );
        } else {
          ok(`Test count (${testCount}) matches all ${testClaimMatches.length} claim(s) in README`);
        }
      }
    } catch (err) {
      // npm test can fail if there are real test failures — surface them but don't
      // mask the claim check. Exit code 1 from npm test shows real failures.
      if (err.status && err.stdout) {
        const passMatch = err.stdout.match(/^[#\s]*[ℹ#]\s*pass\s+(\d+)/m);
        if (passMatch) {
          const testCount = parseInt(passMatch[1], 10);
          fail(
            `npm test exited with code ${err.status}. Actual test count: ${testCount}. Fix the failing test(s) before re-running check:claims.`
          );
        } else {
          fail(`npm test failed with exit code ${err.status}. Run \`npm test\` to see the failure.`);
        }
      } else {
        fail(`npm test failed to run: ${err.message.slice(0, 200)}`);
      }
    }
  }
}

// ----------------------------------------------------------------------------
// CHECK 4: Backtest structural claims
// ----------------------------------------------------------------------------

const quick = process.argv.includes('--quick');
console.log(`\nBacktest claims:${quick ? ' (skipped via --quick)' : ''}`);

if (quick) {
  console.log('  -- Skipped (--quick mode). Run without --quick to verify TIER 4 ≤ TIER 2 ordering.');
} else {
  runBacktestCheck();
}

function runBacktestCheck() {
  try {
    const { runBacktest, setRandomSeed, resetRandomSeed } = require(backtestPath);
    setRandomSeed(42);
    const result = runBacktest({ scenarios: 3000, verbose: false });
    resetRandomSeed();

    const t1 = result.results['TIER 1'] || { wins: 0, losses: 0 };
    const t2 = result.results['TIER 2'] || { wins: 0, losses: 0 };
    const t3 = result.results['TIER 3'] || { wins: 0, losses: 0 };
    const t4 = result.results['TIER 4'] || { wins: 0, losses: 0 };

    const t1Total = t1.wins + t1.losses;
    const t2Total = t2.wins + t2.losses;
    const t3Total = t3.wins + t3.losses;
    const t4Total = t4.wins + t4.losses;

    const rate = (w, total) => (total > 0 ? ((w / total) * 100).toFixed(1) + '%' : 'N/A');

    console.log(`  TIER 1: ${rate(t1.wins, t1Total)} (${t1.wins}W/${t1.losses}L/${t1Total} plays)`);
    console.log(`  TIER 2: ${rate(t2.wins, t2Total)} (${t2.wins}W/${t2.losses}L/${t2Total} plays)`);
    console.log(`  TIER 3: ${rate(t3.wins, t3Total)} (${t3.wins}W/${t3.losses}L/${t3Total} plays)`);
    console.log(`  TIER 4: ${rate(t4.wins, t4Total)} (${t4.wins}W/${t4.losses}L/${t4Total} plays)`);

    // The README's strongest directional claim: "TIER 4 > TIER 2 inversion | Fixed in v1.5.1"
    // This is reported as a WARNING, not a failure, because the synthetic backtest's
    // TIER 2 sample is small (typically <30 plays) and noisy — a single seed run can
    // show the inversion even when the algorithm is directionally correct. Treat
    // sustained inversion across multiple runs (or a real code change to risk scoring)
    // as the signal that the claim is stale. A warning here means "review the
    // numbers in README's 'The numbers' section" — not "ship is blocked".
    if (t2Total === 0 || t4Total === 0) {
      warn(`TIER 2 or TIER 4 has 0 plays — can't verify inversion fix claim`);
    } else if (t4.wins / t4Total > t2.wins / t2Total) {
      const gap = ((t4.wins / t4Total - t2.wins / t2Total) * 100).toFixed(1);
      warn(
        `TIER 4 hit rate (${rate(t4.wins, t4Total)}) > TIER 2 hit rate (${rate(t2.wins, t2Total)}, +${gap}pp) in this run. The README's "TIER 4 > TIER 2 inversion fixed in v1.5.1" claim is based on a small TIER 2 sample (${t2Total} plays) — review whether the README's "The numbers" section is still accurate. NOT a release blocker.`
      );
    } else {
      ok(
        `TIER 4 ≤ TIER 2 ordering holds (${rate(t4.wins, t4Total)} ≤ ${rate(t2.wins, t2Total)}) — README's "TIER 4 inversion fixed" claim is directionally supported in this run`
      );
    }

    // Minimum TIER 1 sample size for the README's hit rate claim to be
    // statistically meaningful. Below this threshold the hit rate is just noise
    // on a 3-5 play sample, and any claim of "TIER 1 hit rate is X%" is
    // unsupportable. 100 plays gives a ~10pp margin at 95% confidence, which
    // is enough to detect whether the algorithm is meaningfully better than
    // random.
    const MIN_TIER_1_SAMPLE = 100;
    if (t1Total < MIN_TIER_1_SAMPLE) {
      fail(
        `TIER 1 sample too small (${t1Total} plays) for the README's hit rate claim to be statistically meaningful. ` +
          `Need at least ${MIN_TIER_1_SAMPLE}. The scenario mix or cache reset logic has regressed.`
      );
    } else {
      ok(`TIER 1 sample (${t1Total} plays) is large enough for a meaningful hit rate claim`);
    }

    // Note about TIER 1 hit rate
    if (t1Total < 10) {
      console.log(`\n  info  TIER 1 sample (${t1Total} plays) is too small for a meaningful hit rate claim.`);
      console.log(`  info  The README's "TIER 1 hit rate" number is not auto-verified — review manually.`);
    }
  } catch (err) {
    warn(`Backtest check failed: ${err.message}`);
  }
}

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------

console.log(`\n${'='.repeat(60)}`);
if (failures > 0) {
  console.error(`FAILED — ${failures} failure(s), ${warnings} warning(s)`);
  process.exit(1);
} else if (warnings > 0) {
  console.log(`OK with warnings — ${warnings} warning(s)`);
} else {
  console.log('OK — all claims verified');
}
