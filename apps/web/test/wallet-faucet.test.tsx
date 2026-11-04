import type { NetworkId } from "@tender/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WalletView } from "../components/WalletView";
import { config } from "../lib/config";
import { createWalletStore, type WalletStore } from "../lib/wallet";
import { FakeChain, FakeNode, fakeFetch } from "./fakeChain";
import { type ChainWallet, chainWallet, fakeProvider } from "./walletDoubles";

// The "Get test tUSDC" button of the wallet page: shown on testnet and nowhere else, one approval
// for the registration (if the token needs it) and the mint, and plain words for what can go
// wrong. The real hook and store run over a wallet that runs on a model of the contract and its
// token (test/fakeChain.ts), read through a fake RPC node. vitest.config.ts gives the config the
// network testnet, the contract tender.testnet and the node http://rpc.test.

const CONTRACT = "tender.testnet";
const USDC = "tusdc.testnet";
const ALICE = "alice.testnet";

const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return { ...actual, useWallet: () => actual.useWalletStore(holder.store) };
});

interface Setup {
  chain: FakeChain;
  wallet: ChainWallet;
  user: ReturnType<typeof userEvent.setup>;
  /** Makes the node fail the reads of the token's registrations, as a node that went away does. */
  breakRegistrationReads(): void;
}

/**
 * A page for Alice, whose wallet is back. She holds nothing and the token has not registered her,
 * unless `registered`; `tokens` is what Tender lists.
 */
function setup(options: { registered?: boolean; tokens?: string[] } = {}): Setup {
  const chain = new FakeChain(
    CONTRACT,
    (options.tokens ?? [USDC]).map((token) => ({ token })),
  );
  if (options.registered === true) chain.give(USDC, ALICE, 0n);
  const node = new FakeNode(chain);
  const wallet = chainWallet(chain, ALICE);
  holder.store = createWalletStore(async () =>
    fakeProvider({ wallet, accountId: ALICE }, { restored: true }),
  );
  let broken = false;
  const route = fakeFetch("http://rpc.test", node);
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const params = typeof init?.body === "string" ? JSON.parse(init.body).params : undefined;
    // The read that asks the token whether it knows the account (NEP-145).
    if (broken && params?.account_id === USDC && params.method_name === "storage_balance_of") {
      throw new TypeError("Failed to fetch");
    }
    return route(input, init);
  });
  return {
    chain,
    wallet,
    user: userEvent.setup(),
    breakRegistrationReads: () => {
      broken = true;
    },
  };
}

const originalNetwork = config.network;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  config.network = originalNetwork;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const faucetButton = () => screen.findByRole("button", { name: "Get test tUSDC" });
const walletBalance = () => within(screen.getByTestId("token-row")).getByTestId("wallet-balance");

test("testnet_offers_free_test_tokens_in_plain_words", async () => {
  setup();
  render(<WalletView />);

  await faucetButton();
  const panel = screen.getByTestId("faucet");
  expect(within(panel).getByRole("heading", { name: "Test tokens" })).toBeDefined();
  expect(within(panel).getByText("Testnet only")).toBeDefined();
  // Free, no value, testnet only; and how much one press gives.
  expect(panel.textContent).toContain("Free test tokens with no value");
  expect(panel.textContent).toContain("exist on testnet only");
  expect(panel.textContent).toContain("One press adds 20.00 tUSDC to your wallet");
});

test("a_press_registers_the_account_and_mints_in_one_approval", async () => {
  const { chain, wallet, user } = setup();
  render(<WalletView />);
  await screen.findByTestId("token-row");
  expect(walletBalance().textContent).toBe("0.00 tUSDC");

  await user.click(await faucetButton());

  await waitFor(() => expect(walletBalance().textContent).toBe("20.00 tUSDC"));
  // One batch to the wallet, of one transaction, of the registration and then the mint.
  expect(wallet.sent).toHaveLength(1);
  expect(wallet.sent[0]?.transactions).toHaveLength(1);
  const [transaction] = wallet.sent[0]?.transactions ?? [];
  expect(transaction?.receiverId).toBe(USDC);
  expect(transaction?.actions.map((action) => action.params.methodName)).toEqual([
    "storage_deposit",
    "mint",
  ]);
  expect(transaction?.actions[0]?.params.args).toEqual({
    account_id: ALICE,
    registration_only: true,
  });
  expect(transaction?.actions[1]?.params).toMatchObject({
    args: { account_id: ALICE, amount: "20000000" },
    deposit: "0",
  });
  expect(chain.view(USDC, "ft_balance_of", { account_id: ALICE })).toBe("20000000");
  expect(within(screen.getByTestId("faucet")).getByTestId("notice").textContent).toBe(
    "Added 20.00 tUSDC to your wallet. They are free test tokens with no value.",
  );
});

test("a_registered_account_is_only_minted_to", async () => {
  const { wallet, user } = setup({ registered: true });
  render(<WalletView />);
  await screen.findByTestId("token-row");

  await user.click(await faucetButton());

  await waitFor(() => expect(walletBalance().textContent).toBe("20.00 tUSDC"));
  expect(wallet.sent).toHaveLength(1);
  expect(
    wallet.sent[0]?.transactions.map((t) => t.actions.map((a) => a.params.methodName)),
  ).toEqual([["mint"]]);
});

test("pressing_again_adds_the_amount_again", async () => {
  const { wallet, user } = setup();
  render(<WalletView />);
  await screen.findByTestId("token-row");

  await user.click(await faucetButton());
  await waitFor(() => expect(walletBalance().textContent).toBe("20.00 tUSDC"));
  await user.click(await faucetButton());

  await waitFor(() => expect(walletBalance().textContent).toBe("40.00 tUSDC"));
  // The second press finds the account registered: the mint alone.
  expect(wallet.sent.map((b) => b.transactions[0]?.actions.length)).toEqual([2, 1]);
});

test.each(["mainnet", "sandbox"] as NetworkId[])(
  "the_faucet_is_not_on_the_page_on_%s",
  async (network) => {
    const { wallet } = setup({ registered: true });
    config.network = network;
    render(<WalletView />);

    // The rest of the page is there, and the faucet is not.
    await screen.findByTestId("token-row");
    expect(screen.queryByTestId("faucet")).toBeNull();
    expect(screen.queryByRole("button", { name: /test tUSDC/ })).toBeNull();
    expect(screen.queryByText("Test tokens")).toBeNull();
    expect(wallet.sent).toEqual([]);
  },
);

test("the_faucet_waits_for_the_wallet_like_the_page", async () => {
  // Signed out, there is no account to mint to, and the page reads nothing.
  const chain = new FakeChain(CONTRACT, [{ token: USDC }]);
  const wallet = chainWallet(chain, ALICE);
  holder.store = createWalletStore(async () => fakeProvider({ wallet, accountId: ALICE }));
  vi.stubGlobal("fetch", fakeFetch("http://rpc.test", new FakeNode(chain)));
  render(<WalletView />);

  await screen.findByRole("button", { name: "Connect wallet" });
  expect(screen.queryByTestId("faucet")).toBeNull();
});

test("when_tender_lists_no_test_token_the_faucet_says_so_and_offers_no_button", async () => {
  setup({ tokens: ["wrap.testnet"] });
  render(<WalletView />);

  const panel = await screen.findByTestId("faucet");
  expect(within(panel).getByTestId("faucet-unavailable").textContent).toBe(
    "Tender lists no test token right now.",
  );
  expect(within(panel).queryByRole("button")).toBeNull();
});

test("a_wallet_that_is_closed_or_throws_is_told_and_nothing_is_minted", async () => {
  const { chain, wallet, user } = setup();
  wallet.signAndSendTransactions = async () => {
    throw new Error("User rejected");
  };
  render(<WalletView />);
  await screen.findByTestId("token-row");

  await user.click(await faucetButton());

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(
    "The wallet reported a problem. Check the balances below before you try again.",
  );
  expect(chain.view(USDC, "ft_balance_of", { account_id: ALICE })).toBe("0");
  // The button is back for another try.
  expect((await faucetButton()).getAttribute("aria-disabled")).toBe("false");
});

test("a_transaction_that_fails_on_the_network_is_told_as_such", async () => {
  const { user, wallet } = setup();
  wallet.signAndSendTransactions = async () => [
    {
      transaction: { hash: "TXFAIL" },
      status: {
        Failure: {
          ActionError: {
            index: 1,
            kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: boom" } },
          },
        },
      },
      receipts_outcome: [],
    },
  ];
  render(<WalletView />);
  await screen.findByTestId("token-row");

  await user.click(await faucetButton());

  expect((await screen.findByRole("alert")).textContent).toBe(
    "The transaction failed on the network.",
  );
  expect(walletBalance().textContent).toBe("0.00 tUSDC");
});

test("when_the_token_cannot_be_asked_if_it_knows_the_account_nothing_is_sent", async () => {
  const { user, wallet, breakRegistrationReads } = setup();
  render(<WalletView />);
  await screen.findByTestId("token-row");
  breakRegistrationReads();

  await user.click(await faucetButton());

  expect((await screen.findByRole("alert")).textContent).toBe(
    "Can't reach the server. Check your connection and try again.",
  );
  // No wallet dialog was opened for a batch that could not be planned.
  expect(wallet.sent).toEqual([]);
});

test("a_second_press_while_the_wallet_is_open_does_not_open_a_second_dialog", async () => {
  const { user, wallet } = setup();
  const runOnChain = wallet.signAndSendTransactions.bind(wallet);
  let opened = 0;
  let release: () => void = () => {};
  wallet.signAndSendTransactions = async (params) => {
    opened++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return runOnChain(params);
  };
  render(<WalletView />);
  await screen.findByTestId("token-row");

  await user.click(await faucetButton());
  const waiting = await screen.findByRole("button", { name: "Waiting for your wallet…" });
  expect(waiting.getAttribute("aria-disabled")).toBe("true");
  await user.click(waiting);
  expect(opened).toBe(1);

  // The wallet finishes; the page goes back to its button, with the balance.
  release();
  await waitFor(() => expect(walletBalance().textContent).toBe("20.00 tUSDC"));
  expect(opened).toBe(1);
  expect((await faucetButton()).getAttribute("aria-disabled")).toBe("false");
});
