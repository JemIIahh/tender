import { stopStack } from "./stack";

// The global teardown of the chain suite: stops the web server, the services and the chain, ends
// what they leave, and removes the run's temp dir (stack.ts). It runs after the specs, after a
// setup that failed half way, and after a run that was interrupted.
export default async function globalTeardown(): Promise<void> {
  await stopStack();
}
