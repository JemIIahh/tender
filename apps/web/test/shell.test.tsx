import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { AppShell } from "../components/AppShell";
import { Avatar, avatarCells } from "../components/Avatar";
import { WalletError } from "../lib/walletErrors";

// The app's frame (components/AppShell.tsx): the sidebar, the top bar, and the menu that the sidebar
// is on a phone. And the avatar that the board draws for a poster. The top bar's Live pill is in
// live-status.test.tsx, and the sidebar's rail in sidebar.test.tsx.

// No jest-dom here (X-20): plain assertions on what the Testing Library finds.

const pathname = vi.hoisted(() => ({ current: "/tasks" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

// The wallet as the top bar reads it: a store whose start and connect are counted and do nothing
// (a connect fails with `failWith`, when a test sets it), with the state a test sets. The real one
// (lib/wallet.ts) would look for near-connect.
const wallet = vi.hoisted(() => ({
  state: { ready: true, accountId: null as string | null, canSignMessage: true },
  listeners: new Set<() => void>(),
  starts: 0,
  connects: 0,
  failWith: null as Error | null,
}));
vi.mock("../lib/wallet", () => ({
  walletStore: {
    subscribe: (listener: () => void) => {
      wallet.listeners.add(listener);
      return () => wallet.listeners.delete(listener);
    },
    getSnapshot: () => wallet.state,
    getServerSnapshot: () => wallet.state,
    start: async () => {
      wallet.starts++;
    },
    connect: async () => {
      wallet.connects++;
      if (wallet.failWith !== null) throw wallet.failWith;
    },
  },
}));

/** A `fetch` that answers by the address's path and query, and fails anything else. */
function fakeApi(routes: Record<string, () => Response>): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const answer = routes[`${url.pathname}${url.search}`];
    if (answer === undefined) throw new TypeError("Failed to fetch");
    return answer();
  });
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wallet.state = { ...wallet.state, ready: true, accountId: null };
  wallet.starts = 0;
  wallet.connects = 0;
  wallet.failWith = null;
});

test("shell_has_the_page_the_post_pill_and_sign_in_which_opens_the_window_where_you_are", async () => {
  fakeApi({});
  render(
    <AppShell>
      <h1>The page</h1>
    </AppShell>,
  );

  expect(within(screen.getByRole("main")).getByRole("heading", { level: 1 }).textContent).toBe(
    "The page",
  );
  const banner = within(screen.getByRole("banner"));
  expect(banner.getByRole("link", { name: "Post task" }).getAttribute("href")).toBe("/post");
  // Sign in is a button that opens the Connect window over this page (the store's connect), and no
  // link: the person stays on the page they are on.
  const signIn = banner.getByRole("button", { name: "Sign in" });
  expect(banner.queryByRole("link", { name: "Sign in" })).toBeNull();
  await userEvent.click(signIn);
  expect(wallet.connects).toBe(1);
  // The skip link leads past the sidebar to the page.
  expect(screen.getByRole("link", { name: "Skip to the page" }).getAttribute("href")).toBe("#main");
  expect(screen.getByRole("main").id).toBe("main");
});

test("shell_top_bar_names_the_connected_account_once_the_tab_has_one", () => {
  fakeApi({});
  render(
    <AppShell>
      <p>The page</p>
    </AppShell>,
  );
  const banner = within(screen.getByRole("banner"));
  expect(banner.getByRole("button", { name: "Sign in" })).toBeTruthy();

  // The person signed in: the same place now names the account, which leads to the wallet page.
  act(() => {
    wallet.state = { ...wallet.state, accountId: "alice.testnet" };
    for (const listener of wallet.listeners) listener();
  });
  expect(banner.queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(banner.getByRole("link", { name: "alice.testnet" }).getAttribute("href")).toBe("/wallet");
  // Beside it, a button that copies the account.
  expect(banner.getByRole("button", { name: "Copy account" })).toBeTruthy();
});

test("shell_starts_the_wallet_and_shows_no_connect_until_it_knows", () => {
  fakeApi({});
  wallet.state = { ...wallet.state, ready: false, accountId: null };
  render(
    <AppShell>
      <p>The page</p>
    </AppShell>,
  );
  const banner = within(screen.getByRole("banner"));
  // The shell looks for the wallet of an earlier visit on every page.
  expect(wallet.starts).toBe(1);

  // Not ready: a placeholder of the pill, which says what it is, and no Sign in.
  const checking = banner.getByRole("status", { name: "Checking if you're signed in…" });
  expect(checking.className).toContain("animate-pulse");
  expect(checking.className).toContain("motion-reduce:animate-none");
  expect(banner.queryByRole("button", { name: "Sign in" })).toBeNull();

  // Ready with no account: Sign in, and the placeholder is gone.
  act(() => {
    wallet.state = { ...wallet.state, ready: true, accountId: null };
    for (const listener of wallet.listeners) listener();
  });
  expect(banner.queryByRole("status", { name: "Checking if you're signed in…" })).toBeNull();
  expect(banner.getByRole("button", { name: "Sign in" })).toBeTruthy();

  // Ready with an account: the account's pill, and no Sign in.
  act(() => {
    wallet.state = { ...wallet.state, ready: true, accountId: "alice.testnet" };
    for (const listener of wallet.listeners) listener();
  });
  expect(banner.queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(banner.getByRole("link", { name: "alice.testnet" }).getAttribute("href")).toBe("/wallet");
});

test("a_sign_in_from_the_bar_that_fails_says_so_under_it_until_the_next_press", async () => {
  fakeApi({});
  wallet.failWith = new WalletError("connect", new Error("the wallet's window failed to load"));
  render(
    <AppShell>
      <p>The page</p>
    </AppShell>,
  );
  const banner = within(screen.getByRole("banner"));
  await userEvent.click(banner.getByRole("button", { name: "Sign in" }));
  expect((await banner.findByRole("alert")).textContent).toBe("Couldn't sign in. Try again.");
  // The next press starts again without it.
  wallet.failWith = null;
  await userEvent.click(banner.getByRole("button", { name: "Sign in" }));
  expect(banner.queryByRole("alert")).toBeNull();
  expect(wallet.connects).toBe(2);
});

test("shell_goes_straight_from_checking_to_the_account_with_no_connect_between", () => {
  fakeApi({});
  wallet.state = { ...wallet.state, ready: false, accountId: null };
  render(
    <AppShell>
      <p>The page</p>
    </AppShell>,
  );
  const banner = within(screen.getByRole("banner"));
  expect(banner.getByRole("status", { name: "Checking if you're signed in…" })).toBeTruthy();
  // The store takes up the wallet of an earlier visit: the account, never Sign in, comes next.
  act(() => {
    wallet.state = { ...wallet.state, ready: true, accountId: "alice.testnet" };
    for (const listener of wallet.listeners) listener();
  });
  expect(banner.getByRole("link", { name: "alice.testnet" })).toBeTruthy();
  expect(banner.queryByRole("button", { name: "Sign in" })).toBeNull();
});

test("shell_menu_opens_and_closes_the_sidebar_on_a_phone", async () => {
  fakeApi({});
  pathname.current = "/tasks";
  const { rerender } = render(
    <AppShell>
      <p>The page</p>
    </AppShell>,
  );
  const menu = screen.getByRole("button", { name: "Menu" });
  const sidebar = document.getElementById(menu.getAttribute("aria-controls") ?? "");
  expect(sidebar?.contains(screen.getByRole("navigation", { name: "Main" }))).toBe(true);
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(sidebar?.getAttribute("data-open")).toBe("false");

  await userEvent.click(menu);
  expect(menu.getAttribute("aria-expanded")).toBe("true");
  expect(sidebar?.getAttribute("data-open")).toBe("true");

  // Escape closes it, from wherever the keyboard is in it, and the focus goes back to the button:
  // the link it was on goes off the page with the menu.
  screen.getByRole("link", { name: "Browse agents" }).focus();
  await userEvent.keyboard("{Escape}");
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(menu);

  // A page chosen from it closes it too.
  await userEvent.click(menu);
  expect(menu.getAttribute("aria-expanded")).toBe("true");
  pathname.current = "/agents";
  rerender(
    <AppShell>
      <p>The next page</p>
    </AppShell>,
  );
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(sidebar?.getAttribute("data-open")).toBe("false");
});

test("shell_page_under_the_open_menu_is_out_of_reach", async () => {
  fakeApi({});
  pathname.current = "/tasks";
  render(
    <AppShell>
      <button type="button">A control of the page</button>
    </AppShell>,
  );
  const main = document.getElementById("main");
  const menu = screen.getByRole("button", { name: "Menu" });
  expect(main?.hasAttribute("inert")).toBe(false);

  // Open, the menu covers the page: the page is inert, so Tab past the menu's last link cannot
  // land on a control hidden under it. The top bar, above the menu, stays in reach.
  await userEvent.click(menu);
  expect(main?.hasAttribute("inert")).toBe(true);
  expect(main?.contains(screen.getByText("A control of the page"))).toBe(true);
  expect(screen.getByRole("banner").closest("[inert]")).toBeNull();
  expect(screen.getByRole("navigation", { name: "Main" }).closest("[inert]")).toBeNull();

  await userEvent.click(menu);
  expect(main?.hasAttribute("inert")).toBe(false);
});

test("shell_menu_left_open_closes_when_the_window_grows_to_a_laptop", async () => {
  fakeApi({});
  pathname.current = "/tasks";
  // A phone that is turned, or a window made wider: the media query starts out narrow.
  const listeners = new Set<(event: { matches: boolean }) => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
      listeners.delete(listener),
  }));
  render(
    <AppShell>
      <p>The page</p>
    </AppShell>,
  );
  const menu = screen.getByRole("button", { name: "Menu" });
  await userEvent.click(menu);
  expect(document.getElementById("main")?.hasAttribute("inert")).toBe(true);

  act(() => {
    for (const listener of listeners) listener({ matches: true });
  });
  // The sidebar is a sidebar again, and the page is not left inert.
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById("main")?.hasAttribute("inert")).toBe(false);
});

test("avatar_is_the_same_for_an_account_and_differs_between_accounts", () => {
  const draw = (account: string) => JSON.stringify(avatarCells(account));
  expect(draw("alice.testnet")).toBe(draw("alice.testnet"));
  const accounts = [
    "alice.testnet",
    "bob.testnet",
    "poster.tender-team.testnet",
    "c0ffee13".repeat(8),
  ];
  expect(new Set(accounts.map(draw)).size).toBe(accounts.length);
  // Mirrored about the middle column, with something lit and at most one red cell.
  for (const account of accounts) {
    const cells = avatarCells(account);
    expect(cells.length, account).toBeGreaterThan(0);
    expect(cells.filter((cell) => cell.accent).length, account).toBeLessThanOrEqual(1);
    for (const cell of cells) {
      expect(
        cells.some((other) => other.x === 4 - cell.x && other.y === cell.y),
        account,
      ).toBe(true);
    }
  }
  // Decoration: hidden from a screen reader, which reads the account next to it.
  const { container } = render(<Avatar account="alice.testnet" />);
  expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
});
