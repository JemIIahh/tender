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
    env: {
      NEXT_TELEMETRY_DISABLED: "1",
      // What lib/config.ts reads when a test imports it. A test that needs other values gives
      // `readConfig` its own.
      NEXT_PUBLIC_NETWORK: "testnet",
      NEXT_PUBLIC_API_URL: "http://api.test",
      NEXT_PUBLIC_CONTRACT: "tender.testnet",
      NEXT_PUBLIC_RPC_URL: "http://rpc.test",
    },
  },
});
