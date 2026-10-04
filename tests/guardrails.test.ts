import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  globToRegExp,
  isProtectedPath,
  isTestPath,
  makeBeforeTool,
  matchesGlob,
  normaliseAgentPath,
  writeTargets,
  type GuardrailOptions,
} from "../src/pipeline/guardrails.ts";
import type { GuardrailBlock } from "../src/types.ts";

const CWD = path.resolve("/sandbox/app");
const REPO = {
  testPaths: ["tests"],
  protectedPaths: ["server.js", "package.json", "package-lock.json", ".env", ".env.*", "sdk/**"],
};

function hook(over: Partial<GuardrailOptions> = {}) {
  const blocks: GuardrailBlock[] = [];
  const beforeTool = makeBeforeTool({ stage: "fix", repo: REPO, cwd: CWD, onBlock: (b) => blocks.push(b), ...over });
  const call = (tool: string, input: unknown) => beforeTool({ tool: { name: tool }, toolCall: { toolName: tool, input }, input });
  return { call, blocks };
}

describe("path rules", () => {
  it("globs: * stays in a segment, ** crosses segments", () => {
    expect(globToRegExp("src/*.js").test("src/a.js")).toBe(true);
    expect(globToRegExp("src/*.js").test("src/lib/a.js")).toBe(false);
    expect(globToRegExp("src/**/*.js").test("src/lib/deep/a.js")).toBe(true);
    expect(globToRegExp("src/**/*.js").test("src/a.js")).toBe(true);
    expect(globToRegExp("sdk/**").test("sdk/x/y.js")).toBe(true);
  });

  it("a slash-free glob also matches the basename at any depth", () => {
    expect(matchesGlob("config/.env", ".env")).toBe(true);
    expect(matchesGlob(".env.local", ".env.*")).toBe(true);
    expect(matchesGlob("src/server.js.bak", "server.js")).toBe(false);
  });

  it("recognises test files by convention and by config", () => {
    for (const p of ["tests/a.test.js", "src/__tests__/x.js", "src/lib/a.spec.ts", "src/b.test.mjs", "test/x.js"]) {
      expect(isTestPath(p, REPO), p).toBe(true);
    }
    expect(isTestPath("src/lib/total.js", REPO)).toBe(false);
    expect(isTestPath("e2e/flow.js", { testPaths: ["e2e"] })).toBe(true);
  });

  it("normalises tricks back to the real path and detects escapes", () => {
    expect(normaliseAgentPath(CWD, "./tests/../server.js")).toBe("server.js");
    expect(normaliseAgentPath(CWD, "src\\..\\package.json")).toBe("package.json");
    expect(normaliseAgentPath(CWD, "../../etc/passwd")).toBeNull();
    expect(isProtectedPath(normaliseAgentPath(CWD, "./sdk/patchpilot-express.js")!, REPO)).toBe(true);
  });

  it("reads targets from apply_patch and write_files", () => {
    expect(writeTargets("apply_patch", { patch: "*** Update File: server.js\n@@\n-a\n+b" })).toEqual(["server.js"]);
    expect(writeTargets("write_files", { files: [{ path: "a.js" }, { path: "b.js" }] })).toEqual(["a.js", "b.js"]);
  });
});

describe("makeBeforeTool", () => {
  it("allows a legitimate source edit", () => {
    const { call, blocks } = hook();
    expect(call("editor", { path: "src/lib/total.js", old_text: "a", new_text: "b" })).toBeUndefined();
    expect(blocks).toHaveLength(0);
  });

  it("allows reads in every stage, including triage", () => {
    const { call } = hook({ stage: "triage" });
    expect(call("read_file", { path: "server.js" })).toBeUndefined();
    expect(call("search_codebase", { queries: ["x"] })).toBeUndefined();
  });

  it("blocks protected paths", () => {
    const { call, blocks } = hook();
    for (const p of ["server.js", "package.json", ".env", ".env.production", "sdk/patchpilot-express.js"]) {
      expect(call("editor", { path: p, new_text: "x" })?.skip, p).toBe(true);
    }
    expect(blocks[0].reason).toMatch(/protected/);
  });

  it("blocks a protected path reached through ../ tricks", () => {
    const { call } = hook();
    expect(call("editor", { path: "./tests/../server.js", new_text: "x" })?.reason).toMatch(/protected/);
  });

  it("blocks test files during the fix stage", () => {
    const { call } = hook({ stage: "fix" });
    for (const p of ["tests/checkout.test.js", "src/lib/total.spec.js", "src/__tests__/a.js"]) {
      expect(call("editor", { path: p, new_text: "x" })?.reason, p).toMatch(/test file/);
    }
  });

  it("blocks any write during triage", () => {
    const { call, blocks } = hook({ stage: "triage" });
    expect(call("editor", { path: "src/lib/total.js", new_text: "x" })?.skip).toBe(true);
    expect(call("write_file", { path: "notes.md", content: "x" })?.skip).toBe(true);
    expect(blocks.every((b) => b.stage === "triage")).toBe(true);
  });

  it("limits the Reproducer to allowWritePaths", () => {
    const { call } = hook({ stage: "reproduce", allowWritePaths: ["tests"] });
    expect(call("editor", { path: "tests/patchpilot-x.test.js", new_text: "x" })).toBeUndefined();
    expect(call("editor", { path: "src/lib/total.js", new_text: "x" })?.reason).toMatch(/outside the folders/);
  });

  it("blocks the locked reproduction test", () => {
    const { call } = hook({ stage: "reproduce", allowWritePaths: ["tests"], lockedFiles: ["tests/patchpilot-x.test.js"] });
    expect(call("editor", { path: "tests/patchpilot-x.test.js", new_text: "x" })?.reason).toMatch(/locked/);
  });

  it("blocks writes outside the working folder", () => {
    const { call } = hook();
    expect(call("editor", { path: "../../outside.js", new_text: "x" })?.reason).toMatch(/outside the working folder/);
  });

  it("blocks apply_patch and write_files that touch a forbidden file", () => {
    const { call } = hook();
    expect(call("apply_patch", { patch: "*** Update File: tests/a.test.js\n+x" })?.skip).toBe(true);
    expect(call("write_files", { files: [{ path: "src/ok.js" }, { path: "package.json" }] })?.skip).toBe(true);
  });

  it("blocks dangerous shell commands", () => {
    const { call } = hook();
    for (const c of ["rm -rf /", "git push origin main", "git reset --hard HEAD~1", "git checkout -- .", "curl http://x", "wget http://x", "npm publish"]) {
      expect(call("run_command", { command: c })?.skip, c).toBe(true);
    }
  });

  it("allows node --test", () => {
    const { call } = hook();
    expect(call("run_command", { command: "node --test" })).toBeUndefined();
    expect(call("run_command", { command: "node --test tests/foo.test.js" })).toBeUndefined();
  });

  it("reports every block with stage, tool, input and reason", () => {
    const { call, blocks } = hook();
    call("editor", { path: "server.js", new_text: "x" });
    expect(blocks[0]).toMatchObject({ stage: "fix", tool: "editor", input: { path: "server.js" } });
    expect(typeof blocks[0].ts).toBe("string");
    expect(blocks[0].reason.length).toBeGreaterThan(0);
  });
});
