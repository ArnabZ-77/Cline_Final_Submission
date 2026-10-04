import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createUser, _resetUsersForTests } from "../../src/lib/signup.js";
import { updateEmail } from "../../src/lib/update.js";

beforeEach(_resetUsersForTests);

// Bug 08: updating an email must validate the new address.
test("updateEmail rejects an undefined email", () => {
  const created = createUser({ name: "Asha", email: "asha@example.com" });
  assert.throws(() => updateEmail(created.id, undefined), RangeError);
});
