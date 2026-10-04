import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createUser, getUser, _resetUsersForTests } from "../src/lib/signup.js";

beforeEach(_resetUsersForTests);

test("createUser stores a user with a valid email and getUser reads it back", () => {
  const created = createUser({ name: "Asha", email: "asha@example.com" });
  assert.equal(getUser(created.id).email, "asha@example.com");
});
