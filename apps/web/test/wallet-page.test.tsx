import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WalletView } from "../components/WalletView";
import type { WalletStore } from "../lib/wallet";
import { createWalletStore } from "../lib/wallet";
import { FakeChain, FakeNode, fakeFetch } from "./fakeChain";
import { type ChainWallet, chainWallet, fakeProvider } from "./walletDoubles";

// The wallet page, as a person uses it: the real hook and store over a wallet that runs on a model
// of the contract and its token, read through a fake RPC node. vitest.config.ts gives the config
// the network testnet, the contract tender.testnet and the node http://rpc.test.

const CONTRACT = "tender.testnet";
const USDC = "tusdc.testnet";
const ALICE = "alice.testnet";

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
  expect(screen.getByRole("status").textContent).toBe("Checking for your wallet…");
  await button("Connect wallet");
  expect(screen.queryByText("Balances")).toBeNull();
  expect(screen.queryByText("Storage with Tender")).toBeNull();
  expect(fetchCalls).toEqual([]);
});

test("register_deposit_withdraw_round_trip_on_the_page", async () => {
  const { chain, wallet, user } = setup();
  render(<WalletView />);

  // Connect.
  await user.click(await button("Connect wallet"));
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

  // Take back the storage that is not used.
  await user.click(await button("Withdraw unused storage"));
  await waitFor(() =>
    expect(screen.getByTestId("storage-available").textContent).toBe("0.00 NEAR"),
  );
  expect(chain.calls.at(-1)).toMatchObject({ methodName: "storage_withdraw", deposit: 1n });
  expect(chain.calls.at(-1)?.args).toEqual({});
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

test("a_deposit_the_contract_sent_back_and_a_withdrawal_the_token_could_not_pay_are_told_as_such", async () => {
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
  expect((await within(addForm).findByTestId("notice")).textContent).toContain(
    "Tender sent the deposit back, so nothing was added.",
  );
  expect(chain.ftBalances.get(USDC)?.get(ALICE)).toBe(20_000_000n);

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

  await user.click(await button("Connect wallet"));

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
    "The wallet didn't send that. Check the balances below, then try again.",
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

test("disconnect_takes_the_balances_away_and_leaves_the_focus_on_the_page", async () => {
  const { user } = setup({ connected: true });
  render(<WalletView />);
  await screen.findByTestId("token-row");

  await user.click(await button("Disconnect"));

  await button("Connect wallet");
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
