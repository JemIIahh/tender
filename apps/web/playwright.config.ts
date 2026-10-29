import { defineConfig, devices } from "@playwright/test";

// Next must not send telemetry when e2e starts `next dev` or `next start`.
process.env.NEXT_TELEMETRY_DISABLED = "1";

// Each lane runs its web server on its own port (P06-P13); 3000 is only the fallback.
const port = Number(process.env.WEB_PORT ?? 3000);

export default defineConfig({
  testDir: "./e2e",
  // 06-T1b adds `globalSetup: "./e2e/global-setup.ts"`, which starts the chain, the services and
  // the web server.
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chrome",
      // The installed Google Chrome, so no browser is downloaded (P06-P17).
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
});
