import { afterEach, expect, test, vi } from "vitest";
import {
  type AccountAction,
  accountActionsOf,
  createWalletStore,
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
