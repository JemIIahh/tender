import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type AgentKeyFile,
  agentKeyFor,
  type ConnectApi,
  type ConnectChain,
  ConnectError,
  type ConnectOutcome,
  connectAgent,
  FUND_AGENT_WHERE,
  hasAgentKeyFile,
  KeyDirError,
  KeyInUseError,
  keyDirOf,
  planRegistration,
  readAgentKeyFile,
  registerWithBond,
  rpcFullAccessKeys,
  rpcKeyState,
  scriptedProfile,
  TenderClient,
} from "@tender/client";
import { CONNECT_CODE_PATTERN, type ConnectLookup, type NetworkId } from "@tender/shared";
import { z } from "zod";
import { errorResult, jsonResult, ToolError } from "./format";

// `connect_to_tender`: the agent's side of "Connect your agent" from an MCP client, as
// `pnpm agent:connect` is from a terminal. The owner's page shows a code and the sentence
// "Connect to Tender with code <code>"; the tool runs `connectAgent` of `@tender/client`:
//
//   - the key is `pnpm agent:init`'s: the same file, `<name>.json` in `.tender/agents/` of the
//     repository (mode 0600, in a directory of mode 0700), under the same key-directory guard, so
//     the terminal's commands (`agent:register`, `agent:delegate`) use it afterwards. The private key
//     is in that file and nowhere else: no answer of this tool holds it;
//   - only the PUBLIC key goes to the API, with the code;
//   - the code must be for the network and the contract this server is set for;
//   - registering is `registerWithBond` with the agent's own key, once the owner's batch has put the
//     bond in its vault. The only thing it moves is NEAR into the storage balance, out of the NEAR
//     the owner sent the account for it.
//
// An MCP call cannot wait half an hour, so one call waits `wait_seconds` (50 by default) and then
// says where it stopped. The next call with the same code goes on from there: the key file is used
// again, and attaching the same key twice is answered as the first time.

/** The repository root: this file is `packages/mcp/src/tools/connect.ts`. */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** `pnpm agent:init`'s directory for keys, which git ignores. */
const KEYS_DIR = join(REPO_ROOT, ".tender", "agents");

/** How long one call waits for the owner and the bond unless it is told otherwise, in seconds. */
const DEFAULT_WAIT_SECONDS = 50;

/** What the tool needs. The bin builds it from the server's own settings. */
export interface ConnectToolDeps {
  /** The network and the contract this server is for: a code for another is refused. */
  network: NetworkId;
  contractId: string;
  /** The API that made the code: the routes the code opens (an `ApiClient` with or without a signer). */
  api: ConnectApi;
  /** The chain's RPC. */
  rpcUrl: string;
  /** Where agent keys are kept. Default: `.tender/agents/` of the repository. */
  keysDir?: string;
  /** The repository the key-directory guard keeps keys out of. Default: this one. */
  repoRoot?: string;
  /** How often to look while waiting, in ms. 3 s by default. */
  pollMs?: number;
  /** How long to keep asking the API to take the agent's word, once registered, in ms. */
  confirmMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** The client that registers the agent with its own key. A test passes its own. */
  clientFor?: (signer: { accountId: string; privateKey: string }) => TenderClient;
  /** Strings no answer may hold, beside the agent's own key. */
  secrets?: readonly string[];
}

const CONNECTS = {
  readOnlyHint: false,
  // It makes a key, and the agent registers, which locks the bond the owner paid into its vault.
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** What to do after the call, for each place it can stop. */
function nextStep(outcome: ConnectOutcome, name: string): string {
  switch (outcome.status) {
    case "waiting_for_account":
      return (
        `Tell the owner (${outcome.owner}) that the fingerprint is ${outcome.fingerprint}: their page ` +
        "shows the same one. Once it matches, they press Create agent. Then call connect_to_tender " +
        "again with the same code."
      );
    case "waiting_for_bond":
      return (
        `${outcome.accountId} exists, and its bond has not reached its vault yet. Tell the owner: ` +
        `${FUND_AGENT_WHERE(outcome.owner, name)} Then call connect_to_tender again with the same code.`
      );
    case "registered":
      return (
        `${outcome.accountId} is registered. Its full-access key is in ${outcome.keyPath}, and only ` +
        "there. To enter tasks with this server, give it a key that cannot spend: from a terminal, " +
        `pnpm agent:delegate --name ${name} --per-task <amount> --total <amount>, then start the ` +
        `server with TENDER_ACCOUNT=${outcome.accountId} and that key (docs/MCP.md, Keys).`
      );
  }
}

/** Registers `connect_to_tender` on `server`. */
export function registerConnectTool(server: McpServer, deps: ConnectToolDeps): void {
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const secrets = [...(deps.secrets ?? [])];

  server.registerTool(
    "connect_to_tender",
    {
      title: "Connect to Tender with a code",
      description:
        "Connect a NEW agent to Tender with the connect code from its owner's Add an agent page " +
        '(the owner says "Connect to Tender with code tc_..."). It makes the agent\'s own ed25519 ' +
        "key on this machine, in .tender/agents/<name>.json (mode 600; the private key never " +
        "leaves the file and is never shown), sends only the PUBLIC key to Tender with the code, " +
        "and gives the key's fingerprint for the owner to match on their page before they create " +
        "the account. Then it waits for the owner's wallet to create <name>.<owner> with that key " +
        "and pay its bond, and registers the agent with its own key. One call waits wait_seconds " +
        "(50 by default) and says where it stopped (status waiting_for_account or " +
        "waiting_for_bond): call it again with the same code to go on. It moves no token of yours: " +
        "the bond comes from the owner. Safe to repeat.",
      inputSchema: {
        code: z
          .string()
          .regex(CONNECT_CODE_PATTERN, "a connect code is tc_ and 26 letters and digits")
          .describe("The connect code, tc_ and 26 letters and digits, from the owner's page"),
        name: z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,31}$/)
          .optional()
          .describe(
            "The agent's name, for its key file and profile. Default: the account name the code was made for",
          ),
        wait_seconds: z
          .int()
          .min(0)
          .max(300)
          .optional()
          .describe("How long this call waits for the owner and the bond, 0 to 300 (default 50)"),
      },
      annotations: CONNECTS,
    },
    async ({ code, name, wait_seconds }) => {
      const progress: string[] = [];
      // The agent's private key, once it is read, is cut out of anything this call says.
      const held: string[] = [];
      try {
        const outcome = await connectAgent({
          code,
          ...(name !== undefined && { name }),
          api: deps.api,
          log: (line) => progress.push(line),
          waitMs: (wait_seconds ?? DEFAULT_WAIT_SECONDS) * 1000,
          ...(deps.pollMs !== undefined && { pollMs: deps.pollMs }),
          ...(deps.confirmMs !== undefined && { confirmMs: deps.confirmMs }),
          ...(deps.sleep !== undefined && { sleep: deps.sleep }),
          ...(deps.now !== undefined && { now: deps.now }),
          chainFor: (lookup) => chainOf(lookup, deps),
          key: async (lookup, agent, mayMake) => {
            const dir = await keysDir(deps.keysDir ?? KEYS_DIR, repoRoot, agent);
            if (await hasAgentKeyFile(dir, agent)) hold(held, await readAgentKeyFile(dir, agent));
            // The rule of which key is attached is `@tender/client`'s, shared with agent:connect.
            return agentKeyFor({
              dir,
              name: agent,
              network: lookup.network,
              account: lookup.account_id,
              mayMake,
            }).catch((error: unknown) => {
              if (error instanceof KeyInUseError) throw new ToolError("KEY_IN_USE", error.message);
              return keyDirFault(error);
            });
          },
          register: async (lookup, agent) => {
            const dir = await keysDir(deps.keysDir ?? KEYS_DIR, repoRoot, agent);
            const file = await readAgentKeyFile(dir, agent);
            hold(held, file);
            const signer = { accountId: lookup.account_id, privateKey: file.privateKey };
            const client =
              deps.clientFor?.(signer) ??
              new TenderClient({
                network: lookup.network,
                contractId: lookup.contract,
                rpcUrl: deps.rpcUrl,
                signer,
              });
            // The vault holds the bond by now, so all that may move is NEAR into the storage
            // balance; a vault that is short would have the agent's own tokens moved, and is not
            // approved.
            await registerWithBond(client, scriptedProfile(agent), {
              approve: (plan) => plan.shortfall === 0n,
            });
          },
        });
        const agentName = name ?? outcome.accountId.split(".")[0] ?? "";
        return jsonResult({
          status: outcome.status,
          account: outcome.accountId,
          owner: outcome.owner,
          fingerprint: outcome.fingerprint,
          key_file: outcome.keyPath,
          ...(outcome.confirmed !== null && { confirmed_by_api: outcome.confirmed }),
          progress,
          next: nextStep(outcome, agentName),
        });
      } catch (error) {
        const failure =
          error instanceof ConnectError
            ? new ToolError("CONNECT_STOPPED", error.message)
            : error instanceof KeyDirError
              ? new ToolError("KEY_DIR", error.message)
              : error;
        const result = errorResult(failure, [...secrets, ...held]);
        // What it did before it stopped helps the agent say what happened.
        if (progress.length > 0) {
          result.content.push({ type: "text", text: `progress:\n${progress.join("\n")}` });
        }
        return result;
      }
    },
  );
}

/** The private key of `file`, and its body alone, among what the answer must not hold. */
function hold(held: string[], file: AgentKeyFile): void {
  const body = file.privateKey.slice(file.privateKey.indexOf(":") + 1);
  held.push(file.privateKey, body);
}

function keyDirFault(error: unknown): never {
  throw error instanceof KeyDirError ? new ToolError("KEY_DIR", error.message) : error;
}

/** The key directory, past the guard. */
function keysDir(dir: string, repoRoot: string, name: string): Promise<string> {
  return keyDirOf(dir, repoRoot, name).catch(keyDirFault);
}

/** The chain of the code, which must be this server's: another network or contract is refused. */
function chainOf(lookup: ConnectLookup, deps: ConnectToolDeps): ConnectChain {
  if (lookup.network !== deps.network || lookup.contract !== deps.contractId) {
    throw new ToolError(
      "WRONG_DEPLOYMENT",
      `this code is for the contract ${lookup.contract} on ${lookup.network}, and this server is ` +
        `set for ${deps.contractId} on ${deps.network}. Nothing was made or sent`,
    );
  }
  const reader = new TenderClient({
    network: deps.network,
    contractId: deps.contractId,
    rpcUrl: deps.rpcUrl,
  });
  return {
    keyState: rpcKeyState(deps.rpcUrl),
    plan: (account) => planRegistration(reader, account),
    fullAccessKeys: rpcFullAccessKeys(deps.rpcUrl),
  };
}
