/**
 * Triage: read-only. Finds the root cause (not the symptom), the intended behaviour and the
 * suspects, with an honest confidence. Below `minTriageConfidence` the incident goes to a
 * human instead of guessing.
 */
import { makeTools } from "../pipeline/tools.ts";
import { makeBeforeTool } from "../pipeline/guardrails.ts";
import { runAgent } from "../pipeline/model.ts";
import { repoTree, suspectSnippet } from "./localize.ts";
import { extractJson, incidentReport, mockTag, pick, toNumber } from "./util.ts";
import type { AgentContext, AgentStageResult } from "./util.ts";
import type { Suspect, TriageResult } from "../types.ts";

export const TRIAGE_SYSTEM_PROMPT = `You are the Triage agent of PatchPilot, which turns production crashes and bug reports into tested pull requests.

Your job: find the TRUE ROOT CAUSE of the incident, not the symptom. The line that threw is often not where the mistake is.
- Read the suspect code and anything it calls or is called by. Use read_file and search_codebase. You cannot edit anything.
- State the intended behavior: what the code SHOULD do, in one or two sentences a reviewer can check.
- Name the suspects (file, symbol, why).
- Give an honest confidence between 0 and 1. If the evidence is thin or the report is ambiguous, give a LOWER confidence rather than guess. Set needs_human to true if a human must decide what the correct behavior is.

Finish with exactly one fenced JSON block:
\`\`\`json
{
  "root_cause": "one or two sentences",
  "intended_behavior": "what the code should do",
  "suspects": [{ "file": "src/...", "symbol": "functionName", "reason": "why" }],
  "confidence": 0.0,
  "needs_human": false
}
\`\`\``;

export function buildTriagePrompt(ctx: AgentContext, suspects: Suspect[]): string {
  const parts: string[] = [];
  // Suspects first: they name the file before anything else in the prompt does.
  parts.push("## Stack-ranked suspects (in-app frames, score 1 = the frame that threw)");
  if (suspects.length === 0) parts.push("(none: there is no usable stack; work from the report)");
  for (const s of suspects) {
    parts.push(`### ${s.file}${s.symbol ? ` — ${s.symbol}` : ""} (score ${s.score}, lines ${s.lineStart}-${s.lineEnd}; ${s.reason})`);
    const snippet = suspectSnippet(ctx.cwd, s);
    if (snippet) parts.push("```js\n" + snippet + "\n```");
  }
  parts.push(incidentReport(ctx.incident));
  parts.push("## Repository (app folder)\n```\n" + repoTree(ctx.cwd) + "\n```");
  parts.push("Investigate, then answer with the JSON block.");
  parts.push(mockTag("triage"));
  return parts.join("\n\n");
}

export function parseTriage(text: string, fallbackSuspects: Suspect[]): TriageResult {
  const raw = extractJson<Record<string, unknown>>(text);
  const suspectsRaw = pick(raw, "suspects");
  const suspects: Suspect[] = Array.isArray(suspectsRaw)
    ? suspectsRaw
        .map((s) => (typeof s === "string" ? { file: s } : (s as Record<string, unknown>)))
        .filter((s) => typeof s.file === "string" && s.file.length > 0)
        .map((s) => ({
          file: String(s.file).replace(/\\/g, "/").replace(/^\.\//, ""),
          symbol: typeof s.symbol === "string" ? s.symbol : undefined,
          reason: typeof s.reason === "string" ? s.reason : undefined,
          score: typeof s.score === "number" ? s.score : undefined,
        }))
    : [];
  const confidence = Math.min(1, Math.max(0, toNumber(pick(raw, "confidence"), 0)));
  return {
    rootCause: String(pick(raw, "root_cause", "rootCause") ?? "").trim(),
    intendedBehavior: String(pick(raw, "intended_behavior", "intendedBehavior") ?? "").trim(),
    suspects: suspects.length > 0 ? suspects : fallbackSuspects,
    confidence,
    needsHuman: Boolean(pick(raw, "needs_human", "needsHuman")),
    raw: text.slice(0, 4000),
  };
}

export async function runTriage(ctx: AgentContext, suspects: Suspect[]): Promise<AgentStageResult<TriageResult>> {
  const all = makeTools(ctx.cwd);
  // Read tools only: Triage is never handed a write tool (the guardrail is the backstop).
  const tools = all.filter((t) => t.name === "read_file" || t.name === "search_codebase");
  const beforeTool = makeBeforeTool({ stage: "triage", repo: ctx.repo, cwd: ctx.cwd, onBlock: ctx.onBlock, onCall: ctx.onCall });
  const answer = await runAgent(buildTriagePrompt(ctx, suspects), {
    settings: ctx.settings,
    systemPrompt: TRIAGE_SYSTEM_PROMPT,
    tools: tools as never,
    maxIterations: 14,
    beforeTool: beforeTool as never,
    onEvent: ctx.onEvent,
    timeoutMs: ctx.timeoutMs,
  });
  return { result: parseTriage(answer.text, suspects), answer };
}
