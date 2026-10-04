/**
 * Reproducer: writes ONE test that fails on the current code because of the bug.
 *
 * It may only write inside the configured test folders. Whatever it claims, PatchPilot
 * re-runs the test itself before accepting it (trap 24), in the orchestrator.
 */
import fs from "node:fs";
import path from "node:path";
import { makeTools, resolveInCwd } from "../pipeline/tools.ts";
import { makeBeforeTool } from "../pipeline/guardrails.ts";
import { runAgent } from "../pipeline/model.ts";
import { runTests } from "../pipeline/testrunner.ts";
import { listTestFiles } from "./localize.ts";
import { extractJson, incidentReport, mockTag, pick, slugify } from "./util.ts";
import type { AgentContext, AgentStageResult } from "./util.ts";
import type { TriageResult } from "../types.ts";

export const REPRODUCE_SYSTEM_PROMPT = `You are the Reproducer agent of PatchPilot.

Write ONE regression test that reproduces the bug described to you, so that it FAILS on the current code and will PASS once the bug is fixed.
- Call the real exported functions of the app. Do not mock the code under test and do not re-implement it inside the test.
- The test must fail with an ASSERTION (or the real crash) on the current code, not because of a typo, a wrong import path or a missing export.
- Assert the INTENDED behavior given to you, not the current buggy behavior.
- Create exactly one new test file, at the path you are told to use, in the same style as the example. Do not edit any other file.
- Run it with run_test_file and confirm it fails for the right reason. Fix the test if it fails for the wrong reason.

Finish with exactly one fenced JSON block:
\`\`\`json
{ "test_file": "tests/....test.js", "test_name": "the test's name", "failure": "how it fails on the current code" }
\`\`\``;

/** The existing test closest to the suspect, as a style example. */
export function pickStyleExample(ctx: AgentContext, suspectFile: string | undefined): string | undefined {
  const tests = listTestFiles(ctx.cwd, ctx.repo).filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) && !f.includes("__golden__"));
  if (tests.length === 0) return undefined;
  const base = suspectFile ? path.basename(suspectFile).replace(/\.[^.]+$/, "").toLowerCase() : "";
  return tests.find((t) => path.basename(t).toLowerCase().startsWith(`${base}.`)) ?? tests.find((t) => !t.includes("patchpilot-")) ?? tests[0];
}

/** A unique file name for this incident's regression test (trap 21). */
export function suggestedTestFile(ctx: AgentContext, triage: TriageResult): string {
  const testDir = ctx.repo.testPaths[0] ?? "tests";
  const symbol = triage.suspects[0]?.symbol ?? path.basename(triage.suspects[0]?.file ?? "bug").replace(/\.[^.]+$/, "");
  const slug = slugify(`${symbol} ${ctx.incident.id.slice(-6)}`, 40);
  return `${testDir}/patchpilot-${slug}.test.js`;
}

export function buildReproducePrompt(ctx: AgentContext, triage: TriageResult, feedback?: string): string {
  const suspect = triage.suspects[0];
  const example = pickStyleExample(ctx, suspect?.file);
  const parts: string[] = [];
  parts.push(
    "## Triage findings\n" +
      triage.suspects.map((s) => `- Suspect: ${s.file}${s.symbol ? ` (${s.symbol})` : ""}${s.reason ? ` — ${s.reason}` : ""}`).join("\n") +
      `\nRoot cause: ${triage.rootCause}\nIntended behavior: ${triage.intendedBehavior}`
  );
  parts.push(incidentReport(ctx.incident));
  parts.push(`## Where to write\nCreate the test at: ${suggestedTestFile(ctx, triage)}\nRun it with run_test_file.`);
  if (example) {
    const src = fs.readFileSync(path.join(ctx.cwd, example), "utf8");
    parts.push(`## Style example (${example})\n\`\`\`js\n${src.slice(0, 3000)}\n\`\`\``);
  }
  if (feedback) parts.push(`## Your previous test was rejected\n${feedback}\nWrite a corrected test.`);
  parts.push(mockTag("reproduce"));
  return parts.join("\n\n");
}

export function parseReproduction(text: string): { testFile: string; testName: string } {
  const raw = extractJson<Record<string, unknown>>(text);
  return {
    testFile: String(pick(raw, "test_file", "testFile") ?? "").replace(/\\/g, "/").replace(/^\.\//, ""),
    testName: String(pick(raw, "test_name", "testName") ?? ""),
  };
}

/** The Reproducer's `run_test_file` tool: runs one test file in the sandbox. */
export function runTestFileTool(ctx: AgentContext) {
  return {
    name: "run_test_file",
    description: "Run one test file with the project's test command and return the pass/fail counts and failure output.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Test file path relative to the app folder" } },
      required: ["path"],
    },
    async execute(input: { path: string }) {
      try {
        const abs = resolveInCwd(ctx.cwd, input?.path);
        const rel = path.relative(ctx.cwd, abs).split(path.sep).join("/");
        const r = await runTests(ctx.repo, ctx.cwd, [rel]);
        return `${r.passed} passed, ${r.failed} failed${r.timedOut ? " (timed out)" : ""}\n${r.summary}`;
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export async function runReproducer(
  ctx: AgentContext,
  triage: TriageResult,
  feedback?: string
): Promise<AgentStageResult<{ testFile: string; testName: string }>> {
  const tools = [
    ...makeTools(ctx.cwd).filter((t) => t.name !== "write_file"),
    runTestFileTool(ctx),
  ];
  const beforeTool = makeBeforeTool({
    stage: "reproduce",
    repo: ctx.repo,
    cwd: ctx.cwd,
    allowWritePaths: ctx.repo.testPaths,
    onBlock: ctx.onBlock,
    onCall: ctx.onCall,
  });
  const answer = await runAgent(buildReproducePrompt(ctx, triage, feedback), {
    settings: ctx.settings,
    systemPrompt: REPRODUCE_SYSTEM_PROMPT,
    tools: tools as never,
    maxIterations: 16,
    beforeTool: beforeTool as never,
    onEvent: ctx.onEvent,
    timeoutMs: ctx.timeoutMs,
  });
  return { result: parseReproduction(answer.text), answer };
}
