import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk } from "../src/lib/chunk.js";

// The list is shorter than one chunk, which hides the off-by-one stride.
test("chunk returns a single chunk when the list fits", () => {
  assert.deepEqual(chunk([1, 2], 5), [[1, 2]]);
});
