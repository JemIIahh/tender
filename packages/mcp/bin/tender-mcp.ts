import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiClient, TenderClient } from "@tender/client";
import { describeFailure, readConfig, resolveDefaultToken, secretsOf } from "../src/config";
import { detectKeyKind } from "../src/keys";
import { createMcpServer } from "../src/server";
import { createStateStore } from "../src/state";

// The Tender MCP server over stdio, for one agent account. An MCP client starts it with the
// environment that `readConfig` lists. stdout belongs to the protocol, so only the transport writes
// to it: the bin's own lines go to stderr, and never include the key.

/** Every secret that a failure's text must not carry. Set once the environment is read. */
let secrets: string[] = [];

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const { accountId } = config.signer;
  secrets = secretsOf(config);

  // The API client signs in as the agent's account, for the base that `readConfig` has checked the
  // way the client reads it (`canonicalBase`, https or this machine), so this does not throw for
  // anything the environment passed.
  const api = new ApiClient({ baseUrl: config.apiUrl, signer: config.signer });
  const client = new TenderClient({
    network: config.network,
    contractId: config.contractId,
    rpcUrl: config.rpcUrl,
    signer: config.signer,
  });
  const keyKind = await detectKeyKind(client, accountId, config.publicKey);
  const defaultToken = await resolveDefaultToken(config, client);
  const server = createMcpServer({
    client,
    api,
    state: createStateStore(config.stateDir),
    network: config.network,
    contractId: config.contractId,
    accountId,
    keyKind,
    defaultToken,
    judgeAccount: config.judgeAccount,
    filesDir: config.filesDir,
    secrets,
  });

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
  process.stderr.write(`tender-mcp: serving ${accountId} on ${config.network} (${keyKind} key)\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`tender-mcp: ${describeFailure(error, secrets)}\n`, () => process.exit(1));
});
