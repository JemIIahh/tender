import {
  canonicalJson,
  HIRER_ACCEPTS_CRITERIA_HASH,
  type RecentEvent,
  type Service,
  sha256Hex,
} from "@tender/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ActivityView } from "../components/ActivityView";
import {
  ago,
  FEED_MAX,
  type FeedEvent,
  fromBacklog,
  lineOf,
  mergeFeed,
  type Part,
} from "../lib/activity";
import { createWalletStore, type WalletStore } from "../lib/wallet";
import { ALICE, accountWallet, json, world } from "./accountFakes";
import { FakeEventSource } from "./fakeEventSource";
import { agent, CREATED, detail, summary } from "./tasks";
import { fakeProvider } from "./walletDoubles";

// The Activity feed (lib/activity.ts, components/ActivityView.tsx): one line an event, from the
// API's backlog once and then the stream, with amounts in each task's token. vitest.config.ts puts
// the API at http://api.test.

const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return { ...actual, useWallet: () => actual.useWalletStore(holder.store) };
});

const TOKEN = "tusdc.tender-team.testnet";
const OTHER = "5f3a9c0e".repeat(8);
const BOB = "bob.testnet";
const WRITER = "writer.acme.testnet";
const NOW_MS = Number(CREATED / 1_000_000n) + 600_000;

function taskCreated(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    poster: BOB,
    token: TOKEN,
    reward: "1500000",
    fee_bps: 500,
    brief_uri: "http://api.test/v1/blobs/x",
    brief_hash: "a".repeat(64),
    criteria_hash: "b".repeat(64),
    heldout_commitment: null,
    verifier: "judge.testnet",
    created_at: "1",
    commit_deadline: "2",
    reveal_deadline: "3",
    pick_deadline: "4",
    fallback_deadline: "5",
    max_entries: 0,
    max_winners: 1,
    invited: [],
    parent: null,
    ...over,
  };
}

const picked = (taskId: string, winners: Array<[string, string]>) => ({
  task_id: taskId,
  by: "judge.testnet",
  winners: winners.map(([account, amount]) => ({ account, bps: 10_000 / winners.length, amount })),
  fee: "1",
  scorecard_hash: "c".repeat(64),
  scorecard_uri: "x",
});

const committed = (taskId: string, account: string) => ({
  task_id: taskId,
  account,
  commitment: "d".repeat(64),
  replaced: false,
  block_height: "9",
});

/** An event as the backlog has it: `minutesAgo` before the tests' clock. */
function recent(
  id: string,
  event: string,
  data: Record<string, unknown>,
  o: { taskId?: string | null; token?: string | null; minutesAgo?: number } = {},
): RecentEvent {
  return {
    id,
    event,
    data,
    height: "100",
    task_id: o.taskId ?? null,
    block_ts: (BigInt(NOW_MS - (o.minutesAgo ?? 0) * 60_000) * 1_000_000n).toString(),
    token: o.token ?? null,
  };
}

/** A service of writer's, checked by the Judge against `criteria`. */
const CRITERIA = {
  version: 1 as const,
  kind: "regex_cases" as const,
  min_score: 100,
  split: "winner_take_all" as const,
  has_heldout: false,
  examples: { match: ["a"], no_match: ["b"] },
};
const JUDGED_HASH = sha256Hex(canonicalJson(CRITERIA));
const JUDGED = {
  agent: WRITER,
  verification: {
    kind: "judge" as const,
    criteria: CRITERIA,
    criteria_hash: JUDGED_HASH,
    judge: "judge.testnet",
  },
};

const textOf = (parts: Part[]) =>
  parts
    .map((part) =>
      part.kind === "text" ? part.text : part.kind === "task" ? `#${part.taskId}` : part.account,
    )
    .join(" ");

const ctx = (tokens: Record<string, string> = {}, services = [JUDGED]) => ({
  tokenOf: (taskId: string) => tokens[taskId],
  services,
});

const feedEvent = (event: string, data: Record<string, unknown>, over: Partial<FeedEvent> = {}) =>
  ({ id: "1", event, data, task_id: null, atMs: NOW_MS, token: null, ...over }) as FeedEvent;

// ---- The lines ----------------------------------------------------------------------------------

test("activity_lines_say_what_each_event_says_with_amounts_in_the_task_s_token", () => {
  const posted = lineOf(feedEvent("task_created", taskCreated("7")), ctx());
  expect(posted?.kind).toBe("posted");
  expect(textOf(posted?.parts ?? [])).toBe(`${BOB} posted #7`);
  expect(posted?.amounts).toEqual([[TOKEN, 1_500_000n]]);
  expect(posted?.accounts).toEqual([BOB, "judge.testnet"]);

  // A hire: one agent invited, once, with a hire's criteria, the hirer's or its service's.
  for (const criteria of [HIRER_ACCEPTS_CRITERIA_HASH, JUDGED_HASH]) {
    const hire = lineOf(
      feedEvent(
        "task_created",
        taskCreated("8", { invited: [WRITER], max_entries: 1, criteria_hash: criteria }),
      ),
      ctx(),
    );
    expect(hire?.kind).toBe("hired");
    expect(textOf(hire?.parts ?? [])).toBe(`${BOB} hired ${WRITER} with #8`);
    expect(hire?.amountLabel).toBe("price");
  }
  // Without the listing, a Judge-checked hire reads as what else it is: a task posted.
  const unknownHire = lineOf(
    feedEvent(
      "task_created",
      taskCreated("8", { invited: [WRITER], max_entries: 1, criteria_hash: JUDGED_HASH }),
    ),
    ctx({}, []),
  );
  expect(unknownHire?.kind).toBe("posted");

  const entered = lineOf(feedEvent("committed", committed("7", ALICE)), ctx());
  expect(textOf(entered?.parts ?? [])).toBe(`${ALICE} entered #7`);
  // An entrant is an agent, linked to its page; a poster need not be one, and is not linked.
  expect(entered?.parts[0]).toEqual({ kind: "account", account: ALICE, agent: true });
  expect(posted?.parts[0]).toEqual({ kind: "account", account: BOB, agent: false });

  // A pick: the payout is in the task's token, which the event does not carry.
  const pick = feedEvent("picked", picked("7", [[ALICE, "1425000"]]), { task_id: "7" });
  const pending = lineOf(pick, ctx());
  expect(textOf(pending?.parts ?? [])).toBe(`judge.testnet picked ${ALICE} in #7`);
  expect(pending?.amounts).toEqual([]);
  expect(pending?.amountPending).toBe(true);
  expect(lineOf(pick, ctx({ 7: TOKEN }))?.amounts).toEqual([[TOKEN, 1_425_000n]]);
  // A token that could not be read: the line goes without the amount, and waits for nothing.
  const unread = lineOf(pick, { ...ctx(), unread: (taskId) => taskId === "7" });
  expect(unread?.amounts).toEqual([]);
  expect(unread?.amountPending).toBe(false);
  // Two winners: their payouts together, in the one token of the task.
  const two = lineOf(
    feedEvent(
      "picked",
      picked("9", [
        [ALICE, "100"],
        [BOB, "50"],
      ]),
      { token: OTHER },
    ),
    ctx(),
  );
  expect(textOf(two?.parts ?? [])).toBe("judge.testnet picked 2 winners in #9");
  expect(two?.amounts).toEqual([[OTHER, 150n]]);

  const voided = lineOf(
    feedEvent(
      "voided",
      {
        task_id: "7",
        reason: "expired",
        by: null,
        refunds: [{ account: BOB, amount: "1500000" }],
        scorecard_hash: null,
        scorecard_uri: null,
      },
      { token: TOKEN },
    ),
    ctx(),
  );
  expect(textOf(voided?.parts ?? [])).toBe("#7 was voided");
  expect(voided?.note).toBe("no one picked in time");
  expect(voided?.amounts).toEqual([[TOKEN, 1_500_000n]]);
  expect(voided?.accounts).toEqual([BOB]);

  const registered = lineOf(
    feedEvent("agent_registered", {
      account: ALICE,
      asp: null,
      profile_uri: "x",
      profile_hash: "e".repeat(64),
      tags: [],
      updated: false,
    }),
    ctx(),
  );
  expect(textOf(registered?.parts ?? [])).toBe(`${ALICE} registered as an agent`);
  const bonded = lineOf(
    feedEvent("agent_bonded", { account: ALICE, token: TOKEN, amount: "5000000" }),
    ctx(),
  );
  expect(bonded?.amounts).toEqual([[TOKEN, 5_000_000n]]);

  // The feed shows only its events, and only data that fits the contract's.
  expect(lineOf(feedEvent("deposit", {}), ctx())).toBeNull();
  expect(lineOf(feedEvent("committed", { task_id: "7" }), ctx())).toBeNull();
});

test("activity_feed_keeps_each_event_once_newest_first_and_at_most_its_cap", () => {
  const event = (id: string) => feedEvent("committed", committed("7", ALICE), { id });
  const feed = mergeFeed([event("5"), event("3")], [event("4"), event("5"), event("10")]);
  expect(feed.map((one) => one.id)).toEqual(["10", "5", "4", "3"]);
  const many = Array.from({ length: FEED_MAX + 5 }, (_, i) => event(String(i + 1)));
  const capped = mergeFeed([], many);
  expect(capped).toHaveLength(FEED_MAX);
  expect(capped[0]?.id).toBe(String(FEED_MAX + 5));

  expect(ago(NOW_MS - 20_000, NOW_MS)).toBe("just now");
  expect(ago(NOW_MS - 4 * 60_000, NOW_MS)).toBe("4m ago");
  expect(ago(NOW_MS - 3 * 3_600_000, NOW_MS)).toBe("3h ago");
  expect(ago(NOW_MS - 50 * 3_600_000, NOW_MS)).toBe("2d ago");
  // A block time a little ahead of this clock is still now.
  expect(ago(NOW_MS + 5_000, NOW_MS)).toBe("just now");

  const backlog = fromBacklog(recent("3", "committed", committed("7", ALICE), { minutesAgo: 2 }));
  expect(backlog.atMs).toBe(NOW_MS - 120_000);
});

// ---- The page -----------------------------------------------------------------------------------

interface Api {
  backlog: RecentEvent[];
  newest: string;
  services: Array<Partial<Service>>;
  failing: boolean;
  requests: string[];
}

function serve(api: Api): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    api.requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/v1/events/recent") {
      if (api.failing) return json({ error: "internal", message: "internal error" }, 500);
      return json({ events: api.backlog, newest: api.newest });
    }
    if (url.pathname === "/v1/services") {
      return json({
        services: api.services.map((one) => ({ ...SERVICE, ...one })),
        next_cursor: null,
      });
    }
    if (url.pathname === "/v1/tasks/3") {
      return json(detail({ ...summary({ id: "3", token: OTHER }) }));
    }
    // The probe the stream makes when it is refused, which these tests never do.
    return json({ error: "not_found", message: "no" }, 404);
  });
}

const SERVICE: Service = {
  id: "1",
  provider: "acme.testnet",
  agent: WRITER,
  title: "Check dates",
  description: "d",
  tags: [],
  category: "coding",
  output_format: "regex_json",
  token: TOKEN,
  price: "1",
  commit_secs: 60,
  reveal_secs: 60,
  pick_secs: 60,
  verification: JUDGED.verification,
  status: "active",
  available: true,
  is_team: false,
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
  agent_record: agent({ account: WRITER }),
};

const BACKLOG: RecentEvent[] = [
  recent("9", "picked", picked("2", [[ALICE, "1425000"]]), { taskId: "2", token: TOKEN }),
  recent("8", "committed", committed("2", ALICE), { taskId: "2", token: TOKEN, minutesAgo: 5 }),
  recent(
    "7",
    "task_created",
    taskCreated("4", { invited: [WRITER], max_entries: 1, criteria_hash: JUDGED_HASH }),
    { taskId: "4", token: TOKEN, minutesAgo: 30 },
  ),
  recent("6", "task_created", taskCreated("2", { token: OTHER, reward: "42" }), {
    taskId: "2",
    token: OTHER,
    minutesAgo: 90,
  }),
];

function apiOf(over: Partial<Api> = {}): Api {
  return { backlog: BACKLOG, newest: "12", services: [{}], failing: false, requests: [], ...over };
}

function open(api: Api, connected = false) {
  serve(api);
  holder.store = createWalletStore(async () =>
    fakeProvider(accountWallet(world()), { restored: connected }),
  );
  render(<ActivityView />);
  return userEvent.setup();
}

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW_MS));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const lines = () => within(screen.getByTestId("activity")).getAllByTestId("activity-line");

test("activity_reads_the_backlog_once_then_follows_the_stream_from_its_newest", async () => {
  const api = apiOf();
  open(api);
  expect(screen.getByRole("status").textContent).toBe("Loading activity…");
  await screen.findByTestId("activity");

  // One backlog read, of the feed's events, and one read of the services, which tell a hire.
  expect(api.requests).toEqual([
    "/v1/events/recent?limit=50&event=task_created%2Ccommitted%2Crevealed%2Cpicked%2Cvoided%2Cagent_registered%2Cagent_bonded",
    "/v1/services?status=all&limit=50",
  ]);
  // The stream opens after the newest event the API had: nothing between the two is missed.
  expect(FakeEventSource.instances).toHaveLength(1);
  expect(FakeEventSource.latest.url).toBe("http://api.test/v1/events?since=12");

  const shown = lines();
  expect(shown.map((line) => line.getAttribute("data-kind"))).toEqual([
    "paid",
    "entered",
    "hired",
    "posted",
  ]);
  expect(shown[0]?.textContent).toContain(`judge.testnet picked ${ALICE} in task #2`);
  expect(shown[0]?.textContent).toContain("paid1.425 tUSDC");
  expect(shown[0]?.textContent).toContain("just now");
  expect(shown[1]?.textContent).toContain("5m ago");
  expect(shown[2]?.textContent).toContain(`${BOB} hired ${WRITER} with task #4`);
  // A token the app knows no decimals for: its smallest units, labelled, never added to another.
  expect(shown[3]?.textContent).toContain(`reward42smallest units of`);
  expect(shown[3]?.textContent).toContain("1h ago");
  // Links: the task, and the agent.
  expect(
    within(shown[0] as HTMLElement)
      .getByRole("link", { name: "task #2" })
      .getAttribute("href"),
  ).toBe("/tasks/2");
  expect(
    within(shown[0] as HTMLElement)
      .getByRole("link", { name: ALICE })
      .getAttribute("href"),
  ).toBe(`/agents/${ALICE}`);
});

test("activity_adds_what_the_stream_says_on_top_and_reads_a_task_s_token_once", async () => {
  const api = apiOf();
  open(api);
  await screen.findByTestId("activity");
  const source = FakeEventSource.latest;
  act(() => {
    source.open();
    source.send(
      "committed",
      { event: "committed", data: committed("2", BOB), height: "101", task_id: "2" },
      "13",
    );
  });
  expect(lines()[0]?.textContent).toContain(`${BOB} entered task #2`);
  expect(lines()[0]?.textContent).toContain("just now");
  // The stream sends it again (a reconnect): it is not shown twice.
  act(() => {
    source.send(
      "committed",
      { event: "committed", data: committed("2", BOB), height: "101", task_id: "2" },
      "13",
    );
  });
  expect(lines()).toHaveLength(5);

  // A pick of a task the page has not seen posted: its token is read once, then the amount shows.
  act(() => {
    source.send(
      "picked",
      { event: "picked", data: picked("3", [[ALICE, "77"]]), height: "102", task_id: "3" },
      "14",
    );
  });
  expect(lines()[0]?.textContent).toContain("reading the task's token");
  await waitFor(() => expect(lines()[0]?.textContent).toContain("paid77smallest units of"));
  expect(api.requests.filter((request) => request === "/v1/tasks/3")).toHaveLength(1);
  // Events the feed does not show (a deposit) are left out.
  act(() => {
    source.send(
      "deposit",
      {
        event: "deposit",
        data: { account: ALICE, token: TOKEN, amount: "1", sender: ALICE },
        height: "103",
        task_id: null,
      },
      "15",
    );
  });
  expect(lines()).toHaveLength(6);
});

test("activity_filters_by_kind_and_by_the_connected_account", async () => {
  const user = open(apiOf(), true);
  await screen.findByTestId("activity");
  await user.click(screen.getByRole("button", { name: "Paid" }));
  expect(screen.getByRole("button", { name: "Paid" }).getAttribute("aria-pressed")).toBe("true");
  expect(lines().map((line) => line.getAttribute("data-kind"))).toEqual(["paid"]);
  await user.click(screen.getByRole("button", { name: "Hires" }));
  expect(lines().map((line) => line.getAttribute("data-kind"))).toEqual(["hired"]);
  await user.click(screen.getByRole("button", { name: "Agents" }));
  expect(screen.getByTestId("activity-none-shown").textContent).toBe(
    "None of the latest activity is of this kind.",
  );

  // Mine: the lines that name alice, who entered task 2 and won it.
  await user.click(screen.getByRole("button", { name: "All" }));
  await user.click(await screen.findByRole("checkbox", { name: "Mine only" }));
  expect(lines().map((line) => line.getAttribute("data-kind"))).toEqual(["paid", "entered"]);
});

test("activity_offers_mine_only_to_a_connected_account", async () => {
  open(apiOf(), false);
  await screen.findByTestId("activity");
  expect(screen.queryByRole("checkbox", { name: "Mine only" })).toBeNull();
});

test("activity_says_when_nothing_has_happened_and_when_the_backlog_cannot_be_read", async () => {
  const api = apiOf({ backlog: [], newest: "0", failing: true });
  const user = open(api);
  const error = await screen.findByTestId("error-state");
  // No backlog, no stream: the page says so, and tries again when asked.
  expect(FakeEventSource.instances).toHaveLength(0);
  api.failing = false;
  await user.click(within(error).getByRole("button", { name: "Retry" }));
  const empty = await screen.findByTestId("activity-empty");
  expect(empty.textContent).toContain("Nothing has happened yet");
  expect(FakeEventSource.latest.url).toBe("http://api.test/v1/events?since=0");
});
