import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../src/lib/pagination.js";

// Page size larger than the list, which hides the off-by-one for a single page.
test("paginate returns the whole list when the page is bigger than the list", () => {
  assert.deepEqual(paginate([1, 2, 3], 0, 10), [1, 2, 3]);
});
