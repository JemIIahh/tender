import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@tender/payments",
    include: ["test/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
