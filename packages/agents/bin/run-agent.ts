import { createApiClient, main } from "../src/cli";

// A reference agent over stdio: `--agent analyst|coder|extractor --solver llm|offline|weak
// --network <n>`. What it reads and checks is in `../src/cli.ts`, and so is the Tender API client
// it acts through (`createApiClient`, an `ApiClient` signed in as the agent). Its log lines go to
// stdout, a failure to stderr, and neither includes a key.

process.exitCode = await main(process.argv.slice(2), { createApi: createApiClient });
