import { defineConfig } from "vitest/config";

// Two projects, so that only the sandbox tests, which start a local chain, get long timeouts for
// tests and for hooks such as beforeAll(startLocalChain).
export default defineConfig({
  test: {
    // Lets `pnpm -r test` pass while the package has no tests yet.
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          // A busy machine can take longer than the defaults to start an in-process database.
          testTimeout: 15_000,
          hookTimeout: 60_000,
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
