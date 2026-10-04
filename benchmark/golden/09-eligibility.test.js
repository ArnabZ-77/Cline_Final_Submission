import { test } from "node:test";
import assert from "node:assert/strict";
import { isEligibleForFreeShipping } from "../../src/lib/eligibility.js";

// Bug 09: the policy is a large order AND a loyalty member, not either.
test("isEligibleForFreeShipping requires both a large order and loyalty", () => {
  assert.equal(isEligibleForFreeShipping(500, false), false);
});
