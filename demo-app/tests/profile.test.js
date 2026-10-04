import { test } from "node:test";
import assert from "node:assert/strict";
import { getUserCity } from "../src/lib/profile.js";

test("getUserCity returns the city of a complete user", () => {
  assert.equal(getUserCity({ name: "Asha", address: { city: "Pune" } }), "Pune");
});
