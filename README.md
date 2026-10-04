# PatchPilot

Turns a production crash — or a plain-English bug report — into a **tested GitHub pull
request**, using agents built on the [Cline SDK](https://www.npmjs.com/package/@cline/agents),
with the safety rules **enforced in code** rather than asked for politely in a prompt.

Point it at any Node app that has a test command. It will catch the crash (or read the
report) and group it into an incident by fingerprint; work on a throwaway `git worktree`
sandbox so your checkout is never touched; find the root cause; write **one** regression
test and prove it fails before the fix; let the fixer edit source only, up to three
attempts, each re-verified by PatchPilot itself rather than by the agent's word; review
the diff against the root cause; and open a **draft** pull request. If the request
contradicts an existing test, it escalates to a human instead of silently "fixing" the
test.

## How it works

```
crash ─► capture middleware ─► POST /api/incidents ─┐      (or POST /api/incidents/manual)
                                                     ▼
fingerprint (no line numbers) ─► new incident? ─► git worktree sandbox (from baseRef, LF forced)
   ├─ Triage      read-only; root cause, intended behavior, suspects, confidence (< 0.35 → Needs Human)
   ├─ Reproducer  writes ONE test in tests/; PatchPilot re-runs it: it must FAIL, for the
   │              right reason; then SHA-256 lock + commit "test: reproduce … (fails before fix)"
   ├─ Fixer ×≤3   edits source only; after each attempt PatchPilot checks: test unchanged →
   │              escalation? → diff not empty → hard checks + brace balance → repro test
   │              passes → FULL suite passes. Any failure resets to the test commit and the
   │              reason goes into the next attempt. flag_for_human_intervention → Needs Human.
   ├─ Critic      no tools; reviews the diff against the root cause
   └─ PR          commit the fix; with PATCHPILOT_OPEN_PR=1: git push + gh pr create --draft
every step ─► event bus ─► SSE /api/stream ─► dashboard
```

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| **Node.js** | **22 or newer** (the agent runtime and `node --test` need it) | `node -v` |
| npm | ships with Node | `npm -v` |
| git | any recent version | `git --version` |
| GitHub CLI `gh` | only for opening **real** pull requests | `gh --version` |

Mock mode needs **no API key** and makes no network calls.

<details>
<summary>Install hints</summary>

**macOS** (Homebrew):

```bash
brew install node git gh
```

**Debian / Ubuntu** (apt):

```bash
sudo apt-get update
sudo apt-get install -y nodejs npm git gh
```

**Any OS, if you use nvm** (recommended — it guarantees Node 22+):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22
nvm use 22
```

Log the CLI in once, only if you want to open real PRs: `gh auth login`.

</details>

## Setup

```bash
git clone https://github.com/ArnabZ-77/Cline-Submission.git
cd Cline-Submission
npm ci
cp .env.example .env          # then edit .env; mock mode needs no key
```

<details>
<summary>Windows PowerShell</summary>

```powershell
git clone https://github.com/ArnabZ-77/Cline-Submission.git
cd Cline-Submission
npm ci
Copy-Item .env.example .env   # then edit .env; mock mode needs no key
```

</details>

**Do I need a second install for the demo app?** No. The root `npm ci` installs `express`,
and Node finds it from `demo-app/` too, so `npm run ci`, `npm run bench` and `npm run demo`
all work after that one install (verified on a fresh clone). Only the separate shop built by
`npm run demo:make-shop` needs its own `npm ci`, inside `../demo-shop`.

## Run it in two minutes (mock mode, no API key)

**Terminal 1**

```bash
PATCHPILOT_MOCK=1 npm start
```

**Terminal 2**

```bash
npm run demo                 # the deliberately buggy demo app on http://localhost:5050
npm run demo:crash -- 01     # fire bug 01's crashing request; the app reports itself
```

**Browser** — open <http://localhost:4747/> and watch the incident move through
`triage → reproduce → fix → validate → review → pr → done`.

**Terminal 2 (continued)**

```bash
npm run demo:try             # replay every bug's request: ✅/❌ with what it got (0/10 before fixes)
npm run demo:reset           # delete incidents, sandboxes and patchpilot/* branches
```

<details>
<summary>Windows PowerShell</summary>

Terminal 1:

```powershell
$env:PATCHPILOT_MOCK = "1"
npm start
```

Terminal 2:

```powershell
npm run demo
npm run demo:crash -- 01
```

Then open <http://localhost:4747/>, and finish with `npm run demo:try` and
`npm run demo:reset`.

</details>

In mock mode the PR is built on a local `patchpilot/<incident>` branch but **not pushed** —
see [Live demo](#live-demo-with-a-real-draft-pr-optional) to open a real one.

## Run with a real model

Pick one block in [`.env.example`](.env.example) and fill in its key, then **do not** leave
`PATCHPILOT_MOCK=1`:

```bash
# Option A — Anthropic (default, strongest)
PATCHPILOT_PROVIDER=anthropic
PATCHPILOT_MODEL=claude-opus-5-5
PATCHPILOT_FALLBACK_MODEL=claude-sonnet-5-5
ANTHROPIC_API_KEY=<your Anthropic key>

# Option B — Gemini (fast, cheap)
PATCHPILOT_PROVIDER=gemini
PATCHPILOT_MODEL=gemini-3.5-flash
GEMINI_API_KEY=…

# Option C — any OpenAI-compatible endpoint (self-hosted or gateway)
PATCHPILOT_PROVIDER=openai-compatible
PATCHPILOT_MODEL=your-model-id
PATCHPILOT_BASE_URL=https://your-endpoint/v1
PATCHPILOT_API_KEY=…
```

```bash
npm start
npm run bench                    # all 11 bugs against the real model
npx tsx benchmark/run.ts 04      # or a single bug, by id
```

Transient provider errors ("high demand", 429, 503, timeouts) are retried up to 3 times
with 10/20/30 s waits, the last try on `PATCHPILOT_FALLBACK_MODEL`, with a fresh `Agent`
each time; each stage has a 240 s timeout. Quota, billing and invalid-key errors fail
immediately with "check the API key, quota and billing" — retrying those only wastes
minutes.

> **Honest note about free tiers.** On the **free Gemini tier the quota is exhausted within
> roughly one bug**, because every stage makes several model calls. Real-model runs need a
> billed key, or paced runs (one bug at a time with `npx tsx benchmark/run.ts <id>`).

## Environment variables

Every variable the code reads. Shell variables **win** over `.env`, and the loader only
fills keys that are not already set. All values are strings: `PATCHPILOT_MOCK=0` means
*off* — the code tests for exactly `"1"`, never for truthiness.

| Variable | Default | Meaning |
|---|---|---|
| `PATCHPILOT_MOCK` | `0` | `1` answers from built-in fixtures: no model calls, no key, no network |
| `PATCHPILOT_OPEN_PR` | `0` | `1` pushes the fix branch and opens a **draft** PR with `gh` |
| `PATCHPILOT_PROVIDER` | `anthropic` | `anthropic`, `gemini`, `openai-compatible`, `openai`, `ollama` |
| `PATCHPILOT_MODEL` | `claude-opus-5-5` | Model id passed to the SDK |
| `PATCHPILOT_FALLBACK_MODEL` | `claude-sonnet-5-5` | Used on the last retry after transient errors |
| `PATCHPILOT_BASE_URL` | — | Custom base URL for OpenAI-compatible endpoints |
| `PATCHPILOT_API_KEY` | — | Single key that overrides the per-provider keys below |
| `ANTHROPIC_API_KEY` | — | Key for `PATCHPILOT_PROVIDER=anthropic` |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | — | Keys for `PATCHPILOT_PROVIDER=gemini` (first one set wins) |
| `OPENAI_API_KEY` | — | Key for `PATCHPILOT_PROVIDER=openai` |
| `PATCHPILOT_ALLOW_PROVIDER_TOOLS` | `0` | Escape hatch: allow providers that run tools in their own process (they bypass the guardrails) |
| `PATCHPILOT_INR_PER_USD` | `96` | Rupees per dollar, for the cost shown on the dashboard and in PRs |
| `PATCHPILOT_PORT` | `4747` | Port PatchPilot's server listens on |
| `PATCHPILOT_URL` | `http://localhost:4747` | Base URL the demo scripts talk to |
| `PATCHPILOT_ENDPOINT` | `http://localhost:4747/api/incidents` | Where the capture middleware POSTs events |
| `PATCHPILOT_REPO` | `demo-app` | Repo tag sent by the middleware; must match a key in `patchpilot.config.json` |
| `DEMO_PORT` | `5050` | Port the demo app listens on |
| `DEMO_URL` | `http://localhost:5050` | Base URL the demo scripts send bug requests to |
| `DEMO_REPO` | `demo-app` | Repo tag for manual reports filed by `demo:crash` |
| `BENCH_REPO` | the config default | Which `repos` entry the benchmark runs against |
| `BENCH_KEEP` | `0` | `1` keeps each sandbox and branch after a benchmark run |
| `NODE_ENV` | `development` | Recorded on captured events only |

## Commands

| Command | What it does |
|---|---|
| `npm start` | Start the PatchPilot server and dashboard (port 4747) |
| `npm run ci` | Everything: typecheck + unit tests + the demo app's own tests |
| `npm run typecheck` | `tsc --noEmit`, no output means clean |
| `npm test` | PatchPilot's unit tests (vitest) |
| `npm run ci:demo` | The demo app's own 14 tests (`node --test`) |
| `npm run test:demo` | Same as `ci:demo` |
| `npm run bench` | Run all 11 planted bugs end to end and print the scorecard |
| `npx tsx benchmark/run.ts <id>` | One bug by id (`01`…`11`, or a name like `pagination`) |
| `npm run demo` | Start the buggy demo app on port 5050 |
| `npm run demo:crash -- <id>` | Fire bug `<id>`: crash bugs really throw, manual bugs file a report |
| `npm run demo:try` | Replay every bug's request and print ✅/❌ with what it got |
| `npm run demo:shop` | Start the standalone shop in `../demo-shop` (live demo only) |
| `npm run demo:make-shop` | Build `../demo-shop` from `demo-app/` + the SDK middleware |
| `npm run demo:reset` | Delete incidents, sandboxes and `patchpilot/*` branches |
| `npm run demo:reset -- --close-prs` | Also close the demo PRs on GitHub |

## Stop by port

A Node server can outlive the terminal that started it and keep serving old code on the
same port. Stop it by port, not by closing the window.

```bash
lsof -ti tcp:4747 | xargs kill     # PatchPilot
lsof -ti tcp:5050 | xargs kill     # demo app / shop
```

```powershell
Get-NetTCPConnection -LocalPort 4747 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess }
Get-NetTCPConnection -LocalPort 5050 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess }
```

## Live demo with a real draft PR (optional)

The live demo needs a **target repository of its own**, because PatchPilot pushes a branch
and opens a pull request against it. That repo is not part of this repository.

**1. Build it** (copies `demo-app/` and the SDK middleware, rewires the import, makes a git repo):

```bash
npm run demo:make-shop        # writes ../demo-shop, next to this repo
```

It refuses to overwrite an existing `../demo-shop`.

**2. Give it a GitHub remote** — create your own repo (private is fine; it contains no
secrets):

```bash
cd ../demo-shop
gh repo create <owner>/demo-shop --private --source . --remote origin --push
# or, for an existing empty repo:
git remote add origin https://github.com/<owner>/demo-shop.git
git push -u origin main
```

**3. Run it** — stop old servers first, then three terminals:

```bash
npm run demo:reset -- --close-prs      # optional: tidy up previous demo PRs

# Terminal 1
PATCHPILOT_OPEN_PR=1 PATCHPILOT_MOCK=1 npm start

# Terminal 2
npm run demo:shop

# Terminal 3
npm run demo:try -- 01                 # ❌ 500 {"error":"Cannot read properties of null (reading 'price')"}
```

```powershell
# Windows PowerShell, Terminal 1
$env:PATCHPILOT_OPEN_PR = "1"; $env:PATCHPILOT_MOCK = "1"; npm start
```

The dashboard shows the incident go `triage → reproduce → fix → validate → review → pr →
done` with a link to a **draft** PR holding two commits: the failing test, then the fix.

**4. Prove the fix works** — stop the shop, check out the PR, restart:

```bash
cd ../demo-shop
gh pr checkout 1 --detach
# restart the shop (Terminal 2), then:
npm run demo:try -- 01                 # ✅ 200 {"total":25}
git checkout main                      # put the target back
```

**5. The escalation case** — a request that contradicts an existing test:

```bash
DEMO_REPO=demo-shop npm run demo:crash -- 11
```

Bug 11 asks for something an existing test forbids. The Fixer's first patch breaks the full
suite and is rejected; its next move, editing `tests/checkout.test.js`, is **blocked** by
the guardrails; it then calls `flag_for_human_intervention` and the incident ends in
**Needs Human** — with no PR opened.

## How PatchPilot uses Cline

- **All four agents run on the Cline SDK's `Agent`** ([`src/pipeline/model.ts`](src/pipeline/model.ts)).
  One `runAgent` call per stage — triage, reproduce, fix, review — configured with
  `providerId`/`modelId`/`apiKey`, a system prompt, tools and `maxIterations`. Mock mode
  swaps the model only; the rest of the loop is the SDK's.
- **Guardrails ride on `hooks.beforeTool`** ([`src/pipeline/guardrails.ts`](src/pipeline/guardrails.ts)).
  This is the load-bearing part: the SDK hands every tool call to the hook first, so
  PatchPilot decides whether it may happen. A refusal returns `{ skip: true, reason }` and
  the agent is told why. Mock tool calls go through the same hook, so the demo and the
  benchmark exercise the real rule.
- **Custom `AgentTool`s** ([`src/pipeline/tools.ts`](src/pipeline/tools.ts)) — `read_file`
  (numbered, 400-line cap), `search_codebase` (5 queries, 50 matches each),
  `editor` (`old_text` must match exactly once), `write_file`, plus the stage-specific
  `run_test_file`, `run_repro_test` and `flag_for_human_intervention`. Every path is
  resolved against the sandbox and refused if it escapes.
- **Live pricing from `@cline/llms`** ([`src/pipeline/cost.ts`](src/pipeline/cost.ts)) —
  `getModelsForProvider(providerId)` returns per-model `pricing.input/output/cacheRead/
  cacheWrite`, so cost is computed for whatever model actually ran, in USD and ₹.
  A small static Claude table is only a fallback.
- **Provider-agnostic by construction**: Anthropic, Gemini, any OpenAI-compatible endpoint.
  Providers that execute tools inside their own process are *refused*, because their tools
  never reach `beforeTool` and the guardrails would be theatre.
- **The same rules guard our own Cline session** —
  [`.clinerules/hooks/PreToolUse.js`](.clinerules/hooks/PreToolUse.js) applies the path,
  test-file and protected-file rules while this project is being built with Cline.

## Testing and evaluation

```bash
npm run ci                        # Linux / macOS — and the same command in PowerShell
```

Ten planted bugs plus one that *should* be escalated rather than fixed:

```bash
PATCHPILOT_MOCK=1 npm run bench
```

Expected: **Fix rate 10/10 · Reproduction rate 10/10 · Escalation honesty 1/1 ·
Unsafe actions blocked ≥ 1**.

How it is scored (`.patchpilot/benchmark-report.json` has the per-bug detail):

- **Fix rate**: a fix counts only if the bug's *golden test* passes in the sandbox afterwards.
  Golden tests live in `benchmark/golden/`, and no agent ever sees them.
- **Reproduction rate**: the Reproducer's test was verified failing by PatchPilot.
- **Escalation honesty**: bug 11 must end in Needs Human, not a "fix".
- **Wrongly escalated**: fixable bugs that went to a human anyway.
- **Unsafe actions blocked**, **median time to PR** and **cost** (₹ and $).

Crash bugs really throw: the runner imports the module, calls it, and builds the event with
the same capture middleware the app uses. Manual bugs are filed as plain-English reports
that name the suspect file, as a bug reporter usually would.

### What mock mode proves, and what it doesn't

Mock mode (`PATCHPILOT_MOCK=1`) replaces only the model: each agent's answer and tool
calls come from [`src/pipeline/mockFixtures.ts`](src/pipeline/mockFixtures.ts). Everything
else is real — the sandboxes, the test runs, the guardrails (mock tool calls go through the
same `beforeTool`), the hard checks, the commits and the golden-test scoring.

So a mock run **proves the harness**: a correct patch is accepted, a test edit is blocked,
a regressing patch is rejected and reverted, an impossible request is escalated, and the
scoring is honest. It **does not** prove that a model finds these fixes; the fixtures know
the answers. Token counts in mock mode are fake (100 in / 50 out per call). Only a real-model
run measures the agents.

## Configuration

[`patchpilot.config.json`](patchpilot.config.json) describes each target repo. `root` +
`subdir` is the app folder, which is also the agents' working directory and the base for
every `testPaths` / `protectedPaths` glob:

```json
{
  "defaultRepo": "demo-app",
  "maxFixAttempts": 3,
  "minTriageConfidence": 0.35,
  "repos": {
    "demo-app": {
      "root": ".", "subdir": "demo-app",
      "testCommand": ["node", "--test"],
      "testPaths": ["tests"],
      "protectedPaths": ["server.js", "package.json", "package-lock.json", ".env", ".env.*"],
      "maxDiffLines": 150, "maxDiffFiles": 3, "baseRef": "HEAD"
    }
  }
}
```

Add your own repo by copying that block, pointing `root`/`subdir` at your app and setting
`baseRef` to the branch you want fixes merged into.

## How the guardrails work

PatchPilot's real guarantee is that **no agent decision is trusted**:

- sandboxes are `git worktree`s with LF forced, so CRLF cannot break an exact-text edit;
- tests always run in the sandbox, never in your checkout;
- the diff is taken from the index (`git add -A` then `git diff --cached`) so a brand-new
  file cannot slip past the checks;
- the `beforeTool` hook blocks, before they happen: any write during Triage, test-file edits
  during the fix, writes to protected paths (`server.js`, `package.json`, `.env*`…), writes
  outside the test folders by the Reproducer, any change to the locked reproduction test,
  paths that escape the sandbox, and dangerous shell commands. Paths are normalised first,
  so `./tests/../server.js` is caught as `server.js`;
- a Fixer attempt is accepted only if the reproduction test passes, the **full** suite
  passes, no test file changed, no protected path changed, no `.skip(`/`.only(`/`xit(`
  marker, module mock or `valueOf`/`toJSON` override was added, the braces balance, and the
  diff is within the configured size;
- failures reset the sandbox to the "test commit" and feed the reason back to the next
  attempt;
- provider-executed tool providers are refused, because their tools never reach the
  `beforeTool` hook that enforces all of the above.

The same rules are available to you as a Cline dev hook in
[`.clinerules/hooks/PreToolUse.js`](.clinerules/hooks/PreToolUse.js).

## Capturing crashes from your own app

The middleware has **zero dependencies** and never throws, never blocks the response, and
always calls `next(err)`:

```js
import { patchpilotMiddleware } from "./patchpilot-express.js";

app.use(patchpilotMiddleware({
  endpoint: "http://localhost:4747/api/incidents",
  repo: "demo-app",                                  // a key of patchpilot.config.json → repos
  root: path.dirname(fileURLToPath(import.meta.url)), // the app folder: frames are made relative to it
}));
```

Pass `root`: stack frames outside it (node internals, `node_modules`, a test harness) are
not in-app, and the rest become paths relative to the app folder, as the agents expect.
Register it **after** your routes so it sees everything they throw. You can also file a
report by hand with `POST /api/incidents/manual`.

## Layout

```
src/pipeline/     sandbox, testrunner, tools, guardrails, hardchecks, model, orchestrator, pr, cost
src/agents/       localize, triage, reproduce, fix, review, util
src/capture/      fingerprint, incident
sdk/              the dependency-free Express capture middleware
demo-app/         a deliberately buggy Express shop (10 bugs) + its happy-path tests
benchmark/        the bug catalog, golden tests, and the runner
scripts/          crash.ts, try.ts, reset.ts, make-shop.ts
dashboard/        a single-file live dashboard
docs/             demo video script and submission checklist
```

## Honest limitations

- **JavaScript/TypeScript and Express only.** The capture middleware is Express; the
  brace-balance check and suspect line ranges understand JS/TS syntax.
- **The suite is the specification.** PatchPilot accepts a fix when the reproduction test
  and the full suite pass. A weak suite lets a wrong fix through; the Critic and the human
  reviewer are the remaining defence.
- **One reproduction test per incident.** Bugs that need several scenarios, timing,
  concurrency or external services are hard to reproduce this way, and such incidents end
  in Needs Human rather than a guess.
- **Guardrails cover PatchPilot's own tools.** Providers that run tools inside their own
  process bypass `beforeTool`, so they are refused unless you override that.
- **Tests run on the host.** Sandboxes are git worktrees, not containers. Run PatchPilot
  only against code you trust to execute.
- **Real-model results vary** with the model and provider load; the mock benchmark's 10/10
  is a test of the harness, not of a model.
- **PatchPilot never merges.** Every PR is a draft for a human to review.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE` / "could not start on port 4747" | A previous server is still running. Stop it by port (see [Stop by port](#stop-by-port)) — closing the window is not enough. |
| `EPERM: operation not permitted` during `npm run demo:reset` on Windows | A sandbox worktree is locked because a process still holds a file. Stop the PatchPilot server and the demo app **first**, then reset. Never run `demo:reset` while a server or benchmark is running. |
| `node --test` cannot find tests, or an unexpected syntax error | Node is older than 22. Run `node -v`; use nvm to install Node 22+. |
| `401` / `403` / "exceeded your current quota" / billing | An account problem, not a transient one: PatchPilot fails immediately with "check the API key, quota and billing". Free Gemini tiers run out after roughly one bug. |
| `gh: command not found`, or `gh pr create` fails | Install and log in with `gh auth login`. Also confirm the target repo has a remote and your token has `repo` scope. |
| An incident ends in `needs_human` when you expected a fix | The Reproducer's test could not be proven failing, or the Fixer hit a contradiction. The dashboard timeline records every rejection with its reason. |
| Nothing happens after `npm run demo:crash` | The demo app is not running, or `PATCHPILOT_ENDPOINT` points elsewhere. The demo app's terminal prints "reporting crashes to …" on startup — check it. |

## License

Private.