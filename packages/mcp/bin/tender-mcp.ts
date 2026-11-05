import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ApiClient,
  type ApiClientOptions,
  fetchNamingApi,
  requireNodeVersion,
  TenderClient,
} from "@tender/client";
import { NETWORKS } from "@tender/shared";
import {
  askNode,
  checkApiDeployment,
  describeFailure,
  filesDirWarning,
  readConfig,
  readConnectConfig,
  resolveDefaultToken,
  secretsOf,
} from "../src/config";
import { detectKeyAccess } from "../src/keys";
import { urlCredentials } from "../src/secrets";
import { createConnectServer, createMcpServer } from "../src/server";
import { createStateStore } from "../src/state";

// The Tender MCP server over stdio, for one agent account. An MCP client starts it with the
// environment that `readConfig` lists. stdout belongs to the protocol, so only the transport writes
// to it: the bin's own lines go to stderr, and never include the key.
//
// With `--connect` it is the server of an agent that has no account yet: it reads only the
// network, the contract and the API (`readConnectConfig`), and offers `connect_to_tender` alone,
// which makes the agent's key and connects it with a code from its owner's page.

// On a Node older than Tender needs, one line says so before anything is read or started.
requireNodeVersion();

/** How long the check of the API's deployment waits: an API that hangs must not hold up the start. */
const API_CHECK_TIMEOUT_MS = 5_000;

/**
 * A client of the API at `TENDER_API_URL` whose requests that get no answer say which address did
 * not answer (`API_UNREACHABLE` in a tool's answer, and the start-up line), not a bare "fetch failed".
 */
const apiClient = (options: ApiClientOptions) =>
  new ApiClient({ ...options, fetchImpl: fetchNamingApi(options.baseUrl) });

/** Every secret that a failure's text must not carry. Set once the environment is read. */
let secrets: string[] = [];

/** Serves `server` over stdio until the client goes, and says so on stderr. */
async function serve(server: McpServer, line: string): Promise<void> {
  // The session is over when the client closes our stdin, or a signal asks us to stop. Without
  // this the process would wait on whatever connections the chain client keeps open.
  const stop = () => {
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.stdin.once("end", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await server.connect(new StdioServerTransport());
  process.stderr.write(`tender-mcp: ${line}\n`);
}

/** Connect mode: no account and no key, and `connect_to_tender` alone. */
async function connectMode(): Promise<void> {
  const config = readConnectConfig(process.env);
  // The RPC URL's credentials, if it has any, are all there is to keep out of what it prints.
  secrets = urlCredentials(config.rpcUrl);
  const api = apiClient({ baseUrl: config.apiUrl });
  await checkApiDeployment(
    config,
    apiClient({ baseUrl: config.apiUrl, timeoutMs: API_CHECK_TIMEOUT_MS }),
    (line) => process.stderr.write(`tender-mcp: ${line}\n`),
  );
  const server = createConnectServer({
    network: config.network,
    contractId: config.contractId,
    api,
    rpcUrl: config.rpcUrl,
    secrets,
  });
  await serve(server, `connect mode on ${config.network}: connect_to_tender only`);
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--connect")) return connectMode();
  const config = readConfig(process.env);
  const { accountId } = config.signer;
  secrets = secretsOf(config);
  // A files directory that nothing can be read from is no fault of the environment, but every
  // `file_path` would be refused without a word as to why: one line says it.
  const warning = filesDirWarning(config);
  if (warning !== undefined) process.stderr.write(`tender-mcp: ${warning}\n`);

  // The API client signs in as the agent's account, for the base that `readConfig` has checked the
  // way the client reads it (`canonicalBase`, https or this machine), so this does not throw for
  // anything the environment passed.
  const api = apiClient({ baseUrl: config.apiUrl, signer: config.signer });
  // Before anything is asked of the chain or written to the state: an API of another network or
  // contract would have this server commit to tasks that the contract it signs for does not have.
  await checkApiDeployment(
    config,
    apiClient({ baseUrl: config.apiUrl, timeoutMs: API_CHECK_TIMEOUT_MS }),
    (line) => process.stderr.write(`tender-mcp: ${line}\n`),
  );
  const client = new TenderClient({
    network: config.network,
    contractId: config.contractId,
    rpcUrl: config.rpcUrl,
    signer: config.signer,
  });
  // The first questions to the node: one that gives no answer is named, with `NEAR_RPC_URL`, in
  // place of a bare `fetch failed`.
  const key = await askNode(config, () => detectKeyAccess(client, accountId, config.publicKey));
  const defaultToken = await askNode(config, () => resolveDefaultToken(config, client));
  const server = createMcpServer({
    client,
    api,
    state: createStateStore(config.stateDir),
    network: config.network,
    contractId: config.contractId,
    accountId,
    keyKind: key.kind,
    keyMethods: key.methods,
    publicKey: config.publicKey,
    defaultToken,
    judgeAccount: config.judgeAccount,
    filesDir: config.filesDir,
    stateDir: config.stateDir,
    secrets,
    connect: {
      network: config.network,
      contractId: config.contractId,
      // The connect routes need no sign-in: a client of its own, with no signer.
      api: apiClient({ baseUrl: config.apiUrl }),
      rpcUrl: config.rpcUrl ?? NETWORKS[config.network].rpcUrl,
      secrets,
    },
  });

  await serve(server, `serving ${accountId} on ${config.network} (${key.kind} key)`);
}

main().catch((error: unknown) => {
  process.stderr.write(`tender-mcp: ${describeFailure(error, secrets)}\n`, () => process.exit(1));
});
