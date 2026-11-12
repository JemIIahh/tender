import {
  commitCall,
  computeCommitment,
  implicitAccountOf,
  type PostTaskInput,
  parseEventLog,
  postTaskCall,
  randomSalt,
  sha256Hex,
  type TenderCall,
  withdrawCall,
} from "@tender/shared";
import { Account, actions, KeyPair, type KeyPairString } from "near-api-js";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  LOCAL_AGENT_BOND,
  type LocalChain,
  registerLocalAgent,
  registerWithBond,
  sendRefused,
  startLocalChain,
  TenderClient,
  TenderError,
  type TxResult,
} from "../src/index";

// One chain for the whole file: each test posts its own tasks, and the balance checks compare
// before and after. Sends from one signer go one at a time; concurrent sends use different
// signers, because two first transactions from one key can get the same nonce.

type Role = keyof LocalChain["accounts"];

const REWARD = 1_000_000n;
const LOCAL_BOND = LOCAL_AGENT_BOND;
const TGAS = 1_000_000_000_000n;
/** An account that exists nowhere, so no token has registered it. */
const NOBODY = "nobody.sandbox";
const EVENT_PREFIX = "EVENT_JSON:";

let chain: LocalChain;
let clients: Record<Role, TenderClient>;

const id = (role: Role) => chain.accounts[role].accountId;
const names = (result: TxResult) => result.events.map((e) => e.event);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  chain = await startLocalChain();
  clients = Object.fromEntries(
    Object.entries(chain.accounts).map(([role, signer]) => [
      role,
      new TenderClient({
        network: chain.network,
        contractId: chain.contractId,
        rpcUrl: chain.rpcUrl,
        signer,
      }),
    ]),
  ) as Record<Role, TenderClient>;
});

afterAll(async () => {
  await chain?.stop();
});

/** A task in the local token, judged by the judge, with four windows of the chain's minimum. */
function taskInput(): PostTaskInput {
  return {
    token: chain.tokenId,
    reward: REWARD,
    briefUri: "ipfs://brief",
    briefHash: sha256Hex("brief"),
    criteriaHash: sha256Hex("criteria"),
    verifier: id("judge"),
    commitSecs: 5,
    revealSecs: 5,
    pickSecs: 5,
    fallbackSecs: 5,
  };
}

/** Funds the poster's vault and posts `taskInput()`. */
async function postTask() {
  await clients.poster.deposit(chain.tokenId, REWARD);
  const posted = await clients.poster.postTask(taskInput());
  const task = await clients.poster.getTask(posted.taskId);
  if (task === null) throw new Error(`task ${posted.taskId} is missing right after posting`);
  return { posted, task };
}

/** What an entrant keeps between its commit and its reveal. */
function seal(taskId: bigint, account: string, work: string) {
  const contentHash = sha256Hex(work);
  const salt = randomSalt();
  return { contentHash, salt, commitment: computeCommitment(taskId, account, contentHash, salt) };
}

/** Waits until the last final block is at or past `ns`, so the next block is too. */
async function waitForChainTime(ns: string) {
  while ((await clients.keeper.blockTimestampNs()) < BigInt(ns)) await sleep(200);
}

/** The TenderError that `call` fails with. Any other outcome fails the test. */
async function failure(call: Promise<unknown>): Promise<TenderError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof TenderError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

/**
 * The drift guard. Every log of every receipt is a Tender event that `parseEventLog` reads, or a
 * log of the token. And the parsed data is the logged data, key for key: the schemas drop keys
 * they do not know, so a field the contract added would otherwise go unnoticed.
 */
function expectEveryLogAccountedFor(result: TxResult) {
  for (const { executorId, logs } of result.receipts) {
    if (executorId === chain.tokenId) continue;
    for (const line of logs) {
      const event = parseEventLog(line);
      expect(event, `a log on ${executorId} that is not a Tender event: ${line}`).not.toBeNull();
      const logged = JSON.parse(line.slice(EVENT_PREFIX.length));
      expect(event?.data, `the schema changed the data of ${line}`).toStrictEqual(logged.data[0]);
    }
  }
}

test("local_chain_boots_and_reads_config", async () => {
  const config = await clients.keeper.getConfig();
  expect(config.fee_bps).toBe(500);
  expect(config.min_window_secs).toBe(5);
  expect(config.owner).toBe(id("owner"));
  expect(config.treasury).toBe(id("treasury"));
  expect(config.tokens).toEqual([
    { token: chain.tokenId, min_reward: "1", max_reward: "1000000000000", enabled: true },
  ]);
  // The first test, so nobody has spent any yet: the poster holds the supply, the others the mint.
  for (const role of ["poster", "alice", "bob", "lead"] as const) {
    expect(await clients.keeper.ftBalanceOf(chain.tokenId, id(role)), role).toBe(10n ** 12n);
  }
  for (const role of Object.keys(chain.accounts) as Role[]) {
    expect(await clients.keeper.storageBalanceOf(id(role)), role).not.toBeNull();
    expect(await clients.keeper.ftStorageBalanceOf(chain.tokenId, id(role)), role).not.toBeNull();
  }
  expect(await clients.keeper.ftStorageBalanceOf(chain.tokenId, chain.contractId)).not.toBeNull();
});

test("full_flow_through_client", async () => {
  const { poster, alice, bob, judge } = clients;
  // Open tasks take entries only from registered agents, each with the bond.
  await Promise.all([registerLocalAgent(chain, "alice"), registerLocalAgent(chain, "bob")]);

  const deposited = await poster.deposit(chain.tokenId, REWARD);
  expect(names(deposited)).toEqual(["deposit"]);
  const posted = await poster.postTask(taskInput());
  expect(names(posted)).toEqual(["task_created"]);
  const taskId = posted.taskId;
  const task = await poster.getTask(taskId);
  if (task === null) throw new Error("the posted task is missing");
  expect(task.verifier).toBe(id("judge"));

  const sealedA = seal(taskId, id("alice"), "alice's work");
  const sealedB = seal(taskId, id("bob"), "bob's work");
  const commits = await Promise.all([
    alice.commit(taskId, sealedA.commitment),
    bob.commit(taskId, sealedB.commitment),
  ]);
  for (const committed of commits) expect(names(committed)).toEqual(["committed"]);

  await waitForChainTime(task.commit_deadline);
  const reveals = await Promise.all([
    alice.reveal(taskId, sealedA.contentHash, sealedA.salt, "ipfs://alice"),
    bob.reveal(taskId, sealedB.contentHash, sealedB.salt, "ipfs://bob"),
  ]);
  for (const revealed of reveals) expect(names(revealed)).toEqual(["revealed"]);

  await waitForChainTime(task.reveal_deadline);
  const picked = await judge.pick(
    taskId,
    [{ account: id("alice"), bps: 10_000 }],
    sha256Hex("{}"),
    "ipfs://scorecard",
  );
  expect(names(picked)).toEqual(["picked"]);
  const paid = (REWARD * 95n) / 100n;
  expect(picked.events[0]).toMatchObject({
    data: { winners: [{ account: id("alice"), bps: 10_000, amount: paid.toString() }] },
  });

  const before = await alice.ftBalanceOf(chain.tokenId, id("alice"));
  const withdrawn = await alice.withdraw(chain.tokenId, paid);
  expect(names(withdrawn)).toEqual(["withdraw"]);
  expect(withdrawn.returnValue).toBe(true);
  const after = await alice.ftBalanceOf(chain.tokenId, id("alice"));
  expect(after - before).toBe((REWARD * 95n) / 100n);

  for (const result of [deposited, posted, ...commits, ...reveals, picked, withdrawn]) {
    expectEveryLogAccountedFor(result);
  }
});

test("contract_errors_map_to_codes", async () => {
  const { poster, alice } = clients;
  const { posted } = await postTask();
  const taskId = posted.taskId;

  // A code the contract panics with.
  const commitment = seal(taskId, id("poster"), "the poster's own work").commitment;
  const auth = await failure(poster.commit(taskId, commitment));
  expect(auth.code).toBe("E_AUTH");
  expect(auth.message).toContain("E_AUTH: the poster and the verifier cannot enter task");
  expect(auth.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);

  // The texts of near-sdk's generated wrappers, each through `send` with a hand-built call.
  const { task } = postTaskCall(chain.contractId, taskInput()).args as {
    task: Record<string, unknown>;
  };
  const { verifier, ...rest } = task;
  const misspelled: TenderCall = {
    ...postTaskCall(chain.contractId, taskInput()),
    args: { task: { ...rest, verifer: verifier } },
  };
  const cases: Array<[TenderClient, TenderCall, string, string]> = [
    [poster, misspelled, "E_ARGS", "Failed to deserialize input from JSON"],
    [
      alice,
      { ...commitCall(chain.contractId, taskId, commitment), deposit: 1n },
      "E_ARGS",
      "Method commit doesn't accept deposit",
    ],
    [
      alice,
      { ...withdrawCall(chain.contractId, chain.tokenId, 1n), deposit: 0n },
      "E_AUTH",
      "Requires attached deposit of exactly 1 yoctoNEAR",
    ],
    [
      alice,
      {
        receiverId: chain.contractId,
        methodName: "new",
        args: { owner: id("alice"), treasury: id("alice"), fee_bps: 0, min_window_secs: 5 },
        gas: 30n * TGAS,
        deposit: 0n,
      },
      "E_AUTH",
      "Method new is private",
    ],
    [
      alice,
      {
        receiverId: chain.tokenId,
        methodName: "new",
        args: { owner_id: id("alice"), total_supply: "1" },
        gas: 30n * TGAS,
        deposit: 0n,
      },
      "E_INITIALIZED",
      "The contract has already been initialized",
    ],
  ];
  for (const [client, call, code, text] of cases) {
    const error = await failure(client.send(call));
    expect(error.code, error.message).toBe(code);
    expect(error.message).toContain(text);
    expect(error.txHash).toBeTypeOf("string");
  }
  expect(await poster.taskCount()).toBe(taskId);
});

test("withdraw_to_unregistered_yields_withdraw_failed_only", async () => {
  const { alice } = clients;
  const amount = 12_345n;
  await alice.deposit(chain.tokenId, amount);
  const before = await alice.balanceOf(id("alice"), chain.tokenId);
  expect(before).toBeGreaterThanOrEqual(amount);

  const result = await alice.withdraw(chain.tokenId, amount, NOBODY);
  expect(names(result)).toEqual(["withdraw_failed"]);
  expect(result.events[0]).toMatchObject({
    data: { account: id("alice"), token: chain.tokenId, amount: amount.toString(), to: NOBODY },
  });
  // `on_withdraw` returns whether the token paid.
  expect(result.returnValue).toBe(false);
  // The token's `ft_transfer` is the receipt that failed.
  expect(result.receipts.filter((r) => r.status === "failure").map((r) => r.executorId)).toEqual([
    chain.tokenId,
  ]);
  expect(await alice.balanceOf(id("alice"), chain.tokenId)).toBe(before);
  expectEveryLogAccountedFor(result);
});

test("views_return_string_numbers", async () => {
  const { keeper, lead } = clients;
  const { posted, task } = await postTask();
  const above2to53 = (value: string) => BigInt(value) > 2n ** 53n;

  // u64 and u128 values arrive as decimal strings, so nanosecond times keep every digit.
  expect(task.id).toBe(posted.taskId.toString());
  expect(task.reward).toBe(REWARD.toString());
  for (const time of [task.created_at, task.commit_deadline, task.fallback_deadline]) {
    expect(time).toBeTypeOf("string");
    expect(above2to53(time)).toBe(true);
  }
  // u8, u16 and u32 values are JSON numbers.
  expect(task.fee_bps).toBe(500);
  expect(task.commit_count).toBe(0);
  expect(await keeper.getTasks(posted.taskId, 1)).toEqual([task]);

  // Amounts and counts the client returns as bigints.
  expect(await keeper.taskCount()).toBeGreaterThanOrEqual(posted.taskId);
  expect(await keeper.balanceOf(id("treasury"), chain.tokenId)).toBeTypeOf("bigint");
  expect(await keeper.finalHeight()).toBeTypeOf("bigint");
  expect((await keeper.blockTimestampNs()) > 2n ** 53n).toBe(true);

  const storage = await keeper.storageBalanceOf(id("poster"));
  expect(storage?.total).toBe("100000000000000000000000");
  expect(storage?.used_bytes).toBeTypeOf("string");
  // A later storage deposit has no minimum.
  const toppedUp = await keeper.storageDeposit(10n ** 21n);
  expect(names(toppedUp)).toEqual(["storage_deposit"]);
  expectEveryLogAccountedFor(toppedUp);
  expect((await keeper.storageBalanceOf(id("keeper")))?.total).toBe("101000000000000000000000");
  expect(await keeper.ftStorageBalanceOf(chain.tokenId, id("poster"))).toEqual({
    total: "1250000000000000000000",
    available: "0",
  });

  // Lead registers here, for the first time: the bond comes out of the vault that the client moves
  // it into first, so the registration is `agent_registered` and then `agent_bonded`.
  const registration = await registerWithBond(
    lead,
    { uri: "ipfs://lead-profile", hash: sha256Hex("lead"), tags: ["analysis"] },
    { approve: () => true },
  );
  expect(names(registration.tx)).toEqual(["agent_registered", "agent_bonded"]);
  expectEveryLogAccountedFor(registration.tx);
  const agent = await keeper.getAgent(id("lead"));
  expect(agent?.profile_uri).toBe("ipfs://lead-profile");
  expect(agent).toMatchObject({
    status: "active",
    bond_token: chain.tokenId,
    bond_amount: LOCAL_BOND.toString(),
    claimable_at: null,
    locked_until: null,
  });
  expect(above2to53(agent?.registered_at ?? "0")).toBe(true);

  const sealed = seal(posted.taskId, id("lead"), "work");
  await lead.commit(posted.taskId, sealed.commitment);
  // An entry in an open task holds the agent's bond until the task's commit deadline.
  expect((await keeper.getAgent(id("lead")))?.locked_until).toBe(task.commit_deadline);
  const entry = await keeper.getEntry(posted.taskId, id("lead"));
  expect(entry?.committed_at_block).toBeTypeOf("string");
  expect(entry?.commitment).toBe(sealed.commitment);

  // A view that finds nothing gives null, not a parse error.
  expect(await keeper.getTask(10n ** 18n)).toBeNull();
  expect(await keeper.getEntry(posted.taskId, NOBODY)).toBeNull();
  expect(await keeper.getAgent(NOBODY)).toBeNull();
  expect(await keeper.storageBalanceOf(NOBODY)).toBeNull();
  expect(await keeper.ftStorageBalanceOf(chain.tokenId, NOBODY)).toBeNull();
  expect(await keeper.balanceOf(NOBODY, chain.tokenId)).toBe(0n);
  expect(await keeper.ftBalanceOf(chain.tokenId, NOBODY)).toBe(0n);
});

test("get_all_entries_skips_what_cleanup_removed", async () => {
  const { alice, bob, lead, keeper } = clients;
  const { posted, task } = await postTask();
  const taskId = posted.taskId;
  // Alice and bob registered in the full flow, and lead in the views test.
  await Promise.all(
    [alice, bob, lead].map((c) =>
      c.commit(taskId, seal(taskId, c.accountId ?? "", "unrevealed").commitment),
    ),
  );
  const entered = await keeper.getAllEntries(taskId);
  expect(entered.map((e) => e.index)).toEqual([0, 1, 2]);

  // Nobody reveals, so once the reveal window is over anyone can void the task.
  await waitForChainTime(task.reveal_deadline);
  const voided = await keeper.voidTask(taskId);
  expect(voided.events).toMatchObject([{ event: "voided", data: { reason: "no_reveals" } }]);
  expectEveryLogAccountedFor(voided);
  const cleaned = await keeper.cleanup(taskId, 1);
  expect(cleaned.returnValue).toBe(1);

  const left = await keeper.getAllEntries(taskId);
  expect(left).toEqual(entered.slice(1));
  expect(await keeper.getEntry(taskId, entered[0]?.account ?? "")).toBeNull();
  expect(await keeper.getTask(taskId)).toMatchObject({ commit_count: 3, cleaned: 1 });
});

test("view_access_key_passes_the_permission_through", async () => {
  const { keeper } = clients;
  const alice = chain.accounts.alice;
  const own = KeyPair.fromString(alice.privateKey as KeyPairString)
    .getPublicKey()
    .toString();
  expect(await keeper.viewAccessKey(alice.accountId, own)).toEqual({ permission: "FullAccess" });

  const stranger = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  expect(await keeper.viewAccessKey(alice.accountId, stranger)).toBeNull();
  expect(await keeper.viewAccessKey(NOBODY, stranger)).toBeNull();

  // A function-call key comes back exactly as the RPC shows it, allowance included, although
  // KeyPermission does not name the allowance. Added with near-api-js, waiting for finality,
  // because viewAccessKey reads the last final block.
  const functionCall = KeyPair.fromRandom("ed25519").getPublicKey();
  const account = new Account(alice.accountId, chain.rpcUrl, alice.privateKey as KeyPairString);
  await account.signAndSendTransaction({
    receiverId: alice.accountId,
    actions: [
      actions.addFunctionCallAccessKey(
        functionCall,
        chain.contractId,
        ["commit", "reveal"],
        10n ** 24n,
      ),
    ],
    waitUntil: "FINAL",
  });
  expect(await keeper.viewAccessKey(alice.accountId, functionCall.toString())).toEqual({
    permission: {
      FunctionCall: {
        allowance: "1000000000000000000000000",
        receiver_id: chain.contractId,
        method_names: ["commit", "reveal"],
      },
    },
  });
});

test("a_transfer_creates_an_implicit_account_with_the_amount", async () => {
  const NEAR = 10n ** 24n;
  const sender = clients.treasury;
  const implicit = implicitAccountOf(KeyPair.fromRandom("ed25519").getPublicKey().toString());
  if (implicit === null) throw new Error("a fresh ed25519 key has no implicit account");
  // Nobody has sent it NEAR, so it is not on chain, and holds nothing.
  expect(await sender.nearBalanceOf(implicit)).toBe(0n);
  const before = await sender.nearBalanceOf(id("treasury"));

  const result = await sender.transfer(implicit, NEAR / 10n);
  expect(result.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  expect(result.events).toEqual([]);
  // `transfer` waits until it has executed, not until that block is final: the final view catches
  // up within a few blocks.
  const giveUpAt = Date.now() + 15_000;
  while ((await sender.nearBalanceOf(implicit)) === 0n && Date.now() < giveUpAt) await sleep(200);
  expect(await sender.nearBalanceOf(implicit)).toBe(NEAR / 10n);
  // The sender paid the amount and a little gas.
  const after = await sender.nearBalanceOf(id("treasury"));
  expect(before - after).toBeGreaterThan(NEAR / 10n);
  expect(before - after).toBeLessThan(NEAR / 10n + NEAR / 100n);

  // More than the sender holds is refused by the node: nothing runs, and the error says so for
  // certain (`sendRefused`), as near-api-js reports it from a real node.
  const refused = await sender.transfer(implicit, after + NEAR).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(refused).toBeInstanceOf(Error);
  expect(sendRefused(refused)).toBe(true);
  expect(await sender.nearBalanceOf(implicit)).toBe(NEAR / 10n);
});
