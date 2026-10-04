import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appDirOf, loadConfig, resolveModelSettings } from "../src/config.ts";
import { IncidentStore } from "../src/store.ts";
import { createIncident, manualEvent } from "../src/capture/incident.ts";
import { processIncident } from "../src/pipeline/orchestrator.ts";
import { git, gitTry, removeSandbox } from "../src/pipeline/sandbox.ts";
import { buildPrBody, buildPrTitle } from "../src/pipeline/pr.ts";
import { buildEvent } from "../sdk/patchpilot-express.js";
import type { Incident, IncidentEvent } from "../src/types.ts";

// End to end in mock mode: real sandboxes, real tests, real guardrails; fixture answers.
const previousMock = process.env.PATCHPILOT_MOCK;
const config = loadConfig();
const repo = config.repos["demo-app"];
const appDir = appDirOf(repo);
let storeDir = "";
let store: IncidentStore;
const made: Incident[] = [];

beforeAll(() => {
  process.env.PATCHPILOT_MOCK = "1";
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-pipeline-"));
  store = new IncidentStore(storeDir);
});

afterAll(() => {
  for (const inc of made) {
    if (!inc.sandbox) continue;
    removeSandbox(repo, inc.id);
    gitTry(repo.root, ["branch", "-D", inc.sandbox.branch]);
  }
  fs.rmSync(storeDir, { recursive: true, force: true });
  if (previousMock === undefined) delete process.env.PATCHPILOT_MOCK;
  else process.env.PATCHPILOT_MOCK = previousMock;
});

async function run(ev: IncidentEvent, extra: Partial<Incident> = {}): Promise<Incident> {
  const inc = Object.assign(createIncident(ev, "demo-app", appDir), extra);
  made.push(inc);
  store.add(inc);
  return processIncident(inc, { store, config, settings: resolveModelSettings(), openPr: false });
}

describe("pipeline (mock mode)", () => {
  it("bug 01: a real crash becomes a tested fix on its own branch, in two commits", async () => {
    const { computeTotal } = await import(new URL("../demo-app/src/lib/total.js", import.meta.url).href);
    let err: unknown;
    try {
      computeTotal([{ price: 10, quantity: 2 }, null]);
    } catch (e) {
      err = e;
    }
    const inc = await run(buildEvent(err, { method: "POST", route: { path: "/api/orders/total" } }, { root: appDir }) as IncidentEvent);

    expect(inc.stage, inc.error ?? inc.needsHumanReason).toBe("done");
    expect(inc.stageHistory.map((s) => s.stage)).toEqual(["received", "triage", "reproduce", "fix", "validate", "review", "pr", "done"]);
    expect(inc.frames.at(-1)?.filename).toBe("src/lib/total.js");
    expect(inc.reproduction?.verifiedFailing).toBe(true);
    expect(inc.reproduction?.lockedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(inc.attempts).toHaveLength(1);
    expect(inc.attempts[0].hardChecks.every((h) => h.ok)).toBe(true);
    expect(inc.attempts[0].fullSuite?.ok).toBe(true);
    expect(inc.usage.inputTokens).toBeGreaterThan(0);
    expect(inc.finishedAt).toBeTruthy();

    const log = git(inc.sandbox!.dir, ["log", "--author=PatchPilot", "--format=%s"]).split("\n");
    expect(log).toHaveLength(2);
    expect(log[1]).toMatch(/^test: reproduce .* \(fails before fix\)$/);
    expect(log[0]).toMatch(/^fix: /);
    // The test commit holds only the test; the fix commit only source.
    expect(git(inc.sandbox!.dir, ["show", "--name-only", "--format=", "HEAD~1"])).toMatch(/^demo-app\/tests\/patchpilot-.*\.test\.js$/);
    expect(git(inc.sandbox!.dir, ["show", "--name-only", "--format=", "HEAD"])).toBe("demo-app/src/lib/total.js");

    expect(inc.pr?.opened).toBe(false);
    expect(inc.pr?.body).toContain("PatchPilot never merges its own patches");
  });

  it("bug 11: a request that contradicts a test is blocked and escalated, never implemented", async () => {
    const description =
      "Product wants a placeholder order: an empty cart must be allowed to check out, so canCheckout([]) should return true. Please change canCheckout to allow it.";
    const inc = await run(
      manualEvent({ title: "Allow a placeholder order", description, suspectFile: "src/lib/checkout.js" }),
      { description, suspectFile: "src/lib/checkout.js" }
    );
    expect(inc.stage).toBe("needs_human");
    expect(inc.needsHumanReason).toMatch(/escalated/i);
    expect(inc.attempts[0].reason).toMatch(/^Full suite regressed/);
    expect(inc.attempts.at(-1)?.escalated).toBe(true);
    expect(inc.guardrailBlocks.map((b) => [b.stage, b.tool, (b.input as { path: string }).path])).toEqual([
      ["fix", "editor", "tests/checkout.test.js"],
    ]);
    // Nothing was committed beyond the reproduction test, and the sandbox is clean.
    expect(git(inc.sandbox!.dir, ["log", "--author=PatchPilot", "--format=%s"]).split("\n")).toHaveLength(1);
    expect(git(inc.sandbox!.cwd, ["status", "--porcelain"])).toBe("");
  });

  it("never changes the main working copy of the target app", () => {
    expect(git(repo.root, ["status", "--porcelain", "--", repo.subdir])).toBe("");
  });
});

describe("pull request text", () => {
  const base = (over: Partial<Incident> = {}): Incident =>
    ({
      ...createIncident(manualEvent({ title: "t", description: "d" }), "demo-app", appDir),
      ...over,
    }) as Incident;

  it("title is fix: <root cause> with the root cause capped at 72 characters", () => {
    const long = "x".repeat(200);
    const title = buildPrTitle(base({ triage: { rootCause: long, intendedBehavior: "", suspects: [], confidence: 1, needsHuman: false } }));
    expect(title.startsWith("fix: ")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(5 + 72);
  });

  it("body has every required section", () => {
    const body = buildPrBody(
      base({
        triage: { rootCause: "rc", intendedBehavior: "ib", suspects: [{ file: "src/a.js", symbol: "f" }], confidence: 0.9, needsHuman: false },
        review: { confidence: 0.8, addressesRootCause: true, behaviorChangeOutsideCrashPath: false, risks: ["r1"], openQuestion: "q?" },
      })
    );
    for (const s of [
      "## Fixes inc_",
      "_fingerprint `",
      "**Root cause:** rc",
      "**Confidence:**",
      "**Open question:** q?",
      "### Evidence",
      "### Reproduction test",
      "### Change summary",
      "### Verification",
      "### What the agent did not do / risk notes",
      "### Provenance",
      "₹",
      "A human reviews and merges this PR — PatchPilot never merges its own patches.",
    ]) {
      expect(body, s).toContain(s);
    }
  });
});
