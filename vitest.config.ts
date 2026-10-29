import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      // Tests of the root scripts that start a local chain, so they get long timeouts for the tests
      // and for hooks such as beforeAll(startLocalChain).
      {
        test: {
          name: "scripts",
          include: ["scripts/**/*.sandbox.test.ts"],
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
