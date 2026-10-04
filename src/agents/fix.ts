/**
 * Fixer: edits source only, to make the locked reproduction test pass without breaking the
 * suite. PatchPilot validates every attempt itself (orchestrator); the Fixer's claims are
 * never trusted (trap 24).
 */
import { makeTools } from "../pipeline/tools.ts";
import { makeBeforeTool } from "../pipeline/guardrails.ts";
import { runAgent } from "../pipeline/model.ts";
import { runTests } from "../pipeline/testrunner.ts";
import { extractJson, incidentReport, mockTag, pick } from "./util.ts";
import type { AgentContext, AgentStageResult } from "./util.ts";
import type { Reproduction, TriageResult } from "../types.ts";

/** The ImpossibleBench wording, verbatim from the spec: it cut test-carving sharply. */
export const FIXER_CORE_INSTRUCTION =
  "Implement a fix according to the root cause and intended behavior given to you. As you work, critically evaluate the failing test. If you find the test itself is logically flawed or inconsistent with the documented behavior, STOP, explain why, and call flag_for_human_intervention — do NOT try to carve out the code just to make an incorrect test pass. Do NOT modify any test file.";

export const FIX_SYSTEM_PROMPT = `You are the Fixer agent of PatchPilot.

${FIXER_CORE_INSTRUCTION}

How to work:
- Read the suspect code first (read_file, search_codebase), then make the smallest correct change with editor. old_text must match the file exactly once.
- Fix the root cause, not the symptom. Keep behavior outside the bug unchanged; the full test suite must still pass.
- Run run_repro_test to check your change. PatchPilot re-runs the reproduction test and the full suite itself after you finish.
- Never edit test files, never skip or disable tests, never add mocks, and never override valueOf/toJSON/Symbol.toPrimitive to fake equality. These are enforced and will be rejected.

Finish with exactly one fenced JSON block:
\`\`\`json
{ "summary": "what you changed and why", "files": ["src/..."], "escalate": false, "reason": "" }
\`\`\`
If you called flag_for_human_intervention, set "escalate": true and explain in "reason".`;

export interface FixOutcome {
  summary: string;
  files: string[];
  /** Set from the tool call itself, never only from the model's text. */
  escalate: boolean;
  reason: string;
}

export function buildFixPrompt(
  ctx: AgentContext,
  triage: TriageResult,
  repro: Reproduction,
  attempt: number,
  maxAttempts: number,
  previousRejections: string[]
): string {
  const parts: string[] = [];
  parts.push(
    "## Triage findings\n" +
      triage.suspects.map((s) => `- Suspect: ${s.file}${s.symbol ? ` (${s.symbol})` : ""}${s.reason ? ` — ${s.reason}` : ""}`).join("\n") +
      `\nRoot cause: ${triage.rootCause}\nIntended behavior: ${triage.intendedBehavior}`
  );
  parts.push(incidentReport(ctx.incident));
  parts.push(
    `## Reproduction test (locked; you may read it, never change it)\nFile: ${repro.testFile}\nTest: ${repro.testName}\n` +
      (repro.failureSummary ? `It currently fails like this:\n\`\`\`\n${repro.failureSummary.slice(0, 1500)}\n\`\`\`` : "")
  );
  parts.push(`## Attempt ${attempt} of ${maxAttempts}`);
  if (previousRejections.length > 0) {
    parts.push(
      "## Previous attempts were rejected by PatchPilot's checks (your changes were reverted)\n" +
        previousRejections.map((r, i) => `### Rejection ${i + 1}\n${r}`).join("\n\n")
    );
  }
  parts.push(mockTag("fix"));
  return parts.join("\n\n");
}

export function parseFix(text: string): Omit<FixOutcome, "escalate"> & { escalate: boolean } {
  let raw: Record<string, unknown> = {};
  try {
    raw = extractJson<Record<string, unknown>>(text);
  } catch {
    // A Fixer that changed code but forgot the JSON is still validated on its diff.
  }
  const files = pick(raw, "files");
  return {
    summary: String(pick(raw, "summary") ?? "").trim(),
    files: Array.isArray(files) ? files.map(String) : [],
    escalate: pick(raw, "escalate") === true,
    reason: String(pick(raw, "reason") ?? "").trim(),
  };
}

export async function runFixer(
  ctx: AgentContext,
  triage: TriageResult,
  repro: Reproduction,
  attempt: number,
  maxAttempts: number,
  previousRejections: string[]
): Promise<AgentStageResult<FixOutcome>> {
  let flagged: string | undefined;
  const tools = [
    ...makeTools(ctx.cwd).filter((t) => t.name !== "write_file"),
    {
      name: "run_repro_test",
      description: "Run the locked reproduction test against your current changes.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        const r = await runTests(ctx.repo, ctx.cwd, [repro.testFile]);
        return `${r.ok ? "PASSES" : "FAILS"}: ${r.passed} passed, ${r.failed} failed${r.timedOut ? " (timed out)" : ""}\n${r.summary}`;
      },
    },
    {
      name: "flag_for_human_intervention",
      description:
        "Stop and hand the incident to a human: use when the failing test is logically flawed or contradicts the documented behavior, so no honest code change can satisfy it.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string", description: "Why a human must decide" } },
        required: ["reason"],
      },
      async execute(input: { reason?: string }) {
        flagged = String(input?.reason ?? "no reason given");
        return "Flagged for human intervention. Stop now and give your final JSON answer with escalate: true.";
      },
    },
  ];
  const beforeTool = makeBeforeTool({
    stage: "fix",
    repo: ctx.repo,
    cwd: ctx.cwd,
    lockedFiles: [repro.testFile],
    onBlock: ctx.onBlock,
    onCall: ctx.onCall,
  });
  const answer = await runAgent(buildFixPrompt(ctx, triage, repro, attempt, maxAttempts, previousRejections), {
    settings: ctx.settings,
    systemPrompt: FIX_SYSTEM_PROMPT,
    tools: tools as never,
    maxIterations: 20,
    beforeTool: beforeTool as never,
    onEvent: ctx.onEvent,
    timeoutMs: ctx.timeoutMs,
  });
  const parsed = parseFix(answer.text);
  const escalate = flagged !== undefined || parsed.escalate;
  return {
    result: { ...parsed, escalate, reason: flagged ?? parsed.reason },
    answer,
  };
}
