import { computeCommitment, type PostTaskInput, randomSalt, sha256Hex } from "@tender/shared";
import { Account, actions, type KeyPairString } from "near-api-js";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { KeyQueue, type LocalChain, startLocalChain, TenderClient } from "../src/index";

type Role = keyof LocalChain["accounts"];

const REWARD = 1_000_000n;
const TASKS = 5;

let chain: LocalChain;

beforeAll(async () => {
  // Alice enters open tasks, which take only registered agents.
  chain = await startLocalChain({ registerAgents: ["alice"] });
});

afterAll(async () => {
  await chain?.stop();
});

/** A new client of `role`, with its own near-api-js account and so its own nonce cache. */
const clientOf = (role: Role) =>
  new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer: chain.accounts[role],
  });

/** A task judged by the judge. Its windows are long, so that no commit here comes too late. */
function taskInput(): PostTaskInput {
  return {
    token: chain.tokenId,
    reward: REWARD,
    briefUri: "ipfs://brief",
    briefHash: sha256Hex("brief"),
    criteriaHash: sha256Hex("criteria"),
    verifier: chain.accounts.judge.accountId,
    commitSecs: 600,
    revealSecs: 600,
    pickSecs: 600,
    fallbackSecs: 600,
  };
}

/**
 * Runs `body` and counts the transactions it sends, and the most that were in flight at once.
 * near-api-js sends each transaction as one `send_tx` request through the global `fetch`, and sends
 * it again each time it retries one.
 */
async function countSends<T>(body: () => Promise<T>) {
  const realFetch = globalThis.fetch;
  const counts = { sent: 0, mostAtOnce: 0 };
  let inFlight = 0;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (typeof init?.body !== "string" || JSON.parse(init.body).method !== "send_tx") {
      return realFetch(input, init);
    }
    counts.sent++;
    counts.mostAtOnce = Math.max(counts.mostAtOnce, ++inFlight);
    try {
      return await realFetch(input, init);
    } finally {
      inFlight--;
    }
  });
  try {
    const result = await body();
    return { result, ...counts };
  } finally {
    spy.mockRestore();
  }
}

test("five_concurrent_commits_from_one_key_all_land", async () => {
  const poster = clientOf("poster");
  await poster.deposit(chain.tokenId, BigInt(TASKS) * REWARD);
  // The poster's five posts go at once too, and the queue takes them one at a time.
  const posted = await Promise.all(
    Array.from({ length: TASKS }, () => poster.postTask(taskInput())),
  );
  const taskIds = posted.map((p) => p.taskId);
  expect(new Set(taskIds).size).toBe(TASKS);

  // Five clients of alice's one key, each sending its first transaction at the same moment. Each
  // reads the key's nonce from the chain and would sign with the same one, which is how the plan 01
  // harness lost transactions; the queue sends them one after another instead.
  const alice = chain.accounts.alice.accountId;
  const { result, sent, mostAtOnce } = await countSends(() =>
    Promise.all(
      taskIds.map((id) =>
        clientOf("alice").commit(
          id,
          computeCommitment(id, alice, sha256Hex(`work for ${id}`), randomSalt()),
        ),
      ),
    ),
  );
  for (const committed of result) {
    expect(committed.events.map((e) => e.event)).toEqual(["committed"]);
  }
  for (const id of taskIds) {
    expect((await poster.getTask(id))?.commit_count, `task ${id}`).toBe(1);
  }
  // Serialised, not retried: one request per transaction, and never two of them in flight.
  expect(sent).toBe(TASKS);
  expect(mostAtOnce).toBe(1);
});

test("a_nonce_collision_with_another_process_is_retried_once", async () => {
  // Two processes that sign with bob's one key: each has its own queue, so nothing orders their
  // sends, and both sign their first transaction with the nonce they read. near-api-js's own
  // retries are off, so the transaction that loses gets only the queue's retry. The amounts
  // differ, because the chain runs two identical transactions once and answers both.
  const { accountId, privateKey } = chain.accounts.bob;
  const transfer = (queue: KeyQueue, amount: bigint) =>
    queue.run(accountId, () =>
      new Account(accountId, chain.rpcUrl, privateKey as KeyPairString).signAndSendTransaction({
        receiverId: accountId,
        actions: [actions.transfer(amount)],
        waitUntil: "FINAL",
        retries: 0,
      }),
    );
  const { result, sent } = await countSends(() =>
    Promise.all([transfer(new KeyQueue(), 1n), transfer(new KeyQueue(), 2n)]),
  );
  expect(result.map((outcome) => outcome.status)).toEqual([
    { SuccessValue: "" },
    { SuccessValue: "" },
  ]);
  // The two first tries, and the loser once more.
  expect(sent).toBe(3);
});
