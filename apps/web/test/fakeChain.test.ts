import {
  depositCall,
  storageDepositCall,
  storageWithdrawCall,
  tokenStorageDepositCall,
  withdrawCall,
} from "@tender/shared";
import { expect, test } from "vitest";
import { FakeChain, NEAR, type WalletAction } from "./fakeChain";
import { chainWallet } from "./walletDoubles";

// The model that the wallet tests run on (test/fakeChain.ts) is held to what the contract does, so
// that a test that passes on it says something about the page. Each rule here is one the contract
// source states: contract/tender/src/vault.rs, storage.rs and ft.rs.

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
