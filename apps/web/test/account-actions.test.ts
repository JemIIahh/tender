import { afterEach, expect, test, vi } from "vitest";
import {
  type AccountAction,
  accountActionsOf,
  createWalletStore,
  type MixedTransaction,
  type Session,
  type SigningWallet,
} from "../lib/wallet";
import {
  TransactionFailed,
  WalletCannotSign,
  WalletError,
  WalletNotConnected,
  WalletResultUnreadable,
} from "../lib/walletErrors";
import { rejection } from "./support";
import { fakeProvider } from "./walletDoubles";

// The wallet's account actions (lib/wallet.ts `accountActionsOf`), which "Add an agent" sends: one
// transaction that creates the agent's account, funds it and adds its key. Only a wallet whose
// manifest says it signs and sends whole transactions is asked; the dev wallet's says it does not.

const ALICE = "alice.testnet";
const AGENT = "scout.alice.testnet";
const KEY = `ed25519:${"1".repeat(44)}`;

const ACTIONS: AccountAction[] = [
  { type: "CreateAccount" },
  { type: "Transfer", params: { deposit: "500000000000000000000000" } },
  { type: "AddKey", params: { publicKey: KEY, accessKey: { permission: "FullAccess" } } },
];

afterEach(() => {
  vi.restoreAllMocks();
});

/** What a wallet sends back for one transaction that ended as `status`. */
const outcome = (status: unknown, hash = "acct-tx") => ({
  status,
  transaction: { hash },
  receipts_outcome: [
    { id: "r1", outcome: { executor_id: AGENT, logs: [], status: { SuccessValue: "" } } },
  ],
});

/** A wallet that says what it can do in its manifest, and answers a send with `answer`. */
function walletThat(
  features: { signAndSendTransactions?: boolean },
  answer: () => unknown = () => [outcome({ SuccessValue: "" })],
) {
  const sent: unknown[] = [];
  const wallet: SigningWallet = {
    manifest: { features: { signMessage: true, ...features } },
    async signAndSendTransactions(params) {
      sent.push(params);
      return answer();
    },
    async signMessage() {
      throw new Error("not asked");
    },
  };
  return { wallet, sent };
}

async function actionsFor(wallet: SigningWallet, connected = true) {
  const session: Session = { wallet, accountId: ALICE };
  const store = createWalletStore(async () => fakeProvider(session, { restored: connected }));
  await store.start();
  return accountActionsOf(store);
}

test("only_a_wallet_that_says_it_sends_transactions_is_asked_to_make_an_account", async () => {
  expect((await actionsFor(walletThat({ signAndSendTransactions: true }).wallet)).canSend()).toBe(
    true,
  );
  // The dev wallet's manifest, and a wallet that says nothing, are not asked.
  const quiet = walletThat({});
  const actions = await actionsFor(quiet.wallet);
  expect(actions.canSend()).toBe(false);
  expect(await rejection(actions.send(AGENT, ACTIONS))).toBeInstanceOf(WalletCannotSign);
  expect(quiet.sent).toEqual([]);
  // Nobody connected: nothing to ask.
  const away = await actionsFor(walletThat({ signAndSendTransactions: true }).wallet, false);
  expect(away.canSend()).toBe(false);
  expect(await rejection(away.send(AGENT, ACTIONS))).toBeInstanceOf(WalletNotConnected);
});

test("the_actions_go_as_one_transaction_to_the_new_account_signed_by_the_connected_one", async () => {
  const { wallet, sent } = walletThat({ signAndSendTransactions: true });
  const actions = await actionsFor(wallet);

  expect(await actions.send(AGENT, ACTIONS)).toBe("acct-tx");
  expect(sent).toEqual([
    { transactions: [{ receiverId: AGENT, actions: ACTIONS }], signerId: ALICE },
  ]);
  await expect(actions.send(AGENT, [])).rejects.toBeInstanceOf(RangeError);
});

test("a_wallet_that_throws_fails_and_a_failed_transaction_says_so", async () => {
  const thrown = walletThat({ signAndSendTransactions: true }, () => {
    throw new Error("User rejected");
  });
  const refused = await rejection((await actionsFor(thrown.wallet)).send(AGENT, ACTIONS));
  expect(refused).toBeInstanceOf(WalletError);
  expect((refused as WalletError).action).toBe("send");

  const failed = walletThat({ signAndSendTransactions: true }, () => [
    outcome({ Failure: { ActionError: { kind: { AccountAlreadyExists: {} } } } }, "bad-tx"),
  ]);
  const failure = await rejection((await actionsFor(failed.wallet)).send(AGENT, ACTIONS));
  expect(failure).toBeInstanceOf(TransactionFailed);
  expect((failure as TransactionFailed).txHash).toBe("bad-tx");

  const garbled = walletThat({ signAndSendTransactions: true }, () => "done");
  expect(await rejection((await actionsFor(garbled.wallet)).send(AGENT, ACTIONS))).toBeInstanceOf(
    WalletResultUnreadable,
  );
});

// ---- Connect your agent: one approval for the account and the calls that pay for it -------------

const STORAGE: MixedTransaction = {
  receiverId: "tender.testnet",
  actions: [
    {
      type: "FunctionCall",
      params: {
        methodName: "storage_deposit",
        args: { account_id: AGENT },
        gas: "10000000000000",
        deposit: "20000000000000000000000",
      },
    },
  ],
};

test("a_batch_mixes_the_account_and_the_calls_in_one_approval_and_gives_each_hash", async () => {
  const { wallet, sent } = walletThat({ signAndSendTransactions: true }, () => [
    outcome({ SuccessValue: "" }, "create-tx"),
    outcome({ SuccessValue: "" }, "storage-tx"),
  ]);
  const actions = await actionsFor(wallet);
  const batch: MixedTransaction[] = [{ receiverId: AGENT, actions: ACTIONS }, STORAGE];

  expect(await actions.sendBatch(batch)).toEqual(["create-tx", "storage-tx"]);
  expect(sent).toEqual([{ transactions: batch, signerId: ALICE }]);
  await expect(actions.sendBatch([])).rejects.toBeInstanceOf(RangeError);
  await expect(actions.sendBatch([{ receiverId: AGENT, actions: [] }])).rejects.toBeInstanceOf(
    RangeError,
  );
});

test("a_batch_is_asked_only_of_a_wallet_that_says_it_sends_transactions_and_its_failure_is_said", async () => {
  const quiet = walletThat({});
  const batch: MixedTransaction[] = [{ receiverId: AGENT, actions: ACTIONS }, STORAGE];
  expect(await rejection((await actionsFor(quiet.wallet)).sendBatch(batch))).toBeInstanceOf(
    WalletCannotSign,
  );
  expect(quiet.sent).toEqual([]);

  // A wallet that stops at the failed transaction: the failure is the answer.
  const stopped = walletThat({ signAndSendTransactions: true }, () => [
    outcome({ SuccessValue: "" }, "create-tx"),
    outcome({ Failure: { ActionError: { kind: { FunctionCallError: {} } } } }, "storage-tx"),
  ]);
  const failure = await rejection((await actionsFor(stopped.wallet)).sendBatch(batch));
  expect(failure).toBeInstanceOf(TransactionFailed);
  expect((failure as TransactionFailed).txHash).toBe("storage-tx");

  // Fewer outcomes than transactions, and none failed: unreadable.
  const short = walletThat({ signAndSendTransactions: true }, () => [
    outcome({ SuccessValue: "" }),
  ]);
  expect(await rejection((await actionsFor(short.wallet)).sendBatch(batch))).toBeInstanceOf(
    WalletResultUnreadable,
  );
});
