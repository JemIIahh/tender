import type { Db } from "@tender/db";
import { FIXTURE_ACCOUNTS, FIXTURE_TOKEN } from "@tender/indexer/testing";
import { type RecentEventsResponse, RecentEventsResponseSchema } from "@tender/shared";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type ApiDeps, createApp, type ErrorBody } from "../src/index";
import { resetDb, seedLifecycle, testDeps } from "./helpers";

// `GET /v1/events/recent`: the backlog a page reads once before it follows the stream. The events
// are the lifecycle's, written by the indexer from the captured logs, as production's are.

const { alice, judge } = FIXTURE_ACCOUNTS;

let deps: ApiDeps;

beforeAll(async () => {
  deps = await testDeps();
});

afterAll(() => deps.db.close());

beforeEach(async () => {
  await resetDb(deps.db);
});

async function recent(query = ""): Promise<{ status: number; body: unknown }> {
  const res = await createApp(deps).request(`/v1/events/recent${query}`);
  return { status: res.status, body: await res.json() };
}

async function page(query = ""): Promise<RecentEventsResponse> {
  const { status, body } = await recent(query);
  expect(status, query).toBe(200);
  // The body is what the schema says, field for field.
  expect(RecentEventsResponseSchema.parse(body)).toEqual(body);
  return body as RecentEventsResponse;
}

test("recent_events_of_an_empty_index_are_none", async () => {
  expect(await page()).toEqual({ events: [], newest: "0" });
});

test("recent_events_are_the_newest_first_with_their_time_and_token", async () => {
  await seedLifecycle(deps.db);
  // A question board event shares the table: it is not listed, and it is the newest id.
  await deps.db.query(
    `insert into events (height, block_ts, receipt_id, log_index, event, data, task_id)
     values (90, 1, 'board:question_asked:1', 0, 'question_asked', '{"task_id":"1","question_id":"1"}', 1)`,
  );
  const [ids] = await deps.db.query<{ max: string; n: number }>(
    "select max(id)::text as max, count(*)::int as n from events",
  );

  const all = await page("?limit=50");
  // The lifecycle: three registrations, the task, two commits, two reveals, the pick.
  expect(all.events.map((event) => event.event)).toEqual([
    "picked",
    "revealed",
    "revealed",
    "committed",
    "committed",
    "task_created",
    "agent_registered",
    "agent_registered",
    "agent_registered",
  ]);
  expect(all.events).toHaveLength((ids?.n ?? 0) - 1);
  expect(all.newest).toBe(ids?.max);
  const [picked] = all.events;
  expect(picked).toMatchObject({ task_id: "1", token: FIXTURE_TOKEN });
  expect(picked?.data).toMatchObject({ by: judge });
  // Ids run down; each event carries the chain time of its block.
  const asNumbers = all.events.map((event) => BigInt(event.id));
  expect([...asNumbers].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0))).toEqual(asNumbers);
  expect(all.events.every((event) => BigInt(event.block_ts) > 0n)).toBe(true);
  // An event about no task has no token.
  expect(all.events.at(-1)).toMatchObject({
    event: "agent_registered",
    task_id: null,
    token: null,
  });
  expect(all.events.at(-1)?.data).toMatchObject({ account: alice });

  // A page of a few, and only the names asked for.
  expect((await page("?limit=2")).events.map((event) => event.event)).toEqual([
    "picked",
    "revealed",
  ]);
  const chosen = await page("?event=task_created,picked");
  expect(chosen.events.map((event) => event.event)).toEqual(["picked", "task_created"]);
  expect(chosen.newest).toBe(ids?.max);
});

test("recent_events_miss_nothing_when_a_block_lands_between_the_two_reads", async () => {
  await seedLifecycle(deps.db);
  const real = deps.db;
  // A database on which the indexer commits a block just after the route's first read and before
  // its second, as two connections of a pool can see it. Whatever the route reads first sees the
  // index without the block; whatever it reads second sees it with.
  let calls = 0;
  let landed = (): void => {};
  const blockLanded = new Promise<void>((resolve) => {
    landed = resolve;
  });
  let late = "";
  const query: Db["query"] = async (sql, params) => {
    if (calls++ > 0) {
      await blockLanded;
      return real.query(sql, params);
    }
    const rows = await real.query(sql, params);
    const [row] = await real.query<{ id: string }>(
      `insert into events (height, block_ts, receipt_id, log_index, event, data, task_id)
       values (91, 1793307600000000000, 'late-receipt', 0, 'agent_registered', $1::jsonb, null)
       returning id::text as id`,
      [JSON.stringify({ account: "late.test.near" })],
    );
    late = row?.id ?? "";
    landed();
    return rows as never;
  };
  const moving = new Proxy(real, {
    get(target, name) {
      if (name === "query") return query;
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const res = await createApp({ ...deps, db: moving }).request("/v1/events/recent?limit=50");
  const body = RecentEventsResponseSchema.parse(await res.json());

  // Every listed event at or below `newest` is in the backlog, and the late one, if it is not
  // there, is after `newest`, where the stream opened at `?since=newest` sends it.
  const listed = await real.query<{ id: string }>(
    "select id::text as id from events where event = any($1::text[]) and id <= $2::bigint order by id desc",
    [["agent_registered", "task_created", "committed", "revealed", "picked"], body.newest],
  );
  expect(body.events.map((event) => event.id)).toEqual(listed.map((row) => row.id));
  expect(late).not.toBe("");
  const inBacklog = body.events.some((event) => event.id === late);
  expect(inBacklog || BigInt(late) > BigInt(body.newest)).toBe(true);
});

test("recent_events_refuse_a_name_that_is_not_the_contract_s", async () => {
  for (const query of ["?event=question_asked", "?event=picked,nope", "?limit=0"]) {
    const { status, body } = await recent(query);
    expect(status, query).toBe(400);
    expect((body as ErrorBody).error, query).toBe("bad_request");
  }
});
