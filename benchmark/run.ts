/**
 * PatchPilot benchmark: run every planted bug through the real pipeline and score it.
 *
 *   npx tsx benchmark/run.ts            all bugs
 *   npx tsx benchmark/run.ts 01         one bug (id prefix or name)
 *
 * Crash bugs really throw: the module is imported and called, and the event is built by the
 * same capture middleware the app uses. Manual bugs go in as plain-English reports.
 * A fix only counts when the bug's golden test, which no agent ever sees, passes in the
 * sandbox afterwards.
 *
 * Env: PATCHPILOT_MOCK=1 (fixtures, no model), BENCH_KEEP=1 (keep sandboxes/branches),
 * BENCH_REPO=<name> (default: the config's defaultRepo).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DATA_DIR, appDirOf, inrPerUsd, isMockMode, loadConfig, resolveModelSettings } from "../src/config.ts";
import { IncidentStore } from "../src/store.ts";
import { createIncident, manualEvent } from "../src/capture/incident.ts";
import { processIncident } from "../src/pipeline/orchestrator.ts";
import { runTests } from "../src/pipeline/testrunner.ts";
import { gitTry, removeSandbox } from "../src/pipeline/sandbox.ts";
import { buildEvent } from "../sdk/patchpilot-express.js";
import { BUGS, selectBugs } from "./golden/bugs.js";
import type { Incident, IncidentEvent } from "../src/types.ts";

interface BugResult {
  id: string;
  name: string;
  source: string;
  expect: string;
  stage: string;
  reproduced: boolean;
  fixed: boolean | null;
  goldenSummary?: string;
  attempts: number;
  blocks: number;
  durationMs: number;
  costUsd: number;
  costInr: number;
  commits?: string[];
  reason?: string;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function eventFor(bug: (typeof BUGS)[number], appDir: string, repoName: string): Promise<IncidentEvent> {
  if (bug.source === "crash") {
    const mod = await import(pathToFileURL(path.join(appDir, bug.file)).href);
    let thrown: unknown;
    if (!bug.crash) throw new Error(`crash bug ${bug.id} has no crash.call`);
    try {
      bug.crash.call(mod);
    } catch (err) {
      thrown = err;
    }
    if (!thrown) throw new Error(`bug ${bug.id} was expected to throw but did not`);
    const req = {
      method: bug.request?.method ?? "GET",
      route: { path: bug.request?.path ?? "/" },
      originalUrl: bug.request?.path ?? "/",
      headers: { "content-type": "application/json" },
    };
    // root = the APP folder (trap 20): harness frames must not count as in-app.
    return buildEvent(thrown, req, { root: appDir, repo: repoName }) as IncidentEvent;
  }
  const description = String(bug.description ?? "");
  const title = description.split(/(?<=[.!?])\s/)[0].slice(0, 100);
  return manualEvent({ title, description, suspectFile: bug.file, repo: repoName });
}

async function main() {
  const prefix = process.argv[2];
  const config = loadConfig();
  const repoName = process.env.BENCH_REPO || config.defaultRepo;
  const repo = config.repos[repoName];
  if (!repo) {
    console.error(`unknown repo "${repoName}"`);
    process.exit(1);
  }

  let settings;
  try {
    settings = resolveModelSettings();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  if (!isMockMode() && !settings.apiKey && settings.providerId !== "ollama") {
    console.error(
      `No API key for provider "${settings.providerId}". Set it in .env (see .env.example), ` +
        `or run in mock mode:  $env:PATCHPILOT_MOCK="1"; npm run bench`
    );
    process.exit(1);
  }
  console.log(`PatchPilot benchmark — ${isMockMode() ? "MOCK MODE (fixtures, no model calls)" : `${settings.providerId}/${settings.modelId}`}`);
  console.log(`repo: ${repoName} (${appDirOf(repo)})\n`);

  const bugs = selectBugs(prefix);
  if (bugs.length === 0) {
    console.error(`no bug matches "${prefix}"`);
    process.exit(1);
  }

  const store = new IncidentStore(path.join(DATA_DIR, "benchmark", "incidents"));
  const appDir = appDirOf(repo);
  const results: BugResult[] = [];

  for (const bug of bugs) {
    const expect = bug.expect ?? "done";
    process.stdout.write(`[${bug.id}] ${bug.name.padEnd(12)} ${bug.source.padEnd(6)} … `);
    const event = await eventFor(bug, appDir, repoName);
    const inc: Incident = createIncident(event, repoName, appDir);
    if (bug.source === "manual") {
      inc.description = String(bug.description ?? "");
      inc.suspectFile = bug.file;
    }
    store.add(inc);
    await processIncident(inc, { store, config, settings, openPr: false });

    let fixed: boolean | null = null;
    let goldenSummary: string | undefined;
    let commits: string[] | undefined;
    if (inc.sandbox) {
      commits = gitTry(inc.sandbox.dir, ["log", "--author=PatchPilot", "--format=%s"]).out.split("\n").filter(Boolean).reverse();
    }
    if (bug.golden) {
      fixed = false;
      if (inc.stage === "done" && inc.sandbox) {
        const dest = path.join(inc.sandbox.cwd, "tests", "__golden__");
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(path.join(import.meta.dirname, "golden", bug.golden), path.join(dest, bug.golden));
        const g = await runTests(repo, inc.sandbox.cwd, [`tests/__golden__/${bug.golden}`]);
        fixed = g.ok;
        goldenSummary = g.ok
          ? `${g.passed} passed / ${g.failed} failed`
          : `${g.passed} passed / ${g.failed} failed · exit ${g.exitCode}${
              g.timedOut ? " · TIMED OUT" : ""
            }${g.failures.length ? `: ${g.failures.slice(0, 2).join("; ")}` : ""}`;
        fs.rmSync(dest, { recursive: true, force: true });
      }
    }

    const r: BugResult = {
      id: bug.id,
      name: bug.name,
      source: bug.source,
      expect,
      stage: inc.stage,
      reproduced: Boolean(inc.reproduction?.verifiedFailing),
      fixed,
      goldenSummary,
      attempts: inc.attempts.length,
      blocks: inc.guardrailBlocks.length,
      durationMs: inc.durationMs ?? 0,
      costUsd: inc.usage.costUsd,
      costInr: inc.usage.costInr,
      commits,
      reason: inc.needsHumanReason ?? inc.error,
    };
    results.push(r);

    const verdict =
      expect === "needs_human"
        ? inc.stage === "needs_human"
          ? "✅ escalated (correct)"
          : `❌ expected needs_human, got ${inc.stage}`
        : fixed
          ? "✅ fixed (golden test passes)"
          : `❌ ${inc.stage}${
              // A golden check that fails is usually environmental (a half-written file, a
              // lost race), so print WHY it failed instead of a bare stage name.
              goldenSummary ? ` (golden: ${goldenSummary})` : ""
            }${r.reason ? `: ${r.reason.split("\n")[0].slice(0, 100)}` : ""}`;
    console.log(`${verdict}  [${(r.durationMs / 1000).toFixed(1)} s, ${r.attempts} attempt(s), ${r.blocks} block(s)]`);
    if (commits?.length) console.log(`       commits: ${commits.map((c) => JSON.stringify(c.slice(0, 70))).join(" → ")}`);

    if (process.env.BENCH_KEEP !== "1" && inc.sandbox) {
      removeSandbox(repo, inc.id);
      gitTry(repo.root, ["branch", "-D", inc.sandbox.branch]);
    }
  }

  // --- report -------------------------------------------------------------------------
  const fixable = results.filter((r) => r.expect !== "needs_human");
  const honesty = results.filter((r) => r.expect === "needs_human");
  const fixedN = fixable.filter((r) => r.fixed).length;
  const reproN = fixable.filter((r) => r.reproduced).length;
  const wronglyEscalated = fixable.filter((r) => r.stage === "needs_human").length;
  const honestN = honesty.filter((r) => r.stage === "needs_human").length;
  const blocks = results.reduce((n, r) => n + r.blocks, 0);
  const costUsd = results.reduce((n, r) => n + r.costUsd, 0);
  const costInr = results.reduce((n, r) => n + r.costInr, 0);
  const medianMs = median(results.filter((r) => r.stage === "done").map((r) => r.durationMs));

  const report = {
    generatedAt: new Date().toISOString(),
    mode: isMockMode() ? "mock" : "real",
    provider: settings.providerId,
    model: settings.modelId,
    repo: repoName,
    fixRate: { fixed: fixedN, total: fixable.length },
    reproductionRate: { reproduced: reproN, total: fixable.length },
    medianTimeToPrMs: medianMs,
    wronglyEscalated,
    escalationHonesty: { correct: honestN, total: honesty.length },
    unsafeActionsBlocked: blocks,
    cost: { usd: Math.round(costUsd * 10000) / 10000, inr: Math.round(costInr * 100) / 100, inrPerUsd: inrPerUsd() },
    bugs: results,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const reportPath = path.join(DATA_DIR, "benchmark-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("\n──────── results ────────");
  if (fixable.length) {
    console.log(`Fix rate              ${fixedN}/${fixable.length}`);
    console.log(`Reproduction rate     ${reproN}/${fixable.length}`);
    console.log(`Wrongly escalated     ${wronglyEscalated}`);
  }
  if (honesty.length) console.log(`Escalation honesty    ${honestN}/${honesty.length}`);
  console.log(`Unsafe actions blocked ${blocks}`);
  console.log(`Median time to PR     ${medianMs === null ? "n/a" : `${(medianMs / 1000).toFixed(1)} s`}`);
  console.log(`Cost                  ₹${costInr.toFixed(2)} ($${costUsd.toFixed(4)})${isMockMode() ? "  (mock: token counts are fake)" : ""}`);
  console.log(`report: ${path.relative(process.cwd(), reportPath)}`);
  if (BUGS.length && bugs.length === BUGS.length && fixedN < fixable.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

