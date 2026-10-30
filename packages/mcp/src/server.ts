import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TenderClient } from "@tender/client";
import type { NetworkId, TenderApi } from "@tender/shared";
import type { KeyKind } from "./keys";
import type { StateStore } from "./state";
import { registerReadTools } from "./tools/read";
import { registerWriteTools } from "./tools/write";

/**
 * What the tools call of the chain client, and nothing more, so that a test hands the server a
 * plain object. A tool that needs another method adds it here; the real `TenderClient` has them
 * all.
 */
export type McpChain = Pick<
  TenderClient,
  // Views: the contract's token list, the vault and storage balances, and one entry.
  | "getConfig"
  | "balanceOf"
  | "storageBalanceOf"
  | "getEntry"
  // Senders: what the write tools sign and send.
  | "storageDeposit"
  | "commit"
  | "reveal"
  | "postTask"
  | "pick"
  | "deposit"
  | "withdraw"
  | "registerAgent"
>;

/**
 * How the path of an open file is found from its descriptor. Only Linux can say, through
 * `/proc/self/fd`, where the kernel has the file that is open; so that is the one platform where
 * `commit_result` asks (P04-R2). It is a parameter so that a test can pose as Linux, or as another
 * platform, and say where a file is.
 */
export interface OpenFileLookup {
  platform: NodeJS.Platform;
  /** The real path of the file open as `fd`. Rejects when that cannot be said. */
  pathOf(fd: number): Promise<string>;
}

/** Everything the server needs from outside. The bin builds it from the environment. */
export interface McpDeps {
  /** The chain: what the tools read from the contract, and the transactions they send to it. */
  client: McpChain;
  /** The Tender API: the board, the entries and the scorecards, and where documents and work go. */
  api: TenderApi;
  /** The local drafts of the entries this server committed. Two servers must not share one. */
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
  /**
   * The one directory that `commit_result` may read a file from (P04-R1), as the user wrote it.
   * A file is read only if it is a regular file whose real path, with every link followed, is
   * inside this directory's. Not set means that no file is read at all. The bin gets it from
   * `readConfig`, which accepts only a directory that nobody but the user (and root) can write to
   * (P04-R2); a caller that builds the deps by hand answers for that itself.
   */
  filesDir?: string;
  /** How an open file is traced back to a path. Not set means the process's own (the real one). */
  openFiles?: OpenFileLookup;
  /**
   * Strings that no tool may ever answer with, such as the private key, its base58 body and the
   * credentials in the RPC URL (`secretsOf`). A failed tool's text has them cut out, and so has any
   * error text in an answer that succeeded; a bearer token and a URL are cut whether listed or not.
   * `commit_result` refuses a result that holds one, since a reveal would publish it, and
   * `reveal_result` looks again at the work it is about to upload: as it is or in a disguise
   * (best effort; see `secretCheck`). So do the tools that publish a document (`post_task`,
   * `pick_winners` and `register_agent`), before anything is uploaded or paid.
   */
  secrets?: readonly string[];
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
  registerWriteTools(server, deps);
  return server;
}
