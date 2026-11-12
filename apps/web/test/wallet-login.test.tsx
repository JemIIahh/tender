import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AccountGroup, shortAccount } from "../components/AccountPill";
import { WalletView } from "../components/WalletView";
import { LOGIN_HOLDS_KEY } from "../lib/copy";
import { createWalletStore, type KeyHolder, type WalletStore } from "../lib/wallet";
import { FakeChain, FakeNode, fakeFetch } from "./fakeChain";
import { chainWallet, fakeProvider } from "./walletDoubles";

// An account of the email and Google login on the wallet page and in the top bar: how the person
// logs in, the account cut short with a copy button, one line on who holds the key, Log out (which
// ends the Tender session and the login's) and Export key (the login's own window).

const CONTRACT = "tender.testnet";
const ACCOUNT = "0a1b".repeat(16);

const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return { ...actual, useWallet: () => actual.useWalletStore(holder.store) };
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function open(login: KeyHolder["login"]) {
  const chain = new FakeChain(CONTRACT, [{ token: "tusdc.testnet" }]);
  vi.stubGlobal("fetch", fakeFetch("http://rpc.test", new FakeNode(chain)));
  const exported: number[] = [];
  const keyHolder: KeyHolder = {
    login,
    exportKey: async () => {
      exported.push(1);
    },
    loginToken: async () => "login-token",
  };
  const provider = fakeProvider(
    { wallet: chainWallet(chain, ACCOUNT), accountId: ACCOUNT, keyHolder },
    { restored: true },
  );
  holder.store = createWalletStore(async () => provider);
  render(<WalletView laterRefreshMs={10} />);
  return { provider, exported, user: userEvent.setup() };
}

test("a_login_account_says_how_it_logs_in_who_holds_its_key_and_offers_log_out_and_export", async () => {
  const { provider, exported, user } = open("email");

  expect((await screen.findByTestId("login-label")).textContent).toBe("Email login");
  const account = screen.getByTestId("account-id");
  expect(account.textContent).toBe(`${ACCOUNT.slice(0, 8)}…${ACCOUNT.slice(-8)}`);
  expect(account.getAttribute("title")).toBe(ACCOUNT);
  expect(screen.getByRole("button", { name: "Copy account" })).toBeTruthy();
  expect(screen.getByTestId("key-holder").textContent).toBe(LOGIN_HOLDS_KEY);
  expect(LOGIN_HOLDS_KEY).toBe("Privy keeps this account's key; you unlock it by logging in.");
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Export key" }));
  expect(exported).toEqual([1]);

  await user.click(screen.getByRole("button", { name: "Log out" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy());
  expect(provider.disconnects).toBe(1);
});

test("a_google_login_says_so", async () => {
  open("google");
  expect((await screen.findByTestId("login-label")).textContent).toBe("Google login");
});

test("the_top_bar_names_the_login_and_cuts_an_implicit_account_short", () => {
  expect(shortAccount(ACCOUNT)).toBe(`${ACCOUNT.slice(0, 6)}…${ACCOUNT.slice(-4)}`);
  expect(shortAccount("alice.testnet")).toBe("alice.testnet");

  const { container, rerender } = render(<AccountGroup ready accountId={ACCOUNT} login="google" />);
  const link = within(container).getByRole("link");
  expect(link.getAttribute("title")).toBe(`Google login: ${ACCOUNT}`);
  expect(within(container).getByTestId("pill-login").textContent).toBe("Google login");
  expect(link.textContent).toContain(shortAccount(ACCOUNT));

  // A login whose method the user's accounts don't name: a neutral word.
  rerender(<AccountGroup ready accountId={ACCOUNT} login={null} />);
  expect(within(container).getByTestId("pill-login").textContent).toBe("Login");

  // A wallet's own account: no login named.
  rerender(<AccountGroup ready accountId="alice.testnet" />);
  expect(within(container).queryByTestId("pill-login")).toBeNull();
  expect(within(container).getByRole("link").getAttribute("title")).toBe("alice.testnet");
});
