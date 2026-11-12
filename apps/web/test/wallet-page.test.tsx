import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WalletView } from "../components/WalletView";
import type { Session, WalletStore } from "../lib/wallet";
import { createWalletStore } from "../lib/wallet";
import { FakeChain, FakeNode, fakeFetch } from "./fakeChain";
import { type ChainWallet, chainWallet, fakeProvider } from "./walletDoubles";

// The wallet page, as a person uses it: the real hook and store over a wallet that runs on a model
// of the contract and its token, read through a fake RPC node. vitest.config.ts gives the config
// the network testnet, the contract tender.testnet and the node http://rpc.test.

const CONTRACT = "tender.testnet";
const USDC = "tusdc.testnet";
const ALICE = "alice.testnet";
const BOB = "bob.testnet";

// The page reads the wallet from `lib/wallet`; the tests hand it a store of their own.
const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return { ...actual, useWallet: () => actual.useWalletStore(holder.store) };
});

interface Setup {
  chain: FakeChain;
  node: FakeNode;
  wallet: ChainWallet;
  user: ReturnType<typeof userEvent.setup>;
  fetchCalls: string[];
}

/** A page for Alice, who holds 20 test USDC and has not set up. `connected`: her wallet is back. */
function setup(options: { connected?: boolean; signMessage?: boolean } = {}): Setup {
  const chain = new FakeChain(CONTRACT, [{ token: USDC }]);
  chain.give(USDC, ALICE, 20_000_000n);
  const node = new FakeNode(chain);
  const wallet = chainWallet(chain, ALICE, { signMessage: options.signMessage });
  holder.store = createWalletStore(async () =>
    fakeProvider({ wallet, accountId: ALICE }, { restored: options.connected }),
  );
  const fetchCalls: string[] = [];
  const route = fakeFetch("http://rpc.test", node);
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    fetchCalls.push(String(input));
    return route(input, init);
  });
  return { chain, node, wallet, user: userEvent.setup(), fetchCalls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const button = (name: string | RegExp) => screen.findByRole("button", { name });

/** The text of a test id inside `scope`. */
const textOf = (scope: HTMLElement, id: string) => within(scope).getByTestId(id).textContent;

/** The section of the page under the heading `title`. */
function section(title: string): HTMLElement {
  const found = screen.getByRole("heading", { name: title }).closest("section");
  if (found === null) throw new Error(`no section under ${title}`);
  return found;
}

test("wallet_page_signed_out_offers_connect_and_reads_nothing", async () => {
  const { fetchCalls } = setup();

  render(<WalletView />);

  // Until the wallet from an earlier visit is looked for, nothing is claimed either way.
  expect(screen.getByRole("status").textContent).toBe("Checking if you're signed in…");
  await button("Sign in");
  expect(screen.queryByText("Balances")).toBeNull();
  expect(screen.queryByText("Storage with Tender")).toBeNull();
  expect(fetchCalls).toEqual([]);
});

test("register_deposit_withdraw_round_trip_on_the_page", async () => {
  const { chain, wallet, user } = setup();
  render(<WalletView />);

  // Connect.
  await user.click(await button("Sign in"));
  expect((await screen.findByTestId("account-id")).textContent).toBe(ALICE);
  const row = await screen.findByTestId("token-row");
  expect(textOf(row, "vault-balance")).toBe("0.00 tUSDC");
  expect(textOf(row, "wallet-balance")).toBe("20.00 tUSDC");
  // Nothing to put in or take out before the account is set up.
  expect(screen.getByText("Set up your account first.")).toBeDefined();
  expect(screen.getByText("There is nothing in your vault to withdraw.")).toBeDefined();

  // Set up the account: half of a tenth of a NEAR to Tender's storage.
  await user.click(await button("Set up account"));
  await waitFor(() => expect(screen.getByTestId("storage-total").textContent).toBe("0.05 NEAR"));
  expect(wallet.sent).toHaveLength(1);
  expect(wallet.sent[0]?.transactions).toEqual([
    {
      receiverId: CONTRACT,
      actions: [
        {
          type: "FunctionCall",
          params: expect.objectContaining({
            methodName: "storage_deposit",
            deposit: "50000000000000000000000",
          }),
        },
      ],
    },
  ]);
  expect(screen.getByTestId("notice").textContent).toBe(
    "Your account is set up. 0.05 NEAR is deposited for storage.",
  );
  // The button that did it is gone; the focus is where what it did is told.
  expect(document.activeElement?.textContent).toBe("Storage with Tender");

  // Add funds: 5 of the 20.
  await user.type(within(section("Add funds")).getByLabelText("Amount"), "5");
  await user.click(within(section("Add funds")).getByRole("button", { name: "Add funds" }));
  await waitFor(() =>
    expect(textOf(screen.getByTestId("token-row"), "vault-balance")).toBe("5.00 tUSDC"),
  );
  expect(textOf(screen.getByTestId("token-row"), "wallet-balance")).toBe("15.00 tUSDC");
  expect(wallet.sent[1]?.transactions[0]).toMatchObject({
    receiverId: USDC,
    actions: [{ params: { methodName: "ft_transfer_call", deposit: "1" } }],
  });
  expect(wallet.sent[1]?.transactions[0]?.actions[0]?.params.args).toEqual({
    receiver_id: CONTRACT,
    amount: "5000000",
    msg: "",
  });
  expect(screen.getAllByTestId("notice").map((n) => n.textContent)).toEqual([
    "Added 5.00 tUSDC to your vault.",
  ]);
  // The field is emptied for the next amount.
  expect((within(section("Add funds")).getByLabelText("Amount") as HTMLInputElement).value).toBe(
    "",
  );

  // Withdraw 2: the account is registered at the token, so it is one transaction.
  const withdrawForm = section("Withdraw");
  await user.type(within(withdrawForm).getByLabelText("Amount"), "2");
  await user.click(within(withdrawForm).getByRole("button", { name: "Withdraw" }));
  await waitFor(() =>
    expect(textOf(screen.getByTestId("token-row"), "vault-balance")).toBe("3.00 tUSDC"),
  );
  expect(textOf(screen.getByTestId("token-row"), "wallet-balance")).toBe("17.00 tUSDC");
  expect(wallet.sent[2]?.transactions.map((t) => t.receiverId)).toEqual([CONTRACT]);
  expect(within(withdrawForm).getByTestId("notice").textContent).toBe(
    "Withdrew 2.00 tUSDC to your wallet.",
  );

  // Take back the storage that is not used. The notice names no amount: the page's reading of it
  // is from before the press, and the figure above is read again after.
  await user.click(await button("Withdraw unused storage"));
  await waitFor(() =>
    expect(screen.getByTestId("storage-available").textContent).toBe("0.00 NEAR"),
  );
  expect(chain.calls.at(-1)).toMatchObject({ methodName: "storage_withdraw", deposit: 1n });
  expect(chain.calls.at(-1)?.args).toEqual({});
  expect(within(section("Storage with Tender")).getByTestId("notice").textContent).toBe(
    "Took back your unused storage.",
  );
});

test("withdraw_unused_storage_with_none_to_take_back_sends_nothing", async () => {
  const { chain, wallet, user } = setup({ connected: true });
  render(<WalletView />);
  await user.click(await button("Set up account"));
  await waitFor(() => expect(screen.getByTestId("storage-total").textContent).toBe("0.05 NEAR"));
  await user.click(await button("Withdraw unused storage"));
  await waitFor(() =>
    expect(screen.getByTestId("storage-available").textContent).toBe("0.00 NEAR"),
  );
  expect(wallet.sent).toHaveLength(2);
  const takeBack = screen.getByRole("button", { name: "Withdraw unused storage" });
  expect(takeBack.getAttribute("aria-disabled")).toBe("true");

  // `aria-disabled` does not stop a press: this one is a click, and a keyboard's Enter is the same.
  await user.click(takeBack);
  takeBack.focus();
  await user.keyboard("{Enter}");

  expect(wallet.sent).toHaveLength(2);
  expect(chain.calls.map((call) => call.methodName)).toEqual([
    "storage_deposit",
    "storage_withdraw",
  ]);
});

test("withdraw_adds_token_registration_when_missing_on_the_page", async () => {
  // Tokens earned on a task were never held, so the token has not registered the account. The
  // registration goes with the withdrawal, in one approval; without it the token would refuse.
  const { chain, wallet, user } = setup({ connected: true });
  chain.fundVault(ALICE, USDC, 3_000_000n);
  chain.ftBalances.get(USDC)?.delete(ALICE);
  chain.ftRegistered.get(USDC)?.delete(ALICE);
  chain.give(USDC, CONTRACT, 3_000_000n);
  render(<WalletView />);
  await screen.findByTestId("token-row");

  await user.type(within(section("Withdraw")).getByLabelText("Amount"), "1");
  await user.click(within(section("Withdraw")).getByRole("button", { name: "Withdraw" }));

  expect(await screen.findByText("Withdrew 1.00 tUSDC to your wallet.")).toBeDefined();
  expect(wallet.sent).toHaveLength(1);
  expect(
    wallet.sent[0]?.transactions.map((t) => [t.receiverId, t.actions[0]?.params.methodName]),
  ).toEqual([
    [USDC, "storage_deposit"],
    [CONTRACT, "withdraw"],
  ]);
  expect(wallet.sent[0]?.transactions[0]?.actions[0]?.params.args).toEqual({
    account_id: ALICE,
    registration_only: true,
  });
  await waitFor(() =>
    expect(textOf(screen.getByTestId("token-row"), "wallet-balance")).toBe("1.00 tUSDC"),
  );
  expect(textOf(screen.getByTestId("token-row"), "vault-balance")).toBe("2.00 tUSDC");
});

test("a_registered_account_is_not_registered_again", async () => {
  const { chain, wallet, user } = setup({ connected: true });
  chain.fundVault(ALICE, USDC, 3_000_000n);
  chain.give(USDC, CONTRACT, 3_000_000n);
  render(<WalletView />);
  await screen.findByTestId("token-row");

  await user.type(within(section("Withdraw")).getByLabelText("Amount"), "1");
  await user.click(within(section("Withdraw")).getByRole("button", { name: "Withdraw" }));

  await screen.findByText("Withdrew 1.00 tUSDC to your wallet.");
  expect(wallet.sent[0]?.transactions.map((t) => t.receiverId)).toEqual([CONTRACT]);
});

test("a_deposit_with_no_event_says_only_what_is_known_and_a_withdrawal_the_token_could_not_pay_is_told_as_such", async () => {
  const { chain, wallet, user } = setup({ connected: true });
  chain.fundVault(ALICE, USDC, 3_000_000n);
  render(<WalletView />);
  await screen.findByTestId("token-row");

  // The token stopped being taken after the page loaded: the contract refunds the deposit, and
  // the transaction is a success all the same.
  chain.tokens.set(USDC, false);
  const addForm = section("Add funds");
  await user.type(within(addForm).getByLabelText("Amount"), "4");
  await user.click(within(addForm).getByRole("button", { name: "Add funds" }));
  // No `deposit` event came back. That is all the page knows, so it does not say where the deposit
  // went: the balances it reads again do.
  expect((await within(addForm).findByTestId("notice")).textContent).toBe(
    "The wallet finished, but Tender didn't report what happened. The balances are read from the network.",
  );
  expect(chain.ftBalances.get(USDC)?.get(ALICE)).toBe(20_000_000n);
  await waitFor(() =>
    expect(textOf(screen.getByTestId("token-row"), "wallet-balance")).toBe("20.00 tUSDC"),
  );
  expect(textOf(screen.getByTestId("token-row"), "vault-balance")).toBe("3.00 tUSDC");

  // The contract holds none of the token it owes (a model's way to make the token refuse): the
  // amount is back in the vault, and the person is told.
  const withdrawForm = section("Withdraw");
  await user.type(within(withdrawForm).getByLabelText("Amount"), "1");
  await user.click(within(withdrawForm).getByRole("button", { name: "Withdraw" }));
  expect((await within(withdrawForm).findByTestId("notice")).textContent).toBe(
    "The token couldn't pay out, so the amount is back in your vault.",
  );
  expect(chain.vault.get(ALICE)?.get(USDC)).toBe(3_000_000n);
  expect(wallet.sent).toHaveLength(2);
});

test("wallet_without_sign_message_degrades_on_the_page", async () => {
  const { user, wallet } = setup({ signMessage: false });
  render(<WalletView />);

  await user.click(await button("Sign in"));

  expect((await screen.findByTestId("cannot-sign")).textContent).toBe(
    "This wallet can't sign messages. Switch wallet to post tasks or link Telegram.",
  );
  // It is a notice and not a wall: the wallet still sends transactions.
  await user.click(await button("Set up account"));
  await screen.findByText("Your account is set up. 0.05 NEAR is deposited for storage.");
  expect(wallet.sent).toHaveLength(1);
});

test("a_wallet_that_can_sign_has_no_such_notice", async () => {
  setup({ connected: true });
  render(<WalletView />);

  await screen.findByTestId("account-id");

  expect(screen.queryByTestId("cannot-sign")).toBeNull();
});

test("an_amount_that_is_not_one_is_told_in_words_and_nothing_is_sent", async () => {
  const { chain, wallet, user } = setup({ connected: true });
  chain.fundVault(ALICE, USDC, 3_000_000n);
  render(<WalletView />);
  await screen.findByTestId("token-row");
  const addForm = section("Add funds");
  const amount = within(addForm).getByLabelText("Amount");
  const submit = within(addForm).getByRole("button", { name: "Add funds" });

  const tries: Array<[string, string]> = [
    ["", "Enter an amount."],
    ["abc", "Use digits and one point, like 12.5."],
    ["0", "Enter more than 0."],
    ["0.0000001", "This token has 6 decimal places at most."],
    ["20.000001", "That's more than you have in your wallet."],
  ];
  for (const [text, message] of tries) {
    await user.clear(amount);
    if (text !== "") await user.type(amount, text);
    await user.click(submit);

    expect(within(addForm).getByTestId("amount-error").textContent, text).toBe(message);
    expect(amount.getAttribute("aria-invalid"), text).toBe("true");
    expect(amount.getAttribute("aria-describedby"), text).toContain(
      within(addForm).getByTestId("amount-error").id,
    );
  }
  expect(wallet.sent).toEqual([]);

  // A good amount clears the complaint.
  await user.clear(amount);
  await user.type(amount, "1");
  await user.click(submit);
  await within(addForm).findByTestId("notice");
  expect(within(addForm).queryByTestId("amount-error")).toBeNull();
});

test("a_wallet_that_refuses_is_told_in_words_logged_and_the_page_goes_on", async () => {
  const { wallet, user } = setup({ connected: true });
  const closed = new Error("User closed the window");
  wallet.signAndSendTransactions = async () => {
    throw closed;
  };
  render(<WalletView />);

  await user.click(await button("Set up account"));

  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toBe(
    "The wallet reported a problem. Check the balances below before you try again.",
  );
  // The original, with its cause, for a developer; nothing of it on the page.
  const logged = vi.mocked(console.error).mock.calls.flat();
  expect(logged.some((entry) => (entry as Error).cause === closed)).toBe(true);
  expect(document.body.textContent).not.toContain("closed the window");
  // And the button works again.
  expect((await button("Set up account")).getAttribute("aria-disabled")).toBe("false");
});

test("a_press_while_an_action_is_under_way_starts_no_second_dialog", async () => {
  const { wallet, user } = setup({ connected: true });
  // The wallet's dialog stays open until the test closes it, as a person's does.
  const run = wallet.signAndSendTransactions.bind(wallet);
  let dialogs = 0;
  let close: () => void = () => {};
  wallet.signAndSendTransactions = (params) => {
    dialogs++;
    return new Promise((resolve) => {
      close = () => resolve(run(params));
    });
  };
  render(<WalletView />);
  const setUp = await button("Set up account");

  await user.dblClick(setUp);

  expect(dialogs).toBe(1);
  expect((await button("Waiting for your wallet…")).getAttribute("aria-disabled")).toBe("true");
  close();
  await screen.findByText("Your account is set up. 0.05 NEAR is deposited for storage.");
  expect(dialogs).toBe(1);
});

test("a_press_that_was_meant_for_one_button_does_not_reach_the_one_that_replaced_it", async () => {
  // "Set up account" gives way to "Withdraw unused storage" in the same place. A second press of
  // the first, arriving late, must not withdraw anything.
  const { chain, wallet, user } = setup({ connected: true });
  render(<WalletView />);
  const setUp = await button("Set up account");

  await user.click(setUp);
  await screen.findByTestId("storage-total");
  await user.click(setUp);

  expect(wallet.sent).toHaveLength(1);
  expect(chain.calls.map((call) => call.methodName)).toEqual(["storage_deposit"]);
});

test("a_balance_that_cannot_be_read_is_an_error_with_a_retry_and_the_page_comes_back", async () => {
  const { chain, node, user } = setup({ connected: true });
  chain.give(USDC, ALICE, 1n);
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("fetch failed");
  });
  render(<WalletView />);

  expect((await screen.findByRole("alert")).textContent).toContain("Can't reach the server.");

  vi.stubGlobal("fetch", fakeFetch("http://rpc.test", node));
  await user.click(screen.getByRole("button", { name: "Retry" }));

  expect(await screen.findByTestId("token-row")).toBeDefined();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("balances_are_read_again_after_a_send_and_once_more_when_the_node_is_behind", async () => {
  const { chain, user } = setup({ connected: true });
  render(<WalletView laterRefreshMs={60} />);
  await screen.findByTestId("token-row");

  // A node that is a block behind: the first read after the send still shows the old vault.
  const real = chain.view.bind(chain);
  let stale = true;
  chain.view = (contractId, method, args) => {
    const view = real(contractId, method, args);
    if (stale && method === "balances_of") {
      stale = false;
      return [];
    }
    return view;
  };
  await user.click(await button("Set up account"));
  chain.fundVault(ALICE, USDC, 4_000_000n);

  await waitFor(() =>
    expect(textOf(screen.getByTestId("token-row"), "vault-balance")).toBe("4.00 tUSDC"),
  );
});

test("the_page_says_it_is_reading_the_balances_in_the_words_the_post_review_uses", async () => {
  setup({ connected: true });
  // A node that does not answer: the page is reading, and says so.
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));

  render(<WalletView />);

  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Reading your balances…"),
  );
});

test("disconnect_takes_the_balances_away_and_leaves_the_focus_on_the_page", async () => {
  const { user } = setup({ connected: true });
  render(<WalletView />);
  await screen.findByTestId("token-row");

  await user.click(await button("Disconnect"));

  await button("Sign in");
  expect(screen.queryByTestId("token-row")).toBeNull();
  expect(screen.queryByText("Storage with Tender")).toBeNull();
  expect(document.activeElement?.textContent).toBe("Connection");
});

test("a_token_that_will_not_say_what_the_account_holds_shows_a_dash_and_the_page_goes_on", async () => {
  const { chain } = setup({ connected: true });
  const real = chain.view.bind(chain);
  chain.view = (contractId, method, args) => {
    if (contractId === USDC && method === "ft_balance_of") throw new Error("MethodNotFound");
    return real(contractId, method, args);
  };
  render(<WalletView />);

  const row = await screen.findByTestId("token-row");

  expect(textOf(row, "wallet-balance")).toBe("— tusdc.testnet");
  expect(textOf(row, "vault-balance")).toBe("0.00 tUSDC");
});

// ---- The page follows the account, and what is typed follows its token --------------------------

/** A page whose wallet connects as Alice, and as Bob when it is asked again. Alice has 3 test USDC in her vault, Bob 7. */
async function setupTwoAccounts() {
  const chain = new FakeChain(CONTRACT, [{ token: USDC }]);
  chain.fundVault(ALICE, USDC, 3_000_000n);
  chain.fundVault(BOB, USDC, 7_000_000n);
  const alice = chainWallet(chain, ALICE);
  const bob = chainWallet(chain, BOB);
  const queue: Session[] = [
    { wallet: alice, accountId: ALICE },
    { wallet: bob, accountId: BOB },
  ];
  const provider = fakeProvider({ wallet: alice, accountId: ALICE });
  provider.connect = async () => queue.shift() ?? null;
  holder.store = createWalletStore(async () => provider);
  await holder.store.connect();
  vi.stubGlobal("fetch", fakeFetch("http://rpc.test", new FakeNode(chain)));
  return { chain, alice, user: userEvent.setup() };
}

/** The wallet is disconnected and connected as Bob, as from the wallet's own screen. */
const switchToBob = () =>
  act(async () => {
    await holder.store.disconnect();
    await holder.store.connect();
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the_second_read_after_an_action_is_not_made_for_an_account_that_has_been_left", async () => {
  const { user } = await setupTwoAccounts();
  render(<WalletView laterRefreshMs={250} />);
  expect(textOf(await screen.findByTestId("token-row"), "vault-balance")).toBe("3.00 tUSDC");
  await user.click(await button("Withdraw unused storage"));
  await screen.findByText("Took back your unused storage.");

  // Alice's second read is on its way. The wallet is Bob's before it comes.
  await switchToBob();
  await waitFor(() => expect(screen.getByTestId("account-id").textContent).toBe(BOB));
  await waitFor(() =>
    expect(textOf(screen.getByTestId("token-row"), "vault-balance")).toBe("7.00 tUSDC"),
  );
  await sleep(600);

  expect(screen.getByTestId("account-id").textContent).toBe(BOB);
  expect(textOf(screen.getByTestId("token-row"), "vault-balance")).toBe("7.00 tUSDC");
});

/** A wallet whose dialog stays open until the test ends it: with the transaction, or a refusal. */
function holdDialog(wallet: ChainWallet) {
  const run = wallet.signAndSendTransactions.bind(wallet);
  let end = { close() {}, refuse(_error: Error) {} };
  wallet.signAndSendTransactions = (params) =>
    new Promise((resolve, reject) => {
      end = { close: () => resolve(run(params)), refuse: reject };
    });
  return { close: () => end.close(), refuse: (error: Error) => end.refuse(error) };
}

test("an_action_that_ends_after_the_account_changed_does_not_read_the_old_balances_back", async () => {
  const { alice, user } = await setupTwoAccounts();
  const dialog = holdDialog(alice);
  render(<WalletView laterRefreshMs={50} />);
  await screen.findByTestId("token-row");
  await user.click(await button("Withdraw unused storage"));
  await button("Waiting for your wallet…");

  await switchToBob();
  await waitFor(() =>
    expect(textOf(screen.getByTestId("token-row"), "vault-balance")).toBe("7.00 tUSDC"),
  );
  dialog.close();
  await waitFor(() => expect(screen.queryByText("Waiting for your wallet…")).toBeNull());
  await sleep(300);

  expect(screen.getByTestId("account-id").textContent).toBe(BOB);
  expect(textOf(screen.getByTestId("token-row"), "vault-balance")).toBe("7.00 tUSDC");
});

test("what_an_action_came_to_is_not_told_on_the_page_of_another_account", async () => {
  const { chain, alice, user } = await setupTwoAccounts();
  const dialog = holdDialog(alice);
  render(<WalletView />);
  await screen.findByTestId("token-row");
  await user.click(await button("Withdraw unused storage"));
  await button("Waiting for your wallet…");

  // The wallet becomes Bob's while Alice's transaction waits for its approval, and then it goes
  // through.
  await switchToBob();
  await waitFor(() =>
    expect(textOf(screen.getByTestId("token-row"), "vault-balance")).toBe("7.00 tUSDC"),
  );
  dialog.close();
  await waitFor(() => expect(screen.queryByText("Waiting for your wallet…")).toBeNull());

  // It ran, and Bob's page has no word of it: not "Took back your unused storage.", not any notice.
  expect(chain.calls.map((call) => [call.signer, call.methodName])).toEqual([
    [ALICE, "storage_withdraw"],
  ]);
  expect(screen.getByTestId("account-id").textContent).toBe(BOB);
  expect(screen.queryByTestId("notice")).toBeNull();

  // What Bob does himself is told as before.
  await user.click(await button("Withdraw unused storage"));
  expect(await screen.findByText("Took back your unused storage.")).toBeDefined();
});

test("a_failure_that_comes_after_the_account_changed_is_logged_and_not_told_on_the_new_page", async () => {
  const { alice, user } = await setupTwoAccounts();
  const dialog = holdDialog(alice);
  render(<WalletView />);
  await screen.findByTestId("token-row");
  await user.click(await button("Withdraw unused storage"));
  await button("Waiting for your wallet…");
  await switchToBob();
  await waitFor(() =>
    expect(textOf(screen.getByTestId("token-row"), "vault-balance")).toBe("7.00 tUSDC"),
  );

  const closed = new Error("User closed the window");
  dialog.refuse(closed);
  await waitFor(() => expect(screen.queryByText("Waiting for your wallet…")).toBeNull());

  // "Check the balances below" would be about Bob's balances. The original is in the console.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByTestId("notice")).toBeNull();
  const logged = vi.mocked(console.error).mock.calls.flat();
  expect(logged.some((entry) => (entry as Error).cause === closed)).toBe(true);
});

/** Alice's vault holds only the second of two tokens; she holds 20 of the first herself. */
function setupTwoTokens() {
  const first = "tusdc.a.testnet";
  const second = "tusdc.b.testnet";
  const chain = new FakeChain(CONTRACT, [{ token: first }, { token: second }]);
  chain.fundVault(ALICE, second, 5_000_000n);
  chain.give(first, ALICE, 20_000_000n);
  chain.give(second, CONTRACT, 5_000_000n);
  const wallet = chainWallet(chain, ALICE);
  holder.store = createWalletStore(async () =>
    fakeProvider({ wallet, accountId: ALICE }, { restored: true }),
  );
  vi.stubGlobal("fetch", fakeFetch("http://rpc.test", new FakeNode(chain)));
  return { chain, first, second, user: userEvent.setup() };
}

test("an_amount_typed_for_a_token_stays_with_it_when_another_token_joins_the_list", async () => {
  const { chain, first, second, user } = setupTwoTokens();
  render(<WalletView />);
  await screen.findAllByTestId("token-row");
  const withdrawForm = section("Withdraw");
  const token = within(withdrawForm).getByLabelText("Token") as HTMLSelectElement;
  const amount = within(withdrawForm).getByLabelText("Amount") as HTMLInputElement;
  // Only the second token has anything in the vault: it is the only one to take out.
  expect(token.value).toBe(second);
  await user.type(amount, "3");

  // The first token gets a vault balance, and is ahead of the second in the list.
  const addForm = section("Add funds");
  await user.type(within(addForm).getByLabelText("Amount"), "4");
  await user.click(within(addForm).getByRole("button", { name: "Add funds" }));
  await waitFor(() =>
    expect(
      within(withdrawForm)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([first, second]),
  );

  // The form still has the second token and the 3 that was typed for it.
  expect(token.value).toBe(second);
  expect(amount.value).toBe("3");
  await user.click(within(withdrawForm).getByRole("button", { name: "Withdraw" }));
  await within(withdrawForm).findByText("Withdrew 3.00 tUSDC to your wallet.");
  expect(chain.calls.at(-1)).toMatchObject({ methodName: "withdraw" });
  expect(chain.calls.at(-1)?.args).toMatchObject({ token: second, amount: "3000000" });
});

test("an_amount_typed_for_a_token_that_leaves_the_list_is_not_kept_for_another", async () => {
  const { chain, first, second, user } = setupTwoTokens();
  chain.fundVault(ALICE, first, 2_000_000n);
  chain.give(first, CONTRACT, 2_000_000n);
  render(<WalletView />);
  await screen.findAllByTestId("token-row");
  const withdrawForm = section("Withdraw");
  const token = within(withdrawForm).getByLabelText("Token") as HTMLSelectElement;
  const amount = within(withdrawForm).getByLabelText("Amount") as HTMLInputElement;
  await user.selectOptions(token, second);
  await user.type(amount, "3");

  // The second token's vault balance goes (taken out elsewhere), and the page reads again.
  chain.vault.get(ALICE)?.set(second, 0n);
  const addForm = section("Add funds");
  await user.type(within(addForm).getByLabelText("Amount"), "1");
  await user.click(within(addForm).getByRole("button", { name: "Add funds" }));
  await waitFor(() =>
    expect(
      within(withdrawForm)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([first]),
  );

  // The 3 was for the second token. The first does not get it.
  expect(token.value).toBe(first);
  expect(amount.value).toBe("");
});
