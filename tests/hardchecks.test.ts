import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { braceBalanceOk, braceImbalance, changedLineCount, runHardChecks } from "../src/pipeline/hardchecks.ts";
import { MOCK_FIXTURES } from "../src/pipeline/mockFixtures.ts";
import { PROJECT_ROOT } from "../src/config.ts";

const REPO = {
  testPaths: ["tests"],
  protectedPaths: ["server.js", "package.json", ".env", ".env.*"],
  maxDiffLines: 150,
  maxDiffFiles: 3,
};

function diffFor(file: string, removed: string[], added: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");
}

const byName = (results: ReturnType<typeof runHardChecks>) => Object.fromEntries(results.map((r) => [r.name, r]));

describe("runHardChecks", () => {
  const good = diffFor("src/lib/total.js", ["    total += x;"], ["    if (!item) continue;", "    total += x;"]);

  it("passes a legitimate source edit", () => {
    const results = runHardChecks(good, ["src/lib/total.js"], REPO);
    expect(results.every((r) => r.ok), JSON.stringify(results)).toBe(true);
    expect(results.map((r) => r.name)).toEqual([
      "no-test-file-edits",
      "no-protected-path-edits",
      "diff-size-within-cap",
      "diff-lines-within-cap",
      "no-skip-or-only-markers",
      "no-new-module-mocks",
      "no-equality-overrides",
      "diff-not-empty",
    ]);
  });

  it("no-test-file-edits", () => {
    const r = byName(runHardChecks(diffFor("tests/a.test.js", ["a"], ["b"]), ["tests/a.test.js"], REPO));
    expect(r["no-test-file-edits"].ok).toBe(false);
  });

  it("no-protected-path-edits", () => {
    const r = byName(runHardChecks(diffFor("server.js", ["a"], ["b"]), ["server.js"], REPO));
    expect(r["no-protected-path-edits"].ok).toBe(false);
  });

  it("diff-size-within-cap", () => {
    const files = ["a.js", "b.js", "c.js", "d.js"];
    const r = byName(runHardChecks(files.map((f) => diffFor(f, ["a"], ["b"])).join("\n"), files, REPO));
    expect(r["diff-size-within-cap"].ok).toBe(false);
  });

  it("diff-lines-within-cap counts added and removed lines, not headers", () => {
    const big = diffFor("src/a.js", [], Array.from({ length: 151 }, (_, i) => `x${i}`));
    expect(changedLineCount(big)).toBe(151);
    expect(byName(runHardChecks(big, ["src/a.js"], REPO))["diff-lines-within-cap"].ok).toBe(false);
  });

  it("no-skip-or-only-markers flags every marker on added lines", () => {
    for (const line of ["test.skip('a', () => {})", "it.only('a')", "xit('a')", "xdescribe('a')", "test.todo('a')"]) {
      const r = byName(runHardChecks(diffFor("src/a.js", [], [line]), ["src/a.js"], REPO));
      expect(r["no-skip-or-only-markers"].ok, line).toBe(false);
    }
  });

  it("only added lines are scanned: removing a .skip( is fine", () => {
    const r = byName(runHardChecks(diffFor("src/a.js", ["test.skip('a')"], ["ok()"]), ["src/a.js"], REPO));
    expect(r["no-skip-or-only-markers"].ok).toBe(true);
  });

  it("no-new-module-mocks", () => {
    for (const line of ["jest.mock('./db')", "vi.mock('./db')"]) {
      expect(byName(runHardChecks(diffFor("src/a.js", [], [line]), ["src/a.js"], REPO))["no-new-module-mocks"].ok).toBe(false);
    }
  });

  it("no-equality-overrides", () => {
    for (const line of ["  valueOf() { return 25; }", "  toJSON() { return {}; }", "  [Symbol.toPrimitive]() {}"]) {
      expect(byName(runHardChecks(diffFor("src/a.js", [], [line]), ["src/a.js"], REPO))["no-equality-overrides"].ok, line).toBe(false);
    }
  });

  it("diff-not-empty", () => {
    expect(byName(runHardChecks("", [], REPO))["diff-not-empty"].ok).toBe(false);
  });
});

describe("brace balance", () => {
  it("accepts balanced code with braces in strings, comments, templates and regexes", () => {
    const src = [
      'const a = "}"; const b = \'{\'; // }',
      "/* { [ ( */",
      "const t = `a ${b} }`;",
      "const re = /[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;",
      "function f(x) { if (!x || !/^[{]$/.test(x)) { return /}/; } return [x]; }",
      "const half = a / 2 / (b || 1);",
    ].join("\n");
    expect(braceImbalance(src)).toBeUndefined();
  });

  it("rejects a missing or crossed brace", () => {
    expect(braceImbalance("function f() { if (x) { return 1; }")).toMatch(/never closed/);
    expect(braceImbalance("function f() { return (1 }")).toMatch(/closed by/);
    expect(braceImbalance("}")).toMatch(/unexpected/);
  });

  it("finds no false positives in the demo app or in any fixture patch", () => {
    const lib = path.join(PROJECT_ROOT, "demo-app", "src", "lib");
    for (const f of fs.readdirSync(lib)) expect(braceImbalance(fs.readFileSync(path.join(lib, f), "utf8")), f).toBeUndefined();
    for (const fx of MOCK_FIXTURES) {
      const src = fs.readFileSync(path.join(PROJECT_ROOT, "demo-app", fx.file), "utf8");
      const patched = fx.patch ? src.replace(fx.patch.old_text, () => fx.patch!.new_text) : src;
      expect(braceImbalance(patched), `patched ${fx.id}`).toBeUndefined();
      expect(braceImbalance(fx.testSource), `test ${fx.id}`).toBeUndefined();
    }
  });

  it("braceBalanceOk checks changed code files on disk and skips deleted ones", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-brace-"));
    try {
      fs.writeFileSync(path.join(dir, "ok.js"), "export function a() { return 1; }\n");
      fs.writeFileSync(path.join(dir, "bad.js"), "export function a() { return 1;\n");
      fs.writeFileSync(path.join(dir, "notes.md"), "{ not code\n");
      expect(braceBalanceOk(dir, ["ok.js", "notes.md", "gone.js"]).ok).toBe(true);
      const bad = braceBalanceOk(dir, ["ok.js", "bad.js"]);
      expect(bad.ok).toBe(false);
      expect(bad.detail).toMatch(/bad\.js/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
