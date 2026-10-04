/**
 * Critic: an independent review with no tools and one turn. It sees only the root cause,
 * the hypothesis and the diff, so it judges the change on its own merits.
 */
import { runAgent } from "../pipeline/model.ts";
import { extractJson, mockTag, pick, toNumber } from "./util.ts";
import type { AgentContext, AgentStageResult } from "./util.ts";
import type { CriticReview, TriageResult } from "../types.ts";

export const REVIEW_SYSTEM_PROMPT = `You are the Critic of PatchPilot: an independent code reviewer. You have no tools.

You are given a root-cause analysis, the intended behavior, and a diff that claims to fix it. Judge the diff:
- Does it address the ROOT CAUSE, or only hide the symptom?
- Does it change behavior outside the crash path (other inputs, other callers)?
- What could go wrong? Be specific and brief.
- Is there one open question a human reviewer should answer?

Answer with exactly one fenced JSON block:
\`\`\`json
{
  "confidence": 0.0,
  "addresses_root_cause": true,
  "behavior_change_outside_crash_path": false,
  "risks": ["..."],
  "open_question": ""
}
\`\`\``;

export function buildReviewPrompt(ctx: AgentContext, triage: TriageResult, diff: string): string {
  return [
    `## Root cause\n${triage.rootCause}`,
    `## Hypothesis (intended behavior)\n${triage.intendedBehavior}`,
    // The report's title keeps mock routing for bug #11 working; it carries no code.
    `## Incident\n${ctx.incident.title}`,
    `## Diff\n\`\`\`diff\n${diff.slice(0, 12000)}\n\`\`\``,
    mockTag("review"),
  ].join("\n\n");
}

export function parseReview(text: string): CriticReview {
  const raw = extractJson<Record<string, unknown>>(text);
  const outside = pick(raw, "behavior_change_outside_crash_path", "behaviorChangeOutsideCrashPath");
  const risks = pick(raw, "risks");
  const question = pick(raw, "open_question", "openQuestion");
  return {
    confidence: Math.min(1, Math.max(0, toNumber(pick(raw, "confidence"), 0))),
    addressesRootCause: pick(raw, "addresses_root_cause", "addressesRootCause") === true,
    behaviorChangeOutsideCrashPath: typeof outside === "string" ? outside : outside === true,
    risks: Array.isArray(risks) ? risks.map(String).filter(Boolean) : [],
    openQuestion: typeof question === "string" && question.trim() ? question.trim() : undefined,
    raw: text.slice(0, 4000),
  };
}

export async function runCritic(ctx: AgentContext, triage: TriageResult, diff: string): Promise<AgentStageResult<CriticReview>> {
  const answer = await runAgent(buildReviewPrompt(ctx, triage, diff), {
    settings: ctx.settings,
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    tools: [],
    maxIterations: 1,
    onEvent: ctx.onEvent,
    timeoutMs: ctx.timeoutMs,
  });
  return { result: parseReview(answer.text), answer };
}
