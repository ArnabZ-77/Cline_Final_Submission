import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateRefund } from "../../src/lib/refund.js";

// Bug 04: money arrives formatted ("$19.99") and must be parsed, not rejected.
test("calculateRefund parses a currency-formatted amount", () => {
  assert.equal(calculateRefund("$19.99", "0"), 19.99);
});
