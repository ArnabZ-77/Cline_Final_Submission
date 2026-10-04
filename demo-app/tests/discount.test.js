import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDiscount } from "../src/lib/discount.js";

test("applyDiscount applies a whole-number percentage", () => {
  assert.equal(applyDiscount(100, "20"), 80);
});

test("applyDiscount rejects a percentage above 100", () => {
  assert.throws(() => applyDiscount(100, "150"), RangeError);
});
