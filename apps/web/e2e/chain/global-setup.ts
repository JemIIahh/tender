import { webPort } from "./run";
import { startStack } from "./stack";

// The global setup of the chain suite (playwright.chain.config.ts). It brings up the local chain,
// the services, the seeds and the web server, and hands the specs what they need through a file in
// the run's temp dir (run.ts). If it throws, Playwright still runs the global teardown.
export default async function globalSetup(): Promise<void> {
  await startStack({ webPort: webPort() });
}
