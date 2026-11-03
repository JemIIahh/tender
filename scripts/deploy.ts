import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { type Signer, TenderClient, TenderError, toTxResult } from "@tender/client";
import {
  AccountIdSchema,
  HashHexSchema,
  NETWORKS,
  type NetworkId,
  ONE_YOCTO,
  setAgentBondCall,
  setAgentBondCooldownCall,
  storageDepositCall,
  type TenderCall,
  tokenStorageDepositCall,
  U64StringSchema,
  U128StringSchema,
} from "@tender/shared";
import {
  Account,
  type AccountView,
  type Action,
  actions,
  baseEncode,
  formatNearAmount,
  JsonRpcProvider,
  KeyPair,
  type KeyPairString,
} from "near-api-js";
import { AccountDoesNotExistError } from "near-api-js/rpc-errors";
import { loadEnv, parseEnvText, REPO_ROOT } from "./lib/env";

/**
 * The deploy script. Under one parent account it creates the team's ten accounts, deploys the test
 * token and Tender to two of them, configures Tender, and writes a record of what it made:
 *
 *   create <account>               ten sub-accounts, each with a fresh full-access key
 *   deploy <account>               the test token, and Tender, each with its `new` in one transaction
 *   register <account> at <token>  Tender with the test token and, where there is one, with USDC
 *   storage <account> at <tender>  0.1 NEAR of storage with Tender for the owner and every account
 *   set_token <token>              the owner puts the test token, and USDC, on Tender's allowlist
 *   set_agent_bond_cooldown <secs> the owner sets how long an agent waits to claim its bond back
 *   set_agent_bond <token> <n>     the owner sets the bond that registering takes, in the test token
 *   record deployments/<n>.json    the contract, tokens, accounts, wasm hash and deploy block
 *
 * Each step prints `OK <step>` when it did the work and `SKIP <step> (exists)` when the chain
 * already had it, so a run that stopped half way, or one made again after it finished, does what is
 * left and nothing more. Steps that sign with different keys run side by side (three at a time on
 * testnet, whose public RPC answers a burst with 429s).
 *
 * The parent is the contract's owner. Its key signs the account creations and the owner's calls;
 * every other transaction is signed by the account it concerns, with the key the script made for it.
 * Those keys have full access. They are appended to `.env.deploy.<network>` (mode 0600, git-ignored)
 * before the accounts exist, as `<STEM>_ACCOUNT` and `<STEM>_FULL_ACCESS_KEY`, and are never
 * printed. The contract's own are `TENDER_CONTRACT` and `TENDER_CONTRACT_FULL_ACCESS_KEY`. The
 * script never writes a `<STEM>_PRIVATE_KEY`, `TENDER_ACCOUNT` or `TENDER_PRIVATE_KEY`; see
 * `roleVars` and `MEMBERS` for why.
 *
 * THE AGENT BOND (contract Task 16b). Registering as an agent takes a refundable bond, and only a
 * registered agent may enter an open task, so the bond is set here, by the last two steps of the
 * owner's lane, before any agent can register (the script registers none). It is in the test token
 * the deploy made: 1 tUSDC (1_000_000 of its smallest unit, at 6 decimals) on every network, and a
 * cooldown (the wait from `unregister_agent` to `claim_agent_bond`) of 14 days on testnet, the
 * contract's own default and the longest a task's window can be, so that a bond cannot be passed
 * from account to account within one task. On a local chain the cooldown is the shortest window,
 * the least the contract takes, so that a test sees a bond come back. A run that finds a bond set
 * leaves it and the cooldown alone: the owner may have changed them since, and a deploy run again
 * must not undo that. To change them later, the owner calls `set_agent_bond` and
 * `set_agent_bond_cooldown`; a bond is never taken back to nothing, and each agent keeps the bond
 * it paid.
 *
 * `pnpm deploy:testnet` is the command line. The mainnet deploy belongs to plan 07.
 */

/** What a deploy needs to know about the chain it goes to and the account it deploys from. */
export interface DeployTarget {
  network: NetworkId;
  rpcUrl: string;
  /** The account the others are created under, and the owner of the contract. A full-access key. */
  parent: Signer;
  /** The shortest window Tender will accept, in seconds. */
  minWindowSecs: number;
  /**
   * Circle's USDC where the network has it: Tender is registered with it, and it goes on the
   * allowlist for rewards of 0.1 to 50 USDC. The account must exist.
   */
  usdc?: string;
  /**
   * The agent bond to set, if the defaults do not suit: `amount` in the smallest unit of the test
   * token (default 1 tUSDC, `AGENT_BOND`), `cooldownSecs` from the shortest window to 56 days
   * (default: 14 days on testnet, the shortest window elsewhere). See the top of the file.
   */
  agentBond?: { amount?: bigint; cooldownSecs?: number };
}

export interface DeployOptions {
  /** Where `.env.deploy.<network>` and `deployments/` are. The repository root by default. */
  dir?: string;
  /** Receives each `OK <step>` and `SKIP <step> (exists)` line, and nothing else. */
  log?: (line: string) => void;
}

/** The public record of a deployment, as `deployments/<network>.json` holds it. No secret is in it. */
export interface Deployment {
  network: NetworkId;
  /** Tender's account. */
  contract: string;
  /** The tokens Tender takes: the test token the deploy made, and USDC where there is one. */
  tokens: { tusdc: string; usdc?: string };
  /** The owner (the parent) and the ten accounts made, by name: `tender`, `treasury`, `analyst`... */
  accounts: Record<string, string>;
  /** The SHA-256 of Tender's wasm, as 64 lowercase hex characters. */
  wasmSha256: string;
  /**
   * The height of the block that holds the deploy transaction of Tender, as a decimal string. No
   * event of Tender comes earlier, so the indexer starts here.
   */
  deployHeight: string;
  /** When the record was written, once the last step was done (ISO 8601, UTC). */
  deployedAt: string;
}

const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;

/** What each account starts with. Tender gets more: its 300 KB of wasm alone locks 3 NEAR. */
const ACCOUNT_BALANCE = 3n * NEAR;
const TENDER_BALANCE = 8n * NEAR;
/** The parent keeps this much back for the gas of its own transactions. */
const GAS_MARGIN = NEAR;
/** The storage balance the owner and each account open with Tender: 0.1 NEAR, about 10 KB. */
const STORAGE_DEPOSIT = NEAR / 10n;
const FEE_BPS = 500;
/** The whole supply of the test token, in its smallest unit (6 decimals): it goes to the poster. */
const TOKEN_SUPPLY = 10n ** 12n;
/** The rewards Tender accepts in each token, in its smallest unit. */
const TUSDC_LIMITS = { min: 1n, max: 10n ** 12n };
const USDC_LIMITS = { min: 100_000n, max: 50_000_000n };
/** The bond that registering takes by default: 1 tUSDC, in the test token's smallest unit. */
export const AGENT_BOND = 10n ** 6n;
/** The amount and cooldown the owner's lane sets for `target`: its own, else the defaults. */
export function bondTermsFor(
  target: Pick<DeployTarget, "network" | "minWindowSecs" | "agentBond">,
): { amount: bigint; cooldownSecs: number } {
  return {
    amount: target.agentBond?.amount ?? AGENT_BOND,
    cooldownSecs:
      target.agentBond?.cooldownSecs ??
      (target.network === "testnet" ? TESTNET_BOND_COOLDOWN_SECS : target.minWindowSecs),
  };
}

/** The default cooldown on testnet: 14 days, the contract's own default and its longest window. */
export const TESTNET_BOND_COOLDOWN_SECS = 14 * 24 * 60 * 60;
/** Gas for the `new` that comes with a deploy. What a call does not use is refunded. */
const INIT_GAS = 100n * TGAS;
const SET_TOKEN_GAS = 30n * TGAS;

/** The code hash NEAR reports for an account that has no contract: 32 zero bytes in base58. */
const NO_CODE = baseEncode(new Uint8Array(32));

/** The variable that keeps the deploy block of Tender between runs; see `recordDeployment`. */
const HEIGHT_VAR = "DEPLOY_TENDER_HEIGHT";

const MAINNET_REFUSED =
  "mainnet is not deployed by this script: plan 07 owns the mainnet deploy, which needs the owner's approval";

/**
 * What is said when the parent's account id is no account id. The value is never in it: it may be
 * a private key that landed in the wrong variable, and what is printed ends up in logs.
 */
const PARENT_ACCOUNT_INVALID =
  "DEPLOY_PARENT_ACCOUNT is not a valid NEAR account id (its value is not shown, since a private " +
  "key may have been put there). It must be an account id such as my-account.testnet, " +
  "and DEPLOY_PARENT_PRIVATE_KEY the key. Also check that no space follows the = on its line: " +
  "some parsers then read the next line as its value.";

/**
 * The names of the variables that hold an account and its key in `.env.deploy.<network>`:
 * `<STEM>_ACCOUNT` and `<STEM>_FULL_ACCESS_KEY`. The key is the full-access key the deploy made for
 * the account, and the name says so. `<STEM>_PRIVATE_KEY` is the key a service signs with, a
 * function-call key limited to Tender that the owner adds (ruling P02-R27): the deploy never writes
 * it, since `loadEnv` lets the network file win over `.env` and a full-access key under that name
 * would replace the owner's. The scripts that sign as these accounts, such as the skeleton on
 * testnet, read the full-access keys under these names.
 */
const roleVars = (stem: string) => ({
  accountVar: `${stem}_ACCOUNT`,
  keyVar: `${stem}_FULL_ACCESS_KEY`,
});

/**
 * The accounts the deploy creates under its parent, in the order it creates them, with what each
 * starts with and the variables of `.env.deploy.<network>` that hold its id and its key.
 *
 * Tender's are `TENDER_CONTRACT` and `TENDER_CONTRACT_FULL_ACCESS_KEY` (rulings P02-R25, P02-R27),
 * never the `TENDER_ACCOUNT` and `TENDER_PRIVATE_KEY` of the MCP signer in `.env.example`: `loadEnv`
 * lets the network file win over `.env`, so those two would replace the signer with the contract's
 * own full-access key. That key can redeploy the contract, so it belongs on the owner's machine and
 * on no host that runs a service.
 */
const MEMBERS = [
  {
    name: "tender",
    accountVar: "TENDER_CONTRACT",
    keyVar: "TENDER_CONTRACT_FULL_ACCESS_KEY",
    balance: TENDER_BALANCE,
  },
  { name: "treasury", ...roleVars("TREASURY"), balance: ACCOUNT_BALANCE },
  { name: "judge", ...roleVars("JUDGE"), balance: ACCOUNT_BALANCE },
  { name: "keeper", ...roleVars("KEEPER"), balance: ACCOUNT_BALANCE },
  { name: "tusdc", ...roleVars("TUSDC"), balance: ACCOUNT_BALANCE },
  { name: "poster", ...roleVars("POSTER"), balance: ACCOUNT_BALANCE },
  { name: "analyst", ...roleVars("AGENT_ANALYST"), balance: ACCOUNT_BALANCE },
  { name: "coder", ...roleVars("AGENT_CODER"), balance: ACCOUNT_BALANCE },
  { name: "extractor", ...roleVars("AGENT_EXTRACTOR"), balance: ACCOUNT_BALANCE },
  { name: "lead", ...roleVars("AGENT_LEAD"), balance: ACCOUNT_BALANCE },
] as const;

type MemberName = (typeof MEMBERS)[number]["name"];

/** One of those accounts, under this deploy's parent. */
interface Member {
  name: MemberName;
  id: string;
  balance: bigint;
  /** The names of its variables in the env file: the account id, and its full-access key. */
  accountVar: string;
  keyVar: string;
}

function plan(parentId: string): Record<MemberName, Member> {
  const members = MEMBERS.map(({ name, accountVar, keyVar, balance }): Member => {
    const id = `${name}.${parentId}`;
    if (!AccountIdSchema.safeParse(id).success) {
      throw new Error(`${id} is not a valid account id (NEAR's longest is 64 characters)`);
    }
    return { name, id, balance, accountVar, keyVar };
  });
  return Object.fromEntries(members.map((m) => [m.name, m])) as Record<MemberName, Member>;
}

/** The private key `value` holds. Throws without showing it, whatever is wrong with it. */
export function parseKey(value: string, what: string): KeyPair {
  try {
    const key = KeyPair.fromString(value as KeyPairString);
    key.getPublicKey();
    return key;
  } catch {
    throw new Error(`${what} is not a valid private key (expected ed25519:<base58>)`);
  }
}

/** The script that writes to a `DeployEnv`, as the file and the errors about it name it. */
export interface EnvWriter {
  /** The script's path, for the header of a file it makes. */
  script: string;
  /** What the owner is told to run again when the file does not read back: "the deploy". */
  rerun: string;
}

const DEPLOY_WRITER: EnvWriter = { script: "scripts/deploy.ts", rerun: "the deploy" };

/**
 * `.env.deploy.<network>`: the keys the script makes, and the one fact it has to remember between
 * runs. Only this file is read, never `.env`: a key in `.env` is a key of something else.
 */
export class DeployEnv {
  /** The file's name, for messages. */
  readonly name: string;
  private exists: boolean;
  private endsWithNewline: boolean;
  private readonly values: Record<string, string>;

  private constructor(
    readonly path: string,
    name: string,
    text: string | null,
    private readonly writer: EnvWriter,
  ) {
    this.name = name;
    this.exists = text !== null;
    this.endsWithNewline = text === null || text === "" || text.endsWith("\n");
    this.values = parseEnvText(text ?? "");
  }

  /**
   * Opens the env file of a network. A file that exists is made readable by its owner alone first:
   * the owner makes it by hand, with the parent's key in it, and gets mode 0644 more often than
   * not. If the deploy then stops before it appends anything, that is the mode it stays in. The
   * `writer` is the script that adds to the file; the deploy, which is the default, names itself.
   */
  static async open(
    dir: string,
    network: NetworkId,
    writer: EnvWriter = DEPLOY_WRITER,
  ): Promise<DeployEnv> {
    const name = `.env.deploy.${network}`;
    const path = join(dir, name);
    try {
      await chmod(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return new DeployEnv(path, name, null, writer);
      throw error;
    }
    return new DeployEnv(path, name, await readFile(path, "utf8"), writer);
  }

  /** The variable's value, or undefined if it is missing or blank. */
  get(key: string): string | undefined {
    const value = this.values[key]?.trim();
    return value === undefined || value === "" ? undefined : value;
  }

  /**
   * Appends the variables to the file, and returns once they are on disk and read back as written.
   * The deploy sends nothing to the chain before that, so a key is never lost to a crash, or to a
   * parser that read its line as something else.
   */
  async add(entries: ReadonlyArray<readonly [string, string]>): Promise<void> {
    let text = `${entries.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
    if (!this.exists) {
      text = `# Written by ${this.writer.script}. It holds private keys: never commit this file.\n${text}`;
    } else if (!this.endsWithNewline) {
      text = `\n${text}`;
    }
    const file = await open(this.path, "a", 0o600);
    try {
      await file.chmod(0o600);
      await file.appendFile(text);
      await file.datasync();
    } finally {
      await file.close();
    }
    this.exists = true;
    this.endsWithNewline = true;

    // Read back with node's parser as it is, without the tolerance of `parseEnvText`: any other
    // reader of the file may use it. A line above that ends in `= ` makes it take the next line as
    // its value, and that line's variable is lost. Every variable the file is known to hold is
    // checked, the new ones and the old, so that the line at fault is found on any run.
    const back = parseEnv(await readFile(this.path, "utf8"));
    const expected = { ...this.values, ...Object.fromEntries(entries) };
    const lost = Object.entries(expected)
      .filter(([key, value]) => back[key] !== value)
      .map(([key]) => key);
    if (lost.length > 0) {
      throw new Error(
        `${this.name} does not read back as written (${lost.join(", ")}). A line that ends in ` +
          '"= " (a space after the =) makes node read the next line as its value: fix that ' +
          `line and run ${this.writer.rerun} again.`,
      );
    }
    for (const [key, value] of entries) this.values[key] = value;
  }
}

/** The wasm the deploy puts on chain, from the committed builds, with the hashes of each. */
interface Wasm {
  tender: Uint8Array;
  token: Uint8Array;
  /** SHA-256 as hex, for the record. */
  tenderSha256: string;
  /** SHA-256 in base58, which is how NEAR reports an account's `code_hash`. */
  tenderCodeHash: string;
  tokenCodeHash: string;
}

async function readWasm(): Promise<Wasm> {
  const read = async (file: string) => {
    const path = join(REPO_ROOT, "contract", "res", file);
    try {
      return await readFile(path);
    } catch (error) {
      throw new Error(`cannot read ${path}; build it with contract/build.sh`, { cause: error });
    }
  };
  const [tender, token] = await Promise.all([read("tender.wasm"), read("test_token.wasm")]);
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
  return {
    tender,
    token,
    tenderSha256: digest(tender).toString("hex"),
    tenderCodeHash: baseEncode(digest(tender)),
    tokenCodeHash: baseEncode(digest(token)),
  };
}

/** What the node answers once a transaction is final. */
type SentTx = Awaited<ReturnType<Account["signAndSendTransaction"]>>;

/** The chain: transactions with the keys of the deploy, and reads. */
class Chain {
  readonly provider: JsonRpcProvider;
  /** Reads Tender and the tokens; every read is of the last final block. */
  readonly reader: TenderClient;
  private readonly tenderId: string;
  /** One `Account` per signer, so that its transactions share one nonce counter. */
  private readonly accounts = new Map<string, Account>();

  constructor(network: NetworkId, rpcUrl: string, tenderId: string) {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
    this.reader = new TenderClient({ network, contractId: tenderId, rpcUrl });
    this.tenderId = tenderId;
  }

  /** The account as of the last final block, or null if there is none. */
  async account(id: string): Promise<AccountView | null> {
    try {
      return await this.provider.viewAccount({ accountId: id, blockQuery: { finality: "final" } });
    } catch (error) {
      if (error instanceof AccountDoesNotExistError) return null;
      throw error;
    }
  }

  /**
   * Signs a transaction as `signer`, sends it and waits until it and its receipts are final. A
   * failure on chain throws a `TenderError`. One signer sends one transaction at a time.
   */
  async send(signer: Signer, receiverId: string, acts: Action[]): Promise<SentTx> {
    let account = this.accounts.get(signer.accountId);
    if (account === undefined) {
      account = new Account(signer.accountId, this.provider, signer.privateKey as KeyPairString);
      this.accounts.set(signer.accountId, account);
    }
    const resp = await account.signAndSendTransaction({
      receiverId,
      actions: acts,
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
    toTxResult(resp, this.tenderId);
    return resp;
  }

  /** `send` for one function call. */
  call(signer: Signer, call: TenderCall): Promise<SentTx> {
    const { receiverId, methodName, args, gas, deposit } = call;
    return this.send(signer, receiverId, [actions.functionCall(methodName, args, gas, deposit)]);
  }

  async heightOf(blockHash: string): Promise<bigint> {
    const { header } = await this.provider.viewBlock({ blockId: blockHash });
    return BigInt(header.height);
  }
}

/** Everything the steps share. */
interface Context {
  network: NetworkId;
  parent: Signer;
  members: Record<MemberName, Member>;
  usdc: string | undefined;
  minWindowSecs: number;
  /** What the owner's lane sets as the agent bond: in the test token, with its cooldown. */
  bond: { token: string; amount: bigint; cooldownSecs: number };
  dir: string;
  chain: Chain;
  env: DeployEnv;
  wasm: Wasm;
  /** The block of Tender's deploy transaction, if this run made it. */
  tenderHeight?: bigint;
}

/** The signer for a member, with the key the env file holds. */
function signerOf(ctx: Context, member: Member): Signer {
  const privateKey = ctx.env.get(member.keyVar);
  if (privateKey === undefined) throw new Error(`${member.keyVar} is not in ${ctx.env.name}`);
  return { accountId: member.id, privateKey };
}

export type Outcome = "OK" | "SKIP";

/** One line of output, and the work behind it. */
export interface Step {
  label: string;
  run(): Promise<Outcome>;
}

const lineOf = (outcome: Outcome, label: string) =>
  outcome === "OK" ? `OK ${label}` : `SKIP ${label} (exists)`;

/** A step that failed: the step, and why. */
class StepFailure extends Error {
  readonly label: string;

  constructor(label: string, cause: unknown) {
    super(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "StepFailure";
    this.label = label;
  }
}

/** Several steps failed, in lanes that ran side by side. */
class StepsFailed extends Error {
  readonly failures: readonly StepFailure[];

  constructor(failures: readonly StepFailure[]) {
    super(`${failures.length} steps failed\n${failures.map((f) => `  ${f.message}`).join("\n")}`);
    this.name = "StepsFailed";
    this.failures = failures;
  }
}

/** Runs the steps of one lane one after another, until one fails. */
async function runLane(steps: readonly Step[], log: (line: string) => void) {
  for (const step of steps) {
    try {
      log(lineOf(await step.run(), step.label));
    } catch (error) {
      return new StepFailure(step.label, error);
    }
  }
  return null;
}

/**
 * How many lanes run at once: all of them on a local chain, and a few on testnet, whose public RPC
 * answers a burst of requests with 429s.
 */
export function laneLimit(network: NetworkId): number {
  return network === "testnet" ? 3 : Number.POSITIVE_INFINITY;
}

/**
 * Runs the lanes side by side, at most `limit` at once, each lane's steps in order. A lane whose
 * step fails stops there; the others go on to their end, and then the failures are thrown, so that
 * a run that stops leaves as much done as it can. Lanes must not share a signing key, since one
 * key sends one transaction at a time.
 */
export async function runLanes(
  lanes: ReadonlyArray<readonly Step[]>,
  log: (line: string) => void,
  limit: number = Number.POSITIVE_INFINITY,
): Promise<void> {
  const results: Array<StepFailure | null> = lanes.map(() => null);
  let next = 0;
  const worker = async () => {
    while (next < lanes.length) {
      const index = next++;
      results[index] = await runLane(lanes[index] ?? [], log);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, lanes.length) }, worker));

  const failures = results.filter((r): r is StepFailure => r !== null);
  if (failures.length === 1 && failures[0] !== undefined) throw failures[0];
  if (failures.length > 1) throw new StepsFailed(failures);
}

/**
 * Runs `send`, a deploy and `new` in one transaction. Returns null if `new` says that it has run
 * before (`E_INITIALIZED`), as it does when another run of the deploy got there first.
 */
export async function orAlreadyInitialised<T>(send: () => Promise<T>): Promise<T | null> {
  try {
    return await send();
  } catch (error) {
    if (error instanceof TenderError && error.code === "E_INITIALIZED") return null;
    throw error;
  }
}

/** The sentence for an account that holds code other than the deploy's. */
function otherCodeMessage(id: string, found: string, wanted: string): string {
  return (
    `${id} runs other code (hash ${found}, not ${wanted}). The deploy puts a contract on an ` +
    "account once and never replaces it; use another parent, or one that has not deployed here."
  );
}

/** The code the deploy puts on an account, if it puts one: Tender's and the test token's. */
function codeFor(ctx: Context, member: Member): string | undefined {
  if (member.name === "tender") return ctx.wasm.tenderCodeHash;
  if (member.name === "tusdc") return ctx.wasm.tokenCodeHash;
  return undefined;
}

/**
 * What can be checked before the first transaction, so that a deploy that cannot succeed leaves
 * nothing behind: the record in `deployments/` is this deployment's or absent, the node is on the
 * chain the target names, the parent's key is a full-access key of the parent, the USDC account
 * exists, no account of the deploy holds other code, and the parent can pay for the accounts still
 * to make.
 */
async function preflight(ctx: Context): Promise<void> {
  const { chain, parent, usdc } = ctx;

  // What needs no network comes first. The run would replace a record of another deployment when
  // it ends; it must not get as far as spending anything.
  await existingRecord(ctx);

  // The network is a label the caller chose; the chain id is what the node says it is.
  const { chain_id: chainId } = await chain.provider.viewNodeStatus();
  if (chainId === "mainnet") {
    throw new Error(`${MAINNET_REFUSED} (the node answered with chain id "mainnet")`);
  }
  if (ctx.network === "testnet" && chainId !== "testnet") {
    throw new Error(
      `this is a testnet deploy, but the node answered with chain id ${JSON.stringify(String(chainId).slice(0, 40))}`,
    );
  }

  const parentKey = parseKey(parent.privateKey, "the parent's key").getPublicKey().toString();
  const key = await chain.reader.viewAccessKey(parent.accountId, parentKey);
  if (key === null) {
    throw new Error(
      `the parent's key is not a key of ${parent.accountId}: is the account or the key wrong?`,
    );
  }
  if (key.permission !== "FullAccess") {
    throw new Error(
      `the parent's key on ${parent.accountId} is a function-call key; the deploy needs a full-access key`,
    );
  }

  if (usdc !== undefined && (await chain.account(usdc)) === null) {
    throw new Error(`the USDC account ${usdc} does not exist on this chain`);
  }

  let missing = 0;
  let cost = 0n;
  for (const member of Object.values(ctx.members)) {
    const view = await chain.account(member.id);
    if (view === null) {
      missing += 1;
      cost += member.balance;
      continue;
    }
    const wanted = codeFor(ctx, member);
    if (wanted !== undefined && view.code_hash !== NO_CODE && view.code_hash !== wanted) {
      throw new Error(otherCodeMessage(member.id, view.code_hash, wanted));
    }
  }

  const balance = (await chain.account(parent.accountId))?.amount ?? 0n;
  if (missing > 0 && balance < cost + GAS_MARGIN) {
    const near = (yocto: bigint) => formatNearAmount(yocto.toString(), 2);
    throw new Error(
      `${parent.accountId} has ${near(balance)} NEAR, but creating the ${missing} accounts it ` +
        `lacks takes ${near(cost)} NEAR, and gas for the rest of the deploy about ` +
        `${near(GAS_MARGIN)} NEAR more (${near(cost + GAS_MARGIN)} NEAR in all). ` +
        "Top the parent up and run the deploy again.",
    );
  }
}

/** Creates the account with a key of its own, which goes into the env file first. */
function createStep(ctx: Context, member: Member): Step {
  return {
    label: `create ${member.id}`,
    async run() {
      const { chain, env, parent } = ctx;
      const stored = env.get(member.keyVar);
      if ((await chain.account(member.id)) !== null) {
        if (stored === undefined) {
          throw new Error(
            `${member.id} exists, but ${member.keyVar} is not in ${env.name}. Without its key the ` +
              "deploy cannot go on: restore the file, or deploy under another parent.",
          );
        }
        const publicKey = parseKey(stored, `${member.keyVar} in ${env.name}`).getPublicKey();
        const onChain = await chain.reader.viewAccessKey(member.id, publicKey.toString());
        if (onChain?.permission !== "FullAccess") {
          throw new Error(
            `${member.keyVar} in ${env.name} is not a full-access key of ${member.id}`,
          );
        }
        if (env.get(member.accountVar) === undefined) {
          await env.add([[member.accountVar, member.id]]);
        }
        return "SKIP";
      }

      // The key is on disk before the account is on chain, so that the deploy never makes an
      // account whose key is lost. A key from an earlier run that stopped here is used again.
      const key = parseKey(stored ?? KeyPair.fromRandom("ed25519").toString(), member.keyVar);
      const entries: Array<readonly [string, string]> = [];
      if (env.get(member.accountVar) === undefined) entries.push([member.accountVar, member.id]);
      if (stored === undefined) entries.push([member.keyVar, key.toString()]);
      if (entries.length > 0) await env.add(entries);
      await chain.send(parent, member.id, [
        actions.createAccount(),
        actions.transfer(member.balance),
        actions.addFullAccessKey(key.getPublicKey()),
      ]);
      return "OK";
    },
  };
}

/**
 * Deploys `code` to the member's account and calls `new` with `init` in the same transaction, which
 * the account signs itself: a deploy and its `new` in two transactions would leave a window for
 * someone else's `new`, and Tender's `new` is private to the account. `onDeployed` gets the height
 * of the block that holds the transaction.
 */
function deployStep(
  ctx: Context,
  member: Member,
  code: { bytes: Uint8Array; hash: string },
  init: object,
  onDeployed?: (height: bigint) => Promise<void>,
): Step {
  return {
    label: `deploy ${member.id}`,
    async run() {
      const view = await ctx.chain.account(member.id);
      if (view === null) throw new Error(`${member.id} does not exist`);
      if (view.code_hash === code.hash) return "SKIP";
      if (view.code_hash !== NO_CODE)
        throw new Error(otherCodeMessage(member.id, view.code_hash, code.hash));
      const resp = await orAlreadyInitialised(() =>
        ctx.chain.send(signerOf(ctx, member), member.id, [
          actions.deployContract(code.bytes),
          actions.functionCall("new", init, INIT_GAS, 0n),
        ]),
      );
      if (resp === null) return "SKIP";
      await onDeployed?.(await ctx.chain.heightOf(resp.transaction_outcome.block_hash));
      return "OK";
    },
  };
}

/** The least a token takes to register an account (NEP-145), from the token itself. */
async function registrationCost(ctx: Context, token: string): Promise<bigint> {
  const bounds = await ctx.chain.reader.view<{ min?: unknown }>(token, "storage_balance_bounds");
  const min = U128StringSchema.safeParse(bounds.min);
  if (!min.success) throw new Error(`${token} does not report a storage minimum (NEP-145)`);
  return BigInt(min.data);
}

/** Registers Tender's account with a token, which it must be before the token will pay it. */
function registerStep(ctx: Context, token: string): Step {
  const tender = ctx.members.tender;
  return {
    label: `register ${tender.id} at ${token}`,
    async run() {
      if ((await ctx.chain.reader.ftStorageBalanceOf(token, tender.id)) !== null) return "SKIP";
      const cost = await registrationCost(ctx, token);
      await ctx.chain.call(signerOf(ctx, tender), tokenStorageDepositCall(token, tender.id, cost));
      return "OK";
    },
  };
}

/** Opens a storage balance with Tender for `signer`, paid from its own funds. */
function storageStep(ctx: Context, signer: Signer): Step {
  const tenderId = ctx.members.tender.id;
  return {
    label: `storage ${signer.accountId} at ${tenderId}`,
    async run() {
      if ((await ctx.chain.reader.storageBalanceOf(signer.accountId)) !== null) return "SKIP";
      await ctx.chain.call(signer, storageDepositCall(tenderId, STORAGE_DEPOSIT));
      return "OK";
    },
  };
}

/** Puts `token` on Tender's allowlist, as the owner. */
function setTokenStep(ctx: Context, token: string, limits: { min: bigint; max: bigint }): Step {
  const tenderId = ctx.members.tender.id;
  return {
    label: `set_token ${token}`,
    async run() {
      const { tokens } = await ctx.chain.reader.getConfig();
      if (tokens.some((t) => t.token === token)) return "SKIP";
      await ctx.chain.call(ctx.parent, {
        receiverId: tenderId,
        methodName: "set_token",
        args: {
          token,
          min_reward: limits.min.toString(),
          max_reward: limits.max.toString(),
          enabled: true,
        },
        gas: SET_TOKEN_GAS,
        deposit: ONE_YOCTO,
      });
      return "OK";
    },
  };
}

/**
 * The bond is already set when the config names a token for it, and then neither step touches it:
 * the owner may have changed the bond or the cooldown since the deploy, and there is no way back
 * to no bond. A deploy that stopped between the two finds the cooldown set and the bond not, and
 * sets the bond.
 */
async function bondIsSet(ctx: Context): Promise<boolean> {
  return (await ctx.chain.reader.getConfig()).agent_bond_token !== null;
}

/** Sets how long an agent waits to claim its bond, as the owner, unless a bond is set already. */
function setBondCooldownStep(ctx: Context): Step {
  const tenderId = ctx.members.tender.id;
  const { cooldownSecs } = ctx.bond;
  return {
    label: `set_agent_bond_cooldown ${cooldownSecs}`,
    async run() {
      const config = await ctx.chain.reader.getConfig();
      if (config.agent_bond_token !== null) return "SKIP";
      if (config.agent_bond_cooldown_secs === cooldownSecs.toString()) return "SKIP";
      await ctx.chain.call(ctx.parent, setAgentBondCooldownCall(tenderId, cooldownSecs));
      return "OK";
    },
  };
}

/** Sets the bond that registering takes, as the owner, unless a bond is set already. */
function setBondStep(ctx: Context): Step {
  const tenderId = ctx.members.tender.id;
  const { token, amount } = ctx.bond;
  return {
    label: `set_agent_bond ${token} ${amount}`,
    async run() {
      if (await bondIsSet(ctx)) return "SKIP";
      await ctx.chain.call(ctx.parent, setAgentBondCall(tenderId, token, amount));
      return "OK";
    },
  };
}

/** The path of a network's record. */
export function deploymentPath(network: NetworkId, dir: string = REPO_ROOT): string {
  return join(dir, "deployments", `${network}.json`);
}

/** A block height as the record writes it: a decimal string, 1 or more. */
const isBlockHeight = (value: unknown): value is string =>
  typeof value === "string" && value !== "0" && U64StringSchema.safeParse(value).success;

/** An ISO 8601 time in UTC, as `Date.prototype.toISOString` writes one. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Reads a record, which must have every field of `Deployment` in its form. */
function parseDeployment(json: unknown, network: NetworkId, source: string): Deployment {
  function bad(what: string): never {
    throw new Error(`${source} is not a deployment record: ${what}`);
  }
  const isAccount = (value: unknown): value is string =>
    typeof value === "string" && AccountIdSchema.safeParse(value).success;
  const asObject = (value: unknown, what: string): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return bad(`${what} is not an object`);
    }
    return value as Record<string, unknown>;
  };

  const record = asObject(json, "it");
  if (record.network !== network) {
    bad(`its network is ${JSON.stringify(record.network)}, not ${network}`);
  }
  const { contract, wasmSha256, deployHeight, deployedAt } = record;
  if (!isAccount(contract)) bad("contract is not an account id");

  const { tusdc, usdc } = asObject(record.tokens, "tokens");
  if (!isAccount(tusdc)) bad("tokens.tusdc is not an account id");
  if (usdc !== undefined && !isAccount(usdc)) bad("tokens.usdc is not an account id");

  const accounts: Record<string, string> = {};
  for (const [name, id] of Object.entries(asObject(record.accounts, "accounts"))) {
    if (!isAccount(id)) bad(`accounts.${name} is not an account id`);
    accounts[name] = id;
  }

  if (typeof wasmSha256 !== "string" || !HashHexSchema.safeParse(wasmSha256).success) {
    bad("wasmSha256 is not a SHA-256 as 64 lowercase hex characters");
  }
  if (!isBlockHeight(deployHeight)) bad("deployHeight is not a block height as a decimal string");
  if (
    typeof deployedAt !== "string" ||
    !ISO_TIME.test(deployedAt) ||
    Number.isNaN(Date.parse(deployedAt))
  ) {
    bad("deployedAt is not an ISO 8601 time in UTC");
  }

  return {
    network,
    contract,
    tokens: usdc === undefined ? { tusdc } : { tusdc, usdc },
    accounts,
    wasmSha256,
    deployHeight,
    deployedAt,
  };
}

/**
 * The record of `network` in `dir/deployments`, or null if there is none. Throws, naming the file,
 * if it is not valid JSON or lacks a field of `Deployment`.
 */
export async function readDeployment(
  network: NetworkId,
  dir: string = REPO_ROOT,
): Promise<Deployment | null> {
  const path = deploymentPath(network, dir);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON`, { cause: error });
  }
  return parseDeployment(json, network, path);
}

/** Writes the record whole or not at all, so a reader never sees half of it. */
async function writeDeployment(path: string, record: Deployment): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temporary, path);
}

/** The same deployment: its contract, tokens and accounts. When it was made does not matter. */
function sameDeployment(a: Deployment, b: Deployment): boolean {
  const identity = (d: Deployment) =>
    JSON.stringify([
      d.contract,
      d.tokens.tusdc,
      d.tokens.usdc ?? null,
      Object.entries(d.accounts).sort(([x], [y]) => (x < y ? -1 : 1)),
    ]);
  return identity(a) === identity(b);
}

/** The record of the deployment this run makes, with the block it names and the time it is made. */
function deploymentOf(ctx: Context, deployHeight: string): Deployment {
  const { members } = ctx;
  return {
    network: ctx.network,
    contract: members.tender.id,
    tokens:
      ctx.usdc === undefined
        ? { tusdc: members.tusdc.id }
        : { tusdc: members.tusdc.id, usdc: ctx.usdc },
    accounts: {
      owner: ctx.parent.accountId,
      ...Object.fromEntries(Object.values(members).map((m) => [m.name, m.id])),
    },
    wasmSha256: ctx.wasm.tenderSha256,
    deployHeight,
    deployedAt: new Date().toISOString(),
  };
}

/**
 * The record already in `deployments/<network>.json`, or null if there is none. Throws if it is
 * another deployment's: its contract, tokens or accounts differ from this one's. That record is
 * what the skeleton and the indexer read, so no run replaces it, whatever it deployed.
 */
async function existingRecord(ctx: Context): Promise<Deployment | null> {
  const existing = await readDeployment(ctx.network, ctx.dir);
  if (existing !== null && !sameDeployment(existing, deploymentOf(ctx, existing.deployHeight))) {
    throw new Error(
      `${deploymentPath(ctx.network, ctx.dir)} is the record of another deployment (contract ` +
        `${existing.contract}; its tokens or accounts differ from this one's). Move it aside to ` +
        "record this deployment.",
    );
  }
  return existing;
}

/**
 * Writes the record, or finds it written. The deploy block is the one this run made, or else the
 * one an earlier run kept in the env file when it deployed Tender; a run that stopped after that
 * block and before the record does not forget it.
 */
async function recordDeployment(
  ctx: Context,
): Promise<{ outcome: Outcome; deployment: Deployment }> {
  const { members, network, env } = ctx;
  const path = deploymentPath(network, ctx.dir);
  // The record of this deployment is kept as it is, unless this run deployed Tender anew and so
  // knows a block that the record does not.
  const existing = await existingRecord(ctx);
  if (existing !== null && ctx.tenderHeight === undefined) {
    return { outcome: "SKIP", deployment: existing };
  }

  const deployHeight = ctx.tenderHeight?.toString() ?? env.get(HEIGHT_VAR);
  if (!isBlockHeight(deployHeight)) {
    throw new Error(
      `${members.tender.id} was deployed by an earlier run, and ${HEIGHT_VAR} is missing from ` +
        `${env.name} or is not a block height, so the block of its deploy transaction is ` +
        `unknown. Look the transaction up in an explorer and set ${HEIGHT_VAR}=<its block ` +
        `height> in ${env.name}.`,
    );
  }
  const deployment = deploymentOf(ctx, deployHeight);
  await writeDeployment(path, deployment);
  return { outcome: "OK", deployment };
}

/** A value from the env file, if it is an account id. Any other may be a key, so it is not shown. */
function shown(value: string): string {
  return AccountIdSchema.safeParse(value).success ? value : "something that is no account id";
}

/**
 * For the message about an env file of another deployment: whose keys it holds, by account id.
 * Only ids are listed, since a file written by hand may hold a key where an id belongs.
 */
function holdsKeysOf(env: DeployEnv, members: Record<MemberName, Member>): string {
  const ids = Object.values(members).flatMap((member) => {
    const id = env.get(member.accountVar);
    const hasKey = env.get(member.keyVar) !== undefined;
    return id !== undefined && hasKey && AccountIdSchema.safeParse(id).success ? [id] : [];
  });
  return ids.length > 0 ? `it holds the keys of ${ids.join(", ")}` : "it may hold keys";
}

/**
 * Deploys Tender and its test token to `target.network` under `target.parent`, and returns the
 * record that it wrote to `deployments/<network>.json`. See the top of this file for the steps.
 *
 * Throws a `StepFailure` (or `StepsFailed`) naming the steps that failed; what the other steps did
 * stays done, and a second run carries on. Before anything is sent it throws if the parent's
 * account id is no account id, the env file names other accounts or holds a bad key, the record in
 * `deployments/` is another deployment's, the node is on mainnet (or, for a testnet target, on any
 * chain but testnet), the parent's key is not a full-access key of the parent, the USDC account is
 * missing, an account of the deploy holds other code, or the parent cannot pay. None of these
 * messages shows the parent's key or the value of a variable.
 */
export async function deploy(
  target: DeployTarget,
  options: DeployOptions = {},
): Promise<Deployment> {
  const { network, rpcUrl, parent, minWindowSecs, usdc } = target;
  if (network === "mainnet") throw new Error(MAINNET_REFUSED);
  if (rpcUrl.trim() === "") {
    throw new Error(
      "deploy needs the RPC URL of the chain: a local node picks its port, so pass its rpcUrl",
    );
  }
  const dir = options.dir ?? REPO_ROOT;
  const log = options.log ?? console.log;
  const limit = laneLimit(network);

  // The env file is opened first, and made private, whatever else turns out to be wrong.
  const env = await DeployEnv.open(dir, network);

  // Then the parent, with nothing printed from it: whatever sits in these two variables may be
  // the key, and the account id goes into the id of every account the deploy makes.
  parseKey(parent.privateKey, "the parent's key");
  if (!AccountIdSchema.safeParse(parent.accountId).success) {
    throw new Error(PARENT_ACCOUNT_INVALID);
  }

  const members = plan(parent.accountId);
  for (const member of Object.values(members)) {
    const named = env.get(member.accountVar);
    if (named !== undefined && named !== member.id) {
      throw new Error(
        `${env.name} names ${shown(named)} as ${member.accountVar}, but this deploy's account is ` +
          `${member.id}. The file belongs to another deployment: move it aside ` +
          `(${holdsKeysOf(env, members)}) and run the deploy again.`,
      );
    }
    const key = env.get(member.keyVar);
    if (key !== undefined) parseKey(key, `${member.keyVar} in ${env.name}`);
  }

  const ctx: Context = {
    network,
    parent,
    members,
    usdc,
    minWindowSecs,
    bond: { token: members.tusdc.id, ...bondTermsFor(target) },
    dir,
    chain: new Chain(network, rpcUrl, members.tender.id),
    env,
    wasm: await readWasm(),
  };
  const { tender, treasury, poster, tusdc } = members;

  await preflight(ctx);

  // The parent makes the accounts, one after another: it is one key.
  await runLanes([Object.values(members).map((member) => createStep(ctx, member))], log, limit);

  // The contracts: each account deploys to itself, and the two go side by side.
  await runLanes(
    [
      [
        deployStep(
          ctx,
          tusdc,
          { bytes: ctx.wasm.token, hash: ctx.wasm.tokenCodeHash },
          { owner_id: poster.id, total_supply: TOKEN_SUPPLY.toString() },
        ),
      ],
      [
        deployStep(
          ctx,
          tender,
          { bytes: ctx.wasm.tender, hash: ctx.wasm.tenderCodeHash },
          {
            owner: parent.accountId,
            treasury: treasury.id,
            fee_bps: FEE_BPS,
            min_window_secs: minWindowSecs,
          },
          async (height) => {
            ctx.tenderHeight = height;
            await env.add([[HEIGHT_VAR, height.toString()]]);
          },
        ),
      ],
    ],
    log,
    limit,
  );

  // The rest is one lane for the owner (its storage first: `set_token` is charged to it), one for
  // Tender's account, and one for each of the others, which have a key to themselves.
  const owner: Step[] = [
    storageStep(ctx, parent),
    setTokenStep(ctx, tusdc.id, TUSDC_LIMITS),
    ...(usdc === undefined ? [] : [setTokenStep(ctx, usdc, USDC_LIMITS)]),
    // After the token, which the bond must be in; before the deploy ends, so that the bond is there
    // when the first agent registers.
    setBondCooldownStep(ctx),
    setBondStep(ctx),
  ];
  const tenderAccount: Step[] = [
    registerStep(ctx, tusdc.id),
    ...(usdc === undefined ? [] : [registerStep(ctx, usdc)]),
    storageStep(ctx, signerOf(ctx, tender)),
  ];
  const others = Object.values(members)
    .filter((member) => member !== tender)
    .map((member) => [storageStep(ctx, signerOf(ctx, member))]);
  await runLanes([owner, tenderAccount, ...others], log, limit);

  const label = `record deployments/${network}.json`;
  try {
    const { outcome, deployment } = await recordDeployment(ctx);
    log(lineOf(outcome, label));
    return deployment;
  } catch (error) {
    throw new StepFailure(label, error);
  }
}

// The command line.

/** A mistake in how the script was run, which is reported without the "deploy failed" of a fault. */
export class UsageError extends Error {}

const USAGE = "usage: pnpm deploy:testnet (tsx scripts/deploy.ts --network testnet)";

/** The yyyymmdd of `now` in UTC. */
const dateStamp = (now: Date) => now.toISOString().slice(0, 10).replaceAll("-", "");

/** What to do about a testnet deploy that has no parent account yet. */
function parentSetup(now: Date): string {
  const account = `tender-dev-${dateStamp(now)}.testnet`;
  return [
    "DEPLOY_PARENT_ACCOUNT is not set, so there is no testnet account to deploy from.",
    "",
    "Create one with near-cli-rs (install it from its official release binary first):",
    "",
    `  near account create-account sponsor-by-faucet-service ${account} autogenerate-new-keypair save-to-keychain network-config testnet create`,
    "",
    "Then export its private key (see `near account export-account --help`), put both in",
    ".env.deploy.testnet, and run pnpm deploy:testnet again:",
    "",
    `  DEPLOY_PARENT_ACCOUNT=${account}`,
    "  DEPLOY_PARENT_PRIVATE_KEY=ed25519:...",
  ].join("\n");
}

/**
 * The target for `network` from the command line: for testnet, the network's RPC URL, window and
 * USDC, and the parent from `DEPLOY_PARENT_ACCOUNT` and `DEPLOY_PARENT_PRIVATE_KEY` in `.env` or
 * `.env.deploy.testnet` of `dir`. Throws a `UsageError` for every other network, for a parent that
 * is not set up, and for a parent account that is no account id (without showing it: it may be the
 * key). It reads no more than those two files and uses no network.
 */
export function loadTarget(
  network: string | undefined,
  options: { dir?: string; now?: Date } = {},
): DeployTarget {
  if (network === undefined) throw new UsageError(USAGE);
  if (network === "mainnet") throw new UsageError(MAINNET_REFUSED);
  if (network === "sandbox") {
    throw new UsageError(
      "the sandbox is deployed by tests, which start the chain and pass its RPC URL and root key " +
        `to deploy(); the command line deploys to testnet.\n${USAGE}`,
    );
  }
  if (network !== "testnet") {
    throw new UsageError(`unknown network ${JSON.stringify(network)}\n${USAGE}`);
  }

  const dir = options.dir ?? REPO_ROOT;
  const account = loadEnv("testnet", { dir }).DEPLOY_PARENT_ACCOUNT?.trim();
  if (account === undefined || account === "") {
    throw new UsageError(parentSetup(options.now ?? new Date()));
  }
  if (!AccountIdSchema.safeParse(account).success) throw new UsageError(PARENT_ACCOUNT_INVALID);
  const env = loadEnv("testnet", { dir, required: ["DEPLOY_PARENT_PRIVATE_KEY"] });
  const config = NETWORKS.testnet;
  return {
    network: "testnet",
    rpcUrl: config.rpcUrl,
    parent: { accountId: account, privateKey: env.DEPLOY_PARENT_PRIVATE_KEY.trim() },
    minWindowSecs: config.minWindowSecs,
    usdc: config.usdc,
  };
}

/** What the command line prints on a failure: the code and the transaction of a `TenderError`. */
export function describeFailure(error: unknown): string {
  const cause = error instanceof StepFailure ? error.cause : error;
  if (cause instanceof TenderError) {
    const at = error instanceof StepFailure ? ` at ${error.label}` : "";
    const tx = cause.txHash === undefined ? "" : `\ntransaction ${cause.txHash}`;
    return `deploy failed${at} with ${cause.code}\n${cause.message}${tx}`;
  }
  return `deploy failed: ${error instanceof Error ? error.message : String(error)}`;
}

export interface CliOptions {
  /** Where the env files and `deployments/` are. The repository root by default. */
  dir?: string;
  now?: Date;
  /** Receives the lines of the deploy. Defaults to `console.log`. */
  out?: (line: string) => void;
  /** Receives what is said about a failure. Defaults to `console.error`. */
  err?: (text: string) => void;
  /** The deploy to run; the real one by default. */
  deploy?: typeof deploy;
}

/** Runs the command line and returns the exit code: 0 after a deploy, 1 for anything else. */
export async function main(args: readonly string[], options: CliOptions = {}): Promise<number> {
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  try {
    let network: string | undefined;
    try {
      network = parseArgs({ args: [...args], options: { network: { type: "string" } } }).values
        .network;
    } catch (error) {
      throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    }
    const target = loadTarget(network, options);
    await (options.deploy ?? deploy)(target, { dir: options.dir, log: out });
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
