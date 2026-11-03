import { defineConfig, devices } from "@playwright/test";
import { webPort } from "./e2e/chain/run";

// The second suite: the pages of the app against a real local chain, the real services (indexer,
// API, keeper and Judge) and the dev wallet of the sandbox, where the first (playwright.config.ts)
// has a fixture API and a model of the chain. The global setup starts all of it and the web server
// with it, because the server needs values that are known only after the chain has started
// (e2e/chain/stack.ts), and the global teardown takes it all down again.
//
// Run it with `pnpm --filter @tender/web e2e:chain`. It needs the nearcore binary that
// near-sandbox uses: set NEAR_SANDBOX_BIN_PATH to it, or near-sandbox downloads one. The web server
// is `next dev` in this directory, so it can't run beside the fixture suite's, or beside any other
// `next dev` here. A server that is already on the port is an error, not a server to test.

export default defineConfig({
  testDir: "./e2e/chain",
  // `*.chain.ts` and not `*.spec.ts`, so that the fixture suite, whose test dir (./e2e) holds this
  // one, never takes these for its own.
  testMatch: "**/*.chain.ts",
  globalSetup: "./e2e/chain/global-setup.ts",
  globalTeardown: "./e2e/chain/global-teardown.ts",
  // One browser at a time: the specs share one chain, and a spec leaves it changed.
  workers: 1,
  fullyParallel: false,
  // A spec that ran something on the chain can't be run again as if nothing had happened.
  retries: 0,
  // A transaction waits for its block to be final, a few seconds each, and a page of `next dev`
  // compiles on its first request.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  outputDir: "./test-results/chain",
  use: {
    baseURL: `http://localhost:${webPort()}`,
    trace: "retain-on-failure",
    // A click, a fill or a load that does not come in this time fails, and says what it was.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: "chrome",
      // The installed Google Chrome, so no browser is downloaded (P06-P17).
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
});
