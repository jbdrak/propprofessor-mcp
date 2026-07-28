# PropProfessor-MCP Remaining Cleanup Plan

## Project state

- Tests: 1757/1757 pass. Lint: 0 errors, 33 warnings (prettier + max-lines).
- Working tree clean. All commits pushed to origin/main.
- Active skill at `~/.hermes/skills/software-development/propprofessor-mcp-development/SKILL.md` has full context.

## What's left to do

### 1. Prettier formatting (`npm run format:check` fails)

6 files have style drift: `lib/screen-row-expander.js`, `lib/tool-definitions/validation.js`, `README.md`, `scripts/server/handlers.js`.
Fix: `npm run format` (writes prettier fixes), then verify with `npm run format:check`.

### 2. TypeScript check failures (`npm run check:types` — 20 errors)

Three categories:

- **Missing @types/node**: ~10 errors in `lib/screen-ranker.js` and `lib/screen-row-expander.js` saying `Cannot find name 'process'`. Fix: `npm i --save-dev @types/node` and ensure tsconfig includes node types.
- **Missing properties on option types**: `focusBook`, `requirePreferredBook`, `playableOnly` not declared on the JSDoc option objects at rankScreenRows/rankLeagueScreenRows. Add them to the JSDoc typedef in `lib/screen-ranker.js` (~line 400-420 and ~line 970-1000).
- **Any-type gaps**: `coverageGaps` and `focusBookMissingRows` typed as `any[]` but used with property access. Add proper JSDoc types.

### 3. Dependabot PRs (4 open)

- [#42] `typescript 5.9.3 → 7.0.2` (dev-dep, BREAKING major)
- [#41] `c8 11.0.0 → 12.0.0` (dev-dep, BREAKING major)
- [#40] `globals 17.7.0 → 17.8.0` (dev-dep, minor)
- [#38] `actions/setup-node 6 → 7` (CI, major)

Fix: Review each PR. Merge the minor one (#40). For the majors, verify they don't break the toolchain (eslint/madge/prettier/check:claims/check:types) by running `npm ci` in the PR branch and running `npm run install:verify` + `npm run check:types`. If they break, close with a comment. If fine, merge.

### 4. handlers.js still 4068 lines — extraction in progress

Current: `scripts/server/handlers.js` is 4068 lines (was 4264). Extracted modules live in `scripts/server/handlers/`.
Continue the existing extraction pattern — pick the next logical handler group to extract (likely `pricing.js` or `discovery.js` adjacent handlers). The reference doc `references/handler-extraction-pattern.md` covers the recipe: inline handler → required module in `handlers/` folder → add to `createMcpHandlers` via Object.assign → delete inline code → run tests.

## Verification steps (must all pass before committing)

1. `npm run install:verify` (53 tests, ~3s)
2. `node --test` (1757 tests, ~190s)
3. `npm run lint` (0 errors required)
4. `npm run format:check` (0 style issues required)
5. `npm run check:types` (0 TS errors required)
6. `npm run check:version` (must pass)
7. `npm run check:claims:quick` (must pass)

## Rules

- No new features. Only fix what's listed.
- Don't touch test/mcp-arg-validator.test.js (already patched twice).
- Don't touch bin/pp-cli.js command logic (pp game was fixed Jul 28).
- All changes must pass the full verification battery.
- After all fixes, commit with a descriptive message and push to origin/main.
