/**
 * Shared helpers for the four agents.
 */
import type { AgentRuntimeEvent } from "@cline/agents";
import type { ModelSettings } from "../config.ts";
import type { AgentAnswer, GuardrailBlock, Incident, RepoConfig } from "../types.ts";

/** What every agent needs: where it works, which model, and where to report. */
export interface AgentContext {
  incident: Incident;
  repo: RepoConfig;
  /** Sandbox app folder: the agent's working directory. */
  cwd: string;
  settings: ModelSettings;
  onBlock: (block: GuardrailBlock) => void;
  onCall?: (tool: string, input: unknown) => void;
  onEvent?: (event: AgentRuntimeEvent) => void;
  timeoutMs?: number;
}

export interface AgentStageResult<T> {
  result: T;
  answer: AgentAnswer;
}

/** The `MOCK_TAG:<stage>` marker mock mode dispatches on (harmless to a real model). */
export function mockTag(stage: "triage" | "reproduce" | "fix" | "review"): string {
  return `(internal routing tag: MOCK_TAG:${stage})`;
}

/** The incident as the agents see it: the exception, or the plain-English report. */
export function incidentReport(inc: Incident): string {
  const ev = inc.events[inc.events.length - 1];
  const lines: string[] = ["## Incident"];
  if (inc.exceptionType === "ReportedBug") {
    lines.push(`Bug report: ${inc.title.replace(/^ReportedBug:\s*/, "")}`);
    if (inc.description) lines.push(`Description: ${inc.description}`);
  } else {
    lines.push(`Exception: ${inc.exceptionType}: ${inc.exceptionValue}`);
    if (ev?.transaction) lines.push(`Transaction: ${ev.transaction}`);
    lines.push(`Occurrences: ${inc.occurrences}`);
    const chain = ev?.exception?.values ?? [];
    if (chain.length > 1) lines.push(`Cause chain (oldest first): ${chain.map((v) => `${v.type}: ${v.value}`).join(" → ")}`);
  }
  return lines.join("\n");
}

/** First defined value among several key spellings (models drift between snake and camel). */
export function pick(obj: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  for (const k of keys) if (obj && obj[k] !== undefined) return obj[k];
  return undefined;
}

export function toNumber(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Pulls a JSON object out of an agent's answer.
 *
 * Models wrap JSON in prose, fences, or both, and they often emit a short example object
 * before the real one. The rule is: the **last** fenced ```json block wins; if there is no
 * fence, fall back to the first balanced `{...}` span.
 */
export function extractJson<T>(text: string): T {
  const source = String(text ?? "");
  const fenced = [...source.matchAll(/```json\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  const candidates = [...fenced].reverse();
  if (candidates.length > 0) {
    for (const candidate of candidates) {
      const parsed = tryParse<T>(candidate);
      if (parsed !== undefined) return parsed;
    }
  }
  const span = firstBalancedSpan(source);
  if (span !== undefined) {
    const parsed = tryParse<T>(span);
    if (parsed !== undefined) return parsed;
  }
  throw new Error(`no JSON found in the agent's answer:\n${source.slice(0, 500)}`);
}

function tryParse<T>(raw: string): T | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return undefined;
  }
}

/** The first `{...}` span that balances, ignoring braces inside strings. */
function firstBalancedSpan(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Trims a model's answer down to something worth storing on an incident. */
export function clip(text: string, maxChars = 4000): string {
  const s = String(text ?? "").trim();
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

/** A filename-safe slug; used for unique per-bug test names (trap 21). */
export function slugify(text: string, maxLen = 48): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
}
