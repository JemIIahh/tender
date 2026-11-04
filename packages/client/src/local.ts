import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NETWORKS, type TenderCall, tokenStorageDepositCall } from "@tender/shared";
import {
  Account,
  type Action,
  actions,
  JsonRpcProvider,
  KeyPair,
  type KeyPairString,
} from "near-api-js";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";
import { type Registration, registerWithBond, scriptedProfile } from "./bond";
import { type Signer, TenderClient, toTxResult } from "./client";

/** The accounts of a local chain that tests and demos sign as. */
export type LocalRole =
  | "owner"
  | "treasury"
  | "judge"
  | "keeper"
  | "poster"
  | "alice"
  | "bob"
  | "lead";

/** A local nearcore node with Tender and a test token deployed and configured. */
export interface LocalChain {
  network: "sandbox";
  rpcUrl: string;
  contractId: "tender.sandbox";
  tokenId: "usdc.sandbox";
  accounts: Record<LocalRole, Signer>;
  /**
   * Stops the node and deletes its data, also when the node has died already. Calling it again does
   * nothing more.
   */
  stop(): Promise<void>;
}

const ROLES = [
  "owner",
  "treasury",
  "judge",
  "keeper",
  "poster",
  "alice",
  "bob",
  "lead",
] as const satisfies readonly LocalRole[];
const CONTRACT = "tender.sandbox";
const TOKEN = "usdc.sandbox";
/** The nearcore that plan 01 tested the contract on, and near-sandbox 0.3.4's default. */
const NEARCORE_VERSION = "2.13.4";
/** How long `stop` waits for near-sandbox to see the node exit. A live node exits in about 25 ms. */
const STOP_TIMEOUT_MS = 10_000;

const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
/** Each role starts with 10 NEAR, and the contract account with 20. */
const BALANCE = 10n * NEAR;
const CONTRACT_BALANCE = 20n * NEAR;
/** Every role's storage balance with Tender: 0.1 NEAR. */
const STORAGE_DEPOSIT = NEAR / 10n;
/** The poster gets the whole supply at the token's `new`; alice, bob and lead are minted as much. */
const TOKENS_EACH = 10n ** 12n;
const MINTED: readonly LocalRole[] = ["alice", "bob", "lead"];
const FEE_BPS = 500;
/** The rewards Tender accepts in the token, in its smallest unit. */
const MIN_REWARD = 1n;
const MAX_REWARD = 10n ** 12n;
/**
 * The bond an agent pays to register on a local chain: 1 token (the token has 6 decimals). The
 * owner sets it at start-up, so that a local chain behaves as a deployed one does.
 */
export const LOCAL_AGENT_BOND = 10n ** 6n;

/** The committed builds (plan 01 Task 12), found from this file's place in the repo. */
const TENDER_WASM = new URL("../../../contract/res/tender.wasm", import.meta.url);
const TOKEN_WASM = new URL("../../../contract/res/test_token.wasm", import.meta.url);

async function readWasm(url: URL): Promise<Buffer> {
  try {
    return await readFile(url);
  } catch (error) {
    throw new Error(`cannot read ${fileURLToPath(url)}; build it with contract/build.sh`, {
      cause: error,
    });
  }
}

/**
 * Kills the node and deletes its home directory. near-sandbox's `tearDown` sends the kill and then
 * waits for the node's `exit` event, which never comes if the node has died already, so the wait
 * is cut short after `STOP_TIMEOUT_MS`. The kill has been sent by then, and the directory goes
 * either way.
 */
async function stopNode(sandbox: Sandbox): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, STOP_TIMEOUT_MS);
  });
  try {
    await Promise.race([sandbox.tearDown(), timeout]);
  } finally {
    clearTimeout(timer);
  }
  // A node slowed by a busy machine can still be writing (a state snapshot) as the directory goes,
  // which fails the removal with ENOTEMPTY; rm retries that, and EBUSY, on its own.
  await rm(sandbox.homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/**
 * Waits until every lane has settled, then throws the error of the first lane that failed, if one
 * did. `Promise.all` would throw as soon as one lane fails, and the node would then be stopped
 * while the other lanes still have requests in flight.
 */
async function settleLanes(lanes: readonly Promise<unknown>[]): Promise<void> {
  for (const lane of await Promise.allSettled(lanes)) {
    if (lane.status === "rejected") throw lane.reason;
  }
}

/** Sends one transaction and waits until it is final. Throws a `TenderError` if it failed. */
async function transact(account: Account, receiverId: string, transactionActions: Action[]) {
  const resp = await account.signAndSendTransaction({
    receiverId,
    actions: transactionActions,
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
  toTxResult(resp, CONTRACT);
}

/** The test token's `mint`, which anyone may call for an account the token has registered. */
function mintCall(accountId: string, amount: bigint): TenderCall {
  return {
    receiverId: TOKEN,
    methodName: "mint",
    args: { account_id: accountId, amount: `${amount}` },
    gas: 15n * TGAS,
    deposit: 0n,
  };
}

/** The owner's `set_token`, which allowlists the token. It charges the owner's storage. */
const setTokenCall: TenderCall = {
  receiverId: CONTRACT,
  methodName: "set_token",
  args: { token: TOKEN, min_reward: `${MIN_REWARD}`, max_reward: `${MAX_REWARD}`, enabled: true },
  gas: 15n * TGAS,
  deposit: 1n,
};

/** What a local chain's agent bond is, and what a started chain registers on its own. */
export interface LocalChainOptions {
  /** The shortest window Tender accepts, in seconds. 5 by default, the sandbox's. */
  minWindowSecs?: number;
  /**
   * The agent bond the owner sets: the amount of the test token (`LOCAL_AGENT_BOND` by default),
   * and how many seconds an agent waits from `unregister_agent` to its claim: the contract's
   * shortest window by default, which is as short as it can be. Contract rules apply: the cooldown
   * is at least `minWindowSecs`.
   *
   * `null` sets no bond and leaves the cooldown at the contract's own: agents that register then
   * hold none, as the ones did that registered before the owner first set a bond. A test of that
   * sets the bond later with the owner's client (`setAgentBond`). There is no way back to no bond.
   */
  agentBond?: { amount?: bigint; cooldownSecs?: number } | null;
  /**
   * Roles to register as agents, each with the bond, before `startLocalChain` returns. Open tasks
   * take entries only from registered agents, so a test or a demo whose roles enter one names them
   * here. Roles that are left out are not agents. Registering later is `registerLocalAgent`.
   */
  registerAgents?: readonly LocalRole[];
}

/**
 * Starts a nearcore node with near-sandbox and sets it up for Tender:
 *
 * - the root account `sandbox` creates `<role>.sandbox` for each role with 10 NEAR, and
 *   `tender.sandbox` (20 NEAR) and `usdc.sandbox` (10 NEAR), each with a fresh full-access key;
 * - `usdc.sandbox` deploys the test token, with its whole supply (10^12) to the poster, and
 *   `tender.sandbox` deploys Tender and calls `new(owner, treasury, 500, minWindowSecs)`, 5 unless
 *   given. Each does it in one transaction it signs itself: Tender's `new` is `#[private]`;
 * - every role, and `tender.sandbox`, registers with the token. Alice, bob and lead are minted
 *   10^12 each, and every role deposits 0.1 NEAR of storage with Tender;
 * - the owner, whose storage balance `set_token` charges, allowlists the token for rewards of 1 to
 *   10^12, and then sets the agent bond (`LOCAL_AGENT_BOND` of the token) and its cooldown, before
 *   any agent registers;
 * - the roles of `registerAgents` register as agents, and pay the bond.
 *
 * The node binary is the one at `NEAR_SANDBOX_BIN_PATH`, or near-sandbox downloads nearcore 2.13.4
 * when that is unset. Call `stop` when done. A node that fails to set up is stopped here, once
 * every request of the setup has settled, and the setup's error is thrown.
 */
export async function startLocalChain(opts: LocalChainOptions = {}): Promise<LocalChain> {
  const minWindowSecs = opts.minWindowSecs ?? NETWORKS.sandbox.minWindowSecs;
  const bond =
    opts.agentBond === null
      ? null
      : {
          amount: opts.agentBond?.amount ?? LOCAL_AGENT_BOND,
          cooldownSecs: opts.agentBond?.cooldownSecs ?? minWindowSecs,
        };
  const [tenderWasm, tokenWasm] = await Promise.all([readWasm(TENDER_WASM), readWasm(TOKEN_WASM)]);
  // near-sandbox waits NEAR_RPC_TIMEOUT_SECS (default 10) for a new node to answer; a busy machine
  // needs longer, so a minute unless the caller chose otherwise.
  process.env.NEAR_RPC_TIMEOUT_SECS ??= "60";
  const sandbox = await Sandbox.start({ version: NEARCORE_VERSION });
  let accounts: Record<LocalRole, Signer>;
  try {
    accounts = await setUp(sandbox.rpcUrl, tenderWasm, tokenWasm, minWindowSecs, bond);
    await Promise.all(
      (opts.registerAgents ?? []).map((role) =>
        registerLocalAgent({ rpcUrl: sandbox.rpcUrl, accounts }, role),
      ),
    );
  } catch (error) {
    // The setup error is the one worth reporting; a failed stop on top of it is not.
    await stopNode(sandbox).catch(() => undefined);
    throw error;
  }
  let stopped: Promise<void> | undefined;
  return {
    network: "sandbox",
    rpcUrl: sandbox.rpcUrl,
    contractId: CONTRACT,
    tokenId: TOKEN,
    accounts,
    stop() {
      stopped ??= stopNode(sandbox);
      return stopped;
    },
  };
}

/**
 * Registers `role` of a local chain as an agent, paying the bond from its own token balance: the
 * shortfall is moved into its vault first (the roles alice, bob and lead hold 10^12 of the token).
 * Open tasks take entries only from agents like this. Registering twice updates the profile and
 * pays nothing more. `chain` is a `LocalChain`, or anything with its `rpcUrl` and `accounts`.
 */
export async function registerLocalAgent(
  chain: Pick<LocalChain, "rpcUrl" | "accounts">,
  role: LocalRole,
  tags: readonly string[] = [],
): Promise<Registration> {
  const client = new TenderClient({
    network: "sandbox",
    contractId: CONTRACT,
    rpcUrl: chain.rpcUrl,
    signer: chain.accounts[role],
  });
  return registerWithBond(client, scriptedProfile(role, tags), { approve: () => true });
}

async function setUp(
  rpcUrl: string,
  tenderWasm: Uint8Array,
  tokenWasm: Uint8Array,
  minWindowSecs: number,
  bond: { amount: bigint; cooldownSecs: number } | null,
): Promise<Record<LocalRole, Signer>> {
  type Name = LocalRole | "tender" | "usdc";
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY);
  const signers = {} as Record<Name, Signer>;

  // The root signs every creation, so they go one after another: two transactions from one key
  // sent at once can get the same nonce.
  for (const name of [...ROLES, "tender", "usdc"] as const) {
    const accountId = `${name}.${DEFAULT_ACCOUNT_ID}`;
    const key = KeyPair.fromRandom("ed25519");
    await transact(root, accountId, [
      actions.createAccount(),
      actions.transfer(name === "tender" ? CONTRACT_BALANCE : BALANCE),
      actions.addFullAccessKey(key.getPublicKey()),
    ]);
    signers[name] = { accountId, privateKey: key.toString() };
  }
  const accountOf = (name: Name) =>
    new Account(signers[name].accountId, provider, signers[name].privateKey as KeyPairString);
  const clientOf = (name: Name) =>
    new TenderClient({ network: "sandbox", contractId: CONTRACT, rpcUrl, signer: signers[name] });

  // Each contract account deploys and initialises itself in one transaction. From here on every
  // account signs only its own transactions, so the accounts can go at the same time.
  const init = (args: object) => actions.functionCall("new", args, 30n * TGAS, 0n);
  await settleLanes([
    transact(accountOf("usdc"), TOKEN, [
      actions.deployContract(tokenWasm),
      init({ owner_id: signers.poster.accountId, total_supply: `${TOKENS_EACH}` }),
    ]),
    transact(accountOf("tender"), CONTRACT, [
      actions.deployContract(tenderWasm),
      init({
        owner: signers.owner.accountId,
        treasury: signers.treasury.accountId,
        fee_bps: FEE_BPS,
        min_window_secs: minWindowSecs,
      }),
    ]),
  ]);

  await settleLanes([
    ...ROLES.map(async (role) => {
      const client = clientOf(role);
      const { accountId } = signers[role];
      // The token's `new` registered the poster already; registering again refunds the deposit.
      await client.send(tokenStorageDepositCall(TOKEN, accountId));
      if (MINTED.includes(role)) await client.send(mintCall(accountId, TOKENS_EACH));
      await client.storageDeposit(STORAGE_DEPOSIT);
      // `set_token` charges the owner's storage balance, which exists by now. The bond comes
      // straight after: it needs the token on the allowlist, and it is set before any agent
      // registers (agents that registered earlier would hold none).
      if (role === "owner") {
        await client.send(setTokenCall);
        if (bond !== null) {
          await client.setAgentBond(TOKEN, bond.amount);
          await client.setAgentBondCooldown(bond.cooldownSecs);
        }
      }
    }),
    clientOf("tender").send(tokenStorageDepositCall(TOKEN, CONTRACT)),
  ]);

  return Object.fromEntries(ROLES.map((role) => [role, signers[role]])) as Record<
    LocalRole,
    Signer
  >;
}
