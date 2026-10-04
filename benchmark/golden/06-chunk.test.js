import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk } from "../../src/lib/chunk.js";

// Bug 06: chunks must advance by `size`, covering every item.
test("chunk splits a list into consecutive chunks", () => {
  assert.deepEqual(chunk([1, 2, 3, 4], 2), [
    [1, 2],
    [3, 4],
  ]);
});
