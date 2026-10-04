/**
 * Mock answers for every planted bug.
 *
 * Mock mode must behave like the real thing wherever the demo depends on it:
 * - the Reproducer and Fixer reach for tools, so their writes pass through the same
 *   `beforeTool` guardrails (trap 19) and a blocked write is visible on the incident;
 * - every patch is the exact `old_text` -> `new_text` from Appendix A, so the benchmark
 *   exercises the real code path, not a shortcut.
 */

export interface MockPatch {
  old_text: string;
  new_text: string;
}

export interface MockFixture {
  id: string;
  file: string;
  symbol: string;
  rootCause: string;
  intendedBehavior: string;
  /** Name of the single regression test the Reproducer writes. */
  testName: string;
  /** Unique per bug (trap 21). */
  testFile: string;
  /** Full contents of the regression test. */
  testSource: string;
  patch: MockPatch | null;
  /**
   * Bug #11: the request contradicts an existing test. The first patch makes the
   * reproduction test pass but regresses the full suite; on the retry the Fixer tries to
   * edit the conflicting test (blocked) and then escalates.
   */
  conflict?: { testPath: string; old_text: string; new_text: string };
  confidence: number;
}

const EMAIL_CHECK = [
  "if (!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {",
  "  throw new RangeError(`invalid email: ${email}`);",
  "}",
].join("\n");

const NEW_EMAIL_CHECK = [
  "if (!newEmail || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(newEmail)) {",
  "  throw new RangeError(`invalid email: ${newEmail}`);",
  "}",
].join("\n");

/** Wraps a body in the `node:test` preamble the regression tests need. */
function nodeTest(body: string): string {
  return ['import { test } from "node:test";', 'import assert from "node:assert/strict";', body.trim(), ""].join(
    "\n"
  );
}

export const MOCK_FIXTURES: MockFixture[] = [
  {
    id: "01",
    file: "src/lib/total.js",
    symbol: "computeTotal",
    rootCause:
      "computeTotal dereferences every item without a guard, so a missing entry in the request body (a null from the JSON payload) throws a TypeError while reading item.price.",
    intendedBehavior:
      "A missing or null item is skipped and the remaining items are totalled, so a partially filled cart still returns a price.",
    testName: "computeTotal skips a missing item",
    testFile: "tests/patchpilot-compute-total-skips-a-missing-item.test.js",
    testSource: nodeTest(`
import { computeTotal } from "../src/lib/total.js";

test("computeTotal skips a missing item", () => {
  assert.equal(
    computeTotal([{ price: 10, quantity: 2 }, undefined, { price: 5, quantity: 1 }]),
    25
  );
});`),
    patch: {
      old_text: "  for (const item of items) {\n    total += item.price * item.quantity;\n  }",
      new_text:
        "  for (const item of items) {\n    if (!item) continue;\n    total += item.price * item.quantity;\n  }",
    },
    confidence: 0.92,
  },
  {
    id: "02",
    file: "src/lib/profile.js",
    symbol: "getUserCity",
    rootCause:
      "getUserCity reads user.address.city without checking that the user has an address, so a profile without an address throws a TypeError.",
    intendedBehavior:
      "A user without an address has no known city, so the function returns undefined instead of throwing.",
    testName: "getUserCity returns undefined when the user has no address",
    testFile: "tests/patchpilot-get-user-city-without-address.test.js",
    testSource: nodeTest(`
import { getUserCity } from "../src/lib/profile.js";

test("getUserCity returns undefined when the user has no address", () => {
  assert.equal(getUserCity({ name: "Rahul" }), undefined);
});`),
    patch: {
      old_text: "  return user.address.city;",
      new_text: "  return user.address ? user.address.city : undefined;",
    },
    confidence: 0.9,
  },
  {
    id: "03",
    file: "src/lib/discount.js",
    symbol: "parseDiscountPercent",
    rootCause:
      'parseDiscountPercent uses parseInt, which truncates a fractional percentage such as "12.5" to 12, so the customer is charged a smaller discount than quoted.',
    intendedBehavior: "The percentage keeps its decimals, so 12.5% of 100 is 12.5 and the price is 87.5.",
    testName: "applyDiscount honours a fractional percentage",
    testFile: "tests/patchpilot-apply-discount-fractional-percent.test.js",
    testSource: nodeTest(`
import { applyDiscount } from "../src/lib/discount.js";

test("applyDiscount honours a fractional percentage", () => {
  assert.equal(applyDiscount(100, "12.5"), 87.5);
});`),
    patch: {
      old_text: "  const pct = parseInt(raw, 10);",
      new_text: "  const pct = parseFloat(raw);",
    },
    confidence: 0.88,
  },
  {
    id: "04",
    file: "src/lib/refund.js",
    symbol: "calculateRefund",
    rootCause:
      'calculateRefund calls Number() on raw query strings, so a currency-formatted amount such as "$19.99" becomes NaN and the function throws a RangeError.',
    intendedBehavior:
      'Money arriving as a formatted string is parsed to its numeric value, so "$19.99" refunds 19.99.',
    testName: "calculateRefund parses a currency-formatted amount",
    testFile: "tests/patchpilot-calculate-refund-currency-amount.test.js",
    testSource: nodeTest(`
import { calculateRefund } from "../src/lib/refund.js";

test("calculateRefund parses a currency-formatted amount", () => {
  assert.equal(calculateRefund("$19.99", "0"), 19.99);
});`),
    patch: {
      old_text: "  const amount = Number(amountStr);\n  const fee = Number(feeStr);",
      new_text:
        '  const amount = Number(String(amountStr).replace(/[^0-9.-]/g, ""));\n  const fee = Number(String(feeStr).replace(/[^0-9.-]/g, ""));',
    },
    confidence: 0.9,
  },
  {
    id: "05",
    file: "src/lib/pagination.js",
    symbol: "paginate",
    rootCause:
      "paginate computes the slice end as start + pageSize - 1, which is an off-by-one: the last item of every page is dropped.",
    intendedBehavior:
      "A full page holds exactly pageSize items, so page 0 of [1..6] with size 3 is [1,2,3].",
    testName: "paginate returns a full first page",
    testFile: "tests/patchpilot-paginate-full-first-page.test.js",
    testSource: nodeTest(`
import { paginate } from "../src/lib/pagination.js";

test("paginate returns a full first page", () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5, 6], 0, 3), [1, 2, 3]);
});`),
    patch: {
      old_text: "  const end = start + pageSize - 1; // BUG: should be start + pageSize",
      new_text: "  const end = start + pageSize;",
    },
    confidence: 0.87,
  },
  {
    id: "06",
    file: "src/lib/chunk.js",
    symbol: "chunk",
    rootCause:
      "chunk advances the loop by size + 1 instead of size, so every chunk after the first skips one item and the tail of the list is lost.",
    intendedBehavior:
      "Consecutive chunks of exactly size items cover the whole list, so [1,2,3,4] becomes [[1,2],[3,4]].",
    testName: "chunk splits a list into consecutive chunks",
    testFile: "tests/patchpilot-chunk-consecutive-chunks.test.js",
    testSource: nodeTest(`
import { chunk } from "../src/lib/chunk.js";

test("chunk splits a list into consecutive chunks", () => {
  assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});`),
    patch: { old_text: "i += size + 1", new_text: "i += size" },
    confidence: 0.87,
  },
  {
    id: "07",
    file: "src/lib/signup.js",
    symbol: "createUser",
    rootCause:
      "createUser stores whatever it is given, so signup accepts an empty or malformed email address and creates an unusable account.",
    intendedBehavior:
      "Signup rejects an empty or malformed email address with a RangeError and creates no user.",
    testName: "createUser rejects an invalid email",
    testFile: "tests/patchpilot-create-user-invalid-email.test.js",
    testSource: nodeTest(`
import { createUser, _resetUsersForTests } from "../src/lib/signup.js";

test("createUser rejects an empty email", () => {
  _resetUsersForTests();
  assert.throws(() => createUser({ name: "Bad", email: "" }), RangeError);
});

test("createUser rejects a malformed email", () => {
  _resetUsersForTests();
  assert.throws(() => createUser({ name: "Bad", email: "not-an-email" }), RangeError);
});`),
    patch: {
      old_text: "export function createUser({ name, email }) {\n  const id = nextId++;",
      new_text: `export function createUser({ name, email }) {\n  ${EMAIL_CHECK}\n  const id = nextId++;`,
    },
    confidence: 0.86,
  },
  {
    id: "08",
    file: "src/lib/update.js",
    symbol: "updateEmail",
    rootCause:
      'updateEmail stringifies whatever it receives, so an empty request body stores the literal text "undefined" as the user\'s email address.',
    intendedBehavior:
      "updateEmail validates the new address and rejects a missing or malformed one instead of storing it.",
    testName: "updateEmail rejects an undefined email",
    testFile: "tests/patchpilot-update-email-undefined.test.js",
    // nodeTest() already imports `test` and `assert`; importing them again is a SyntaxError,
    // and a test that cannot load "fails" for the wrong reason and never passes after the fix.
    testSource: nodeTest(`
import { beforeEach } from "node:test";
import { createUser, _resetUsersForTests } from "../src/lib/signup.js";
import { updateEmail } from "../src/lib/update.js";

beforeEach(_resetUsersForTests);

test("updateEmail rejects an undefined email", () => {
  const created = createUser({ name: "Asha", email: "asha@example.com" });
  assert.throws(() => updateEmail(created.id, undefined), RangeError);
});`),
    patch: {
      old_text:
        "export function updateEmail(id, newEmail) {\n  const user = getUser(id);\n  user.email = String(newEmail);\n  return user;\n}",
      new_text: `export function updateEmail(id, newEmail) {\n  ${NEW_EMAIL_CHECK}\n  const user = getUser(id);\n  user.email = newEmail;\n  return user;\n}`,
    },
    confidence: 0.85,
  },
  {
    id: "09",
    file: "src/lib/eligibility.js",
    symbol: "isEligibleForFreeShipping",
    rootCause:
      "The eligibility rule is written as orderTotal >= 50 || isLoyaltyMember, so either condition alone grants free shipping.",
    intendedBehavior:
      "The policy is orderTotal >= $50 AND a loyalty membership, so a large order from a non-member is not eligible.",
    testName: "isEligibleForFreeShipping requires both conditions",
    testFile: "tests/patchpilot-free-shipping-requires-both.test.js",
    testSource: nodeTest(`
import { isEligibleForFreeShipping } from "../src/lib/eligibility.js";

test("isEligibleForFreeShipping requires both a large order and loyalty", () => {
  assert.equal(isEligibleForFreeShipping(500, false), false);
});`),
    patch: { old_text: "|| isLoyaltyMember", new_text: "&& isLoyaltyMember" },
    confidence: 0.84,
  },
  {
    id: "10",
    file: "src/lib/checkout.js",
    symbol: "canCheckout",
    rootCause:
      "canCheckout uses cart.some, so a cart passes as soon as one item is in stock and an out-of-stock item slips through.",
    intendedBehavior:
      "Every item must be in stock, so a cart containing an out-of-stock item cannot check out.",
    testName: "canCheckout blocks a cart with an out-of-stock item",
    testFile: "tests/patchpilot-can-checkout-out-of-stock.test.js",
    testSource: nodeTest(`
import { canCheckout } from "../src/lib/checkout.js";

test("canCheckout blocks a cart with an out-of-stock item", () => {
  assert.equal(canCheckout([{ inStock: true }, { inStock: false }]), false);
});`),
    patch: { old_text: "cart.some(", new_text: "cart.every(" },
    confidence: 0.85,
  },
  {
    id: "11",
    file: "src/lib/checkout.js",
    symbol: "canCheckout",
    rootCause:
      "canCheckout returns false for an empty cart, and product now wants an empty placeholder order to be allowed.",
    intendedBehavior: "Per the report: canCheckout([]) returns true so a placeholder order can be placed.",
    testName: "canCheckout allows an empty placeholder order",
    testFile: "tests/patchpilot-can-checkout-empty-placeholder.test.js",
    testSource: nodeTest(`
import { canCheckout } from "../src/lib/checkout.js";

test("canCheckout allows an empty placeholder order", () => {
  assert.equal(canCheckout([]), true);
});`),
    // Makes the reproduction test pass but breaks the happy-path test "an empty cart cannot
    // check out", so PatchPilot rejects it with "Full suite regressed".
    patch: {
      old_text: "  if (cart.length === 0) return false;",
      new_text: "  if (cart.length === 0) return true;",
    },
    conflict: {
      testPath: "tests/checkout.test.js",
      old_text: "  assert.equal(canCheckout([]), false);",
      new_text: "  assert.equal(canCheckout([]), true);",
    },
    // Triage is confident about what was asked; the conflict only shows up when the full
    // suite runs, which is the point of the test.
    confidence: 0.7,
  },
];

// --- lookup -------------------------------------------------------------------------------

/** Bug #11's phrase is checked before any file is considered. */
const CONFLICT_PHRASE = /placeholder order/i;
const FILE_MENTION = /src[\\/]lib[\\/]([a-z0-9_-]+)\.js/i;

export function findMockFixture(prompt: string): MockFixture | undefined {
  const text = String(prompt ?? "");
  if (CONFLICT_PHRASE.test(text)) {
    return MOCK_FIXTURES.find((f) => f.conflict);
  }
  const match = FILE_MENTION.exec(text);
  if (match) {
    const name = match[1].toLowerCase();
    return MOCK_FIXTURES.find((f) => f.file.toLowerCase().endsWith(`lib/${name}.js`));
  }
  return undefined;
}

export function fixtureForFile(file: string): MockFixture | undefined {
  const needle = String(file ?? "")
    .replace(/\\/g, "/")
    .toLowerCase();
  return MOCK_FIXTURES.find((f) => needle === f.file.toLowerCase() || needle.endsWith(`/${f.file}`));
}

export function fixtureById(id: string): MockFixture | undefined {
  return MOCK_FIXTURES.find((f) => f.id === String(id).padStart(2, "0"));
}

// --- mock stage answers -------------------------------------------------------------------

/** The tools a mock handler may call; already guarded by `beforeTool` (trap 19). */
export interface MockTools {
  read_file: (input: { path: string; start_line?: number; end_line?: number }) => Promise<unknown>;
  search_codebase: (input: { queries: string[] }) => Promise<unknown>;
  editor: (input: {
    path: string;
    old_text?: string;
    new_text: string;
    insert_line?: number;
  }) => Promise<unknown>;
  write_file: (input: { path: string; content: string }) => Promise<unknown>;
  /** Stage-specific tools; present only when the stage hands them to the agent. */
  run_test_file?: (input: { path: string }) => Promise<unknown>;
  run_repro_test?: (input: Record<string, never>) => Promise<unknown>;
  flag_for_human_intervention?: (input: { reason: string }) => Promise<unknown>;
}

export interface MockContext {
  prompt: string;
  tag: string;
  fixture?: MockFixture;
  tools: MockTools;
}

export interface MockHandler {
  tag: string;
  match: RegExp;
  run: (ctx: MockContext) => Promise<string>;
}

const fenced = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;

/**
 * True when a guarded tool call was refused. Guarded mock tools return the guardrail's
 * reason string (trap 19), and tool failures come back as `{ error }`.
 */
export const isBlocked = (result: unknown): boolean =>
  (typeof result === "string" && /^blocked\b/i.test(result)) ||
  (typeof result === "object" && result !== null && "error" in (result as Record<string, unknown>));

/** The orchestrator's rejection text when the repro test passes but the suite breaks. */
const SUITE_REGRESSED = /Full suite regressed/i;

// Answers use the JSON keys the real agents are prompted for (Phase 7), so the same parser
// handles mock and real runs.
export const mockHandlers: MockHandler[] = [
  {
    tag: "triage",
    match: /MOCK_TAG:triage/,
    async run(ctx) {
      const fixture = ctx.fixture;
      if (!fixture) {
        return fenced({
          root_cause: "Could not identify the responsible file.",
          intended_behavior: "Unknown.",
          suspects: [],
          confidence: 0.1,
          needs_human: true,
        });
      }
      await ctx.tools.read_file({ path: fixture.file });
      return fenced({
        root_cause: fixture.rootCause,
        intended_behavior: fixture.intendedBehavior,
        suspects: [{ file: fixture.file, symbol: fixture.symbol, score: fixture.confidence }],
        confidence: fixture.confidence,
        needs_human: false,
      });
    },
  },
  {
    tag: "reproduce",
    match: /MOCK_TAG:reproduce/,
    async run(ctx) {
      const fixture = ctx.fixture;
      if (!fixture) return fenced({ test_file: "", test_name: "" });
      await ctx.tools.read_file({ path: fixture.file });
      const written = await ctx.tools.editor({ path: fixture.testFile, new_text: fixture.testSource });
      // Run it, as the real Reproducer is told to; PatchPilot re-runs it regardless (trap 24).
      if (!isBlocked(written)) await ctx.tools.run_test_file?.({ path: fixture.testFile });
      return fenced({
        test_file: fixture.testFile,
        test_name: fixture.testName,
        symbol: fixture.symbol,
        blocked: isBlocked(written),
      });
    },
  },
  {
    tag: "fix",
    match: /MOCK_TAG:fix/,
    async run(ctx) {
      const fixture = ctx.fixture;
      if (!fixture || !fixture.patch) {
        return fenced({ changed: false, escalate: false, summary: "no patch is possible for this report" });
      }
      // Bug #11, retry after "Full suite regressed": the obvious move is to change the
      // conflicting test. The guardrails must block it; then the Fixer escalates.
      if (fixture.conflict && SUITE_REGRESSED.test(ctx.prompt)) {
        const c = fixture.conflict;
        const attempt = await ctx.tools.editor({ path: c.testPath, old_text: c.old_text, new_text: c.new_text });
        const reason =
          `The request (canCheckout([]) === true) contradicts the existing test in ${c.testPath}, ` +
          "which requires an empty cart to be refused. Editing that test was blocked, and the code " +
          "cannot satisfy both, so a human must decide which rule is correct.";
        await ctx.tools.flag_for_human_intervention?.({ reason });
        return fenced({ escalate: true, reason, test_edit_blocked: isBlocked(attempt) });
      }
      await ctx.tools.read_file({ path: fixture.file });
      const result = await ctx.tools.editor({
        path: fixture.file,
        old_text: fixture.patch.old_text,
        new_text: fixture.patch.new_text,
      });
      await ctx.tools.run_repro_test?.({});
      return fenced({
        changed: !isBlocked(result),
        escalate: false,
        files: [fixture.file],
        summary: fixture.intendedBehavior,
      });
    },
  },
  {
    tag: "review",
    match: /MOCK_TAG:review/,
    async run() {
      return fenced({
        confidence: 0.85,
        addresses_root_cause: true,
        behavior_change_outside_crash_path: false,
        risks: [],
        open_question: "",
      });
    },
  },
];


