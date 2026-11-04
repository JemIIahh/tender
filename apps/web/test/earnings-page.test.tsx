import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EarningsView } from "../components/account/EarningsView";
import { createWalletStore, type WalletStore } from "../lib/wallet";
import {
  ALICE,
  accountWallet,
  entryRow,
  pickedTask,
  row,
  SCOUT,
  serve,
  TOKEN,
  type World,
  world,
} from "./accountFakes";
import { CREATED, SECOND, summary } from "./tasks";
import { fakeProvider } from "./walletDoubles";

// Earnings, over a fake API: what the agents won (the payouts their tasks' outcomes record), what
// waits on a pick, and where the rewards of the tasks the account posted went. The tab is in the
// address, which a tiny model of the router holds.

const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return { ...actual, useWallet: () => actual.useWalletStore(holder.store) };
});

const nav = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const model = {
    query: new URLSearchParams(),
    replaced: [] as string[],
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => model.query,
    replace(url: string) {
      model.replaced.push(url);
      model.query = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?")) : "");
      for (const listener of listeners) listener();
    },
  };
  return model;
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/earnings",
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => useSyncExternalStore(nav.subscribe, nav.snapshot, nav.snapshot),
}));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  nav.query = new URLSearchParams();
  nav.replaced = [];
  // The fixtures' clock: inside the commit window of the default deadlines.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Number(CREATED / 1_000_000n) + 60_000));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const past = {
  created_at: (CREATED - 3_000n * SECOND).toString(),
  commit_deadline: (CREATED - 2_500n * SECOND).toString(),
  reveal_deadline: (CREATED - 2_000n * SECOND).toString(),
  pick_deadline: (CREATED - 1_500n * SECOND).toString(),
  fallback_deadline: (CREATED - 1_000n * SECOND).toString(),
};

/** Alice and her scout have won a task each and wait on two picks; she posted four tasks. */
function aliceEarned(bonds = false): World {
  const state = world();
  state.agents.set(
    ALICE,
    row({
      account: ALICE,
      name: "Alice Extractor",
      entries: 3,
      wins: 1,
      earned: { [TOKEN]: "1900000" },
      ...(bonds ? { status: "active", bond_token: TOKEN, bond_amount: "5000000" } : {}),
    }),
  );
  state.under.set(ALICE, [
    row({
      account: SCOUT,
      asp: ALICE,
      name: "Alice Scout",
      entries: 2,
      wins: 1,
      earned: { [TOKEN]: "2850000" },
    }),
  ]);
  state.entries.set(ALICE, [
    entryRow("24", { phase: "judging" }),
    entryRow("21", { won: true }),
    entryRow("2", { phase: "open", revealed: false }),
  ]);
  state.entries.set(SCOUT, [entryRow("25", { phase: "revealing" }), entryRow("22", { won: true })]);
  state.tasks.set("21", pickedTask("21", 2_000_000n, [[ALICE, 10_000]]));
  state.tasks.set(
    "22",
    pickedTask("22", 5_000_000n, [
      [SCOUT, 6_000],
      ["carol.testnet", 4_000],
    ]),
  );
  state.posted.set(ALICE, [
    summary({
      id: "34",
      title: "Label receipts",
      poster: ALICE,
      reward: "750000",
      token: TOKEN,
      ...past,
    }),
    summary({
      id: "33",
      title: "Translate notes",
      poster: ALICE,
      reward: "500000",
      token: TOKEN,
      outcome_kind: "voided",
      phase: "settled",
    }),
    summary({
      id: "32",
      title: "Extract fields",
      poster: ALICE,
      reward: "1000000",
      token: TOKEN,
      outcome_kind: "picked",
      phase: "settled",
    }),
    summary({ id: "31", title: "Check rules", poster: ALICE, reward: "3000000", token: TOKEN }),
  ]);
  return state;
}

function open(state: World, connected = true) {
  serve(state);
  holder.store = createWalletStore(async () =>
    fakeProvider(accountWallet(state), { restored: connected }),
  );
  render(<EarningsView />);
  return userEvent.setup();
}

const stat = (id: string) => screen.getByTestId(id).textContent;

test("earnings_asks_to_connect_and_reads_nothing_until_then", async () => {
  const state = aliceEarned();
  open(state, false);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "Earnings. What your agents won, and where your rewards went.",
  );
  await screen.findByRole("heading", { name: "Connect your wallet" });
  expect(state.requests).toEqual([]);
});

test("the_summary_is_the_wins_before_the_fee_the_fee_and_the_net_with_what_waits", async () => {
  open(aliceEarned());

  await screen.findByTestId("stat-net");
  // Alice won all of a 2.00 task, the scout 60% of a 5.00 one; the fee was 5% of each.
  expect(stat("stat-gross")).toContain("5.00 tUSDC");
  expect(stat("stat-fees")).toContain("0.25 tUSDC");
  expect(stat("stat-net")).toContain("4.75 tUSDC");
  expect(stat("stat-pending")).toContain("2");
  // Every win was read: no note. No bond fields: no bond figure.
  expect(screen.queryByTestId("coverage")).toBeNull();
  expect(screen.queryByTestId("stat-bonds")).toBeNull();
});

test("the_tabs_show_the_agents_the_transactions_and_the_tasks_posted", async () => {
  const user = open(aliceEarned());

  // My agents, first: each agent's wins and what the contract counted as earned.
  const agents = await screen.findByTestId("earnings-agents");
  const rows = within(agents).getAllByTestId("earnings-agent");
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("Alice Extractor");
  expect(rows[0]?.textContent).toContain("1.90 tUSDC");
  expect(screen.getByRole("tab", { name: "My agents" }).getAttribute("aria-selected")).toBe("true");

  // Transactions: the wins, newest first, and the entries that wait.
  await user.click(screen.getByRole("tab", { name: "Transactions" }));
  expect(nav.replaced).toEqual(["/earnings?tab=transactions"]);
  const transactions = within(await screen.findByTestId("transactions")).getAllByTestId(
    "transaction",
  );
  expect(
    transactions.map((one) => within(one).getByTestId("transaction-status").textContent),
  ).toEqual(["Awaiting pick", "Awaiting pick", "Paid", "Paid"]);
  const scoutWin = transactions[2] as HTMLElement;
  expect(within(scoutWin).getByRole("link", { name: "Task 22" }).getAttribute("href")).toBe(
    "/tasks/22",
  );
  expect(within(scoutWin).getByTestId("gross").textContent).toBe("3.00 tUSDC");
  expect(within(scoutWin).getByTestId("net").textContent).toBe("2.85 tUSDC");
  expect(scoutWin.textContent).toContain("60% share");
  expect(scoutWin.textContent).toContain("less 5% fee");

  // The keyboard moves between the tabs with the arrows.
  screen.getByRole("tab", { name: "Transactions" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(nav.replaced.at(-1)).toBe("/earnings?tab=poster");
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "As a poster" }));

  // As a poster: where each reward is, and the totals.
  const posted = within(await screen.findByTestId("posted")).getAllByTestId("posted-task");
  expect(posted.map((one) => within(one).getByTestId("posted-state").textContent)).toEqual([
    "Due back to its funders in full",
    "Refunded to its funders in full",
    "Paid to the winners, less the platform fee",
    "Locked in escrow",
  ]);
  expect(stat("poster-locked")).toContain("3.75 tUSDC");
  expect(stat("poster-paid")).toContain("1.00 tUSDC");
  expect(stat("poster-refunded")).toContain("0.50 tUSDC");

  await user.keyboard("{Home}");
  expect(nav.replaced.at(-1)).toBe("/earnings");
});

test("a_win_whose_task_cannot_be_read_is_left_out_and_the_page_says_so", async () => {
  const state = aliceEarned(true);
  state.tasks.delete("22");
  open(state);
  expect((await screen.findByTestId("coverage")).textContent).toBe(
    "These sums are from the 1 of your agents' 2 wins that were read.",
  );
  expect(stat("stat-net")).toContain("1.90 tUSDC");
  // The bond fields are there: the bond locked shows.
  expect(stat("stat-bonds")).toContain("5.00 tUSDC");
});

test("an_account_with_no_agents_and_no_tasks_is_shown_where_to_start", async () => {
  const user = open(world());
  expect((await screen.findByText("No agents yet")).closest("div")?.textContent).toContain(
    "Add an agent",
  );
  expect(screen.getByRole("link", { name: "Add an agent" }).getAttribute("href")).toBe(
    "/my-agents/new",
  );
  await user.click(screen.getByRole("tab", { name: "Transactions" }));
  expect((await screen.findByTestId("no-transactions")).textContent).toMatch(
    /No wins or payouts yet/,
  );
  await user.click(screen.getByRole("tab", { name: "As a poster" }));
  const none = await screen.findByTestId("no-posted");
  expect(within(none).getByRole("link", { name: "Post a task" }).getAttribute("href")).toBe(
    "/post",
  );
});

test("a_read_that_fails_says_so_in_the_panel_and_retry_reads_again", async () => {
  const state = aliceEarned();
  state.failing.add("/v1/entries");
  const user = open(state);
  const alert = await screen.findByRole("alert");
  state.failing.clear();
  await user.click(within(alert).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByTestId("earnings-agents")).toBeTruthy());
});
