import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "web",
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // Playwright specs live in e2e/ and run with `pnpm --filter @tender/web e2e`, not here.
    include: ["test/**/*.test.{ts,tsx}"],
    // Lets `pnpm -r test` pass while the app has no unit tests yet.
    passWithNoTests: true,
    env: { NEXT_TELEMETRY_DISABLED: "1" },
  },
});
