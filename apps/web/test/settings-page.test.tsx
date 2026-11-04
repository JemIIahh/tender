import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SettingsView, withoutQuery } from "../components/SettingsView";
import { clearApiToken, heldToken, keepToken, signInTicket } from "../lib/apiToken";
import { SIDEBAR_KEY, setRail } from "../lib/sidebar";
import { createWalletStore, type WalletStore } from "../lib/wallet";
import { ALICE, accountWallet, world } from "./accountFakes";
import { fakeProvider } from "./walletDoubles";

// Settings (components/SettingsView.tsx): the account and its API sign-in, Telegram, the sidebar's
// state (the one key lib/sidebar.ts keeps), motion, and the network to copy. Nothing on chain.

const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return { ...actual, useWallet: () => actual.useWalletStore(holder.store) };
});

const TOKEN_TEXT = "secret-bearer-token-of-the-test";

function open(connected: boolean) {
  holder.store = createWalletStore(async () =>
    fakeProvider(accountWallet(world()), { restored: connected }),
  );
  render(<SettingsView />);
  return userEvent.setup();
}

beforeEach(() => {
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("no request is expected");
  });
  clearApiToken();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-sidebar");
});

afterEach(() => {
  clearApiToken();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-sidebar");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("settings_without_a_wallet_point_to_the_wallet_and_say_there_is_no_sign_in", async () => {
  open(false);
  const account = screen.getByTestId("settings-account");
  await within(account).findByText("No wallet connected.");
  expect(
    within(account).getByRole("link", { name: "Connect on Wallet" }).getAttribute("href"),
  ).toBe("/wallet");
  expect(screen.getByTestId("settings-session").textContent).toContain("Not signed in.");
  expect(screen.queryByRole("button", { name: "Sign out of the API" })).toBeNull();
  // Telegram is linked on its own page.
  expect(
    within(account).getByRole("link", { name: "Telegram settings" }).getAttribute("href"),
  ).toBe("/telegram");
});

test("settings_show_the_account_and_end_the_api_sign_in_without_showing_the_token", async () => {
  keepToken(
    { accountId: ALICE, token: TOKEN_TEXT, expiresAtMs: Date.now() + 3_600_000 },
    signInTicket(),
  );
  const user = open(true);
  expect((await screen.findByTestId("settings-wallet")).textContent).toBe(ALICE);
  await waitFor(() =>
    expect(screen.getByTestId("settings-session").textContent).toMatch(/^Signed in until /),
  );
  // The token is a secret: it is nowhere on the page.
  expect(document.body.textContent).not.toContain(TOKEN_TEXT);

  await user.click(screen.getByRole("button", { name: "Sign out of the API" }));
  expect(heldToken()).toBeNull();
  expect(window.sessionStorage.getItem("tender.apiToken")).toBeNull();
  // Only this tab forgets it: the API has no way to end a token before it expires.
  expect(screen.getByTestId("settings-session").textContent).toContain("Signed out in this tab.");
  expect(screen.queryByRole("button", { name: "Sign out of the API" })).toBeNull();
});

test("settings_choose_the_sidebar_in_its_one_key_and_follow_a_change_made_elsewhere", async () => {
  const user = open(false);
  const full = screen.getByRole("radio", { name: /Full/ }) as HTMLInputElement;
  const rail = screen.getByRole("radio", { name: /Icons only/ }) as HTMLInputElement;
  expect(full.checked).toBe(true);

  await user.click(rail);
  expect(document.documentElement.getAttribute("data-sidebar")).toBe("rail");
  expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("rail");
  await user.click(full);
  expect(document.documentElement.getAttribute("data-sidebar")).toBeNull();
  expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("full");

  // ⌘B or the sidebar's own button changes the same state, and the choice here follows it.
  act(() => setRail(true));
  expect(rail.checked).toBe(true);
});

test("settings_say_that_motion_follows_the_system", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  open(false);
  expect(screen.getByTestId("settings-motion").textContent).toBe(
    "Follows your system. Reduced motion is on: nothing moves by itself.",
  );
});

test("settings_show_the_network_to_copy_and_no_more_of_an_rpc_address_than_is_public", async () => {
  const user = open(false);
  const network = screen.getByTestId("settings-network");
  expect(
    within(network)
      .getAllByTestId("settings-value")
      .map((value) => value.textContent),
  ).toEqual(["NEAR testnet", "tender.testnet", "http://rpc.test", "http://api.test"]);
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await user.click(within(network).getByRole("button", { name: "Copy contract" }));
  expect(writeText).toHaveBeenCalledWith("tender.testnet");
  expect(within(network).getByRole("button", { name: "Copy contract" }).textContent).toBe("Copied");

  // An address with a key in its query, or a password, shows without them.
  expect(withoutQuery("https://rpc.example/v1?apiKey=abc#x")).toEqual({
    shown: "https://rpc.example/v1",
    cut: true,
  });
  expect(withoutQuery("https://user:pass@rpc.example/")).toEqual({
    shown: "https://rpc.example/",
    cut: true,
  });
  expect(withoutQuery("http://rpc.test")).toEqual({ shown: "http://rpc.test", cut: false });
});
