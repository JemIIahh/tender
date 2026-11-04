import type { TaskSummary } from "@tender/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MyTasksView } from "../components/account/MyTasksView";
import { nextStep } from "../lib/myTasks";
import { createWalletStore, type WalletStore } from "../lib/wallet";
import { ALICE, accountWallet, json, world } from "./accountFakes";
import { AT, SECOND, summary } from "./tasks";
import { fakeProvider } from "./walletDoubles";

// My tasks, over a fake API: the tasks the account has to pick, the tasks it posted with the next
// step on each, and its hires. The tab is in the address, which a tiny model of the router holds.

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
  usePathname: () => "/my-tasks",
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => useSyncExternalStore(nav.subscribe, nav.snapshot, nav.snapshot),
}));

const BOB = "bob.testnet";
/** The moment of the tests: in the judge window of a task with the default deadlines. */
const NOW = AT.reveal + 60n * SECOND;

/** A task with its deadlines moved `seconds` earlier: 700 s earlier puts it in its fallback. */
function earlier(seconds: bigint, over: Partial<TaskSummary>): TaskSummary {
  const base = summary(over);
  const back = (value: string) => (BigInt(value) - seconds * SECOND).toString();
  return {
    ...base,
    created_at: back(base.created_at),
    commit_deadline: back(base.commit_deadline),
    reveal_deadline: back(base.reveal_deadline),
    pick_deadline: back(base.pick_deadline),
    fallback_deadline: back(base.fallback_deadline),
  };
}

/** Alice verifies 40 (revealed entries) and 41 (none), and posted 42, now in its fallback. */
const VERIFIES = [
  summary({ id: "40", title: "Rank the leads", verifier: ALICE, poster: BOB, reveal_count: 2 }),
  summary({ id: "41", title: "Empty task", verifier: ALICE, poster: BOB, reveal_count: 0 }),
];
const FALLBACK = [
  earlier(700n, { id: "42", title: "Sort the inbox", poster: ALICE, reveal_count: 1 }),
];
/** What alice posted: open, judged by someone else, past every window, settled, and 42. */
const POSTED = [
  earlier(-1_200n, { id: "45", title: "Open task", poster: ALICE }),
  summary({ id: "44", title: "Judge's task", poster: ALICE, reveal_count: 3 }),
  earlier(3_000n, { id: "43", title: "Lapsed task", poster: ALICE, reveal_count: 1 }),
  ...FALLBACK,
  summary({ id: "39", title: "Done task", poster: ALICE, outcome_kind: "picked" }),
];
const HIRES = [earlier(-1_200n, { id: "46", title: "Hire: Summarise a filing", poster: ALICE })];

interface Api {
  verifies: TaskSummary[];
  fallback: TaskSummary[];
  posted: TaskSummary[];
  hires: TaskSummary[];
  failing: boolean;
  requests: string[];
}

function serve(api: Api): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    api.requests.push(`${url.pathname}${url.search}`);
    if (url.pathname !== "/v1/tasks") return json({ error: "not_found", message: "no" }, 404);
    if (api.failing) return json({ error: "internal", message: "internal error" }, 500);
    const q = url.searchParams;
    const tasks =
      q.get("verifier") === ALICE && q.get("phase") === "judging"
        ? api.verifies
        : q.get("poster") === ALICE && q.get("phase") === "fallback"
          ? api.fallback
          : q.get("poster") === ALICE && q.get("hire") === "true"
            ? api.hires
            : q.get("poster") === ALICE && !q.has("phase") && !q.has("hire")
              ? api.posted
              : [];
    return json({ tasks, next_cursor: null });
  });
}

function apiOf(over: Partial<Api> = {}): Api {
  return {
    verifies: VERIFIES,
    fallback: FALLBACK,
    posted: POSTED,
    hires: HIRES,
    failing: false,
    requests: [],
    ...over,
  };
}

function open(api: Api, connected = true) {
  serve(api);
  holder.store = createWalletStore(async () =>
    fakeProvider(accountWallet(world()), { restored: connected }),
  );
  render(<MyTasksView />);
  return userEvent.setup();
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  nav.query = new URLSearchParams();
  nav.replaced = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Number(NOW / 1_000_000n)));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rowsOf = (testId: string) => within(screen.getByTestId(testId)).getAllByTestId("my-task");
const stepOf = (row: HTMLElement) => within(row).queryByTestId("next-step");

test("next_step_follows_the_contract_s_rules_by_the_clock", () => {
  const judging = summary({ verifier: ALICE, poster: BOB, reveal_count: 1 });
  expect(nextStep(judging, ALICE, NOW)).toBe("pick");
  // The poster does not pick while the verifier's window is open.
  expect(nextStep(judging, BOB, NOW)).toBeNull();
  // Nothing revealed: there is nothing to pick, and anyone can refund once the reveals are over.
  expect(nextStep({ ...judging, reveal_count: 0 }, ALICE, NOW)).toBe("refund");
  // The fallback window: the poster picks, the verifier no longer does.
  const fallback = earlier(600n, { verifier: ALICE, poster: BOB, reveal_count: 1 });
  expect(nextStep(fallback, BOB, NOW)).toBe("pick");
  expect(nextStep(fallback, ALICE, NOW)).toBeNull();
  // Open: the reward can be topped up. Every window past: refund. Settled: nothing.
  expect(nextStep(earlier(-1_200n, {}), ALICE, NOW)).toBe("top-up");
  expect(nextStep(earlier(3_000n, {}), BOB, NOW)).toBe("refund");
  expect(nextStep(summary({ outcome_kind: "voided" }), ALICE, NOW)).toBeNull();
  // Revealing: nothing to do but wait.
  expect(nextStep(earlier(-200n, { poster: ALICE }), ALICE, NOW)).toBeNull();
});

test("my_tasks_asks_to_connect_and_reads_nothing_until_then", async () => {
  const api = apiOf();
  open(api, false);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "My tasks. What you posted, and what is yours to do next.",
  );
  await screen.findByRole("heading", { name: "Connect your wallet" });
  expect(api.requests).toEqual([]);
});

test("my_tasks_opens_on_what_is_to_pick_with_a_count_soonest_first", async () => {
  const api = apiOf();
  open(api);
  const picks = await screen.findByTestId("to-pick");
  const tab = screen.getByRole("tab", { name: /To pick/ });
  expect(tab.getAttribute("aria-selected")).toBe("true");
  // 40 as its verifier and 42 as its poster in the fallback; 41 has nothing revealed to pick.
  expect(within(tab).getByTestId("pick-count").textContent).toBe("2 to pick");
  const rows = within(picks).getAllByTestId("my-task");
  // 42's fallback window closes 100 s before 40's pick window: the soonest first.
  expect(
    rows.map((row) => within(row).getByRole("link", { name: /Rank|Sort/ }).textContent),
  ).toEqual(["Sort the inbox", "Rank the leads"]);
  for (const row of rows) {
    const step = stepOf(row);
    expect(step?.getAttribute("data-step")).toBe("pick");
    expect(step?.getAttribute("href")).toMatch(/^\/tasks\/4[02]$/);
  }
  expect(stepOf(rows[1] as HTMLElement)?.getAttribute("aria-label")).toBe(
    "Pick the winners of task #40",
  );
  // Each row says when its window closes, as the board's cards do, and its entries.
  expect(within(rows[1] as HTMLElement).getByTestId("closes").textContent).toBe("Pick due in 9m");
  expect(rows[1]?.textContent).toContain("2 · 2 revealed");
  // The reads: what alice verifies in the judge window, and what she posted in the fallback.
  expect(api.requests).toContain(`/v1/tasks?phase=judging&verifier=${ALICE}&limit=50`);
  expect(api.requests).toContain(`/v1/tasks?phase=fallback&poster=${ALICE}&limit=50`);
});

test("my_tasks_posted_shows_the_next_step_of_each_task", async () => {
  const user = open(apiOf());
  await screen.findByTestId("to-pick");
  await user.click(screen.getByRole("tab", { name: "Posted" }));
  expect(nav.replaced).toEqual(["/my-tasks?tab=posted"]);
  await screen.findByTestId("posted");
  const steps = Object.fromEntries(
    rowsOf("posted").map((row) => [
      within(row).getAllByRole("link")[0]?.textContent,
      stepOf(row)?.getAttribute("data-step") ?? null,
    ]),
  );
  expect(steps).toEqual({
    "Open task": "top-up",
    // Judged by the Judge, whose window it is: nothing for the poster to do.
    "Judge's task": null,
    "Lapsed task": "refund",
    "Sort the inbox": "pick",
    "Done task": null,
  });
  // Each step is a link to the task's page, which holds the action; the page signs nothing.
  const lapsed = rowsOf("posted").find((row) => row.textContent?.includes("Lapsed task"));
  expect(stepOf(lapsed as HTMLElement)?.getAttribute("href")).toBe("/tasks/43");
  expect(screen.queryByRole("button", { name: /pick|refund|top up/i })).toBeNull();
});

test("my_tasks_hires_are_read_with_the_hire_filter", async () => {
  const api = apiOf();
  nav.query = new URLSearchParams("tab=hires");
  open(api);
  const hires = await screen.findByTestId("hires");
  expect(within(hires).getAllByTestId("my-task")).toHaveLength(1);
  expect(hires.textContent).toContain("Hire: Summarise a filing");
  expect(api.requests).toContain(`/v1/tasks?poster=${ALICE}&hire=true&limit=50`);
});

test("my_tasks_with_nothing_to_pick_opens_on_posted_and_each_tab_says_when_it_is_empty", async () => {
  const user = open(apiOf({ verifies: [], fallback: [], posted: [], hires: [] }));
  // Nothing to pick: the page opens on what was posted, and the tab carries no count.
  await screen.findByTestId("no-posted");
  expect(screen.getByRole("tab", { name: "Posted" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByTestId("pick-count")).toBeNull();
  expect(screen.getByRole("link", { name: "Post a task" }).getAttribute("href")).toBe("/post");

  await user.click(screen.getByRole("tab", { name: "To pick" }));
  await screen.findByTestId("no-picks");
  await user.click(screen.getByRole("tab", { name: "Hires" }));
  await screen.findByTestId("no-hires");
  expect(screen.getByRole("link", { name: "Browse services" }).getAttribute("href")).toBe(
    "/services",
  );
});

test("my_tasks_says_when_the_tasks_cannot_be_read_and_tries_again", async () => {
  const api = apiOf({ failing: true });
  const user = open(api);
  const error = await screen.findByTestId("error-state");
  expect(error.textContent).toContain("The Tender API had a problem (status 500)");
  api.failing = false;
  await user.click(within(error).getByRole("button", { name: "Retry" }));
  await screen.findByTestId("to-pick");
});

test("my_tasks_tabs_move_with_the_arrow_keys", async () => {
  const user = open(apiOf());
  await screen.findByTestId("to-pick");
  screen.getByRole("tab", { name: /To pick/ }).focus();
  await user.keyboard("{ArrowRight}");
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "Posted" }).getAttribute("aria-selected")).toBe("true"),
  );
  expect(document.activeElement?.textContent).toBe("Posted");
  await user.keyboard("{End}");
  await waitFor(() => expect(document.activeElement?.textContent).toBe("Hires"));
});
