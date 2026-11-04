import { createHash } from "node:crypto";
import {
  commitCall,
  type PostTaskInput,
  postTaskCall,
  sha256Hex,
  U64StringSchema,
} from "@tender/shared";
import {
  Account,
  actions,
  baseEncode,
  JsonRpcProvider,
  KeyPairSigner,
  type KeyPairString,
} from "near-api-js";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  type LocalChain,
  type SignedTx,
  startLocalChain,
  TenderClient,
  TenderError,
} from "../src/index";

// What a caller can do about a send that timed out: write down the transaction's hash before it is
// sent (`hooks.beforeSend`), and ask the chain what became of it (`txStatus`), on a real node.

const REWARD = 1_000_000n;

let chain: LocalChain;
let poster: TenderClient;
let alice: TenderClient;

beforeAll(async () => {
  chain = await startLocalChain();
  const clientOf = (signer: LocalChain["accounts"]["poster"]) =>
    new TenderClient({
      network: chain.network,
      contractId: chain.contractId,
      rpcUrl: chain.rpcUrl,
      signer,
    });
  poster = clientOf(chain.accounts.poster);
  alice = clientOf(chain.accounts.alice);
  await poster.deposit(chain.tokenId, REWARD * 10n);
});

afterAll(async () => {
  await chain?.stop();
});

function taskInput(): PostTaskInput {
  return {
    token: chain.tokenId,
    reward: REWARD,
    briefUri: "ipfs://brief",
    briefHash: sha256Hex("brief"),
    criteriaHash: sha256Hex("criteria"),
    verifier: chain.accounts.judge.accountId,
    commitSecs: 5,
    revealSecs: 5,
    pickSecs: 5,
    fallbackSecs: 5,
  };
}

test("the_hook_hears_of_the_transaction_before_it_is_sent_with_the_hash_it_ends_with", async () => {
  const before = await poster.taskCount();
  const heard: SignedTx[] = [];
  const countAtHook: bigint[] = [];
  const posted = await poster.postTask(taskInput(), undefined, {
    beforeSend: async (tx) => {
      heard.push(tx);
      // Nothing is sent yet: no task has been made.
      countAtHook.push(await poster.taskCount());
    },
  });
  expect(heard).toHaveLength(1);
  const [tx] = heard;
  expect(tx?.txHash).toBe(posted.txHash);
  expect(tx?.signerId).toBe(chain.accounts.poster.accountId);
  expect(tx?.publicKey).toBe(poster.publicKey);
  expect(tx?.nonce).toBeGreaterThan(0n);
  expect(tx?.blockHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  expect(tx?.blockHeight).toBeGreaterThan(0n);
  expect(countAtHook).toEqual([before]);
  expect(await poster.taskCount()).toBe(before + 1n);
  expect(posted.taskId).toBe(before + 1n);
});

test("a_hook_that_throws_stops_the_send_and_nothing_reaches_the_chain", async () => {
  const before = await poster.taskCount();
  const failure = new Error("the journal could not be written");
  await expect(
    poster.postTask(taskInput(), undefined, {
      beforeSend: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(await poster.taskCount()).toBe(before);
});

test("txStatus_of_a_transaction_that_succeeded_has_its_result_and_the_new_task_s_id", async () => {
  let hash = "";
  const posted = await poster.postTask(taskInput(), undefined, {
    beforeSend: async (tx) => {
      hash = tx.txHash;
    },
  });
  const status = await poster.txStatus(hash);
  expect(status.kind).toBe("executed");
  if (status.kind !== "executed") return;
  expect(status.result.txHash).toBe(posted.txHash);
  expect(BigInt(U64StringSchema.parse(status.result.returnValue))).toBe(posted.taskId);
});

test("txStatus_of_a_transaction_that_failed_has_the_contract_s_code", async () => {
  const taskId = (await poster.postTask(taskInput())).taskId;
  let hash = "";
  // The poster may not enter its own task: the contract panics with E_AUTH.
  const sent = poster.send(commitCall(chain.contractId, taskId, sha256Hex("x")), {
    beforeSend: async (tx) => {
      hash = tx.txHash;
    },
  });
  await expect(sent).rejects.toBeInstanceOf(TenderError);
  const status = await poster.txStatus(hash);
  expect(status.kind).toBe("failed");
  if (status.kind !== "failed") return;
  expect(status.error.code).toBe("E_AUTH");
});

test("txStatus_of_a_hash_the_node_never_saw_is_unknown", async () => {
  const never = baseEncode(new Uint8Array(32).fill(7));
  expect(await poster.txStatus(never)).toEqual({ kind: "unknown" });
});

test("a_transaction_that_loses_its_nonce_is_signed_again_and_the_hook_hears_of_both", async () => {
  // Two clients of one key each count the nonce for themselves. `second` sends once (its count is
  // now at n), `first` sends (n + 1 is taken on chain), and `second` sends again with a nonce the
  // chain has passed: the node refuses it, the client signs a new one, and the hook hears of both.
  const second = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer: chain.accounts.poster,
  });
  await second.postTask(taskInput());
  await poster.postTask(taskInput());
  const heard: SignedTx[] = [];
  const posted = await second.postTask(taskInput(), undefined, {
    beforeSend: async (tx) => {
      heard.push(tx);
    },
  });
  expect(heard.length).toBeGreaterThanOrEqual(2);
  expect(new Set(heard.map((tx) => tx.txHash)).size).toBe(heard.length);
  expect(heard.at(-1)?.txHash).toBe(posted.txHash);
  // The first was refused: the node never had it, and it cannot be included later.
  const refused = heard[0];
  expect(refused?.nonce).toBeLessThan(heard.at(-1)?.nonce ?? 0n);
  expect((await poster.txStatus(refused?.txHash ?? "")).kind).toBe("unknown");
});

test("alice_s_status_needs_alice_s_account_not_the_poster_s", async () => {
  // A status is asked by hash and signer. A client says whose with the second argument.
  let hash = "";
  await alice.deposit(chain.tokenId, REWARD);
  const aliceTask = await alice.postTask(taskInput(), undefined, {
    beforeSend: async (tx) => {
      hash = tx.txHash;
    },
  });
  expect((await poster.txStatus(hash, chain.accounts.alice.accountId)).kind).toBe("executed");
  expect(aliceTask.taskId).toBeGreaterThan(0n);
});

test("txStatus_of_a_transaction_on_its_way_is_never_a_failure_and_ends_executed", async () => {
  // Sent without waiting for anything, as a client that timed out would have left it.
  await alice.deposit(chain.tokenId, REWARD);
  const account = new Account(
    chain.accounts.alice.accountId,
    new JsonRpcProvider({ url: chain.rpcUrl }),
    KeyPairSigner.fromSecretKey(chain.accounts.alice.privateKey as KeyPairString),
  );
  const call = postTaskCall(chain.contractId, taskInput());
  const signed = await account.createSignedTransaction({
    receiverId: chain.contractId,
    actions: [actions.functionCall(call.methodName, call.args, call.gas, call.deposit)],
  });
  // A transaction's hash is the SHA-256 of its unsigned body.
  const txHash = baseEncode(createHash("sha256").update(signed.transaction.encode()).digest());
  const before = await alice.taskCount();
  await account.provider.sendTransactionUntil(signed, "NONE");
  const seen = new Set<string>();
  const started = Date.now();
  for (;;) {
    const status = await alice.txStatus(txHash);
    seen.add(status.kind);
    if (status.kind === "executed") break;
    expect(["unknown", "pending"]).toContain(status.kind);
    if (Date.now() - started > 60_000) throw new Error(`still ${status.kind} after a minute`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(await alice.taskCount()).toBe(before + 1n);
  expect(seen.has("failed")).toBe(false);
});
