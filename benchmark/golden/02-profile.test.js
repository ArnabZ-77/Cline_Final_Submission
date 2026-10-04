import { test } from "node:test";
import assert from "node:assert/strict";
import { getUserCity } from "../../src/lib/profile.js";

// Bug 02: a user without an address must not crash; the city is unknown.
test("getUserCity returns undefined when the user has no address", () => {
  assert.equal(getUserCity({ name: "Rahul" }), undefined);
});
