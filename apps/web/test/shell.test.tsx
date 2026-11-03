import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { AppShell } from "../components/AppShell";
import { Avatar, avatarCells } from "../components/Avatar";
import { PlatformStats } from "../components/PlatformStats";
import { agent, summary } from "./tasks";

// The app's frame (components/AppShell.tsx): the sidebar and its live figures, the top bar, and the
// menu that the sidebar is on a phone. And the avatar that the board draws for a poster.

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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

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

const HEALTH = {
  ok: true,
  network: "testnet",
  contract: "tender.testnet",
  indexed_height: "100",
  chain_final_height: "100",
  lag_blocks: "0",
  waiting_for_chain: false,
};

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

  // Escape closes it.
  await userEvent.keyboard("{Escape}");
  expect(menu.getAttribute("aria-expanded")).toBe("false");

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

test("platform_stats_show_the_figures_the_api_gives_and_only_reads", async () => {
  const urls = fakeApi({
    "/v1/tasks?phase=open&limit=50": () =>
      json({
        tasks: [summary({ id: "7", reward: "1500000" }), summary({ id: "8", reward: "500000" })],
        next_cursor: null,
      }),
    "/v1/agents?limit=50": () => json({ agents: [agent()], next_cursor: "next" }),
    "/v1/health": () => json(HEALTH),
  });
  render(<PlatformStats />);

  const block = await screen.findByTestId("platform-stats");
  const stats = within(block)
    .getAllByTestId("stat")
    .map((row) => row.textContent);
  expect(stats).toEqual([
    "Open tasks2",
    "In escrow on open tasks2.00 tUSDC",
    // A full page with more after it: at least that many, and said so.
    "Agents1+",
    "Indexin sync",
  ]);
  expect(urls.sort()).toEqual([
    "GET /v1/agents?limit=50",
    "GET /v1/health",
    "GET /v1/tasks?phase=open&limit=50",
  ]);
});

test("platform_stats_leave_out_a_figure_the_api_did_not_give", async () => {
  fakeApi({
    "/v1/agents?limit=50": () => json({ agents: [agent()], next_cursor: null }),
    "/v1/health": () => json({ ...HEALTH, lag_blocks: "0", waiting_for_chain: true }),
  });
  render(<PlatformStats />);

  const block = await screen.findByTestId("platform-stats");
  expect(
    within(block)
      .getAllByTestId("stat")
      .map((row) => row.textContent),
  ).toEqual(["Agents1", "Indexwaiting for the chain"]);
});

test("platform_stats_are_not_there_when_the_api_is_down", async () => {
  const urls = fakeApi({});
  render(<PlatformStats />);

  await waitFor(() => expect(urls).toHaveLength(3));
  // Each read failed: nothing to show, and nothing made up in its place.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByTestId("platform-stats")).toBeNull();
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
