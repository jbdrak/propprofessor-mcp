# Universal Agent Access Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make PropProfessor MCP accessible to agents serving all types of sports bettors — from casual "what should I bet today" users to sharp bettors who want full movement data and line history.

**Architecture:** Progressive disclosure via verbosity levels, simplified auth flow, agent onboarding prompt, and tool grouping. No web UI — this stays agent-to-agent via MCP.

**Tech Stack:** Node.js 18+, MCP stdio transport, existing got-scraping + superjson deps.

---

## Phase 1: Auth Simplification (Biggest Unlock)

**Problem:** Current auth requires users to manually export browser cookies from a logged-in session. Most agent users aren't technical enough to do this reliably.

**Solution:** Add a `pp-query login` command that automates the cookie export using Playwright, then installs the auth file.

### Task 1.1: Create Playwright-based login script

**Objective:** Automate the browser login flow so users don't need to manually export cookies.

**Files:**

- Create: `scripts/pp-login.js`
- Modify: `package.json` (add `playwright` as optional dependency)

**Step 1: Write failing test**

```javascript
// test/pp-login.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { loginAndSaveAuth } = require('../scripts/pp-login');

describe('pp-login', () => {
  it('should export a function', () => {
    assert.strictEqual(typeof loginAndSaveAuth, 'function');
  });
});
```

**Step 2: Run test to verify failure**

```bash
node --test test/pp-login.test.js
```

Expected: FAIL — "Cannot find module '../scripts/pp-login'"

**Step 3: Implement login script**

```javascript
// scripts/pp-login.js
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_AUTH_FILE = path.join(os.homedir(), '.propprofessor', 'auth.json');
const LOGIN_URL = 'https://app.propprofessor.com/login';

async function loginAndSaveAuth({ headless = false, timeout = 60000 } = {}) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Opening PropProfessor login page...');
  console.log('Please log in with your PropProfessor credentials.');
  console.log('The browser will close automatically once you are logged in.\n');

  await page.goto(LOGIN_URL);

  // Wait for navigation away from login page (successful login)
  await page.waitForURL('**/dashboard**', { timeout });

  // Export storage state (cookies + localStorage)
  const storageState = await context.storageState();

  await browser.close();

  // Ensure directory exists
  const dir = path.dirname(DEFAULT_AUTH_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(DEFAULT_AUTH_FILE, JSON.stringify(storageState, null, 2));

  console.log(`\n✓ Auth saved to ${DEFAULT_AUTH_FILE}`);
  console.log('✓ You can now use pp-mcp with your AI agent.');

  return { ok: true, authFile: DEFAULT_AUTH_FILE };
}

module.exports = { loginAndSaveAuth };

// CLI entry point
if (require.main === module) {
  loginAndSaveAuth().catch((err) => {
    console.error('Login failed:', err.message);
    process.exit(1);
  });
}
```

**Step 4: Run test to verify pass**

```bash
node --test test/pp-login.test.js
```

Expected: PASS

**Step 5: Add CLI command to pp-query**

```javascript
// In scripts/query-propprofessor.js, add to command router:
if (command === 'login') {
  const { loginAndSaveAuth } = require('./pp-login');
  await loginAndSaveAuth();
  process.exit(0);
}
```

**Step 6: Update README**

Add to Quick Start section:

````markdown
### Auth Setup (Automated)

```bash
pp-query login
# Opens browser, log in, auth saved automatically
```
````

### Auth Setup (Manual)

If you already have an exported session:

```bash
pp-query install-auth --source /path/to/auth.json
```

````

**Step 7: Commit**

```bash
git add scripts/pp-login.js scripts/query-propprofessor.js test/pp-login.test.js package.json README.md
git commit -m "feat: automated login flow with Playwright"
````

---

### Task 1.2: Add auth status check to health endpoint

**Objective:** When auth expires or is missing, return a clear agent-friendly error with recovery instructions.

**Files:**

- Modify: `lib/propprofessor-api.js` (add `isAuthValid()` function)
- Modify: `scripts/propprofessor-mcp-server.js` (update `health_status` handler)

**Step 1: Write failing test**

```javascript
// test/propprofessor-auth-check.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { isAuthValid } = require('../lib/propprofessor-api');

describe('isAuthValid', () => {
  it('should return false for null auth', () => {
    assert.strictEqual(isAuthValid(null), false);
  });

  it('should return false for auth without cookies', () => {
    assert.strictEqual(isAuthValid({ cookies: [] }), false);
  });

  it('should return true for auth with PropProfessor cookies', () => {
    const auth = {
      cookies: [{ name: 'session', domain: '.propprofessor.com', value: 'abc123' }]
    };
    assert.strictEqual(isAuthValid(auth), true);
  });
});
```

**Step 2: Run test to verify failure**

```bash
node --test test/propprofessor-auth-check.test.js
```

Expected: FAIL — "Cannot find module '../lib/propprofessor-api'" or "isAuthValid is not a function"

**Step 3: Implement isAuthValid**

```javascript
// In lib/propprofessor-api.js, add:
function isAuthValid(auth) {
  if (!auth || typeof auth !== 'object') return false;
  if (!Array.isArray(auth.cookies)) return false;
  return auth.cookies.some(
    (c) => c && c.domain && c.domain.includes('propprofessor.com') && c.value
  );
}

module.exports = { /* existing exports */, isAuthValid };
```

**Step 4: Update health_status handler**

```javascript
// In scripts/propprofessor-mcp-server.js, update health_status case:
case 'health_status': {
  const authFile = resolveAuthFile();
  const auth = authFile ? loadAuthFromFile(authFile) : null;
  const authValid = isAuthValid(auth);

  const result = {
    ok: authValid,
    auth: {
      valid: authValid,
      file: authFile || null,
      message: authValid
        ? 'Auth is valid'
        : 'Auth missing or expired. Run: pp-query login'
    }
  };

  if (authValid) {
    try {
      const client = createPropProfessorClient({ auth });
      await client.ping();
      result.backend = { ok: true, message: 'Backend reachable' };
    } catch (err) {
      result.backend = { ok: false, message: err.message };
    }
  }

  return createJsonRpcSuccess(id, result);
}
```

**Step 5: Run test to verify pass**

```bash
node --test test/propprofessor-auth-check.test.js
```

Expected: PASS

**Step 6: Commit**

```bash
git add lib/propprofessor-api.js scripts/propprofessor-mcp-server.js test/propprofessor-auth-check.test.js
git commit -m "feat: clear auth status in health endpoint"
```

---

## Phase 2: Progressive Disclosure (Verbosity Levels)

**Problem:** All tools return the same verbose output regardless of user sophistication. A casual bettor sees `"edge": 2.57, "kaiCall": "BET", "tier": "TIER 2"` and has no idea what that means.

**Solution:** Add a `verbosity` parameter to key tools: `minimal` (plain English), `standard` (current default), `full` (all data).

### Task 2.1: Add verbosity parameter to tool definitions

**Objective:** Allow agents to request different output formats based on user sophistication.

**Files:**

- Modify: `lib/propprofessor-tool-definitions.js` (add `verbosity` param to key tools)

**Step 1: Write failing test**

```javascript
// test/propprofessor-verbosity-param.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { buildToolDefinitions } = require('../lib/propprofessor-tool-definitions');

describe('verbosity parameter', () => {
  it('should add verbosity to recommended_bets', () => {
    const tools = buildToolDefinitions();
    const recBets = tools.find((t) => t.name === 'recommended_bets');
    assert.ok(recBets.inputSchema.properties.verbosity);
    assert.deepStrictEqual(recBets.inputSchema.properties.verbosity.enum, ['minimal', 'standard', 'full']);
  });
});
```

**Step 2: Run test to verify failure**

```bash
node --test test/propprofessor-verbosity-param.test.js
```

Expected: FAIL — "Cannot read properties of undefined (reading 'verbosity')"

**Step 3: Add verbosity parameter to tool definitions**

```javascript
// In lib/propprofessor-tool-definitions.js, add to recommended_bets, sharp_plays, screen_ranked:

const VERBOSITY_PARAM = {
  type: 'string',
  enum: ['minimal', 'standard', 'full'],
  description:
    'Output detail level. minimal: plain English summary for casual bettors. standard: edge/tier/risk with brief rationale. full: all movement data, line history, debug payloads. Default: standard.'
};

// Add to each tool's inputSchema.properties:
verbosity: VERBOSITY_PARAM,
```

**Step 4: Run test to verify pass**

```bash
node --test test/propprofessor-verbosity-param.test.js
```

Expected: PASS

**Step 5: Commit**

```bash
git add lib/propprofessor-tool-definitions.js test/propprofessor-verbosity-param.test.js
git commit -m "feat: add verbosity parameter to key tools"
```

---

### Task 2.2: Implement minimal verbosity formatter

**Objective:** Convert raw bet data into plain English for casual bettors.

**Files:**

- Create: `lib/propprofessor-formatter.js`
- Modify: `scripts/propprofessor-mcp-server.js` (apply formatter when verbosity=minimal)

**Step 1: Write failing test**

```javascript
// test/propprofessor-formatter.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { formatBetMinimal } = require('../lib/propprofessor-formatter');

describe('formatBetMinimal', () => {
  it('should produce plain English for a TIER 1 bet', () => {
    const bet = {
      selection: 'Bonfim',
      odds: '+105',
      game: 'Bonfim vs Muhammad',
      league: 'UFC',
      market: 'Moneyline',
      tier: 'TIER 1',
      edge: 2.57,
      riskScore: 2,
      rationale: 'Sharp books agree, low injury risk, good value'
    };

    const result = formatBetMinimal(bet);
    assert.ok(result.includes('Bet'));
    assert.ok(result.includes('Bonfim'));
    assert.ok(result.includes('+105'));
    assert.ok(result.includes('high confidence'));
  });

  it('should warn for high-risk bets', () => {
    const bet = {
      selection: 'Tiafoe',
      odds: '-150',
      game: 'Tiafoe vs Sinner',
      league: 'Tennis',
      market: 'Moneyline',
      tier: 'TIER 3',
      edge: 0.5,
      riskScore: 8,
      rationale: 'Injury concern, sharp books split'
    };

    const result = formatBetMinimal(bet);
    assert.ok(result.includes('risky') || result.includes('caution'));
  });
});
```

**Step 2: Run test to verify failure**

```bash
node --test test/propprofessor-formatter.test.js
```

Expected: FAIL — "Cannot find module '../lib/propprofessor-formatter'"

**Step 3: Implement formatter**

```javascript
// lib/propprofessor-formatter.js
'use strict';

function formatBetMinimal(bet = {}) {
  const { selection, odds, game, league, market, tier, edge, riskScore, rationale } = bet;

  const confidence =
    tier === 'TIER 1' ? 'high confidence' : tier === 'TIER 2' ? 'moderate confidence' : 'low confidence';

  const risk = riskScore >= 7 ? '⚠️ Risky' : riskScore >= 4 ? 'Moderate risk' : 'Low risk';

  const action = tier === 'TIER 1' || tier === 'TIER 2' ? 'Bet' : 'Consider';

  let summary = `${action} ${selection} at ${odds} (${game}, ${league} ${market}). ${confidence}, ${risk.toLowerCase()}.`;

  if (rationale) {
    summary += ` Why: ${rationale}`;
  }

  if (riskScore >= 7) {
    summary += ' ⚠️ Proceed with caution.';
  }

  return summary;
}

function formatBetsMinimal(bets = []) {
  if (!bets.length) return 'No strong plays right now.';

  const lines = bets.map((bet, i) => `${i + 1}. ${formatBetMinimal(bet)}`);
  return lines.join('\n\n');
}

module.exports = { formatBetMinimal, formatBetsMinimal };
```

**Step 4: Run test to verify pass**

```bash
node --test test/propprofessor-formatter.test.js
```

Expected: PASS

**Step 5: Integrate into recommended_bets handler**

```javascript
// In scripts/propprofessor-mcp-server.js, update recommended_bets case:
case 'recommended_bets': {
  const verbosity = args.verbosity || 'standard';
  const rows = await getRecommendedBets(args);

  if (verbosity === 'minimal') {
    const { formatBetsMinimal } = require('../lib/propprofessor-formatter');
    return createJsonRpcSuccess(id, {
      summary: formatBetsMinimal(rows),
      count: rows.length
    });
  }

  // standard and full return existing format
  return createJsonRpcSuccess(id, rows);
}
```

**Step 6: Commit**

```bash
git add lib/propprofessor-formatter.js scripts/propprofessor-mcp-server.js test/propprofessor-formatter.test.js
git commit -m "feat: minimal verbosity formatter for casual bettors"
```

---

### Task 2.3: Add standard verbosity formatter

**Objective:** Provide edge/tier/risk with brief rationale for intermediate bettors.

**Files:**

- Modify: `lib/propprofessor-formatter.js` (add `formatBetStandard`)
- Modify: `scripts/propprofessor-mcp-server.js` (apply formatter when verbosity=standard)

**Step 1: Write failing test**

```javascript
// In test/propprofessor-formatter.test.js, add:
it('should produce structured output for standard verbosity', () => {
  const bet = {
    selection: 'Bonfim',
    odds: '+105',
    game: 'Bonfim vs Muhammad',
    league: 'UFC',
    market: 'Moneyline',
    tier: 'TIER 1',
    edge: 2.57,
    riskScore: 2,
    movementGrade: 'A',
    rationale: 'Sharp books agree, low injury risk'
  };

  const result = formatBetStandard(bet);
  assert.ok(result.selection === 'Bonfim');
  assert.ok(result.odds === '+105');
  assert.ok(result.tier === 'TIER 1');
  assert.ok(result.edge === 2.57);
  assert.ok(result.rationale);
  assert.ok(!result.lineHistory); // standard strips verbose data
});
```

**Step 2: Run test to verify failure**

```bash
node --test test/propprofessor-formatter.test.js
```

Expected: FAIL — "formatBetStandard is not defined"

**Step 3: Implement standard formatter**

```javascript
// In lib/propprofessor-formatter.js, add:
function formatBetStandard(bet = {}) {
  // Strip verbose debug payloads, keep key fields
  const {
    selection,
    odds,
    game,
    league,
    market,
    tier,
    edge,
    riskScore,
    movementGrade,
    kaiCall,
    rationale,
    consensusScore,
    sharpBooks
  } = bet;

  return {
    selection,
    odds,
    game,
    league,
    market,
    tier,
    edge,
    riskScore,
    movementGrade,
    kaiCall,
    rationale,
    consensusScore,
    sharpBooks: sharpBooks?.length || 0
  };
}

function formatBetsStandard(bets = []) {
  return bets.map(formatBetStandard);
}

module.exports = { formatBetMinimal, formatBetsMinimal, formatBetStandard, formatBetsStandard };
```

**Step 4: Run test to verify pass**

```bash
node --test test/propprofessor-formatter.test.js
```

Expected: PASS

**Step 5: Integrate into handler**

```javascript
// In scripts/propprofessor-mcp-server.js, update recommended_bets case:
case 'recommended_bets': {
  const verbosity = args.verbosity || 'standard';
  const rows = await getRecommendedBets(args);

  if (verbosity === 'minimal') {
    const { formatBetsMinimal } = require('../lib/propprofessor-formatter');
    return createJsonRpcSuccess(id, {
      summary: formatBetsMinimal(rows),
      count: rows.length
    });
  }

  if (verbosity === 'standard') {
    const { formatBetsStandard } = require('../lib/propprofessor-formatter');
    return createJsonRpcSuccess(id, formatBetsStandard(rows));
  }

  // full returns existing format with all debug payloads
  return createJsonRpcSuccess(id, rows);
}
```

**Step 6: Commit**

```bash
git add lib/propprofessor-formatter.js scripts/propprofessor-mcp-server.js test/propprofessor-formatter.test.js
git commit -m "feat: standard verbosity formatter for intermediate bettors"
```

---

## Phase 3: Tool Discoverability & Grouping

**Problem:** 20 tools is overwhelming. Agents don't know which to call first. Casual bettors just want "what should I bet today?"

**Solution:** Add a `get_started` meta-tool that guides agents through the workflow, and group tools by use case in documentation.

### Task 3.1: Create get_started meta-tool

**Objective:** Provide a single entry point that tells agents the recommended workflow based on user type.

**Files:**

- Modify: `lib/propprofessor-tool-definitions.js` (add `get_started` tool)
- Modify: `scripts/propprofessor-mcp-server.js` (implement handler)

**Step 1: Write failing test**

```javascript
// test/propprofessor-get-started.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { buildToolDefinitions } = require('../lib/propprofessor-tool-definitions');

describe('get_started tool', () => {
  it('should exist in tool definitions', () => {
    const tools = buildToolDefinitions();
    const getStarted = tools.find((t) => t.name === 'get_started');
    assert.ok(getStarted);
    assert.ok(getStarted.description.includes('workflow'));
  });
});
```

**Step 2: Run test to verify failure**

```bash
node --test test/propprofessor-get-started.test.js
```

Expected: FAIL — "Cannot read properties of undefined"

**Step 3: Add get_started tool definition**

```javascript
// In lib/propprofessor-tool-definitions.js, add at the start of the array:
{
  name: 'get_started',
  description:
    'Get recommended workflow based on user type. Call this first to understand which tools to use for casual, intermediate, or sharp bettors.',
  inputSchema: {
    type: 'object',
    properties: {
      user_type: {
        type: 'string',
        enum: ['casual', 'intermediate', 'sharp'],
        description:
          'casual: just wants top picks with plain English. intermediate: understands edge/tier, wants guidance. sharp: wants full movement data and control.'
      }
    },
    required: ['user_type'],
    additionalProperties: false
  }
},
```

**Step 4: Implement handler**

```javascript
// In scripts/propprofessor-mcp-server.js, add case:
case 'get_started': {
  const userType = args.user_type || 'intermediate';

  const workflows = {
    casual: {
      summary: 'For casual bettors who just want top picks.',
      steps: [
        'Call recommended_bets with verbosity="minimal" to get plain English picks.',
        'Present the top 3-5 plays to the user.',
        'If they want more detail on a specific play, call player_context to check injury risk.'
      ],
      tools_to_use: ['recommended_bets', 'player_context'],
      avoid: ['screen_raw', 'sharp_consensus', 'ev_candidates']
    },
    intermediate: {
      summary: 'For bettors who understand edge and tier but want guidance.',
      steps: [
        'Call recommended_bets with verbosity="standard" to get structured plays.',
        'Filter by tier (TIER 1, TIER 2) for highest confidence.',
        'For each top play, call player_context to check injury risk.',
        'If riskScore >= 7, warn the user.',
        'Optionally call find_best_price to line shop.'
      ],
      tools_to_use: ['recommended_bets', 'player_context', 'find_best_price', 'league_presets'],
      avoid: ['screen_raw', 'sharp_consensus']
    },
    sharp: {
      summary: 'For sharp bettors who want full control and movement data.',
      steps: [
        'Call screen_ranked with verbosity="full" for complete data.',
        'Use sharp_consensus to check multi-window movement.',
        'Use sharp_plays to find plays with independent sharp support.',
        'Call get_play_details for line history on specific plays.',
        'Use staking_plan for Kelly sizing.',
        'Check player_context for injury risk on final picks.'
      ],
      tools_to_use: [
        'screen_ranked',
        'sharp_consensus',
        'sharp_plays',
        'get_play_details',
        'staking_plan',
        'player_context',
        'find_best_price'
      ],
      avoid: []
    }
  };

  return createJsonRpcSuccess(id, workflows[userType]);
}
```

**Step 5: Run test to verify pass**

```bash
node --test test/propprofessor-get-started.test.js
```

Expected: PASS

**Step 6: Commit**

```bash
git add lib/propprofessor-tool-definitions.js scripts/propprofessor-mcp-server.js test/propprofessor-get-started.test.js
git commit -m "feat: get_started meta-tool for agent workflow guidance"
```

---

### Task 3.2: Add tool grouping to README

**Objective:** Document tools by use case so agents (and humans reading the docs) understand the workflow.

**Files:**

- Modify: `README.md` (add "Tool Guide" section)

**Step 1: Add tool guide section**

```markdown
## Tool Guide

### For Casual Bettors (Just Tell Me What to Bet)

1. **`get_started`** (user_type: "casual") — Get the workflow
2. **`recommended_bets`** (verbosity: "minimal") — Plain English top picks
3. **`player_context`** — Check injury risk on specific plays

**That's it.** Three tools.

### For Intermediate Bettors (Show Me the Edge)

1. **`get_started`** (user_type: "intermediate") — Get the workflow
2. **`recommended_bets`** (verbosity: "standard") — Structured plays with edge/tier/risk
3. **`player_context`** — Injury risk check
4. **`find_best_price`** — Line shop across books
5. **`league_presets`** — See league-specific ranking weights

### For Sharp Bettors (Full Control)

1. **`get_started`** (user_type: "sharp") — Get the workflow
2. **`screen_ranked`** (verbosity: "full") — Complete ranked data
3. **`sharp_consensus`** — Multi-window sharp movement
4. **`sharp_plays`** — Plays with independent sharp support
5. **`get_play_details`** — Line history for specific plays
6. **`staking_plan`** — Kelly sizing
7. **`player_context`** — Injury risk on final picks

### All Tools (Reference)

| Tool               | Purpose                   | Casual | Intermediate | Sharp |
| ------------------ | ------------------------- | ------ | ------------ | ----- |
| `get_started`      | Workflow guide            | ✓      | ✓            | ✓     |
| `recommended_bets` | Top picks                 | ✓      | ✓            | ✓     |
| `player_context`   | Injury risk               | ✓      | ✓            | ✓     |
| `find_best_price`  | Line shopping             |        | ✓            | ✓     |
| `league_presets`   | Ranking weights           |        | ✓            | ✓     |
| `screen_ranked`    | Full ranked data          |        |              | ✓     |
| `sharp_consensus`  | Multi-window movement     |        |              | ✓     |
| `sharp_plays`      | Independent sharp support |        |              | ✓     |
| `get_play_details` | Line history              |        |              | ✓     |
| `staking_plan`     | Kelly sizing              |        |              | ✓     |
| `screen_raw`       | Raw odds screen           |        |              | ✓     |
| `ev_candidates`    | +EV discovery             |        |              | ✓     |
| `ufc_card`         | UFC event analysis        |        |              | ✓     |
| `all_slates`       | All leagues at once       |        |              | ✓     |
| `health_status`    | System health             | ✓      | ✓            | ✓     |
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add tool guide by user type"
```

---

## Phase 4: Agent Onboarding & Documentation

**Problem:** Agents don't know what PropProfessor MCP does, what the outputs mean, or how to explain them to users.

**Solution:** Create a system prompt template and a skill file that ships with the MCP server.

### Task 4.1: Create agent system prompt template

**Objective:** Provide a recommended system prompt that agents can use to understand PropProfessor MCP.

**Files:**

- Create: `docs/AGENT_PROMPT.md`

**Step 1: Write agent prompt**

```markdown
# PropProfessor MCP Agent Prompt

You are a sports betting assistant powered by PropProfessor MCP. You help users find profitable bets by analyzing odds movement, sharp book consensus, and player context.

## Core Philosophy

**Don't bet just because one book has a good number.** Wait for independent sharp book movement to confirm the play. That's the difference between "this looks like value" and "smart money is actually doing the same thing I am."

## Understanding the Outputs

### Tier System

- **TIER 1**: Highest confidence. Sharp books agree, strong movement, low risk.
- **TIER 2**: Good confidence. Sharp support present, moderate risk.
- **TIER 3**: Lower confidence. Mixed signals, higher risk.
- **TIER 4**: Pass. Not enough confirmation or too risky.

### Risk Score (1-10)

- **1-3**: Low risk. Sharp books agree, no injury concerns, stable line.
- **4-6**: Moderate risk. Some uncertainty, check player context.
- **7-10**: High risk. Injury concerns, sharp books split, volatile line.

### Edge (%)

The percentage advantage you have over the book. Higher is better.

- **< 1%**: Marginal. Skip unless other signals are strong.
- **1-3%**: Decent. Worth considering.
- **> 3%**: Strong. Good value if confirmed by sharp movement.

### Movement Grade

- **A**: Strong supportive movement from sharp books.
- **B**: Moderate supportive movement.
- **C**: Mixed or neutral movement.
- **D**: Adverse movement (sharp books moving against the play).

## Workflow by User Type

### Casual Bettors

They just want to know what to bet. Use `recommended_bets` with `verbosity: "minimal"` to get plain English picks. Present the top 3-5 plays. If they ask "why," check `player_context` for injury risk.

**Example response:**

> "Bet Bonfim at +105 (UFC, Moneyline). High confidence, low risk. Sharp books agree, no injury concerns, good value."

### Intermediate Bettors

They understand edge and tier. Use `recommended_bets` with `verbosity: "standard"` to get structured data. Explain what the edge and tier mean. Warn them if riskScore >= 7.

**Example response:**

> "Bonfim +105 is TIER 1 with 2.57% edge. Risk score is 2 (low). Sharp books (Pinnacle, BetOnline, BookMaker) all moved supportive in the 2h, 6h, and 12h windows. No injury concerns. Good value."

### Sharp Bettors

They want full control. Use `screen_ranked` with `verbosity: "full"` and let them explore. They'll ask for specific data (line history, consensus windows, steam moves). Provide it.

**Example response:**

> "Bonfim +105 has movement grade A. Multi-window consensus: supportive in 2h, 6h, 12h, 24h. All three sharp books (Pinnacle, BetOnline, BookMaker) agree. Line history shows 5-cent move from +110 to +105 over 6 hours. No injury risk. Kelly suggests 2% of bankroll."

## Key Rules

1. **Always check player context before recommending a bet.** Injury risk can flip a TIER 1 to a PASS.
2. **Never recommend TIER 4 plays.** They're passes for a reason.
3. **Warn about high-risk plays.** If riskScore >= 7, say "⚠️ This is risky" and explain why.
4. **Don't over-explain to casual bettors.** They want picks, not a dissertation on sharp book movement.
5. **Do explain to intermediate bettors.** They want to learn. Tell them why a play is good or bad.
6. **Give sharp bettors the data.** They'll make their own calls. Your job is to surface the signals.

## Common Questions

**"What's the best bet today?"**
→ Call `recommended_bets` with appropriate verbosity. Present top 3-5 plays.

**"Is [player] safe to bet on?"**
→ Call `player_context` for that player. Check riskFlag. If "high," warn the user.

**"Why is this TIER 1?"**
→ Explain: sharp books agree, strong movement, low risk, good edge. Show the specific signals.

**"What's the difference between TIER 1 and TIER 2?"**
→ TIER 1 has stronger sharp consensus and lower risk. TIER 2 is still good but has more uncertainty.

**"Should I bet this TIER 3 play?"**
→ Generally no. TIER 3 means mixed signals. If the user insists, explain the risks and check player context.

## Bankroll Management

If the user asks how much to bet:

- **TIER 1**: 1-2% of bankroll
- **TIER 2**: 0.5-1% of bankroll
- **TIER 3**: Skip or 0.25% max
- **TIER 4**: Don't bet

Use `staking_plan` to calculate exact Kelly sizing if they provide their bankroll.
```

**Step 2: Commit**

```bash
git add docs/AGENT_PROMPT.md
git commit -m "docs: add agent system prompt template"
```

---

### Task 4.2: Create Hermes skill file

**Objective:** Provide a Hermes skill that agents can load to understand PropProfessor MCP.

**Files:**

- Create: `docs/HERMES_SKILL.md`

**Step 1: Write skill file**

```yaml
---
name: propprofessor-mcp
description: "PropProfessor MCP: sports betting analysis for AI agents. Screens 36+ books, ranks by sharp movement, validates with multi-window consensus."
version: 1.1.0
author: James Drake
tags: [sports-betting, mcp, odds-analysis, sharp-movement]
---

# PropProfessor MCP Skill

## What It Does

PropProfessor MCP is an odds analysis engine for AI agents. It screens 36+ sportsbooks across NBA, MLB, NHL, NFL, WNBA, UFC, Tennis, Soccer and ranks plays by:

- **Sharp book consensus** (Pinnacle, BetOnline, BookMaker)
- **Multi-window line movement** (1h, 2h, 6h, 12h, 24h, 48h)
- **Steam move detection** (5-min, 3-book moves)
- **Player context** (injury risk, recent news, tweets)

## Quick Start

### For Casual Bettors

```

1. Call get_started(user_type: "casual")
2. Call recommended_bets(verbosity: "minimal")
3. Present top 3-5 plays in plain English
4. Check player_context for injury risk if asked

```

### For Intermediate Bettors

```

1. Call get_started(user_type: "intermediate")
2. Call recommended_bets(verbosity: "standard")
3. Filter by TIER 1, TIER 2
4. Check player_context for each top play
5. Warn if riskScore >= 7
6. Optionally call find_best_price to line shop

```

### For Sharp Bettors

```

1. Call get_started(user_type: "sharp")
2. Call screen_ranked(verbosity: "full")
3. Use sharp_consensus for multi-window movement
4. Use sharp_plays for independent sharp support
5. Call get_play_details for line history
6. Use staking_plan for Kelly sizing
7. Check player_context for final picks

```

## Key Concepts

### Tier System
- **TIER 1**: Highest confidence. Sharp books agree, strong movement, low risk.
- **TIER 2**: Good confidence. Sharp support present, moderate risk.
- **TIER 3**: Lower confidence. Mixed signals, higher risk.
- **TIER 4**: Pass. Not enough confirmation or too risky.

### Risk Score (1-10)
- **1-3**: Low risk. Sharp books agree, no injury concerns.
- **4-6**: Moderate risk. Some uncertainty, check player context.
- **7-10**: High risk. Injury concerns, sharp books split.

### Movement Grade
- **A**: Strong supportive movement from sharp books.
- **B**: Moderate supportive movement.
- **C**: Mixed or neutral.
- **D**: Adverse movement (sharp books moving against).

## Common Pitfalls

1. **Don't bet TIER 4 plays.** They're passes for a reason.
2. **Always check player context.** Injury risk can flip a TIER 1 to a PASS.
3. **Don't over-explain to casual bettors.** They want picks, not a dissertation.
4. **Do explain to intermediate bettors.** They want to learn.
5. **Give sharp bettors the data.** They'll make their own calls.

## Auth

If `health_status` returns `auth.valid: false`, tell the user:

> "Your PropProfessor auth has expired. Run `pp-query login` to re-authenticate."

## Resources

- **Agent prompt template**: `docs/AGENT_PROMPT.md`
- **Tool guide**: See README.md "Tool Guide" section
- **Auth guide**: `AUTH.md`
- **Config guide**: `CONFIG.md`
```

**Step 2: Commit**

```bash
git add docs/HERMES_SKILL.md
git commit -m "docs: add Hermes skill file for agent onboarding"
```

---

## Phase 5: Error Handling & Recovery

**Problem:** When auth expires or the backend is down, agents get generic errors and don't know how to recover.

**Solution:** Add structured error codes with recovery instructions.

### Task 5.1: Add structured error codes

**Objective:** Return clear error codes with recovery instructions so agents can guide users.

**Files:**

- Modify: `lib/propprofessor-mcp-stdio.js` (enhance error categorization)
- Modify: `scripts/propprofessor-mcp-server.js` (return structured errors)

**Step 1: Write failing test**

```javascript
// test/propprofessor-error-codes.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { categorizeError } = require('../lib/propprofessor-mcp-stdio');

describe('structured error codes', () => {
  it('should return AUTH_EXPIRED for 401 errors', () => {
    const err = new Error('Unauthorized');
    err.status = 401;
    const result = categorizeError(err);
    assert.strictEqual(result.code, 'AUTH_EXPIRED');
    assert.ok(result.recovery.includes('pp-query login'));
  });

  it('should return BACKEND_DOWN for 503 errors', () => {
    const err = new Error('Service unavailable');
    err.status = 503;
    const result = categorizeError(err);
    assert.strictEqual(result.code, 'BACKEND_DOWN');
    assert.ok(result.recovery.includes('try again later'));
  });
});
```

**Step 2: Run test to verify failure**

```bash
node --test test/propprofessor-error-codes.test.js
```

Expected: FAIL — "Cannot read properties of undefined (reading 'recovery')"

**Step 3: Enhance error categorization**

```javascript
// In lib/propprofessor-mcp-stdio.js, update categorizeError:
function categorizeError(error) {
  const message = String(error?.message || error || 'Unexpected error');
  const status = error?.status;

  if (status === 401 || message.toLowerCase().includes('unauthorized')) {
    return {
      code: 'AUTH_EXPIRED',
      category: 'auth',
      message: 'PropProfessor auth has expired',
      recovery: 'Run: pp-query login'
    };
  }

  if (status === 503 || message.toLowerCase().includes('service unavailable')) {
    return {
      code: 'BACKEND_DOWN',
      category: 'backend',
      message: 'PropProfessor backend is temporarily unavailable',
      recovery: 'Try again in a few minutes'
    };
  }

  if (status === 429) {
    return {
      code: 'RATE_LIMITED',
      category: 'transport',
      message: 'Rate limited by PropProfessor API',
      recovery: 'Wait 60 seconds and retry'
    };
  }

  return {
    code: 'INTERNAL_ERROR',
    category: 'internal',
    message,
    recovery: 'Check logs or file an issue at github.com/jbdrak/propprofessor-mcp'
  };
}
```

**Step 4: Run test to verify pass**

```bash
node --test test/propprofessor-error-codes.test.js
```

Expected: PASS

**Step 5: Commit**

```bash
git add lib/propprofessor-mcp-stdio.js test/propprofessor-error-codes.test.js
git commit -m "feat: structured error codes with recovery instructions"
```

---

## Phase 6: Testing & Backtesting

**Problem:** No way to validate that TIER 1 plays actually hit at a higher rate than TIER 4. Users can't trust the methodology without proof.

**Solution:** Add a backtesting script that pulls historical data and calculates hit rates by tier.

### Task 6.1: Create backtesting script

**Objective:** Validate that the tier system actually predicts outcomes.

**Files:**

- Create: `scripts/backtest.js`
- Create: `docs/BACKTESTING.md`

**Step 1: Write backtesting script**

```javascript
// scripts/backtest.js
#!/usr/bin/env node
'use strict';

const { createPropProfessorClient } = require('../lib/propprofessor-api');
const { getConfidenceTier } = require('../lib/propprofessor-risk-score');

async function backtest({ league, market, days = 30 } = {}) {
  console.log(`Backtesting ${league} ${market} for the last ${days} days...\n`);

  const client = createPropProfessorClient();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  // Fetch historical screen data
  const rows = await client.queryScreen({ league, market });

  // Filter to resolved bets (have outcome)
  const resolved = rows.filter((row) => row.outcome && row.startTime >= cutoff);

  console.log(`Found ${resolved.length} resolved bets.\n`);

  // Group by tier
  const byTier = { 'TIER 1': [], 'TIER 2': [], 'TIER 3': [], 'TIER 4': [] };

  for (const row of resolved) {
    const tier = getConfidenceTier(row);
    if (!byTier[tier]) continue;
    byTier[tier].push(row);
  }

  // Calculate hit rates
  console.log('Tier\t\tTotal\tWins\tLosses\tPush\tHit Rate');
  console.log('----\t\t-----\t----\t------\t----\t--------');

  for (const [tier, bets] of Object.entries(byTier)) {
    if (!bets.length) continue;

    const wins = bets.filter((b) => b.outcome === 'win').length;
    const losses = bets.filter((b) => b.outcome === 'loss').length;
    const pushes = bets.filter((b) => b.outcome === 'push').length;
    const hitRate = ((wins / bets.length) * 100).toFixed(1);

    console.log(`${tier}\t\t${bets.length}\t${wins}\t${losses}\t${pushes}\t${hitRate}%`);
  }

  console.log('\n✓ Backtest complete.');
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const league = args[0] || 'MLB';
  const market = args[1] || 'Moneyline';
  const days = parseInt(args[2]) || 30;

  backtest({ league, market, days }).catch((err) => {
    console.error('Backtest failed:', err.message);
    process.exit(1);
  });
}

module.exports = { backtest };
```

**Step 2: Add documentation**

````markdown
# Backtesting Guide

## Run a Backtest

```bash
node scripts/backtest.js MLB Moneyline 30
```
````

This tests the last 30 days of MLB Moneyline plays.

## Expected Output

```
Backtesting MLB Moneyline for the last 30 days...

Found 247 resolved bets.

Tier		Total	Wins	Losses	Push	Hit Rate
----		-----	----	------	----	--------
TIER 1		42	29	12	1	69.0%
TIER 2		87	51	34	2	58.6%
TIER 3		73	35	36	2	47.9%
TIER 4		45	17	27	1	37.8%

✓ Backtest complete.
```

## Interpreting Results

If TIER 1 hit rate is significantly higher than TIER 4, the tier system is working. If they're similar, the ranking methodology needs adjustment.

## Limitations

- Historical data availability depends on PropProfessor's API
- Past performance doesn't guarantee future results
- Small sample sizes (< 50 bets per tier) may not be statistically significant

````

**Step 3: Commit**

```bash
git add scripts/backtest.js docs/BACKTESTING.md
git commit -m "feat: backtesting script to validate tier system"
````

---

## Summary

This plan takes PropProfessor MCP from **3/10 to 9/10** for universal agent access:

**Phase 1: Auth Simplification** — Automated login flow, clear auth status in health endpoint.

**Phase 2: Progressive Disclosure** — Verbosity levels (minimal/standard/full) for casual, intermediate, and sharp bettors.

**Phase 3: Tool Discoverability** — `get_started` meta-tool, tool guide by user type.

**Phase 4: Agent Onboarding** — System prompt template, Hermes skill file.

**Phase 5: Error Handling** — Structured error codes with recovery instructions.

**Phase 6: Backtesting** — Validate that the tier system actually predicts outcomes.

**Estimated effort:** 3-4 weeks for a solo developer working part-time.

**Biggest unlock:** Phase 1 (auth). If you can't get authenticated in 2 minutes, nothing else matters.

**Second biggest:** Phase 2 (verbosity). Casual bettors don't want to parse JSON. Give them plain English.

**Third biggest:** Phase 4 (onboarding). Agents need to understand what the tool does and how to explain it to users.

---

## Next Steps

1. **Start with Phase 1** — Get auth working smoothly. This is the #1 blocker.
2. **Then Phase 2** — Add verbosity levels. This makes the tool usable for non-technical users.
3. **Then Phase 4** — Write the agent prompt and skill file. This helps agents understand the tool.
4. **Phase 3, 5, 6** — Polish and validation.

Ready to execute? Use subagent-driven-development to dispatch one task at a time.
