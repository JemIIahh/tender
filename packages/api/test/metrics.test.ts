import { insertService } from "@tender/db";
import { applyBlock } from "@tender/indexer";
import {
  blockOf,
  eventLine,
  FIXTURE_ACCOUNTS,
  FIXTURE_OPTIONS,
  FIXTURE_TOKEN,
} from "@tender/indexer/testing";
import { type MetricsResponse, MetricsResponseSchema } from "@tender/shared";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type ApiDeps, createApp } from "../src/index";
import { resetDb, seedLifecycle, TEST_NOW, testDeps } from "./helpers";

// `GET /v1/metrics`: every figure is counted from what the indexer wrote, at the time of the
// request. The data is written the way production data is, by the indexer from event lines, and the
// services as the API's writes store them.

const { judge, alice, bob, carol } = FIXTURE_ACCOUNTS;
const SECOND = 1_000_000_000n;
const DAY = 86_400n * SECOND;
const OTHER_TOKEN = "other.test.near";

let deps: ApiDeps;
let nowNs = TEST_NOW;
let nextHeight = 100n;

beforeAll(async () => {
  deps = await testDeps({ now: () => nowNs, judgeAccount: judge, teamAccounts: [bob] });
});

afterAll(() => deps.db.close());

beforeEach(async () => {
  await resetDb(deps.db);
  nowNs = TEST_NOW;
  nextHeight = 100n;
});

function apply(...lines: string[]): Promise<number> {
  return applyBlock(deps.db, blockOf(nextHeight++, lines), FIXTURE_OPTIONS);
}

async function metrics(over: Partial<ApiDeps> = {}): Promise<MetricsResponse> {
  const res = await createApp({ ...deps, ...over }).request("/v1/metrics");
  expect(res.status).toBe(200);
  const body = await res.json();
  // The body is what the schema says, field for field: nothing dropped, nothing of another type.
  expect(MetricsResponseSchema.parse(body)).toEqual(body);
  return body as MetricsResponse;
}

/** Windows that put a task in its commit window at `TEST_NOW`, posted `daysAgo` days before it. */
function openWindows(daysAgo = 0n) {
  const created = TEST_NOW - daysAgo * DAY - 10n * SECOND;
  const commit = TEST_NOW + 60n * SECOND;
  return {
    created_at: String(created),
    commit_deadline: String(commit),
    reveal_deadline: String(commit + 60n * SECOND),
    pick_deadline: String(commit + 120n * SECOND),
    fallback_deadline: String(commit + 180n * SECOND),
  };
}

/** The UTC date of a moment in nanoseconds. */
const dayOf = (ns: bigint) => new Date(Number(ns / 1_000_000n)).toISOString().slice(0, 10);

test("metrics_of_an_empty_index_are_zeros_and_fourteen_empty_days", async () => {
  const body = await metrics();
  expect(body).toMatchObject({
    tasks: { posted: 0, open: 0, settled: 0, picked: 0, voided: 0 },
    paid: [],
    fees: [],
    agents: { registered: 0, active: 0 },
    providers: 0,
    services: { listed: 0, available: 0 },
    top_agents: [],
  });
  expect(body.posted_by_day).toHaveLength(14);
  expect(body.posted_by_day.every((day) => day.tasks === 0)).toBe(true);
  // The last day is today, by the request's clock, in UTC; the days run one after the other.
  expect(body.posted_by_day.at(-1)?.day).toBe(dayOf(TEST_NOW));
  expect(body.posted_by_day[0]?.day).toBe(dayOf(TEST_NOW - 13n * DAY));
});

test("metrics_count_tasks_sum_payouts_and_fees_by_token_and_rank_agents", async () => {
  // Task 1: the lifecycle, picked by the Judge: alice 665003 and bob 285000 of 1000003 in the
  // fixture token, and a fee of 50000. Alice, bob and the Judge register as agents under test.near.
  await seedLifecycle(deps.db);
  await apply(
    // Task 2, voided: no fee, nothing paid.
    eventLine("task_created", { id: "2", ...openWindows(3n) }),
    // Task 3, open now, posted three days ago as well; task 4 open, posted today.
    eventLine("task_created", { id: "3", ...openWindows(3n) }),
    eventLine("task_created", { id: "4", token: OTHER_TOKEN, ...openWindows() }),
    // Task 5, in another token, picked below: carol is paid 900 and the fee is 100.
    eventLine("task_created", { id: "5", token: OTHER_TOKEN, ...openWindows(20n) }),
    // Carol registers on her own (no provider), wins task 5, and then leaves: registered, and not
    // active.
    eventLine("agent_registered", { account: carol, asp: null }),
  );
  await apply(
    eventLine("voided", { task_id: "2" }),
    eventLine("picked", {
      task_id: "5",
      winners: [{ account: carol, bps: 10_000, amount: "900" }],
      fee: "100",
    }),
    eventLine("agent_unregistering", { account: carol, claimable_at: String(TEST_NOW) }),
  );
  // Two services: one that can be hired, one paused.
  const service = {
    provider: bob,
    agent: bob,
    title: "t",
    description: "d",
    tags: [],
    category: "research",
    outputFormat: "text",
    token: FIXTURE_TOKEN,
    price: "1",
    commitSecs: 60,
    revealSecs: 60,
    pickSecs: 60,
    verifier: "hirer" as const,
    criteria: null,
    status: "active" as const,
  };
  await insertService(deps.db, service, 50);
  await insertService(deps.db, { ...service, title: "u", status: "paused" }, 50);
  // Bob holds a bond, so his active service can be hired.
  await deps.db.query("update agents set bond_token = $1, bond_amount = 5 where account = $2", [
    FIXTURE_TOKEN,
    bob,
  ]);

  const body = await metrics();
  expect(body.tasks).toEqual({ posted: 5, open: 2, settled: 3, picked: 2, voided: 1 });
  // Token by token, never one sum of two tokens; in the order of the tokens' ids.
  expect(body.paid).toEqual([
    { token: OTHER_TOKEN, amount: "900" },
    { token: FIXTURE_TOKEN, amount: "950003" },
  ]);
  expect(body.fees).toEqual([
    { token: OTHER_TOKEN, amount: "100" },
    { token: FIXTURE_TOKEN, amount: "50000" },
  ]);
  expect(body.agents).toEqual({ registered: 4, active: 3 });
  // test.near runs alice, bob and the Judge; carol has no provider.
  expect(body.providers).toBe(1);
  expect(body.services).toEqual({ listed: 2, available: 1 });
  // The winners, most wins first and then by account; the Judge and nobody else who never won.
  expect(body.top_agents.map((agent) => [agent.account, agent.wins])).toEqual([
    [alice, 1],
    [bob, 1],
    [carol, 1],
  ]);
  // Each agent as the directory lists it, the team's label included.
  expect(body.top_agents.find((agent) => agent.account === bob)?.is_team).toBe(true);
  expect(body.top_agents.find((agent) => agent.account === alice)?.earned).toEqual({
    [FIXTURE_TOKEN]: "665003",
  });

  // The posting days, by chain time: task 1 and task 4 today, tasks 2 and 3 three days ago, and
  // task 5, twenty days ago, before the fourteen days.
  const byDay = Object.fromEntries(body.posted_by_day.map((row) => [row.day, row.tasks]));
  expect(byDay[dayOf(TEST_NOW)]).toBe(2);
  expect(byDay[dayOf(TEST_NOW - 3n * DAY)]).toBe(2);
  expect(body.posted_by_day.reduce((sum, row) => sum + row.tasks, 0)).toBe(4);

  // The open count follows the clock: a minute and a half on, the open tasks are revealing.
  nowNs = TEST_NOW + 90n * SECOND;
  expect((await metrics()).tasks.open).toBe(0);
  nowNs = TEST_NOW;

  // Without a Judge, a Judge-checked service could not be hired; a hirer-checked one still can.
  expect((await metrics({ judgeAccount: undefined })).services.available).toBe(1);
});

test("metrics_sum_amounts_past_a_u128_and_take_no_query", async () => {
  // Two picks of the largest reward a u128 holds: their sum has 40 digits, and is written whole.
  const max = (2n ** 128n - 1n).toString();
  await apply(
    eventLine("task_created", { id: "1", reward: max, ...openWindows() }),
    eventLine("task_created", { id: "2", reward: max, ...openWindows() }),
  );
  await apply(
    eventLine("picked", { task_id: "1", winners: [{ account: alice, bps: 10_000, amount: max }] }),
    eventLine("picked", { task_id: "2", winners: [{ account: alice, bps: 10_000, amount: max }] }),
  );
  const body = await metrics();
  expect(body.paid).toEqual([
    { token: FIXTURE_TOKEN, amount: (2n * (2n ** 128n - 1n)).toString() },
  ]);

  // A query changes nothing: the route takes none.
  const res = await createApp(deps).request("/v1/metrics?limit=1&poster=x");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(body);
});
