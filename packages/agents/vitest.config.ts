import { defineConfig } from "vitest/config";

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
        },
      },
    ],
  },
});
