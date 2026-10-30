import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type LocalChain,
  type Signer,
  startLocalChain,
  TenderClient,
  TenderError,
} from "@tender/client";
import {
  computeCommitment,
  NETWORKS,
  randomSalt,
  sha256Hex,
  type TenderCall,
  tokenStorageDepositCall,
  USDC_DECIMALS,
} from "@tender/shared";
import { loadEnv, REPO_ROOT } from "./lib/env";

/**
 * The walking skeleton: one script that runs a whole task on a chain, from a deposit to a
 * withdrawal, and prints six lines as the steps finish.
 *
 *   DEPOSITED 10000000    the poster puts 10 tUSDC in its vault
 *   POSTED task=<id>      and posts a task of 1 tUSDC, judged by the judge
 *   COMMITTED 2           alice and bob each commit to work
 *   REVEALED 2            and each reveals it
 *   PAID alice=<amount>   the judge picks alice, and the reward less the fee is hers in the vault
 *   WITHDRAWN alice=<n>   she withdraws it, and her token balance rises by <n>
 *
 * `pnpm skeleton` runs it on a local chain, `pnpm skeleton --network testnet` on the testnet
 * deployment. The work is a stand-in: nothing is uploaded, and the URIs are `skeleton://...`.
 */

export interface SkeletonOptions {
  network: "sandbox" | "testnet";
  /**
   * A running local chain to use and leave running; sandbox only. Without one, the skeleton starts
   * a chain of its own and stops it at the end.
   */
  chain?: LocalChain;
  /** Receives each of the six lines. Defaults to `console.log`. */
  log?: (line: string) => void;
}

export interface SkeletonResult {
  taskId: bigint;
  /** What the pick credited to alice in the vault, in the token's smallest unit. */
  paid: bigint;
  /** How much her token balance rose when she withdrew it. */
  withdrawn: bigint;
}

/** What the skeleton runs against: a chain, the accounts to sign as, and the task's pace. */
export interface Target {
  network: "sandbox" | "testnet";
  contractId: string;
  tokenId: string;
  /** Unset on testnet, where the client uses the network's RPC. */
  rpcUrl?: string;
  /** Posts the task and funds it. */
  poster: Signer;
  /** Picks the winner. */
  judge: Signer;
  /** Gets paid. */
  alice: Signer;
  /** Enters and loses. */
  bob: Signer;
  /**
   * The length in seconds of each of the task's four windows, or the contract's minimum if that
   * is longer.
   */
  windowSecs: number;
}

const ONE_TOKEN = 10n ** BigInt(USDC_DECIMALS);
const DEPOSIT = 10n * ONE_TOKEN;
const REWARD = ONE_TOKEN;
const TGAS = 10n ** 12n;

/**
 * The sandbox's windows are twice its 5 s minimum. Each step lands about a second into its window,
 * measured on a quiet machine and with four runs side by side, so the rest is margin for a slower
 * one, such as a CI runner.
 */
const SANDBOX_WINDOW_SECS = 10;

/**
 * The keys of `.env.deploy.testnet` the skeleton signs with, as the deploy script names them: the
 * poster and the judge by role, alice and bob by the reference agents `analyst` and `coder`. The
 * keys are the full-access ones the deploy made, `<STEM>_FULL_ACCESS_KEY`, because the skeleton
 * mints, deposits and posts, which a function-call key limited to Tender cannot. The
 * `<STEM>_PRIVATE_KEY` names are the services' own, and the skeleton never reads them.
 */
const TESTNET_KEYS = [
  "POSTER_ACCOUNT",
  "POSTER_FULL_ACCESS_KEY",
  "JUDGE_ACCOUNT",
  "JUDGE_FULL_ACCESS_KEY",
  "AGENT_ANALYST_ACCOUNT",
  "AGENT_ANALYST_FULL_ACCESS_KEY",
  "AGENT_CODER_ACCOUNT",
  "AGENT_CODER_FULL_ACCESS_KEY",
] as const;

/** How long past its due time a wait for the chain's clock may run before it gives up. */
const STALL_MS = 60_000;

/**
 * Runs the whole task, on `opts.network`, and returns what it came to. Throws a `TenderError` if
 * the chain refuses a step, and an `Error` if a step succeeds but does not do what it should.
 *
 * On testnet the keys come from `.env.deploy.testnet` and the contract and token from
 * `deployments/testnet.json`; without them it fails at once, before it touches the network.
 *
 * It signs as the poster, the judge, alice and bob, so run it one at a time on a chain: two runs
 * at once would send from the same keys at the same time.
 */
export async function runSkeleton(opts: SkeletonOptions): Promise<SkeletonResult> {
  const log = opts.log ?? console.log;
  if (opts.network === "testnet") {
    if (opts.chain !== undefined) {
      throw new Error(
        "a local chain is for the sandbox; the testnet run uses the testnet deployment",
      );
    }
    return play(await loadTestnetTarget(), log);
  }

  const ownChain = opts.chain === undefined;
  const chain = opts.chain ?? (await startLocalChain());
  let result: SkeletonResult;
  try {
    result = await play(sandboxTarget(chain), log);
  } catch (error) {
    // The failure is the one worth reporting; a failed teardown on top of it is not.
    if (ownChain) await chain.stop().catch(() => undefined);
    throw error;
  }
  if (ownChain) await chain.stop();
  return result;
}

function sandboxTarget(chain: LocalChain): Target {
  const { poster, judge, alice, bob } = chain.accounts;
  return {
    network: chain.network,
    contractId: chain.contractId,
    tokenId: chain.tokenId,
    rpcUrl: chain.rpcUrl,
    poster,
    judge,
    alice,
    bob,
    windowSecs: SANDBOX_WINDOW_SECS,
  };
}

/**
 * The testnet deployment and the accounts to sign as, read from `.env.deploy.testnet` and
 * `deployments/testnet.json` in `dir`. The windows are the network's minimum, 60 s. Throws, naming
 * what is missing, before it reads anything from the network; the keys come first, since they are
 * the owner's to provide.
 */
export async function loadTestnetTarget(dir: string = REPO_ROOT): Promise<Target> {
  const env = loadEnv("testnet", { required: TESTNET_KEYS, dir });
  const { contract, tusdc } = await readDeployment(dir);
  return {
    network: "testnet",
    contractId: contract,
    tokenId: tusdc,
    poster: { accountId: env.POSTER_ACCOUNT, privateKey: env.POSTER_FULL_ACCESS_KEY },
    judge: { accountId: env.JUDGE_ACCOUNT, privateKey: env.JUDGE_FULL_ACCESS_KEY },
    alice: { accountId: env.AGENT_ANALYST_ACCOUNT, privateKey: env.AGENT_ANALYST_FULL_ACCESS_KEY },
    bob: { accountId: env.AGENT_CODER_ACCOUNT, privateKey: env.AGENT_CODER_FULL_ACCESS_KEY },
    windowSecs: NETWORKS.testnet.minWindowSecs,
  };
}

/** The Tender contract and the test token in `deployments/testnet.json`. */
async function readDeployment(dir: string): Promise<{ contract: string; tusdc: string }> {
  const file = join(dir, "deployments", "testnet.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${file} does not exist: deploy to testnet first (pnpm deploy:testnet)`, {
        cause: error,
      });
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON`, { cause: error });
  }
  const contract = stringAt(json, ["contract"]);
  const tusdc = stringAt(json, ["tokens", "tusdc"]);
  if (contract === undefined || tusdc === undefined) {
    throw new Error(`${file} has no "contract" and "tokens.tusdc"; deploy to testnet again`);
  }
  return { contract, tusdc };
}

/** The non-empty string at `path` in a parsed JSON value, if there is one. */
function stringAt(value: unknown, path: readonly string[]): string | undefined {
  let at = value;
  for (const key of path) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return typeof at === "string" && at !== "" ? at : undefined;
}

/**
 * The task, step by step. Every account sends one transaction at a time; alice and bob go side by
 * side, because they sign with different keys. After each step it reads the chain back and throws
 * if the step did not do what it should, since a line that only says a call returned would let a
 * broken loop pass.
 */
async function play(target: Target, log: (line: string) => void): Promise<SkeletonResult> {
  const { tokenId } = target;
  const clientOf = (signer: Signer) =>
    new TenderClient({
      network: target.network,
      contractId: target.contractId,
      rpcUrl: target.rpcUrl,
      signer,
    });
  const poster = clientOf(target.poster);
  const judge = clientOf(target.judge);
  const alice = clientOf(target.alice);
  const bob = clientOf(target.bob);
  const aliceId = target.alice.accountId;

  // The test token mints for anyone, so the poster gets its 10 tUSDC here rather than from a
  // faucet. Alice has to be registered with the token before it will pay her: if it has not, her
  // withdrawal fails, and nothing on the contract's side shows it until then.
  await poster.send(mintCall(tokenId, target.poster.accountId, DEPOSIT));
  if ((await alice.ftStorageBalanceOf(tokenId, aliceId)) === null) {
    await alice.send(tokenStorageDepositCall(tokenId, aliceId));
  }

  const deposit = (await poster.deposit(tokenId, DEPOSIT)).events.find(
    (e) => e.event === "deposit",
  );
  if (deposit?.event !== "deposit") {
    throw new Error("Tender did not take the deposit; is the poster's storage registered with it?");
  }
  log(`DEPOSITED ${deposit.data.amount}`);

  const { min_window_secs } = await poster.getConfig();
  const windowSecs = Math.max(target.windowSecs, min_window_secs);
  const { taskId } = await poster.postTask({
    token: tokenId,
    reward: REWARD,
    briefUri: "skeleton://brief",
    briefHash: sha256Hex("skeleton brief"),
    criteriaHash: sha256Hex("skeleton criteria"),
    verifier: target.judge.accountId,
    commitSecs: windowSecs,
    revealSecs: windowSecs,
    pickSecs: windowSecs,
    fallbackSecs: windowSecs,
  });
  log(`POSTED task=${taskId}`);
  const task = await taskOf(poster, taskId);

  const entrants = [
    { client: alice, id: aliceId, ...seal(taskId, aliceId) },
    { client: bob, id: target.bob.accountId, ...seal(taskId, target.bob.accountId) },
  ];
  await Promise.all(entrants.map((e) => e.client.commit(taskId, e.commitment)));
  const committed = (await taskOf(poster, taskId)).commit_count;
  requireCount("committed", committed, entrants.length);
  log(`COMMITTED ${committed}`);

  await waitForChainTime(poster, BigInt(task.commit_deadline));
  await Promise.all(
    entrants.map((e) => e.client.reveal(taskId, e.contentHash, e.salt, `skeleton://${e.id}`)),
  );
  const revealed = (await taskOf(poster, taskId)).reveal_count;
  requireCount("revealed", revealed, entrants.length);
  log(`REVEALED ${revealed}`);

  await waitForChainTime(poster, BigInt(task.reveal_deadline));
  const vaultBefore = await alice.balanceOf(aliceId, tokenId);
  await judge.pick(
    taskId,
    [{ account: aliceId, bps: 10_000 }],
    sha256Hex("{}"),
    "skeleton://scorecard",
  );
  const { outcome } = await taskOf(poster, taskId);
  const payout =
    outcome?.kind === "picked" ? outcome.winners.find((w) => w.account === aliceId) : undefined;
  if (payout === undefined) throw new Error(`task ${taskId} did not pick ${aliceId}`);
  const paid = BigInt(payout.amount);
  const credited = (await alice.balanceOf(aliceId, tokenId)) - vaultBefore;
  if (credited !== paid) {
    throw new Error(`task ${taskId} paid alice ${paid}, but her vault rose by ${credited}`);
  }
  log(`PAID alice=${paid}`);

  const heldBefore = await alice.ftBalanceOf(tokenId, aliceId);
  const withdrawal = await alice.withdraw(tokenId, paid);
  const withdrawn = (await alice.ftBalanceOf(tokenId, aliceId)) - heldBefore;
  if (withdrawal.returnValue !== true || withdrawn !== paid) {
    const events = withdrawal.events.map((e) => e.event).join(", ");
    throw new Error(
      `alice withdrew ${withdrawn} of ${paid} (events: ${events}); is she registered with the token?`,
    );
  }
  log(`WITHDRAWN alice=${withdrawn}`);

  return { taskId, paid, withdrawn };
}

/** The test token's `mint`, which anyone may call for an account the token has registered. */
function mintCall(tokenId: string, accountId: string, amount: bigint): TenderCall {
  return {
    receiverId: tokenId,
    methodName: "mint",
    args: { account_id: accountId, amount: amount.toString() },
    gas: 15n * TGAS,
    deposit: 0n,
  };
}

/** What an entrant keeps between its commit and its reveal. */
function seal(taskId: bigint, account: string) {
  const contentHash = sha256Hex(`skeleton work of ${account}`);
  const salt = randomSalt();
  return { contentHash, salt, commitment: computeCommitment(taskId, account, contentHash, salt) };
}

async function taskOf(client: TenderClient, taskId: bigint) {
  const task = await client.getTask(taskId);
  if (task === null) throw new Error(`task ${taskId} is missing from the chain`);
  return task;
}

function requireCount(what: string, got: number, want: number): void {
  if (got !== want) throw new Error(`${got} entries ${what}, expected ${want}`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits until the last final block is at or past `targetNs`, so that every transaction sent from
 * then on runs in a block that is. It polls less often the further off the time is, which keeps a
 * 60 s testnet window to a couple of dozen requests.
 */
async function waitForChainTime(client: TenderClient, targetNs: bigint): Promise<void> {
  const msUntil = (nowNs: bigint) => Number((targetNs - nowNs) / 1_000_000n);
  let now = await client.blockTimestampNs();
  const giveUpAt = Date.now() + msUntil(now) + STALL_MS;
  while (now < targetNs) {
    if (Date.now() > giveUpAt) {
      throw new Error(`the chain's clock did not reach ${targetNs} ns; is its node still running?`);
    }
    await sleep(Math.min(Math.max(msUntil(now) / 2, 200), 5_000));
    now = await client.blockTimestampNs();
  }
}

/** What the command line prints on a failure: the code of a `TenderError`, else the message. */
export function describeFailure(error: unknown): string {
  if (error instanceof TenderError) {
    const tx = error.txHash === undefined ? "" : `\ntransaction ${error.txHash}`;
    return `skeleton failed with ${error.code}\n${error.message}${tx}`;
  }
  return `skeleton failed: ${error instanceof Error ? error.message : String(error)}`;
}

async function main(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: { network: { type: "string", default: "sandbox" } },
  });
  const { network } = values;
  if (network !== "sandbox" && network !== "testnet") {
    throw new Error(`--network must be sandbox or testnet, not ${network}`);
  }
  await runSkeleton({ network });
}

// Only when run as the script, never when a test or another script imports `runSkeleton`.
if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(describeFailure(error));
    process.exitCode = 1;
  });
}
