import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { AppShell } from "../components/AppShell";
import { Avatar, avatarCells } from "../components/Avatar";

// The app's frame (components/AppShell.tsx): the sidebar, the top bar, and the menu that the sidebar
// is on a phone. And the avatar that the board draws for a poster. The top bar's Live pill is in
// live-status.test.tsx, and the sidebar's rail in sidebar.test.tsx.

// No jest-dom here (X-20): plain assertions on what the Testing Library finds.

const pathname = vi.hoisted(() => ({ current: "/tasks" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

// The wallet as the top bar reads it: a store that nothing here starts, with the account a test
// sets. The real one (lib/wallet.ts) would look for near-connect.
const wallet = vi.hoisted(() => ({
  state: { ready: true, accountId: null as string | null, canSignMessage: true },
  listeners: new Set<() => void>(),
}));
vi.mock("../lib/wallet", () => ({
  walletStore: {
    subscribe: (listener: () => void) => {
      wallet.listeners.add(listener);
      return () => wallet.listeners.delete(listener);
    },
    getSnapshot: () => wallet.state,
    getServerSnapshot: () => wallet.state,
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
  wallet.state = { ...wallet.state, accountId: null };
});

test("shell_has_the_page_the_post_pill_and_the_way_to_the_wallet", () => {
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
  // The way to the wallet is a link to its page, not a second Connect wallet button: the pages
  // that connect have their own, and there is one such button on a page.
  expect(banner.getByRole("link", { name: "Connect wallet" }).getAttribute("href")).toBe("/wallet");
  expect(screen.queryByRole("button", { name: "Connect wallet" })).toBeNull();
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
  expect(banner.getByRole("link", { name: "Connect wallet" })).toBeTruthy();

  // A page connected the wallet: the same place now names the account, and still leads to the
  // wallet page.
  act(() => {
    wallet.state = { ...wallet.state, accountId: "alice.testnet" };
    for (const listener of wallet.listeners) listener();
  });
  expect(banner.queryByRole("link", { name: "Connect wallet" })).toBeNull();
  expect(banner.getByRole("link", { name: "alice.testnet" }).getAttribute("href")).toBe("/wallet");
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
