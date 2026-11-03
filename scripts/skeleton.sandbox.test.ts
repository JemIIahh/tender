import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type LocalChain, startLocalChain, TenderClient } from "@tender/client";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { runSkeleton } from "./skeleton";

// Every chain started while this file runs, the ones `runSkeleton` starts for itself included.
const started = vi.hoisted((): LocalChain[] => []);
vi.mock("@tender/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tender/client")>();
  return {
    ...actual,
    async startLocalChain(...args: Parameters<typeof actual.startLocalChain>) {
      const chain = await actual.startLocalChain(...args);
      started.push(chain);
      return chain;
    },
  };
});

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TGAS = 1_000_000_000_000n;

/** The six lines for task `taskId`, with the amounts of a reward of 1_000_000 at a 5% fee. */
const linesFor = (taskId: bigint) => [
  "DEPOSITED 10000000",
  `POSTED task=${taskId}`,
  "COMMITTED 2",
  "REVEALED 2",
  "PAID alice=950000",
  "WITHDRAWN alice=950000",
];

const clientOf = (chain: LocalChain, role: keyof LocalChain["accounts"]) =>
  new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer: chain.accounts[role],
  });

/** One chain for the tests that give `runSkeleton` a chain; each runs the skeleton on it once. */
let shared: LocalChain;
/** The id the next task on the shared chain gets. */
const nextTaskId = async () => (await clientOf(shared, "keeper").taskCount()) + 1n;

beforeAll(async () => {
  shared = await startLocalChain();
});

afterAll(async () => {
  await shared?.stop();
});

/** Whether a node answers at the chain's RPC URL. */
async function isUp(chain: LocalChain): Promise<boolean> {
  try {
    const response = await fetch(chain.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "probe", method: "status", params: [] }),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

test("skeleton_sandbox_pays_and_withdraws", async () => {
  const lines: string[] = [];
  const before = started.length;

  const result = await runSkeleton({ network: "sandbox", log: (line) => lines.push(line) });

  // A reward of 1_000_000 less the 5% fee, paid to alice and then withdrawn to her token balance.
  expect(result).toEqual({ taskId: 1n, paid: 950_000n, withdrawn: 950_000n });
  expect(lines).toEqual(linesFor(1n));
  // It started a chain of its own for this, and stopped it again.
  const own = started.slice(before);
  expect(own).toHaveLength(1);
  for (const chain of own) expect(await isUp(chain)).toBe(false);
});

test("skeleton_runs_on_a_given_chain_and_leaves_it_running", async () => {
  const lines: string[] = [];
  const before = started.length;
  const taskId = await nextTaskId();

  const result = await runSkeleton({
    network: "sandbox",
    chain: shared,
    log: (line) => lines.push(line),
  });

  expect(result).toEqual({ taskId, paid: 950_000n, withdrawn: 950_000n });
  expect(lines).toEqual(linesFor(taskId));
  expect(started).toHaveLength(before);
  expect(await isUp(shared)).toBe(true);
  // What it did is on that chain: a task of the poster and the judge, picked for alice.
  const { accounts } = shared;
  expect(await clientOf(shared, "keeper").getTask(taskId)).toMatchObject({
    poster: accounts.poster.accountId,
    verifier: accounts.judge.accountId,
    commit_count: 2,
    reveal_count: 2,
    outcome: {
      kind: "picked",
      fee: "50000",
      winners: [{ account: accounts.alice.accountId, bps: 10_000, amount: "950000" }],
    },
  });
  // Both entrants are active agents with the bond the contract names, which they registered with
  // before the task was posted: an open task takes no one else.
  for (const role of ["alice", "bob"] as const) {
    expect(await clientOf(shared, "keeper").getAgent(accounts[role].accountId), role).toMatchObject(
      {
        status: "active",
        bond_token: shared.tokenId,
        bond_amount: "1000000",
        claimable_at: null,
      },
    );
  }
});

test("skeleton_registers_alice_with_the_token_when_nobody_has", async () => {
  // As may be so on testnet, where the deploy registers Tender with the test token but not
  // necessarily the agents. A forced unregister frees the account's storage deposit and burns its
  // tokens.
  const alice = clientOf(shared, "alice");
  const { accountId } = shared.accounts.alice;
  await alice.send({
    receiverId: shared.tokenId,
    methodName: "storage_unregister",
    args: { force: true },
    gas: 30n * TGAS,
    deposit: 1n,
  });
  expect(await alice.ftStorageBalanceOf(shared.tokenId, accountId)).toBeNull();

  const lines: string[] = [];
  const taskId = await nextTaskId();
  const result = await runSkeleton({
    network: "sandbox",
    chain: shared,
    log: (line) => lines.push(line),
  });

  // Paid and withdrawn in full, although the token had not registered her.
  expect(result).toEqual({ taskId, paid: 950_000n, withdrawn: 950_000n });
  expect(lines).toEqual(linesFor(taskId));
  expect(await alice.ftStorageBalanceOf(shared.tokenId, accountId)).not.toBeNull();
  expect(await alice.ftBalanceOf(shared.tokenId, accountId)).toBe(950_000n);
  // She was an active agent from the run before, so this one took no second bond.
  expect(await alice.getAgent(accountId)).toMatchObject({
    status: "active",
    bond_amount: "1000000",
  });
});

test("skeleton_cli_prints_the_six_lines_and_exits_zero", async () => {
  // The way `pnpm skeleton` runs it. Nothing but the six lines may reach stdout.
  const { stdout } = await run(
    process.execPath,
    ["--import", "tsx", "scripts/skeleton.ts", "--network", "sandbox"],
    { cwd: ROOT, timeout: 150_000 },
  );
  expect(stdout.trimEnd().split("\n")).toEqual(linesFor(1n));
});
