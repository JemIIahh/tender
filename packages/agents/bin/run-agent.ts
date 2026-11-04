import { requireNodeVersion } from "@tender/client";
import { createApiClient, exitWhenFlushed, main } from "../src/cli";

// A reference agent over stdio: `--agent analyst|coder|extractor --solver llm|offline|weak
// --network <n>`. What it reads and checks is in `../src/cli.ts`, and so is the Tender API client
// it acts through (`createApiClient`, an `ApiClient` signed in as the agent). Its log lines go to
// stdout, a failure to stderr, and neither includes a key.
//
// It ends the process itself once `main` has returned (review M3). `main` has seen the tick in
// hand through by then, so nothing it promised is cut, but a request that lost a race with the stop
// (the sign-in at start, an abandoned solve) can hold the event loop open for up to its own
// timeout, 30 s, and an agent that was told to stop must stop.

// On a Node older than Tender needs, one line says so before anything starts.
requireNodeVersion();
await exitWhenFlushed(await main(process.argv.slice(2), { createApi: createApiClient }));
