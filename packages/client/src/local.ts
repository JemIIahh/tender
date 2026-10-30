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
 *   10^12.
 *
 * The node binary is the one at `NEAR_SANDBOX_BIN_PATH`, or near-sandbox downloads nearcore 2.13.4
 * when that is unset. Call `stop` when done. A node that fails to set up is stopped here, once
 * every request of the setup has settled, and the setup's error is thrown.
 */
export async function startLocalChain(opts: { minWindowSecs?: number } = {}): Promise<LocalChain> {
  const minWindowSecs = opts.minWindowSecs ?? NETWORKS.sandbox.minWindowSecs;
  const [tenderWasm, tokenWasm] = await Promise.all([readWasm(TENDER_WASM), readWasm(TOKEN_WASM)]);
  const sandbox = await Sandbox.start({ version: NEARCORE_VERSION });
  let accounts: Record<LocalRole, Signer>;
  try {
    accounts = await setUp(sandbox.rpcUrl, tenderWasm, tokenWasm, minWindowSecs);
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

async function setUp(
  rpcUrl: string,
  tenderWasm: Uint8Array,
  tokenWasm: Uint8Array,
  minWindowSecs: number,
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
      // `set_token` charges the owner's storage balance, which exists by now.
      if (role === "owner") await client.send(setTokenCall);
    }),
    clientOf("tender").send(tokenStorageDepositCall(TOKEN, CONTRACT)),
  ]);

  return Object.fromEntries(ROLES.map((role) => [role, signers[role]])) as Record<
    LocalRole,
    Signer
  >;
}
