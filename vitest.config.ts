import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      // The web app's unit tests (jsdom). Its Playwright specs run separately, with the e2e script.
      "apps/web",
      // Tests of the root scripts. Most of them start a local chain, so every one gets long
      // timeouts for the tests and for hooks such as beforeAll(startLocalChain).
      {
        test: {
          name: "scripts",
          include: ["scripts/**/*.test.ts"],
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
      // Tests of the seed tasks, which sit outside packages/*.
      {
        test: {
          name: "seeds",
          include: ["seeds/**/*.test.ts"],
        },
      },
    ],
  },
});
