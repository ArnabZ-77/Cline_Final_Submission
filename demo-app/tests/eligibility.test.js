import { test } from "node:test";
import assert from "node:assert/strict";
import { isEligibleForFreeShipping } from "../src/lib/eligibility.js";

test("a large order from a loyalty member is eligible", () => {
  assert.equal(isEligibleForFreeShipping(60, true), true);
});

test("a small order from a non-member is not eligible", () => {
  assert.equal(isEligibleForFreeShipping(10, false), false);
});
