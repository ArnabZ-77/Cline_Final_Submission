import { test } from "node:test";
import assert from "node:assert/strict";
import { createUser, _resetUsersForTests } from "../../src/lib/signup.js";

// Bug 07: signup must reject an empty or malformed email address.
test("createUser rejects an empty email", () => {
  _resetUsersForTests();
  assert.throws(() => createUser({ name: "Bad", email: "" }), RangeError);
});

test("createUser rejects a malformed email", () => {
  _resetUsersForTests();
  assert.throws(() => createUser({ name: "Bad", email: "not-an-email" }), RangeError);
});
