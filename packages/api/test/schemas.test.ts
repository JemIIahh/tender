import { Buffer } from "node:buffer";
import { putBlob } from "@tender/db";
import { applyBlock } from "@tender/indexer";
import {
  blockOf,
  eventLine,
  FIXTURE_ACCOUNTS,
  FIXTURE_BRIEF,
  FIXTURE_OPTIONS,
} from "@tender/indexer/testing";
import type * as Shared from "@tender/shared";
import {
  AccountEntriesResponseSchema,
  AgentDetailResponseSchema,
  BlobUploadResponseSchema,
  ChallengeResponseSchema,
  canonicalJson,
  ErrorBodySchema,
  EventMessageSchema,
  HealthResponseSchema,
  HealthUnavailableSchema,
  HeldoutUploadResponseSchema,
  ListAgentsResponseSchema,
  ListTasksResponseSchema,
  type Phase,
  type PublicCriteria,
  type Scorecard,
  ScorecardSchema,
  SignInResponseSchema,
  StartResponseSchema,
  sha256Hex,
  TaskDetailResponseSchema,
  TelegramLinkResponseSchema,
  type TenderEvent,
  TenderEventSchema,
} from "@tender/shared";
import type { Hono } from "hono";
import { Account, KeyPair, KeyPairSigner, type Provider } from "near-api-js";
import * as nearNep413 from "near-api-js/nep413";
import { afterAll, beforeAll, beforeEach, expect, expectTypeOf, test, vi } from "vitest";
import type { z } from "zod";
import type { ChallengeResponse, SignInResponse } from "../src/auth";
import type * as Api from "../src/format";
import { type ApiDeps, createApp } from "../src/index";
import type { StartResponse } from "../src/routes/start";
import type { TelegramLinkResponse } from "../src/routes/telegram";
import type { EventMessage } from "../src/sse";
import { fakeClient, resetDb, seedLifecycle, TEST_NOW, testDeps } from "./helpers";

// The drift test of `@tender/shared`'s API schemas (src/api.ts). The web app, the MCP server and
// the agents read every response through those schemas, so each one has to be what its route
// really sends. Every test seeds data the way production data is written, with the indexer from
// the captured event logs, calls the routes of `createApp` with `app.request()`, and holds each
// JSON body to `Schema.parse(body)` equal to `body`: a field the route sends and the schema lacks
// is dropped from the parsed copy, and a value of the wrong type fails the parse, so either one
// fails here. Error bodies are held to `ErrorBodySchema` the same way.

const { judge, alice, bob, carol } = FIXTURE_ACCOUNTS;
const SECOND = 1_000_000_000n;
const BOT = "tender_test_bot";

let deps: ApiDeps;
let nextHeight = 100n;

beforeAll(async () => {
  deps = await testDeps();
});

afterAll(() => deps.db.close());

beforeEach(async () => {
  await resetDb(deps.db);
  // The lifecycle's blocks occupy heights 60 to 90, and a block applied at a height already used
  // would be skipped, so every extra block gets a height of its own above them.
  nextHeight = 100n;
});

/** Applies one block of its own in which each of `lines` has a receipt. */
function apply(...lines: string[]): Promise<number> {
  return applyBlock(deps.db, blockOf(nextHeight++, lines), FIXTURE_OPTIONS);
}

function appWith(over: Partial<ApiDeps> = {}): Hono {
  return createApp({ ...deps, ...over });
}

interface Reply {
  status: number;
  body: unknown;
}

async function send(app: Hono, path: string, init: RequestInit = {}): Promise<Reply> {
  const res = await app.request(path, init);
  return { status: res.status, body: await res.json() };
}

const get = (app: Hono, path: string) => send(app, path);

function post(app: Hono, path: string, body?: unknown, token?: string): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return send(app, path, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * `body` as `schema` reads it, which must be a copy of `body` as it is. Throws, naming `what` and
 * the first faults, when the body does not fit.
 */
function fits<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`${what} does not fit: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`);
  }
  expect(parsed.data, what).toEqual(body);
  return parsed.data;
}

/** An error reply: the status, the code, and a body that is an `ErrorBodySchema` document. */
function failsWith(reply: Reply, status: number, error: string, what: string) {
  expect(reply.status, what).toBe(status);
  const body = fits(ErrorBodySchema, reply.body, what);
  expect(body.error, what).toBe(error);
  return body;
}

// ---- Data -------------------------------------------------------------------------------------

type OpenPhase = Exclude<Phase, "settled">;
const PHASE_ORDER: OpenPhase[] = ["open", "revealing", "judging", "fallback", "expired"];

/**
 * Deadlines 60 seconds apart that put a task in `phase` at `TEST_NOW`, 30 seconds from the nearest
 * deadline on either side.
 */
function windowsFor(phase: OpenPhase) {
  const commit = TEST_NOW + (60n * BigInt(1 - PHASE_ORDER.indexOf(phase)) - 30n) * SECOND;
  return {
    created_at: String(commit - 100n * SECOND),
    commit_deadline: String(commit),
    reveal_deadline: String(commit + 60n * SECOND),
    pick_deadline: String(commit + 120n * SECOND),
    fallback_deadline: String(commit + 180n * SECOND),
  };
}

type TaskCreated = Extract<TenderEvent, { event: "task_created" }>["data"];

const taskLine = (id: number, over: Partial<TaskCreated> = {}) =>
  eventLine("task_created", { id: String(id), ...over });

const CRITERIA: PublicCriteria = {
  kind: "exact",
  version: 1,
  min_score: 60,
  split: "winner_take_all",
  has_heldout: true,
  normalize: ["trim"],
};

/** What the Judge says when it turns a task away. */
const REFUSAL = "kind rubric is limited to team tasks in v1";

function scorecardOf(taskId: string, criteriaHash: string): Scorecard {
  return {
    version: 1,
    task_id: taskId,
    verifier: judge,
    kind: "exact",
    criteria_hash: criteriaHash,
    heldout_commitment: null,
    heldout: null,
    tie_break: "score desc, committed_at_block asc, account asc",
    entries: [
      {
        account: alice,
        content_hash: sha256Hex("alice work"),
        uri: "ipfs://alice-work",
        committed_at_block: "65",
        score: 100,
        passed: true,
        reasons: ["matches the expected value"],
      },
    ],
    winners: [{ account: alice, bps: 10_000 }],
    generated_at: "2026-10-30T10:00:00Z",
    judge: { software: "tender-judge/1", model: null },
  };
}

async function putDocument(kind: "criteria" | "scorecard", document: unknown): Promise<string> {
  return putBlob(deps.db, {
    kind,
    contentType: "application/json",
    bytes: canonicalJson(document),
    isPublic: true,
  });
}

/**
 * The lifecycle's task 1 (settled, picked by the judge) and six more, one of each way a task can
 * stand, so that every shape of a task page is on the board:
 *
 * | id | state at TEST_NOW                                | outcome                                     |
 * | -- | ------------------------------------------------ | ------------------------------------------- |
 * | 1  | settled, topped up by carol, task 2 is its child | pick by the judge, no scorecard stored      |
 * | 2  | open; alice has committed and not revealed       | none                                        |
 * | 3  | settled; criteria and scorecard blobs are stored | pick by the judge                           |
 * | 4  | settled; the Judge refused it at intake          | void by `void_task`: no `by`, no scorecard  |
 * | 5  | settled                                          | empty pick by the judge, with refunds       |
 * | 6  | settled                                          | pick the index took from the chain's view   |
 * | 7  | settled                                          | void the index took from the chain's view   |
 *
 * The last two are what `reconcile` writes for an outcome it did not see happen: `by` is null,
 * `by_source` says why, and a void has no `refunds` (`outcomeFromView` in the indexer). The API's
 * own `TaskOutcome` type has to accept them, which `satisfies` checks when the tests are
 * type-checked.
 */
async function seedBoard(): Promise<void> {
  await seedLifecycle(deps.db, { teamAccounts: [judge] });
  const criteriaHash = await putDocument("criteria", CRITERIA);
  const scorecardHash = await putDocument("scorecard", scorecardOf("3", criteriaHash));

  await apply(
    eventLine("task_topped_up"),
    taskLine(2, { poster: carol, parent: "1", ...windowsFor("open") }),
    eventLine("committed", { task_id: "2", account: alice, block_height: "120" }),
    taskLine(3, { criteria_hash: criteriaHash, ...windowsFor("judging") }),
    eventLine("picked", { task_id: "3", scorecard_hash: scorecardHash }),
    taskLine(4, windowsFor("expired")),
    eventLine("voided", {
      task_id: "4",
      reason: "expired",
      by: null,
      scorecard_hash: null,
      scorecard_uri: null,
    }),
    taskLine(5, windowsFor("judging")),
    eventLine("voided", { task_id: "5" }),
    taskLine(6, windowsFor("judging")),
    taskLine(7, windowsFor("judging")),
  );

  const reconciledPick = {
    kind: "picked",
    task_id: "6",
    by: null,
    by_source: "reconcile",
    winners: [{ account: alice, bps: 10_000, amount: "950000" }],
    fee: "50000",
    scorecard_hash: sha256Hex("a scorecard nobody uploaded"),
    scorecard_uri: "ipfs://scorecard",
  } satisfies Api.TaskOutcome;
  const reconciledVoid = {
    kind: "voided",
    task_id: "7",
    by: null,
    by_source: "reconcile",
    reason: "expired",
    scorecard_hash: null,
    scorecard_uri: null,
  } satisfies Api.TaskOutcome;
  for (const outcome of [reconciledPick, reconciledVoid]) {
    await deps.db.query("update tasks set outcome = $2::jsonb where id = $1::numeric", [
      outcome.task_id,
      JSON.stringify(outcome),
    ]);
  }
  // The rows no event writes: what the Judge made of a task and why, and who said they are working
  // on it.
  await deps.db.query("update tasks set judge_status = 'accepted' where id = 2");
  await deps.db.query(
    "update tasks set judge_status = 'rejected', judge_reason = $1 where id = 4",
    [REFUSAL],
  );
  await deps.db.query("insert into working (task_id, account) values (2, $1), (2, $2)", [
    alice,
    bob,
  ]);
}

// ---- Signing in -------------------------------------------------------------------------------

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** A whole sign-in as `account` with a fresh key, signed by near-api-js as a wallet would. */
async function signIn(app: Hono, account: string = alice): Promise<string> {
  const challenge = await post(app, "/v1/auth/challenge");
  expect(challenge.status).toBe(200);
  const { nonce, message, recipient } = fits(ChallengeResponseSchema, challenge.body, "challenge");

  // Signing a NEP-413 message is local: the account's provider is never called.
  const key = KeyPair.fromRandom("ed25519");
  const signerAccount = new Account(account, {} as unknown as Provider, new KeyPairSigner(key));
  const signed = await nearNep413.signMessage({
    signerAccount,
    payload: { message, recipient, nonce: Uint8Array.from(Buffer.from(nonce, "base64")) },
  });
  const verified = await post(app, "/v1/auth/verify", {
    account_id: account,
    public_key: signed.publicKey.toString(),
    signature: toBase64(signed.signature),
    nonce,
    message,
    recipient,
  });
  expect(verified.status).toBe(200);
  return fits(SignInResponseSchema, verified.body, "verify").token;
}

// ---- Tasks ------------------------------------------------------------------------------------

test("task_routes_match_their_schemas", async () => {
  await seedBoard();
  const app = appWith({ teamAccounts: [alice, carol] });

  const list = await get(app, "/v1/tasks");
  expect(list.status).toBe(200);
  const board = fits(ListTasksResponseSchema, list.body, "GET /v1/tasks");
  expect(board.tasks.map((task) => task.id)).toEqual(["7", "6", "5", "4", "3", "2", "1"]);
  expect(board.next_cursor).toBeNull();
  expect(board.tasks.find((task) => task.id === "2")).toMatchObject({
    phase: "open",
    working_count: 2,
    judge_status: "accepted",
    judge_reason: null,
    is_team_poster: true,
    parent: "1",
    outcome_kind: null,
  });
  // A task the Judge turned away says so in the list, and why.
  expect(board.tasks.find((task) => task.id === "4")).toMatchObject({
    judge_status: "rejected",
    judge_reason: REFUSAL,
  });

  // A page that is not the last has a cursor, and a filtered list is the same schema.
  const page = await get(app, "/v1/tasks?limit=3");
  expect(fits(ListTasksResponseSchema, page.body, "GET /v1/tasks?limit=3").next_cursor).toBe("5");
  const settled = await get(app, "/v1/tasks?phase=settled&tag=extraction");
  expect(fits(ListTasksResponseSchema, settled.body, "a filtered list").tasks).toHaveLength(1);
  const none = await get(app, "/v1/tasks?tag=nothing");
  expect(fits(ListTasksResponseSchema, none.body, "an empty list")).toEqual({
    tasks: [],
    next_cursor: null,
  });

  const detail = async (id: string) => {
    const reply = await get(app, `/v1/tasks/${id}`);
    expect(reply.status, `task ${id}`).toBe(200);
    return fits(TaskDetailResponseSchema, reply.body, `GET /v1/tasks/${id}`);
  };
  const [one, two, three, four, five, six, seven] = await Promise.all(
    ["1", "2", "3", "4", "5", "6", "7"].map(detail),
  );

  // The seed reached each shape the schema has to hold: documents, both kinds of entry, funders,
  // children, and every outcome.
  expect(one?.brief).toEqual(FIXTURE_BRIEF);
  expect(one?.scorecard).toBeNull();
  expect(one?.funders).toHaveLength(2);
  expect(one?.children).toEqual(["2"]);
  expect(one?.entries.map((entry) => [entry.revealed, entry.is_team])).toEqual([
    [true, true],
    [true, false],
  ]);
  expect(one?.task.outcome).toMatchObject({ kind: "picked", by: judge });
  expect(two?.entries).toMatchObject([{ account: alice, revealed: false, content_hash: null }]);
  expect(two?.task).toMatchObject({ judge_status: "accepted", judge_reason: null });
  expect(three?.criteria).toEqual(CRITERIA);
  expect(three?.scorecard?.task_id).toBe("3");
  expect(four?.task.outcome).toMatchObject({ kind: "voided", reason: "expired", by: null });
  expect(four?.task.outcome).toHaveProperty("refunds");
  expect(four?.task).toMatchObject({ judge_status: "rejected", judge_reason: REFUSAL });
  expect(five?.task.outcome).toMatchObject({ kind: "voided", reason: "no_award", by: judge });
  expect(six?.task.outcome).toMatchObject({ kind: "picked", by: null, by_source: "reconcile" });
  expect(seven?.task.outcome).toMatchObject({ kind: "voided", by: null, by_source: "reconcile" });
  expect(seven?.task.outcome).not.toHaveProperty("refunds");
});

test("scorecard_route_matches_the_scorecard_schema", async () => {
  await seedBoard();
  const app = appWith();

  const reply = await get(app, "/v1/scorecards/3");
  expect(reply.status).toBe(200);
  const scorecard = fits(ScorecardSchema, reply.body, "GET /v1/scorecards/3");
  expect(scorecard.task_id).toBe("3");

  // The scorecard of a task that has none is an error body.
  failsWith(await get(app, "/v1/scorecards/1"), 404, "not_found", "no scorecard stored");
});

// ---- Agents and entries -----------------------------------------------------------------------

test("agent_and_entry_routes_match_their_schemas", async () => {
  await seedLifecycle(deps.db, { teamAccounts: [judge] });
  // carol registers under no provider, and alice commits to a second task and has not revealed.
  await apply(
    eventLine("agent_registered", { account: carol, asp: null }),
    taskLine(2, windowsFor("open")),
    eventLine("committed", { task_id: "2", account: alice, block_height: "120" }),
  );
  const app = appWith();

  const list = await get(app, "/v1/agents");
  expect(list.status).toBe(200);
  const directory = fits(ListAgentsResponseSchema, list.body, "GET /v1/agents");
  expect(directory.agents.map((agent) => agent.account)).toEqual([alice, bob, carol, judge]);
  const byAccount = Object.fromEntries(directory.agents.map((agent) => [agent.account, agent]));
  expect(byAccount[alice]?.name).toBe("Alice Extractor");
  expect(Object.keys(byAccount[alice]?.earned ?? {})).toHaveLength(1);
  expect(byAccount[bob]?.name).toBeNull();
  expect(byAccount[carol]).toMatchObject({ asp: null, earned: {} });
  expect(byAccount[judge]).toMatchObject({ is_team: true, picks_made: 1 });

  const page = await get(app, "/v1/agents?limit=2");
  expect(fits(ListAgentsResponseSchema, page.body, "GET /v1/agents?limit=2").next_cursor).toBe(bob);

  const detail = async (account: string) => {
    const reply = await get(app, `/v1/agents/${account}`);
    expect(reply.status, account).toBe(200);
    return fits(AgentDetailResponseSchema, reply.body, `GET /v1/agents/${account}`);
  };
  const aliceDetail = await detail(alice);
  expect(aliceDetail.recent_entries).toEqual([
    { task_id: "2", title: null, phase: "open", revealed: false, won: false },
    { task_id: "1", title: FIXTURE_BRIEF.title, phase: "settled", revealed: true, won: true },
  ]);
  expect((await detail(judge)).recent_entries).toEqual([]);

  const entries = await get(app, `/v1/entries?account=${alice}`);
  expect(entries.status).toBe(200);
  const mine = fits(AccountEntriesResponseSchema, entries.body, "GET /v1/entries");
  expect(
    mine.entries.map((entry) => [entry.task_id, entry.revealed, entry.content_hash === null]),
  ).toEqual([
    ["2", false, true],
    ["1", true, false],
  ]);
  const empty = await get(app, `/v1/entries?account=${carol}`);
  expect(fits(AccountEntriesResponseSchema, empty.body, "no entries")).toEqual({ entries: [] });
});

// ---- Health -----------------------------------------------------------------------------------

test("health_matches_its_schemas", async () => {
  await seedLifecycle(deps.db);

  const ok = await get(appWith(), "/v1/health");
  expect(ok.status).toBe(200);
  expect(fits(HealthResponseSchema, ok.body, "GET /v1/health")).toMatchObject({
    ok: true,
    indexed_height: "90",
    chain_final_height: "100",
    lag_blocks: "10",
  });

  // The 503 has a schema of its own, and is an error body besides.
  const client = fakeClient({
    finalHeight: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const down = await get(appWith({ client }), "/v1/health");
    expect(down.status).toBe(503);
    expect(fits(HealthUnavailableSchema, down.body, "the 503 of /v1/health")).toMatchObject({
      ok: false,
      error: "chain_unavailable",
      indexed_height: "90",
    });
    expect(ErrorBodySchema.safeParse(down.body).success).toBe(true);
  } finally {
    log.mockRestore();
  }
});

// ---- Signed in --------------------------------------------------------------------------------

test("sign_in_uploads_start_and_telegram_link_match_their_schemas", async () => {
  await seedBoard();
  const app = appWith({ telegramBotUsername: BOT });
  const token = await signIn(app, carol);

  // A brief goes in, and the same bytes come out of the URI that was handed back.
  const brief = canonicalJson({ ...FIXTURE_BRIEF, title: "Uploaded through the API" });
  const upload = await post(
    app,
    "/v1/blobs",
    { kind: "brief", content_type: "application/json", content_base64: toBase64(brief) },
    token,
  );
  expect(upload.status).toBe(200);
  const stored = fits(BlobUploadResponseSchema, upload.body, "POST /v1/blobs");
  expect(stored.sha256).toBe(sha256Hex(brief));
  expect(stored.uri).toBe(`${deps.publicUrl}/v1/blobs/${stored.sha256}`);
  const read = await app.request(`/v1/blobs/${stored.sha256}`);
  expect(read.status).toBe(200);
  expect(new Uint8Array(await read.arrayBuffer())).toEqual(brief);

  const heldout = canonicalJson({ exact: { expected: ["42"] } });
  const held = await post(
    app,
    "/v1/heldout",
    { commitment: sha256Hex(heldout), content_base64: toBase64(heldout) },
    token,
  );
  expect(held.status).toBe(200);
  expect(fits(HeldoutUploadResponseSchema, held.body, "POST /v1/heldout")).toEqual({ ok: true });

  // Task 2 is open, and alice and bob have said they are on it. Carol, who signed in, makes three.
  const started = await post(app, "/v1/tasks/2/start", undefined, token);
  expect(started.status).toBe(200);
  expect(fits(StartResponseSchema, started.body, "POST /v1/tasks/2/start")).toEqual({
    ok: true,
    working_count: 3,
  });

  const link = await post(app, "/v1/telegram/link", undefined, token);
  expect(link.status).toBe(200);
  const { url, expires_at } = fits(TelegramLinkResponseSchema, link.body, "POST /v1/telegram/link");
  expect(url).toMatch(new RegExp(`^https://t\\.me/${BOT}\\?start=`));
  expect(new Date(expires_at).getTime()).toBeGreaterThan(Date.now());
});

// ---- Events -----------------------------------------------------------------------------------

interface Frame {
  id: string;
  event: string;
  data: string;
}

/** `promise`, or a rejection after `ms` if it has not settled by then. The timer never outlives it. */
async function within<T>(ms: number, promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`gave up waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** The first `count` messages of `GET /v1/events`, from the first event stored. Then it hangs up. */
async function eventFrames(app: Hono, count: number): Promise<Frame[]> {
  const res = await app.request("/v1/events?since=0");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  if (res.body === null) throw new Error("the stream has no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let rest = "";
  try {
    while (frames.length < count) {
      const chunk = await within(5_000, reader.read(), `message ${frames.length + 1} of ${count}`);
      if (chunk.done) break;
      rest += decoder.decode(chunk.value, { stream: true });
      const parts = rest.split("\n\n");
      rest = parts.pop() ?? "";
      for (const part of parts) {
        const fields: Record<string, string> = {};
        for (const line of part.split("\n")) {
          const colon = line.indexOf(":");
          if (colon > 0) fields[line.slice(0, colon)] = line.slice(colon + 1).replace(/^ /, "");
        }
        // A comment (`: ping`) has no data, and is not a message.
        if (fields.data !== undefined) {
          frames.push({ id: fields.id ?? "", event: fields.event ?? "", data: fields.data });
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

test("event_stream_messages_match_their_schema", async () => {
  await seedBoard();
  const [stored] = await deps.db.query<{ n: number }>("select count(*)::int as n from events");
  const count = stored?.n ?? 0;
  expect(count).toBeGreaterThan(0);

  const frames = await eventFrames(appWith(), count);
  expect(frames).toHaveLength(count);

  const messages = frames.map((frame) => {
    const message = fits(EventMessageSchema, JSON.parse(frame.data), `event ${frame.id}`);
    // The frame's own `event:` line names the same event as its data.
    expect(frame.event, `event ${frame.id}`).toBe(message.event);
    // The data is the contract's event, which `TenderEventSchema` reads as it is.
    const logged = { event: message.event, data: message.data };
    expect(TenderEventSchema.parse(logged), `event ${frame.id}`).toEqual(logged);
    return message;
  });
  // An event about no task (an agent registering) and events about one are both on the stream.
  expect(messages.some((message) => message.task_id === null)).toBe(true);
  expect(messages.some((message) => message.task_id === "1")).toBe(true);
  // Every message above fits, and these are the kinds of event that this test needs on the stream,
  // so that each kind that the schemas describe is checked. The lifecycle may carry more kinds,
  // now or later, without failing the test.
  const names = new Set(messages.map((message) => message.event));
  for (const name of [
    "agent_registered",
    "task_created",
    "task_topped_up",
    "committed",
    "revealed",
    "picked",
    "voided",
  ]) {
    expect(names.has(name), `the stream carries ${name}`).toBe(true);
  }
});

// ---- Errors -----------------------------------------------------------------------------------

test("error_bodies_match_the_error_body_schema", async () => {
  await seedBoard();
  const app = appWith();
  const token = await signIn(app);

  failsWith(await get(app, "/v1/tasks/999"), 404, "not_found", "an unknown task");
  failsWith(await get(app, "/v1/agents/nobody.test.near"), 404, "not_found", "an unknown agent");
  failsWith(await get(app, "/v1/nothing"), 404, "not_found", "an unknown route");
  failsWith(await get(app, `/v1/blobs/${sha256Hex("nothing")}`), 404, "not_found", "no such blob");
  failsWith(await get(app, "/v1/tasks?limit=0"), 400, "bad_request", "a bad query");
  failsWith(await get(app, "/v1/entries"), 400, "bad_request", "a missing account");

  // A request body that does not fit its schema lists the faults.
  const bad = failsWith(
    await post(app, "/v1/blobs", { kind: "nothing" }, token),
    400,
    "bad_request",
    "a bad upload",
  );
  expect(bad.issues?.length).toBeGreaterThan(0);
  for (const issue of bad.issues ?? []) {
    expect(issue.path.length).toBeGreaterThan(0);
  }

  // Signing in: no token, and a challenge nobody issued.
  failsWith(await post(app, "/v1/blobs", {}), 401, "unauthorized", "no bearer token");
  const refused = await post(app, "/v1/auth/verify", {
    account_id: alice,
    public_key: "ed25519:11111111111111111111111111111111",
    signature: "",
    nonce: "not-a-challenge",
    message: "Sign in to Tender",
    recipient: "api.test",
  });
  failsWith(refused, 401, "bad_nonce", "a sign-in that is refused");

  // A task past its commit window cannot be started, and a Telegram link needs a bot.
  const settled = failsWith(
    await post(app, "/v1/tasks/1/start", undefined, token),
    409,
    "not_open",
    "a settled task",
  );
  expect(settled.message).toContain("settled");
  failsWith(await post(app, "/v1/telegram/link", undefined, token), 503, "unavailable", "no bot");

  // And the stream turns clients away with the same body when it is full.
  failsWith(await get(appWith({ maxSseStreams: 0 }), "/v1/events"), 503, "unavailable", "full");
});

// ---- Types ------------------------------------------------------------------------------------

// The routes send the types of `src/format.ts` and of the route modules, and the clients read the
// same responses as the types of the schemas in `@tender/shared`. Each pair below has to be the
// same type: each side fits the other, and both have the same keys, since a key that only one side
// has, and that is optional there, would fit either way. These assertions do nothing when the tests
// run. `pnpm typecheck` checks them, in this package's own tsconfig (it includes `test`), and
// fails here when either side drifts. (The 503 body of `GET /v1/health` has no API type: the route
// builds it in place. It is held to its route by the tests above.)

/** `true` if `A` and `B` fit each other and have the same keys, and otherwise what is wrong. */
type Pair<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? [keyof A] extends [keyof B]
      ? [keyof B] extends [keyof A]
        ? true
        : "a key only the schema's type has"
      : "a key only the API's type has"
    : "the schema's type does not fit the API's"
  : "the API's type does not fit the schema's";

/**
 * The schemas are wider than the API's types in one place, on purpose: `by_source` is any string
 * there, so that a source added later does not fail a client that predates it, and the API's type
 * says "reconcile", the only source there is. `Replace` gives a schema's type with that one key
 * narrowed, so that all the rest of an outcome is still held to the API's type both ways. It
 * never adds a key, so a schema that has lost one shows as a key only the API's type has. That
 * the API's type fits the schema as it is follows, since a narrower type fits a wider one.
 */
type Replace<T, Over> = { [K in keyof T]: K extends keyof Over ? Over[K] : T[K] };
type SchemaOutcome = Replace<Shared.TaskOutcome, { by_source: "reconcile" | undefined }>;
type SchemaTaskDetail = Replace<Shared.TaskDetail, { outcome: SchemaOutcome | null }>;
type SchemaTaskDetailResponse = Replace<Shared.TaskDetailResponse, { task: SchemaTaskDetail }>;

/** One kind of outcome. Each has optional keys of its own, which the union's `keyof` hides. */
type Kind<T, K extends string> = Extract<T, { kind: K }>;

test("api_types_and_schema_types_are_the_same_type_both_ways", () => {
  // `src/format.ts`.
  expectTypeOf<Pair<Api.HealthResponse, Shared.HealthResponse>>().toEqualTypeOf<true>();
  expectTypeOf<Pair<Api.TaskSummary, Shared.TaskSummary>>().toEqualTypeOf<true>();
  expectTypeOf<Pair<Api.TaskEntry, Shared.TaskEntry>>().toEqualTypeOf<true>();
  expectTypeOf<Pair<Api.TaskFunder, Shared.TaskFunder>>().toEqualTypeOf<true>();
  expectTypeOf<Pair<Api.ListTasksResponse, Shared.ListTasksResponse>>().toEqualTypeOf<true>();
  expectTypeOf<Pair<Api.AgentSummary, Shared.AgentSummary>>().toEqualTypeOf<true>();
  expectTypeOf<Pair<Api.ListAgentsResponse, Shared.ListAgentsResponse>>().toEqualTypeOf<true>();
  expectTypeOf<Pair<Api.AgentRecentEntry, Shared.AgentRecentEntry>>().toEqualTypeOf<true>();
  expectTypeOf<Pair<Api.AgentDetailResponse, Shared.AgentDetailResponse>>().toEqualTypeOf<true>();
  expectTypeOf<Pair<Api.AccountEntry, Shared.AccountEntry>>().toEqualTypeOf<true>();
  expectTypeOf<
    Pair<Api.AccountEntriesResponse, Shared.AccountEntriesResponse>
  >().toEqualTypeOf<true>();
  expectTypeOf<Pair<Api.BlobUploadResponse, Shared.BlobUploadResponse>>().toEqualTypeOf<true>();
  expectTypeOf<
    Pair<Api.HeldoutUploadResponse, Shared.HeldoutUploadResponse>
  >().toEqualTypeOf<true>();
  expectTypeOf<Pair<Api.ErrorIssue, Shared.ErrorIssue>>().toEqualTypeOf<true>();
  expectTypeOf<Pair<Api.ErrorBody, Shared.ErrorBody>>().toEqualTypeOf<true>();

  // The types that hold an outcome, with `by_source` narrowed (see `Replace`).
  expectTypeOf<Pair<Api.TaskOutcome, SchemaOutcome>>().toEqualTypeOf<true>();
  expectTypeOf<
    Pair<Kind<Api.TaskOutcome, "picked">, Kind<SchemaOutcome, "picked">>
  >().toEqualTypeOf<true>();
  expectTypeOf<
    Pair<Kind<Api.TaskOutcome, "voided">, Kind<SchemaOutcome, "voided">>
  >().toEqualTypeOf<true>();
  expectTypeOf<Pair<Api.TaskDetail, SchemaTaskDetail>>().toEqualTypeOf<true>();
  expectTypeOf<Pair<Api.TaskDetailResponse, SchemaTaskDetailResponse>>().toEqualTypeOf<true>();

  // The route modules.
  expectTypeOf<Pair<ChallengeResponse, Shared.ChallengeResponse>>().toEqualTypeOf<true>();
  expectTypeOf<Pair<SignInResponse, Shared.SignInResponse>>().toEqualTypeOf<true>();
  expectTypeOf<Pair<StartResponse, Shared.StartResponse>>().toEqualTypeOf<true>();
  expectTypeOf<Pair<TelegramLinkResponse, Shared.TelegramLinkResponse>>().toEqualTypeOf<true>();
  expectTypeOf<Pair<EventMessage, Shared.EventMessage>>().toEqualTypeOf<true>();
});
