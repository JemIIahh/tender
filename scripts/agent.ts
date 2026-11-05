import "./lib/node-check";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  AGENT_NAME,
  type AgentKeyFile,
  type AgentProfile,
  ApiClient,
  agentKeyFor,
  agentKeyPath,
  type ConnectApi,
  type ConnectChain,
  ConnectError,
  type ConnectOutcome,
  connectAgent,
  DELEGATE_SUFFIX,
  fetchNamingApi,
  KeyDirError,
  KeyInUseError,
  type KeyPermission,
  keyDirOf,
  makeAgentKeyFile,
  moveAgentKeyToImplicit,
  planRegistration,
  prepareKeyDir,
  type RegistrationPlan,
  readAgentKeyFile,
  registerWithBond,
  rpcAccountExists,
  rpcFullAccessKeys,
  rpcKeyState,
  type Signer,
  scriptedProfile,
  TenderClient,
  TenderError,
  toTxResult,
  writeKeyFile,
} from "@tender/client";
import {
  AccountIdSchema,
  type AgentView,
  type ConnectLookup,
  canonicalBase,
  type DelegateView,
  DelegateViewSchema,
  formatTokenAmount,
  NETWORKS,
  type NetworkId,
  ProfileSchema,
  parseTokenAmount,
  tokenMeta,
} from "@tender/shared";
import {
  Account,
  actions,
  formatNearAmount,
  JsonRpcProvider,
  KeyPair,
  type KeyPairString,
  PublicKey,
} from "near-api-js";
import { readDeployment, UsageError } from "./deploy";
import { envDir, REPO_ROOT, readEnvFile } from "./lib/env";

/**
 * The agent commands. An agent is a NEAR account that has put up a refundable bond with Tender
 * (contract Task 16b); only a registered agent whose bond is held may enter an open task. These
 * commands take an account through its life:
 *
 *   pnpm agent:init --name <name>     makes the agent's key, on this machine, and prints its PUBLIC half
 *   pnpm agent:register               puts the bond in the vault if it is short, registers, prints the status
 *   pnpm agent:retire                 starts the way out: no new open task, the bond claimable after a cooldown
 *   pnpm agent:claim-bond             once the cooldown is over, the bond goes back to the vault
 *
 * or all of the first two at once, with a connect code from the owner's "Add an agent" page:
 *
 *   pnpm agent:connect <code> --api <url>   makes the key, attaches its PUBLIC half to the code,
 *                                           waits for the owner's wallet to create and fund the
 *                                           account, then registers: see "CONNECT"
 *
 * and these two give the agent a key that may spend, within caps, without being the account's own:
 *
 *   pnpm agent:delegate --per-task <amount> --total <amount>   a delegate key: see "THE DELEGATE KEY"
 *   pnpm agent:undelegate             takes its caps back and deletes the key from the account
 *
 * THE KEY. `init` makes an ed25519 key and writes it to the agent's own file, `<name>.json` in
 * `.tender/agents/` of the repository (git-ignored), mode 0600 in a directory of mode 0700. The
 * private key is in that file and nowhere else: no command prints it, logs it or puts it in an error,
 * and a file that others on the machine can read is refused. `init` never replaces a file. The line
 * to look for is `public key: ed25519:...`: it is what the NEAR account is created with, or what is
 * added to an account as a full-access key.
 *
 * WHICH KEY. Registering, retiring and claiming take exactly 1 yoctoNEAR, which only a full-access
 * key can attach. A function-call key, a delegate key (which commits and reveals for an agent) among
 * them, is refused before anything is sent. So the file holds a full-access key of the agent's own
 * account; a service that only commits and reveals gets a function-call key from `keeper-key`.
 *
 * THE ACCOUNT. `--account <id>` on `init` or `register`, else the file's, else asked for. `register`
 * writes it into the file once the chain has taken the registration, so that the other commands
 * need no flag.
 *
 * THE BOND. The owner sets a token and an amount; `register` takes the amount out of the agent's
 * vault. If the vault is short, the missing token moves from the agent's wallet (and NEAR into its
 * storage balance, if that is short) first, and only after the command has said how much and been
 * answered yes, or was given `--yes`. Without a terminal and without `--yes` the answer is no, and
 * nothing moves.
 *
 * THE DELEGATE KEY. `delegate` makes a second key for the same account, a function-call key that
 * may call only `post_task`, `top_up_task`, `commit` and `reveal` on the Tender contract (never
 * `pick`, `withdraw` or `add_delegate`), with a finite allowance for gas (0.25 NEAR unless
 * `--allowance` says another), and registers it with `add_delegate` for the caps `--per-task` (per
 * call) and `--total` (in all), in `--token`'s units. It signs with the agent's full-access key,
 * from the key file. The new key's file is `<name>.delegate.json` beside it: mode 0600, git-ignored
 * like it (the same key-directory guard), private key never printed. The key is saved before the
 * chain is asked to take it, so a run that stops half way is finished by running the command
 * again. `undelegate` is its undoing: `remove_delegate` (the caps, which are the money), then
 * DeleteKey (the key), and only when the chain shows both gone is the file removed. Before its first
 * chain step `undelegate` marks the file (`"revoking": true`), and `delegate` refuses a marked file:
 * a run of `undelegate` that stopped after `remove_delegate` is finished by running it again, and
 * is never mistaken for a `delegate` that stopped, which would give the key new caps with nothing
 * spent. A function-call key that leaks costs at most its caps and its allowance; keep little
 * liquid NEAR on the account.
 *
 * CONNECT. `connect` is `connectAgent` of `@tender/client`, with this file's key and register. The
 * code says which account the agent gets (`<name>.<owner>`, or the implicit account of the agent's
 * key once the owner chose that on the page), on which network and contract; the key is `init`'s, in
 * the same file and directory under the same guard, named by `--name` or else by the code's own
 * name, and is used again if it is there for that account, so a run that stopped (the owner was
 * away) is finished by running the same command again. When the code's record says the owner chose
 * the implicit account, the key file is moved to it (`moveAgentKeyToImplicit`): only a file made for
 * this code's `<name>.<owner>`, only to its own key's implicit account, and only while the chain has
 * no `<name>.<owner>`; otherwise the command stops and the file is left as it was. It prints the
 * key's fingerprint, which the owner's page shows too: the owner matches the two before the wallet
 * signs anything. Once the account exists with the key and its
 * vault holds the bond (the owner's batch pays both), it is `register` with `--yes`: the only thing
 * left to move is NEAR into the storage balance, from the NEAR the owner sent the account. `--api`
 * is the address of the API that made the code (`TENDER_API_URL` when it is not given): https, or
 * http to this machine only, as the code is a credential. `--wait` is how many minutes to wait for
 * the owner (30 by default).
 *
 * WHERE. `--network` (else `TENDER_NETWORK` in the environment or `.env`, else testnet), the contract
 * from `TENDER_CONTRACT` or the network's record in `deployments/`, the node from `NEAR_RPC_URL` or
 * the network's own. The deploy's `.env.deploy.<network>`, which holds other accounts' keys, is not
 * read.
 */

const USAGE = `usage:
  pnpm agent:init --name <name> [--account <id>] [--network <n>] [--dir <path>]
  pnpm agent:register [--name <name>] [--account <id>] [--network <n>] [--yes]
                      [--tags a,b] [--description <text>] [--uri <uri>] [--dir <path>]
  pnpm agent:retire [--name <name>] [--network <n>] [--yes] [--dir <path>]
  pnpm agent:claim-bond [--name <name>] [--network <n>] [--dir <path>]
  pnpm agent:delegate --per-task <amount> --total <amount> [--name <name>] [--token <id>]
                      [--allowance <NEAR>] [--network <n>] [--dir <path>]
  pnpm agent:undelegate [--name <name>] [--network <n>] [--dir <path>]
  pnpm agent:connect <code> [--api <url>] [--name <name>] [--network <n>] [--wait <minutes>]
                     [--tags a,b] [--description <text>] [--dir <path>]`;

/** An agent's name: the key file's name, and the name in its profile (`@tender/client`'s). */
const NAME = AGENT_NAME;

/** Where the keys go: git-ignored (`.gitignore` has `.tender/`), so no key lands in a commit. */
const KEYS_DIR = join(REPO_ROOT, ".tender", "agents");

// ---- The key file -----------------------------------------------------------------------------

// The key file and the key-directory guard are `@tender/client`'s (`keyfile.ts`), so that the MCP
// server's `connect_to_tender` makes a key exactly as `init` does, in the same directory.

/** What a key file holds. `account` is absent until the agent's account is known. */
type KeyFile = AgentKeyFile;

const isNetwork = (value: string): value is NetworkId => Object.hasOwn(NETWORKS, value);

function nameOf(value: string | undefined): string {
  if (value === undefined || !NAME.test(value)) {
    throw new UsageError(
      `--name must be lowercase letters, digits and dashes, starting with a letter, 32 at most\n${USAGE}`,
    );
  }
  return value;
}

/** A refusal of the key directory, as a fault of the flags: printed without "agent failed". */
function asUsage(error: unknown): never {
  throw error instanceof KeyDirError ? new UsageError(error.message) : error;
}

/**
 * The directory the keys are in, with its symlinks followed, once the key-directory guard has
 * passed it: `--dir`, else `.tender/agents/` of the repository. `name` is the agent whose file
 * will be in it, when it is known.
 */
async function keysDirOf(dir: string | undefined, name = "agent"): Promise<string> {
  return keyDirOf(dir ?? KEYS_DIR, REPO_ROOT, name).catch(asUsage);
}

const fileOf = agentKeyPath;

/**
 * The key file of `name`. Throws, without the key, if it is missing, readable by others, not a key
 * file, or if its private key is not the one its public key says.
 */
const readKeyFile = readAgentKeyFile;

/** The agent to act for: `--name`, else the only key in the directory. */
async function pickName(dir: string, wanted: string | undefined): Promise<string> {
  if (wanted !== undefined) return nameOf(wanted);
  let names: string[] = [];
  try {
    names = (await readdir(dir))
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length))
      .filter((name) => NAME.test(name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (names.length === 1 && names[0] !== undefined) return names[0];
  throw new UsageError(
    names.length === 0
      ? `there is no agent key in ${dir}: run pnpm agent:init --name <name>`
      : `there are ${names.length} agent keys (${names.join(", ")}): choose one with --name\n${USAGE}`,
  );
}

// ---- Init -------------------------------------------------------------------------------------

export interface InitOptions {
  name: string;
  network: NetworkId;
  /** The agent's account, if it exists already. */
  account?: string;
  /** The directory for keys. Default: `.tender/agents/` of the repository. */
  dir?: string;
  log?: (line: string) => void;
}

/** Makes the agent's key and writes it to its file. Prints the public key and nothing secret. */
export async function initAgent(
  options: InitOptions,
): Promise<{ path: string; publicKey: string }> {
  const log = options.log ?? console.log;
  const name = nameOf(options.name);
  const dir = await keysDirOf(options.dir, name);
  if (options.account !== undefined && !AccountIdSchema.safeParse(options.account).success) {
    throw new UsageError("--account is not a valid NEAR account id");
  }
  await prepareKeyDir(dir).catch(asUsage);
  const { path, publicKey } = await makeAgentKeyFile({
    dir,
    name,
    network: options.network,
    ...(options.account !== undefined && { account: options.account }),
  });
  log(`OK init agent ${name}`);
  log(`key file: ${path} (mode 600; the private key is in it and is never printed)`);
  log(`public key: ${publicKey}`);
  log(
    options.account === undefined
      ? `next: create a ${options.network} account with that public key as its full-access key, then run pnpm agent:register --name ${name} --account <that account>`
      : `next: make sure ${options.account} has that public key as a full-access key, then run pnpm agent:register --name ${name}`,
  );
  return { path, publicKey };
}

// ---- The chain --------------------------------------------------------------------------------

/** The chain and contract the commands act on. */
export interface AgentTarget {
  network: NetworkId;
  contractId: string;
  rpcUrl: string;
}

export interface Environment {
  /** The process environment by default; `.env` fills in what it lacks. */
  env?: Record<string, string | undefined>;
  /** Where `.env` and `deployments/` are. The repository root by default, or what `TENDER_ENV_DIR` names. */
  repoDir?: string;
}

/** Where to send things: the flag, else the environment, else `.env`, else the deploy's record. */
export async function resolveTarget(
  flag: string | undefined,
  fallbackNetwork: NetworkId | undefined,
  options: Environment = {},
): Promise<AgentTarget> {
  const own = definedOnly(options.env ?? process.env);
  const repoDir = options.repoDir ?? envDir(own);
  const env = { ...readEnvFile(join(repoDir, ".env")), ...own };
  const wanted = flag ?? fallbackNetwork ?? env.TENDER_NETWORK ?? "testnet";
  if (!isNetwork(wanted))
    throw new UsageError(`--network must be sandbox, testnet or mainnet\n${USAGE}`);
  const contractId = env.TENDER_CONTRACT ?? (await readDeployment(wanted, repoDir))?.contract;
  if (contractId === undefined || !AccountIdSchema.safeParse(contractId).success) {
    throw new Error(
      `no Tender contract for ${wanted}: set TENDER_CONTRACT, or deploy first so that ` +
        `deployments/${wanted}.json exists`,
    );
  }
  const rpcUrl = env.NEAR_RPC_URL ?? NETWORKS[wanted].rpcUrl;
  if (rpcUrl === "")
    throw new Error(`NEAR_RPC_URL must be set for ${wanted}: the RPC URL of the node`);
  return { network: wanted, contractId, rpcUrl };
}

function definedOnly(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** The client of `key` on `target`. A test passes its own to stand in for it. */
export type ClientFactory = (
  target: AgentTarget,
  key: { accountId: string; privateKey: string },
) => TenderClient;

const realClient: ClientFactory = (target, signer) =>
  new TenderClient({
    network: target.network,
    contractId: target.contractId,
    rpcUrl: target.rpcUrl,
    signer,
  });

// ---- The commands -----------------------------------------------------------------------------

export interface CommandOptions extends Environment {
  /** The agent's name; the only key in the directory when absent. */
  name?: string;
  network?: string;
  account?: string;
  /** Skip the question: yes. */
  yes?: boolean;
  tags?: string;
  description?: string;
  uri?: string;
  dir?: string;
  log?: (line: string) => void;
  /** Asks a yes/no question. The terminal by default; with none, the answer is no. */
  confirm?: (question: string) => Promise<boolean>;
  clientFor?: ClientFactory;
  /** The time, in ms, for the words about a date. */
  now?: () => number;
}

interface Loaded {
  key: KeyFile;
  account: string;
  target: AgentTarget;
  client: TenderClient;
  keyDir: string;
}

async function terminalConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function terminalAsk(question: string): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function load(options: CommandOptions, ask: boolean): Promise<Loaded> {
  const keyDir = await keysDirOf(options.dir, options.name);
  const name = await pickName(keyDir, options.name);
  const key = await readKeyFile(keyDir, name);
  const target = await resolveTarget(options.network, key.network, options);
  if (target.network !== key.network) {
    throw new Error(
      `the key of agent ${name} was made for ${key.network}, and this is ${target.network}: ` +
        "use the network it was made for, or make a key for this one",
    );
  }
  let account = options.account ?? key.account;
  if (account === undefined && ask) {
    account = await terminalAsk(`the NEAR account of agent ${name} on ${target.network}: `);
  }
  if (account === undefined || !AccountIdSchema.safeParse(account).success) {
    throw new UsageError(
      account === undefined
        ? `agent ${name} has no account yet: pass --account <id>\n${USAGE}`
        : "--account is not a valid NEAR account id",
    );
  }
  if (key.account !== undefined && key.account !== account) {
    throw new Error(
      `the key file of agent ${name} is for ${key.account}, not ${account}: ` +
        "make a key for the other account under another --name",
    );
  }
  const client = (options.clientFor ?? realClient)(target, {
    accountId: account,
    privateKey: key.privateKey,
  });
  return { key, account, target, client, keyDir };
}

/** A time in nanoseconds as a date, and how far from `nowMs` it is. */
function whenIs(ns: string, nowMs: number): string {
  const ms = Number(BigInt(ns) / 1_000_000n);
  const date = new Date(ms).toISOString();
  const left = ms - nowMs;
  if (left <= 0) return `${date} (now)`;
  const hours = Math.floor(left / 3_600_000);
  const days = Math.floor(hours / 24);
  return `${date} (in ${days > 0 ? `${days}d ${hours % 24}h` : `${hours}h ${Math.floor((left % 3_600_000) / 60_000)}m`})`;
}

/** The lines that say where an agent stands. Nothing secret is in them. */
function statusLines(account: string, agent: AgentView, nowMs: number): string[] {
  const lines = [`account: ${account}`, `status: ${agent.status}`];
  lines.push(
    agent.bond_token !== null && agent.bond_amount !== null
      ? `bond: ${agent.bond_amount} ${agent.bond_token}`
      : "bond: none held",
  );
  if (agent.claimable_at !== null) lines.push(`claimable at: ${whenIs(agent.claimable_at, nowMs)}`);
  // The commit deadline of the latest open task it entered: the bond cannot be claimed before it.
  if (agent.locked_until !== null) {
    lines.push(`held by an open task until: ${whenIs(agent.locked_until, nowMs)}`);
  }
  return lines;
}

/** What `register` is about to move, in words. */
function planLines(plan: RegistrationPlan): string[] {
  const lines = [`${plan.account} needs funds in place before it can register:`];
  if (plan.shortfall > 0n && plan.terms !== null) {
    lines.push(
      `  - ${plan.shortfall} ${plan.terms.token} from its wallet into its Tender vault ` +
        `(the bond is ${plan.terms.amount}; the vault holds ${plan.vault})`,
    );
  }
  if (plan.storageShortfall > 0n) {
    lines.push(
      `  - ${formatNearAmount(plan.storageShortfall.toString(), 5)} NEAR into its Tender storage balance`,
    );
  }
  return lines;
}

/**
 * Registers the agent: the bond into the vault if short (after a yes, or `--yes`), then
 * `register_agent` with 1 yoctoNEAR. Prints the status. Returns the agent as the chain shows it.
 */
export async function registerAgentCommand(options: CommandOptions): Promise<AgentView> {
  const log = options.log ?? console.log;
  const confirm = options.confirm ?? terminalConfirm;
  const { key, account, client, keyDir } = await load(options, true);

  // The profile is checked before the chain is asked anything, so that a bad tag cannot be found
  // out after the bond has moved.
  const tags = (options.tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  const made = scriptedProfile(key.name, tags, options.description ?? "");
  const checked = ProfileSchema.safeParse(made.document);
  if (!checked.success) {
    throw new UsageError(
      `the profile is not valid: ${checked.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  }
  const profile: AgentProfile = {
    uri: options.uri ?? made.uri,
    hash: made.hash,
    tags: made.tags,
  };
  if (options.uri !== undefined && (options.uri.length === 0 || options.uri.length > 256)) {
    throw new UsageError("--uri must be 1 to 256 characters");
  }

  const result = await registerWithBond(client, profile, {
    approve: async (plan) => {
      for (const line of planLines(plan)) log(line);
      if (options.yes === true) return true;
      return confirm("Move these funds and register? [y/N] ");
    },
  });

  // The chain has taken it: the account is the key's, so the file may say so.
  if (key.account === undefined) {
    await writeKeyFile(fileOf(keyDir, key.name), { ...key, account }, true);
  }
  log(`OK register ${account} as agent ${key.name}`);
  if (result.deposited > 0n) {
    log(
      `deposited: ${result.deposited} ${result.plan.terms?.token ?? ""} into the vault`.trimEnd(),
    );
  }
  log(`tx: ${result.tx.txHash}`);
  for (const line of statusLines(account, result.agent, (options.now ?? Date.now)())) log(line);
  return result.agent;
}

/** Starts the way out: no new open task, the bond claimable once the cooldown is over. */
export async function retireAgentCommand(options: CommandOptions): Promise<AgentView> {
  const log = options.log ?? console.log;
  const confirm = options.confirm ?? terminalConfirm;
  const nowMs = (options.now ?? Date.now)();
  const { key, account, client } = await load(options, false);

  const agent = await client.getAgent(account);
  if (agent === null || agent.status === "retired") {
    throw new TenderError(
      "E_NOT_REGISTERED",
      `${account} is not a registered agent${agent === null ? "" : " (it is retired)"}: nothing to retire`,
    );
  }
  if (agent.status === "unregistering") {
    for (const line of statusLines(account, agent, nowMs)) log(line);
    throw new TenderError(
      "E_PHASE",
      `${account} is unregistering already: claim the bond with pnpm agent:claim-bond once it is claimable`,
    );
  }
  const config = await client.getConfig();
  const cooldown = config.agent_bond_cooldown_secs;
  log(
    `${account} will stop being able to enter open tasks at once, and can claim its bond ` +
      `${cooldown} seconds after this. It cannot register again before it has claimed it.`,
  );
  // The key first, so that nobody is asked about something that cannot be sent.
  await client.requireFullAccessKey("unregister_agent");
  if (options.yes !== true && !(await confirm("Retire agent? [y/N] "))) {
    throw new Error("not retired: the answer was not yes (pass --yes to answer for it)");
  }
  const tx = await client.unregisterAgent();
  const after = await client.getAgent(account);
  if (after === null) throw new Error(`${account} is not an agent after unregistering`);
  log(`OK retire ${account} (agent ${key.name})`);
  log(`tx: ${tx.txHash}`);
  for (const line of statusLines(account, after, (options.now ?? Date.now)())) log(line);
  return after;
}

/** Takes the bond back into the vault, once the cooldown is over. */
export async function claimBondCommand(options: CommandOptions): Promise<AgentView> {
  const log = options.log ?? console.log;
  const nowMs = (options.now ?? Date.now)();
  const { key, account, client } = await load(options, false);

  const agent = await client.getAgent(account);
  if (agent === null || agent.status !== "unregistering") {
    throw new TenderError(
      agent === null ? "E_NOT_REGISTERED" : "E_PHASE",
      agent === null
        ? `${account} is not a registered agent`
        : `${account} is ${agent.status}: a bond is claimed after pnpm agent:retire, and not before`,
    );
  }
  await client.requireFullAccessKey("claim_agent_bond");
  let tx: Awaited<ReturnType<TenderClient["claimAgentBond"]>>;
  try {
    tx = await client.claimAgentBond();
  } catch (error) {
    if (error instanceof TenderError && error.code === "E_PHASE" && agent.claimable_at !== null) {
      throw new TenderError(
        "E_PHASE",
        `the bond of ${account} is claimable from ${whenIs(agent.claimable_at, nowMs)}`,
        error.txHash === undefined ? {} : { txHash: error.txHash },
      );
    }
    throw error;
  }
  const after = await client.getAgent(account);
  if (after === null) throw new Error(`${account} is not an agent after claiming`);
  log(`OK claim-bond ${account} (agent ${key.name})`);
  log(
    agent.bond_token !== null && agent.bond_amount !== null
      ? `returned: ${agent.bond_amount} ${agent.bond_token} to its vault (withdraw it from there)`
      : "returned: nothing (it registered before any bond was set)",
  );
  log(`tx: ${tx.txHash}`);
  for (const line of statusLines(account, after, (options.now ?? Date.now)())) log(line);
  return after;
}

// ---- The delegate key -------------------------------------------------------------------------

/**
 * The methods of a delegate key, and no others: it posts and tops up tasks (within its caps) and
 * enters them (`commit`, `reveal`). Never `pick`, which judges and which the contract refuses a
 * delegate key anyway, and nothing that moves money out (`withdraw`) or widens a key
 * (`add_delegate`). The list is exact on the chain: a key with another list is not this one.
 */
export const DELEGATE_METHODS: readonly string[] = ["post_task", "top_up_task", "commit", "reveal"];

/**
 * The gas a delegate key may burn before it stops, in NEAR, when `--allowance` says nothing. It is
 * always finite: a function-call key with no cap on its allowance can spend all of the account's
 * NEAR on fees, which the caps (they count tokens) do not bound.
 */
export const DEFAULT_ALLOWANCE = "0.25";

/** What a delegate key's file holds. The private key is in it and nowhere else. */
interface DelegateFile {
  version: 1;
  kind: "delegate";
  name: string;
  network: NetworkId;
  account: string;
  /** The Tender contract the key is limited to, and whose caps it has. */
  contract: string;
  publicKey: string;
  privateKey: string;
  /**
   * Set by `undelegate` before its first chain step and cleared only by deleting the file, once the
   * chain shows the key and its caps gone. A file in this state is a revoke that stopped half way:
   * `delegate` refuses it, because giving the key caps again would start it with nothing spent.
   */
  revoking?: true;
}

const delegateFileOf = (dir: string, name: string) => join(dir, `${name}${DELEGATE_SUFFIX}`);

/**
 * The delegate key file of `name`, or null if there is none. Throws, without the key, if it is
 * readable by others, not a delegate key file, or if its private key is not the one its public key
 * says.
 */
async function readDelegateFile(dir: string, name: string): Promise<DelegateFile | null> {
  const path = delegateFileOf(dir, name);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(
      `${path} can be read by other users of this machine: run chmod 600 on it first ` +
        "(and treat the key as exposed if others could have read it)",
    );
  }
  const bad = () => new Error(`${path} is not a delegate key file made by pnpm agent:delegate`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw bad();
  }
  if (typeof parsed !== "object" || parsed === null) throw bad();
  const f = parsed as Record<string, unknown>;
  if (
    f.version !== 1 ||
    f.kind !== "delegate" ||
    f.name !== name ||
    typeof f.network !== "string" ||
    !isNetwork(f.network) ||
    typeof f.account !== "string" ||
    !AccountIdSchema.safeParse(f.account).success ||
    typeof f.contract !== "string" ||
    !AccountIdSchema.safeParse(f.contract).success ||
    typeof f.publicKey !== "string" ||
    typeof f.privateKey !== "string" ||
    (f.revoking !== undefined && f.revoking !== true)
  ) {
    throw bad();
  }
  let derived: string;
  try {
    derived = KeyPair.fromString(f.privateKey as KeyPairString)
      .getPublicKey()
      .toString();
  } catch {
    throw bad();
  }
  if (derived !== f.publicKey) {
    throw new Error(`the private key in ${path} is not the one its public key names`);
  }
  return {
    version: 1,
    kind: "delegate",
    name,
    network: f.network,
    account: f.account,
    contract: f.contract,
    publicKey: f.publicKey,
    privateKey: f.privateKey,
    ...(f.revoking === true ? { revoking: true as const } : {}),
  };
}

/** What the commands write to the chain besides Tender's own calls: access keys. A test passes a fake. */
export interface KeyWriter {
  /** Adds a function-call key limited to `contractId` and `methods`, with `allowance` yoctoNEAR. */
  addFunctionCallKey(args: {
    signer: Signer;
    publicKey: string;
    contractId: string;
    methods: readonly string[];
    allowance: bigint;
  }): Promise<void>;
  /** Deletes the key `publicKey` from the signer's account. */
  deleteKey(args: { signer: Signer; publicKey: string }): Promise<void>;
}

export type KeyWriterFactory = (target: AgentTarget) => KeyWriter;

/** The chain, through near-api-js: a transaction to the signer's own account, final before it returns. */
const realKeyWriter: KeyWriterFactory = (target) => {
  const provider = new JsonRpcProvider({ url: target.rpcUrl });
  const send = async (signer: Signer, action: ReturnType<typeof actions.deleteKey>) => {
    const account = new Account(signer.accountId, provider, signer.privateKey as KeyPairString);
    const resp = await account.signAndSendTransaction({
      receiverId: signer.accountId,
      actions: [action],
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
    toTxResult(resp, target.contractId);
  };
  return {
    addFunctionCallKey: ({ signer, publicKey, contractId, methods, allowance }) =>
      send(
        signer,
        actions.addFunctionCallAccessKey(
          PublicKey.from(publicKey),
          contractId,
          [...methods],
          allowance,
        ),
      ),
    deleteKey: ({ signer, publicKey }) =>
      send(signer, actions.deleteKey(PublicKey.from(publicKey))),
  };
};

/** An access key's permission with the allowance, which `KeyPermission` leaves out. */
interface FunctionCallKey {
  FunctionCall: {
    receiver_id: string;
    method_names: readonly string[];
    /** What is left of the allowance, in yoctoNEAR. Absent or null: no cap. */
    allowance?: string | null;
  };
}

const asFunctionCall = (permission: KeyPermission): FunctionCallKey["FunctionCall"] | null =>
  typeof permission === "object" && permission !== null && "FunctionCall" in permission
    ? (permission as FunctionCallKey).FunctionCall
    : null;

/**
 * Throws unless `permission` is exactly a delegate key's: a function-call key to `contractId` that
 * lists the four methods of `DELEGATE_METHODS` and no others (in any order), with an allowance that
 * is finite. A key that lists no method may call any, and is not this one.
 */
function requireDelegatePermission(permission: KeyPermission, contractId: string, what: string) {
  const call = asFunctionCall(permission);
  if (call === null) {
    throw new Error(
      `${what} is a full-access key on the chain, which a delegate key never is: nothing was changed`,
    );
  }
  const wanted = [...DELEGATE_METHODS].sort().join(",");
  if (call.receiver_id !== contractId || [...call.method_names].sort().join(",") !== wanted) {
    throw new Error(
      `${what} is on the chain with another permission (to ${call.receiver_id}, for ` +
        `${call.method_names.length === 0 ? "any method" : call.method_names.join(", ")}) than a ` +
        `delegate key's (to ${contractId}, for ${DELEGATE_METHODS.join(", ")}). It will not be widened ` +
        "or narrowed: take it off the account first, with pnpm agent:undelegate",
    );
  }
  if (call.allowance === undefined || call.allowance === null) {
    throw new Error(
      `${what} has no cap on its allowance on the chain: it could spend all the NEAR of the ` +
        "account on gas. Take it off with pnpm agent:undelegate and make a new one",
    );
  }
}

/** `get_delegate`: the caps of `publicKey` on `account`, or null. */
async function delegateOf(
  client: TenderClient,
  account: string,
  publicKey: string,
): Promise<DelegateView | null> {
  const view = await client.view<unknown>(client.contractId, "get_delegate", {
    account_id: account,
    public_key: publicKey,
  });
  return view === null ? null : DelegateViewSchema.parse(view);
}

export interface DelegateOptions extends CommandOptions {
  /** The most one `post_task` or `top_up_task` may spend, in whole units of the token. */
  perTask?: string;
  /** The most the key may spend in all, in whole units of the token. */
  total?: string;
  /** The key's allowance for gas, in NEAR. `DEFAULT_ALLOWANCE` when absent. */
  allowance?: string;
  /** The token the caps are in. Default: the network's USDC if Tender takes it, else its first token. */
  token?: string;
  keysFor?: KeyWriterFactory;
}

export interface DelegateResult {
  /** The delegate key's public half. */
  publicKey: string;
  /** Where its private half is. */
  path: string;
  /** The caps the chain holds for it. */
  caps: DelegateView;
}

/** A positive amount in whole units, as `--flag` wrote it, or a `UsageError` that names the flag. */
function readUnits(flag: string, text: string | undefined, decimals: number): bigint {
  if (text === undefined) throw new UsageError(`${flag} is required\n${USAGE}`);
  let amount: bigint;
  try {
    amount = parseTokenAmount(text, decimals);
  } catch (error) {
    throw new UsageError(
      error instanceof RangeError && !text.startsWith("-")
        ? `${flag} has more than ${decimals} decimal places`
        : `${flag} must be a positive number of whole units, like 2 or 0.5`,
    );
  }
  if (amount === 0n) throw new UsageError(`${flag} must be more than 0`);
  return amount;
}

/** `error` with `note` after its message; a `TenderError` keeps its code and transaction. */
function withNote(error: unknown, note: string): Error {
  if (error instanceof TenderError) {
    return new TenderError(
      error.code,
      error.message + note,
      error.txHash === undefined ? {} : { txHash: error.txHash },
    );
  }
  return new Error(error instanceof Error ? error.message + note : note.trim());
}

/** Wraps a failure of `step` with what state the account is left in and how to go on. */
function afterKeyAdded(error: unknown, account: string, step: string): Error {
  return withNote(
    error,
    `\nThe delegate key is on ${account} already, so ${step} did not happen: run the same ` +
      "pnpm agent:delegate command again to finish, or pnpm agent:undelegate to take the key off.",
  );
}

/**
 * Wraps a failure of `step` of `undelegate`, which has marked the key file by then: says what
 * state the account may be in and that running `pnpm agent:undelegate` again finishes it.
 */
function whileRevoking(error: unknown, account: string, step: string): Error {
  return withNote(
    error,
    `\nThe delegate key of ${account} is being taken away and ${step} did not finish: run ` +
      "pnpm agent:undelegate again to finish it. Until it is done, pnpm agent:delegate refuses " +
      "this key, so that it is not given caps again.",
  );
}

/**
 * Gives the agent a delegate key: makes it and saves it (`<name>.delegate.json`), adds it to the
 * account as a function-call key limited to Tender and `DELEGATE_METHODS` with a finite allowance,
 * and registers its caps with `add_delegate`. Signs with the agent's full-access key. A run that
 * stopped half way is finished by running it again: the saved key is used and no other is made.
 * Prints the public key and nothing secret.
 */
export async function delegateAgentCommand(options: DelegateOptions): Promise<DelegateResult> {
  const log = options.log ?? console.log;
  // The words are checked before the chain is asked anything.
  const allowance = readUnits("--allowance", options.allowance ?? DEFAULT_ALLOWANCE, 24);
  const { key, account, target, client, keyDir } = await load(options, false);

  // The delegate key saved already (a run that stopped, or a revoke that stopped). A file marked by
  // `undelegate` is refused before anything else is asked of the chain: adding that key again would
  // give it new caps with nothing spent.
  const path = delegateFileOf(keyDir, key.name);
  let file = await readDelegateFile(keyDir, key.name);
  if (file?.revoking === true) {
    throw new Error(
      `${path} is a delegate key that pnpm agent:undelegate started to take away and did not ` +
        `finish: run pnpm agent:undelegate --name ${key.name} to finish it. This command does ` +
        "not use it again, because the key would get new caps with nothing counted as spent. " +
        "Nothing was changed.",
    );
  }
  await client.requireFullAccessKey("add_delegate");

  const enabled = (await client.getConfig()).tokens.filter((candidate) => candidate.enabled);
  const usdc = NETWORKS[target.network].usdc;
  const token =
    options.token ??
    (usdc !== undefined && enabled.some((candidate) => candidate.token === usdc)
      ? usdc
      : enabled[0]?.token);
  if (token === undefined || !enabled.some((candidate) => candidate.token === token)) {
    throw new UsageError(
      options.token === undefined
        ? "Tender takes no token on this network yet: nothing to set caps in"
        : `--token ${options.token} is not a token Tender takes now (${enabled.map((t) => t.token).join(", ") || "none"})`,
    );
  }
  const { symbol, decimals } = tokenMeta(token, target.network);
  const perTask = readUnits("--per-task", options.perTask, decimals);
  const total = readUnits("--total", options.total, decimals);
  if (perTask > total) {
    throw new UsageError("--per-task is more than --total: a call could never spend that much");
  }
  // `add_delegate` is charged to the account's storage balance with Tender.
  if ((await client.storageBalanceOf(account)) === null) {
    throw new TenderError(
      "E_STORAGE",
      `${account} has no storage balance with Tender, which pays for the record of the caps: ` +
        `run pnpm agent:register --name ${key.name} first (it puts the storage in place)`,
    );
  }

  // The delegate key: the one saved already (a run that stopped), or a new one, saved before the
  // chain is asked to take it, so that a key on the chain is never one that has been lost.
  if (file !== null) {
    if (
      file.account !== account ||
      file.network !== target.network ||
      file.contract !== target.contractId
    ) {
      throw new Error(
        `${path} is for ${file.account} at ${file.contract} on ${file.network}, and this is ` +
          `${account} at ${target.contractId} on ${target.network}: take that key off with ` +
          "pnpm agent:undelegate, or use another --name",
      );
    }
    if (file.publicKey === key.publicKey) {
      throw new Error(`${path} holds the agent's own full-access key, which is no delegate key`);
    }
    log(`using the delegate key saved in ${path}`);
  } else {
    const pair = KeyPair.fromRandom("ed25519");
    file = {
      version: 1,
      kind: "delegate",
      name: key.name,
      network: target.network,
      account,
      contract: target.contractId,
      publicKey: pair.getPublicKey().toString(),
      privateKey: pair.toString(),
    };
    try {
      await writeKeyFile(path, file, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`${path} appeared while this ran, and this command never replaces a key`);
      }
      throw error;
    }
  }

  const signer: Signer = { accountId: account, privateKey: key.privateKey };
  const keys = (options.keysFor ?? realKeyWriter)(target);
  const held = await client.viewAccessKey(account, file.publicKey);
  if (held === null) {
    try {
      await keys.addFunctionCallKey({
        signer,
        publicKey: file.publicKey,
        contractId: target.contractId,
        methods: DELEGATE_METHODS,
        allowance,
      });
    } catch (error) {
      // The transaction may still land (a node that did not answer in time); the saved key is what
      // a second run adds, or finds on the account.
      throw withNote(
        error,
        `\nThe delegate key is saved in ${path}, and the chain may or may not have taken it: ` +
          "run the same pnpm agent:delegate command again, which adds it if it is not there.",
      );
    }
  }
  // What the chain holds, and not what was sent.
  const added = await client.viewAccessKey(account, file.publicKey);
  if (added === null) {
    throw new Error(`the chain does not show the delegate key on ${account} after adding it`);
  }
  requireDelegatePermission(added.permission, target.contractId, "the delegate key");

  let tx: Awaited<ReturnType<TenderClient["addDelegate"]>>;
  try {
    tx = await client.addDelegate(file.publicKey, token, perTask, total);
  } catch (error) {
    throw afterKeyAdded(error, account, "add_delegate");
  }
  const caps = await delegateOf(client, account, file.publicKey);
  if (
    caps === null ||
    caps.token !== token ||
    BigInt(caps.per_task_cap) !== perTask ||
    BigInt(caps.total_cap) !== total
  ) {
    throw afterKeyAdded(
      new Error(`the chain does not show the caps that were set: ${JSON.stringify(caps)}`),
      account,
      "setting the caps",
    );
  }

  const left = asFunctionCall(added.permission)?.allowance ?? "0";
  const show = (units: bigint) => `${formatTokenAmount(units, decimals)} ${symbol}`;
  log(`OK delegate agent ${key.name} (${account})`);
  log(`delegate key file: ${path} (mode 600; the private key is in it and is never printed)`);
  log(`delegate public key: ${file.publicKey}`);
  log(`methods: ${DELEGATE_METHODS.join(", ")} (never pick, withdraw or add_delegate)`);
  log(`allowance: ${formatTokenAmount(left, 24)} NEAR of gas, finite`);
  log(
    `caps: ${show(perTask)} per call, ${show(total)} in all, in ${token}; spent ${show(BigInt(caps.spent))}`,
  );
  log(`tx: ${tx.txHash}`);
  log(
    `next: sign as ${account} with that key (TENDER_ACCOUNT=${account}, and TENDER_PRIVATE_KEY from ` +
      "the privateKey in the file); keep little liquid NEAR on the account. " +
      `Revoke it with pnpm agent:undelegate --name ${key.name}`,
  );
  return { publicKey: file.publicKey, path, caps };
}

/**
 * Takes the delegate key away: `remove_delegate` first (its caps are the money), then DeleteKey
 * (the key itself), each only if the chain still has it, so that a run that stopped half way is
 * finished by running it again. Before the first chain step the key file is marked `revoking`
 * (written whole, then renamed), which makes `delegate` refuse it: a key whose caps are gone but
 * whose key is still on the account must not be given new caps. The file is removed only when the
 * chain shows both gone.
 */
export async function undelegateAgentCommand(options: DelegateOptions): Promise<void> {
  const log = options.log ?? console.log;
  const { key, account, target, client, keyDir } = await load(options, false);
  const path = delegateFileOf(keyDir, key.name);
  const file = await readDelegateFile(keyDir, key.name);
  if (file === null) {
    throw new Error(`agent ${key.name} has no delegate key at ${path}: nothing to take away`);
  }
  if (
    file.account !== account ||
    file.network !== target.network ||
    file.contract !== target.contractId
  ) {
    throw new Error(
      `${path} is for ${file.account} at ${file.contract} on ${file.network}, and this is ` +
        `${account} at ${target.contractId} on ${target.network}: nothing was changed`,
    );
  }
  // A file that names the agent's own key would have this command delete the key that signs: the
  // account would be locked for good.
  if (file.publicKey === key.publicKey) {
    throw new Error(`${path} holds the agent's own full-access key: nothing was changed`);
  }
  await client.requireFullAccessKey("remove_delegate");
  // Only a function-call key is deleted here, whatever the file says: never a full-access key.
  const requireFunctionCall = (held: { permission: KeyPermission } | null) => {
    if (held !== null && asFunctionCall(held.permission) === null) {
      throw new Error(
        `the key in ${path} is a full-access key of ${account}, which a delegate key never is: ` +
          "it was not deleted and nothing else was changed",
      );
    }
  };
  requireFunctionCall(await client.viewAccessKey(account, file.publicKey));

  // From here on the chain changes: the mark first, so that a run that stops after
  // `remove_delegate` is not mistaken by `delegate` for one that stopped after AddKey.
  if (file.revoking === true) {
    log("finishing a revoke that stopped half way");
  } else {
    await writeKeyFile(path, { ...file, revoking: true }, true);
  }

  let tx: Awaited<ReturnType<TenderClient["removeDelegate"]>> | undefined;
  try {
    if ((await delegateOf(client, account, file.publicKey)) !== null) {
      tx = await client.removeDelegate(file.publicKey);
    }
  } catch (error) {
    throw whileRevoking(error, account, "remove_delegate");
  }
  const held = await client.viewAccessKey(account, file.publicKey);
  if (held !== null) {
    requireFunctionCall(held);
    try {
      await (options.keysFor ?? realKeyWriter)(target).deleteKey({
        signer: { accountId: account, privateKey: key.privateKey },
        publicKey: file.publicKey,
      });
    } catch (error) {
      throw whileRevoking(error, account, "DeleteKey");
    }
  }
  // What the chain holds now: both gone, or the file stays, marked, for another run.
  if (
    (await client.viewAccessKey(account, file.publicKey)) !== null ||
    (await delegateOf(client, account, file.publicKey)) !== null
  ) {
    throw whileRevoking(
      new Error(`the chain still shows the delegate key or its caps on ${account}`),
      account,
      "taking them away",
    );
  }
  await rm(path);
  log(`OK undelegate agent ${key.name} (${account})`);
  log(`delegate public key: ${file.publicKey}`);
  log(tx === undefined ? "caps: none on the chain already" : `caps: removed (tx ${tx.txHash})`);
  log(held === null ? "key: not on the account already" : "key: deleted from the account");
  log(`delegate key file removed: ${path} (the key is dead; a new delegate makes a new one)`);
}

// ---- Connect ----------------------------------------------------------------------------------

/** How long `connect` waits for the owner unless `--wait` says otherwise: 30 minutes. */
export const CONNECT_WAIT_MINUTES = 30;

export interface ConnectCommandOptions extends CommandOptions {
  /** The connect code, from the owner's Add an agent page. */
  code: string;
  /** The API that made the code. `TENDER_API_URL` when absent. */
  api?: string;
  /** How long to wait for the owner, then for the bond, in ms. 30 minutes by default. */
  waitMs?: number;
  /** How often to look while waiting, in ms. 3 s by default. */
  pollMs?: number;
  /** How often, at most, to ask the API which account the owner chose, in ms. 20 s by default. */
  lookupMs?: number;
  /** How long to keep asking the API to take the agent's word, once registered, in ms. */
  confirmMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** The API, at the base given. A test passes its own. */
  apiFor?: (baseUrl: string) => ConnectApi;
  /** What the chain says of the account and the key; through the node unless a test says. */
  chainCheck?: ConnectChain["keyState"];
  /** The account's full-access keys; through the node unless a test says. */
  keysCheck?: ConnectChain["fullAccessKeys"];
  /** Whether an account exists; through the node unless a test says. */
  accountCheck?: ConnectChain["accountExists"];
}

/** Hosts that are this machine, where plain http cannot be read or changed on the way. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The API's base as the API client reads it: https, or http to this machine. */
function connectApiBase(value: string): string {
  let base: string;
  try {
    base = canonicalBase(value);
  } catch {
    throw new UsageError(`--api is not the address of a Tender API\n${USAGE}`);
  }
  const { protocol, hostname } = new URL(base);
  if (protocol === "https:" || (protocol === "http:" && LOOPBACK_HOSTS.has(hostname))) return base;
  throw new UsageError(
    "--api must be https, or http to localhost, 127.0.0.1 or [::1]: the connect code is a " +
      "credential, and plain http could hand it to anyone on the way",
  );
}

/**
 * The chain the code is for, from what the API says, held to what this machine says: a `--network`
 * or a `TENDER_CONTRACT` (or `deployments/<network>.json`) that names another is refused, before a
 * key is made. The node is `NEAR_RPC_URL`, else the network's own.
 */
async function connectTarget(
  lookup: ConnectLookup,
  options: ConnectCommandOptions,
  env: Record<string, string>,
  repoDir: string,
): Promise<AgentTarget> {
  if (options.network !== undefined && options.network !== lookup.network) {
    throw new UsageError(
      `this code is for ${lookup.network}, and --network says ${options.network}: leave --network out`,
    );
  }
  const named = env.TENDER_CONTRACT ?? (await readDeployment(lookup.network, repoDir))?.contract;
  if (named !== undefined && named !== lookup.contract) {
    throw new Error(
      `the API that made this code serves the contract ${lookup.contract} on ${lookup.network}, and ` +
        `this machine names ${named} (TENDER_CONTRACT, or deployments/${lookup.network}.json): use ` +
        "the API of that deployment, or make them agree",
    );
  }
  const rpcUrl = env.NEAR_RPC_URL ?? NETWORKS[lookup.network].rpcUrl;
  if (rpcUrl === "") {
    throw new Error(`NEAR_RPC_URL must be set for ${lookup.network}: the RPC URL of the node`);
  }
  return { network: lookup.network, contractId: lookup.contract, rpcUrl };
}

/**
 * Connects the agent with a code from the owner's page (`connectAgent` of `@tender/client`): the key
 * is `init`'s, used again if its file is there for this account, and the registration is
 * `registerAgentCommand` with `--yes`. Prints plain progress lines and nothing secret.
 */
export async function connectAgentCommand(options: ConnectCommandOptions): Promise<ConnectOutcome> {
  const log = options.log ?? console.log;
  const own = definedOnly(options.env ?? process.env);
  const repoDir = options.repoDir ?? envDir(own);
  const env = { ...readEnvFile(join(repoDir, ".env")), ...own };
  const wanted = options.api ?? env.TENDER_API_URL;
  if (wanted === undefined || wanted === "") {
    throw new UsageError(
      `--api <url> is needed: the address of the Tender API, as the Add an agent page shows it in the command\n${USAGE}`,
    );
  }
  // A request that gets no answer names the address it went to (`fetchNamingApi`): a mistyped
  // `--api` says which one it was, not a bare "fetch failed".
  const api = (
    options.apiFor ?? ((baseUrl) => new ApiClient({ baseUrl, fetchImpl: fetchNamingApi(baseUrl) }))
  )(connectApiBase(wanted));
  // Settled once the code has said which chain it is for (`chainFor`, which runs before `key`).
  let target: AgentTarget | undefined;
  let checked: Promise<AgentTarget> | undefined;
  const targetOf = (lookup: ConnectLookup) => {
    checked ??= connectTarget(lookup, options, env, repoDir).then((found) => {
      target = found;
      return found;
    });
    return checked;
  };
  const chainFor = (lookup: ConnectLookup): ConnectChain => {
    const ready = targetOf(lookup);
    // Ask for it now, so that a refusal comes before the key is made (`key` waits for it).
    ready.catch(() => undefined);
    return {
      keyState: async (account, publicKey) =>
        (options.chainCheck ?? rpcKeyState((await ready).rpcUrl))(account, publicKey),
      fullAccessKeys: async (account) =>
        (options.keysCheck ?? rpcFullAccessKeys((await ready).rpcUrl))(account),
      accountExists: async (account) =>
        (options.accountCheck ?? rpcAccountExists((await ready).rpcUrl))(account),
      plan: async (account) => {
        const where = await ready;
        const reader = new TenderClient({
          network: where.network,
          contractId: where.contractId,
          rpcUrl: where.rpcUrl,
        });
        return planRegistration(reader, account);
      },
    };
  };

  return connectAgent({
    code: options.code,
    ...(options.name !== undefined && { name: options.name }),
    api,
    log,
    waitMs: options.waitMs ?? CONNECT_WAIT_MINUTES * 60_000,
    ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
    ...(options.lookupMs !== undefined && { lookupMs: options.lookupMs }),
    ...(options.confirmMs !== undefined && { confirmMs: options.confirmMs }),
    ...(options.sleep !== undefined && { sleep: options.sleep }),
    ...(options.now !== undefined && { now: options.now }),
    chainFor,
    key: async (lookup, name, mayMake) => {
      await targetOf(lookup);
      const dir = await keysDirOf(options.dir, name);
      // The rule of which key is attached is `@tender/client`'s, shared with `connect_to_tender`.
      return agentKeyFor({
        dir,
        name,
        network: lookup.network,
        // The account the code was made for; a file moved to the implicit account counts only once
        // the code's record says the owner chose it.
        account: `${lookup.name}.${lookup.owner}`,
        implicit: lookup.account_kind === "implicit" ? lookup.account_id : null,
        mayMake,
      }).catch((error: unknown) => {
        if (error instanceof KeyInUseError) throw new Error(`${error.message} (--name <name>)`);
        return asUsage(error);
      });
    },
    moveKey: async (lookup, name, exists) => {
      await targetOf(lookup);
      const dir = await keysDirOf(options.dir, name);
      return moveAgentKeyToImplicit({
        dir,
        name,
        network: lookup.network,
        from: `${lookup.name}.${lookup.owner}`,
        to: lookup.account_id,
        exists,
      }).catch((error: unknown) => {
        if (error instanceof KeyInUseError) throw new Error(error.message);
        return asUsage(error);
      });
    },
    register: async (lookup, name) => {
      const where = target ?? (await targetOf(lookup));
      await registerAgentCommand({
        ...options,
        name,
        account: lookup.account_id,
        network: lookup.network,
        // The vault holds the bond by now: what is left to move is NEAR into the storage balance,
        // out of the NEAR the owner sent the account for it.
        yes: true,
        log,
        env: {
          ...env,
          TENDER_NETWORK: where.network,
          TENDER_CONTRACT: where.contractId,
          NEAR_RPC_URL: where.rpcUrl,
        },
      });
    },
  });
}

// ---- The command line -------------------------------------------------------------------------

export interface CliOptions extends CommandOptions {
  /** Receives what is said about a failure. Default: `console.error`. */
  err?: (text: string) => void;
  /** For tests: what `connect` asks of the API and the chain, and its clock. */
  connect?: Pick<
    ConnectCommandOptions,
    "apiFor" | "chainCheck" | "keysCheck" | "accountCheck" | "sleep" | "now" | "pollMs"
  >;
}

/** What is printed of a failure: the code and transaction of a `TenderError`, else the message. */
export function describeFailure(error: unknown): string {
  if (error instanceof ConnectError) return `agent connect stopped: ${error.message}`;
  if (error instanceof TenderError) {
    const tx = error.txHash === undefined ? "" : `\ntransaction ${error.txHash}`;
    return `agent failed with ${error.code}\n${error.message}${tx}`;
  }
  return `agent failed: ${error instanceof Error ? error.message : String(error)}`;
}

const COMMANDS = [
  "init",
  "register",
  "retire",
  "claim-bond",
  "delegate",
  "undelegate",
  "connect",
] as const;

/**
 * Runs the command line and returns the exit code: 0 when the command did its work, 1 when it
 * failed, and 2 when `connect` stopped waiting for the owner or the bond (the same command goes on).
 */
export async function main(args: readonly string[], options: CliOptions = {}): Promise<number> {
  const err = options.err ?? console.error;
  try {
    const [command, ...given] = args;
    if (command === undefined || !(COMMANDS as readonly string[]).includes(command)) {
      throw new UsageError(`unknown command ${JSON.stringify(command ?? "")}\n${USAGE}`);
    }
    // `connect` takes its code first, as the page shows the command; no other command takes one.
    const code = command === "connect" && !given[0]?.startsWith("-") ? given[0] : undefined;
    const rest = code === undefined ? given : given.slice(1);
    if (command === "connect" && code === undefined) {
      throw new UsageError(`connect needs the code from the Add an agent page\n${USAGE}`);
    }
    let values: Record<string, string | boolean | undefined>;
    try {
      values = parseArgs({
        args: [...rest],
        options: {
          api: { type: "string" },
          wait: { type: "string" },
          name: { type: "string" },
          account: { type: "string" },
          network: { type: "string" },
          dir: { type: "string" },
          yes: { type: "boolean" },
          tags: { type: "string" },
          description: { type: "string" },
          uri: { type: "string" },
          "per-task": { type: "string" },
          total: { type: "string" },
          allowance: { type: "string" },
          token: { type: "string" },
        },
      }).values;
    } catch (error) {
      throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    }
    const text = (key: string) => (typeof values[key] === "string" ? values[key] : undefined);
    const common: CommandOptions = {
      ...options,
      ...(text("name") !== undefined && { name: text("name") }),
      ...(text("account") !== undefined && { account: text("account") }),
      ...(text("network") !== undefined && { network: text("network") }),
      ...(text("dir") !== undefined && { dir: text("dir") }),
      ...(text("tags") !== undefined && { tags: text("tags") }),
      ...(text("description") !== undefined && { description: text("description") }),
      ...(text("uri") !== undefined && { uri: text("uri") }),
      yes: values.yes === true,
    };
    if (command === "init") {
      const network =
        text("network") ?? options.env?.TENDER_NETWORK ?? process.env.TENDER_NETWORK ?? "testnet";
      if (!isNetwork(network))
        throw new UsageError(`--network must be sandbox, testnet or mainnet\n${USAGE}`);
      await initAgent({
        name: nameOf(text("name")),
        network,
        ...(text("account") !== undefined && { account: text("account") }),
        ...(text("dir") !== undefined && { dir: text("dir") }),
        ...(options.log !== undefined && { log: options.log }),
      });
    } else if (command === "register") {
      await registerAgentCommand(common);
    } else if (command === "retire") {
      await retireAgentCommand(common);
    } else if (command === "claim-bond") {
      await claimBondCommand(common);
    } else if (command === "delegate") {
      await delegateAgentCommand({
        ...common,
        ...(text("per-task") !== undefined && { perTask: text("per-task") }),
        ...(text("total") !== undefined && { total: text("total") }),
        ...(text("allowance") !== undefined && { allowance: text("allowance") }),
        ...(text("token") !== undefined && { token: text("token") }),
      });
    } else if (command === "undelegate") {
      await undelegateAgentCommand(common);
    } else {
      const wait = text("wait");
      if (wait !== undefined && !/^[1-9][0-9]{0,3}$/.test(wait)) {
        throw new UsageError(`--wait must be a whole number of minutes, 1 to 9999\n${USAGE}`);
      }
      const outcome = await connectAgentCommand({
        ...common,
        ...options.connect,
        code: code ?? "",
        ...(text("api") !== undefined && { api: text("api") }),
        ...(wait !== undefined && { waitMs: Number(wait) * 60_000 }),
      });
      // A run that stopped to wait is not done: the same command goes on from where it stopped.
      return outcome.status === "registered" ? 0 : 2;
    }
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
