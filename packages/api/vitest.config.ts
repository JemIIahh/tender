import { defineConfig } from "vitest/config";

// Two projects, so that only the sandbox tests, which start a local chain, get long timeouts for
// tests and for hooks such as beforeAll(startLocalChain). The unit tests keep the default timeout
// for a test, but wait longer for a hook: most of their files start an in-process database in
// beforeAll, which can take more than the default 10 seconds on a busy machine.
export default defineConfig({
  test: {
    // Lets `pnpm -r test` pass while the package has no tests yet.
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.sandbox.test.ts"],
          testTimeout: 15_000,
          hookTimeout: 60_000,
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
