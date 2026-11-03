import { defineConfig, devices } from "@playwright/test";
import { API_URL, RPC_URL } from "./e2e/fixtures";

// Next must not send telemetry when e2e starts `next dev` or `next start`.
process.env.NEXT_TELEMETRY_DISABLED = "1";

// Each lane runs its web server on its own port (P06-P13); 3000 is only the fallback.
const port = Number(process.env.WEB_PORT || 3000);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  // The web server, for the specs that run against the fixture API (e2e/fixtures.ts). 06-T1b adds
  // `globalSetup: "./e2e/global-setup.ts"`, which starts the chain, the services and the web
  // server, and takes this block out. A server that is already on the port is an error, not a
  // server to test: it would not have these values.
  webServer: {
    command: "pnpm dev",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_NETWORK: "testnet",
      NEXT_PUBLIC_API_URL: API_URL,
      // Never the real node: a read that no spec answers fails to connect (e2e/walletStub.ts).
      NEXT_PUBLIC_RPC_URL: RPC_URL,
      NEXT_PUBLIC_CONTRACT: "tender.tender-team.testnet",
      // The Judge the post wizard offers as the verifier, and picks by default (e2e/fixtures.ts).
      NEXT_PUBLIC_JUDGE_ACCOUNT: "judge.tender-team.testnet",
    },
  },
  projects: [
    {
      name: "chrome",
      // The installed Google Chrome, so no browser is downloaded (P06-P17).
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
});
