import type { TenderApi } from "@tender/shared";
import { CliError, main, type RunConfig } from "../src/cli";

// A reference agent over stdio: `--agent analyst|coder|extractor --solver llm|offline|weak
// --network <n>`. What it reads and checks is in `../src/cli.ts`. Its log lines go to stdout, a
// failure to stderr, and neither includes a key.

/**
 * Where the agent gets its Tender API client, the one part the bin cannot build yet. The client is
 * `ApiClient` of `@tender/client` (plan 03 task 12b), which implements `TenderApi`. When it is
 * merged, this function becomes
 *
 *     return new ApiClient({ baseUrl: config.apiUrl, signer: config.signer });
 *
 * and nothing else in the bin changes. Until then the agent stops here, after its key is checked
 * and before it lists a task.
 */
function createApi(_config: RunConfig): TenderApi {
  throw new CliError("the Tender API client is not available yet: ApiClient (plan 03 task 12b)");
}

process.exitCode = await main(process.argv.slice(2), { createApi });
