import { defineConfig, devices } from "@playwright/test";
import { API_URL, RPC_URL } from "./e2e/fixtures";

// The third suite: the email and Google login, in a build with a Privy app id. Privy's kit needs
// Privy's servers, so this suite's web server builds the app with the kit replaced by a stand-in
// (e2e/privy/kit.tsx; next.config.ts makes the swap under TENDER_E2E_PRIVY_KIT=1). Everything of
// the app's own is real: the chooser, the wallet store, the bridge, the readiness check and the
// pages. The API and the node are answered by the specs (e2e/fixtures.ts), as in the first suite.
//
// Run it with `pnpm --filter @tender/web exec playwright test -c playwright.privy.config.ts`. Its
// web server is `next dev` in this directory, so it can't run beside the fixture suite's. The
// fixture suite (playwright.config.ts) builds with no app id and does not take these specs:
// they are `*.privy.ts`, not `*.spec.ts`.

process.env.NEXT_TELEMETRY_DISABLED = "1";

const port = Number(process.env.WEB_PORT || 3000);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e/privy",
  testMatch: "**/*.privy.ts",
  outputDir: "./test-results/privy",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_NETWORK: "testnet",
      NEXT_PUBLIC_API_URL: API_URL,
      NEXT_PUBLIC_RPC_URL: RPC_URL,
      NEXT_PUBLIC_CONTRACT: "tender.tender-team.testnet",
      NEXT_PUBLIC_JUDGE_ACCOUNT: "judge.tender-team.testnet",
      // Made up: the stand-in kit never sends it anywhere.
      NEXT_PUBLIC_PRIVY_APP_ID: "e2e-privy-app",
      TENDER_E2E_PRIVY_KIT: "1",
    },
  },
  projects: [
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
});
