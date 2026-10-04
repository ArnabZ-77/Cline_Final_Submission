import { test } from "node:test";
import assert from "node:assert/strict";
import { canCheckout } from "../../src/lib/checkout.js";

// Bug 10: every item must be in stock, so one out-of-stock item blocks checkout.
test("canCheckout blocks a cart with an out-of-stock item", () => {
  assert.equal(canCheckout([{ inStock: true }, { inStock: false }]), false);
});
