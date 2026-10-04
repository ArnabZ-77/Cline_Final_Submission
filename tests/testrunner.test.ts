import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  formatCommand,
  parseCounts,
  runTests,
  stripAnsi,
  summarise,
} from "../src/pipeline/testrunner.ts";
import { PROJECT_ROOT } from "../src/config.ts";

const SPEC_PASS = `
✔ computeTotal adds price * quantity (1.3297ms)
✔ computeTotal of an empty list is 0 (0.1228ms)
ℹ tests 14
ℹ suites 0
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 291.5537
`;

const SPEC_FAIL = `
✖ computeTotal skips a missing item (1.9738ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
    at TestContext.<anonymous> (file:///D:/app/tests/x.test.js:7:10)
ℹ tests 15
ℹ pass 14
ℹ fail 1
ℹ duration_ms 300.5
`;

const TAP_PASS = `TAP version 13
# Subtest: computeTotal adds price * quantity
ok 1 - computeTotal adds price * quantity
  ---
  duration_ms: 1.2
  ---
1..14
# tests 14
# pass 14
# fail 0
# cancelled 0
# duration_ms 291.553
`;

const TAP_FAIL = `TAP version 13
not ok 15 - computeTotal skips a missing item
  ---
  error: 'Expected values to be strictly equal'
  expected: 25
  actual: NaN
  ---
1..15
# tests 15
# pass 14
# fail 1
# duration_ms 302.1
`;

describe("parseCounts", () => {
  it("reads the spec reporter", () => {
    expect(parseCounts(SPEC_PASS)).toMatchObject({ tests: 14, pass: 14, fail: 0 });
    expect(parseCounts(SPEC_FAIL)).toMatchObject({ tests: 15, pass: 14, fail: 1 });
  });

  it("reads the TAP reporter", () => {
    expect(parseCounts(TAP_PASS)).toMatchObject({ tests: 14, pass: 14, fail: 0 });
    expect(parseCounts(TAP_FAIL)).toMatchObject({ tests: 15, pass: 14, fail: 1 });
  });

  it("reports nothing for unstructured output", () => {
    expect(parseCounts("boom")).toEqual({
      tests: undefined,
      pass: undefined,
      fail: undefined,
      durationMs: undefined,
    });
  });
});

describe("summarise", () => {
  it("keeps only failure-related lines", () => {
    const text = summarise(SPEC_FAIL);
    expect(text).toContain("computeTotal skips a missing item");
    expect(text).toContain("AssertionError");
    expect(text).not.toContain("✔ computeTotal adds price");
  });

  it("finds failures in TAP output", () => {
    expect(summarise(TAP_FAIL)).toContain("computeTotal skips a missing item");
  });

  it("caps the text", () => {
    const long = Array.from({ length: 500 }, (_, i) => `AssertionError: case ${i}`).join("\n");
    expect(summarise(long).length).toBeLessThanOrEqual(3501);
  });
});

describe("stripAnsi / formatCommand", () => {
  it("removes colour codes", () => {
    expect(stripAnsi("\u001b[32m✖ nope\u001b[39m")).toBe("✖ nope");
  });

  it("quotes arguments containing spaces", () => {
    expect(formatCommand(["node", "--test", "my tests/x.js"])).toBe('node --test "my tests/x.js"');
  });
});

describe("runTests", () => {
  const repo = { testCommand: ["node", "--test"] };
  const demoApp = path.join(PROJECT_ROOT, "demo-app");

  it("runs the demo app suite and reports 14 passing tests", async () => {
    const result = await runTests(repo, demoApp);
    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.passed).toBe(14);
    expect(result.failed).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.command).toBe("node --test");
  });

  it("runs a single test file when given extra args", async () => {
    const result = await runTests(repo, demoApp, ["tests/checkout.test.js"]);
    expect(result.ok).toBe(true);
    expect(result.passed).toBe(2);
  });

  it("fails cleanly when the command does not exist", async () => {
    const result = await runTests({ testCommand: ["definitely-not-a-real-binary"] }, demoApp);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.summary).toContain("could not run");
  });

  it("kills a hanging suite on timeout without blocking the event loop", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    const result = await runTests({ testCommand: ["node", "-e", "for(;;){}"] }, demoApp, [], 1000);
    clearInterval(timer);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.summary).toContain("timed out");
    expect(ticks).toBeGreaterThan(5);
  });
});
