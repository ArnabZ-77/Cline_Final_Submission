/**
 * The one place that talks to a model.
 *
 * Mock mode answers from `mockFixtures` but still goes through the tools, and those tools
 * are guarded by the same `beforeTool` the real runtime uses (trap 19) — otherwise the demo
 * could never show a guardrail block.
 *
 * Real mode follows traps 14-16:
 * 14  retry transient provider errors up to 3 times (10/20/30 s), with a fresh Agent each
 *     time, falling back to `PATCHPILOT_FALLBACK_MODEL` on the last try;
 * 15  a per-stage timeout calls `agent.abort("stage timeout")` and counts as transient;
 * 16  account problems (quota, billing, 401/403) are checked FIRST and fail immediately.
 */
import { Agent } from "@cline/agents";
import type {
  AgentBeforeToolResult,
  AgentRuntimeEvent,
  AgentRuntimeHooks,
  AgentTool,
  AgentUsage,
} from "@cline/agents";
import { isMockMode, type ModelSettings } from "../config.ts";
import { computeCost, resolvePricing } from "./cost.ts";
import { findMockFixture, mockHandlers, type MockTools } from "./mockFixtures.ts";
import type { AgentAnswer, UsageTotals } from "../types.ts";

// Neither package exports the context type by name (@cline/shared's two `export *`s
// collide on it), so take it from the hook signature: exactly what the runtime passes.
type AgentBeforeToolContext = Parameters<NonNullable<AgentRuntimeHooks["beforeTool"]>>[0];

export const DEFAULT_STAGE_TIMEOUT_MS = 240_000;
/** One try plus up to 3 retries (10/20/30 s); the last one uses the fallback model. */
export const MAX_ATTEMPTS = 4;
export const RETRY_DELAYS_MS = [10_000, 20_000, 30_000];

/**
 * Trap 16: never retry these — the user has to fix billing or the key. Phrase-level on
 * purpose: a bare "quota" also appears in per-minute rate-limit errors, which ARE
 * transient (trap 14) and must be retried.
 */
const ACCOUNT_PROBLEM =
  /exceeded your current quota|insufficient[_ ]quota|billing|payment required|credit balance is too low|invalid[ _-]?api[ _-]?key|incorrect api key|api key not valid|authentication[ _]error|permission[ _]denied|unauthorized|forbidden|(?:status|code|http)[^a-z0-9]{0,3}40[13]\b|^40[13]\b/im;

/** Trap 14: transient provider hiccups worth another try. */
const TRANSIENT =
  /high demand|overloaded|rate limit|\b429\b|\b503\b|unavailable|try again|timeout|timed out|etimedout|fetch failed|network|socket hang up|econnreset|temporarily/i;

export function isAccountProblem(message: string): boolean {
  return ACCOUNT_PROBLEM.test(String(message ?? ""));
}

export function isTransient(message: string): boolean {
  const text = String(message ?? "");
  if (ACCOUNT_PROBLEM.test(text)) return false;
  return TRANSIENT.test(text);
}

// Not unref'd: in the benchmark CLI the retry wait is the only thing keeping Node alive,
// and an unref'd timer would let the process exit silently mid-run.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RunAgentOptions {
  settings: ModelSettings;
  systemPrompt: string;
  tools: AgentTool[];
  maxIterations?: number;
  beforeTool?: (context: AgentBeforeToolContext) => AgentBeforeToolResult | undefined | Promise<AgentBeforeToolResult | undefined>;
  onEvent?: (event: AgentRuntimeEvent) => void;
  timeoutMs?: number;
  /** Extra sleep between retries; tests pass 0. */
  retryDelayMs?: number;
}

/** Fake usage for a mock answer, so cost accounting still has something to show. */
export const MOCK_USAGE: UsageTotals = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  costInr: 0,
};

/**
 * Trap 19: wrap every tool so `execute` calls `beforeTool` first. A skip becomes the tool's
 * result (the reason string), which is exactly what a real blocked tool call returns.
 */
export function guardTools(
  tools: AgentTool[],
  beforeTool?: RunAgentOptions["beforeTool"]
): AgentTool[] {
  if (!beforeTool) return tools;
  return tools.map((tool) => ({
    ...tool,
    async execute(input: unknown, context: unknown) {
      // Same context shape as the real runtime, including the top-level `input` the
      // guardrails read; without it every mock write would sail through unchecked.
      const result = await beforeTool({
        snapshot: { agentId: "mock", status: "running", iteration: 0, messages: [], pendingToolCalls: [], usage: emptyMockUsage() },
        tool,
        toolCall: { type: "tool-call", toolCallId: "mock", toolName: tool.name, input },
        input,
      } as AgentBeforeToolContext);
      // A skip returns the reason string as the tool result, as the real runtime does.
      if (result?.skip) return `blocked: ${result.reason ?? "blocked by guardrails"}`;
      return tool.execute(input as never, context);
    },
  }));
}

function emptyMockUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function asMockTools(tools: AgentTool[]): MockTools {
  const find = (name: string): AgentTool | undefined => tools.find((t) => t.name === name);
  const call = (name: string) => async (input: never) => {
    const tool = find(name);
    if (!tool) return { error: `no such tool: ${name}` };
    try {
      return await tool.execute(input, { agentId: "mock", iteration: 0 });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
  return {
    read_file: call("read_file") as MockTools["read_file"],
    search_codebase: call("search_codebase") as MockTools["search_codebase"],
    editor: call("editor") as MockTools["editor"],
    write_file: call("write_file") as MockTools["write_file"],
    run_test_file: find("run_test_file") ? (call("run_test_file") as MockTools["run_test_file"]) : undefined,
    run_repro_test: find("run_repro_test") ? (call("run_repro_test") as MockTools["run_repro_test"]) : undefined,
    flag_for_human_intervention: find("flag_for_human_intervention")
      ? (call("flag_for_human_intervention") as MockTools["flag_for_human_intervention"])
      : undefined,
  };
}

/** The `MOCK_TAG:<stage>` marker the mock handlers match on. */
export const MOCK_TAG_RE = /MOCK_TAG:([a-z_]+)/i;

export function mockTagOf(prompt: string): string | undefined {
  return MOCK_TAG_RE.exec(String(prompt ?? ""))?.[1]?.toLowerCase();
}

async function runMock(prompt: string, options: RunAgentOptions): Promise<AgentAnswer> {
  const handler = mockHandlers.find((h) => h.match.test(prompt));
  if (!handler) {
    return {
      text: `No mock handler matched this prompt (tag ${mockTagOf(prompt) ?? "missing"}).`,
      usage: { ...MOCK_USAGE },
      status: "mock-unmatched",
    };
  }
  const fixture = findMockFixture(prompt);
  const text = await handler.run({
    prompt,
    tag: handler.tag,
    fixture,
    tools: asMockTools(guardTools(options.tools, options.beforeTool)),
  });
  return { text, usage: { ...MOCK_USAGE }, status: "mock" };
}

async function runOnce(prompt: string, options: RunAgentOptions, modelId: string): Promise<AgentAnswer> {
  const { settings } = options;
  const timeout = options.timeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  // Once the stage times out this run is abandoned. `agent.abort()` does not interrupt an
  // in-flight HTTP request (a hung Gemini call ran ~11 min past a 240 s timeout), so the
  // run may keep going in the background: refuse its later tool calls so it cannot touch
  // the sandbox while the retry works there, and drop its events.
  let cancelled = false;
  const agent = new Agent({
    providerId: settings.providerId,
    modelId,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    systemPrompt: options.systemPrompt,
    tools: options.tools,
    maxIterations: options.maxIterations ?? 20,
    hooks: {
      beforeTool: async (ctx: AgentBeforeToolContext) =>
        cancelled ? { skip: true, reason: "this run was cancelled: the stage timed out" } : options.beforeTool?.(ctx),
      onEvent: (event: AgentRuntimeEvent) => {
        if (!cancelled) options.onEvent?.(event);
      },
    },
  });

  // Trap 15: the timeout must end the stage ON TIME and surface as "stage timeout"
  // (transient), however the runtime reacts to the abort.
  const timeoutError = () => new Error(`stage timeout after ${timeout} ms`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      cancelled = true;
      try {
        agent.abort("stage timeout");
      } catch {
        // already finished or not abortable: the race below still ends the stage
      }
      reject(timeoutError());
    }, timeout);
  });
  const running = agent.run(prompt);
  running.catch(() => undefined); // an abandoned run may reject later; nobody is listening

  try {
    let result;
    try {
      result = await Promise.race([running, expired]);
    } catch (err) {
      if (cancelled) throw timeoutError();
      throw err;
    }
    if (result.error) throw result.error;
    if (result.status === "aborted" || result.status === "failed") {
      throw new Error(`run ${result.status}`);
    }
    const pricing = await resolvePricing(settings.providerId, modelId);
    return {
      text: result.outputText ?? "",
      usage: computeCost(result.usage, pricing),
      status: result.status,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one agent turn. In mock mode this is a fixture lookup; otherwise it is the
 * AgentRuntime plus the retry, timeout and fallback rules.
 */
export async function runAgent(prompt: string, options: RunAgentOptions): Promise<AgentAnswer> {
  if (isMockMode()) return runMock(prompt, options);

  const delayFor = options.retryDelayMs !== undefined ? () => options.retryDelayMs! : (ms: number) => ms;
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const isLast = attempt === MAX_ATTEMPTS;
    const modelId = isLast ? (options.settings.fallbackModelId ?? options.settings.modelId) : options.settings.modelId;
    try {
      return await runOnce(prompt, options, modelId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = message;

      // Trap 16: account problems are checked before anything else.
      if (isAccountProblem(message)) {
        throw new Error(
          `${message}\nThis looks like an account problem, not a transient failure. ` +
            `Check the API key, quota and billing.`
        );
      }
      if (!isTransient(message)) throw err;

      options.onEvent?.({
        type: "status-notice",
        snapshot: noticeSnapshot(attempt, message),
        message:
          attempt < MAX_ATTEMPTS
            ? `transient provider error, retrying in ${Math.round(delayFor(RETRY_DELAYS_MS[attempt - 1] ?? 30_000) / 1000)}s (attempt ${attempt}/${MAX_ATTEMPTS})`
            : `transient provider error, switching to ${modelId} for the last attempt`,
      });

      if (!isLast) await sleep(delayFor(RETRY_DELAYS_MS[attempt - 1] ?? 30_000));
    }
  }

  throw new Error(`the model failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

function noticeSnapshot(attempt: number, message: string) {
  return {
    agentId: "patchpilot",
    status: "running" as const,
    iteration: attempt,
    messages: [],
    pendingToolCalls: [],
    usage: emptyMockUsage(),
    lastError: message,
  };
}

