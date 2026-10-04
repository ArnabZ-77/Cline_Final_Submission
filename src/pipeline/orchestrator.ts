/**
 * The pipeline: incident → sandbox → Triage → Reproducer → (commit test) → Fixer ×≤N with
 * PatchPilot's own validation → Critic → (commit fix) → PR.
 *
 * Every claim an agent makes is re-checked here (trap 24). Every stage's usage is added to
 * the incident as it happens. Any exception ends in `failed` with the message, and
 * `finishedAt` / `durationMs` are always set.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inrPerUsd, resolveModelSettings, type ModelSettings, type PatchPilotConfig } from "../config.ts";
import { FINISHED_STAGES, type IncidentStore } from "../store.ts";
import { rankSuspects, listTestFiles } from "../agents/localize.ts";
import { runTriage } from "../agents/triage.ts";
import { runReproducer } from "../agents/reproduce.ts";
import { runFixer } from "../agents/fix.ts";
import { runCritic } from "../agents/review.ts";
import { clip, type AgentContext } from "../agents/util.ts";
import { addUsage, computeCost, recordStage, resolvePricing, type ModelPricingLike } from "./cost.ts";
import { commitAll, createSandbox, diffNames, diffText, revertAll } from "./sandbox.ts";
import { runTests } from "./testrunner.ts";
import { braceBalanceOk, runHardChecks } from "./hardchecks.ts";
import { isTestPath, normaliseAgentPath } from "./guardrails.ts";
import { buildPrBody, buildPrTitle, openDraftPr } from "./pr.ts";
import type { AgentAnswer, Attempt, CriticReview, Incident, Reproduction, Stage, TriageResult } from "../types.ts";

export interface PipelineDeps {
  store: IncidentStore;
  config: PatchPilotConfig;
  /** Defaults to resolveModelSettings() (env). */
  settings?: ModelSettings;
  /** Per-stage model timeout; defaults to the model wrapper's 240 s. */
  timeoutMs?: number;
  /** Defaults to PATCHPILOT_OPEN_PR === "1". */
  openPr?: boolean;
}

/** Why a test run "failed" for the wrong reason: the file did not even load. */
const LOAD_FAILURE = /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module|does not provide an export named|ReferenceError: \w+ is not defined\s*$/m;

const MAX_REPRO_TRIES = 2;

class NeedsHuman extends Error {}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function short(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (typeof i.path === "string") return i.path;
  if (Array.isArray(i.queries)) return i.queries.map(String).join(", ").slice(0, 80);
  if (typeof i.reason === "string") return clip(i.reason, 80);
  return "";
}

export async function processIncident(inc: Incident, deps: PipelineDeps): Promise<Incident> {
  const { store, config } = deps;
  const started = Date.now();
  inc.startedAt = new Date(started).toISOString();
  const log = (type: string, text: string, data?: unknown) => store.log(inc, type, text, data);
  const stage = (s: Stage, note?: string) => store.setStage(inc, s, note);
  let pricing: ModelPricingLike | undefined;

  /** Adds an answer's usage to the incident (priced from the catalog if the answer is not). */
  const account = (s: string, answer: AgentAnswer) => {
    const usage = answer.usage.costUsd > 0 ? answer.usage : computeCost(answer.usage, pricing);
    addUsage(inc.usage, usage);
    recordStage(inc.usage, s, usage);
    store.save(inc);
  };

  try {
    const settings = deps.settings ?? resolveModelSettings();
    const repo = config.repos[inc.repo];
    if (!repo) throw new Error(`unknown repo "${inc.repo}"`);
    pricing = await resolvePricing(settings.providerId, settings.modelId);
    log("info", `model ${settings.providerId}/${settings.modelId}${process.env.PATCHPILOT_MOCK === "1" ? " (mock mode)" : ""}`);

    // --- sandbox ----------------------------------------------------------------------
    const sandbox = createSandbox(repo, inc.id);
    inc.sandbox = sandbox;
    log("info", `sandbox ${sandbox.branch} at ${sandbox.dir} (from ${repo.baseRef})`);

    const ctx: AgentContext = {
      incident: inc,
      repo,
      cwd: sandbox.cwd,
      settings,
      timeoutMs: deps.timeoutMs,
      onBlock: (b) => {
        inc.guardrailBlocks.push(b);
        log("block", `blocked ${b.tool}: ${b.reason}`, b);
      },
      onCall: (tool, input) => log("tool", `${tool} ${short(input)}`.trim()),
      onEvent: (e) => {
        if (e.type === "status-notice") log("notice", e.message);
        else if (e.type === "run-failed") log("error", `model run failed: ${e.error?.message ?? "unknown"}`);
      },
    };

    // --- triage -----------------------------------------------------------------------
    stage("triage");
    const suspects = rankSuspects(inc.frames, sandbox.cwd, repo);
    log("info", `${suspects.length} suspect(s) from the stack`, suspects);
    const tri = await runTriage(ctx, suspects);
    account("triage", tri.answer);
    const triage: TriageResult = tri.result;
    inc.triage = triage;
    log("triage", `root cause (${triage.confidence.toFixed(2)}): ${triage.rootCause}`, { suspects: triage.suspects });
    if (!triage.rootCause) throw new NeedsHuman("Triage could not name a root cause.");
    if (triage.needsHuman) throw new NeedsHuman(`Triage asked for a human: ${triage.rootCause}`);
    if (triage.confidence < config.minTriageConfidence) {
      throw new NeedsHuman(
        `Triage confidence ${triage.confidence.toFixed(2)} is below the minimum ${config.minTriageConfidence}: ${triage.rootCause}`
      );
    }

    // --- reproduce --------------------------------------------------------------------
    stage("reproduce");
    const reproduction = await reproduce(ctx, triage, account, log);
    inc.reproduction = reproduction;
    // Trap 3: commit the accepted test BEFORE the Fixer starts, so it is never part of the
    // Fixer's diff and a revert can never delete it.
    commitAll(sandbox.dir, `test: reproduce ${inc.id} (fails before fix)`);
    log("info", `committed ${reproduction.testFile} (sha256 ${reproduction.lockedHash.slice(0, 12)})`);

    const baseline = await runTests(repo, sandbox.cwd);
    inc.baseline = { ok: baseline.ok, passed: baseline.passed, failed: baseline.failed, summary: baseline.summary };
    log("info", `baseline with the new test: ${baseline.passed} passed, ${baseline.failed} failed`);

    // --- fix + validate ---------------------------------------------------------------
    const rejections: string[] = [];
    let accepted: Attempt | undefined;
    for (let n = 1; n <= config.maxFixAttempts && !accepted; n += 1) {
      stage("fix", `attempt ${n}`);
      const attemptStart = Date.now();
      const fx = await runFixer(ctx, triage, reproduction, n, config.maxFixAttempts, rejections);
      account("fix", fx.answer);
      stage("validate", `attempt ${n}`);
      const attempt: Attempt = {
        index: n,
        ok: false,
        escalated: false,
        files: [],
        hardChecks: [],
        text: fx.result.summary,
        usage: fx.answer.usage,
        startedAt: new Date(attemptStart).toISOString(),
        finishedAt: "",
        durationMs: 0,
      };
      const reject = (reason: string) => {
        revertAll(sandbox.cwd);
        attempt.reason = reason;
        rejections.push(reason);
        log("reject", `attempt ${n} rejected: ${reason.split("\n")[0]}`, { reason });
      };

      const verdict = await validateAttempt(ctx, reproduction, fx.result, attempt);
      if (verdict.kind === "escalate") {
        revertAll(sandbox.cwd);
        attempt.escalated = true;
        attempt.reason = verdict.reason;
        finish(attempt);
        inc.attempts.push(attempt);
        throw new NeedsHuman(`The Fixer escalated: ${verdict.reason}`);
      }
      if (verdict.kind === "reject") reject(verdict.reason);
      else {
        attempt.ok = true;
        accepted = attempt;
        log("accept", `attempt ${n} accepted: ${attempt.files.join(", ")}`);
      }
      finish(attempt);
      inc.attempts.push(attempt);
      store.save(inc);
    }
    if (!accepted) {
      throw new NeedsHuman(
        `No acceptable fix after ${config.maxFixAttempts} attempt(s). Last rejection: ${rejections.at(-1)?.split("\n")[0] ?? "unknown"}`
      );
    }

    // --- review -----------------------------------------------------------------------
    stage("review");
    const diff = diffText(sandbox.cwd);
    accepted.diff = diff;
    try {
      const rv = await runCritic(ctx, triage, diff);
      account("review", rv.answer);
      inc.review = rv.result;
    } catch (err) {
      // The critic informs the PR; it does not gate it. Record that it failed.
      inc.review = criticUnavailable(err);
    }
    log("review", `critic ${inc.review.confidence.toFixed(2)}: ${inc.review.addressesRootCause ? "addresses the root cause" : "doubts the fix"}`, inc.review);

    // --- commit + PR ------------------------------------------------------------------
    const title = buildPrTitle(inc);
    commitAll(sandbox.dir, title);
    log("info", `committed the fix on ${sandbox.branch}`);

    stage("pr");
    const body = buildPrBody(inc, { inrPerUsd: inrPerUsd() });
    inc.pr = { title, branch: sandbox.branch, body, opened: false };
    const openPr = deps.openPr ?? process.env.PATCHPILOT_OPEN_PR === "1";
    if (openPr) {
      const res = openDraftPr(sandbox.dir, sandbox.branch, title, body, repo.baseRef);
      if (res.url) {
        inc.pr.url = res.url;
        inc.pr.opened = true;
        log("pr", `draft PR opened: ${res.url}`);
      } else {
        inc.pr.error = res.error;
        log("error", `could not open the PR: ${res.error}`);
      }
    } else {
      inc.pr.error = "not opened: set PATCHPILOT_OPEN_PR=1 to push the branch and open a draft PR";
      log("pr", `PR ready on branch ${sandbox.branch} (not opened: PATCHPILOT_OPEN_PR is not 1)`);
    }
    stage("done");
  } catch (err) {
    if (err instanceof NeedsHuman) {
      inc.needsHumanReason = err.message;
      stage("needs_human", err.message);
    } else {
      inc.error = err instanceof Error ? err.message : String(err);
      if (!FINISHED_STAGES.includes(inc.stage)) stage("failed", inc.error);
    }
  } finally {
    inc.finishedAt = new Date().toISOString();
    inc.durationMs = Date.now() - started;
    log("info", `finished in ${(inc.durationMs / 1000).toFixed(1)} s — ${inc.stage}; cost ₹${inc.usage.costInr.toFixed(2)} ($${inc.usage.costUsd.toFixed(4)})`);
  }
  return inc;
}

function finish(a: Attempt): void {
  a.finishedAt = new Date().toISOString();
  a.durationMs = Date.parse(a.finishedAt) - Date.parse(a.startedAt);
}

function criticUnavailable(err: unknown): CriticReview {
  return {
    confidence: 0,
    addressesRootCause: false,
    behaviorChangeOutsideCrashPath: "unknown: the critic did not answer",
    risks: [`the critic review failed: ${err instanceof Error ? err.message : String(err)}`],
  };
}

/**
 * Runs the Reproducer (up to twice), then checks its test independently: one new test file
 * inside the test folders, nothing else changed, and it FAILS for the right reason.
 */
async function reproduce(
  ctx: AgentContext,
  triage: TriageResult,
  account: (stage: string, answer: AgentAnswer) => void,
  log: (type: string, text: string, data?: unknown) => void
): Promise<Reproduction> {
  const { repo, cwd } = ctx;
  const existing = new Set(listTestFiles(cwd, repo).map((f) => f.toLowerCase()));
  let feedback: string | undefined;
  for (let tryNo = 1; tryNo <= MAX_REPRO_TRIES; tryNo += 1) {
    const rp = await runReproducer(ctx, triage, feedback);
    account("reproduce", rp.answer);
    const claimed = rp.result.testFile;
    const rel = claimed ? normaliseAgentPath(cwd, claimed) : null;
    const problem = !rel
      ? "Your answer did not name the test file (test_file), or it is outside the app folder."
      : !isTestPath(rel, repo)
        ? `${rel} is not inside the test folders (${repo.testPaths.join(", ")}).`
        : existing.has(rel.toLowerCase())
          ? `${rel} already existed. Create a NEW test file with a unique name.`
          : !fs.existsSync(path.join(cwd, rel))
            ? `${rel} does not exist; the write may have been blocked.`
            : undefined;
    if (problem || !rel) {
      revertAll(cwd);
      feedback = problem;
      log("reject", `reproduction ${tryNo} rejected: ${problem}`);
      continue;
    }

    // Keep ONLY the new test: anything else the Reproducer touched is discarded.
    const content = fs.readFileSync(path.join(cwd, rel), "utf8");
    const others = diffNames(cwd).filter((f) => f.toLowerCase() !== rel.toLowerCase());
    revertAll(cwd);
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), content, "utf8");
    if (others.length > 0) log("info", `discarded other changes by the Reproducer: ${others.join(", ")}`);

    // Trap 24: run it ourselves. It must fail, and fail because of the bug.
    const run = await runTests(repo, cwd, [rel]);
    const wrongReason = LOAD_FAILURE.test(run.summary);
    if (run.ok || run.failed < 1 || run.timedOut || wrongReason) {
      const why = run.ok
        ? "it PASSES on the current code, so it does not reproduce the bug"
        : run.timedOut
          ? "it timed out"
          : wrongReason
            ? "it fails because the file does not load (syntax error, bad import or missing export), not because of the bug"
            : "it reported no failing test";
      feedback = `PatchPilot ran ${rel}: ${why}.\n${run.summary.slice(0, 1500)}`;
      revertAll(cwd);
      log("reject", `reproduction ${tryNo} rejected: ${why}`);
      continue;
    }
    log("repro", `${rel} fails on the current code as required (${run.failed} failing)`);
    return {
      testFile: rel,
      testName: rp.result.testName || path.basename(rel),
      lockedHash: sha256(content),
      verifiedFailing: true,
      failureSummary: run.summary.slice(0, 2000),
    };
  }
  throw new NeedsHuman(`Could not reproduce the bug with a failing test: ${feedback ?? "unknown reason"}`);
}

type Verdict = { kind: "accept" } | { kind: "reject"; reason: string } | { kind: "escalate"; reason: string };

/** PatchPilot's own checks on one Fixer attempt, in the spec's order. */
async function validateAttempt(
  ctx: AgentContext,
  repro: Reproduction,
  fix: { escalate: boolean; reason: string },
  attempt: Attempt
): Promise<Verdict> {
  const { repo, cwd } = ctx;

  // 1. The locked reproduction test is untouched.
  const testAbs = path.join(cwd, repro.testFile);
  const current = fs.existsSync(testAbs) ? sha256(fs.readFileSync(testAbs, "utf8")) : "";
  if (current !== repro.lockedHash) {
    return { kind: "reject", reason: `The locked reproduction test ${repro.testFile} was modified or deleted.` };
  }

  // 2. Escalation requested.
  if (fix.escalate) return { kind: "escalate", reason: fix.reason || "the Fixer flagged the test as flawed" };

  // 3. There is a change at all.
  const files = diffNames(cwd);
  attempt.files = files;
  if (files.length === 0) return { kind: "reject", reason: "No changes were made. Edit the source code to fix the root cause." };

  // 4. Hard checks + brace balance.
  const diff = diffText(cwd);
  attempt.diff = diff;
  attempt.hardChecks = [...runHardChecks(diff, files, repo), braceBalanceOk(cwd, files)];
  const failed = attempt.hardChecks.filter((h) => !h.ok);
  if (failed.length > 0) {
    return {
      kind: "reject",
      reason: `Hard checks failed: ${failed.map((h) => `${h.name}${h.detail ? ` (${h.detail})` : ""}`).join("; ")}`,
    };
  }

  // 5. The reproduction test passes.
  const r = await runTests(repo, cwd, [repro.testFile]);
  attempt.reproTest = { ok: r.ok, summary: `${r.passed} passed / ${r.failed} failed` };
  if (!r.ok) {
    return { kind: "reject", reason: `The reproduction test still fails:\n${r.summary.slice(0, 1500)}` };
  }

  // 6. The FULL suite passes.
  const full = await runTests(repo, cwd);
  attempt.fullSuite = { ok: full.ok, passed: full.passed, failed: full.failed, summary: full.summary.slice(0, 2000) };
  if (!full.ok) {
    return {
      kind: "reject",
      reason: `Full suite regressed: ${full.failed} test(s) failing after your change. Behavior outside the bug must not change.\n${full.summary.slice(0, 1500)}`,
    };
  }
  return { kind: "accept" };
}

/** Wires the pipeline into the server: a new incident starts processing in the background. */
export function makeIncidentHandler(deps: PipelineDeps) {
  return (inc: Incident) => processIncident(inc, deps).then(() => undefined);
}

