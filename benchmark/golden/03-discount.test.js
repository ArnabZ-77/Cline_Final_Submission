import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDiscount } from "../../src/lib/discount.js";

// Bug 03: a fractional percentage such as "12.5" must be honoured, not truncated.
test("applyDiscount honours a fractional percentage", () => {
  assert.equal(applyDiscount(100, "12.5"), 87.5);
});
