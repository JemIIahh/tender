import { defineConfig } from "vitest/config";

// Two projects, so that only the sandbox tests, which start a local chain, get a long timeout.
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
        },
      },
    ],
  },
});
