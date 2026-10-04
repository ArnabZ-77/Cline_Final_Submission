# Submission checklist

Everything a judge needs, and everything left for the user to do.

## 1. Repository

| Item | Value | Verified |
|---|---|---|
| Repo | <https://github.com/ArnabZ-77/Cline-Submission> | ✅ public |
| Opens logged out | Private/incognito window, no GitHub session | ⬜ **user must check** |
| Setup + run instructions | `README.md` — Linux/macOS first, PowerShell second | ✅ |
| Demo video | link TBD | ⬜ **user must record** |

The README is self-contained: clone → `npm ci` → `PATCHPILOT_MOCK=1 npm start` → crash a
bug → watch the dashboard. No API key required.

## 2. The draft pull request lives in a PRIVATE repo

The real draft PR that PatchPilot opened is here:

- <https://github.com/ArnabZ-77/patchpilot-demo-shop-v2/pull/1> — **private repo, judges
  cannot open it.**

That repo is a deliberately buggy demo shop. It contains no secrets (verified: see §5), so
it is safe to make public. **Choose one — the user must decide:**

- [ ] **(a) Make it public** so judges can open the PR directly.
      `gh repo edit ArnabZ-77/patchpilot-demo-shop-v2 --visibility public --accept-visibility-change-consequences`
- [ ] **(b) Add the judges as collaborators** on the private repo.
- [ ] **(c) Rely on screenshots in `docs/`** plus the video, and leave it private.

## 3. Cline chat history

The complete, unedited chat history is required. **The user does the export; this repo does
not contain it.**

1. In Cline, open the task history panel for the PatchPilot task.
2. Export **each** task (the long main task, plus any side tasks). Export them **complete
   and unedited** — do not trim, summarise or redact.
3. Where to put them:
   - upload to the submission form / Drive as the organisers require, **or**
   - commit them to this repo under `docs/cline-history/` — **only if** the organisers allow
     committing chat logs (they contain the full conversation).
4. Do not "clean up" the history: terminal output, retries and mistakes are part of the
   evidence.

## 4. Demo video

- Script and shot list: [`docs/demo-video-script.md`](demo-video-script.md) — 3–4 minutes,
  timed, with exact commands and a pre-recording checklist.
- After recording: confirm the link plays **logged out** in a private window. ⬜

## 5. Secret hygiene — verified

- `.env` is in `.gitignore` and is **not** committed.
- The secret grep run before every commit (Google / Anthropic / Azure key shapes) returns
  **no matches** across the working tree.
- The private demo-shop repo holds only source and tests; no keys.

## 6. Optional social post (3 lines)

> A bug report used to mean: read a stack trace at 2 a.m., guess, and hope the test suite
> catches your mistake. PatchPilot turns a crash — or a plain-English complaint — into a
> tested draft PR, and refuses to touch the test when the two disagree.
> Built on the Cline SDK; guardrails enforced in code, not in the prompt.
> https://github.com/ArnabZ-77/Cline-Submission

## 7. What the judges will see when they run it

| Check | Expected result |
|---|---|
| `npm run ci` | typecheck clean · 152 unit tests · demo-app 14/14 |
| `PATCHPILOT_MOCK=1 npm run bench` | Fix 10/10 · Reproduction 10/10 · Escalation honesty 1/1 · ≥1 unsafe action blocked |
| `PATCHPILOT_MOCK=1 npm start` + `npm run demo:crash -- 01` | incident reaches `done`, draft PR prepared on a local branch |

All three verified on **Windows 11 / Node 24**, twice: in PowerShell 5.1, and on a **fresh
clone in a temp folder, following the README's bash commands literally** in Git Bash
(`git clone` → `npm ci` → `cp .env.example .env` → `npm run ci` → `PATCHPILOT_MOCK=1 npm run
bench` → `PATCHPILOT_MOCK=1 npm start` + `npm run demo` + `npm run demo:crash -- 01` → incident
`done`). `npm run demo:make-shop` was verified the same way (shop builds, its 14 tests pass,
a second run refuses to overwrite). Behaviour on real macOS and Linux is **not verified on
those operating systems**; nothing in the code is Windows-specific, and every command is
an npm script.

## 8. Still open for the user

- [ ] Make/keep the demo-shop private, or publish it (§2)
- [ ] Export the Cline chat history (§3)
- [ ] Record and upload the video; verify it plays logged out (§4)
- [ ] Decide what to do with the old public repo `ArnabZ-77/patchpilot-demo-shop`
      (a different build, with an open draft PR #1): make it private, archive it, or leave it
- [ ] Optional: a real-model run needs a key in `.env`; mock mode is what is verified here