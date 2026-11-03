import { randomBytes } from "node:crypto";
import { applyBlock } from "@tender/indexer";
import {
  blockOf,
  eventLine,
  FIXTURE_ACCOUNTS,
  FIXTURE_OPTIONS,
  LIFECYCLE_TASK_ID,
} from "@tender/indexer/testing";
import { type Phase, phaseAt, sha256Hex, type TenderEvent } from "@tender/shared";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { AuthVariables, RequireAuth } from "../src/auth";
import { handleError } from "../src/format";
import { type ApiDeps, createApp, type ErrorBody, type ListTasksResponse } from "../src/index";
import { startRoutes } from "../src/routes/start";
import { telegramRoutes } from "../src/routes/telegram";
import { resetDb, seedLifecycle, TEST_NOW, testDeps } from "./helpers";

// The working signal and the Telegram link. Both routes are mounted on an app of their own with
// `stubAuth`, which reads the signed-in account from a header, so most tests do not sign in;
// sign-in has `auth.test.ts`, and the tests that end `_requires_sign_in` hold `createApp` to
// refusing a request without a bearer token and to accepting one that a real sign-in could have
// issued. The data is written by the indexer from the captured event logs, as in production:
// task 1 is the lifecycle's, which is settled, and the others are open or in a later phase at
// `TEST_NOW`. The clock is a variable, so a test can move it across a deadline.

const { alice, bob, carol } = FIXTURE_ACCOUNTS;
const SECOND = 1_000_000_000n;
const MINUTE = 60n * SECOND;
const BOT = "tender_test_bot";

let deps: ApiDeps;
let nowNs = TEST_NOW;
let nextHeight = 100n;

beforeAll(async () => {
  deps = await testDeps({ now: () => nowNs, telegramBotUsername: BOT });
});

afterAll(() => deps.db.close());

beforeEach(async () => {
  await resetDb(deps.db);
  nowNs = TEST_NOW;
  // The lifecycle's blocks occupy heights 60 to 90, and a block applied at a height already used
  // would be skipped, so every extra block gets a height of its own above them.
  nextHeight = 100n;
});

/** Applies one block of its own in which each of `lines` has a receipt. */
function apply(...lines: string[]): Promise<number> {
  return applyBlock(deps.db, blockOf(nextHeight++, lines), FIXTURE_OPTIONS);
}

/** A stand-in for sign-in: the account is the `x-test-account` header, and no header is no sign-in. */
const stubAuth: RequireAuth = async (c, next) => {
  const account = c.req.header("x-test-account");
  if (account === undefined) {
    const body: ErrorBody = { error: "unauthorized", message: "sign in first" };
    return c.json(body, 401);
  }
  c.set("account", account);
  await next();
};

/** The two routes alone, under `/v1`, with the API's error handler. */
function appWith(over: Partial<ApiDeps> = {}): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError(handleError);
  app.route("/v1", startRoutes({ ...deps, ...over }, stubAuth));
  app.route("/v1", telegramRoutes({ ...deps, ...over }, stubAuth));
  return app;
}

interface Reply<T> {
  status: number;
  body: T;
  headers: Headers;
}

/** Posts nothing, as `account` or signed out. */
async function post<T = unknown>(
  path: string,
  account?: string,
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> } = appWith(),
  headers: Record<string, string> = {},
): Promise<Reply<T>> {
  const sent = { ...headers };
  if (account !== undefined) sent["x-test-account"] = account;
  const res = await app.request(path, { method: "POST", headers: sent });
  return { status: res.status, body: (await res.json()) as T, headers: res.headers };
}

// ---- Data -------------------------------------------------------------------------------------

type TaskCreated = Extract<TenderEvent, { event: "task_created" }>["data"];
type OpenPhase = Exclude<Phase, "settled">;
const PHASE_ORDER: OpenPhase[] = ["open", "revealing", "judging", "fallback", "expired"];

/**
 * Deadlines 60 seconds apart that put a task in `phase` at `TEST_NOW`, 30 seconds from the nearest
 * deadline on either side.
 */
function windowsFor(
  phase: OpenPhase,
): Pick<
  TaskCreated,
  "created_at" | "commit_deadline" | "reveal_deadline" | "pick_deadline" | "fallback_deadline"
> {
  const commit = TEST_NOW + (60n * BigInt(1 - PHASE_ORDER.indexOf(phase)) - 30n) * SECOND;
  return {
    created_at: String(commit - 100n * SECOND),
    commit_deadline: String(commit),
    reveal_deadline: String(commit + 60n * SECOND),
    pick_deadline: String(commit + 120n * SECOND),
    fallback_deadline: String(commit + 180n * SECOND),
  };
}

const taskLine = (id: number, phase: OpenPhase) =>
  eventLine("task_created", { id: String(id), ...windowsFor(phase) });

/**
 * The lifecycle's task 1 (settled) and one task in each phase that is not `settled` at `TEST_NOW`:
 * 2 is open, 3 revealing, 4 judging, 5 in the fallback window, 6 expired, and 7 open again.
 */
async function seedBoard(): Promise<void> {
  await seedLifecycle(deps.db);
  await apply(...PHASE_ORDER.map((phase, i) => taskLine(i + 2, phase)), taskLine(7, "open"));
}

const workingRows = () =>
  deps.db.query<{ task_id: string; account: string }>(
    "select task_id::text as task_id, account from working order by task_id, account",
  );

/** A token as sign-in would have issued it: stored by its hash, for a full-access key. */
async function tokenFor(account: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await deps.db.query(
    `insert into auth_tokens (token_sha256, account, public_key, key_kind, expires_at)
     values ($1, $2, 'ed25519:test', 'full_access', $3::timestamptz)`,
    [sha256Hex(token), account, new Date(Number(TEST_NOW / 1_000_000n) + 3_600_000).toISOString()],
  );
  return token;
}

// ---- Start ------------------------------------------------------------------------------------

test("start_only_while_open", async () => {
  await seedBoard();
  const app = appWith();

  const started = await post<{ ok: boolean; working_count: number }>(
    "/v1/tasks/2/start",
    alice,
    app,
  );
  expect(started.status).toBe(200);
  expect(started.body).toEqual({ ok: true, working_count: 1 });

  // Every other phase is refused, settled included, and nothing is written for it.
  const refused: Array<[string, Phase]> = [
    ["3", "revealing"],
    ["4", "judging"],
    ["5", "fallback"],
    ["6", "expired"],
    [LIFECYCLE_TASK_ID, "settled"],
  ];
  for (const [id, phase] of refused) {
    const res = await post<ErrorBody>(`/v1/tasks/${id}/start`, alice, app);
    expect(res.status, `task ${id}`).toBe(409);
    expect(res.body.error, `task ${id}`).toBe("not_open");
    expect(res.body.message, `task ${id}`).toContain(phase);
  }
  expect(await workingRows()).toEqual([{ task_id: "2", account: alice }]);
});

test("start_follows_the_phase_clock", async () => {
  await seedBoard();
  const app = appWith();
  const windows = windowsFor("open");
  const commit = BigInt(windows.commit_deadline);

  // At every moment around the deadlines the answer is the one `phaseAt` gives: a task is open
  // up to, but not including, its commit deadline, and from the deadline on it is not.
  const task = {
    commit_deadline: windows.commit_deadline,
    reveal_deadline: windows.reveal_deadline,
    pick_deadline: windows.pick_deadline,
    fallback_deadline: windows.fallback_deadline,
    settled: false,
  };
  const moments = [
    0n,
    commit - 1n,
    commit,
    commit + 1n,
    BigInt(windows.fallback_deadline),
    2n ** 64n - 1n,
  ];
  for (const moment of moments) {
    nowNs = moment;
    const expected = phaseAt(task, moment) === "open" ? 200 : 409;
    const res = await post("/v1/tasks/2/start", bob, app);
    expect(res.status, `at ${moment}`).toBe(expected);
  }
  nowNs = commit - 1n;
  expect((await post("/v1/tasks/2/start", carol, app)).status).toBe(200);
  nowNs = commit;
  expect((await post("/v1/tasks/2/start", alice, app)).status).toBe(409);

  // A task with an outcome is settled whatever the time, even before its commit deadline.
  nowNs = commit - 1n;
  await deps.db.query(
    `update tasks set outcome = '{"kind":"voided"}'::jsonb, settled_height = 1 where id = 7`,
  );
  const settled = await post<ErrorBody>("/v1/tasks/7/start", alice, app);
  expect(settled.status).toBe(409);
  expect(settled.body.error).toBe("not_open");
  expect((await workingRows()).filter((row) => row.task_id === "7")).toEqual([]);
});

test("start_is_idempotent", async () => {
  await seedBoard();
  const app = appWith();
  const startedAt = () =>
    deps.db.query<{ started_at: Date }>(
      "select started_at from working where task_id = 2 and account = $1",
      [alice],
    );

  const first = await post<{ ok: boolean; working_count: number }>("/v1/tasks/2/start", alice, app);
  expect(first.body).toEqual({ ok: true, working_count: 1 });
  const [firstStart] = await startedAt();

  // Pushed into the past, so that a second start that rewrote the row could not look the same.
  await deps.db.query(
    "update working set started_at = '2020-01-01T00:00:00Z' where task_id = 2 and account = $1",
    [alice],
  );
  const again = await post<{ ok: boolean; working_count: number }>("/v1/tasks/2/start", alice, app);
  expect(again.status).toBe(200);
  expect(again.body).toEqual({ ok: true, working_count: 1 });
  const [kept] = await startedAt();
  expect(kept?.started_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  // The first start was stamped now, by the database, and not with a date in the past.
  expect(firstStart?.started_at.getTime()).toBeGreaterThan(Date.parse("2020-01-01"));

  // Another account adds to the count, and the same count is what the board shows.
  const second = await post<{ working_count: number }>("/v1/tasks/2/start", bob, app);
  expect(second.body).toEqual({ ok: true, working_count: 2 });
  const other = await post<{ working_count: number }>("/v1/tasks/7/start", alice, app);
  expect(other.body).toEqual({ ok: true, working_count: 1 });
  expect(await workingRows()).toEqual([
    { task_id: "2", account: alice },
    { task_id: "2", account: bob },
    { task_id: "7", account: alice },
  ]);

  const board = await createApp(deps).request("/v1/tasks");
  const { tasks } = (await board.json()) as ListTasksResponse;
  const counts = Object.fromEntries(tasks.map((t) => [t.id, t.working_count]));
  expect(counts).toMatchObject({ "2": 2, "7": 1, "3": 0 });
  // A count is a JSON integer, not a decimal string.
  expect(typeof second.body.working_count).toBe("number");
});

test("start_of_an_unknown_task_is_404", async () => {
  await seedBoard();
  const app = appWith();
  // An id that is no canonical u64 names no task, like any id the index does not hold.
  for (const id of ["999", "0", "abc", "01", "-1", "1.5", "1e1", "0x2", "18446744073709551616"]) {
    const res = await post<ErrorBody>(`/v1/tasks/${id}/start`, alice, app);
    expect(res.status, id).toBe(404);
    expect(res.body, id).toEqual({ error: "not_found", message: "no such task" });
  }
  expect(await workingRows()).toEqual([]);
});

test("start_requires_sign_in", async () => {
  await seedBoard();
  // The real app: a header that stands in for sign-in in the tests above is nothing to it.
  const app = createApp(deps);
  const attempts: Array<Record<string, string>> = [
    {},
    { authorization: "Bearer anything" },
    { authorization: `Bearer ${"A".repeat(43)}` },
    { "x-test-account": alice },
  ];
  for (const headers of attempts) {
    const res = await post<ErrorBody>("/v1/tasks/2/start", undefined, app, headers);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  }
  expect(await workingRows()).toEqual([]);

  // A token that sign-in issued is the account it was issued to.
  const token = await tokenFor(bob);
  const signedIn = await post<{ working_count: number }>("/v1/tasks/2/start", undefined, app, {
    authorization: `Bearer ${token}`,
  });
  expect(signedIn.status).toBe(200);
  expect(signedIn.body).toEqual({ ok: true, working_count: 1 });
  expect(await workingRows()).toEqual([{ task_id: "2", account: bob }]);
});

// ---- Telegram link ----------------------------------------------------------------------------

interface LinkReply {
  url: string;
  expires_at: string;
}

const nonceRows = () =>
  deps.db.query<{ nonce: string; account: string; used: boolean; expires_at: Date }>(
    "select nonce, account, used, expires_at from tg_link_nonces order by expires_at",
  );

test("telegram_link_url_and_expiry", async () => {
  const app = appWith();
  const res = await post<LinkReply>("/v1/telegram/link", alice, app);
  expect(res.status).toBe(200);
  expect(Object.keys(res.body).sort()).toEqual(["expires_at", "url"]);
  // A link is for one person and says so to every cache between us and them.
  expect(res.headers.get("cache-control")).toBe("no-store");

  // The deep link: 16 random bytes as base64url are 22 characters from Telegram's `A-Za-z0-9_-`.
  const match = /^https:\/\/t\.me\/tender_test_bot\?start=([A-Za-z0-9_-]{22})$/.exec(res.body.url);
  expect(match, res.body.url).not.toBeNull();
  const nonce = match?.[1] ?? "";
  expect(Buffer.from(nonce, "base64url")).toHaveLength(16);

  // The row is the account's, unspent, and good for 10 minutes of the database's own clock, which
  // is the one the bot reads. `expires_at` is that same instant, to the millisecond.
  const rows = await nonceRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ nonce, account: alice, used: false });
  expect(
    Math.abs((rows[0]?.expires_at.getTime() ?? 0) - Date.parse(res.body.expires_at)),
  ).toBeLessThan(2);
  expect(res.body.expires_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const [timing] = await deps.db.query<{ left: number }>(
    "select extract(epoch from (expires_at - now()))::float8 as left from tg_link_nonces",
  );
  expect(timing?.left).toBeGreaterThan(9 * 60 + 50);
  expect(timing?.left).toBeLessThanOrEqual(10 * 60);

  // The API's clock (`deps.now`) is a test's to move and the database's is not, and here they
  // differ by more than a minute. The link follows the database's, which is what the bot compares
  // with.
  expect(Math.abs(Number(nowNs / 1_000_000n) - Date.now())).toBeGreaterThan(60_000);
  const spend = (n: string) =>
    deps.db.query(
      "update tg_link_nonces set used = true where nonce = $1 and not used and expires_at > now() returning account",
      [n],
    );
  expect(await spend(nonce)).toEqual([{ account: alice }]);
  expect(await spend(nonce)).toEqual([]);

  // Every call is a new nonce, for the account that asked.
  const a = await post<LinkReply>("/v1/telegram/link", bob, app);
  const b = await post<LinkReply>("/v1/telegram/link", bob, app);
  expect(a.body.url).not.toBe(b.body.url);
  const accounts = (await nonceRows()).map((row) => row.account).sort();
  expect(accounts).toEqual([alice, bob, bob]);
});

test("telegram_link_removes_nonces_expired_over_an_hour_ago", async () => {
  const insert = (nonce: string, expires: string, used = false) =>
    deps.db.query(
      "insert into tg_link_nonces (nonce, account, expires_at, used) values ($1, $2, now() + $3::interval, $4)",
      [nonce, alice, expires, used],
    );
  await insert("expired-two-hours-ago", "-2 hours");
  await insert("expired-and-spent-long-ago", "-3 hours", true);
  await insert("expired-61-minutes-ago", "-61 minutes");
  await insert("expired-59-minutes-ago", "-59 minutes");
  await insert("still-live", "5 minutes");

  const res = await post<LinkReply>("/v1/telegram/link", alice);
  expect(res.status).toBe(200);

  // Only what expired more than an hour ago is gone; the rest is kept, and the new link is there.
  const kept = (await nonceRows()).map((row) => row.nonce).sort();
  const fresh = new URL(res.body.url).searchParams.get("start") ?? "";
  expect(kept).toEqual(["expired-59-minutes-ago", "still-live", fresh].sort());
});

test("telegram_link_503_without_bot", async () => {
  await deps.db.query(
    "insert into tg_link_nonces (nonce, account, expires_at) values ('old', $1, now() - interval '3 hours')",
    [alice],
  );
  for (const telegramBotUsername of [undefined, ""]) {
    const res = await post<ErrorBody>("/v1/telegram/link", alice, appWith({ telegramBotUsername }));
    expect(res.status, String(telegramBotUsername)).toBe(503);
    expect(res.body).toEqual({ error: "unavailable", message: "Telegram linking is not set up" });
  }
  // Before anything is written: no new nonce, and not even the clean-up ran.
  expect((await nonceRows()).map((row) => row.nonce)).toEqual(["old"]);
});

test("telegram_link_requires_sign_in", async () => {
  const app = createApp(deps);
  const attempts: Array<Record<string, string>> = [
    {},
    { authorization: "Bearer anything" },
    { "x-test-account": alice },
  ];
  for (const headers of attempts) {
    const res = await post<ErrorBody>("/v1/telegram/link", undefined, app, headers);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  }
  expect(await nonceRows()).toEqual([]);

  const token = await tokenFor(carol);
  const res = await post<LinkReply>("/v1/telegram/link", undefined, app, {
    authorization: `Bearer ${token}`,
  });
  expect(res.status).toBe(200);
  expect(res.body.url).toMatch(/^https:\/\/t\.me\/tender_test_bot\?start=[A-Za-z0-9_-]{22}$/);
  expect((await nonceRows()).map((row) => row.account)).toEqual([carol]);

  // The expiry stays ten minutes of the database's clock whatever the API's clock says.
  nowNs = TEST_NOW + 30n * MINUTE;
  const later = await post<LinkReply>("/v1/telegram/link", undefined, app, {
    authorization: `Bearer ${token}`,
  });
  expect(later.status).toBe(200);
  expect(Date.parse(later.body.expires_at) - Date.now()).toBeGreaterThan(9 * 60_000);
});
