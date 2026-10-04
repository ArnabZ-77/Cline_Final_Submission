import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTotal } from "../src/lib/total.js";

test("computeTotal adds price * quantity", () => {
  assert.equal(
    computeTotal([
      { price: 10, quantity: 2 },
      { price: 5, quantity: 1 },
    ]),
    25
  );
});

test("computeTotal of an empty list is 0", () => {
  assert.equal(computeTotal([]), 0);
});
