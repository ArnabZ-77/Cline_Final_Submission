import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createUser, _resetUsersForTests } from "../src/lib/signup.js";
import { updateEmail } from "../src/lib/update.js";

beforeEach(_resetUsersForTests);

test("updateEmail changes the stored email for a valid address", () => {
  const created = createUser({ name: "Asha", email: "asha@example.com" });
  const updated = updateEmail(created.id, "asha2@example.com");
  assert.equal(updated.email, "asha2@example.com");
});
