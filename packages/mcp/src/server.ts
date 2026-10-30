import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TenderClient } from "@tender/client";
import type { NetworkId, TenderApi } from "@tender/shared";
import type { KeyKind } from "./keys";
import type { StateStore } from "./state";
import { registerReadTools } from "./tools/read";

/**
 * What the tools call of the chain client, and nothing more, so that a test hands the server a
 * plain object. A tool that needs another method adds it here; the real `TenderClient` has them
 * all.
 */
export type McpChain = Pick<TenderClient, "getConfig" | "balanceOf" | "storageBalanceOf">;

/** Everything the server needs from outside. The bin builds it from the environment. */
export interface McpDeps {
  /** The chain: vault and storage balances, the contract's token list. */
  client: McpChain;
  /** The Tender API, for the board, the entries and the scorecards. */
  api: TenderApi;
  /** The local drafts of the entries this server committed. */
  state: StateStore;
  network: NetworkId;
  contractId: string;
  /** The account the server acts as. */
  accountId: string;
  /** What the server's key may do; see `detectKeyKind`. */
  keyKind: KeyKind;
  /** The token the tools use when a call names none. */
  defaultToken: string;
  /** The account that `verifier: "judge"` means. */
  judgeAccount?: string;
}

/** The server's name and version, as an MCP client sees them when it connects. */
const SERVER_INFO = { name: "tender", version: "1.0.0" } as const;

/**
 * The Tender MCP server for one agent account. It is not connected to anything: the caller picks
 * the transport (`StdioServerTransport` in the bin, an in-memory pair in a test) and connects it.
 */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerReadTools(server, deps);
  return server;
}
