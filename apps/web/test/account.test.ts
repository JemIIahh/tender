import type { TaskDetailResponse } from "@tender/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  bondOf,
  bondTermsOf,
  combinedRecord,
  MAX_WIN_TASKS,
  postedStateOf,
  postedTotals,
  readEarnings,
  readMyAgents,
  readPosted,
  sumByToken,
  winOf,
  winTotals,
} from "../lib/account";
import type { AgentRecord } from "../lib/api";
import { AT, agent, CREATED, detail, SECOND, summary, TOKEN } from "./tasks";

// What the account pages read and add up (lib/account.ts), over a fake API.

const ALICE = "alice.testnet";
const SCOUT = `scout.${ALICE}`;
const OTHER = "5f3a9c0e".repeat(8);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const notFound = () => json({ error: "not_found", message: "no such thing" }, 404);

/** An API that answers by path and query; `requests` holds each, as `/v1/path?query`. */
function fakeApi(answer: (url: URL) => Response | undefined) {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    return answer(url) ?? notFound();
  });
  return requests;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The overrides are loose on purpose: some tests give a field a value the API would never send
// (a status the page does not know, a number for an amount), to see that the page leaves it out.
const record = (overrides: Record<string, unknown> = {}): AgentRecord =>
  ({
    ...agent({ is_team: false, picks_made: 0, voids_after_reveals: 0 }),
    ...overrides,
  }) as AgentRecord;

// ---- Bonds ------------------------------------------------------------------------------------

test("an_agent_without_bond_fields_has_no_bond_and_one_with_them_has_its_own", () => {
  expect(bondOf(record())).toBeNull();
  // A status the page does not know is not one it shows.
  expect(bondOf(record({ status: "paused" }))).toBeNull();
  expect(
    bondOf(
      record({
        status: "unregistering",
        bond_token: TOKEN,
        bond_amount: "5000000",
        claimable_at: "1793307169820229000",
      }),
    ),
  ).toEqual({
    status: "unregistering",
    token: TOKEN,
    amount: "5000000",
    claimableAt: 1_793_307_169_820_229_000n,
  });
  // A field that is there but is not what it should be is left out, not guessed.
  expect(
    bondOf(
      record({
        status: "active",
        bond_token: "NOT AN ACCOUNT",
        bond_amount: -1,
        claimable_at: "soon",
      }),
    ),
  ).toEqual({ status: "active", token: null, amount: null, claimableAt: null });
});

test("the_bond_terms_are_read_from_either_spelling_of_the_config_and_unknown_without_them", () => {
  const config = { owner: "tender.testnet", fee_bps: 500 };
  expect(bondTermsOf(config)).toEqual({ state: "unknown" });
  expect(bondTermsOf(null)).toEqual({ state: "unknown" });
  expect(bondTermsOf({ ...config, agent_bond: null })).toEqual({ state: "none" });
  expect(bondTermsOf({ ...config, agent_bond: { token: TOKEN, amount: "0" } })).toEqual({
    state: "none",
  });
  expect(
    bondTermsOf({
      ...config,
      agent_bond: { token: TOKEN, amount: "5000000" },
      agent_bond_cooldown_secs: "604800",
    }),
  ).toEqual({ state: "set", token: TOKEN, amount: "5000000", cooldownSecs: 604_800 });
  expect(bondTermsOf({ ...config, agent_bond_token: TOKEN, agent_bond_amount: "7" })).toEqual({
    state: "set",
    token: TOKEN,
    amount: "7",
    cooldownSecs: null,
  });
});

// ---- Adding up ----------------------------------------------------------------------------------

test("amounts_add_up_token_by_token_and_never_across_tokens", () => {
  expect(
    sumByToken([
      [TOKEN, "1"],
      [OTHER, 2n],
      [TOKEN, "340282366920938463463374607431768211455"],
      [OTHER, "not a number"],
    ]),
  ).toEqual([
    [TOKEN, 340282366920938463463374607431768211456n],
    [OTHER, 2n],
  ]);
  expect(sumByToken([])).toEqual([]);
});

test("the_combined_record_adds_up_what_the_api_counted_and_bonds_only_when_there_are_any", () => {
  const agents = [
    record({ account: ALICE, entries: 5, reveals: 4, wins: 1, earned: { [TOKEN]: "1900000" } }),
    record({
      account: SCOUT,
      entries: 4_294_967_295,
      reveals: 1,
      wins: 2,
      earned: { [TOKEN]: "100", [OTHER]: "7" },
    }),
  ];
  expect(combinedRecord(agents)).toEqual({
    count: 2,
    entries: 4_294_967_300,
    reveals: 5,
    wins: 3,
    earned: [
      [TOKEN, 1_900_100n],
      [OTHER, 7n],
    ],
    bonds: null,
  });
  const bonded = [
    record({ account: ALICE, status: "active", bond_token: TOKEN, bond_amount: "5" }),
    record({ account: SCOUT, status: "unregistering", bond_token: TOKEN, bond_amount: "6" }),
    // A retired agent took its bond back: it is not locked.
    record({ account: `old.${ALICE}`, status: "retired", bond_token: TOKEN, bond_amount: "100" }),
  ];
  expect(combinedRecord(bonded).bonds).toEqual([[TOKEN, 11n]]);
  expect(combinedRecord([]).count).toBe(0);
});

// ---- My agents ------------------------------------------------------------------------------------

test("my_agents_are_the_account_itself_if_registered_then_every_agent_under_it_page_by_page", async () => {
  const requests = fakeApi((url) => {
    if (url.pathname === `/v1/agents/${ALICE}`)
      return json({ agent: record({ account: ALICE }), recent_entries: [] });
    if (url.pathname === "/v1/agents") {
      // The provider's own account is never listed twice.
      return url.searchParams.get("cursor") === null
        ? json({
            agents: [record({ account: SCOUT, asp: ALICE }), record({ account: ALICE })],
            next_cursor: SCOUT,
          })
        : json({
            agents: [record({ account: `z.${ALICE}`, asp: ALICE, status: "active" })],
            next_cursor: null,
          });
    }
  });
  const mine = await readMyAgents(ALICE);
  expect(mine?.agents.map((row) => row.account)).toEqual([ALICE, SCOUT, `z.${ALICE}`]);
  expect(mine?.selfRegistered).toBe(true);
  expect(mine?.truncated).toBe(false);
  // The fields the schema does not name are kept, for the bond.
  expect(mine?.agents[2]?.status).toBe("active");
  expect(requests).toEqual([
    `/v1/agents/${ALICE}`,
    `/v1/agents?asp=${ALICE}&limit=50`,
    `/v1/agents?asp=${ALICE}&limit=50&cursor=${SCOUT}`,
  ]);
});

test("an_account_that_is_no_agent_has_only_the_agents_under_it_and_a_read_no_one_wants_stops", async () => {
  fakeApi((url) =>
    url.pathname === "/v1/agents"
      ? json({ agents: [record({ account: SCOUT })], next_cursor: null })
      : undefined,
  );
  const mine = await readMyAgents(ALICE);
  expect(mine).toEqual({
    agents: [expect.objectContaining({ account: SCOUT })],
    selfRegistered: false,
    truncated: false,
  });
  expect(await readMyAgents(ALICE, () => false)).toBeNull();
});

test("my_agents_stop_after_ten_pages_and_say_so", async () => {
  let page = 0;
  const requests = fakeApi((url) =>
    url.pathname === "/v1/agents"
      ? json({
          agents: [record({ account: `a${page}.${ALICE}` })],
          next_cursor: `a${page++}.${ALICE}`,
        })
      : undefined,
  );
  const mine = await readMyAgents(ALICE);
  expect(mine?.truncated).toBe(true);
  expect(mine?.agents).toHaveLength(10);
  expect(requests.filter((path) => path.startsWith("/v1/agents?"))).toHaveLength(10);
});

// ---- Earnings ---------------------------------------------------------------------------------

/** A task alice and scout entered, picked with `winners`, reward `reward`, fee 5%. */
function picked(
  id: string,
  reward: bigint,
  winners: Array<[string, number]>,
  token = TOKEN,
): TaskDetailResponse {
  const fee = (reward * 500n) / 10_000n;
  return detail({
    id,
    token,
    reward: reward.toString(),
    phase: "settled",
    outcome_kind: "picked",
    fee_bps: 500,
    outcome: {
      kind: "picked",
      task_id: id,
      by: "judge.tender-team.testnet",
      winners: winners.map(([account, bps]) => ({
        account,
        bps,
        amount: (((reward - fee) * BigInt(bps)) / 10_000n).toString(),
      })),
      fee: fee.toString(),
      scorecard_hash: "c".repeat(64),
      scorecard_uri: "http://api.test/v1/blobs/c",
    },
  });
}

test("a_win_is_the_payout_its_task_records_with_its_part_of_the_fee", () => {
  const alice = record({ account: ALICE });
  const task = picked("21", 2_000_000n, [
    [ALICE, 6_000],
    ["carol.testnet", 4_000],
  ]);
  expect(winOf(alice, task)).toEqual({
    agent: alice,
    taskId: "21",
    title: "Extract invoice totals",
    token: TOKEN,
    bps: 6_000,
    feeBps: 500,
    net: 1_140_000n,
    fee: 60_000n,
    gross: 1_200_000n,
  });
  // Three winners of a fee of 100 units: 33 each by share, and the unit left over is the first's,
  // so that the parts add up to the task's fee.
  const three = picked("22", 2_000n, [
    [ALICE, 3_334],
    ["carol.testnet", 3_333],
    ["dave.testnet", 3_333],
  ]);
  const fees = [ALICE, "carol.testnet", "dave.testnet"].map(
    (account) => winOf(record({ account }), three)?.fee,
  );
  expect(fees).toEqual([34n, 33n, 33n]);
  expect(fees.reduce((sum, fee) => (sum ?? 0n) + (fee ?? 0n), 0n)).toBe(100n);
  // Not among the winners, voided, or not decided: no win.
  expect(winOf(record({ account: "bob.testnet" }), task)).toBeNull();
  expect(winOf(alice, detail({ outcome: null }))).toBeNull();
  expect(
    winOf(
      alice,
      detail({
        outcome: {
          kind: "voided",
          task_id: "7",
          reason: "no_reveals",
          by: null,
          refunds: [],
          scorecard_hash: null,
          scorecard_uri: null,
        },
      }),
    ),
  ).toBeNull();
});

test("earnings_read_each_agents_entries_and_the_outcome_of_each_task_it_won", async () => {
  const alice = record({ account: ALICE });
  const scout = record({ account: SCOUT });
  const entry = (task_id: string, extra: object) => ({
    task_id,
    title: `Task ${task_id}`,
    phase: "settled",
    revealed: true,
    won: false,
    entry_index: 0,
    committed_height: "1",
    content_hash: null,
    uri: null,
    ...extra,
  });
  const requests = fakeApi((url) => {
    if (url.pathname === "/v1/entries") {
      return url.searchParams.get("account") === ALICE
        ? json({
            entries: [
              entry("24", { phase: "judging" }),
              entry("21", { won: true }),
              entry("2", { phase: "open", revealed: false }),
            ],
          })
        : json({
            entries: [
              entry("25", { phase: "revealing" }),
              entry("22", { won: true }),
              entry("23", { won: true }),
              entry("20", { phase: "expired" }),
            ],
          });
    }
    if (url.pathname === "/v1/tasks/21") return json(picked("21", 2_000_000n, [[ALICE, 10_000]]));
    if (url.pathname === "/v1/tasks/22")
      return json(
        picked("22", 5_000_000n, [
          [SCOUT, 6_000],
          ["carol.testnet", 4_000],
        ]),
      );
    // Task 23 can't be read: its win is listed and not read.
    if (url.pathname === "/v1/tasks/23") return json({ error: "boom", message: "down" }, 500);
  });

  const earnings = await readEarnings([alice, scout]);
  expect(earnings?.winsListed).toBe(3);
  expect(earnings?.winsRead).toBe(2);
  expect(earnings?.wins.map((win) => [win.agent.account, win.taskId, win.net])).toEqual([
    [SCOUT, "22", 2_850_000n],
    [ALICE, "21", 1_900_000n],
  ]);
  // Revealed, on a task that is not decided: pending. Not revealed, or expired: not.
  expect(earnings?.pending.map((row) => [row.agent.account, row.taskId])).toEqual([
    [SCOUT, "25"],
    [ALICE, "24"],
  ]);
  expect(requests.filter((path) => path.startsWith("/v1/tasks/")).sort()).toEqual([
    "/v1/tasks/21",
    "/v1/tasks/22",
    "/v1/tasks/23",
  ]);
  expect(winTotals(earnings?.wins ?? [])).toEqual({
    gross: [[TOKEN, 5_000_000n]],
    fee: [[TOKEN, 250_000n]],
    net: [[TOKEN, 4_750_000n]],
  });
});

test("earnings_read_the_outcomes_of_the_newest_hundred_won_tasks_only", async () => {
  const many = Array.from({ length: MAX_WIN_TASKS + 5 }, (_, i) => ({
    task_id: String(i + 1),
    title: null,
    phase: "settled",
    revealed: true,
    won: true,
    entry_index: 0,
    committed_height: "1",
    content_hash: null,
    uri: null,
  }));
  const requests = fakeApi((url) => {
    if (url.pathname === "/v1/entries") return json({ entries: many });
    const id = /^\/v1\/tasks\/(\d+)$/.exec(url.pathname)?.[1];
    if (id !== undefined) return json(picked(id, 100n, [[ALICE, 10_000]]));
  });
  const earnings = await readEarnings([record({ account: ALICE })]);
  const read = requests.filter((path) => path.startsWith("/v1/tasks/"));
  expect(read).toHaveLength(MAX_WIN_TASKS);
  expect(read).not.toContain("/v1/tasks/1");
  expect(earnings?.winsListed).toBe(MAX_WIN_TASKS + 5);
  expect(earnings?.winsRead).toBe(MAX_WIN_TASKS);
});

// ---- As a poster --------------------------------------------------------------------------------

const before = (task: object) => ({
  ...task,
  created_at: (CREATED - 3_000n * SECOND).toString(),
  commit_deadline: (CREATED - 2_500n * SECOND).toString(),
  reveal_deadline: (CREATED - 2_000n * SECOND).toString(),
  pick_deadline: (CREATED - 1_500n * SECOND).toString(),
  fallback_deadline: (CREATED - 1_000n * SECOND).toString(),
});

test("a_posted_tasks_reward_is_locked_paid_refunded_or_due_back", () => {
  // Inside the commit window of the default deadlines.
  const now = AT.created + 1n;
  expect(postedStateOf(summary(), now)).toBe("locked");
  expect(postedStateOf(summary({ outcome_kind: "picked" }), now)).toBe("paid");
  expect(postedStateOf(summary({ outcome_kind: "voided" }), now)).toBe("refunded");
  // Past its last window with no outcome: the reward is still in escrow, due back to its funders.
  expect(postedStateOf(summary(before({})), now)).toBe("due-back");

  const tasks = [
    summary({ id: "1", reward: "100" }),
    summary({ id: "2", reward: "5", ...before({}) }),
    summary({ id: "3", reward: "10", outcome_kind: "picked" }),
    summary({ id: "4", reward: "20", outcome_kind: "voided" }),
    summary({ id: "5", reward: "7", token: OTHER, outcome_kind: "picked" }),
  ];
  expect(postedTotals(tasks, now)).toEqual({
    locked: [[TOKEN, 105n]],
    paid: [
      [TOKEN, 10n],
      [OTHER, 7n],
    ],
    refunded: [[TOKEN, 20n]],
  });
});

test("the_posted_tasks_are_read_page_by_page_for_the_poster", async () => {
  const requests = fakeApi((url) => {
    if (url.pathname !== "/v1/tasks") return undefined;
    return url.searchParams.get("cursor") === null
      ? json({ tasks: [summary({ id: "9", poster: ALICE })], next_cursor: "9" })
      : json({ tasks: [summary({ id: "8", poster: ALICE })], next_cursor: null });
  });
  const posted = await readPosted(ALICE);
  expect(posted?.tasks.map((task) => task.id)).toEqual(["9", "8"]);
  expect(posted?.truncated).toBe(false);
  expect(requests).toEqual([
    `/v1/tasks?poster=${ALICE}&limit=50`,
    `/v1/tasks?poster=${ALICE}&limit=50&cursor=9`,
  ]);
  expect(await readPosted(ALICE, () => false)).toBeNull();
});
