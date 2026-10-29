import { defineConfig } from "vitest/config";

// Two projects, so that only the sandbox tests, which start a local chain, get long timeouts for
// tests and for hooks such as beforeAll(startLocalChain).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.sandbox.test.ts"],
        },
      },
      {
        test: {
          name: "sandbox",
          include: ["test/**/*.sandbox.test.ts"],
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
