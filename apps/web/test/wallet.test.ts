import {
  depositCall,
  toConnectorAction,
  tokenStorageDepositCall,
  withdrawCall,
} from "@tender/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { isRegisteredAtToken, planWithdraw } from "../lib/vault";
import {
  connectorProvider,
  createWalletStore,
  groupCalls,
  type Session,
  type WalletProvider,
} from "../lib/wallet";
import {
  TransactionFailed,
  WALLET_CANNOT_SIGN_MESSAGE,
  WalletCannotSign,
  WalletError,
  WalletNotConnected,
  WalletResultUnreadable,
  WalletUnavailable,
  walletErrorMessage,
} from "../lib/walletErrors";
import { eventLine, FakeChain, FakeNode, fakeFetch } from "./fakeChain";
import { rejection } from "./support";
import { chainWallet, fakeProvider } from "./walletDoubles";

// The wallet layer (lib/wallet.ts): how calls become transactions, how a wallet's answer is read,
// what the store does as a wallet comes and goes, and how near-connect is driven. vitest.config.ts
// gives the config the network testnet and the contract tender.testnet.

const CONTRACT = "tender.testnet";
const TOKEN = "tusdc.testnet";
const ALICE = "alice.testnet";

/** A chain where Alice has set up her account with Tender and holds `wallet` of the token. */
function chainWith({ vault, wallet }: { vault: bigint; wallet: bigint }): FakeChain {
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.fundVault(ALICE, TOKEN, vault);
  chain.give(TOKEN, ALICE, wallet);
  return chain;
}

/** A store whose wallet is Alice's on `chain`, restored from an earlier visit. */
async function storeFor(wallet: ReturnType<typeof chainWallet>) {
  const session: Session = { wallet, accountId: ALICE };
  const store = createWalletStore(async () => fakeProvider(session, { restored: true }));
  await store.start();
  return store;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---- Calls become transactions ------------------------------------------------------------------

test("calls_grouped_into_transactions", () => {
  const register = tokenStorageDepositCall(TOKEN, ALICE);
  const deposit = depositCall(TOKEN, CONTRACT, 5n);
  const withdraw = withdrawCall(CONTRACT, TOKEN, 1n);
  const registerBob = tokenStorageDepositCall(TOKEN, "bob.testnet");

  // Calls to one receiver, one after the other, are one transaction. A call to the same receiver
  // after another's is not joined to the first: the order of the calls is the order of the sends.
  expect(groupCalls([register, deposit, withdraw, registerBob])).toEqual([
    { receiverId: TOKEN, actions: [toConnectorAction(register), toConnectorAction(deposit)] },
    { receiverId: CONTRACT, actions: [toConnectorAction(withdraw)] },
    { receiverId: TOKEN, actions: [toConnectorAction(registerBob)] },
  ]);
  expect(groupCalls([])).toEqual([]);
  expect(groupCalls([withdraw])).toEqual([
    { receiverId: CONTRACT, actions: [toConnectorAction(withdraw)] },
  ]);
});

test("calls_grouped_into_transactions_reach_the_wallet_as_one_batch_for_the_account", async () => {
  const chain = chainWith({ vault: 100n, wallet: 50n });
  const wallet = chainWallet(chain, ALICE);
  const store = await storeFor(wallet);
  const calls = [depositCall(TOKEN, CONTRACT, 10n), withdrawCall(CONTRACT, TOKEN, 5n)];

  await store.signAndSend(calls);

  // One request, two transactions, signed as the connected account. Gas and deposit are the
  // decimal strings that `toConnectorAction` writes.
  expect(wallet.sent).toEqual([{ transactions: groupCalls(calls), signerId: ALICE }]);
  const [first] = wallet.sent[0]?.transactions ?? [];
  expect(first?.actions[0]?.params.deposit).toBe("1");
  expect(typeof first?.actions[0]?.params.gas).toBe("string");
});

test("withdraw_adds_token_registration_when_missing", async () => {
  // A token pays only an account it has registered, so an account it has not registered gets the
  // registration first: a call to the token, which makes it a transaction of its own, in the same
  // batch, so that one approval does both.
  const plan = (registered: boolean) =>
    planWithdraw({ contractId: CONTRACT, token: TOKEN, account: ALICE, amount: 5n, registered });
  expect(plan(true)).toEqual([withdrawCall(CONTRACT, TOKEN, 5n)]);
  expect(plan(false)).toEqual([
    tokenStorageDepositCall(TOKEN, ALICE),
    withdrawCall(CONTRACT, TOKEN, 5n),
  ]);
  expect(groupCalls(plan(false)).map((transaction) => transaction.receiverId)).toEqual([
    TOKEN,
    CONTRACT,
  ]);

  // And it works on a chain. The same withdrawal without the registration is paid back into the
  // vault by the contract (`withdraw_failed`), and the person has not got their tokens.
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.fundVault(ALICE, TOKEN, 100n);
  chain.give(TOKEN, CONTRACT, 100n);
  vi.stubGlobal("fetch", fakeFetch("http://rpc.test", new FakeNode(chain)));
  const store = await storeFor(chainWallet(chain, ALICE));

  const without = await store.signAndSend([withdrawCall(CONTRACT, TOKEN, 5n)]);
  expect(without.events.map((event) => event.event)).toEqual(["withdraw_failed"]);
  expect(chain.ftBalances.get(TOKEN)?.get(ALICE) ?? 0n).toBe(0n);

  // What the page does: it asks the token whether it knows the account, and plans from the answer.
  const registered = await isRegisteredAtToken(TOKEN, ALICE);
  expect(registered).toBe(false);
  const withRegistration = await store.signAndSend(plan(registered));
  expect(withRegistration.events.map((event) => event.event)).toEqual(["withdraw"]);
  expect(chain.ftBalances.get(TOKEN)?.get(ALICE)).toBe(5n);
  expect(chain.vault.get(ALICE)?.get(TOKEN)).toBe(95n);
  expect(await isRegisteredAtToken(TOKEN, ALICE)).toBe(true);
});

test("send_gives_back_the_events_and_the_hash_of_each_transaction", async () => {
  const chain = chainWith({ vault: 100n, wallet: 50n });
  const store = await storeFor(chainWallet(chain, ALICE));

  const result = await store.signAndSend([
    depositCall(TOKEN, CONTRACT, 10n),
    withdrawCall(CONTRACT, TOKEN, 5n),
  ]);

  expect(result.txHashes).toHaveLength(2);
  expect(new Set(result.txHashes).size).toBe(2);
  expect(result.events.map((event) => event.event)).toEqual(["deposit", "withdraw"]);
  const [deposit, withdraw] = result.events;
  expect(deposit?.data).toMatchObject({ account: ALICE, token: TOKEN, amount: "10" });
  expect(withdraw?.data).toMatchObject({ account: ALICE, token: TOKEN, amount: "5", to: ALICE });
  expect(chain.vault.get(ALICE)?.get(TOKEN)).toBe(105n);
});

test("send_reports_a_withdrawal_the_token_could_not_pay_as_an_event_and_not_a_failure", async () => {
  // Alice is not registered at the token: the transaction succeeds, the token refuses, and the
  // contract puts the amount back and logs `withdraw_failed`. The page words that from the event.
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.fundVault(ALICE, TOKEN, 100n);
  chain.give(TOKEN, CONTRACT, 100n);
  const store = await storeFor(chainWallet(chain, ALICE));

  const result = await store.signAndSend([withdrawCall(CONTRACT, TOKEN, 5n)]);

  expect(result.events.map((event) => event.event)).toEqual(["withdraw_failed"]);
  expect(chain.vault.get(ALICE)?.get(TOKEN)).toBe(100n);
});

test("events_come_from_the_tender_contract_only", async () => {
  // Any contract can log a line that looks like ours; only a receipt that ran on Tender counts.
  const line = eventLine("deposit", { account: ALICE, token: TOKEN, amount: "9", sender: ALICE });
  const outcome = (executor: string) => ({
    status: { SuccessValue: "" },
    transaction: { hash: "hash1" },
    receipts_outcome: [
      { id: "r1", outcome: { executor_id: executor, logs: [line], status: { SuccessValue: "" } } },
    ],
  });
  const wallet = chainWallet(new FakeChain(CONTRACT, []), ALICE);
  const store = await storeFor(wallet);

  wallet.signAndSendTransactions = async () => [outcome("evil.testnet")];
  expect((await store.signAndSend([withdrawCall(CONTRACT, TOKEN, 1n)])).events).toEqual([]);

  wallet.signAndSendTransactions = async () => [outcome(CONTRACT)];
  expect((await store.signAndSend([withdrawCall(CONTRACT, TOKEN, 1n)])).events).toHaveLength(1);
});

test("send_of_a_transaction_that_failed_names_the_contracts_error_code", async () => {
  const chain = chainWith({ vault: 1n, wallet: 0n });
  const store = await storeFor(chainWallet(chain, ALICE));

  const failure = await rejection(store.signAndSend([withdrawCall(CONTRACT, TOKEN, 5n)]));

  expect(failure).toBeInstanceOf(TransactionFailed);
  expect((failure as TransactionFailed).code).toBe("E_FUNDS");
  expect((failure as TransactionFailed).txHash).toBe("tx1");
  expect(walletErrorMessage(failure)).toBe("The transaction failed on the network.");
});

test("send_stops_at_the_first_transaction_that_failed", async () => {
  // The registration at the token goes through; the withdrawal after it fails on the network.
  // The wallet sends what it can, and the failed outcome ends the batch.
  const chain = chainWith({ vault: 1n, wallet: 0n });
  const store = await storeFor(chainWallet(chain, ALICE));

  const failure = await rejection(
    store.signAndSend([
      tokenStorageDepositCall(TOKEN, ALICE),
      withdrawCall(CONTRACT, TOKEN, 5n),
      tokenStorageDepositCall(TOKEN, "bob.testnet"),
    ]),
  );

  expect(failure).toBeInstanceOf(TransactionFailed);
  expect(chain.calls.map((call) => call.methodName)).toEqual(["storage_deposit", "withdraw"]);
});

test("send_by_a_wallet_that_throws_is_a_wallet_error_with_the_cause", async () => {
  const wallet = chainWallet(new FakeChain(CONTRACT, []), ALICE);
  const closed = new Error("User closed the window");
  wallet.signAndSendTransactions = async () => {
    throw closed;
  };
  const store = await storeFor(wallet);

  const failure = await rejection(store.signAndSend([withdrawCall(CONTRACT, TOKEN, 1n)]));

  expect(failure).toBeInstanceOf(WalletError);
  expect((failure as WalletError).action).toBe("send");
  expect(failure.cause).toBe(closed);
  // What the person reads says nothing a wallet chose.
  expect(failure.message).not.toContain("closed the window");
  expect(walletErrorMessage(failure)).toContain("Check the balances");
});

test("send_without_a_wallet_or_without_calls_sends_nothing", async () => {
  const store = createWalletStore(async () =>
    fakeProvider({ wallet: chainWallet(new FakeChain(CONTRACT, []), ALICE), accountId: ALICE }),
  );
  await store.start();

  expect(await rejection(store.signAndSend([withdrawCall(CONTRACT, TOKEN, 1n)]))).toBeInstanceOf(
    WalletNotConnected,
  );

  const connected = await storeFor(chainWallet(new FakeChain(CONTRACT, []), ALICE));
  expect(await rejection(connected.signAndSend([]))).toBeInstanceOf(RangeError);
});

test("send_reads_a_single_outcome_for_a_single_transaction_and_nothing_else_it_cannot_read", async () => {
  const chain = chainWith({ vault: 100n, wallet: 50n });
  const wallet = chainWallet(chain, ALICE);
  const store = await storeFor(wallet);
  const good = {
    status: { SuccessValue: "" },
    transaction: { hash: "hash1" },
    receipts_outcome: [],
  };
  const call = [withdrawCall(CONTRACT, TOKEN, 1n)];

  // A wallet may answer one transaction with its outcome, and not a list of one.
  wallet.signAndSendTransactions = async () => good;
  expect((await store.signAndSend(call)).txHashes).toEqual(["hash1"]);

  // Anything else is not what was asked for. The page is told so, and shows balances from the
  // node, which it reads again, and not a claim of success.
  const unreadable: Record<string, unknown> = {
    "a string": "ok",
    nothing: undefined,
    "no outcomes": [],
    "two outcomes for one transaction": [good, good],
    "no hash": [{ ...good, transaction: {} }],
    "an empty hash": [{ ...good, transaction: { hash: "" } }],
    "no receipts": [{ status: good.status, transaction: good.transaction }],
    "a receipt with no logs": [
      { ...good, receipts_outcome: [{ id: "r", outcome: { executor_id: CONTRACT } }] },
    ],
    "a log that is not text": [
      { ...good, receipts_outcome: [{ id: "r", outcome: { executor_id: CONTRACT, logs: [1] } }] },
    ],
    "no status": [{ transaction: good.transaction, receipts_outcome: [] }],
    "a status that is not yet an end": [{ ...good, status: "Started" }],
  };
  for (const [what, result] of Object.entries(unreadable)) {
    wallet.signAndSendTransactions = async () => result;

    const failure = await rejection(store.signAndSend(call));

    expect(failure, what).toBeInstanceOf(WalletResultUnreadable);
    expect((failure as WalletResultUnreadable).what, what).toBe("transaction");
  }
});

// ---- A wallet that can't sign a message ---------------------------------------------------------

test("wallet_without_sign_message_degrades", async () => {
  const chain = chainWith({ vault: 100n, wallet: 50n });
  const wallet = chainWallet(chain, ALICE, { signMessage: false });
  const store = await storeFor(wallet);

  // The store says so, for the buttons that need a sign-in to show the sentence in its place.
  expect(store.getSnapshot()).toEqual({ ready: true, accountId: ALICE, canSignMessage: false });
  expect(WALLET_CANNOT_SIGN_MESSAGE).toBe(
    "This wallet can't sign messages. Switch wallet to post tasks or link Telegram.",
  );

  // Asked to sign, it refuses with that sentence, and the wallet is never troubled with it.
  const failure = await rejection(
    store.signMessage({
      message: "Sign in to Tender",
      recipient: "http://api.test",
      nonce: new Uint8Array(32),
    }),
  );
  expect(failure).toBeInstanceOf(WalletCannotSign);
  expect(failure.message).toBe(WALLET_CANNOT_SIGN_MESSAGE);
  expect(walletErrorMessage(failure)).toBe(WALLET_CANNOT_SIGN_MESSAGE);
  expect(wallet.signRequests).toEqual([]);

  // It degrades, and does not break: transactions still go through.
  const result = await store.signAndSend([depositCall(TOKEN, CONTRACT, 10n)]);
  expect(result.events.map((event) => event.event)).toEqual(["deposit"]);
});

test("a_wallet_that_signs_is_asked_as_the_connected_account_and_its_answer_is_checked", async () => {
  const wallet = chainWallet(new FakeChain(CONTRACT, []), ALICE);
  const store = await storeFor(wallet);
  const nonce = Uint8Array.from({ length: 32 }, (_, i) => i);

  const signed = await store.signMessage({
    message: "Sign in to Tender",
    recipient: "http://api.test",
    nonce,
  });

  expect(store.getSnapshot().canSignMessage).toBe(true);
  expect(wallet.signRequests).toEqual([
    { message: "Sign in to Tender", recipient: "http://api.test", nonce, signerId: ALICE },
  ]);
  expect(Object.keys(signed).sort()).toEqual(["accountId", "publicKey", "signature"]);

  // A wallet that answers with something else gets no signature of ours out of it.
  for (const answer of [
    undefined,
    "signed",
    {},
    { accountId: ALICE, publicKey: "ed25519:x" },
    { accountId: ALICE, publicKey: "ed25519:x", signature: "" },
    { accountId: 1, publicKey: "k", signature: "s" },
  ]) {
    wallet.signMessage = async () => answer as never;
    const failure = await rejection(store.signMessage({ message: "m", recipient: "r", nonce }));
    expect(failure).toBeInstanceOf(WalletResultUnreadable);
    expect((failure as WalletResultUnreadable).what).toBe("signature");
  }

  // A wallet that throws, such as one the person closed, is a wallet error and not a crash.
  wallet.signMessage = async () => {
    throw new Error("closed");
  };
  const refused = await rejection(store.signMessage({ message: "m", recipient: "r", nonce }));
  expect(refused).toBeInstanceOf(WalletError);
  expect((refused as WalletError).action).toBe("sign");
});

test("signing_with_no_wallet_connected_says_so", async () => {
  const store = createWalletStore(async () =>
    fakeProvider({ wallet: chainWallet(new FakeChain(CONTRACT, []), ALICE), accountId: ALICE }),
  );

  const failure = await rejection(
    store.signMessage({ message: "m", recipient: "r", nonce: new Uint8Array(32) }),
  );

  expect(failure).toBeInstanceOf(WalletNotConnected);
});

// ---- The store ----------------------------------------------------------------------------------

test("the_store_is_not_ready_until_it_has_looked_for_the_wallet_of_an_earlier_visit", async () => {
  const wallet = chainWallet(new FakeChain(CONTRACT, []), ALICE);
  const store = createWalletStore(async () =>
    fakeProvider({ wallet, accountId: ALICE }, { restored: true }),
  );
  const seen: string[] = [];
  store.subscribe(() => seen.push(JSON.stringify(store.getSnapshot())));

  expect(store.getSnapshot()).toEqual({ ready: false, accountId: null, canSignMessage: false });
  // What the server renders is the same: no account, not ready.
  expect(store.getServerSnapshot()).toEqual(store.getSnapshot());

  await store.start();

  expect(store.getSnapshot()).toEqual({ ready: true, accountId: ALICE, canSignMessage: true });
  // One change for the account, one for ready: a listener is told of a change and of nothing else.
  expect(seen).toHaveLength(2);
  await store.start();
  expect(seen).toHaveLength(2);
});

test("with_no_wallet_from_an_earlier_visit_the_store_is_ready_and_has_no_account", async () => {
  const wallet = chainWallet(new FakeChain(CONTRACT, []), ALICE);
  const store = createWalletStore(async () => fakeProvider({ wallet, accountId: ALICE }));

  await store.start();

  expect(store.getSnapshot()).toEqual({ ready: true, accountId: null, canSignMessage: false });
});

test("connect_takes_the_session_and_a_closed_dialog_is_not_an_error", async () => {
  const wallet = chainWallet(new FakeChain(CONTRACT, []), ALICE);
  const closed = fakeProvider({ wallet, accountId: ALICE }, { connect: "closed" });
  const store = createWalletStore(async () => closed);

  await store.connect();

  expect(closed.connects).toBe(1);
  expect(store.getSnapshot()).toEqual({ ready: true, accountId: null, canSignMessage: false });

  const chosen = fakeProvider({ wallet, accountId: ALICE });
  const other = createWalletStore(async () => chosen);
  await other.connect();
  expect(other.getSnapshot().accountId).toBe(ALICE);
  // Connecting when connected asks nobody.
  await other.connect();
  expect(chosen.connects).toBe(1);
});

test("a_connect_that_fails_is_thrown_and_leaves_the_store_as_it_was", async () => {
  const wallet = chainWallet(new FakeChain(CONTRACT, []), ALICE);
  const refused = new WalletError("connect", new Error("popup blocked"));
  const store = createWalletStore(async () =>
    fakeProvider({ wallet, accountId: ALICE }, { connect: refused }),
  );

  expect(await rejection(store.connect())).toBe(refused);
  expect(store.getSnapshot().accountId).toBeNull();
  // And the store connects when it is tried again: it is not stuck in "connecting".
  expect(await rejection(store.connect())).toBe(refused);
});

test("two_connects_at_once_open_one_dialog", async () => {
  const wallet = chainWallet(new FakeChain(CONTRACT, []), ALICE);
  let opened = 0;
  let choose: (session: Session) => void = () => {};
  const provider: WalletProvider = {
    ...fakeProvider({ wallet, accountId: ALICE }),
    connect: () => {
      opened++;
      return new Promise((resolve) => {
        choose = resolve;
      });
    },
  };
  const store = createWalletStore(async () => provider);

  const first = store.connect();
  const second = store.connect();
  await vi.waitFor(() => expect(opened).toBe(1));
  choose({ wallet, accountId: ALICE });
  await Promise.all([first, second]);

  expect(opened).toBe(1);
  expect(store.getSnapshot().accountId).toBe(ALICE);
});

test("disconnect_signs_out_and_a_wallet_that_cannot_leaves_the_account_connected", async () => {
  const wallet = chainWallet(new FakeChain(CONTRACT, []), ALICE);
  const provider = fakeProvider({ wallet, accountId: ALICE }, { restored: true });
  const store = createWalletStore(async () => provider);
  await store.start();

  await store.disconnect();

  expect(provider.disconnects).toBe(1);
  expect(store.getSnapshot().accountId).toBeNull();
  // Nothing to disconnect is not an error, and asks no one.
  await store.disconnect();
  expect(provider.disconnects).toBe(1);

  const stuck = fakeProvider({ wallet, accountId: ALICE }, { restored: true });
  const trouble = new WalletError("disconnect", new Error("no"));
  stuck.disconnect = async () => {
    throw trouble;
  };
  const other = createWalletStore(async () => stuck);
  await other.start();
  expect(await rejection(other.disconnect())).toBe(trouble);
  // Still shown as connected: it is.
  expect(other.getSnapshot().accountId).toBe(ALICE);
});

test("a_wallet_that_signs_out_by_itself_clears_the_account", async () => {
  const wallet = chainWallet(new FakeChain(CONTRACT, []), ALICE);
  const provider = fakeProvider({ wallet, accountId: ALICE }, { restored: true });
  const store = createWalletStore(async () => provider);
  await store.start();

  provider.signOut();

  expect(store.getSnapshot()).toEqual({ ready: true, accountId: null, canSignMessage: false });
});

test("a_wallet_that_is_slow_to_come_back_does_not_hold_the_page_and_is_taken_when_it_does", async () => {
  vi.useFakeTimers();
  const wallet = chainWallet(new FakeChain(CONTRACT, []), ALICE);
  let found: (session: Session) => void = () => {};
  const provider: WalletProvider = {
    ...fakeProvider({ wallet, accountId: ALICE }),
    restore: () =>
      new Promise((resolve) => {
        found = resolve;
      }),
  };
  const store = createWalletStore(async () => provider);

  const starting = store.start();
  await vi.advanceTimersByTimeAsync(7000);
  expect(store.getSnapshot().ready).toBe(false);
  await vi.advanceTimersByTimeAsync(1500);
  await starting;

  // The page shows its Connect button...
  expect(store.getSnapshot()).toEqual({ ready: true, accountId: null, canSignMessage: false });
  // ...and the wallet, when it turns up, is connected all the same.
  found({ wallet, accountId: ALICE });
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getSnapshot().accountId).toBe(ALICE);
});

test("a_wallet_connected_while_the_old_one_is_looked_for_is_not_replaced_by_it", async () => {
  vi.useFakeTimers();
  const wallet = chainWallet(new FakeChain(CONTRACT, []), ALICE);
  const bob = chainWallet(new FakeChain(CONTRACT, []), "bob.testnet");
  let found: (session: Session) => void = () => {};
  const provider: WalletProvider = {
    ...fakeProvider({ wallet: bob, accountId: "bob.testnet" }),
    restore: () =>
      new Promise((resolve) => {
        found = resolve;
      }),
  };
  const store = createWalletStore(async () => provider);

  const starting = store.start();
  await vi.advanceTimersByTimeAsync(9000);
  await starting;
  await store.connect();
  found({ wallet, accountId: ALICE });
  await vi.advanceTimersByTimeAsync(0);

  expect(store.getSnapshot().accountId).toBe("bob.testnet");
});

test("a_build_with_no_wallet_says_so_when_asked_to_connect_and_tries_again_each_time", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const wallet = chainWallet(new FakeChain(CONTRACT, []), ALICE);
  let made = 0;
  const store = createWalletStore(async () => {
    made++;
    if (made < 3) throw new WalletUnavailable();
    return fakeProvider({ wallet, accountId: ALICE });
  });

  // The page loads: it is ready, with a Connect button, and the reason is in the console.
  await store.start();
  expect(store.getSnapshot()).toEqual({ ready: true, accountId: null, canSignMessage: false });
  expect(log).toHaveBeenCalledTimes(1);

  // Pressing it throws the reason, and so does the next press: nothing is remembered as failed.
  expect(await rejection(store.connect())).toBeInstanceOf(WalletUnavailable);
  await store.connect();
  expect(made).toBe(3);
  expect(store.getSnapshot().accountId).toBe(ALICE);
});

test("a_wallet_library_that_loaded_on_a_later_try_is_heard_when_it_signs_out", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const wallet = chainWallet(new FakeChain(CONTRACT, []), ALICE);
  const provider = fakeProvider({ wallet, accountId: ALICE });
  let made = 0;
  const store = createWalletStore(async () => {
    made++;
    if (made === 1) throw new WalletUnavailable();
    return provider;
  });

  // The library did not load with the page: ready, with a Connect button, and no provider to hear.
  await store.start();
  expect(store.getSnapshot()).toEqual({ ready: true, accountId: null, canSignMessage: false });
  // It loads when Connect is pressed...
  await store.connect();
  expect(store.getSnapshot().accountId).toBe(ALICE);

  // ...and the wallet signing itself out is heard all the same.
  provider.signOut();
  expect(store.getSnapshot()).toEqual({ ready: true, accountId: null, canSignMessage: false });
});

test("a_provider_is_listened_to_once_however_often_the_store_uses_it", async () => {
  const wallet = chainWallet(new FakeChain(CONTRACT, []), ALICE);
  const provider = fakeProvider({ wallet, accountId: ALICE });
  const subscribe = vi.spyOn(provider, "subscribe");
  const store = createWalletStore(async () => provider);

  await store.start();
  await store.connect();
  await store.disconnect();
  await store.connect();

  expect(subscribe).toHaveBeenCalledTimes(1);
});

// ---- near-connect -------------------------------------------------------------------------------

// The library is replaced by a connector that does what the test says. It is the library that
// touches `window` as it loads, so nothing here runs the real one.
const library = vi.hoisted(() => {
  interface Connected {
    wallet: { manifest: { features: { signMessage: boolean } } };
    accounts: Array<{ accountId: string }>;
  }
  class FakeConnector {
    connect = vi.fn<() => Promise<unknown>>(async () => ({}));
    getConnectedWallet = vi.fn<() => Promise<Connected>>(async () => {
      throw new Error("No wallet selected");
    });
    disconnect = vi.fn<() => Promise<void>>(async () => {});
    handlers = new Map<string, Set<() => void>>();

    constructor(public options: unknown) {
      library.made.push(this);
    }

    on(event: string, handler: () => void) {
      const set = this.handlers.get(event) ?? new Set();
      set.add(handler);
      this.handlers.set(event, set);
    }

    off(event: string, handler: () => void) {
      this.handlers.get(event)?.delete(handler);
    }

    emit(event: string) {
      for (const handler of [...(this.handlers.get(event) ?? [])]) handler();
    }
  }
  const library = { made: [] as FakeConnector[], FakeConnector };
  return library;
});

vi.mock("@hot-labs/near-connect", () => ({ NearConnector: library.FakeConnector }));

beforeEach(() => {
  library.made.length = 0;
});

/** The connector the provider made, which a test then tells what to do. */
async function connectorFor(network: "mainnet" | "testnet" = "testnet") {
  const provider = await connectorProvider(network);
  const connector = library.made.at(-1);
  if (connector === undefined) throw new Error("the provider made no connector");
  return { provider, connector };
}

const connected = (signMessage: boolean, accountId = ALICE) => ({
  wallet: { manifest: { features: { signMessage } } },
  accounts: [{ accountId }],
});

test("near_connect_is_made_for_the_configured_network_and_asks_for_wallets_that_can_send_a_batch", async () => {
  // Every send in the app is a signAndSendTransactions, and signMessage is left unfiltered: a
  // wallet that can't sign a message may still send transactions.
  const testnet = await connectorFor("testnet");
  expect(testnet.connector.options).toEqual({
    network: "testnet",
    features: { signAndSendTransactions: true },
  });

  const mainnet = await connectorFor("mainnet");
  expect(mainnet.connector.options).toEqual({
    network: "mainnet",
    features: { signAndSendTransactions: true },
  });
});

test("near_connect_restores_the_wallet_it_kept_and_a_wallet_never_connected_is_quiet", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { provider, connector } = await connectorFor();

  // Neither of near-connect's two messages for "nothing was connected" is a failure.
  expect(await provider.restore()).toBeNull();
  connector.getConnectedWallet.mockRejectedValueOnce(new Error("No accounts found"));
  expect(await provider.restore()).toBeNull();
  expect(log).not.toHaveBeenCalled();

  // Another failure is the same to the page, and a developer sees it in the console.
  const broken = new Error("indexedDB is not available");
  connector.getConnectedWallet.mockRejectedValueOnce(broken);
  expect(await provider.restore()).toBeNull();
  expect(log).toHaveBeenCalledWith(broken);

  connector.getConnectedWallet.mockResolvedValueOnce(connected(true));
  expect(await provider.restore()).toMatchObject({ accountId: ALICE });
});

test("near_connect_gives_the_account_the_wallet_reports_if_it_is_one", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { provider, connector } = await connectorFor();

  connector.getConnectedWallet.mockResolvedValue(connected(true, "Not An Account"));
  expect(await provider.restore()).toBeNull();
  expect(log).toHaveBeenCalledTimes(1);
  expect(await rejection(provider.connect())).toBeInstanceOf(WalletError);

  connector.getConnectedWallet.mockResolvedValue({ wallet: connected(true).wallet, accounts: [] });
  expect(await provider.restore()).toBeNull();
});

test("near_connect_connect_has_the_person_pick_a_wallet_and_reads_the_account_it_signed_in", async () => {
  const { provider, connector } = await connectorFor();
  connector.getConnectedWallet.mockResolvedValue(connected(false));

  const session = await provider.connect();

  expect(connector.connect).toHaveBeenCalledTimes(1);
  expect(session?.accountId).toBe(ALICE);
  // The flag of the wallet's manifest is what the store reads for `canSignMessage`.
  const store = createWalletStore(async () => provider);
  await store.connect();
  expect(store.getSnapshot()).toEqual({ ready: true, accountId: ALICE, canSignMessage: false });
});

test("near_connect_connect_closed_by_the_person_is_not_an_error_and_any_other_is", async () => {
  const { provider, connector } = await connectorFor();

  // What near-connect rejects with when its dialog is closed.
  connector.connect.mockRejectedValueOnce(new Error("User rejected"));
  expect(await provider.connect()).toBeNull();

  const other = new Error("wallet iframe failed to load");
  connector.connect.mockRejectedValueOnce(other);
  const failure = await rejection(provider.connect());
  expect(failure).toBeInstanceOf(WalletError);
  expect((failure as WalletError).action).toBe("connect");
  expect(failure.cause).toBe(other);
});

test("near_connect_disconnect_and_the_wallets_own_sign_out", async () => {
  const { provider, connector } = await connectorFor();
  connector.getConnectedWallet.mockResolvedValue(connected(true));
  const session = await provider.connect();
  if (session === null) throw new Error("no session");

  await provider.disconnect(session);
  expect(connector.disconnect).toHaveBeenCalledTimes(1);

  connector.disconnect.mockRejectedValueOnce(new Error("popup blocked"));
  const failure = await rejection(provider.disconnect(session));
  expect((failure as WalletError).action).toBe("disconnect");

  // The wallet signing itself out reaches the listener, until it is taken away.
  const heard: Array<Session | null> = [];
  const stop = provider.subscribe((next) => heard.push(next));
  connector.emit("wallet:signOut");
  expect(heard).toEqual([null]);
  stop();
  connector.emit("wallet:signOut");
  expect(heard).toEqual([null]);
});

test("near_connect_that_does_not_load_is_a_wallet_error_for_a_connect", async () => {
  // A failed import of the library (a chunk that did not arrive) is a wallet that can't be had.
  vi.resetModules();
  vi.doMock("@hot-labs/near-connect", () => {
    throw new Error("Loading chunk failed");
  });
  try {
    const { connectorProvider: fresh } = await import("../lib/wallet");
    // The classes of the fresh module graph: those the test imported first are not the same ones.
    const { WalletError: FreshWalletError } = await import("../lib/walletErrors");

    const failure = await rejection(fresh("testnet"));

    expect(failure).toBeInstanceOf(FreshWalletError);
    expect((failure as WalletError).action).toBe("connect");
  } finally {
    vi.doUnmock("@hot-labs/near-connect");
  }
});

// ---- The dev wallet stays out of every build but the sandbox's ---------------------------------

const DEV_KEY = `ed25519:${"3".repeat(88)}`;

/** `lib/wallet.ts` as a build for `network` loads it. */
async function walletFor(network: string, env: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", network);
  vi.stubEnv("NEXT_PUBLIC_DEV_WALLET_KEY", DEV_KEY);
  vi.stubEnv("NEXT_PUBLIC_DEV_WALLET_ACCOUNT", "dev.sandbox");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return import("../lib/wallet");
}

test("dev_wallet_excluded_outside_sandbox", async () => {
  // A build for testnet or mainnet gets no dev wallet, even if the variables that switch it on
  // and hold its key are set: nothing is loaded...
  for (const network of ["testnet", "mainnet"]) {
    const built = await walletFor(network, { NEXT_PUBLIC_DEV_WALLET: "1" });
    expect(await built.loadDevWallet(), network).toBeNull();
  }

  // ...and the module refuses to make a wallet, without saying what the key is, in case a build
  // were to bundle it all the same.
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "testnet");
  vi.stubEnv("NEXT_PUBLIC_DEV_WALLET_KEY", DEV_KEY);
  vi.stubEnv("NEXT_PUBLIC_DEV_WALLET_ACCOUNT", "dev.sandbox");
  const { createDevWallet, createDevProvider } = await import("../lib/devWallet");
  const makes: Array<() => unknown> = [createDevWallet, createDevProvider];
  for (const make of makes) {
    const failure = await rejection(Promise.resolve().then(() => make()));
    expect(failure.message).toBe("the dev wallet is for the sandbox only");
    expect(failure.message).not.toContain(DEV_KEY);
  }

  // The sandbox has it only when it is switched on.
  const off = await walletFor("sandbox", { NEXT_PUBLIC_DEV_WALLET: "" });
  expect(await off.loadDevWallet()).toBeNull();
  const on = await walletFor("sandbox", { NEXT_PUBLIC_DEV_WALLET: "1" });
  expect(await on.loadDevWallet()).not.toBeNull();
});

test("dev_wallet_only_stands_in_where_the_sandbox_has_no_other_wallet", async () => {
  // A sandbox build that did not switch the dev wallet on has nothing to connect to, and says so
  // on a press of Connect. (near-connect lists no wallet for a chain it doesn't know.)
  vi.spyOn(console, "error").mockImplementation(() => {});
  const built = await walletFor("sandbox", { NEXT_PUBLIC_DEV_WALLET: "" });
  const errors = await import("../lib/walletErrors");

  const failure = await rejection(built.walletStore.connect());

  expect(failure).toBeInstanceOf(errors.WalletUnavailable);
  expect(errors.walletErrorMessage(failure)).toBe("This build has no wallet to connect.");
});

test("the_wallet_hook_is_the_store", async () => {
  // `useWallet` reads the store of the page: one store for every component, which starts looking
  // for the wallet when the first one mounts.
  const { renderHook } = await import("@testing-library/react");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const built = await walletFor("sandbox", { NEXT_PUBLIC_DEV_WALLET: "" });

  const { result } = renderHook(() => built.useWallet());
  expect(result.current.ready).toBe(false);
  await vi.waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.accountId).toBeNull();
  expect(typeof result.current.signAndSend).toBe("function");
});
