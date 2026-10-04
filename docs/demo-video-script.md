# PatchPilot — demo video script

**Target length: 3–4 minutes.** One voiceover, screen recording, no face-cam needed.
Timings are cumulative. The commands are exact; the narration under each shot is what to
say while they run.

---

## Pre-recording checklist

- [ ] Nothing listening on 4747 or 5050 (see *Stop by port* in the README); stop servers
      **before** resetting
- [ ] `npm run demo:reset` — clean incidents, sandboxes, `patchpilot/*` branches, shop on
      `main`. Add `-- --close-prs` only if you want earlier demo PRs closed (the new PR then
      gets the next number)
- [ ] `../demo-shop` exists and has a GitHub remote (`git -C ../demo-shop remote -v`)
- [ ] Do one dry run of the whole script off camera: mock mode makes each run ~3 s
- [ ] **Close every window that might show `.env`, a key, or a token.** The demo never
      needs one: it runs in mock mode. Never type `cat .env` while recording.
- [ ] Terminal zoomed so ~90 characters fit; font size ~14–16
- [ ] Browser zoom 100%, dashboard dark-mode readable
- [ ] GitHub open in a **logged-out** private window for the PR shot (or pre-open the PR tab)
- [ ] Notifications off; desktop notifications off
- [ ] No `.patchpilot/` or `node_modules/` visible in the file manager

Two terminals, both starting in the repo folder:

```bash
cd <path>/Cline-Submission
```

---

## 0:00 — the problem (20 s)

**Say:** "It's 2 a.m. A production error page fires. Someone has to read a stack trace,
guess the root cause, write a test that fails for the right reason, fix the code, and open a
pull request — without breaking anything else. Most AI tools will confidently change the
test instead. PatchPilot doesn't trust itself: every claim is re-checked in code, and when
a request contradicts a test, it escalates to a human instead of guessing."

**Show:** title card, then the terminal.

---

## 0:20 — architecture (25 s)

**Say:** "A crash hits the app. A zero-dependency middleware builds a Sentry-shaped event
and posts it here. PatchPilot groups it into an incident, opens a throwaway git worktree so
your checkout is never touched, then runs four agents: Triage, Reproducer, Fixer, Critic."

**Show:** the README architecture diagram (open the README, scroll to *How it works*).

---

## 0:45 — crash bug 01, live (60 s)

The video uses the **standalone shop** (`../demo-shop`, which has a GitHub remote), because
the next shot shows the real pull request. The in-repo `npm run demo` app has no remote, so
it can never open a PR. See the README's *Live demo* section to set the shop up once.

**Terminal 1** (start it before recording):

```bash
PATCHPILOT_OPEN_PR=1 PATCHPILOT_MOCK=1 npm start
```

```powershell
$env:PATCHPILOT_OPEN_PR = "1"; $env:PATCHPILOT_MOCK = "1"; npm start   # Windows PowerShell
```

**Terminal 2** (start it before recording):

```bash
npm run demo:shop            # the buggy shop on :5050, reporting as repo "demo-shop"
```

**Terminal 3** (on camera):

```bash
npm run demo:try -- 01       # ❌ 500 {"error":"Cannot read properties of null (reading 'price')"}
```

That one request both shows the bug and reports the crash: the shop's middleware posts it
to PatchPilot. No separate `demo:crash` is needed.

**Browser:** <http://localhost:4747/>

**Say:** "One request crashes the checkout endpoint. The middleware captured the stack, and
the incident is already moving: triage, reproduce, fix, validate, review, pr, done — in about
three seconds."

**Point at:** the stage rail filling in, the timeline entries, the cost in ₹ and $.

---

## 1:45 — the draft PR (45 s)

**Say:** "It wrote one regression test, proved it failed before the fix, committed that test
separately, then fixed the code and pushed its own branch. The pull request is a draft —
PatchPilot never merges."

**Show (GitHub):** the PR — exactly **two commits**:

```
test: reproduce inc_… (fails before fix)
fix: computeTotal dereferences every item without a guard…
```

Scroll the body: root cause, confidence, evidence, reproduction test, and the
**Verification** checklist — every hard check ticked, full suite 15/15.

**Say:** "Every box in Verification was computed by PatchPilot, not claimed by the model."

---

## 2:30 — bug 11: blocked, then escalated (30 s)

**Terminal 3:**

```bash
DEMO_REPO=demo-shop npm run demo:crash -- 11
```

```powershell
$env:DEMO_REPO = "demo-shop"; npm run demo:crash -- 11   # Windows PowerShell
```

**Browser:** the new incident.

**Say:** "Bug 11 asks for an empty cart to be allowed to check out — but an existing test
forbids it. Watch what happens: the first patch breaks the suite and is rejected; the next
move is to edit the test — and the guardrails block it in code, before the write happens.
So the agent escalates. Needs Human. No pull request."

**Point at:** the red `blocked` entry naming `tests/checkout.test.js`, and the stage ending
in **needs_human**.

---

## 3:00 — the benchmark (30 s)

**Say:** "Eleven planted bugs, scored by tests the agents never see."

```bash
PATCHPILOT_MOCK=1 npm run bench
```

```powershell
$env:PATCHPILOT_MOCK = "1"; npm run bench   # Windows PowerShell (~35 s; or pre-record it)
```

**Show (zoom on the scorecard):**

```
Fix rate              10/10
Reproduction rate     10/10
Escalation honesty    1/1
Unsafe actions blocked 1
```

**Say — and be honest:** "This is mock mode: the model answers come from fixtures. It proves
the *harness* — that correct patches are accepted and cheating ones are not. Only a
real-model run measures the agents."

---

## 3:30 — Cline SDK + the dev hook (30 s)

**Say:** "Everything runs on the Cline SDK's Agent. The guardrails ride on its `beforeTool`
hook, so the SDK hands us every tool call before it happens and we decide. Tools are
provider-agnostic — Anthropic, Gemini, any OpenAI-compatible endpoint — and providers that
run tools in their own process are refused, because they'd bypass the hook. We use the same
rules to guard our own Cline session: this project's `.clinerules/hooks/PreToolUse.js`."

**Show (split screen):** `src/pipeline/guardrails.ts` → `.clinerules/hooks/PreToolUse.js`.

**End card:** repo URL + "mock mode: no key required".

---

## If a shot goes wrong

| Problem | Do this |
|---|---|
| Port already in use | `lsof -ti tcp:4747 \| xargs kill` (Linux/macOS), then restart Terminal 1 |
| `needs_human` where you expected a fix | `npm run demo:reset`, then re-run the shot; incidents are de-duplicated by fingerprint, so a stale incident will not re-run the pipeline |
| A bug was already fixed from an earlier shot | `git -C ../demo-shop checkout main`, restart the shop |
| The incident ends `done` but shows "PR not opened" | Terminal 1 was started without `PATCHPILOT_OPEN_PR=1`, or the shop has no remote / `gh` is not logged in. The PR panel shows the exact error |
| The dashboard looks empty | `npm run demo:crash -- 01` again, or reload <http://localhost:4747/> |