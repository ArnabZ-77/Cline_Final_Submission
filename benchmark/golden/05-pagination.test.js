import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../../src/lib/pagination.js";

// Bug 05: a full page must contain exactly `pageSize` items.
test("paginate returns a full first page", () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5, 6], 0, 3), [1, 2, 3]);
});
