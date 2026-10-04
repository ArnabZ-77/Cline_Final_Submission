import { defineConfig } from "vitest/config";

// PatchPilot's own unit tests only. demo-app/** and benchmark/** are node:test suites
// and would fail under vitest.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "demo-app/**", "benchmark/**", ".patchpilot/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
