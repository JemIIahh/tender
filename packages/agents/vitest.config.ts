import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Lets `pnpm -r test` pass while the package has no tests yet.
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
        },
      },
    ],
  },
});
