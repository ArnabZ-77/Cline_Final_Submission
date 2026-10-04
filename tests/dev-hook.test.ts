import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PROJECT_ROOT } from "../src/config.ts";
import { decide } from "../.clinerules/hooks/PreToolUse.js";

const HOOK = path.join(PROJECT_ROOT, ".clinerules", "hooks", "PreToolUse.js");
const call = (toolName: string, parameters: Record<string, unknown>) => decide({ preToolUse: { toolName, parameters } });
const blocked = (toolName: string, parameters: Record<string, unknown>) => call(toolName, parameters).cancel === true;

describe("dev-Cline PreToolUse hook", () => {
  it("blocks writes to .env and .env.*", () => {
    expect(blocked("write_to_file", { path: ".env", content: "KEY=1" })).toBe(true);
    expect(blocked("replace_in_file", { path: "config\\.env.production", diff: "x" })).toBe(true);
  });

  it("allows reading .env", () => {
    expect(blocked("read_file", { path: ".env" })).toBe(false);
  });

  it("blocks any write under benchmark/golden/", () => {
    expect(blocked("replace_in_file", { path: "benchmark/golden/01-total.test.js", diff: "x" })).toBe(true);
    expect(blocked("write_to_file", { path: "benchmark/golden/bugs.js", content: "x" })).toBe(true);
    expect(blocked("execute_command", { command: "Remove-Item benchmark\\golden\\01-total.test.js" })).toBe(true);
  });

  it("blocks deleting or emptying test files", () => {
    expect(blocked("write_to_file", { path: "tests/total.test.js", content: "   \n" })).toBe(true);
    expect(blocked("apply_patch", { input: "*** Delete File: demo-app/tests/total.test.js" })).toBe(true);
    expect(blocked("execute_command", { command: "rm demo-app/tests/total.test.js" })).toBe(true);
    expect(blocked("execute_command", { command: "del demo-app\\tests\\total.test.js" })).toBe(true);
    expect(blocked("execute_command", { command: "git rm tests/guardrails.test.ts" })).toBe(true);
  });

  it("allows writing and editing tests", () => {
    expect(blocked("write_to_file", { path: "tests/new.test.ts", content: "import { it } from 'vitest';" })).toBe(false);
    expect(blocked("replace_in_file", { path: "tests/guardrails.test.ts", diff: "x" })).toBe(false);
  });

  it("blocks force pushes, hard resets, rm -rf and Remove-Item -Recurse", () => {
    for (const command of [
      "git push --force origin main",
      "git push -f",
      "git push origin main --force-with-lease",
      "git reset --hard HEAD~3",
      "rm -rf node_modules",
      "Remove-Item -Recurse -Force .patchpilot",
      "rmdir /s /q src",
    ]) {
      expect(blocked("execute_command", { command }), command).toBe(true);
    }
  });

  it("allows ordinary commands", () => {
    for (const command of ["npm run ci", "git push -u origin feature", "git status", "node --test", "npx vitest run"]) {
      expect(blocked("execute_command", { command }), command).toBe(false);
    }
  });

  it("allows unknown tools and malformed payloads", () => {
    expect(decide({}).cancel).toBe(false);
    expect(decide(null).cancel).toBe(false);
    expect(call("browser_action", { url: "x" }).cancel).toBe(false);
  });

  it("works as a real hook: JSON on stdin, decision on stdout", () => {
    const run = (input: string) => {
      const r = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8" });
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout);
    };
    const no = run(JSON.stringify({ preToolUse: { toolName: "write_to_file", parameters: { path: ".env", content: "x" } } }));
    expect(no.cancel).toBe(true);
    expect(no.errorMessage).toMatch(/\.env/);
    expect(run(JSON.stringify({ preToolUse: { toolName: "read_file", parameters: { path: ".env" } } }))).toEqual({ cancel: false });
    expect(run("this is not json")).toEqual({ cancel: false });
  });
});
