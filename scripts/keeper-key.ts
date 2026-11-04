import { parseArgs } from "node:util";
import { type Signer, TenderClient, TenderError, toTxResult } from "@tender/client";
import { AccountIdSchema, NETWORKS, type NetworkId } from "@tender/shared";
import {
  Account,
  actions,
  JsonRpcProvider,
  KeyPair,
  type KeyPairString,
  PublicKey,
} from "near-api-js";
import { DeployEnv, type EnvWriter, type Outcome, parseKey, UsageError } from "./deploy";
import { envDir, loadEnv } from "./lib/env";

/**
 * The key script. A service that signs for the keeper, the judge or an agent does not hold that
 * account's full-access key, which can do anything with it, down to deleting it. It holds a
 * function-call key the owner adds with this script: limited to Tender, to the methods the role
 * calls, and with no cap on its allowance, since a key that runs out of allowance stops a service
 * in the middle of its work (rulings P02-R27, X-7).
 *
 *   keeper   void_task, cleanup
 *   judge    pick, pick_attested
 *   agent    commit, reveal
 *
 * The agent role takes the agent's name, `--agent analyst` for instance, and works on the account
 * the deploy made for it: its variables are `AGENT_<NAME>_ACCOUNT` and so on, in capitals. The
 * reference agents are analyst, coder and extractor, and the deploy makes a lead as well.
 *
 * For a role the script reads `<ROLE>_ACCOUNT` and `<ROLE>_FULL_ACCESS_KEY`, which the deploy wrote
 * to `.env.deploy.<network>` (`<ROLE>` is KEEPER, JUDGE or AGENT_<NAME>), signs with that key, and
 * adds the new one to the account. It prints `OK add <role> key <public key> to <account>` when it
 * did (for an agent the role reads `agent analyst`), and `SKIP add ... (exists)` when the key was
 * there already, and nothing else. The private key is never printed, anywhere: it goes to the same
 * file as `<ROLE>_PRIVATE_KEY`, which is what the service reads.
 *
 * The file is written the way the deploy writes it: mode 0600, the key appended and synced to disk
 * and read back before the chain is asked to take it, so that a key is never lost to a crash, and
 * the chain is never given one the file cannot hand back. A run is safe to repeat. A
 * `<ROLE>_PRIVATE_KEY` that is in the environment already is used, never replaced:
 *
 *   on the chain with the permission above    SKIP
 *   not on the chain (the run stopped there)  that same key is added, and no other is made
 *   on the chain with another permission      an error: the script will not widen or narrow a key
 *
 * The error tells the owner to take a function-call key off the account along with the variable.
 * For any other key, a full-access one above all, it tells them to remove the variable alone and
 * never to delete the key: an account without a full-access key is locked for good, and the deploy
 * made one (`<ROLE>_FULL_ACCESS_KEY`, which a service must never hold) for each account.
 *
 * A `<ROLE>_PRIVATE_KEY` that is the same key as any other full-access key in the env files, the
 * `*_FULL_ACCESS_KEY` of another account or the contract's, or `DEPLOY_PARENT_PRIVATE_KEY`, is
 * refused before the chain is asked anything: the variable was filled in with the wrong key, and
 * adding it would give the service a secret with full access to another account. The error names
 * both variables, and the owner removes the variable alone.
 *
 * The variable is read from `.env` and the network's file, the network's winning, as the services
 * read it. A value in `.env` is the owner's, so it is used as it is and nothing is written.
 *
 * The mainnet keys belong to plan 07. Mainnet is refused by name, and also when the node answers
 * with the chain id `mainnet`, whatever the target calls it.
 *
 *   pnpm exec tsx scripts/keeper-key.ts --network testnet [--role keeper|judge]
 *   pnpm exec tsx scripts/keeper-key.ts --network testnet --role agent --agent <name>
 */

export type Role = "keeper" | "judge" | "agent";

/** What a role's key is for, and where its variables are. */
interface RoleSpec {
  /** The variables are `<stem>_ACCOUNT`, `<stem>_FULL_ACCESS_KEY` and `<stem>_PRIVATE_KEY`. */
  stem: string;
  /** The methods the key may call, and no others. */
  methods: readonly string[];
  /** What the script calls the role in the line it prints. */
  label: string;
}

const FIXED_ROLES: Readonly<Record<"keeper" | "judge", RoleSpec>> = {
  keeper: { stem: "KEEPER", methods: ["void_task", "cleanup"], label: "keeper" },
  judge: { stem: "JUDGE", methods: ["pick", "pick_attested"], label: "judge" },
};

/** The methods this script lets the key of `role` call, which `pnpm serve` checks a key for. */
export const roleMethods = (role: "keeper" | "judge"): readonly string[] =>
  FIXED_ROLES[role].methods;

/** An agent enters tasks and nothing else: it commits to an answer and later reveals it. */
const AGENT_METHODS: readonly string[] = ["commit", "reveal"];

/** An agent's name as the deploy makes it: the label of its sub-account, and the stem's tail. */
const AGENT_NAME = /^[a-z][a-z0-9]{0,19}$/;

const isRole = (value: string): value is Role =>
  value === "agent" || Object.hasOwn(FIXED_ROLES, value);

/**
 * The spec of `role`, for the agent called `agent` when the role is `agent`. Throws, without showing
 * the name, if an agent role has no name or a name that is no agent's, or if another role has one.
 * The name becomes part of variable names, so only the form of the deploy's agents is let through.
 */
function specOf(role: Role, agent: string | undefined): RoleSpec {
  if (role !== "agent") {
    if (agent !== undefined) throw new Error("--agent goes with --role agent only");
    return FIXED_ROLES[role];
  }
  if (agent === undefined)
    throw new Error("the agent role needs the name of an agent: --agent <name>");
  if (!AGENT_NAME.test(agent)) {
    throw new Error(
      "--agent must be a name of lowercase letters and digits that starts with a letter, 20 at " +
        "most (its value is not shown)",
    );
  }
  return { stem: `AGENT_${agent.toUpperCase()}`, methods: AGENT_METHODS, label: `agent ${agent}` };
}

/** How the env file names this script: in the header of a file it makes, and in what it says to run. */
const WRITER: EnvWriter = { script: "scripts/keeper-key.ts", rerun: "this script" };

const MAINNET_REFUSED =
  "mainnet is not handled by this script: plan 07 owns the mainnet keys, which need the owner's approval";

/**
 * What is said when a value is no account id. The value is never in it: it may be a private key that
 * landed in the wrong variable, and what is printed ends up in logs.
 */
const notAccountId = (what: string) =>
  `${what} is not a valid NEAR account id (its value is not shown, since a private key may have ` +
  "been put there)";

/** An access key's permission, as the node reports it. The two variants this script tells apart. */
export type ChainPermission =
  | "FullAccess"
  | {
      FunctionCall: {
        receiver_id: string;
        method_names: readonly string[];
        /** Absent or null for a key with no cap. */
        allowance?: string | null;
      };
    };

/** What the script asks of the chain. A fake one stands in for it in tests. */
export interface KeyChain {
  /** The chain id the node reports: `testnet`, `mainnet`, `localnet`... */
  chainId(): Promise<string>;
  /** The key's permission as of the last final block, or null if the account has no such key. */
  viewAccessKey(
    accountId: string,
    publicKey: string,
  ): Promise<{ permission: ChainPermission } | null>;
  /**
   * Adds a function-call key limited to `contractId` and `methods`, with no cap on its allowance, to
   * the signer's account, signed by the signer, and returns once it is final. Throws if the chain
   * refuses.
   */
  addFunctionCallKey(args: {
    signer: Signer;
    publicKey: string;
    contractId: string;
    methods: readonly string[];
  }): Promise<void>;
}

/** The chain and contract to add keys for. */
export interface KeyTarget {
  network: NetworkId;
  rpcUrl: string;
  /** Tender's account: the one receiver the key is limited to. */
  contractId: string;
}

export interface AddKeyOptions {
  /** The agent's name, for the agent role (`analyst`) and for no other role. */
  agent?: string;
  /** Where `.env` and `.env.deploy.<network>` are. The repository root by default, or what `TENDER_ENV_DIR` names. */
  dir?: string;
  /** Receives the `OK` or `SKIP` line, and nothing else. Default: `console.log`. */
  log?: (line: string) => void;
  /** The chain to ask. Default: the node at `target.rpcUrl`. */
  chain?: KeyChain;
}

export interface KeyResult {
  outcome: Outcome;
  accountId: string;
  /** The key's public half, as `ed25519:<base58>`. */
  publicKey: string;
}

/** The chain, through near-api-js. */
class NearChain implements KeyChain {
  private readonly provider: JsonRpcProvider;
  private readonly reader: TenderClient;

  constructor(target: KeyTarget) {
    this.provider = new JsonRpcProvider({ url: target.rpcUrl });
    this.reader = new TenderClient({
      network: target.network,
      contractId: target.contractId,
      rpcUrl: target.rpcUrl,
    });
  }

  async chainId(): Promise<string> {
    return String((await this.provider.viewNodeStatus()).chain_id);
  }

  viewAccessKey(accountId: string, publicKey: string) {
    return this.reader.viewAccessKey(accountId, publicKey);
  }

  async addFunctionCallKey(args: Parameters<KeyChain["addFunctionCallKey"]>[0]): Promise<void> {
    const { signer, publicKey, contractId, methods } = args;
    const account = new Account(
      signer.accountId,
      this.provider,
      signer.privateKey as KeyPairString,
    );
    const resp = await account.signAndSendTransaction({
      receiverId: signer.accountId,
      // No allowance: the key may spend as much gas as the account has, which is what a service
      // that runs for months needs. It can call only these methods, and attach no deposit.
      actions: [
        actions.addFunctionCallAccessKey(PublicKey.from(publicKey), contractId, [...methods]),
      ],
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
    toTxResult(resp, contractId);
  }
}

type FunctionCallPermission = Extract<ChainPermission, { FunctionCall: unknown }>;

function isFunctionCall(permission: ChainPermission): permission is FunctionCallPermission {
  return typeof permission === "object" && permission !== null && "FunctionCall" in permission;
}

/** The sentence for a key's permission, in the terms of this script. */
function describePermission(permission: ChainPermission): string {
  if (permission === "FullAccess") return "a full-access key";
  if (isFunctionCall(permission)) {
    const { receiver_id: receiver, method_names: methods, allowance } = permission.FunctionCall;
    const cap =
      allowance === null || allowance === undefined ? "unlimited allowance" : "an allowance";
    // On NEAR a key with no methods listed may call any of them.
    const calls = methods.length === 0 ? "any method" : methods.join(", ");
    return `a function-call key to ${receiver} for ${calls} with ${cap}`;
  }
  return "a key of another kind";
}

/**
 * What is said of a stored service key that is on the chain with a permission the script does not
 * add, and the advice for the owner. A function-call key comes off the account without a loss. Any
 * other kind may be the way into the account: an account whose last full-access key is deleted is
 * locked for good, and the deploy made only one. So for those the owner is told to remove the
 * variable alone, and never to delete the key. `sameAsFullKey` is the mix-up that P02-R27 is about,
 * the deploy's own full-access key put under the service's name.
 */
function refusedStoredKey(found: {
  keyVar: string;
  fullKeyVar: string;
  accountId: string;
  publicKey: string;
  permission: ChainPermission;
  sameAsFullKey: boolean;
  wanted: ChainPermission;
}): string {
  const { keyVar, fullKeyVar, accountId, publicKey, permission, sameAsFullKey, wanted } = found;
  const is = sameAsFullKey
    ? `the same key as ${fullKeyVar}: ${describePermission(permission)}`
    : describePermission(permission);
  const head = `${keyVar} holds ${publicKey}, which is ${is} on ${accountId}, not ${describePermission(wanted)}.`;
  if (isFunctionCall(permission) && !sameAsFullKey) {
    return (
      `${head} This script does not change a key: remove that key from the account and the ` +
      `${keyVar} line from the env file, and run it again.`
    );
  }
  let why = "this script cannot tell what it is for";
  if (permission === "FullAccess") why = "an account without a full-access key is locked for good";
  else if (sameAsFullKey) why = `${fullKeyVar} names it`;
  return (
    `${head} A service must hold a function-call key. Remove only the ${keyVar} line from the ` +
    `env file, and run this script again to make one. Do not delete the key from the account: ${why}.`
  );
}

/** Whether the permission is the one the script adds: to `contractId`, for exactly `methods`. */
function isWanted(
  permission: ChainPermission,
  contractId: string,
  methods: readonly string[],
): boolean {
  if (!isFunctionCall(permission)) return false;
  const { receiver_id: receiver, method_names: names, allowance } = permission.FunctionCall;
  if (receiver !== contractId || (allowance !== null && allowance !== undefined)) return false;
  const have = [...new Set(names)].sort();
  const want = [...methods].sort();
  return have.length === want.length && have.every((name, i) => name === want[i]);
}

/** The variable of the owner's parent account key, which the deploy reads from `.env`. */
const PARENT_KEY_VARIABLE = "DEPLOY_PARENT_PRIVATE_KEY";

/** Whether the variable holds a full-access key: one of the deploy's, the contract's among them. */
const isFullAccessVariable = (name: string) =>
  name.endsWith("_FULL_ACCESS_KEY") || name === PARENT_KEY_VARIABLE;

/**
 * The first variable, by name and other than `except`, that holds a full-access key whose public
 * half is `publicKey`. A value that is no key is passed over, and never shown.
 */
function holderOfFullAccessKey(
  env: Record<string, string>,
  publicKey: string,
  except: string,
): string | undefined {
  return Object.keys(env)
    .filter((name) => name !== except && isFullAccessVariable(name))
    .sort()
    .find((name) => {
      try {
        const key = KeyPair.fromString((env[name] ?? "").trim() as KeyPairString);
        return key.getPublicKey().toString() === publicKey;
      } catch {
        return false;
      }
    });
}

/** Throws, without showing it, unless `contractId` is an account id. */
function checkContract(contractId: string, what: string): void {
  if (!AccountIdSchema.safeParse(contractId).success) throw new Error(notAccountId(what));
}

/**
 * Adds the role's function-call key to its account and returns what was done; see the top of this
 * file for the rules. Throws, before anything is written or sent, if the target is mainnet, if the
 * role is `agent` and `options.agent` is no agent's name (or another role has one), if the
 * contract or the role's account is no account id, if a key in the env file is no key, if
 * `<ROLE>_PRIVATE_KEY` is the same key as another full-access key of the env files, if the node
 * is on mainnet (or, for a testnet target, on any chain but testnet), or if `<ROLE>_PRIVATE_KEY` is
 * on the chain with another permission. Throws, before a new key is made, if
 * `<ROLE>_FULL_ACCESS_KEY` is not a full-access key of the account. No message shows a private key
 * or the value of a variable.
 */
export async function addRoleKey(
  role: Role,
  target: KeyTarget,
  options: AddKeyOptions = {},
): Promise<KeyResult> {
  const { network, contractId } = target;
  if (network === "mainnet") throw new Error(MAINNET_REFUSED);
  const { stem, methods, label } = specOf(role, options.agent);
  const dir = options.dir ?? envDir();
  const log = options.log ?? console.log;
  const accountVar = `${stem}_ACCOUNT`;
  const fullKeyVar = `${stem}_FULL_ACCESS_KEY`;
  const keyVar = `${stem}_PRIVATE_KEY`;

  // The env file is opened first, and made private, whatever else turns out to be wrong.
  const file = await DeployEnv.open(dir, network, WRITER);
  checkContract(contractId, "the contract");
  const env = loadEnv(network, { dir, required: [accountVar, fullKeyVar] });
  const accountId = (env[accountVar] ?? "").trim();
  if (!AccountIdSchema.safeParse(accountId).success) throw new Error(notAccountId(accountVar));
  const fullKey = parseKey((env[fullKeyVar] ?? "").trim(), fullKeyVar);
  // The key a service signs with, from `.env` or the network's file. Blank is none: `.env.example`
  // has the variable, empty, for the owner to fill in.
  const storedValue = (env[keyVar] ?? "").trim();
  const stored = storedValue === "" ? undefined : parseKey(storedValue, keyVar);
  if (stored !== undefined) {
    // The service key is a function-call key of the role's own account. If it is a full-access key
    // that the env files hold, the variable was filled in with the wrong key (P02-R27), and the
    // script would add it to this account: the service would sign with a secret that has full access
    // to another one. The role's own full-access key is left to the check against the chain below.
    const publicKey = stored.getPublicKey().toString();
    const holder = holderOfFullAccessKey(env, publicKey, fullKeyVar);
    if (holder !== undefined) {
      throw new Error(
        `${keyVar} holds ${publicKey}, which is the same key as ${holder}, a full-access key. A ` +
          "service must hold a function-call key of its own, so this script will not add that one. " +
          `Remove only the ${keyVar} line from the env file, and run this script again to make ` +
          "one. Do not delete any key from an account.",
      );
    }
  }

  const chain = options.chain ?? new NearChain(target);
  // The network is a label the caller chose; the chain id is what the node says it is.
  const chainId = await chain.chainId();
  if (chainId === "mainnet") {
    throw new Error(`${MAINNET_REFUSED} (the node answered with chain id "mainnet")`);
  }
  if (network === "testnet" && chainId !== "testnet") {
    throw new Error(
      `the target is testnet, but the node answered with chain id ${JSON.stringify(String(chainId).slice(0, 40))}`,
    );
  }

  if (stored !== undefined) {
    const publicKey = stored.getPublicKey().toString();
    const onChain = await chain.viewAccessKey(accountId, publicKey);
    if (onChain !== null) {
      if (!isWanted(onChain.permission, contractId, methods)) {
        throw new Error(
          refusedStoredKey({
            keyVar,
            fullKeyVar,
            accountId,
            publicKey,
            permission: onChain.permission,
            sameAsFullKey: publicKey === fullKey.getPublicKey().toString(),
            wanted: { FunctionCall: { receiver_id: contractId, method_names: methods } },
          }),
        );
      }
      log(`SKIP add ${label} key ${publicKey} to ${accountId} (exists)`);
      return { outcome: "SKIP", accountId, publicKey };
    }
  }

  // The account's full-access key signs the addition, so it must be one.
  const full = await chain.viewAccessKey(accountId, fullKey.getPublicKey().toString());
  if (full === null) {
    throw new Error(`${fullKeyVar} is not a key of ${accountId}: is the account or the key wrong?`);
  }
  if (full.permission !== "FullAccess") {
    throw new Error(
      `${fullKeyVar} is a function-call key of ${accountId}; adding a key needs a full-access key`,
    );
  }

  // A new key is on disk, and read back, before the chain hears of it. One from an earlier run that
  // stopped before the chain took it is used again, and nothing is written.
  let key = stored;
  if (key === undefined) {
    key = parseKey(KeyPair.fromRandom("ed25519").toString(), keyVar);
    await file.add([[keyVar, key.toString()]]);
  }
  const publicKey = key.getPublicKey().toString();
  await chain.addFunctionCallKey({
    signer: { accountId, privateKey: fullKey.toString() },
    publicKey,
    contractId,
    methods,
  });
  log(`OK add ${label} key ${publicKey} to ${accountId}`);
  return { outcome: "OK", accountId, publicKey };
}

// The command line.

const USAGE =
  "usage: pnpm exec tsx scripts/keeper-key.ts --network testnet " +
  "[--role keeper|judge | --role agent --agent <name>]";

/**
 * The target for `network` from the command line: for testnet, the network's RPC URL and the
 * contract named by `TENDER_CONTRACT` in `.env` or `.env.deploy.testnet` of `dir`. Throws a
 * `UsageError` for every other network, and for a contract that is no account id (without showing
 * it). It reads no more than those two files and uses no network.
 */
export function loadTarget(network: string | undefined, options: { dir?: string } = {}): KeyTarget {
  if (network === undefined) throw new UsageError(USAGE);
  if (network === "mainnet") throw new UsageError(MAINNET_REFUSED);
  if (network === "sandbox") {
    throw new UsageError(
      "the sandbox is for tests, which start the chain and pass its RPC URL to addRoleKey(); the " +
        `command line adds keys on testnet.\n${USAGE}`,
    );
  }
  if (network !== "testnet") {
    throw new UsageError(`unknown network ${JSON.stringify(network)}\n${USAGE}`);
  }
  const env = loadEnv("testnet", { dir: options.dir, required: ["TENDER_CONTRACT"] });
  const contractId = env.TENDER_CONTRACT.trim();
  if (!AccountIdSchema.safeParse(contractId).success) {
    throw new UsageError(notAccountId("TENDER_CONTRACT"));
  }
  return { network: "testnet", rpcUrl: NETWORKS.testnet.rpcUrl, contractId };
}

/** What the command line prints on a failure: the code and the transaction of a `TenderError`. */
export function describeFailure(error: unknown): string {
  if (error instanceof TenderError) {
    const tx = error.txHash === undefined ? "" : `\ntransaction ${error.txHash}`;
    return `keeper-key failed with ${error.code}\n${error.message}${tx}`;
  }
  return `keeper-key failed: ${error instanceof Error ? error.message : String(error)}`;
}

export interface CliOptions {
  /** Where the env files are. The repository root by default, or what `TENDER_ENV_DIR` names. */
  dir?: string;
  /** Receives the script's lines. Defaults to `console.log`. */
  out?: (line: string) => void;
  /** Receives what is said about a failure. Defaults to `console.error`. */
  err?: (text: string) => void;
  /** The function to run; the real one by default. */
  addKey?: typeof addRoleKey;
}

/** Runs the command line and returns the exit code: 0 after the key is added or found, else 1. */
export async function main(args: readonly string[], options: CliOptions = {}): Promise<number> {
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  try {
    let values: { network?: string; role?: string; agent?: string };
    try {
      values = parseArgs({
        args: [...args],
        options: {
          network: { type: "string" },
          role: { type: "string" },
          agent: { type: "string" },
        },
      }).values;
    } catch (error) {
      throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    }
    const role = values.role ?? "keeper";
    if (!isRole(role)) {
      throw new UsageError(
        `unknown role ${JSON.stringify(role)}: use keeper or judge (or agent, with --agent <name>)\n${USAGE}`,
      );
    }
    try {
      // The rules for the agent's name are the function's own: asked now, the command line fails
      // with the usage before it reads a file.
      specOf(role, values.agent);
    } catch (error) {
      throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    }
    const target = loadTarget(values.network, options);
    await (options.addKey ?? addRoleKey)(role, target, {
      dir: options.dir,
      log: out,
      ...(values.agent !== undefined && { agent: values.agent }),
    });
    return 0;
  } catch (error) {
    err(error instanceof UsageError ? error.message : describeFailure(error));
    return 1;
  }
}

// Only when run as the script, never when a test or another script imports from here.
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
