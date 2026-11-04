import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TenderClient } from "@tender/client";
import type { NetworkId, TenderApi } from "@tender/shared";
import type { KeyKind } from "./keys";
import type { StateStore } from "./state";
import { type ConnectToolDeps, registerConnectTool } from "./tools/connect";
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
  // A delegate key's caps (`get_delegate`), which `hire_agent` reads before it spends.
  | "view"
  // The agent bond (contract Task 16b): the agent's record, and the bond token in its wallet.
  | "getAgent"
  | "ftStorageBalanceOf"
  | "ftBalanceOf"
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
  /** What the server's key may do; see `detectKeyAccess`. */
  keyKind: KeyKind;
  /**
   * The public key of the server's key, as NEAR writes one (`ed25519:...`). `hire_agent` asks the
   * chain for its caps when it is a function-call key, which a delegate key is. Left out, a
   * function-call key is not taken for a delegate key, and cannot hire.
   */
  publicKey?: string;
  /**
   * The methods of the contract that a `function_call` key lists (`detectKeyAccess`). Left out or
   * empty means that it lists none, and a key that lists none may call any, as on the chain. The
   * write tools check the key against the method they are about to call, before they upload or
   * send anything (`keyMayCall`).
   */
  keyMethods?: readonly string[];
  /** The token the tools use when a call names none. */
  defaultToken: string;
  /** The account that `verifier: "judge"` means. */
  judgeAccount?: string;
  /**
   * The one directory that `commit_result` may read a file from (P04-R1), as a real path: it is used
   * as it is and never looked up again (P04-R3), so a path with a link in it reads nothing. A file
   * is read only if it is a regular file whose real path, with every link followed, is inside it
   * and has no name below it that starts with a dot (a hidden file or folder: `.env`, `.ssh`).
   * Not set means that no file is read at all. The bin gets it from `readConfig`, which looks the
   * directory up once, and accepts only one that nobody but the user (and root) can write to
   * (P04-R2) and that is neither the home directory nor a directory that holds it; a caller that
   * builds the deps by hand answers for all of that itself.
   */
  filesDir?: string;
  /**
   * The directory the drafts are kept in (the bin passes `TENDER_STATE_DIR`'s). `commit_result`
   * reads no file inside it, whatever `filesDir` is: a draft file holds another task's unrevealed
   * work and its salt, and `reveal_result` publishes what a commit took in. Not set means that this
   * directory is not named; the other places that are kept out (`stateRoot`, and any folder called
   * `drafts`) are kept out all the same, so a caller that builds the deps by hand and sets
   * `filesDir` need only name this one. The path need not exist yet, nor be a real path: it is
   * looked up at each call.
   */
  stateDir?: string;
  /**
   * The directory that holds the default state directories of every account on this machine,
   * `~/.tender` (`defaultStateRoot`). `commit_result` reads no file inside it either, whatever
   * `filesDir` is: another account's drafts are as private as this server's own. Not set means the
   * default root, and a test says where it is. The path need not exist, nor be a real path.
   */
  stateRoot?: string;
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
  /**
   * What `connect_to_tender` needs, to connect a new agent with a code from its owner's page. Not
   * set means the tool is not offered. The bin sets it from the server's own settings.
   */
  connect?: ConnectToolDeps;
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
  if (deps.connect !== undefined) registerConnectTool(server, deps.connect);
  return server;
}

/**
 * The server in connect mode (`tender-mcp --connect`), for an agent that has no account yet: it
 * offers `connect_to_tender` alone, and holds no key until that tool has made one.
 */
export function createConnectServer(deps: ConnectToolDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerConnectTool(server, deps);
  return server;
}
