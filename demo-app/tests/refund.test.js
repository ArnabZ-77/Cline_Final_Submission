import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateRefund } from "../src/lib/refund.js";

test("calculateRefund subtracts the fee from the amount", () => {
  assert.equal(calculateRefund("20", 5), 15);
});
