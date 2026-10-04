import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_ROOT } from "../src/config.ts";
import {
  MOCK_FIXTURES,
  findMockFixture,
  fixtureById,
  mockHandlers,
} from "../src/pipeline/mockFixtures.ts";
import { extractJson } from "../src/agents/util.ts";
import { editFile, makeTools, readFile, searchCodebase, ToolError } from "../src/pipeline/tools.ts";
import { runTests } from "../src/pipeline/testrunner.ts";

const DEMO_APP = path.join(PROJECT_ROOT, "demo-app");
const GOLDEN = path.join(PROJECT_ROOT, "benchmark", "golden");

/**
 * A throwaway copy of the demo app. Golden tests are NOT pre-copied: `node --test` would
 * discover them and the happy-path count would no longer be 14. Each golden check copies
 * its own file into tests/__golden__/.
 */
function makeScratchApp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patchpilot-fixtures-"));
  const app = path.join(dir, "demo-app");
  fs.cpSync(DEMO_APP, app, { recursive: true, filter: (src) => !src.includes("node_modules") });
  fs.mkdirSync(path.join(app, "tests", "__golden__"), { recursive: true });
  return app;
}

const goldenNameFor = (id: string): string | undefined =>
  fs.readdirSync(GOLDEN).find((f) => f.startsWith(`${id}-`) && f.endsWith(".test.js"));

// Bug #11's patch deliberately regresses the suite (that is how the conflict surfaces), so
// it is checked on its own below rather than applied with the real fixes.
const patched = MOCK_FIXTURES.filter((f) => f.patch !== null && !f.conflict);

describe("mock fixtures", () => {
  let app = "";

  beforeAll(() => {
    app = makeScratchApp();
  });

  afterAll(() => {
    if (app) fs.rmSync(path.dirname(app), { recursive: true, force: true });
  });

  it("covers all 11 planted bugs", () => {
    expect(MOCK_FIXTURES).toHaveLength(11);
    expect(MOCK_FIXTURES.map((f) => f.id)).toEqual([
      "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11",
    ]);
  });

  it.each(patched)("bug $id: old_text matches exactly once", (fixture) => {
    const text = fs.readFileSync(path.join(app, fixture.file), "utf8");
    const occurrences = text.split(fixture.patch!.old_text).length - 1;
    expect(occurrences, `${fixture.id} old_text in ${fixture.file}`).toBe(1);
  });

  it.each(patched)("bug $id: the editor applies the patch", (fixture) => {
    const result = editFile(app, {
      path: fixture.file,
      old_text: fixture.patch!.old_text,
      new_text: fixture.patch!.new_text,
    });
    expect(result.action).toBe("replaced");
    expect(fs.readFileSync(path.join(app, fixture.file), "utf8")).toContain(fixture.patch!.new_text);
  });

  it("happy-path tests still pass 14/14 after every patch", async () => {
    const result = await runTests({ testCommand: ["node", "--test"] }, app);
    expect(result.passed).toBe(14);
    expect(result.failed).toBe(0);
    expect(result.ok).toBe(true);
  });

  it.each(patched)("golden test for bug $id passes against the patched app", async (fixture) => {
    const name = goldenNameFor(fixture.id);
    expect(name, `golden test for bug ${fixture.id}`).toBeTruthy();
    const dest = path.join(app, "tests", "__golden__", name!);
    fs.copyFileSync(path.join(GOLDEN, name!), dest);
    try {
      const result = await runTests({ testCommand: ["node", "--test"] }, app, [dest]);
      expect(result.ok, `${name}: ${result.summary}`).toBe(true);
      expect(result.passed).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dest, { force: true });
    }
  });

  it("bug 11's patch passes its reproduction test but regresses the full suite", async () => {
    const fixture = fixtureById("11")!;
    expect(fixture.conflict?.testPath).toBe("tests/checkout.test.js");
    const scratch = makeScratchApp();
    try {
      fs.rmSync(path.join(scratch, "tests", "__golden__"), { recursive: true, force: true });
      fs.writeFileSync(path.join(scratch, fixture.testFile), fixture.testSource);
      editFile(scratch, { path: fixture.file, old_text: fixture.patch!.old_text, new_text: fixture.patch!.new_text });
      const repro = await runTests({ testCommand: ["node", "--test"] }, scratch, [fixture.testFile]);
      expect(repro.ok, repro.summary).toBe(true);
      const full = await runTests({ testCommand: ["node", "--test"] }, scratch);
      expect(full.ok).toBe(false);
      expect(full.failed).toBe(1);
    } finally {
      fs.rmSync(path.dirname(scratch), { recursive: true, force: true });
    }
  });

  it.each(MOCK_FIXTURES)("bug $id: the reproduction test fails on the buggy code with an assertion", async (fixture) => {
    const scratch = makeScratchApp();
    try {
      fs.writeFileSync(path.join(scratch, fixture.testFile), fixture.testSource);
      const result = await runTests({ testCommand: ["node", "--test"] }, scratch, [fixture.testFile]);
      expect(result.ok).toBe(false);
      expect(result.failed).toBeGreaterThanOrEqual(1);
      // It must fail because of the bug (an assertion, or the crash itself for crash bugs),
      // not because the file cannot load.
      expect(result.summary, fixture.id).not.toMatch(
        /SyntaxError|ERR_MODULE_NOT_FOUND|does not provide an export|Cannot find module/
      );
    } finally {
      fs.rmSync(path.dirname(scratch), { recursive: true, force: true });
    }
  });

  it.each(MOCK_FIXTURES.filter((f) => !f.conflict))(
    "bug $id: the reproduction test passes once the patch is applied",
    async (fixture) => {
      const scratch = makeScratchApp();
      try {
        fs.writeFileSync(path.join(scratch, fixture.testFile), fixture.testSource);
        editFile(scratch, { path: fixture.file, old_text: fixture.patch!.old_text, new_text: fixture.patch!.new_text });
        const result = await runTests({ testCommand: ["node", "--test"] }, scratch, [fixture.testFile]);
        expect(result.ok, `${fixture.id}: ${result.summary}`).toBe(true);
      } finally {
        fs.rmSync(path.dirname(scratch), { recursive: true, force: true });
      }
    }
  );

  it("findMockFixture prefers the placeholder-order phrase over the file", () => {
    const found = findMockFixture(
      "src/lib/checkout.js is wrong. Product wants a placeholder order: an empty cart must be allowed."
    );
    expect(found?.id).toBe("11");
  });

  it("findMockFixture picks the fixture from the first src/lib mention", () => {
    expect(findMockFixture("look at src/lib/pagination.js please")?.id).toBe("05");
    expect(findMockFixture("look at src\\lib\\total.js please")?.id).toBe("01");
    expect(findMockFixture("nothing relevant here")).toBeUndefined();
  });

  it("registers one mock handler per stage", () => {
    expect(mockHandlers.map((h) => h.tag).sort()).toEqual(["fix", "reproduce", "review", "triage"]);
    for (const handler of mockHandlers) {
      expect(handler.match.test(`MOCK_TAG:${handler.tag} do the thing`)).toBe(true);
    }
  });
});

describe("tools", () => {
  let app = "";

  beforeAll(() => {
    app = makeScratchApp();
  });

  afterAll(() => {
    if (app) fs.rmSync(path.dirname(app), { recursive: true, force: true });
  });

  it("refuses to read outside the app folder", () => {
    expect(() => readFile(app, { path: "../package.json" })).toThrow(ToolError);
    expect(() => readFile(app, { path: "../../etc/passwd" })).toThrow(ToolError);
  });

  it("refuses to write outside the app folder", () => {
    expect(() => editFile(app, { path: "../evil.js", new_text: "boom" })).toThrow(ToolError);
    expect(fs.existsSync(path.join(path.dirname(app), "evil.js"))).toBe(false);
  });

  it("numbers lines", () => {
    const text = readFile(app, { path: "src/lib/total.js" });
    expect(text).toContain("1: // total.js");
    expect(text).toContain("computeTotal");
  });

  it("caps the read at 400 lines and says how many were left out", () => {
    fs.writeFileSync(
      path.join(app, "big.txt"),
      Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n"),
      "utf8"
    );
    const text = readFile(app, { path: "big.txt" });
    expect(text).toContain("(100 more lines below)");
    // 400 numbered lines plus the note line.
    expect(text.split("\n").filter((l) => /^\d+: /.test(l))).toHaveLength(400);
  });

  it("requires old_text to match exactly once", () => {
    const target = "src/lib/eligibility.js";
    const before = fs.readFileSync(path.join(app, target), "utf8");
    expect(() => editFile(app, { path: target, old_text: "nowhere", new_text: "x" })).toThrow(/not found/);
    // `isLoyaltyMember` appears twice (parameter and body); `return` appears only once.
    expect(() => editFile(app, { path: target, old_text: "isLoyaltyMember", new_text: "x" })).toThrow(
      /exactly once/
    );
    expect(fs.readFileSync(path.join(app, target), "utf8")).toBe(before);
  });

  it("creates a file when old_text is absent", () => {
    const result = editFile(app, { path: "src/lib/new-thing.js", new_text: "export const x = 1;\n" });
    expect(result.action).toBe("created");
    expect(fs.existsSync(path.join(app, "src/lib/new-thing.js"))).toBe(true);
  });

  it("searches and skips node_modules", () => {
    const text = searchCodebase(app, { queries: ["canCheckout"] });
    expect(text).toContain("src/lib/checkout.js");
    expect(text).not.toContain("node_modules");
  });

  it("hands out tools that resolve against the app folder", () => {
    expect(makeTools(app).map((t) => t.name)).toEqual([
      "read_file",
      "search_codebase",
      "editor",
      "write_file",
    ]);
  });
});

describe("extractJson", () => {
  it("reads the last fenced json block", () => {
    const text = 'here you go\n```json\n{"a":1}\n```\nactually\n```json\n{"a":2}\n```';
    expect(extractJson<{ a: number }>(text)).toEqual({ a: 2 });
  });

  it("falls back to the first object span", () => {
    expect(extractJson<{ ok: boolean }>('sure: {"ok": true} thanks')).toEqual({ ok: true });
  });

  it("throws when there is no json", () => {
    expect(() => extractJson("no json here")).toThrow(/no JSON found/);
  });
});
