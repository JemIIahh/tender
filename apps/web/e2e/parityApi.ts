import type { Page } from "@playwright/test";
import {
  HIRER_ACCEPTS_CRITERIA_HASH,
  type ListTasksResponse,
  type MetricsResponse,
  type RecentEvent,
  type RecentEventsResponse,
  type TaskSummary,
} from "@tender/shared";
import { agent, CREATED, SECOND, summary } from "../test/tasks";
import {
  type AccountChain,
  installAccountWallet,
  OWNER,
  routeAccount,
  routeAccountNode,
} from "./accountApi";
import { API_URL, type FixtureApi, routeApi } from "./fixtures";
import { STUB_WALLET_NAME } from "./walletStub";

// The fixture API of the pages the parity brief adds: My tasks (what alice picks and what she hired,
// beside what she posted, which `routeAccount` answers), Activity's backlog, and Metrics. Register
// it after `routeApi` (and `routeAccount`): the route registered last is asked first, and this one
// hands on what it does not answer.

const CORS = { "access-control-allow-origin": "*" };
const TOKEN = "tusdc.tender-team.testnet";
/** A token the app knows no decimals for: an implicit account of 64 characters. */
const OTHER_TOKEN = "5f3a9c0e".repeat(8);
const JUDGE = "judge.tender-team.testnet";
const WRITER = "writer.acme.testnet";
/** The largest u128. */
const MAX = "340282366920938463463374607431768211455";

/** The fixtures' clock: two minutes after the fixture tasks were posted. */
export const OPEN_AT = new Date(Number(CREATED / 1_000_000n) + 120_000);

/** A task with its deadlines `seconds` earlier than the fixtures': 1,000 s is its judge window. */
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

/** Alice verifies task 2 (the board's regex task), in its judge window with two reveals. */
export const TO_PICK: TaskSummary[] = [
  earlier(1_000n, {
    id: "2",
    title: "Regex for valid NEAR account IDs",
    verifier: OWNER,
    poster: "bob.testnet",
    commit_count: 2,
    reveal_count: 2,
    is_team_poster: false,
  }),
];

/** A hire alice made of writer's service, open for its one entry. */
export const HIRES: TaskSummary[] = [
  summary({
    id: "46",
    title: "Hire: Summarise a filing",
    poster: OWNER,
    reward: "2500000",
    commit_count: 0,
    is_team_poster: false,
  }),
];

/** The 14 days that end on the fixtures' day, oldest first. */
function lastDays(counts: number[]): MetricsResponse["posted_by_day"] {
  const today = Math.floor(OPEN_AT.getTime() / 86_400_000);
  return counts.map((tasks, i) => ({
    day: new Date((today - counts.length + 1 + i) * 86_400_000).toISOString().slice(0, 10),
    tasks,
  }));
}

export const METRICS: MetricsResponse = {
  tasks: { posted: 34, open: 3, settled: 22, picked: 17, voided: 5 },
  paid: [
    { token: OTHER_TOKEN, amount: MAX },
    { token: TOKEN, amount: "48250000" },
  ],
  fees: [{ token: TOKEN, amount: "2540000" }],
  agents: { registered: 11, active: 9 },
  providers: 3,
  services: { listed: 6, available: 5 },
  top_agents: [
    agent({
      account: OWNER,
      name: "Alice Extractor",
      wins: 7,
      entries: 12,
      earned: { [TOKEN]: "19000000" },
      is_team: false,
    }),
    agent({
      account: "scout.tender-team.testnet",
      name: "Tender Scout",
      wins: 5,
      entries: 20,
      earned: { [TOKEN]: "11400000" },
      is_team: true,
    }),
    agent({
      account: "c0ffee13".repeat(8),
      name: null,
      wins: 2,
      entries: 3,
      earned: { [OTHER_TOKEN]: MAX, [TOKEN]: "950000" },
      is_team: false,
    }),
  ],
  posted_by_day: lastDays([0, 1, 0, 3, 2, 0, 4, 1, 0, 5, 2, 6, 3, 7]),
};

/** An event of the backlog, `minutesAgo` before the fixtures' clock. */
function recent(
  id: string,
  event: string,
  data: Record<string, unknown>,
  o: { taskId?: string; token?: string; minutesAgo: number },
): RecentEvent {
  const at = BigInt(OPEN_AT.getTime() - o.minutesAgo * 60_000) * 1_000_000n;
  return {
    id,
    event,
    data,
    height: String(900 + Number(id)),
    task_id: o.taskId ?? null,
    block_ts: at.toString(),
    token: o.token ?? null,
  };
}

function taskCreated(id: string, over: Record<string, unknown>) {
  return {
    id,
    poster: "poster.tender-team.testnet",
    token: TOKEN,
    reward: "1000000",
    fee_bps: 500,
    brief_uri: `${API_URL}/v1/blobs/${"a".repeat(64)}`,
    brief_hash: "a".repeat(64),
    criteria_hash: "b".repeat(64),
    heldout_commitment: null,
    verifier: JUDGE,
    created_at: CREATED.toString(),
    commit_deadline: (CREATED + 600n * SECOND).toString(),
    reveal_deadline: (CREATED + 900n * SECOND).toString(),
    pick_deadline: (CREATED + 1_500n * SECOND).toString(),
    fallback_deadline: (CREATED + 2_100n * SECOND).toString(),
    max_entries: 0,
    max_winners: 1,
    invited: [],
    parent: null,
    ...over,
  };
}

/**
 * The backlog: a pick that paid in a token the app knows no decimals for, a hire of writer's
 * service, the regex task posted, and an agent that registered, newest first, the newest with id 4.
 * A spec moves the fixture's stream to that id before the page opens (four events of its own), so
 * that the stream resumes after it, as the API's would.
 */
export function backlog(): RecentEventsResponse {
  return {
    events: [
      recent(
        "4",
        "picked",
        {
          task_id: "3",
          by: JUDGE,
          winners: [{ account: "c0ffee13".repeat(8), bps: 10_000, amount: MAX }],
          fee: "1",
          scorecard_hash: "9f".repeat(32),
          scorecard_uri: "ipfs://scorecard",
        },
        { taskId: "3", token: OTHER_TOKEN, minutesAgo: 1 },
      ),
      recent(
        "3",
        "task_created",
        taskCreated("46", {
          poster: OWNER,
          reward: "2500000",
          invited: [WRITER],
          max_entries: 1,
          criteria_hash: HIRER_ACCEPTS_CRITERIA_HASH,
        }),
        { taskId: "46", token: TOKEN, minutesAgo: 12 },
      ),
      recent("2", "task_created", taskCreated("2", {}), {
        taskId: "2",
        token: TOKEN,
        minutesAgo: 95,
      }),
      recent(
        "1",
        "agent_registered",
        {
          account: "scout.tender-team.testnet",
          asp: "tender-team.testnet",
          profile_uri: "ipfs://profile",
          profile_hash: "e".repeat(64),
          tags: ["research"],
          updated: false,
        },
        { minutesAgo: 60 * 26 },
      ),
    ],
    newest: "4",
  };
}

export interface ParityApi {
  /** Every request this route answered, as `GET /v1/path?query`. */
  requests: string[];
}

/**
 * Answers `GET /v1/metrics`, `GET /v1/events/recent`, `GET /v1/services` (none listed: only
 * Activity reads it here), and alice's to-pick and hire lists of `GET /v1/tasks`. Anything else
 * falls back to the routes registered before it.
 */
export async function routeParity(
  page: Page,
  options: { backlog?: RecentEventsResponse; metrics?: MetricsResponse } = {},
): Promise<ParityApi> {
  const api: ParityApi = { requests: [] };
  await page.route(`${API_URL}/**`, async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fallback();
    const url = new URL(request.url());
    const answer = (body: unknown) => {
      api.requests.push(`GET ${url.pathname}${url.search}`);
      return route.fulfill({ status: 200, json: body, headers: CORS });
    };
    const q = url.searchParams;
    if (url.pathname === "/v1/metrics") return answer(options.metrics ?? METRICS);
    if (url.pathname === "/v1/events/recent") return answer(options.backlog ?? backlog());
    if (url.pathname === "/v1/services") return answer({ services: [], next_cursor: null });
    if (url.pathname === "/v1/tasks") {
      const list = (tasks: TaskSummary[]) => {
        const body: ListTasksResponse = { tasks, next_cursor: null };
        return answer(body);
      };
      if (q.get("verifier") === OWNER && q.get("phase") === "judging") return list(TO_PICK);
      if (q.get("poster") === OWNER && q.get("phase") === "fallback") return list([]);
      if (q.get("poster") === OWNER && q.get("hire") === "true") return list(HIRES);
    }
    return route.fallback();
  });
  return api;
}

/** The contract's config view: a 5% fee, and a bond of 5.00 tUSDC with a week's cooldown. */
export const CONFIG = {
  owner: "tender-team.testnet",
  pending_owner: null,
  treasury: "treasury.tender-team.testnet",
  fee_bps: 500,
  min_window_secs: 60,
  max_window_secs: 1_209_600,
  paused: false,
  version: 1,
  tokens: [{ token: TOKEN, min_reward: "100000", max_reward: "1000000000000", enabled: true }],
  agent_bond_token: TOKEN,
  agent_bond_amount: "5000000",
  agent_bond_cooldown_secs: "604800",
};

/**
 * Opens `path` at the fixtures' clock with every fixture route (the board's, alice's account,
 * this file's, and a node that answers the config view) and, when `connect`, connects alice's
 * wallet from the page's own button.
 */
export async function openParity(
  page: Page,
  path: string,
  options: { connect?: boolean; beforeOpen?: (fixture: FixtureApi) => void | Promise<void> } = {},
): Promise<{ fixture: FixtureApi; parity: ParityApi }> {
  await page.clock.install({ time: OPEN_AT });
  const fixture = await routeApi(page);
  await routeAccount(page);
  const parity = await routeParity(page);
  const chain: AccountChain = { accounts: new Map([[OWNER, []]]), config: CONFIG };
  await routeAccountNode(page, chain);
  await installAccountWallet(page, { account: OWNER, chain });
  await options.beforeOpen?.(fixture);
  await page.goto(path);
  if (options.connect) {
    await page.locator("main").getByRole("button", { name: "Connect wallet" }).click();
    await page.locator(".hot-connector-popup .connect-item", { hasText: STUB_WALLET_NAME }).click();
  }
  return { fixture, parity };
}

/** Fails if the page is wider than the window: nothing may scroll sideways. */
export async function pageFits(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}
