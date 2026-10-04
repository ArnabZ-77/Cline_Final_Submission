import { afterEach, describe, expect, it, vi } from "vitest";

// A fake Agent whose run() never settles and whose abort() does nothing: exactly how a
// hung provider request behaved in a real Gemini run (it outlived the 240 s timeout by
// ~11 minutes). Each instance records its hooks so the test can call them late.
const instances: Array<{ modelId: string; hooks: any; aborted: boolean }> = [];
vi.mock("@cline/agents", () => ({
  Agent: class {
    record: { modelId: string; hooks: any; aborted: boolean };
    constructor(cfg: any) {
      this.record = { modelId: cfg.modelId, hooks: cfg.hooks, aborted: false };
      instances.push(this.record);
    }
    run() {
      return new Promise(() => {});
    }
    abort() {
      this.record.aborted = true;
    }
  },
}));

const { runAgent, MAX_ATTEMPTS } = await import("../src/pipeline/model.ts");

const settings = { providerId: "gemini", modelId: "main-model", fallbackModelId: "fallback-model", apiKey: "k" };

describe("runAgent stage timeout (trap 15)", () => {
  const previousMock = process.env.PATCHPILOT_MOCK;
  afterEach(() => {
    instances.length = 0;
    process.env.PATCHPILOT_MOCK = previousMock;
  });

  it("ends a hung run on time, retries with a fresh Agent, and uses the fallback last", async () => {
    process.env.PATCHPILOT_MOCK = "0";
    const notices: string[] = [];
    const started = Date.now();
    await expect(
      runAgent("hello", {
        settings,
        systemPrompt: "",
        tools: [],
        timeoutMs: 100,
        retryDelayMs: 0,
        onEvent: (e: any) => notices.push(e.message),
      })
    ).rejects.toThrow(/failed after 4 attempts: stage timeout after 100 ms/);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3000); // 4 × 100 ms, not "whenever the request gives up"
    expect(instances).toHaveLength(MAX_ATTEMPTS);
    expect(instances.every((i) => i.aborted)).toBe(true);
    expect(instances.map((i) => i.modelId)).toEqual(["main-model", "main-model", "main-model", "fallback-model"]);
    expect(notices.filter((n) => /transient provider error/.test(n))).toHaveLength(MAX_ATTEMPTS);
  });

  it("refuses tool calls from a run that was abandoned after its timeout", async () => {
    process.env.PATCHPILOT_MOCK = "0";
    const allowed: string[] = [];
    await runAgent("hello", {
      settings,
      systemPrompt: "",
      tools: [],
      timeoutMs: 50,
      retryDelayMs: 0,
      beforeTool: ({ tool }: any) => {
        allowed.push(tool.name);
        return undefined;
      },
    }).catch(() => undefined);

    const late = await instances[0].hooks.beforeTool({ tool: { name: "editor" }, toolCall: {}, input: { path: "src/a.js" } });
    expect(late).toMatchObject({ skip: true });
    expect(late.reason).toMatch(/cancelled/);
    expect(allowed).toEqual([]); // the real guardrail never even saw it
  });
});
