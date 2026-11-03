import {
  depositCall,
  type PostTaskInput,
  postTaskCall,
  storageDepositCall,
  storageWithdrawCall,
  TenderEventSchema,
  tokenStorageDepositCall,
  withdrawCall,
} from "@tender/shared";
import { expect, test } from "vitest";
import { FakeChain, NEAR, type WalletAction } from "./fakeChain";
import { chainWallet } from "./walletDoubles";

// The model that the wallet tests run on (test/fakeChain.ts) is held to what the contract does, so
// that a test that passes on it says something about the page. Each rule here is one the contract
// source states: contract/tender/src/vault.rs, storage.rs, ft.rs and tasks.rs.

const CONTRACT = "tender.testnet";
const TOKEN = "tusdc.testnet";
const ALICE = "alice.testnet";

const actionOf = (call: ReturnType<typeof withdrawCall>): WalletAction => ({
  type: "FunctionCall",
  params: {
    methodName: call.methodName,
    args: call.args,
    gas: call.gas.toString(),
    deposit: call.deposit.toString(),
  },
});

/** Sends each call as a transaction of its own, as ALICE, and gives the outcomes. */
function sendAll(chain: FakeChain, calls: Array<ReturnType<typeof withdrawCall>>) {
  return chain.send(
    ALICE,
    calls.map((call) => ({ receiverId: call.receiverId, actions: [actionOf(call)] })),
  );
}

const eventsOf = (outcomes: ReturnType<FakeChain["send"]>) =>
  outcomes
    .flatMap((o) => o.receipts_outcome.flatMap((r) => r.outcome.logs))
    .map((line) => {
      const parsed = JSON.parse(line.slice("EVENT_JSON:".length));
      return parsed.event as string;
    });

test("a_first_storage_deposit_below_the_minimum_is_refused_and_leaves_nothing_behind", () => {
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);

  const [low] = sendAll(chain, [storageDepositCall(CONTRACT, NEAR(0.005))]);
  expect("Failure" in (low?.status ?? {})).toBe(true);
  expect(JSON.stringify(low?.status)).toContain("E_MIN_DEPOSIT");
  expect(chain.view(CONTRACT, "storage_balance_of", { account_id: ALICE })).toBeNull();

  const [ok] = sendAll(chain, [storageDepositCall(CONTRACT, NEAR(0.05))]);
  expect("SuccessValue" in (ok?.status ?? {})).toBe(true);
  expect(chain.view(CONTRACT, "storage_balance_of", { account_id: ALICE })).toMatchObject({
    total: NEAR(0.05).toString(),
  });
});

test("a_panic_undoes_what_the_same_transaction_did_before_it", () => {
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.give(TOKEN, ALICE, 10n);

  // One transaction with two calls to the token: the second panics, so the first is undone too.
  const bad = tokenStorageDepositCall(TOKEN, "bob.testnet");
  const worse = depositCall(TOKEN, CONTRACT, 99n);
  const [outcome] = chain.send(ALICE, [
    { receiverId: TOKEN, actions: [actionOf(bad), actionOf(worse)] },
  ]);

  expect("Failure" in (outcome?.status ?? {})).toBe(true);
  expect(chain.view(TOKEN, "storage_balance_of", { account_id: "bob.testnet" })).toBeNull();
});

test("a_deposit_is_credited_or_handed_back_whole", () => {
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.give(TOKEN, ALICE, 100n);

  // No storage with Tender: the token moved the tokens, Tender refused them, nothing is credited.
  expect(eventsOf(sendAll(chain, [depositCall(TOKEN, CONTRACT, 10n)]))).toEqual([]);
  expect(chain.view(TOKEN, "ft_balance_of", { account_id: ALICE })).toBe("100");

  sendAll(chain, [storageDepositCall(CONTRACT, NEAR(0.05))]);
  expect(eventsOf(sendAll(chain, [depositCall(TOKEN, CONTRACT, 10n)]))).toEqual(["deposit"]);
  expect(chain.view(CONTRACT, "balances_of", { account_id: ALICE })).toEqual([
    { token: TOKEN, amount: "10" },
  ]);
  expect(chain.view(TOKEN, "ft_balance_of", { account_id: ALICE })).toBe("90");

  // A deposit for someone else needs that someone to have storage.
  expect(eventsOf(sendAll(chain, [depositCall(TOKEN, CONTRACT, 1n, "bob.testnet")]))).toEqual([]);

  // A token that is not enabled is refused, with the tokens handed back.
  chain.tokens.set(TOKEN, false);
  expect(eventsOf(sendAll(chain, [depositCall(TOKEN, CONTRACT, 1n)]))).toEqual([]);
  expect(chain.view(TOKEN, "ft_balance_of", { account_id: ALICE })).toBe("90");
});

test("a_first_deposit_of_a_token_is_charged_a_slot_and_handed_back_if_storage_cannot_pay", () => {
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.give(TOKEN, ALICE, 100n);
  // An account whose storage balance has 199 bytes free: one short of the 200 a slot is charged.
  const byte = 10n ** 19n;
  chain.storage.set(ALICE, { total: (173n + 199n) * byte, usedBytes: 173n });

  expect(eventsOf(sendAll(chain, [depositCall(TOKEN, CONTRACT, 10n)]))).toEqual([]);
  expect(chain.view(TOKEN, "ft_balance_of", { account_id: ALICE })).toBe("100");
  expect(chain.view(CONTRACT, "balances_of", { account_id: ALICE })).toEqual([]);

  // A post that follows the refused deposit is turned down for the vault, as the contract does.
  const [, post] = sendAll(chain, [
    depositCall(TOKEN, CONTRACT, 10n),
    postTaskCall(CONTRACT, { ...TERMS, reward: 10n }),
  ]);
  expect(JSON.stringify(post?.status)).toContain("E_FUNDS");

  // One byte more pays for the slot. The deposit is credited and the slot is charged once.
  sendAll(chain, [storageDepositCall(CONTRACT, byte)]);
  expect(eventsOf(sendAll(chain, [depositCall(TOKEN, CONTRACT, 10n)]))).toEqual(["deposit"]);
  expect(chain.storage.get(ALICE)?.usedBytes).toBe(173n + 200n);
  expect(eventsOf(sendAll(chain, [depositCall(TOKEN, CONTRACT, 10n)]))).toEqual(["deposit"]);
  expect(chain.storage.get(ALICE)?.usedBytes).toBe(173n + 200n);
  expect(chain.view(CONTRACT, "balances_of", { account_id: ALICE })).toEqual([
    { token: TOKEN, amount: "20" },
  ]);
});

test("a_withdrawal_is_paid_or_put_back_and_logged_as_which", () => {
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.fundVault(ALICE, TOKEN, 100n);
  chain.give(TOKEN, CONTRACT, 100n);

  // The token pays only an account it has registered.
  expect(eventsOf(sendAll(chain, [withdrawCall(CONTRACT, TOKEN, 30n)]))).toEqual([
    "withdraw_failed",
  ]);
  expect(chain.view(CONTRACT, "balances_of", { account_id: ALICE })).toEqual([
    { token: TOKEN, amount: "100" },
  ]);

  expect(
    eventsOf(
      sendAll(chain, [tokenStorageDepositCall(TOKEN, ALICE), withdrawCall(CONTRACT, TOKEN, 30n)]),
    ),
  ).toEqual(["withdraw"]);
  expect(chain.view(CONTRACT, "balances_of", { account_id: ALICE })).toEqual([
    { token: TOKEN, amount: "70" },
  ]);
  expect(chain.view(TOKEN, "ft_balance_of", { account_id: ALICE })).toBe("30");
});

test("a_withdrawal_that_breaks_a_rule_of_the_contract_panics_with_its_code", () => {
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.fundVault(ALICE, TOKEN, 10n);
  const code = (outcomes: ReturnType<FakeChain["send"]>) =>
    /(E_[A-Z_]+)/.exec(JSON.stringify(outcomes[0]?.status))?.[1];

  expect(code(sendAll(chain, [withdrawCall(CONTRACT, TOKEN, 11n)]))).toBe("E_FUNDS");
  expect(code(sendAll(chain, [withdrawCall(CONTRACT, TOKEN, 0n)]))).toBe("E_FUNDS");
  const noYocto = { ...withdrawCall(CONTRACT, TOKEN, 1n), deposit: 0n };
  expect(code(sendAll(chain, [noYocto]))).toBe("E_YOCTO");
  const noGas = { ...withdrawCall(CONTRACT, TOKEN, 1n), gas: 34_000_000_000_000n };
  expect(code(sendAll(chain, [noGas]))).toBe("E_GAS");
  // Nothing came of any of it.
  expect(chain.view(CONTRACT, "balances_of", { account_id: ALICE })).toEqual([
    { token: TOKEN, amount: "10" },
  ]);
});

test("unused_storage_can_be_taken_back_up_to_what_is_unused", () => {
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.fundVault(ALICE, TOKEN, 1n);
  const view = () =>
    chain.view(CONTRACT, "storage_balance_of", { account_id: ALICE }) as {
      total: string;
      available: string;
    };
  const before = view();

  const tooMuch = { ...storageWithdrawCall(CONTRACT, BigInt(before.available) + 1n) };
  expect(JSON.stringify(sendAll(chain, [tooMuch])[0]?.status)).toContain("E_STORAGE");

  expect(sendAll(chain, [storageWithdrawCall(CONTRACT)])[0]?.status).toEqual({ SuccessValue: "" });
  expect(view().available).toBe("0");
  expect(BigInt(view().total)).toBe(BigInt(before.total) - BigInt(before.available));
});

test("a_wallet_double_stops_at_the_first_transaction_that_fails", async () => {
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  const wallet = chainWallet(chain, ALICE);
  const transactions = [
    { receiverId: CONTRACT, actions: [actionOf(withdrawCall(CONTRACT, TOKEN, 5n))] },
    { receiverId: TOKEN, actions: [actionOf(tokenStorageDepositCall(TOKEN, ALICE))] },
  ];

  const outcomes = (await wallet.signAndSendTransactions({ transactions })) as unknown[];

  // The withdrawal fails (there is nothing in the vault), and the registration after it is never run.
  expect(outcomes).toHaveLength(1);
  expect(wallet.sent).toHaveLength(1);
  expect(chain.calls.map((call) => call.methodName)).toEqual(["withdraw"]);
});

// ---- post_task ----------------------------------------------------------------------------------

const HASH = "a".repeat(64);
const TERMS: PostTaskInput = {
  token: TOKEN,
  reward: 5_000_000n,
  briefUri: "http://api.test/v1/blobs/brief",
  briefHash: HASH,
  criteriaHash: "b".repeat(64),
  heldoutCommitment: "c".repeat(64),
  verifier: "judge.testnet",
  commitSecs: 600,
  revealSecs: 300,
  pickSecs: 600,
  fallbackSecs: 600,
};

/** A chain on which ALICE has set up and holds 10 test USDC in the vault. */
function postingChain(): FakeChain {
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.fundVault(ALICE, TOKEN, 10_000_000n);
  chain.now = () => 1_793_307_169_820_229_000n;
  return chain;
}

const codeOf = (outcomes: ReturnType<FakeChain["send"]>) =>
  /(E_[A-Z_]+)/.exec(JSON.stringify(outcomes[0]?.status))?.[1];

test("post_task_puts_the_reward_in_escrow_and_logs_task_created", () => {
  const chain = postingChain();
  const storageBefore = chain.storage.get(ALICE)?.usedBytes ?? 0n;

  const outcomes = sendAll(chain, [postTaskCall(CONTRACT, TERMS)]);

  expect(outcomes[0]?.status).toEqual({ SuccessValue: "" });
  // The vault gave up the reward, and the poster's storage holds the task and the outcome's room.
  expect(chain.view(CONTRACT, "balances_of", { account_id: ALICE })).toEqual([
    { token: TOKEN, amount: "5000000" },
  ]);
  expect((chain.storage.get(ALICE)?.usedBytes ?? 0n) - storageBefore).toBeGreaterThan(800n);

  const [log] = outcomes.flatMap((o) => o.receipts_outcome.flatMap((r) => r.outcome.logs));
  const line = JSON.parse((log ?? "").slice("EVENT_JSON:".length));
  const event = TenderEventSchema.parse({ event: line.event, data: line.data[0] });
  expect(event).toMatchObject({
    event: "task_created",
    data: {
      id: "1",
      poster: ALICE,
      token: TOKEN,
      reward: "5000000",
      fee_bps: 500,
      brief_hash: HASH,
      heldout_commitment: "c".repeat(64),
      verifier: "judge.testnet",
      max_entries: 0,
      max_winners: 1,
      invited: [],
      parent: null,
    },
  });
  // The deadlines follow one another from the block time.
  const second = 1_000_000_000n;
  expect(chain.tasks.get(1n)).toMatchObject({
    createdAt: 1_793_307_169_820_229_000n,
    commitDeadline: 1_793_307_169_820_229_000n + 600n * second,
    revealDeadline: 1_793_307_169_820_229_000n + 900n * second,
    pickDeadline: 1_793_307_169_820_229_000n + 1_500n * second,
    fallbackDeadline: 1_793_307_169_820_229_000n + 2_100n * second,
  });
});

test("post_task_is_the_poster_s_own_verifier_unless_it_names_another", () => {
  const chain = postingChain();

  sendAll(chain, [
    postTaskCall(CONTRACT, { ...TERMS, verifier: undefined, heldoutCommitment: undefined }),
  ]);

  expect(chain.tasks.get(1n)).toMatchObject({ verifier: ALICE, heldoutCommitment: null });
});

test("post_task_breaks_a_rule_of_the_contract_and_panics_with_its_code_and_nothing_changes", () => {
  const rules: Array<[string, (chain: FakeChain) => PostTaskInput | Record<string, unknown>]> = [
    [
      "E_PAUSED",
      (chain) => {
        chain.paused = true;
        return TERMS;
      },
    ],
    ["E_TOKEN", () => ({ ...TERMS, token: "other.testnet" })],
    ["E_REWARD", () => ({ ...TERMS, reward: 0n })],
    ["E_URI", () => ({ ...TERMS, briefUri: "" })],
    ["E_URI", () => ({ ...TERMS, briefUri: "u".repeat(257) })],
    ["E_HASH", () => ({ ...TERMS, briefHash: "A".repeat(64) })],
    ["E_HASH", () => ({ ...TERMS, heldoutCommitment: "c".repeat(63) })],
    ["E_WINDOW", () => ({ ...TERMS, commitSecs: 59 })],
    ["E_WINDOW", () => ({ ...TERMS, fallbackSecs: 1_209_601 })],
    ["E_WINNERS", () => ({ ...TERMS, maxWinners: 0 })],
    ["E_WINNERS", () => ({ ...TERMS, maxWinners: 6 })],
    ["E_LIMIT", () => ({ ...TERMS, maxEntries: 3 })],
    ["E_PARENT", () => ({ ...TERMS, parent: 1n })],
    ["E_FUNDS", () => ({ ...TERMS, reward: 10_000_001n })],
  ];
  for (const [code, make] of rules) {
    const chain = postingChain();
    const terms = make(chain) as PostTaskInput;

    const outcomes = sendAll(chain, [postTaskCall(CONTRACT, terms)]);

    expect(codeOf(outcomes), code).toBe(code);
    expect(chain.tasks.size, code).toBe(0);
    expect(chain.view(CONTRACT, "balances_of", { account_id: ALICE }), code).toEqual([
      { token: TOKEN, amount: "10000000" },
    ]);
  }

  // Exactly 1 yoctoNEAR, and a field the contract does not know.
  const chain = postingChain();
  expect(codeOf(sendAll(chain, [{ ...postTaskCall(CONTRACT, TERMS), deposit: 0n }]))).toBe(
    "E_AUTH",
  );
  const extra = postTaskCall(CONTRACT, TERMS);
  (extra.args.task as Record<string, unknown>).max_winner = 1;
  expect(codeOf(sendAll(chain, [extra]))).toBe("E_ARGS");
  expect(chain.tasks.size).toBe(0);
});

test("post_task_needs_a_storage_balance_that_can_hold_the_task", () => {
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.give(TOKEN, ALICE, 5_000_000n);
  // A vault balance with no storage cannot exist; a storage balance that is full can.
  chain.vault.set(ALICE, new Map([[TOKEN, 10_000_000n]]));
  expect(codeOf(sendAll(chain, [postTaskCall(CONTRACT, TERMS)]))).toBe("E_STORAGE");

  chain.storage.set(ALICE, { total: NEAR(0.05), usedBytes: 4_900n });
  expect(codeOf(sendAll(chain, [postTaskCall(CONTRACT, TERMS)]))).toBe("E_STORAGE");
  // Nothing was taken from the vault, and no id was used up.
  expect(chain.tasks.size).toBe(0);
  chain.storage.set(ALICE, { total: NEAR(0.05), usedBytes: 200n });
  sendAll(chain, [postTaskCall(CONTRACT, TERMS)]);
  expect([...chain.tasks.keys()]).toEqual([1n]);
});

test("task_ids_count_up_from_one_and_a_failed_post_does_not_use_one", () => {
  const chain = postingChain();

  sendAll(chain, [postTaskCall(CONTRACT, TERMS)]);
  sendAll(chain, [postTaskCall(CONTRACT, { ...TERMS, reward: 99_000_000n })]);
  sendAll(chain, [postTaskCall(CONTRACT, { ...TERMS, reward: 1_000_000n })]);

  expect([...chain.tasks.keys()]).toEqual([1n, 2n]);
});

test("get_config_tells_what_a_task_may_pay_and_how_short_a_window_may_be", () => {
  const chain = new FakeChain(CONTRACT, [
    { token: TOKEN, minReward: 1_000_000n, maxReward: 50_000_000n },
    { token: "off.testnet", enabled: false },
  ]);
  chain.minWindowSecs = 300;
  chain.feeBps = 250;

  expect(chain.view(CONTRACT, "get_config", {})).toMatchObject({
    fee_bps: 250,
    min_window_secs: 300,
    max_window_secs: 1_209_600,
    paused: false,
    tokens: [
      { token: TOKEN, min_reward: "1000000", max_reward: "50000000", enabled: true },
      { token: "off.testnet", min_reward: "1", enabled: false },
    ],
  });
});
