import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Lets `pnpm -r test` pass while the package has no tests yet.
    passWithNoTests: true,
  },
});
