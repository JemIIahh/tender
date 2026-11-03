import { Buffer } from "node:buffer";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Db,
  getBlob,
  hasHeldoutUpload,
  hasResultUpload,
  migrate,
  openDb,
  putBlob,
  recordResultUpload,
  setBlobPublic,
} from "@tender/db";
import { applyBlock } from "@tender/indexer";
import {
  BOB_ENTRY,
  blockOf,
  eventLine,
  FIXTURE_ACCOUNTS,
  FIXTURE_BRIEF,
  FIXTURE_BRIEF_HASH,
  FIXTURE_OPTIONS,
  FIXTURE_PROFILE,
  FIXTURE_PROFILE_HASH,
  fixtureData,
} from "@tender/indexer/testing";
import { intakeTask, type JudgeDeps } from "@tender/judge";
import { canonicalJson, type PublicCriteria, type Scorecard, sha256Hex } from "@tender/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import type { AuthVariables, RequireAuth } from "../src/auth";
import { handleError, readJson } from "../src/format";
import {
  type AgentDetailResponse,
  type ApiDeps,
  createApp,
  type ErrorBody,
  resultUsable,
  type TaskDetailResponse,
} from "../src/index";
import { publicDocument } from "../src/queries";
import { blobRoutes } from "../src/routes/blobs";
import { resetDb, seedLifecycle, TEST_NOW, testDeps } from "./helpers";

// The blob store and the held-out intake. The upload routes are mounted on an app of their own
// with `stubAuth`, which reads the signed-in account from a header, so these tests do not sign in;
// sign-in has `auth.test.ts`, and `uploads_are_refused_without_sign_in` holds `createApp` to
// refusing a request without a bearer token. The two GET routes need no sign-in and are also read
// through `createApp`.
//
// The data is the lifecycle of `@tender/indexer/testing`: task 1 has the poster, the judge as its
// verifier, and alice and bob as entrants. Its reveal deadline is `REVEAL_DEADLINE`, and the clock
// is a variable, so a test can move it across the deadline. The judge is also the team's Judge
// (`deps.judgeAccount`), the one account that may publish a scorecard under the Judge's name; any
// other account publishes one of its own (`scorecardBy`).

const { poster, judge, alice, bob, carol } = FIXTURE_ACCOUNTS;
const SECOND = 1_000_000_000n;
/** The reveal deadline of the captured task, which is task 1 here. */
const REVEAL_DEADLINE = 1_793_307_409_820_229_000n;
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const LIMIT = 262_144;

let deps: ApiDeps;
let nowNs = TEST_NOW;
let nextHeight = 100n;

beforeAll(async () => {
  deps = await testDeps({ now: () => nowNs, judgeAccount: judge });
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

/** The blob routes alone, under `/v1`, with the API's error handler. */
function appWith(over: Partial<ApiDeps> = {}): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError(handleError);
  app.route("/v1", blobRoutes({ ...deps, ...over }, stubAuth));
  return app;
}

/** An app to send requests to: the blob routes alone, or the whole API. */
interface App {
  request: (path: string, init?: RequestInit) => Response | Promise<Response>;
}

interface Reply<T> {
  status: number;
  body: T;
  headers: Headers;
}

interface Stored {
  sha256: string;
  uri: string;
}

/** Posts `body` (JSON text is sent as it is) as `account`, or signed out. */
async function post<T = Stored>(
  path: string,
  body: unknown,
  account?: string,
  app: App = appWith(),
): Promise<Reply<T>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (account !== undefined) headers["x-test-account"] = account;
  const res = await app.request(path, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T, headers: res.headers };
}

/** The bytes a GET answers with, or the JSON error it answers with. */
async function get(path: string, app: App = appWith()) {
  const res = await app.request(path);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    bytes,
    headers: res.headers,
    text: () => new TextDecoder().decode(bytes),
  };
}

// ---- Data -------------------------------------------------------------------------------------

type UploadKind = "brief" | "criteria" | "result" | "scorecard" | "profile";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const utf8 = (text: string) => new TextEncoder().encode(text);

/** The body of `POST /v1/blobs`: JSON by default, `over` replaces any field. */
function blobBody(kind: UploadKind, bytes: Uint8Array, over: Record<string, unknown> = {}) {
  return { kind, content_type: "application/json", content_base64: b64(bytes), ...over };
}

/** The body that uploads `text` as a result of `taskId`. */
function resultBody(text: string | Uint8Array, taskId: string | undefined, over = {}) {
  const bytes = typeof text === "string" ? utf8(text) : text;
  return blobBody("result", bytes, { content_type: "text/plain", task_id: taskId, ...over });
}

const CRITERIA: PublicCriteria = {
  kind: "exact",
  version: 1,
  min_score: 60,
  split: "winner_take_all",
  has_heldout: true,
  normalize: ["trim"],
};

/** The winners of the captured `picked` event, as a scorecard names them: account and share. */
const PICKED_WINNERS = fixtureData("picked").winners.map(({ account, bps }) => ({ account, bps }));

const HELDOUT = { exact: { expected: ["42"] } };
const HELDOUT_BYTES = canonicalJson(HELDOUT);
const HELDOUT_HASH = sha256Hex(HELDOUT_BYTES);

function scorecardOf(taskId: string, over: Partial<Scorecard> = {}): Scorecard {
  return {
    version: 1,
    task_id: taskId,
    verifier: judge,
    kind: "exact",
    criteria_hash: sha256Hex("criteria"),
    heldout_commitment: null,
    heldout: null,
    tie_break: "score desc, committed_at_block asc, account asc",
    entries: [],
    winners: [],
    generated_at: "2026-10-30T10:00:00Z",
    judge: { software: "tender-judge/1", model: null },
    ...over,
  };
}

/**
 * The scorecard of `taskId` as `account` writes it: from the Judge it is `scorecardOf` as it is,
 * and from any other account it names that account as the verifier and some software of its own,
 * since only the Judge may publish under the Judge's name. `over` replaces any field.
 */
function scorecardBy(account: string, taskId: string, over: Partial<Scorecard> = {}): Scorecard {
  if (account === judge) return scorecardOf(taskId, over);
  return scorecardOf(taskId, {
    verifier: account,
    judge: { software: "poster-script/1", model: null },
    ...over,
  });
}

/** A `task_created` line for task `id`: the captured one, with the given fields replaced. */
function taskLine(id: number, over: Record<string, string> = {}): string {
  return eventLine("task_created", { id: String(id), ...over });
}

/**
 * Creates task `id`, whose reveals close at `deadline`, and has each of `entrants` commit to it.
 * `over` replaces fields of the captured task, such as its `heldout_commitment`.
 */
async function openTask(
  id: number,
  deadline: bigint,
  entrants: string[],
  over: Record<string, string> = {},
): Promise<void> {
  await apply(
    taskLine(id, {
      reveal_deadline: deadline.toString(),
      pick_deadline: (deadline + 60n * SECOND).toString(),
      fallback_deadline: (deadline + 120n * SECOND).toString(),
      ...over,
    }),
    ...entrants.map((account) =>
      eventLine("committed", { task_id: String(id), account, block_height: "130" }),
    ),
  );
}

/** The log line of `account` revealing `content` in task `id`, as the chain logs it. */
function revealLine(id: number, account: string, content: string): string {
  const contentHash = sha256Hex(content);
  return eventLine("revealed", {
    task_id: String(id),
    account,
    content_hash: contentHash,
    uri: `http://api.test/v1/blobs/${contentHash}`,
  });
}

/** Has `account` reveal `content` in task `id`, in a block of its own, and returns its hash. */
async function reveal(id: number, account: string, content: string): Promise<string> {
  await apply(revealLine(id, account, content));
  return sha256Hex(content);
}

interface Row {
  kind: string;
  content_type: string;
  task_id: string | null;
  uploader: string | null;
  is_public: boolean;
}

/** What the blobs table holds under `sha256`, or null. */
async function rowOf(sha256: string): Promise<Row | null> {
  const [row] = await deps.db.query<Row>(
    "select kind, content_type, task_id::text as task_id, uploader, is_public from blobs where sha256 = $1",
    [sha256],
  );
  return row ?? null;
}

async function blobCount(): Promise<number> {
  const [row] = await deps.db.query<{ n: number }>("select count(*)::int as n from blobs");
  return row?.n ?? 0;
}

/** Seeds the lifecycle, which stores a brief and a profile of its own, and counts what it stored. */
async function seed(): Promise<number> {
  await seedLifecycle(deps.db);
  return blobCount();
}

const NAMES_UPLOADER = {
  error: "forbidden",
  message: "a scorecard must name its uploader as verifier",
};
const JUDGE_ONLY = {
  error: "forbidden",
  message: "only the team's Judge may publish Judge scorecards",
};

/**
 * Uploads `document` as a scorecard from `account` and expects the 403 `expected`, with nothing
 * kept of it: the blobs, the row under its hash and the records of uploads are as they were.
 */
async function expectScorecardRefused(
  document: Scorecard,
  account: string,
  expected: ErrorBody,
  app?: App,
): Promise<void> {
  const bytes = canonicalJson(document);
  const hash = sha256Hex(bytes);
  const blobs = await blobCount();
  const row = await rowOf(hash);
  const res = await post<ErrorBody>("/v1/blobs", blobBody("scorecard", bytes), account, app);
  expect([res.status, res.body], account).toEqual([403, expected]);
  expect(await blobCount(), account).toBe(blobs);
  expect(await rowOf(hash), account).toEqual(row);
  expect(await uploadCount(), account).toBe(0);
}

const NOT_FOUND = { error: "not_found", message: expect.any(String) };

/** What a result that is a document of another kind is refused with. */
const ANOTHER_KIND: ErrorBody = {
  error: "bad_request",
  message:
    "these bytes are a canonical brief, criteria, held-out, profile or scorecard document: upload it as that kind, or end your answer with a newline",
};

/** The canonical bytes of a brief titled `title`: one size for every title of the same length. */
const briefOf = (title: string) => canonicalJson({ ...FIXTURE_BRIEF, title });

/** The accounts recorded as having sent the held-out document under `sha256`. */
async function heldoutUploadersOf(sha256: string): Promise<string[]> {
  const rows = await deps.db.query<{ account: string }>(
    "select account from heldout_uploads where sha256 = $1 order by account",
    [sha256],
  );
  return rows.map((row) => row.account);
}

// ---- The brief's tests ------------------------------------------------------------------------

// A result is served by what was revealed, not by who sent it: from the reveal deadline of the task
// that revealed the hash first, among the reveals whose account also uploaded the bytes for that
// task. A reveal of the same hash in another task, later, changes nothing, and neither does the
// task a result was sent for. A reveal with no upload behind it counts for nothing (the tests of
// the upload records, at the end).

test("result_hidden_until_reveal_deadline", async () => {
  await seedLifecycle(deps.db);
  // Carol enters task 2 and sends her result before she reveals it, as an entrant does.
  await openTask(2, REVEAL_DEADLINE, [carol]);
  const put = await post("/v1/blobs", resultBody("the answer is 42", "2"), carol);
  expect(put.status).toBe(200);
  const path = `/v1/blobs/${put.body.sha256}`;

  // Sent but not revealed, nobody reads it, whatever the time: the deadline of the task included.
  for (const at of [TEST_NOW, REVEAL_DEADLINE, REVEAL_DEADLINE + 3600n * SECOND]) {
    nowNs = at;
    const hidden = await get(path);
    expect(hidden.status, `unrevealed at ${at}`).toBe(404);
    expect(JSON.parse(hidden.text())).toMatchObject(NOT_FOUND);
    expect(hidden.headers.get("cache-control")).toBe("no-store");
  }

  // Revealed, it waits for the reveals of the task to close, the uploader included.
  expect(await reveal(2, carol, "the answer is 42")).toBe(put.body.sha256);
  for (const at of [TEST_NOW, REVEAL_DEADLINE - SECOND, REVEAL_DEADLINE - 1n]) {
    nowNs = at;
    const hidden = await get(path);
    expect(hidden.status, `revealed at ${at}`).toBe(404);
    expect(hidden.headers.get("cache-control")).toBe("no-store");
  }

  // At the deadline the next phase has begun, as in the contract: `now >= reveal_deadline`.
  for (const at of [REVEAL_DEADLINE, REVEAL_DEADLINE + 1n, REVEAL_DEADLINE + 3600n * SECOND]) {
    nowNs = at;
    const shown = await get(path);
    expect(shown.status, `at ${at}`).toBe(200);
    expect(shown.text()).toBe("the answer is 42");
  }
});

test("uploaded_but_unrevealed_result_is_never_served", async () => {
  await seedLifecycle(deps.db);
  // Long after every deadline there is: sending a result does not make it readable, a reveal does.
  nowNs = REVEAL_DEADLINE + 1_000_000n * SECOND;
  // Alice has an entry on task 1, so she may send a result for it, but she revealed other bytes.
  const sent = await post("/v1/blobs", resultBody("early", "1"), alice);
  expect(sent.status).toBe(200);
  // Making the row public changes nothing: for a result, a reveal is the only rule.
  await setBlobPublic(deps.db, sent.body.sha256, true);
  // Rows put in directly: a result with no task, and one for a task the index does not know.
  const noTask = await putBlob(deps.db, {
    kind: "result",
    contentType: "text/plain",
    bytes: utf8("no task"),
    isPublic: false,
  });
  const lostTask = await putBlob(deps.db, {
    kind: "result",
    contentType: "text/plain",
    bytes: utf8("lost task"),
    taskId: 999n,
    isPublic: false,
  });
  // An entry that is only committed has revealed nothing.
  await openTask(2, REVEAL_DEADLINE, [carol]);
  const committed = await post("/v1/blobs", resultBody("committed only", "2"), carol);
  expect(committed.status).toBe(200);

  for (const sha256 of [sent.body.sha256, noTask, lostTask, committed.body.sha256]) {
    const res = await get(`/v1/blobs/${sha256}`);
    expect(res.status, sha256).toBe(404);
    expect(res.headers.get("cache-control"), sha256).toBe("no-store");
  }
});

test("revealed_result_is_served_after_its_tasks_deadline", async () => {
  await seedLifecycle(deps.db);
  // Bob revealed "bob work" in task 1, so the index has its hash. The bytes can be sent after that.
  const put = await post("/v1/blobs", resultBody("bob work", "1"), bob);
  expect(put.body.sha256).toBe(BOB_ENTRY.contentHash);
  const path = `/v1/blobs/${put.body.sha256}`;

  for (const at of [TEST_NOW, REVEAL_DEADLINE - SECOND, REVEAL_DEADLINE - 1n]) {
    nowNs = at;
    const hidden = await get(path);
    expect(hidden.status, `at ${at}`).toBe(404);
    expect(hidden.headers.get("cache-control")).toBe("no-store");
  }
  for (const at of [REVEAL_DEADLINE, REVEAL_DEADLINE + 1n, REVEAL_DEADLINE + 3600n * SECOND]) {
    nowNs = at;
    const shown = await get(path);
    expect(shown.status, `at ${at}`).toBe(200);
    expect(shown.text()).toBe("bob work");
  }

  // The deadline that counts is the one of the task that revealed the bytes. Alice sent them for
  // task 1, which has closed by now, but carol revealed them in task 3, which closes later, and sent
  // them for it too.
  const soon = REVEAL_DEADLINE + 500n * SECOND;
  await openTask(3, soon, [carol]);
  await reveal(3, carol, "carol work");
  const early = await post("/v1/blobs", resultBody("carol work", "1"), alice);
  expect((await post("/v1/blobs", resultBody("carol work", "3"), carol)).body).toEqual(early.body);
  for (const [at, status] of [
    [REVEAL_DEADLINE + SECOND, 404],
    [soon - 1n, 404],
    [soon, 200],
  ] as const) {
    nowNs = at;
    expect((await get(`/v1/blobs/${early.body.sha256}`)).status, `at ${at}`).toBe(status);
  }
});

test("a_far_future_upload_cannot_delay_a_revealed_result", async () => {
  await seedLifecycle(deps.db);
  // Task 2 closes its reveals long after task 1, and task 3 a little after it. Carol entered task 2
  // and alice entered task 3.
  const far = REVEAL_DEADLINE + 1_000_000n * SECOND;
  const soon = REVEAL_DEADLINE + 500n * SECOND;
  await openTask(2, far, [carol]);
  await openTask(3, soon, [alice]);

  // Bob revealed "bob work" in task 1, and carol sends the same bytes for her task, which closes
  // much later. It is still served when task 1 closes.
  const first = await post("/v1/blobs", resultBody("bob work", "1"), bob);
  const second = await post("/v1/blobs", resultBody("bob work", "2"), carol);
  expect(second.body).toEqual(first.body);
  expect(await rowOf(first.body.sha256)).toMatchObject({ task_id: "1", uploader: bob });
  nowNs = REVEAL_DEADLINE - 1n;
  expect((await get(`/v1/blobs/${first.body.sha256}`)).status).toBe(404);
  nowNs = REVEAL_DEADLINE;
  expect((await get(`/v1/blobs/${first.body.sha256}`)).status).toBe(200);

  // Carol can send them before they are revealed too. The row keeps the task it was first sent for,
  // which is for information only, and the bytes are served when the task that revealed them closes.
  const guess = "a guessable answer";
  const stored = await post("/v1/blobs", resultBody(guess, "2"), carol);
  await reveal(3, alice, guess);
  const mine = await post("/v1/blobs", resultBody(guess, "3"), alice);
  expect(mine.body).toEqual(stored.body);
  expect(await rowOf(stored.body.sha256)).toMatchObject({ task_id: "2", uploader: carol });
  nowNs = soon - 1n;
  expect((await get(`/v1/blobs/${stored.body.sha256}`)).status).toBe(404);
  nowNs = soon;
  expect((await get(`/v1/blobs/${stored.body.sha256}`)).status).toBe(200);
});

test("a_copy_reveal_in_a_faster_task_cannot_publish_early", async () => {
  await seedLifecycle(deps.db);
  // Task 2 closes its reveals at `slow`. Task 3 closes them at `fast`, before it, and has no entry
  // yet: its commit window is open. Carol enters task 2.
  const slow = REVEAL_DEADLINE + 1_000n * SECOND;
  const fast = REVEAL_DEADLINE + 500n * SECOND;
  await openTask(2, slow, [carol]);
  await openTask(3, fast, []);

  // Carol reveals in task 2, which puts the hash of her answer on chain for anyone to read. Alice
  // commits to that hash in task 3, with a salt of her own, and reveals it there. The contract
  // checks the commitment and not the bytes, so the reveal is good, and her task closes first.
  const hash = await reveal(2, carol, "the answer is 42");
  await apply(eventLine("committed", { task_id: "3", account: alice, block_height: "140" }));
  expect(await reveal(3, alice, "the answer is 42")).toBe(hash);
  const put = await post("/v1/blobs", resultBody("the answer is 42", "2"), carol);
  expect(put.body.sha256).toBe(hash);
  const path = `/v1/blobs/${hash}`;

  // The bytes wait for the task that revealed the hash first, not for task 3, whose deadline passes
  // with nothing served.
  for (const at of [TEST_NOW, fast - 1n, fast, fast + 1n, slow - 1n]) {
    nowNs = at;
    const hidden = await get(path);
    expect(hidden.status, `at ${at}`).toBe(404);
    expect(JSON.parse(hidden.text())).toMatchObject(NOT_FOUND);
    expect(hidden.headers.get("cache-control"), `at ${at}`).toBe("no-store");
  }
  for (const at of [slow, slow + 1n, slow + 3600n * SECOND]) {
    nowNs = at;
    const shown = await get(path);
    expect(shown.status, `at ${at}`).toBe(200);
    expect(shown.text()).toBe("the answer is 42");
  }
});

test("a_copy_reveal_in_a_slower_task_cannot_delay_it", async () => {
  await seedLifecycle(deps.db);
  // Task 3 closes its reveals at `soon` and task 2, which has the lower id, at `far`. Alice reveals
  // in task 3 first, and carol reveals the same hash in task 2 after her.
  const far = REVEAL_DEADLINE + 1_000_000n * SECOND;
  const soon = REVEAL_DEADLINE + 500n * SECOND;
  await openTask(2, far, [carol]);
  await openTask(3, soon, [alice]);
  const hash = await reveal(3, alice, "first answer");
  expect(await reveal(2, carol, "first answer")).toBe(hash);
  expect((await post("/v1/blobs", resultBody("first answer", "3"), alice)).body.sha256).toBe(hash);
  const path = `/v1/blobs/${hash}`;

  // It is the first reveal that counts, not the lowest task id and not the latest deadline.
  nowNs = soon - 1n;
  expect((await get(path)).status).toBe(404);
  for (const at of [soon, soon + SECOND, far - 1n, far]) {
    nowNs = at;
    const shown = await get(path);
    expect(shown.status, `at ${at}`).toBe(200);
    expect(shown.text()).toBe("first answer");
  }
});

test("the_first_reveal_is_the_earliest_by_height_even_if_applied_late", async () => {
  await seedLifecycle(deps.db);
  // As in a_copy_reveal_in_a_faster_task_cannot_publish_early, task 2 closes late and task 3 early.
  const slow = REVEAL_DEADLINE + 1_000n * SECOND;
  const fast = REVEAL_DEADLINE + 500n * SECOND;
  await openTask(2, slow, [carol]);
  await openTask(3, fast, [alice]);

  // Carol revealed in task 2 at height 200, and alice revealed the same hash in task 3 at height
  // 300. The index applies the block of height 300 first, as it would if the block of height 200
  // had been missing and were filled in afterwards. The reveal that is earlier on chain is the one
  // with the higher id.
  nextHeight = 300n;
  const hash = await reveal(3, alice, "the answer is 42");
  nextHeight = 200n;
  expect(await reveal(2, carol, "the answer is 42")).toBe(hash);
  const stored = await deps.db.query<{ task_id: string; height: string }>(
    `select task_id::text as task_id, height::text as height
       from events
      where event = 'revealed' and data->>'content_hash' = $1
      order by id`,
    [hash],
  );
  expect(stored).toEqual([
    { task_id: "3", height: "300" },
    { task_id: "2", height: "200" },
  ]);

  // Both sent the bytes for their task, so both reveals count and the order is what decides.
  const put = await post("/v1/blobs", resultBody("the answer is 42", "2"), carol);
  expect(put.body.sha256).toBe(hash);
  expect((await post("/v1/blobs", resultBody("the answer is 42", "3"), alice)).body).toEqual(
    put.body,
  );
  const path = `/v1/blobs/${hash}`;

  // The first reveal is the one at the lower height, so the bytes wait for task 2, not for task 3.
  for (const at of [TEST_NOW, fast - 1n, fast, fast + 1n, slow - 1n]) {
    nowNs = at;
    const hidden = await get(path);
    expect(hidden.status, `at ${at}`).toBe(404);
    expect(hidden.headers.get("cache-control"), `at ${at}`).toBe("no-store");
  }
  nowNs = slow;
  const shown = await get(path);
  expect(shown.status).toBe(200);
  expect(shown.text()).toBe("the answer is 42");
});

test("upload_too_large_413", async () => {
  const base = await seed();
  const exactly = await post("/v1/blobs", resultBody(new Uint8Array(LIMIT).fill(0x61), "1"), alice);
  expect(exactly.status).toBe(200);

  const over = new Uint8Array(LIMIT + 1).fill(0x61);
  const res = await post<ErrorBody>("/v1/blobs", resultBody(over, "1"), alice);
  expect(res.status).toBe(413);
  expect(res.body).toEqual({
    error: "payload_too_large",
    message: `content is over ${LIMIT} bytes`,
  });
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(await blobCount()).toBe(base + 1);

  // The limit counts decoded bytes, for every kind.
  const document = { ...FIXTURE_BRIEF, instructions: "x".repeat(LIMIT) };
  const brief = await post<ErrorBody>(
    "/v1/blobs",
    blobBody("brief", canonicalJson(document)),
    alice,
  );
  expect(brief.status).toBe(413);
  const heldout = await post<ErrorBody>(
    "/v1/heldout",
    { commitment: sha256Hex(over), content_base64: b64(over) },
    poster,
  );
  expect(heldout.status).toBe(413);
  expect(heldout.body.error).toBe("payload_too_large");
});

test("brief_must_match_schema_400", async () => {
  const bad = { ...FIXTURE_BRIEF, title: "", tags: ["UPPER"] };
  const res = await post<ErrorBody>("/v1/blobs", blobBody("brief", canonicalJson(bad)), alice);
  expect(res.status).toBe(400);
  expect(res.body.error).toBe("bad_request");
  expect(res.body.message).toEqual(expect.any(String));
  // The zod issues, as { path, message, code }.
  expect(res.body.issues).toEqual(
    expect.arrayContaining([
      { path: ["title"], message: expect.any(String), code: "too_small" },
      { path: ["tags", 0], message: expect.any(String), code: "invalid_format" },
    ]),
  );
  for (const issue of res.body.issues ?? []) {
    expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
  }

  // The schemas are strict, and the name of a key that is not theirs is not sent back.
  const strict = { ...FIXTURE_BRIEF, attachements: [] };
  const stray = await post<ErrorBody>("/v1/blobs", blobBody("brief", canonicalJson(strict)), alice);
  expect(stray.status).toBe(400);
  expect(stray.body.issues?.map((issue) => issue.code)).toEqual(["unrecognized_keys"]);
  expect(JSON.stringify(stray.body)).not.toContain("attachements");

  // Every JSON kind has its own schema.
  const documents: Array<[UploadKind, unknown]> = [
    ["brief", CRITERIA],
    ["criteria", FIXTURE_BRIEF],
    ["profile", FIXTURE_BRIEF],
    ["profile", { ...FIXTURE_PROFILE, homepage: "javascript:alert(1)" }],
    ["scorecard", FIXTURE_PROFILE],
    ["scorecard", {}],
  ];
  for (const [kind, document] of documents) {
    const wrong = await post<ErrorBody>(
      "/v1/blobs",
      blobBody(kind, canonicalJson(document)),
      alice,
    );
    expect(wrong.status, kind).toBe(400);
    expect(wrong.body.issues?.length, kind).toBeGreaterThan(0);
  }

  // A document with a great many faults answers with the first 20.
  const many = { ...FIXTURE_BRIEF, attachments: Array.from({ length: 30 }, () => ({})) };
  const cut = await post<ErrorBody>("/v1/blobs", blobBody("brief", canonicalJson(many)), alice);
  expect(cut.status).toBe(400);
  expect(cut.body.issues).toHaveLength(20);

  expect(await blobCount()).toBe(0);
});

test("result_upload_requires_entry_403", async () => {
  const base = await seed();
  await apply(taskLine(2));
  const forTask = (taskId: string) => resultBody("an answer", taskId);

  // Alice and bob entered task 1; nobody else did, whatever else they are.
  for (const account of [carol, poster, judge]) {
    const refused = await post<ErrorBody>("/v1/blobs", forTask("1"), account);
    expect(refused.status, account).toBe(403);
    expect(refused.body.error).toBe("forbidden");
    // The index can be behind the chain: a commit made a moment ago may not be in it yet.
    expect(refused.body.message).toContain("indexer");
  }
  // An entry on one task is no entry on another.
  expect((await post("/v1/blobs", forTask("2"), alice)).status).toBe(403);
  expect(await blobCount()).toBe(base);

  // The commit is indexed, and the same upload is accepted.
  await apply(eventLine("committed", { task_id: "2", account: carol, block_height: "130" }));
  expect((await post("/v1/blobs", forTask("2"), carol)).status).toBe(200);
  expect((await post("/v1/blobs", forTask("1"), alice)).status).toBe(200);
  expect((await post("/v1/blobs", forTask("1"), bob)).status).toBe(200);

  // A result needs its task, and the task has to exist.
  const missing = await post<ErrorBody>("/v1/blobs", forTask("77"), alice);
  expect(missing.status).toBe(404);
  expect(missing.body.error).toBe("not_found");
  expect((await post("/v1/blobs", resultBody("an answer", undefined), alice)).status).toBe(400);
  expect((await post("/v1/blobs", forTask("one"), alice)).status).toBe(400);
});

test("scorecard_upload_only_by_verifier_or_poster", async () => {
  const base = await seed();
  // The reveal window of task 1 has closed, which a scorecard waits for
  // (scorecard_upload_waits_for_the_reveal_deadline).
  nowNs = REVEAL_DEADLINE;
  const upload = (document: Scorecard, over = {}) =>
    blobBody("scorecard", canonicalJson(document), over);

  // The verifier and the poster of task 1 may publish its scorecard, each under its own name.
  const byVerifier = await post("/v1/blobs", upload(scorecardOf("1")), judge);
  expect(byVerifier.status).toBe(200);
  const byPoster = await post(
    "/v1/blobs",
    upload(scorecardBy(poster, "1", { generated_at: "2026-10-30T11:00:00Z" })),
    poster,
  );
  expect(byPoster.status).toBe(200);
  expect(byPoster.body.sha256).not.toBe(byVerifier.body.sha256);

  // Nobody else may, the entrants included, though each names itself as a verifier would.
  for (const account of [alice, bob, carol]) {
    const refused = await post<ErrorBody>(
      "/v1/blobs",
      upload(scorecardBy(account, "1", { generated_at: "2026-10-30T12:00:00Z" })),
      account,
    );
    expect(refused.status, account).toBe(403);
    expect(refused.body, account).toEqual({
      error: "forbidden",
      message: "only the verifier or the poster of the task may upload its scorecard",
    });
  }
  expect(await blobCount()).toBe(base + 2);

  // The task is the document's own: a body that names another one is wrong, and one that names
  // the same is fine. A document for a task the index does not know is not stored.
  const named = await post<ErrorBody>(
    "/v1/blobs",
    upload(scorecardOf("1"), { task_id: "2" }),
    judge,
  );
  expect(named.status).toBe(400);
  expect((await post("/v1/blobs", upload(scorecardOf("1"), { task_id: "1" }), judge)).status).toBe(
    200,
  );
  const unknown = await post<ErrorBody>("/v1/blobs", upload(scorecardOf("77")), judge);
  expect(unknown.status).toBe(404);
  expect(await blobCount()).toBe(base + 2);

  // The row says whose it is and what it is for. A scorecard is public once published.
  expect(await rowOf(byVerifier.body.sha256)).toEqual({
    kind: "scorecard",
    content_type: "application/json",
    task_id: "1",
    uploader: judge,
    is_public: true,
  });
});

test("scorecard_upload_waits_for_the_reveal_deadline", async () => {
  const base = await seed();
  const tooEarly = { error: "too_early", message: "the task's reveal window has not closed" };
  const upload = (document: Scorecard) => blobBody("scorecard", canonicalJson(document));
  // Task 2 closes its reveals a minute after task 1, and has the same verifier and poster, but not
  // the same held-out document, which would make task 1 wait for it
  // (scorecard_waits_for_every_task_sharing_its_heldout).
  const later = REVEAL_DEADLINE + 60n * SECOND;
  await openTask(2, later, [alice], { heldout_commitment: sha256Hex("the held-out of task 2") });

  // A nanosecond before the deadline of its task, the verifier and the poster are both told to
  // wait, and nothing is stored.
  nowNs = REVEAL_DEADLINE - 1n;
  for (const account of [judge, poster]) {
    const early = await post<ErrorBody>("/v1/blobs", upload(scorecardBy(account, "1")), account);
    expect(early.status, account).toBe(409);
    expect(early.body, account).toEqual(tooEarly);
  }
  expect(await blobCount()).toBe(base);

  // What is wrong in itself, and what the account may not do, are answered as they were: the clock
  // is looked at last.
  const pretty = blobBody("scorecard", utf8(JSON.stringify(scorecardOf("1"), null, 2)));
  const notCanonical = await post<ErrorBody>("/v1/blobs", pretty, judge);
  expect([notCanonical.status, notCanonical.body.message]).toEqual([400, "not canonical JSON"]);
  const nameless = await post<ErrorBody>("/v1/blobs", upload(scorecardBy(alice, "1")), alice);
  expect([nameless.status, nameless.body.error]).toEqual([403, "forbidden"]);
  const unknown = await post<ErrorBody>("/v1/blobs", upload(scorecardOf("77")), judge);
  expect([unknown.status, unknown.body.error]).toEqual([404, "not_found"]);
  expect(await blobCount()).toBe(base);

  // The deadline is the moment the window closes, as the contract has it (`now >= reveal_deadline`).
  nowNs = REVEAL_DEADLINE;
  expect((await post("/v1/blobs", upload(scorecardOf("1")), judge)).status).toBe(200);
  nowNs = REVEAL_DEADLINE + 1n;
  const byPoster = upload(scorecardBy(poster, "1", { generated_at: "2026-10-30T11:00:00Z" }));
  expect((await post("/v1/blobs", byPoster, poster)).status).toBe(200);
  expect(await blobCount()).toBe(base + 2);

  // Each task has a deadline of its own: task 2 is still open, though task 1 is not.
  const open = await post<ErrorBody>("/v1/blobs", upload(scorecardOf("2")), judge);
  expect(open.status).toBe(409);
  expect(open.body).toEqual(tooEarly);
  nowNs = later - 1n;
  expect((await post("/v1/blobs", upload(scorecardOf("2")), judge)).status).toBe(409);
  nowNs = later;
  expect((await post("/v1/blobs", upload(scorecardOf("2")), judge)).status).toBe(200);
  expect(await blobCount()).toBe(base + 3);
});

test("scorecard_must_name_its_uploader_as_verifier", async () => {
  const base = await seed();
  // Task 2 has the poster of task 1 and closes its reveals with it, but its verifier is alice: any
  // account a task names may publish its scorecard, and the card is that account's own word.
  await openTask(2, REVEAL_DEADLINE, [], { verifier: alice });
  nowNs = REVEAL_DEADLINE;
  const upload = (document: Scorecard) => blobBody("scorecard", canonicalJson(document));
  const card = (verifier: string) =>
    scorecardOf("2", { verifier, judge: { software: "my-judge/2", model: null } });

  // Alice may not put another name on her card, the poster's, the Judge's or a stranger's.
  for (const other of [poster, judge, bob]) {
    await expectScorecardRefused(card(other), alice, NAMES_UPLOADER);
  }
  // The poster may not publish alice's card as hers, or one that names the Judge: it is no verifier.
  await expectScorecardRefused(card(alice), poster, NAMES_UPLOADER);
  await expectScorecardRefused(card(judge), poster, NAMES_UPLOADER);
  // Nor may the Judge's account, the verifier of task 1, put a name on a card but its own.
  await expectScorecardRefused(scorecardOf("1", { verifier: alice }), judge, NAMES_UPLOADER);
  expect(await blobCount()).toBe(base);

  // Each of them may publish a card that names itself, and the row says whose it is.
  const byVerifier = await post("/v1/blobs", upload(card(alice)), alice);
  expect(byVerifier.status).toBe(200);
  expect(await rowOf(byVerifier.body.sha256)).toEqual({
    kind: "scorecard",
    content_type: "application/json",
    task_id: "2",
    uploader: alice,
    is_public: true,
  });
  expect((await post("/v1/blobs", upload(card(poster)), poster)).status).toBe(200);
  expect((await post("/v1/blobs", upload(scorecardOf("1")), judge)).status).toBe(200);
  expect(await blobCount()).toBe(base + 3);

  // The bytes that alice stored are hers: the poster cannot send them again as its own.
  await expectScorecardRefused(card(alice), poster, NAMES_UPLOADER);
});

test("only_the_judge_account_publishes_judge_scorecards", async () => {
  const base = await seed();
  await openTask(2, REVEAL_DEADLINE, [], { verifier: alice });
  nowNs = REVEAL_DEADLINE;
  const upload = (document: Scorecard) => blobBody("scorecard", canonicalJson(document));
  const software = (name: string) => ({ software: name, model: null });
  const bySoftware = (account: string, name: string) =>
    scorecardBy(account, "2", { judge: software(name) });

  // Alice names herself, but calls her software the Judge's, in any of the ways the schema lets her
  // write it. The poster, naming itself, does the same. Neither is the Judge: both are refused.
  for (const name of [
    "tender-judge/1",
    "Tender_Judge",
    "TENDERJUDGE-x",
    "tender.judge/2",
    "t-e-n-d-e-r_j-u-d-g-e",
  ]) {
    await expectScorecardRefused(bySoftware(alice, name), alice, JUDGE_ONLY);
    await expectScorecardRefused(bySoftware(poster, name), poster, JUDGE_ONLY);
  }
  expect(await blobCount()).toBe(base);

  // A look-alike is no name at all, so a card with one is a 400 from the schema and never gets as
  // far as this rule.
  for (const name of ["tender\u{2010}judge/1", "tender\u{200d}judge/1", "tender judge/1"]) {
    const res = await post<ErrorBody>("/v1/blobs", upload(bySoftware(alice, name)), alice);
    expect(res.status, name).toBe(400);
    expect(res.body.issues, name).toEqual([
      { path: ["judge", "software"], message: expect.any(String), code: "invalid_format" },
    ]);
  }
  expect(await blobCount()).toBe(base);

  // Any other name is hers to choose.
  for (const name of ["my-judge/2", "tender-agent", "judge/tender"]) {
    expect((await post("/v1/blobs", upload(bySoftware(alice, name)), alice)).status, name).toBe(
      200,
    );
  }
  expect(await blobCount()).toBe(base + 3);

  // The Judge's account may use the Judge's name, and is the account that `deps.judgeAccount` says.
  const asJudge = appWith({ judgeAccount: judge });
  const published = await post("/v1/blobs", upload(scorecardOf("1")), judge, asJudge);
  expect(published.status).toBe(200);
  expect(await rowOf(published.body.sha256)).toMatchObject({ uploader: judge, task_id: "1" });
  expect(await blobCount()).toBe(base + 4);
  // Verifying a task does not make an account the Judge. When `deps.judgeAccount` is another
  // account, the verifier of task 1 is refused the name, and when none is set, so is every account.
  const other = appWith({ judgeAccount: carol });
  const unset = appWith({ judgeAccount: undefined });
  const again = (at: string) => scorecardOf("1", { generated_at: at });
  await expectScorecardRefused(again("2026-10-30T11:00:00Z"), judge, JUDGE_ONLY, other);
  await expectScorecardRefused(again("2026-10-30T12:00:00Z"), judge, JUDGE_ONLY, unset);
  // The Judge's account is no more than any other account for a name that is not the Judge's.
  const own = scorecardOf("1", { judge: software("my-judge/2") });
  expect((await post("/v1/blobs", upload(own), judge, unset)).status).toBe(200);
  expect(await blobCount()).toBe(base + 5);
});

test("scorecard_attribution_is_told_after_the_right_to_upload_and_before_the_clock", async () => {
  const base = await seed();
  // The reveal window of task 2 is open: the clock stays where it starts, before its deadline.
  await openTask(2, REVEAL_DEADLINE, [], { verifier: alice });
  const upload = (document: Scorecard) => blobBody("scorecard", canonicalJson(document));
  const wait = { error: "too_early", message: "the task's reveal window has not closed" };

  // A card that is right for its sender is told to wait. One that is not is told what is wrong with
  // it at once, since waiting would not mend it.
  const early = await post<ErrorBody>("/v1/blobs", upload(scorecardBy(alice, "2")), alice);
  expect([early.status, early.body]).toEqual([409, wait]);
  await expectScorecardRefused(scorecardOf("2", { verifier: judge }), alice, NAMES_UPLOADER);
  await expectScorecardRefused(scorecardOf("2", { verifier: alice }), alice, JUDGE_ONLY);

  // Whether the account may upload at all comes before what the card says: carol is neither the
  // verifier nor the poster, and is told that whoever the card names and whatever it is called.
  const stranger = {
    error: "forbidden",
    message: "only the verifier or the poster of the task may upload its scorecard",
  };
  for (const document of [
    scorecardBy(carol, "2"),
    scorecardOf("2", { verifier: alice }),
    scorecardOf("2", { verifier: carol }),
  ]) {
    await expectScorecardRefused(document, carol, stranger);
  }
  expect(await blobCount()).toBe(base);
});

test("heldout_hash_must_match_commitment", async () => {
  const upload = (commitment: string, bytes: Uint8Array) =>
    post<{ ok: true } & ErrorBody>(
      "/v1/heldout",
      { commitment, content_base64: b64(bytes) },
      poster,
    );

  const ok = await upload(HELDOUT_HASH, HELDOUT_BYTES);
  expect(ok.status).toBe(200);
  expect(ok.body).toEqual({ ok: true });
  // It is stored private, as the poster's, under the hash the chain will hold as the commitment,
  // and the poster is recorded as one who sent it.
  expect(await rowOf(HELDOUT_HASH)).toEqual({
    kind: "heldout",
    content_type: "application/json",
    task_id: null,
    uploader: poster,
    is_public: false,
  });
  expect(await heldoutUploadersOf(HELDOUT_HASH)).toEqual([poster]);

  // Bytes that do not hash to the commitment are refused, however good they are.
  const other = canonicalJson({ exact: { expected: ["43"] } });
  const wrongHash = await upload(HELDOUT_HASH, other);
  expect(wrongHash.status).toBe(400);
  expect(wrongHash.body.error).toBe("bad_request");
  expect(await rowOf(sha256Hex(other))).toBeNull();

  // A commitment is 64 lowercase hex characters.
  for (const commitment of [
    HELDOUT_HASH.toUpperCase(),
    HELDOUT_HASH.slice(1),
    `${HELDOUT_HASH}0`,
    "",
  ]) {
    expect((await upload(commitment, HELDOUT_BYTES)).status, commitment).toBe(400);
  }

  // The hash matches but the bytes are not a held-out document: the poster committed to rubbish.
  for (const document of [
    {},
    { exact: { expected: [] } },
    { exact: { expected: ["1"] }, tests: { cases: [] } },
    [1],
  ]) {
    const bytes = canonicalJson(document);
    const rubbish = await upload(sha256Hex(bytes), bytes);
    expect(rubbish.status, JSON.stringify(document)).toBe(400);
    expect(rubbish.body.issues?.length ?? 0).toBeGreaterThan(0);
  }
  expect(await blobCount()).toBe(1);

  // The body is checked as well: extra fields and a missing one.
  const extra = { commitment: HELDOUT_HASH, content_base64: b64(HELDOUT_BYTES), kind: "heldout" };
  expect((await post("/v1/heldout", extra, poster)).status).toBe(400);
  expect((await post("/v1/heldout", { commitment: HELDOUT_HASH }, poster)).status).toBe(400);
  // None of the refused uploads is recorded.
  expect(await deps.db.query("select sha256, account from heldout_uploads")).toEqual([
    { sha256: HELDOUT_HASH, account: poster },
  ]);
});

test("heldout_never_served_while_private", async () => {
  await post(
    "/v1/heldout",
    { commitment: HELDOUT_HASH, content_base64: b64(HELDOUT_BYTES) },
    poster,
  );
  const path = `/v1/blobs/${HELDOUT_HASH}`;

  // Not at any time, and not any differently from a hash nobody ever stored.
  for (const at of [TEST_NOW, REVEAL_DEADLINE, REVEAL_DEADLINE + 1_000_000n * SECOND]) {
    nowNs = at;
    const hidden = await get(path);
    expect(hidden.status).toBe(404);
    expect(hidden.headers.get("cache-control")).toBe("no-store");
    expect(hidden.text()).not.toContain("expected");
    const unknown = await get(`/v1/blobs/${sha256Hex("never stored")}`);
    expect(hidden.text()).toBe(unknown.text());
  }
  // Uploading it again, as the poster or as anyone else, does not publish it.
  await post(
    "/v1/heldout",
    { commitment: HELDOUT_HASH, content_base64: b64(HELDOUT_BYTES) },
    poster,
  );
  await post(
    "/v1/heldout",
    { commitment: HELDOUT_HASH, content_base64: b64(HELDOUT_BYTES) },
    carol,
  );
  expect((await get(path)).status).toBe(404);
  expect((await rowOf(HELDOUT_HASH))?.is_public).toBe(false);

  // Visibility is the only thing that lets it out (the settlement publishes it).
  await setBlobPublic(deps.db, HELDOUT_HASH, true);
  const shown = await get(path);
  expect(shown.status).toBe(200);
  expect(shown.bytes).toEqual(HELDOUT_BYTES);
  await setBlobPublic(deps.db, HELDOUT_HASH, false);
  expect((await get(path)).status).toBe(404);
});

test("immutable_cache_headers", async () => {
  await seedLifecycle(deps.db);
  const brief = await post("/v1/blobs", blobBody("brief", canonicalJson(FIXTURE_BRIEF)), alice);
  // Bob revealed "bob work" in task 1, and carol reveals a JSON result in task 2, which closes at
  // the same time. A result is served once it is revealed and its task has closed.
  const result = await post("/v1/blobs", resultBody("bob work", "1"), bob);
  await openTask(2, REVEAL_DEADLINE, [carol]);
  await reveal(2, carol, '{"total":"1.00"}');
  const asJson = await post(
    "/v1/blobs",
    resultBody('{"total":"1.00"}', "2", { content_type: "application/json" }),
    carol,
  );
  nowNs = REVEAL_DEADLINE;

  const served = await get(`/v1/blobs/${brief.body.sha256}`);
  expect(served.status).toBe(200);
  expect(served.bytes).toEqual(canonicalJson(FIXTURE_BRIEF));
  expect(served.headers.get("content-type")).toBe("application/json");
  expect(served.headers.get("cache-control")).toBe(CACHE_CONTROL);
  // What is served is user content: it is never sniffed into a page, and never runs in one.
  expect(served.headers.get("x-content-type-options")).toBe("nosniff");
  expect(served.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");

  const text = await get(`/v1/blobs/${result.body.sha256}`);
  expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(text.headers.get("cache-control")).toBe(CACHE_CONTROL);
  expect(text.headers.get("x-content-type-options")).toBe("nosniff");
  expect(text.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  expect((await get(`/v1/blobs/${asJson.body.sha256}`)).headers.get("content-type")).toBe(
    "application/json",
  );

  // A blob that is not served yet may be served later, so nothing may keep its 404.
  nowNs = TEST_NOW;
  const early = await get(`/v1/blobs/${result.body.sha256}`);
  expect(early.status).toBe(404);
  expect(early.headers.get("cache-control")).toBe("no-store");
  const unknown = await get(`/v1/blobs/${sha256Hex("unknown")}`);
  expect(unknown.status).toBe(404);
  expect(unknown.headers.get("cache-control")).toBe("no-store");
});

test("same_bytes_same_sha", async () => {
  const bytes = canonicalJson(FIXTURE_BRIEF);
  const first = await post("/v1/blobs", blobBody("brief", bytes), alice);
  expect(first.status).toBe(200);
  // The hash is what the chain records for the brief: the SHA-256 of its canonical bytes.
  expect(first.body).toEqual({
    sha256: FIXTURE_BRIEF_HASH,
    uri: `http://api.test/v1/blobs/${FIXTURE_BRIEF_HASH}`,
  });

  // Again, from the same account and from another: one blob, the same answer.
  for (const account of [alice, bob]) {
    const again = await post("/v1/blobs", blobBody("brief", bytes), account);
    expect(again.status, account).toBe(200);
    expect(again.body).toEqual(first.body);
  }
  expect(await blobCount()).toBe(1);
  // The first writer is the one on record.
  expect((await rowOf(FIXTURE_BRIEF_HASH))?.uploader).toBe(alice);

  // The URI follows the public URL of the deployment.
  const elsewhere = appWith({ publicUrl: "https://api.tender.example" });
  const moved = await post("/v1/blobs", blobBody("brief", bytes), alice, elsewhere);
  expect(moved.body.uri).toBe(`https://api.tender.example/v1/blobs/${FIXTURE_BRIEF_HASH}`);
});

// ---- The addendum's tests ---------------------------------------------------------------------

test("uploads_are_refused_without_sign_in", async () => {
  // The real app: without a bearer token from a sign-in nobody can upload, whatever they send. A
  // header that stands in for sign-in in these tests is nothing to the real one.
  const app = createApp(deps);
  const tries: Array<[string, unknown]> = [
    ["/v1/blobs", blobBody("brief", canonicalJson(FIXTURE_BRIEF))],
    ["/v1/heldout", { commitment: HELDOUT_HASH, content_base64: b64(HELDOUT_BYTES) }],
  ];
  for (const [path, body] of tries) {
    const signedIn: Array<Record<string, string>> = [
      {},
      { authorization: "Bearer anything" },
      { authorization: `Bearer ${"A".repeat(43)}` },
      { "x-test-account": alice },
    ];
    for (const headers of signedIn) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      expect(res.status, path).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(await res.json()).toEqual({
        error: "unauthorized",
        message: "sign in with a bearer token from POST /v1/auth/verify",
      });
    }
  }
  // Not even a request that is too large or not JSON gets further than the refusal.
  const junk = await app.request("/v1/blobs", { method: "POST", body: "x".repeat(500_000) });
  expect(junk.status).toBe(401);
  expect(await blobCount()).toBe(0);

  // The routes ask for sign-in themselves, whatever stands in for it.
  const signedOut = await post<ErrorBody>(
    "/v1/blobs",
    blobBody("brief", canonicalJson(FIXTURE_BRIEF)),
  );
  expect(signedOut.status).toBe(401);
  const signedOutHeldout = await post<ErrorBody>("/v1/heldout", {
    commitment: HELDOUT_HASH,
    content_base64: b64(HELDOUT_BYTES),
  });
  expect(signedOutHeldout.status).toBe(401);
  expect(await blobCount()).toBe(0);
});

test("json_kinds_must_be_canonical", async () => {
  const base = await seed();
  // The scorecard is for task 1, whose reveal window has closed.
  nowNs = REVEAL_DEADLINE;
  const documents: Array<[UploadKind, unknown]> = [
    ["brief", FIXTURE_BRIEF],
    ["criteria", CRITERIA],
    ["profile", FIXTURE_PROFILE],
    ["scorecard", scorecardOf("1")],
  ];

  for (const [kind, document] of documents) {
    // A scorecard is the verifier's to upload.
    const account = kind === "scorecard" ? judge : alice;
    const canonical = canonicalJson(document);
    const text = new TextDecoder().decode(canonical);
    const variants: Record<string, Uint8Array> = {
      "pretty printing": utf8(JSON.stringify(document, null, 2)),
      "keys in the order they were written": utf8(JSON.stringify(document)),
      "a trailing newline": utf8(`${text}\n`),
      "a leading space": utf8(` ${text}`),
      "a byte order mark": new Uint8Array([0xef, 0xbb, 0xbf, ...canonical]),
      "a number written 1.0": utf8(text.replace(/:(\d+)([,}])/, ":$1.0$2")),
      "an escaped character": utf8(
        text.replace(/[a-z]{3}/, (m) => `\\u00${m.charCodeAt(0).toString(16)}${m.slice(1)}`),
      ),
    };
    for (const [name, bytes] of Object.entries(variants)) {
      // A document with no number to rewrite (a profile) is left as it was, which is canonical.
      if (Buffer.compare(bytes, canonical) === 0) continue;
      const res = await post<ErrorBody>("/v1/blobs", blobBody(kind, bytes), account);
      expect(res.status, `${kind} with ${name}`).toBe(400);
      expect(res.body, `${kind} with ${name}`).toEqual({
        error: "bad_request",
        message: "not canonical JSON",
      });
    }
    // Only the canonical bytes are stored.
    const stored = await post("/v1/blobs", blobBody(kind, canonical), account);
    expect(stored.status, kind).toBe(200);
    expect(stored.body.sha256).toBe(sha256Hex(canonical));
  }
  // The brief and the profile are the lifecycle's own and stored already: two documents are new.
  expect(await blobCount()).toBe(base + 2);

  // The message names the fault; the comparison is with the text as it was parsed.
  const pretty = await post<ErrorBody>(
    "/v1/blobs",
    blobBody("brief", utf8(JSON.stringify(FIXTURE_BRIEF, null, 2))),
    alice,
  );
  expect(pretty.body).toEqual({ error: "bad_request", message: "not canonical JSON" });
  // Duplicate keys collapse when parsed, so the text is not what its hash would stand for.
  const duplicate = `{"version":1,"version":1,${new TextDecoder().decode(canonicalJson(FIXTURE_BRIEF)).slice(1)}`;
  expect((await post("/v1/blobs", blobBody("brief", utf8(duplicate)), alice)).status).toBe(400);

  // Text that is not UTF-8, or not JSON, is not canonical JSON either. A surrogate written as three
  // bytes is not UTF-8.
  for (const bytes of [
    new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]),
    new Uint8Array([0x22, 0xed, 0xa0, 0x80, 0x22]),
    utf8("{"),
    utf8(""),
  ]) {
    const res = await post<ErrorBody>("/v1/blobs", blobBody("brief", bytes), alice);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "bad_request", message: "not canonical JSON" });
  }
  // JSON that is no brief is told what it lacks.
  for (const bytes of [utf8("null"), utf8("[]"), utf8("7")]) {
    const res = await post<ErrorBody>("/v1/blobs", blobBody("brief", bytes), alice);
    expect(res.status).toBe(400);
    expect(res.body.issues?.length).toBeGreaterThan(0);
  }
  // 1e999 parses to Infinity, which JSON cannot write: it is refused, and does not crash.
  const infinite = utf8(
    new TextDecoder()
      .decode(canonicalJson(FIXTURE_BRIEF))
      .replace('"max_bytes":4096', '"max_bytes":1e999'),
  );
  expect((await post("/v1/blobs", blobBody("brief", infinite), alice)).status).toBe(400);

  // Spellings of a document that the canonical form does not write that way. `-0` is the number 0.
  // A lone surrogate can be escaped in JSON but has no UTF-8 form, so the canonical form refuses a
  // string or a key that holds one (RFC 8785), and no text that spells one is canonical.
  const textOf = (document: unknown) => new TextDecoder().decode(canonicalJson(document));
  const spelled: Array<[string, UploadKind, string, string]> = [
    [
      "a number written -0",
      "criteria",
      textOf({ ...CRITERIA, min_score: 0 }).replace('"min_score":0', '"min_score":-0'),
      alice,
    ],
    [
      "a lone surrogate in a string",
      "profile",
      textOf({ ...FIXTURE_PROFILE, name: "NAME" }).replace("NAME", String.raw`a\ud800b`),
      alice,
    ],
    [
      "a lone surrogate in a key",
      "scorecard",
      textOf(scorecardOf("1", { heldout: { KEY: 1 } })).replace('"KEY"', String.raw`"\udc00"`),
      judge,
    ],
  ];
  for (const [name, kind, spelling, account] of spelled) {
    const res = await post<ErrorBody>("/v1/blobs", blobBody(kind, utf8(spelling)), account);
    expect(res.status, name).toBe(400);
    expect(res.body, name).toEqual({ error: "bad_request", message: "not canonical JSON" });
  }
  // An own `__proto__` key is no key of any document, and the schemas say so before the form is
  // looked at: this is a fault of the document, not of its spelling.
  const withProto: Array<[UploadKind, string, string]> = [
    ["brief", textOf(FIXTURE_BRIEF).replace("{", '{"__proto__":1,'), alice],
    [
      "scorecard",
      textOf(scorecardOf("1", { heldout: { KEY: 1 } })).replace('"KEY"', '"__proto__"'),
      judge,
    ],
  ];
  for (const [kind, spelling, account] of withProto) {
    const res = await post<ErrorBody>("/v1/blobs", blobBody(kind, utf8(spelling)), account);
    expect(res.status, kind).toBe(400);
    expect(res.body.message, kind).toContain("does not fit its schema");
    expect(res.body.issues?.length, kind).toBeGreaterThan(0);
  }
  // Nothing of the above was stored.
  expect(await blobCount()).toBe(base + 2);

  // The JSON kinds are JSON.
  const asText = await post<ErrorBody>(
    "/v1/blobs",
    blobBody("brief", canonicalJson(FIXTURE_BRIEF), { content_type: "text/plain" }),
    alice,
  );
  expect(asText.status).toBe(400);

  // A result is the entrant's own bytes, in either type, with no form to keep to.
  const prettyResult = resultBody(JSON.stringify(FIXTURE_BRIEF, null, 2), "1", {
    content_type: "application/json",
  });
  expect((await post("/v1/blobs", prettyResult, alice)).status).toBe(200);
  expect(
    (await post("/v1/blobs", resultBody(new Uint8Array([0xff, 0x00, 0xfe]), "1"), alice)).status,
  ).toBe(200);
  expect((await post("/v1/blobs", resultBody("", "1"), alice)).status).toBe(200);

  // Nor does a held-out document get to be anything but canonical.
  const prettyHeldout = utf8(JSON.stringify(HELDOUT, null, 2));
  const heldout = await post<ErrorBody>(
    "/v1/heldout",
    { commitment: sha256Hex(prettyHeldout), content_base64: b64(prettyHeldout) },
    poster,
  );
  expect(heldout.status).toBe(400);
  expect(heldout.body.message).toBe("not canonical JSON");
  // A lone surrogate is refused there as well. The commitment is the hash of the bytes sent.
  const lone = utf8(textOf({ exact: { expected: ["X"] } }).replace("X", String.raw`\ud800`));
  const loneHeldout = await post<ErrorBody>(
    "/v1/heldout",
    { commitment: sha256Hex(lone), content_base64: b64(lone) },
    poster,
  );
  expect(loneHeldout.status).toBe(400);
  expect(loneHeldout.body.message).toBe("not canonical JSON");
});

test("kind_conflict_is_409", async () => {
  await seedLifecycle(deps.db);
  const conflict = { error: "conflict", message: "these bytes are already stored as another kind" };

  // A private held-out document that happens to be a valid brief must not become a public one:
  // its task could no longer be judged, and its answers would be out.
  const secretBrief = canonicalJson({ ...FIXTURE_BRIEF, title: "Secret answers" });
  const heldout = await putBlob(deps.db, {
    kind: "heldout",
    contentType: "application/json",
    bytes: secretBrief,
    uploader: poster,
    isPublic: false,
  });
  const taken = await post<ErrorBody>("/v1/blobs", blobBody("brief", secretBrief), carol);
  expect(taken.status).toBe(409);
  expect(taken.body).toEqual(conflict);
  expect(await rowOf(heldout)).toEqual({
    kind: "heldout",
    content_type: "application/json",
    task_id: null,
    uploader: poster,
    is_public: false,
  });
  expect((await get(`/v1/blobs/${heldout}`)).status).toBe(404);

  // A result is not a profile, a public brief is not a result, and neither changes.
  const profile = canonicalJson({ ...FIXTURE_PROFILE, name: "Also a result" });
  const result = await putBlob(deps.db, {
    kind: "result",
    contentType: "application/json",
    bytes: profile,
    taskId: 1n,
    uploader: alice,
    isPublic: false,
  });
  expect((await post("/v1/blobs", blobBody("profile", profile), carol)).status).toBe(409);
  expect(await rowOf(result)).toMatchObject({ kind: "result", is_public: false, uploader: alice });

  // A public brief is not a result either. A result that is a document of another kind is refused
  // for what it is, before its kind is looked at (`a_result_may_not_be_a_document_of_another_kind`).
  const publicBrief = canonicalJson({ ...FIXTURE_BRIEF, title: "Already public" });
  const brief = await post("/v1/blobs", blobBody("brief", publicBrief), carol);
  const asResult = await post<ErrorBody>(
    "/v1/blobs",
    resultBody(publicBrief, "1", { content_type: "application/json" }),
    alice,
  );
  expect(asResult.status).toBe(400);
  expect(asResult.body).toEqual(ANOTHER_KIND);
  expect(await rowOf(brief.body.sha256)).toMatchObject({
    kind: "brief",
    is_public: true,
    uploader: carol,
  });

  // The same goes for a held-out document sent to the held-out route.
  const answers = await putBlob(deps.db, {
    kind: "result",
    contentType: "text/plain",
    bytes: HELDOUT_BYTES,
    taskId: 1n,
    uploader: alice,
    isPublic: false,
  });
  const asHeldout = await post<ErrorBody>(
    "/v1/heldout",
    { commitment: answers, content_base64: b64(HELDOUT_BYTES) },
    poster,
  );
  expect(asHeldout.status).toBe(409);
  expect(asHeldout.body).toEqual(conflict);
  expect(await rowOf(answers)).toMatchObject({ kind: "result", uploader: alice, is_public: false });
});

test("heldout_is_recorded_for_every_account_that_sends_it", async () => {
  const body = { commitment: HELDOUT_HASH, content_base64: b64(HELDOUT_BYTES) };
  // Carol has the bytes first, as anyone can once a document is out (a seed's is in the
  // repository), and the row is hers. The poster's upload of the same bytes is answered as any
  // other, and counts: the Judge asks whether the poster is among those who sent them.
  expect((await post("/v1/heldout", body, carol)).status).toBe(200);
  const mine = await post<{ ok: true }>("/v1/heldout", body, poster);
  expect([mine.status, mine.body]).toEqual([200, { ok: true }]);
  expect(await rowOf(HELDOUT_HASH)).toMatchObject({ uploader: carol, is_public: false });
  expect(await heldoutUploadersOf(HELDOUT_HASH)).toEqual([carol, poster]);
  expect(await hasHeldoutUpload(deps.db, HELDOUT_HASH, poster)).toBe(true);

  // Saying it again is the same blob and the same record.
  expect((await post("/v1/heldout", body, poster)).status).toBe(200);
  expect(await blobCount()).toBe(1);
  expect(await heldoutUploadersOf(HELDOUT_HASH)).toEqual([carol, poster]);

  // Bytes stored as another kind are a 409, and no one is recorded for them.
  const answers = canonicalJson({ exact: { expected: ["44"] } });
  await putBlob(deps.db, {
    kind: "result",
    contentType: "text/plain",
    bytes: answers,
    taskId: 1n,
    uploader: alice,
    isPublic: false,
  });
  const taken = await post<ErrorBody>(
    "/v1/heldout",
    { commitment: sha256Hex(answers), content_base64: b64(answers) },
    poster,
  );
  expect(taken.status).toBe(409);
  expect(await heldoutUploadersOf(sha256Hex(answers))).toEqual([]);
});

test("brief_and_profile_are_stored_public", async () => {
  const briefBytes = canonicalJson(FIXTURE_BRIEF);
  const brief = await post("/v1/blobs", blobBody("brief", briefBytes), alice);
  const profile = await post("/v1/blobs", blobBody("profile", canonicalJson(FIXTURE_PROFILE)), bob);
  const criteria = await post("/v1/blobs", blobBody("criteria", canonicalJson(CRITERIA)), carol);
  expect(await rowOf(brief.body.sha256)).toEqual({
    kind: "brief",
    content_type: "application/json",
    task_id: null,
    uploader: alice,
    is_public: true,
  });
  expect(await rowOf(profile.body.sha256)).toMatchObject({ kind: "profile", is_public: true });
  expect(await rowOf(criteria.body.sha256)).toMatchObject({ kind: "criteria", is_public: true });
  expect(profile.body.sha256).toBe(FIXTURE_PROFILE_HASH);

  // The indexer reads a brief and a profile only when they are public with their kind. A task
  // posted with the uploaded brief shows its title, and an agent registered with the uploaded
  // profile shows its name.
  await apply(
    taskLine(2, { brief_hash: brief.body.sha256, criteria_hash: criteria.body.sha256 }),
    eventLine("agent_registered", { account: carol, profile_hash: profile.body.sha256 }),
  );
  const app = createApp(deps);
  const task = (await (await app.request("/v1/tasks/2")).json()) as TaskDetailResponse;
  expect(task.task.title).toBe(FIXTURE_BRIEF.title);
  expect(task.brief).toEqual(FIXTURE_BRIEF);
  expect(task.criteria).toEqual(CRITERIA);
  const agent = (await (await app.request(`/v1/agents/${carol}`)).json()) as AgentDetailResponse;
  expect(agent.agent.name).toBe(FIXTURE_PROFILE.name);

  // Someone stored the bytes of a brief before its poster did, as private. Uploading them again
  // makes the row public: the uploader holds the bytes, so nothing is given away, and the
  // indexer can read them.
  const draft = canonicalJson({ ...FIXTURE_BRIEF, title: "A draft" });
  const hash = await putBlob(deps.db, {
    kind: "brief",
    contentType: "application/json",
    bytes: draft,
    uploader: carol,
    isPublic: false,
  });
  expect((await get(`/v1/blobs/${hash}`)).status).toBe(404);
  const published = await post("/v1/blobs", blobBody("brief", draft), alice);
  expect(published.status).toBe(200);
  expect(published.body.sha256).toBe(hash);
  expect(await rowOf(hash)).toMatchObject({ kind: "brief", is_public: true, uploader: carol });
  expect((await get(`/v1/blobs/${hash}`)).bytes).toEqual(draft);
});

test("upload_envelope_is_checked", async () => {
  const base = await seed();
  const good = blobBody("brief", canonicalJson(FIXTURE_BRIEF));
  const cases: Array<[string, Record<string, unknown>]> = [
    ["an unknown kind", { ...good, kind: "heldout" }],
    ["no kind", { ...good, kind: undefined }],
    ["an unknown content type", { ...good, content_type: "text/html" }],
    ["no content", { ...good, content_base64: undefined }],
    ["content that is no string", { ...good, content_base64: 12 }],
    ["an extra field", { ...good, uploader: alice }],
    ["a task id that is no u64", { ...good, task_id: "01" }],
    ["a task id that is a number", { ...good, task_id: 1 }],
  ];
  for (const [name, body] of cases) {
    const res = await post<ErrorBody>("/v1/blobs", body, alice);
    expect(res.status, name).toBe(400);
    expect(res.body.error, name).toBe("bad_request");
    expect(res.body.issues?.length, name).toBeGreaterThan(0);
  }
  // Bodies that are no objects.
  for (const body of ["[]", "null", '"brief"', "7"]) {
    expect((await post("/v1/blobs", body, alice)).status, body).toBe(400);
  }
  // The name of a field that is not the API's is not sent back to whoever sent it.
  const stray = await post<ErrorBody>("/v1/blobs", { ...good, "stray-field-1f3a": 1 }, alice);
  expect(stray.status).toBe(400);
  expect(JSON.stringify(stray.body)).not.toContain("stray-field-1f3a");
  expect(await blobCount()).toBe(base);

  // A task id means nothing to a brief and is left out of its row.
  const withTask = await post("/v1/blobs", { ...good, task_id: "1" }, alice);
  expect(withTask.status).toBe(200);
  expect((await rowOf(withTask.body.sha256))?.task_id).toBeNull();
});

test("body_limit_413", async () => {
  const app = appWith();
  const send = (path: string, body: string, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "x-test-account": alice, "content-type": "application/json", ...headers },
      body,
    });

  for (const path of ["/v1/blobs", "/v1/heldout"]) {
    // Over the limit, the body is refused before it is parsed: as JSON it would be a 400.
    const over = await send(path, "x".repeat(400_001));
    expect(over.status, path).toBe(413);
    expect(over.headers.get("content-type")).toContain("application/json");
    expect(await over.json()).toEqual({
      error: "payload_too_large",
      message: "the request body is too large",
    });
    // At the limit it is read, and found not to be JSON.
    const at = await send(path, "x".repeat(400_000));
    expect(at.status, path).toBe(400);
    expect(await at.json()).toEqual({ error: "bad_request", message: "body is not valid JSON" });

    // A declared length is enough to refuse it, whatever follows.
    const declared = await send(path, "{}", { "content-length": "400001" });
    expect(declared.status, path).toBe(413);
  }
  expect(await blobCount()).toBe(0);
});

test("bad_base64_400", async () => {
  const base = await seed();
  const send = (content: unknown) =>
    post<ErrorBody>(
      "/v1/blobs",
      { kind: "result", content_type: "text/plain", task_id: "1", content_base64: content },
      alice,
    );

  // "QUJD" is "ABC". The decoder of Node skips what it cannot read, so each of these would be
  // taken for something else if the text were not checked.
  expect((await send("QUJD")).status).toBe(200);
  expect((await send("QQ==")).status).toBe(200);
  expect((await send("")).status).toBe(200);
  for (const content of [
    "QUJD\n",
    "QU\nJD",
    " QUJD",
    "QUJD ",
    "QUJ",
    "QQ",
    "QQ=",
    "QR==",
    "====",
    "!!!!",
    "QUJD!",
    "QU-D",
    "-_8=",
    "QUJD=",
    "QUJDQQ==QQ==",
    "é",
  ]) {
    const res = await send(content);
    expect(res.status, JSON.stringify(content)).toBe(400);
    expect(res.body.error).toBe("bad_request");
    expect(res.body.message).toContain("base64");
  }
  expect((await send(7)).status).toBe(400);
  // The three that were good: "ABC", "A" and nothing.
  expect(await blobCount()).toBe(base + 3);

  // The held-out route reads its content the same way.
  const heldout = await post<ErrorBody>(
    "/v1/heldout",
    { commitment: HELDOUT_HASH, content_base64: `${b64(HELDOUT_BYTES)}\n` },
    poster,
  );
  expect(heldout.status).toBe(400);
  expect(heldout.body.message).toContain("base64");
});

test("malformed_json_body_is_400_json", async () => {
  const bodies = ["", "{", '{"kind":', "secret-token", "undefined", "{'kind': 'brief'}", "[1,"];
  for (const path of ["/v1/blobs", "/v1/heldout"]) {
    for (const body of bodies) {
      const res = await post<ErrorBody>(path, body, alice);
      expect(res.status, `${path} ${body}`).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      // A fixed message: the parser's own would quote the start of the request.
      expect(res.body).toEqual({ error: "bad_request", message: "body is not valid JSON" });
    }
  }

  // An HTTPException that carries no response of its own, such as the one `hono/validator` throws
  // for a body it cannot parse, is answered as JSON as well, with the words of its status.
  const app = appWith();
  app.post(
    "/v1/probe/validated",
    validator("json", (value) => value),
    (c) => c.json({ ok: true }),
  );
  app.get("/v1/probe/refused", () => {
    throw new HTTPException(403, { message: "secret-token was not allowed in" });
  });
  app.get("/v1/probe/broken", () => {
    throw new HTTPException(503, { message: "secret-token: the database password is wrong" });
  });

  const malformed = await post<ErrorBody>("/v1/probe/validated", "{", undefined, app);
  expect(malformed.status).toBe(400);
  expect(malformed.headers.get("content-type")).toContain("application/json");
  expect(malformed.body.error).toBe("bad_request");
  expect(malformed.body.message).toEqual(expect.any(String));
  expect((await post("/v1/probe/validated", "{}", undefined, app)).status).toBe(200);

  for (const [path, status, error] of [
    ["/v1/probe/refused", 403, "forbidden"],
    ["/v1/probe/broken", 503, "service_unavailable"],
  ] as const) {
    const res = await app.request(path);
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toContain("application/json");
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error, message: expect.any(String) });
    expect(text).not.toContain("secret-token");
  }

  // The messages of the other errors do not quote the request either.
  const quoting = await post<ErrorBody>("/v1/blobs", { kind: "secret-token" }, alice);
  expect(quoting.status).toBe(400);
  expect(quoting.body.message).not.toContain("secret-token");
});

test("a_syntax_error_of_ours_is_a_500_and_is_logged", async () => {
  // A body that is not JSON makes `c.req.json()` throw a `SyntaxError`, and `readJson` makes that a
  // 400. A `SyntaxError` from anywhere else is a bug of the server, such as a parser it runs on its
  // own data, and must not pass for the caller's mistake: it is a 500, and it is logged.
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const app = appWith();
    app.get("/v1/probe/parse", () => {
      throw new SyntaxError("Unexpected token in secret-token");
    });
    app.post("/v1/probe/read", async (c) => c.json({ read: await readJson(c) }));

    const bug = await app.request("/v1/probe/parse");
    expect(bug.status).toBe(500);
    const text = await bug.text();
    expect(JSON.parse(text)).toEqual({ error: "internal", message: "internal error" });
    expect(text).not.toContain("secret-token");
    expect(logged).toHaveBeenCalledTimes(1);

    // A body that is not JSON is the caller's: a 400, and nothing is logged for it.
    logged.mockClear();
    const bad = await post<ErrorBody>("/v1/probe/read", "{", undefined, app);
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: "bad_request", message: "body is not valid JSON" });
    const good = await post<{ read: unknown }>("/v1/probe/read", '{"a":1}', undefined, app);
    expect([good.status, good.body]).toEqual([200, { read: { a: 1 } }]);
    expect(logged).not.toHaveBeenCalled();

    // A body that cannot be read at all is no bad JSON either. It is not the caller's mistake to
    // hide: a 500, and logged.
    const broken = await app.request("/v1/probe/read", {
      method: "POST",
      body: new ReadableStream({
        start: (controller) => controller.error(new Error("connection reset")),
      }),
      duplex: "half",
    } as RequestInit);
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: "internal", message: "internal error" });
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    logged.mockRestore();
  }
});

// ---- The scorecard route ----------------------------------------------------------------------

test("scorecard_route_serves_the_scorecard_of_a_settled_task", async () => {
  await seedLifecycle(deps.db);
  await apply(taskLine(2));
  // Task 2 has the reveal deadline of the captured task, and a scorecard is uploaded after it.
  nowNs = REVEAL_DEADLINE;
  const document = scorecardOf("2", {
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
    // What the task's pick pays, below: a scorecard is served only beside its own payout.
    winners: PICKED_WINNERS,
  });
  const bytes = canonicalJson(document);
  const stored = await post("/v1/blobs", blobBody("scorecard", bytes), judge);
  expect(stored.status).toBe(200);

  const app = createApp(deps);
  // The task has no outcome yet: there is nothing to serve, though the blob is public.
  const early = await get("/v1/scorecards/2", app);
  expect(early.status).toBe(404);
  expect(early.headers.get("cache-control")).toBe("no-store");
  expect(JSON.parse(early.text())).toMatchObject(NOT_FOUND);

  await apply(eventLine("picked", { task_id: "2", scorecard_hash: stored.body.sha256 }));
  const res = await get("/v1/scorecards/2", app);
  expect(res.status).toBe(200);
  // The canonical bytes of the document are the bytes that were stored and that the chain hashes.
  expect(res.bytes).toEqual(bytes);
  expect(sha256Hex(res.bytes)).toBe(stored.body.sha256);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");

  // The blob route serves the same bytes under their hash.
  const byHash = await get(`/v1/blobs/${stored.body.sha256}`, app);
  expect(byHash.bytes).toEqual(bytes);

  // Ids that name no task with a scorecard.
  for (const id of ["1", "3", "0", "abc", "02", "18446744073709551616", "2%2F"]) {
    const none = await get(`/v1/scorecards/${id}`, app);
    expect(none.status, id).toBe(404);
    expect(none.headers.get("cache-control"), id).toBe("no-store");
  }
});

test("scorecard_route_hides_a_scorecard_that_names_another_task", async () => {
  await seedLifecycle(deps.db);
  // The verifier chooses the hash it settles with, so it can name the scorecard of another task.
  const other = await putBlob(deps.db, {
    kind: "scorecard",
    contentType: "application/json",
    bytes: canonicalJson(scorecardOf("9")),
    uploader: judge,
    isPublic: true,
  });
  await apply(taskLine(3), eventLine("picked", { task_id: "3", scorecard_hash: other }));
  const app = createApp(deps);
  const res = await get("/v1/scorecards/3", app);
  expect(res.status).toBe(404);
  expect(res.headers.get("cache-control")).toBe("no-store");
  // The scorecard of task 9 is still a public blob, and no task points at it.
  expect((await get(`/v1/blobs/${other}`, app)).status).toBe(200);
  expect((await get("/v1/scorecards/9", app)).status).toBe(404);
});

/**
 * The scorecard of task `id` wherever the API serves one: its route, the task's page and the MCP
 * tool, each as the document it serves, or null for none. One function decides for all three
 * (`getScorecard`), so they have to agree.
 */
async function servedScorecards(id: string): Promise<Array<Scorecard | null>> {
  const app = createApp(deps);
  const route = await get(`/v1/scorecards/${id}`, app);
  const page = (await (await app.request(`/v1/tasks/${id}`)).json()) as TaskDetailResponse;
  const call = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_scorecard", arguments: { task_id: id } },
    }),
  });
  const { result } = (await call.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  return [
    route.status === 200 ? (JSON.parse(route.text()) as Scorecard) : null,
    page.scorecard,
    result.isError === true ? null : (JSON.parse(result.content[0]?.text ?? "") as Scorecard),
  ];
}

/** Stores `document` as a public scorecard, as the Judge stores its own before it picks. */
function publishCard(document: Scorecard): Promise<string> {
  return putBlob(deps.db, {
    kind: "scorecard",
    contentType: "application/json",
    bytes: canonicalJson(document),
    taskId: BigInt(document.task_id),
    uploader: document.verifier,
    isPublic: true,
  });
}

/** A `picked` line for task `id`, by `by`, paying `winners` (each with some amount). */
function pickLine(
  id: string,
  by: string,
  winners: Array<{ account: string; bps: number }>,
  scorecardHash: string,
): string {
  return eventLine("picked", {
    task_id: id,
    by,
    winners: winners.map((winner) => ({ ...winner, amount: "1000" })),
    scorecard_hash: scorecardHash,
  });
}

test("a_scorecard_is_served_only_beside_the_payout_it_names", async () => {
  await seedLifecycle(deps.db);
  await apply(taskLine(2), taskLine(3), taskLine(4));
  const toAlice = [{ account: alice, bps: 10_000 }];

  // The Judge published its card for task 2 before a pick that failed. In the fallback window the
  // poster picks other winners with the Judge's hash: the card, which names the Judge as verifier
  // and alice as the winner, must not be shown beside a payout to bob that the Judge never made.
  const laundered = scorecardOf("2", { winners: toAlice });
  await apply(pickLine("2", poster, [{ account: bob, bps: 10_000 }], await publishCard(laundered)));
  expect(await servedScorecards("2")).toEqual([null, null, null]);

  // A poster that pays exactly what the Judge's card says has the Judge's card shown: it is the
  // truth of that payout.
  const honoured = scorecardOf("3", { winners: toAlice });
  await apply(pickLine("3", poster, toAlice, await publishCard(honoured)));
  expect(await servedScorecards("3")).toEqual([honoured, honoured, honoured]);

  // The same accounts and shares in another order are another pick.
  const reordered = scorecardOf("4", { winners: PICKED_WINNERS });
  await apply(pickLine("4", judge, PICKED_WINNERS.toReversed(), await publishCard(reordered)));
  expect(await servedScorecards("4")).toEqual([null, null, null]);
});

test("a_scorecard_of_an_empty_pick_names_no_winners", async () => {
  await seedLifecycle(deps.db);
  await apply(taskLine(2), taskLine(3));
  // A pick with no winners voids the task as `no_award`, with the scorecard it was made with.
  const empty = scorecardOf("2");
  await apply(eventLine("voided", { task_id: "2", scorecard_hash: await publishCard(empty) }));
  expect(await servedScorecards("2")).toEqual([empty, empty, empty]);

  // A card that names winners does not go with a payout of nothing.
  const named = scorecardOf("3", { winners: [{ account: alice, bps: 10_000 }] });
  await apply(eventLine("voided", { task_id: "3", scorecard_hash: await publishCard(named) }));
  expect(await servedScorecards("3")).toEqual([null, null, null]);
});

test("a_scorecard_is_the_word_of_the_tasks_verifier_or_poster", async () => {
  await seedLifecycle(deps.db);
  await apply(taskLine(2), taskLine(3));
  // A card that pays what the pick paid, for the task, in the name of an account that is neither
  // its verifier nor its poster, is nobody's to show for it. (The upload route would not take it;
  // the read holds to the same.)
  const strangers = scorecardBy(carol, "2", { winners: PICKED_WINNERS });
  await apply(pickLine("2", judge, PICKED_WINNERS, await publishCard(strangers)));
  expect(await servedScorecards("2")).toEqual([null, null, null]);

  // The poster's own card, for a pick it made in the fallback window, is shown.
  const posters = scorecardBy(poster, "3", { winners: PICKED_WINNERS });
  await apply(pickLine("3", poster, PICKED_WINNERS, await publishCard(posters)));
  expect(await servedScorecards("3")).toEqual([posters, posters, posters]);
});

test("scorecard_route_hides_a_private_scorecard", async () => {
  await seedLifecycle(deps.db);
  const document = scorecardOf("3", {
    heldout: HELDOUT,
    heldout_commitment: HELDOUT_HASH,
    winners: PICKED_WINNERS,
  });
  const hash = await putBlob(deps.db, {
    kind: "scorecard",
    contentType: "application/json",
    bytes: canonicalJson(document),
    uploader: judge,
    isPublic: false,
  });
  await apply(taskLine(3), eventLine("picked", { task_id: "3", scorecard_hash: hash }));
  const app = createApp(deps);

  expect((await get("/v1/scorecards/3", app)).status).toBe(404);
  expect((await get(`/v1/blobs/${hash}`, app)).status).toBe(404);
  await setBlobPublic(deps.db, hash, true);
  const shown = await get("/v1/scorecards/3", app);
  expect(shown.status).toBe(200);
  expect(shown.bytes).toEqual(canonicalJson(document));

  // A blob of another kind under that hash is no scorecard, public or not.
  const asResult = await putBlob(deps.db, {
    kind: "result",
    contentType: "application/json",
    bytes: canonicalJson(scorecardOf("4")),
    taskId: 1n,
    isPublic: true,
  });
  await apply(taskLine(4), eventLine("picked", { task_id: "4", scorecard_hash: asResult }));
  expect((await get("/v1/scorecards/4", app)).status).toBe(404);
  expect((await getBlob(deps.db, hash))?.isPublic).toBe(true);
});

test("public_document_is_returned_as_parsed_from_its_bytes", async () => {
  // A schema that builds a new object cannot keep an own `__proto__` key, and a document that lost
  // a key no longer hashes to the bytes that were stored. `z.record` is such a schema.
  const copying = z.record(z.string(), z.unknown());
  const text = '{"__proto__":{"seen":true},"b":2}';
  expect(Object.hasOwn(copying.parse(JSON.parse(text)), "__proto__")).toBe(false);

  const hash = await putBlob(deps.db, {
    kind: "scorecard",
    contentType: "application/json",
    bytes: utf8(text),
    isPublic: true,
  });
  const document = await publicDocument(deps.db, hash, "scorecard", copying);
  expect(document).not.toBeNull();
  expect(Object.hasOwn(document ?? {}, "__proto__")).toBe(true);
  expect(sha256Hex(canonicalJson(document))).toBe(hash);

  // The schema still decides whether it is returned at all, and so do the kind and the visibility.
  expect(await publicDocument(deps.db, hash, "scorecard", z.array(z.unknown()))).toBeNull();
  expect(await publicDocument(deps.db, hash, "brief", copying)).toBeNull();
  await setBlobPublic(deps.db, hash, false);
  expect(await publicDocument(deps.db, hash, "scorecard", copying)).toBeNull();
});

test("scorecard_with_proto_key_is_never_served_with_the_key_missing", async () => {
  await seedLifecycle(deps.db);
  // `JSON.parse` makes `__proto__` an own key, which an object literal or an assignment would not.
  const heldout: unknown = JSON.parse('{"exact":{"expected":["42"]},"__proto__":{"seen":true}}');
  expect(Object.keys(heldout as object)).toContain("__proto__");
  const bytes = canonicalJson(
    scorecardOf("3", {
      heldout,
      heldout_commitment: sha256Hex(canonicalJson(heldout)),
      winners: PICKED_WINNERS,
    }),
  );
  const hash = await putBlob(deps.db, {
    kind: "scorecard",
    contentType: "application/json",
    bytes,
    uploader: judge,
    isPublic: true,
  });
  await apply(taskLine(3), eventLine("picked", { task_id: "3", scorecard_hash: hash }));
  const app = createApp(deps);

  // `JsonValueSchema` refuses an own `__proto__` key (packages/shared/src/criteria.ts), so the
  // scorecard is not served at all, which is better than served without the key and with bytes that
  // no longer hash to `scorecard_hash`. If that rule is lifted, this is the round trip: a 200 whose
  // bytes are the stored ones.
  const res = await get("/v1/scorecards/3", app);
  expect(res.status).toBe(404);
  expect(res.headers.get("cache-control")).toBe("no-store");

  // The blob route sends the stored bytes whole: it hands out bytes and reads no document.
  const blob = await get(`/v1/blobs/${hash}`, app);
  expect(blob.bytes).toEqual(bytes);
  expect(sha256Hex(blob.bytes)).toBe(hash);
});

test("a_hash_that_is_not_64_lowercase_hex_is_404", async () => {
  await seedLifecycle(deps.db);
  const brief = await post("/v1/blobs", blobBody("brief", canonicalJson(FIXTURE_BRIEF)), alice);
  const hash = brief.body.sha256;
  expect((await get(`/v1/blobs/${hash}`)).status).toBe(200);

  for (const bad of [
    hash.toUpperCase(),
    hash.slice(1),
    `${hash}0`,
    "x".repeat(64),
    "%zz",
    `${hash}%00`,
    `${hash}%2f..`,
    "a%2fb",
  ]) {
    const res = await get(`/v1/blobs/${bad}`);
    expect(res.status, bad).toBe(404);
    expect(res.headers.get("cache-control"), bad).toBe("no-store");
    expect(JSON.parse(res.text()), bad).toMatchObject(NOT_FOUND);
  }
});

// ---- Result upload records (P03-R17) ----------------------------------------------------------

// A reveal puts a hash on chain for anyone to read, so it says nothing of who holds the bytes. The
// API records who uploaded which bytes for which task, and counts a reveal only when the account
// that made it uploaded the bytes for the task it revealed them in. A copy of a hash has no upload.

/** Who is recorded as having uploaded `sha256`, and for which task. */
function uploadsOf(sha256: string): Promise<Array<{ task_id: string; account: string }>> {
  return deps.db.query(
    `select task_id::text as task_id, account from result_uploads
      where sha256 = $1 order by result_uploads.task_id, account`,
    [sha256],
  );
}

async function uploadCount(): Promise<number> {
  const [row] = await deps.db.query<{ n: number }>("select count(*)::int as n from result_uploads");
  return row?.n ?? 0;
}

/** The reveals of `sha256` in the order the API takes them: by height, then by the event's id. */
function revealsOf(sha256: string): Promise<Array<{ task_id: string; height: string }>> {
  return deps.db.query(
    `select task_id::text as task_id, height::text as height from events
      where event = 'revealed' and data->>'content_hash' = $1
      order by events.height, events.id`,
    [sha256],
  );
}

/** Asserts that the result is a 404 that no cache keeps at each of `times`. */
async function expectHiddenAt(
  sha256: string,
  times: bigint[],
  app: App = appWith(),
): Promise<void> {
  for (const at of times) {
    nowNs = at;
    const res = await get(`/v1/blobs/${sha256}`, app);
    expect(res.status, `at ${at}`).toBe(404);
    expect(JSON.parse(res.text()), `at ${at}`).toMatchObject(NOT_FOUND);
    expect(res.headers.get("cache-control"), `at ${at}`).toBe("no-store");
  }
}

/** Asserts that the result is served, with `text` for its bytes, at each of `times`. */
async function expectServedAt(
  sha256: string,
  times: bigint[],
  text: string,
  app: App = appWith(),
): Promise<void> {
  for (const at of times) {
    nowNs = at;
    const res = await get(`/v1/blobs/${sha256}`, app);
    expect(res.status, `at ${at}`).toBe(200);
    expect(res.text(), `at ${at}`).toBe(text);
  }
}

test("an_upload_is_recorded_for_its_task_and_account", async () => {
  const base = await seed();
  await openTask(2, REVEAL_DEADLINE, [carol]);
  const hash = sha256Hex("shared work");
  expect(await uploadCount()).toBe(0);

  // New bytes are stored, and recorded for the account that sent them and the task they name.
  const first = await post("/v1/blobs", resultBody("shared work", "1"), alice);
  expect(first.body.sha256).toBe(hash);
  expect(await uploadsOf(hash)).toEqual([{ task_id: "1", account: alice }]);
  expect(await hasResultUpload(deps.db, hash, 1n, alice)).toBe(true);
  expect(await hasResultUpload(deps.db, hash, 2n, alice)).toBe(false);

  // The same upload again is the same record.
  expect((await post("/v1/blobs", resultBody("shared work", "1"), alice)).status).toBe(200);
  expect(await uploadsOf(hash)).toEqual([{ task_id: "1", account: alice }]);

  // Bytes already stored as a result, by anyone, are recorded for every account that sends them
  // after, for the task each names, for as long as they are not served (the tests of P03-R22, at the
  // end). There is still one blob, and it is alice's.
  expect((await post("/v1/blobs", resultBody("shared work", "1"), bob)).status).toBe(200);
  expect((await post("/v1/blobs", resultBody("shared work", "2"), carol)).status).toBe(200);
  expect(await uploadsOf(hash)).toEqual([
    { task_id: "1", account: alice },
    { task_id: "1", account: bob },
    { task_id: "2", account: carol },
  ]);
  expect(await blobCount()).toBe(base + 1);
  expect(await rowOf(hash)).toMatchObject({ kind: "result", task_id: "1", uploader: alice });
});

test("a_refused_upload_records_nothing", async () => {
  const base = await seed();
  const refused = async (body: unknown, account: string, status: number) => {
    const res = await post<ErrorBody>("/v1/blobs", body, account);
    expect(res.status, JSON.stringify(res.body)).toBe(status);
  };

  // No entry on the task is a 403, no such task a 404, and a body that is wrong a 400.
  await refused(resultBody("an answer", "1"), carol, 403);
  await refused(resultBody("an answer", "77"), alice, 404);
  await refused(resultBody("an answer", undefined), alice, 400);
  await refused(resultBody("an answer", "1", { content_base64: "QUJD\n" }), alice, 400);

  // A document of another kind is no result, whether it is stored already or not: a 400, and the
  // brief has no record of a result.
  const brief = canonicalJson({ ...FIXTURE_BRIEF, title: "Also an answer" });
  expect((await post("/v1/blobs", blobBody("brief", brief), alice)).status).toBe(200);
  await refused(resultBody(brief, "1", { content_type: "application/json" }), alice, 400);

  expect(await uploadCount()).toBe(0);
  expect(await blobCount()).toBe(base + 1);
});

test("a_copy_reveal_without_an_upload_never_publishes", async () => {
  await seedLifecycle(deps.db);
  // Carol enters task 2, which closes its reveals at `slow`. Alice enters task 3, which closes them
  // at `fast`, before it. Carol has the bytes and sends them for her task. Alice has only the hash.
  const slow = REVEAL_DEADLINE + 1_000n * SECOND;
  const fast = REVEAL_DEADLINE + 500n * SECOND;
  await openTask(2, slow, [carol]);
  await openTask(3, fast, [alice]);
  const waiting = [TEST_NOW, fast - 1n, fast, fast + 1n, slow - 1n];
  const served = [slow, slow + 1n, slow + 3600n * SECOND];

  // Alice's copy of the hash lands in the same block as carol's reveal, ahead of it, so it has the
  // lower event id and is the first reveal of the hash. With no upload behind it, it counts for
  // nothing: the bytes wait for the task of carol, who has them.
  const answer = "the answer is 42";
  const hash = sha256Hex(answer);
  expect((await post("/v1/blobs", resultBody(answer, "2"), carol)).body.sha256).toBe(hash);
  await apply(revealLine(3, alice, answer), revealLine(2, carol, answer));
  const sameBlock = await revealsOf(hash);
  expect(sameBlock.map((r) => r.task_id)).toEqual(["3", "2"]);
  expect(sameBlock[0]?.height).toBe(sameBlock[1]?.height);
  await expectHiddenAt(hash, waiting);
  await expectServedAt(hash, served, answer);

  // So does a copy in a block of its own before carol's.
  const other = "another answer";
  const otherHash = sha256Hex(other);
  await post("/v1/blobs", resultBody(other, "2"), carol);
  await reveal(3, alice, other);
  await reveal(2, carol, other);
  expect((await revealsOf(otherHash)).map((r) => r.task_id)).toEqual(["3", "2"]);
  await expectHiddenAt(otherHash, waiting);
  await expectServedAt(otherHash, served, other);
});

test("an_upload_backs_only_the_reveal_of_its_own_account_and_task", async () => {
  await seedLifecycle(deps.db);
  const far = REVEAL_DEADLINE + 1_000n * SECOND;
  const soon = REVEAL_DEADLINE + 500n * SECOND;
  await openTask(2, far, [carol, alice]);
  await openTask(3, soon, [carol]);

  // Carol sends her result for task 2, and for no other task. Alice entered task 2 as well, and
  // carol entered task 3.
  const answer = "the answer is 42";
  const hash = (await post("/v1/blobs", resultBody(answer, "2"), carol)).body.sha256;
  expect(await uploadsOf(hash)).toEqual([{ task_id: "2", account: carol }]);

  // Alice reveals the hash in task 2, where the bytes were sent, but they were not sent by her. Carol
  // reveals it in task 3, where she sent nothing. An upload backs the reveal of the same account in
  // the same task, and neither of these, so the bytes are not served at any time.
  await reveal(3, carol, answer);
  await reveal(2, alice, answer);
  expect((await revealsOf(hash)).map((r) => r.task_id)).toEqual(["3", "2"]);
  await expectHiddenAt(hash, [TEST_NOW, soon, soon + 1n, far, far + 1_000_000n * SECOND]);

  // Carol's reveal in task 2 is the one that is backed, and the bytes are served from its deadline.
  await reveal(2, carol, answer);
  await expectHiddenAt(hash, [soon, far - 1n]);
  await expectServedAt(hash, [far, far + 1n], answer);
});

test("a_failed_reveal_is_not_published_by_a_copy", async () => {
  await seedLifecycle(deps.db);
  const far = REVEAL_DEADLINE + 1_000n * SECOND;
  const soon = REVEAL_DEADLINE + 500n * SECOND;
  await openTask(2, far, [carol]);
  await openTask(3, soon, [alice]);

  // Carol sends her result for task 2, and her reveal never lands: it ran late or out of gas, and
  // the indexer skips a failed receipt. The hash is in the arguments of her transaction all the
  // same, so alice commits to it in task 3 and reveals it there, without the bytes.
  const answer = "the answer is 42";
  const hash = (await post("/v1/blobs", resultBody(answer, "2"), carol)).body.sha256;
  expect(await reveal(3, alice, answer)).toBe(hash);
  expect((await revealsOf(hash)).map((r) => r.task_id)).toEqual(["3"]);

  // The bytes are not served: not when alice's task closes, not when carol's does, not after.
  await expectHiddenAt(hash, [
    TEST_NOW,
    soon - 1n,
    soon,
    soon + 1n,
    far,
    far + 1_000_000n * SECOND,
  ]);

  // Alice's copy did not take anything from carol. If her reveal does land after all (the index was
  // only slow to see it), the bytes are served from the deadline of her task.
  await reveal(2, carol, answer);
  await expectHiddenAt(hash, [soon, far - 1n]);
  await expectServedAt(hash, [far, far + 1n], answer);
});

test("identical_uploads_by_two_entrants_both_count", async () => {
  await seedLifecycle(deps.db);
  const far = REVEAL_DEADLINE + 1_000n * SECOND;
  const soon = REVEAL_DEADLINE + 500n * SECOND;
  await openTask(2, far, [carol]);
  await openTask(3, soon, [alice]);

  // Carol and alice have the same bytes, and each sends them for the task she entered. There is one
  // blob, carol's since she sent it first, and a record for each of them.
  const shared = "the same answer";
  const hash = sha256Hex(shared);
  const first = await post("/v1/blobs", resultBody(shared, "2"), carol);
  const second = await post("/v1/blobs", resultBody(shared, "3"), alice);
  expect(second.body).toEqual(first.body);
  expect(await rowOf(hash)).toMatchObject({ task_id: "2", uploader: carol });
  expect(await uploadsOf(hash)).toEqual([
    { task_id: "2", account: carol },
    { task_id: "3", account: alice },
  ]);

  // Alice sent them second but reveals first, and her reveal counts: the bytes are served when her
  // task closes, though the blob is carol's.
  await reveal(3, alice, shared);
  await reveal(2, carol, shared);
  await expectHiddenAt(hash, [TEST_NOW, soon - 1n]);
  await expectServedAt(hash, [soon, far - 1n, far], shared);

  // Carol, who sent them first, can be the first to reveal as well. Alice's reveal is backed by an
  // upload too but comes after, so the bytes wait for the task of carol, which closes later.
  const other = "a second shared answer";
  const otherHash = sha256Hex(other);
  await post("/v1/blobs", resultBody(other, "2"), carol);
  await post("/v1/blobs", resultBody(other, "3"), alice);
  await reveal(2, carol, other);
  await reveal(3, alice, other);
  await expectHiddenAt(otherHash, [TEST_NOW, soon, soon + 1n, far - 1n]);
  await expectServedAt(otherHash, [far, far + 1n], other);
});

test("a_first_reveal_in_an_unindexed_task_keeps_the_bytes_hidden", async () => {
  await seedLifecycle(deps.db);
  const soon = REVEAL_DEADLINE + 500n * SECOND;
  const late = REVEAL_DEADLINE + 900n * SECOND;
  await openTask(3, soon, [carol]);

  // Alice revealed the bytes first, in task 7, which the index does not hold. She uploaded them for
  // it when it did: the upload route takes a result only for a task the index knows, so that record
  // is put in directly. Carol reveals them in task 3, which the index holds, and uploads them.
  const answer = "the answer is 42";
  const hash = await reveal(7, alice, answer);
  await recordResultUpload(deps.db, { sha256: hash, taskId: 7n, account: alice });
  await reveal(3, carol, answer);
  expect((await post("/v1/blobs", resultBody(answer, "3"), carol)).body.sha256).toBe(hash);
  expect((await revealsOf(hash)).map((r) => r.task_id)).toEqual(["7", "3"]);

  // The first reveal is in a task whose deadline the index cannot tell, so nothing is served, not
  // even from the deadline of task 3, the first one that it does know.
  await expectHiddenAt(hash, [TEST_NOW, soon - 1n, soon, late, late + 1_000_000n * SECOND]);

  // Once the index has task 7, the bytes are served from its deadline.
  await openTask(7, late, []);
  await expectHiddenAt(hash, [soon, late - 1n]);
  await expectServedAt(hash, [late, late + 1n], answer);
});

test("reveals_in_one_block_are_ordered_by_event_id", async () => {
  await seedLifecycle(deps.db);
  const far = REVEAL_DEADLINE + 1_000n * SECOND;
  const soon = REVEAL_DEADLINE + 500n * SECOND;
  await openTask(2, far, [carol]);
  await openTask(3, soon, [alice]);

  // Carol and alice both have the bytes, and reveal them in the same block. Their reveals are at one
  // height, so the order in which the index stored them is what says which came first.
  const bytes = { carol: "carol is first", alice: "alice is first" };
  for (const answer of Object.values(bytes)) {
    await post("/v1/blobs", resultBody(answer, "2"), carol);
    await post("/v1/blobs", resultBody(answer, "3"), alice);
  }
  await apply(revealLine(2, carol, bytes.carol), revealLine(3, alice, bytes.carol));
  await apply(revealLine(3, alice, bytes.alice), revealLine(2, carol, bytes.alice));

  const carolHash = sha256Hex(bytes.carol);
  const carolFirst = await revealsOf(carolHash);
  expect(carolFirst.map((r) => r.task_id)).toEqual(["2", "3"]);
  expect(carolFirst[0]?.height).toBe(carolFirst[1]?.height);
  const aliceHash = sha256Hex(bytes.alice);
  const aliceFirst = await revealsOf(aliceHash);
  expect(aliceFirst.map((r) => r.task_id)).toEqual(["3", "2"]);
  expect(aliceFirst[0]?.height).toBe(aliceFirst[1]?.height);

  // The lower id wins the tie, whichever of the two tasks closes first.
  await expectHiddenAt(carolHash, [TEST_NOW, soon, soon + 1n, far - 1n]);
  await expectServedAt(carolHash, [far, far + 1n], bytes.carol);
  await expectHiddenAt(aliceHash, [TEST_NOW, soon - 1n]);
  await expectServedAt(aliceHash, [soon, far], bytes.alice);
});

test("scorecard_waits_for_every_task_sharing_its_heldout", async () => {
  const tooEarly = { error: "too_early", message: "the task's reveal window has not closed" };
  const upload = (document: Scorecard) => blobBody("scorecard", canonicalJson(document));

  // A scorecard shows the held-out document its task was judged against. Tasks 2 and 3 use the same
  // one and close their reveals a minute apart. Task 4 has a held-out of its own, and closes later.
  // All of them are the poster's: the task of another account does not count
  // (a_strangers_copy_of_a_heldout_does_not_hold_a_scorecard_back).
  const minute = REVEAL_DEADLINE + 60n * SECOND;
  const hour = REVEAL_DEADLINE + 3600n * SECOND;
  const shared = sha256Hex("a held-out document that two tasks use");
  await openTask(2, REVEAL_DEADLINE, [], { heldout_commitment: shared });
  await openTask(3, minute, [], { heldout_commitment: shared });
  await openTask(4, hour, [], { heldout_commitment: sha256Hex("a held-out document of its own") });

  // Task 2 has closed its reveals but task 3, which shares its held-out, has not: publishing the
  // scorecard of task 2 would give the answers to a task that still takes reveals. The verifier and
  // the poster are told to wait, and whoever has no right to upload is told that first.
  nowNs = REVEAL_DEADLINE;
  for (const account of [judge, poster]) {
    const early = await post<ErrorBody>("/v1/blobs", upload(scorecardBy(account, "2")), account);
    expect([early.status, early.body], account).toEqual([409, tooEarly]);
  }
  const stranger = await post<ErrorBody>("/v1/blobs", upload(scorecardBy(alice, "2")), alice);
  expect([stranger.status, stranger.body.error]).toEqual([403, "forbidden"]);
  nowNs = minute - 1n;
  expect((await post("/v1/blobs", upload(scorecardOf("2")), judge)).status).toBe(409);
  expect(await blobCount()).toBe(0);

  // When task 3 closes, both may publish. Task 4 is still open, and shares nothing with them.
  nowNs = minute;
  expect((await post("/v1/blobs", upload(scorecardOf("2")), judge)).status).toBe(200);
  expect((await post("/v1/blobs", upload(scorecardBy(poster, "3")), poster)).status).toBe(200);
  const own = await post<ErrorBody>("/v1/blobs", upload(scorecardOf("4")), judge);
  expect([own.status, own.body]).toEqual([409, tooEarly]);
  nowNs = hour;
  expect((await post("/v1/blobs", upload(scorecardOf("4")), judge)).status).toBe(200);
  expect(await blobCount()).toBe(3);

  // Tasks that have no held-out share none: task 5 is not held back for task 6, which has none either.
  const withoutHeldout = (id: number, deadline: bigint) =>
    eventLine("task_created", {
      id: String(id),
      heldout_commitment: null,
      reveal_deadline: deadline.toString(),
      pick_deadline: (deadline + 60n * SECOND).toString(),
      fallback_deadline: (deadline + 120n * SECOND).toString(),
    });
  await apply(withoutHeldout(5, hour), withoutHeldout(6, hour + 3600n * SECOND));
  expect((await post("/v1/blobs", upload(scorecardOf("5")), judge)).status).toBe(200);
});

test("a_strangers_copy_of_a_heldout_does_not_hold_a_scorecard_back", async () => {
  const tooEarly = { error: "too_early", message: "the task's reveal window has not closed" };
  const upload = (document: Scorecard) => blobBody("scorecard", canonicalJson(document));

  // The commitment of a held-out is public once its task is posted, so anyone can put it in a task
  // of their own, with a reveal deadline as far away as they like. The wait is for a poster who
  // reuses their own held-out. The Judge takes a held-out only from the poster of a task, so a task
  // of another account can never be judged against it, and has no answers to be given away.
  // Tasks 2 and 3 are the poster's and close a minute apart. Carol's task 4 copies their commitment
  // and closes eleven days after.
  const minute = REVEAL_DEADLINE + 60n * SECOND;
  const faraway = REVEAL_DEADLINE + 1_000_000n * SECOND;
  const shared = sha256Hex("a held-out document that a stranger copied");
  await openTask(2, REVEAL_DEADLINE, [], { heldout_commitment: shared });
  await openTask(3, minute, [], { heldout_commitment: shared });
  await openTask(4, faraway, [], { heldout_commitment: shared, poster: carol });

  // The poster's own task 3 holds the scorecard of task 2 back until it closes.
  nowNs = REVEAL_DEADLINE;
  const early = await post<ErrorBody>("/v1/blobs", upload(scorecardOf("2")), judge);
  expect([early.status, early.body]).toEqual([409, tooEarly]);
  nowNs = minute - 1n;
  expect((await post("/v1/blobs", upload(scorecardBy(poster, "2")), poster)).status).toBe(409);
  expect(await blobCount()).toBe(0);

  // Carol's task has days to run, and holds nothing back.
  nowNs = minute;
  expect((await post("/v1/blobs", upload(scorecardOf("2")), judge)).status).toBe(200);
  expect((await post("/v1/blobs", upload(scorecardBy(poster, "3")), poster)).status).toBe(200);
  expect(await blobCount()).toBe(2);

  // Her own task waits for its own reveal window, like any other.
  const own = await post<ErrorBody>("/v1/blobs", upload(scorecardOf("4")), judge);
  expect([own.status, own.body]).toEqual([409, tooEarly]);
  nowNs = faraway;
  expect((await post("/v1/blobs", upload(scorecardOf("4")), judge)).status).toBe(200);
});

test("scorecard_route_hides_a_stored_scorecard_it_cannot_write_again", async () => {
  await seedLifecycle(deps.db);
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  const errored = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    // A row from before the canonical form refused a lone surrogate: JSON.stringify wrote it as an
    // escape, and it parses, but it can no longer be written as canonical JSON.
    const document = scorecardOf("3", {
      entries: [
        {
          account: alice,
          content_hash: sha256Hex("x"),
          uri: "ipfs://x",
          committed_at_block: "65",
          score: 10,
          passed: false,
          reasons: ["a\ud800b"],
        },
      ],
      winners: PICKED_WINNERS,
    });
    expect(() => canonicalJson(document)).toThrow(/lone surrogate/);
    const bytes = utf8(JSON.stringify(document));
    const hash = await putBlob(deps.db, {
      kind: "scorecard",
      contentType: "application/json",
      bytes,
      uploader: judge,
      isPublic: true,
    });
    await apply(taskLine(3), eventLine("picked", { task_id: "3", scorecard_hash: hash }));
    const app = createApp(deps);

    // Not a 500: the same answer as for a scorecard that is not there, and one warning. It names the
    // task and the kind of error and nothing of the document: the text of the error says where in it.
    const res = await get("/v1/scorecards/3", app);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(res.text())).toEqual({ error: "not_found", message: "no such scorecard" });
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned).toHaveBeenCalledWith(
      "api: scorecard of task 3 is not served, it cannot be written as canonical JSON (TypeError)",
    );
    expect(errored).not.toHaveBeenCalled();
    // Task 1 was settled with a scorecard that was never stored. It is the same answer, unwarned.
    const absent = await get("/v1/scorecards/1", app);
    expect([absent.status, absent.text()]).toEqual([404, res.text()]);
    expect(warned).toHaveBeenCalledTimes(1);

    // The stored bytes are still the blob's, which hands out bytes and reads no document.
    expect((await get(`/v1/blobs/${hash}`, app)).bytes).toEqual(bytes);
  } finally {
    warned.mockRestore();
    errored.mockRestore();
  }
});

// ---- Records only before publication (P03-R22) ------------------------------------------------

// Bytes that are served are public, so sending them proves nothing: anyone can read them. The upload
// route records an upload only while the bytes are not served. Otherwise a copier whose reveal of the
// hash came first could read the published bytes and send them for its own task, which closes later.
// Its reveal would then be the first one that counts, and the bytes would be hidden again.

test("an_upload_of_published_bytes_records_nothing", async () => {
  await seedLifecycle(deps.db);
  const soon = REVEAL_DEADLINE + 500n * SECOND;
  const far = REVEAL_DEADLINE + 1_000n * SECOND;
  await openTask(2, soon, [carol]);
  await openTask(3, far, [alice]);

  // Carol has the bytes and sends them for her task. Alice has only the hash, and reveals it in her
  // task, which closes later, before carol's reveal lands. Hers is the first reveal, and no upload
  // backs it, so the bytes wait for the task of carol.
  const answer = "the answer is 42";
  const hash = (await post("/v1/blobs", resultBody(answer, "2"), carol)).body.sha256;
  await reveal(3, alice, answer);
  await reveal(2, carol, answer);
  expect((await revealsOf(hash)).map((r) => r.task_id)).toEqual(["3", "2"]);
  await expectHiddenAt(hash, [TEST_NOW, soon - 1n]);

  // At carol's deadline the bytes are out, and any cache may keep them for a year. Alice reads them
  // and sends them for her own task. She is told it went through, and nothing is recorded for her.
  nowNs = soon;
  const published = await get(`/v1/blobs/${hash}`);
  expect(published.status).toBe(200);
  expect(published.headers.get("cache-control")).toBe(CACHE_CONTROL);
  const copy = await post("/v1/blobs", resultBody(published.text(), "3"), alice);
  expect([copy.status, copy.body.sha256]).toEqual([200, hash]);
  expect(await hasResultUpload(deps.db, hash, 3n, alice)).toBe(false);
  expect(await uploadsOf(hash)).toEqual([{ task_id: "2", account: carol }]);

  // So her reveal did not become the first one that counts, and the bytes stay served: not hidden
  // again from carol's deadline to her own.
  await expectServedAt(hash, [soon, soon + 1n, far - 1n, far], answer);
});

test("an_upload_is_recorded_until_the_moment_the_bytes_are_served", async () => {
  await seedLifecycle(deps.db);
  const soon = REVEAL_DEADLINE + 500n * SECOND;
  const far = REVEAL_DEADLINE + 1_000n * SECOND;
  await openTask(2, soon, [carol]);
  await openTask(3, far, [alice, bob]);

  // Carol's reveal is the only one, so her bytes are served when her task closes, at `soon`.
  const answer = "the answer is 42";
  const hash = (await post("/v1/blobs", resultBody(answer, "2"), carol)).body.sha256;
  await reveal(2, carol, answer);

  // Bob and alice have the same bytes, each from work of their own. Bob sends them in the last
  // instant that they are hidden, and is recorded. Alice sends them in the first instant that they
  // are out, and is not. Both are told it went through.
  nowNs = soon - 1n;
  expect((await post("/v1/blobs", resultBody(answer, "3"), bob)).status).toBe(200);
  nowNs = soon;
  expect((await post("/v1/blobs", resultBody(answer, "3"), alice)).status).toBe(200);
  expect(await uploadsOf(hash)).toEqual([
    { task_id: "2", account: carol },
    { task_id: "3", account: bob },
  ]);
});

test("a_result_is_usable_by_its_uploader_while_hidden_and_by_anyone_once_served", async () => {
  await seedLifecycle(deps.db);
  const soon = REVEAL_DEADLINE + 500n * SECOND;
  const far = REVEAL_DEADLINE + 1_000n * SECOND;
  await openTask(2, soon, [carol]);
  await openTask(3, far, [alice, bob]);

  // Carol sends her bytes for her task and reveals them. Alice reveals the hash in hers, without them.
  const answer = "the answer is 42";
  const hash = (await post("/v1/blobs", resultBody(answer, "2"), carol)).body.sha256;
  await reveal(2, carol, answer);
  await reveal(3, alice, answer);
  const usable = (taskId: bigint, account: string, at: bigint) =>
    resultUsable(deps.db, hash, taskId, account, at);

  // While the bytes are hidden, only an upload makes them usable: that of the same account, for the
  // same task. A copy of the hash is not an upload.
  for (const at of [TEST_NOW, soon - 1n]) {
    expect(await usable(2n, carol, at), `carol, task 2, at ${at}`).toBe(true);
    expect(await usable(3n, alice, at), `alice, task 3, at ${at}`).toBe(false);
    expect(await usable(3n, bob, at), `bob, task 3, at ${at}`).toBe(false);
    expect(await usable(2n, alice, at), `alice, task 2, at ${at}`).toBe(false);
    expect(await usable(3n, carol, at), `carol, task 3, at ${at}`).toBe(false);
  }

  // Once the API serves them they are as public as any URL, and a reveal of them is as good with no
  // record as with one. Alice never sent them, and bob sends them now, after they are out.
  nowNs = soon;
  expect((await post("/v1/blobs", resultBody(answer, "3"), bob)).status).toBe(200);
  for (const at of [soon, far, far + 1_000_000n * SECOND]) {
    expect(await usable(2n, carol, at), `carol, task 2, at ${at}`).toBe(true);
    expect(await usable(3n, alice, at), `alice, task 3, at ${at}`).toBe(true);
    expect(await usable(3n, bob, at), `bob, task 3, at ${at}`).toBe(true);
  }
  expect(await uploadsOf(hash)).toEqual([{ task_id: "2", account: carol }]);

  // Bytes the store does not hold are usable by no one. Nor is a held-out document, which it holds
  // and serves to no one.
  const heldout = await post(
    "/v1/heldout",
    { commitment: HELDOUT_HASH, content_base64: b64(HELDOUT_BYTES) },
    poster,
  );
  expect(heldout.status).toBe(200);
  expect(await resultUsable(deps.db, sha256Hex("not stored"), 2n, carol, far)).toBe(false);
  expect(await resultUsable(deps.db, HELDOUT_HASH, 2n, poster, far)).toBe(false);
});

test("a_result_stored_before_the_records_is_served_after_the_upgrade", async () => {
  // A database that was set up before the records existed: migration 0001 alone, with no table of
  // them.
  const dir = await mkdtemp(join(tmpdir(), "tender-0001-"));
  const old = await openDb("pglite:memory");
  try {
    await copyFile(
      new URL("../../db/migrations/0001_init.sql", import.meta.url),
      join(dir, "0001_init.sql"),
    );
    expect(await migrate(old, dir)).toEqual(["0001_init.sql"]);
    await seedLifecycle(old);
    const applyOld = (...lines: string[]) =>
      applyBlock(old, blockOf(nextHeight++, lines), FIXTURE_OPTIONS);

    // Carol entered task 2, which closes its reveals at `soon`. She sent her result for it, and the
    // upload route of that time stored what it stored: a private row, with her and the task.
    const soon = REVEAL_DEADLINE + 500n * SECOND;
    await applyOld(
      taskLine(2, {
        reveal_deadline: soon.toString(),
        pick_deadline: (soon + 60n * SECOND).toString(),
        fallback_deadline: (soon + 120n * SECOND).toString(),
      }),
      eventLine("committed", { task_id: "2", account: carol, block_height: "130" }),
    );
    const answer = "the answer is 42";
    const hash = await putBlob(old, {
      kind: "result",
      contentType: "text/plain",
      bytes: utf8(answer),
      taskId: 2n,
      uploader: carol,
      isPublic: false,
    });
    await old.query("update blobs set created_at = $2 where sha256 = $1", [
      hash,
      "2026-10-01T09:00:00Z",
    ]);
    await applyOld(revealLine(2, carol, answer));

    // Rows that are not a result with a task and an uploader are no one's upload of a result.
    const others = [
      { kind: "brief", bytes: canonicalJson({ ...FIXTURE_BRIEF, title: "Not a result" }) },
      { kind: "heldout", bytes: HELDOUT_BYTES, uploader: poster },
      { kind: "scorecard", bytes: canonicalJson(scorecardOf("2")), taskId: 2n, uploader: judge },
      { kind: "result", bytes: utf8("sent by no one"), taskId: 2n, uploader: undefined },
      { kind: "result", bytes: utf8("sent for no task"), taskId: undefined },
    ] as const;
    for (const other of others) {
      await putBlob(old, {
        contentType: "application/json",
        uploader: carol,
        isPublic: false,
        ...other,
      });
    }

    // The upgrade gives the result its record: carol's, for task 2, from the time she sent it.
    expect(await migrate(old)).toEqual(["0002_result_uploads.sql", "0003_heldout_uploads.sql"]);
    expect(
      await old.query(
        "select sha256, task_id::text as task_id, account, uploaded_at from result_uploads",
      ),
    ).toEqual([
      { sha256: hash, task_id: "2", account: carol, uploaded_at: new Date("2026-10-01T09:00:00Z") },
    ]);

    // So her reveal is still backed, and the bytes are served from the deadline of her task as
    // before: hidden until it, served from it.
    const app = appWith({ db: old });
    await expectHiddenAt(hash, [TEST_NOW, soon - 1n], app);
    await expectServedAt(hash, [soon, soon + 1n], answer, app);
  } finally {
    await old.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Bytes that are not the uploader's to fix (I2) --------------------------------------------

test("a_result_may_not_be_a_document_of_another_kind", async () => {
  const base = await seed();
  // The canonical bytes of each kind of document that another route stores. Stored first as
  // somebody's private result, they could never be that document.
  const documents: Array<[string, Uint8Array]> = [
    ["a brief", canonicalJson({ ...FIXTURE_BRIEF, title: "Somebody else's brief" })],
    ["criteria", canonicalJson(CRITERIA)],
    ["a held-out document", HELDOUT_BYTES],
    ["a profile", canonicalJson({ ...FIXTURE_PROFILE, name: "Somebody else" })],
    ["a scorecard", canonicalJson(scorecardOf("1"))],
  ];
  for (const [what, bytes] of documents) {
    for (const contentType of ["application/json", "text/plain"]) {
      const body = resultBody(bytes, "1", { content_type: contentType });
      const res = await post<ErrorBody>("/v1/blobs", body, alice);
      expect([res.status, res.body], `${what} as ${contentType}`).toEqual([400, ANOTHER_KIND]);
    }
    expect(await rowOf(sha256Hex(bytes)), what).toBeNull();
  }
  expect(await blobCount()).toBe(base);
  expect(await uploadCount()).toBe(0);

  // An answer that happens to be such a document is the same answer with a newline at its end.
  // A document that is not in its canonical form, which could not be stored as its kind, is a
  // result, and so is JSON that fits no kind of document.
  const answers = [
    new Uint8Array([...HELDOUT_BYTES, 0x0a]),
    utf8(JSON.stringify(CRITERIA, null, 2)),
    canonicalJson({ total: 42 }),
  ];
  for (const bytes of answers) {
    const body = resultBody(bytes, "1", { content_type: "application/json" });
    expect((await post("/v1/blobs", body, alice)).status).toBe(200);
  }
  expect(await uploadCount()).toBe(answers.length);
});

/**
 * The team's Judge on this file's database and clock, as far as intake needs one: whether it takes
 * a task's documents. Intake asks the chain nothing, so its chain has nothing to say.
 */
function judgeOf(): JudgeDeps {
  return {
    db: deps.db,
    client: {
      getTask: async () => null,
      getAllEntries: async () => [],
      pick: async () => {
        throw new Error("intake does not pick");
      },
    },
    judgeAccount: judge,
    teamAccounts: [],
    publicUrl: "http://api.test",
    resultUploaded: async () => false,
    now: () => new Date(Number(nowNs / 1_000_000n)),
  };
}

/**
 * Task `id` of the poster, judged by the Judge, whose terms commit to `CRITERIA` and to `HELDOUT`
 * and whose brief is `brief`, as the indexer stores it once the poster has posted it.
 */
async function postedTask(id: number, brief: Uint8Array): Promise<void> {
  await apply(
    taskLine(id, {
      brief_hash: sha256Hex(brief),
      criteria_hash: sha256Hex(canonicalJson(CRITERIA)),
      heldout_commitment: HELDOUT_HASH,
    }),
  );
}

test("a_stranger_who_stores_the_heldout_first_does_not_keep_it_from_its_poster", async () => {
  // The first griefing order of I2: a stranger has the poster's held-out document (a seed's is in
  // the repository) and sends it to the held-out route first. Then the poster sends the same bytes
  // and the criteria, and the Judge takes the task.
  const brief = briefOf("The poster's task");
  await postedTask(5, brief);
  const heldout = { commitment: HELDOUT_HASH, content_base64: b64(HELDOUT_BYTES) };

  expect((await post("/v1/heldout", heldout, carol)).status).toBe(200);
  expect((await post("/v1/heldout", heldout, poster)).status).toBe(200);
  expect(
    (await post("/v1/blobs", blobBody("criteria", canonicalJson(CRITERIA)), poster)).status,
  ).toBe(200);
  expect((await post("/v1/blobs", blobBody("brief", brief), poster)).status).toBe(200);
  expect(await rowOf(HELDOUT_HASH)).toMatchObject({ uploader: carol, is_public: false });

  expect(await intakeTask(judgeOf(), 5n)).toBe("accepted");

  // The other order is no trouble either: the poster first, then the stranger, whose upload is
  // recorded and changes nothing for the poster's next task with other checks.
  const second = canonicalJson({ exact: { expected: ["43"] } });
  await apply(
    taskLine(6, {
      criteria_hash: sha256Hex(canonicalJson(CRITERIA)),
      heldout_commitment: sha256Hex(second),
    }),
  );
  const sent = { commitment: sha256Hex(second), content_base64: b64(second) };
  expect((await post("/v1/heldout", sent, poster)).status).toBe(200);
  expect((await post("/v1/heldout", sent, carol)).status).toBe(200);
  expect(await intakeTask(judgeOf(), 6n)).toBe("accepted");
});

test("an_entrant_cannot_store_a_posters_documents_first_as_its_result", async () => {
  // The second griefing order of I2: an entrant of any task (alice, on task 1) has the documents
  // of the poster's task and sends them as a result first, which would fix their kind as a private
  // result for good. Each is refused, and nothing is stored, so the poster's uploads that follow
  // are the documents, and the Judge takes the task.
  await seed();
  const brief = briefOf("The poster's other task");
  await postedTask(5, brief);
  const documents = [canonicalJson(CRITERIA), HELDOUT_BYTES, brief];
  for (const bytes of documents) {
    const asResult = await post<ErrorBody>("/v1/blobs", resultBody(bytes, "1"), alice);
    expect([asResult.status, asResult.body]).toEqual([400, ANOTHER_KIND]);
    expect(await rowOf(sha256Hex(bytes))).toBeNull();
  }
  expect(await uploadCount()).toBe(0);

  const heldout = { commitment: HELDOUT_HASH, content_base64: b64(HELDOUT_BYTES) };
  expect((await post("/v1/heldout", heldout, poster)).status).toBe(200);
  expect(
    (await post("/v1/blobs", blobBody("criteria", canonicalJson(CRITERIA)), poster)).status,
  ).toBe(200);
  expect((await post("/v1/blobs", blobBody("brief", brief), poster)).status).toBe(200);

  expect(await intakeTask(judgeOf(), 5n)).toBe("accepted");
  // The brief is served under the hash the task names.
  const served = await get(`/v1/blobs/${sha256Hex(brief)}`);
  expect([served.status, served.bytes]).toEqual([200, brief]);
});

// ---- Upload limits (I1) -----------------------------------------------------------------------

const HOUR_MS = 3_600_000;

/** The body that uploads `bytes` as a held-out document under their own hash. */
const heldoutBody = (bytes: Uint8Array) => ({
  commitment: sha256Hex(bytes),
  content_base64: b64(bytes),
});

/** Expects the refusal `status` with `body`, and a `Retry-After` within `windowMs`. */
function expectRefused(res: Reply<ErrorBody>, status: number, body: ErrorBody, windowMs: number) {
  expect([res.status, res.body]).toEqual([status, body]);
  const retryAfter = Number(res.headers.get("retry-after"));
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThanOrEqual(1);
  expect(retryAfter).toBeLessThanOrEqual(Math.ceil(windowMs / 1000));
}

const RATE_LIMITED: ErrorBody = {
  error: "rate_limited",
  message: "too many requests, try again later",
};
const UPLOADED_TOO_MUCH: ErrorBody = {
  error: "rate_limited",
  message: "this account has uploaded too many bytes, try again later",
};
const BLOBS_USED_UP: ErrorBody = {
  error: "unavailable",
  message: "the API is taking no more uploads for now, try again later",
};
const HELDOUTS_USED_UP: ErrorBody = {
  error: "unavailable",
  message: "the API is taking no more held-out documents for now, try again later",
};

test("uploads_are_counted_per_account_across_both_routes", async () => {
  await seed();
  const app = appWith({ rateLimits: { upload: { limit: 3, windowMs: HOUR_MS } } });
  const brief = (title: string) => blobBody("brief", briefOf(title));

  // A brief, a held-out document and an upload that is refused for what it is: three uploads.
  expect((await post("/v1/blobs", brief("one"), alice, app)).status).toBe(200);
  expect((await post("/v1/heldout", heldoutBody(HELDOUT_BYTES), alice, app)).status).toBe(200);
  expect((await post("/v1/blobs", { kind: "nonsense" }, alice, app)).status).toBe(400);

  // A fourth, to either route, is a 429 with `Retry-After`, and nothing of it is kept.
  const blobs = await blobCount();
  const another = canonicalJson({ exact: { expected: ["43"] } });
  expectRefused(await post("/v1/blobs", brief("two"), alice, app), 429, RATE_LIMITED, HOUR_MS);
  expectRefused(
    await post("/v1/heldout", heldoutBody(another), alice, app),
    429,
    RATE_LIMITED,
    HOUR_MS,
  );
  expect(await blobCount()).toBe(blobs);
  expect(await heldoutUploadersOf(sha256Hex(another))).toEqual([]);

  // Another account has a count of its own, though every request here has the same address.
  expect((await post("/v1/blobs", brief("bob"), bob, app)).status).toBe(200);

  // The team's accounts are not counted at all; the others still are.
  const team = appWith({
    teamAccounts: [carol],
    rateLimits: { upload: { limit: 1, windowMs: HOUR_MS } },
  });
  for (const title of ["ca1", "ca2", "ca3"]) {
    expect((await post("/v1/blobs", brief(title), carol, team)).status, title).toBe(200);
  }
  expect((await post("/v1/blobs", brief("bo1"), bob, team)).status).toBe(200);
  expect((await post("/v1/blobs", brief("bo2"), bob, team)).status).toBe(429);
});

test("upload_bytes_are_held_to_a_budget_for_each_account", async () => {
  await seed();
  const size = briefOf("one").length;
  const app = appWith({ rateLimits: { uploadBytes: { limit: 2 * size, windowMs: HOUR_MS } } });

  expect((await post("/v1/blobs", blobBody("brief", briefOf("one")), alice, app)).status).toBe(200);
  expect((await post("/v1/blobs", blobBody("brief", briefOf("two")), alice, app)).status).toBe(200);
  // A third is more than the account may store: a 429 that says when its window ends, with
  // nothing stored. The held-out route takes from the same budget.
  const blobs = await blobCount();
  expectRefused(
    await post("/v1/blobs", blobBody("brief", briefOf("six")), alice, app),
    429,
    UPLOADED_TOO_MUCH,
    HOUR_MS,
  );
  expectRefused(
    await post("/v1/heldout", heldoutBody(HELDOUT_BYTES), alice, app),
    429,
    UPLOADED_TOO_MUCH,
    HOUR_MS,
  );
  expect(await blobCount()).toBe(blobs);
  expect(await heldoutUploadersOf(HELDOUT_HASH)).toEqual([]);

  // Another account has a budget of its own, and a team account has none.
  expect((await post("/v1/blobs", blobBody("brief", briefOf("bob")), bob, app)).status).toBe(200);
  const team = appWith({
    teamAccounts: [carol],
    rateLimits: { uploadBytes: { limit: size, windowMs: HOUR_MS } },
  });
  for (const title of ["ca1", "ca2", "ca3"]) {
    const res = await post("/v1/blobs", blobBody("brief", briefOf(title)), carol, team);
    expect(res.status, title).toBe(200);
  }
});

test("each_route_has_a_pool_of_its_own_and_the_team_is_held_to_neither", async () => {
  await seed();
  const size = briefOf("one").length;
  const another = canonicalJson({ exact: { expected: ["43"] } });
  const app = appWith({
    teamAccounts: [carol],
    rateLimits: {
      blobBytesTotal: { limit: size, windowMs: HOUR_MS },
      heldoutBytesTotal: { limit: HELDOUT_BYTES.length, windowMs: HOUR_MS },
    },
  });
  const brief = (account: string, title: string) =>
    post<ErrorBody>("/v1/blobs", blobBody("brief", briefOf(title)), account, app);
  const heldout = (account: string, bytes: Uint8Array) =>
    post<ErrorBody>("/v1/heldout", heldoutBody(bytes), account, app);

  // Alice's brief takes all that the route of the other kinds takes in its hour: the next new
  // upload to it, by any account but the team's, is a 503 that says when the hour is over.
  expect((await brief(alice, "one")).status).toBe(200);
  const blobs = await blobCount();
  expectRefused(await brief(bob, "two"), 503, BLOBS_USED_UP, HOUR_MS);
  expect(await blobCount()).toBe(blobs);

  // A flood of other uploads cannot stop a poster's held-out document: that route has a pool of
  // its own. Used up in its turn, it refuses new held-out documents.
  expect((await heldout(poster, HELDOUT_BYTES)).status).toBe(200);
  expectRefused(await heldout(bob, another), 503, HELDOUTS_USED_UP, HOUR_MS);
  expect(await heldoutUploadersOf(sha256Hex(another))).toEqual([]);

  // The team's accounts are held to neither pool, and take from neither.
  expect((await brief(carol, "car")).status).toBe(200);
  expect((await heldout(carol, another)).status).toBe(200);
  expect(await heldoutUploadersOf(sha256Hex(another))).toEqual([carol]);
  expectRefused(await brief(bob, "two"), 503, BLOBS_USED_UP, HOUR_MS);
});

test("bytes_that_are_stored_already_cost_nothing", async () => {
  await seed();
  const size = briefOf("one").length;
  const app = appWith({
    rateLimits: {
      uploadBytes: { limit: size, windowMs: HOUR_MS },
      blobBytesTotal: { limit: 2 * size, windowMs: HOUR_MS },
      heldoutBytesTotal: { limit: HELDOUT_BYTES.length, windowMs: HOUR_MS },
    },
  });
  const brief = (account: string, title: string) =>
    post<ErrorBody>("/v1/blobs", blobBody("brief", briefOf(title)), account, app);

  // Alice's brief takes all of her budget. Sending it again, as she or anyone else may, stores no
  // new row and costs nothing, so it is taken whatever is left.
  expect((await brief(alice, "one")).status).toBe(200);
  expect((await brief(alice, "one")).status).toBe(200);
  expect((await brief(bob, "one")).status).toBe(200);
  // So bob still has his whole budget, and the route a brief's worth of room.
  expect((await brief(bob, "two")).status).toBe(200);
  expectRefused(await brief(alice, "six"), 429, UPLOADED_TOO_MUCH, HOUR_MS);

  // The same for a held-out document: the second account to send it is recorded, for nothing.
  const sent = heldoutBody(HELDOUT_BYTES);
  expect((await post("/v1/heldout", sent, carol, app)).status).toBe(200);
  expect((await post("/v1/heldout", sent, poster, app)).status).toBe(200);
  expect(await heldoutUploadersOf(HELDOUT_HASH)).toEqual([carol, poster]);
});

test("of_two_uploads_of_the_same_new_bytes_at_once_only_the_one_that_stores_them_pays", async () => {
  await seed();
  const size = briefOf("one").length;
  // Both uploads find the bytes not stored, and are charged, before either puts them: the puts are
  // held until both have looked. The second put stores no row, and its upload is given back what
  // it was charged.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lookups = 0;
  const racing: Db = {
    ...deps.db,
    query: (async (sql: string, params?: unknown[]) => {
      if (sql.includes("insert into blobs")) await held;
      const rows = await deps.db.query(sql, params);
      if (sql.includes("from blobs where sha256") && ++lookups === 2) release();
      return rows;
    }) as Db["query"],
  };
  const app = appWith({
    db: racing,
    rateLimits: { uploadBytes: { limit: 2 * size, windowMs: HOUR_MS } },
  });
  const send = (account: string, title: string) =>
    post<ErrorBody>("/v1/blobs", blobBody("brief", briefOf(title)), account, app);

  const both = await Promise.all([send(alice, "duo"), send(bob, "duo")]);
  expect(both.map((res) => res.status)).toEqual([200, 200]);
  // Each had room for two briefs. The one that stored the bytes has room for one more and the
  // other for two: three between them, where two would mean both had paid.
  let more = 0;
  for (const [account, titles] of [
    [alice, ["al1", "al2"]],
    [bob, ["bo1", "bo2"]],
  ] as const) {
    for (const title of titles) if ((await send(account, title)).status === 200) more += 1;
  }
  expect(more).toBe(3);
});

test("an_upload_that_is_refused_costs_nothing", async () => {
  await seed();
  const size = briefOf("one").length;
  const app = appWith({
    rateLimits: {
      uploadBytes: { limit: size, windowMs: HOUR_MS },
      blobBytesTotal: { limit: size, windowMs: HOUR_MS },
    },
  });
  // Bytes stored as somebody's result before, which no route stores as a brief.
  const taken = briefOf("tkn");
  await putBlob(deps.db, {
    kind: "result",
    contentType: "application/json",
    bytes: taken,
    taskId: 1n,
    uploader: alice,
    isPublic: false,
  });

  // Carol is refused, over and over: a body that is no upload, a brief that is not canonical, bytes
  // stored as another kind, a result for a task she has no entry on, content that is too large.
  const refusals: Array<[unknown, number]> = [
    [{ kind: "nonsense" }, 400],
    [blobBody("brief", utf8(JSON.stringify(FIXTURE_BRIEF, null, 2))), 400],
    [blobBody("brief", taken), 409],
    [resultBody("an answer", "1"), 403],
    [resultBody(new Uint8Array(LIMIT + 1), "1"), 413],
  ];
  for (const [body, status] of refusals) {
    expect((await post("/v1/blobs", body, carol, app)).status).toBe(status);
  }
  // None of it was charged: her budget and the route's pool still have room for a brief.
  expect((await post("/v1/blobs", blobBody("brief", briefOf("one")), carol, app)).status).toBe(200);
  expectRefused(
    await post<ErrorBody>("/v1/blobs", blobBody("brief", briefOf("two")), carol, app),
    429,
    UPLOADED_TOO_MUCH,
    HOUR_MS,
  );
});

test("an_upload_budget_lets_the_account_in_again_once_its_window_is_over", async () => {
  await seed();
  const size = briefOf("one").length;
  const app = appWith({ rateLimits: { uploadBytes: { limit: size, windowMs: 300 } } });
  const upload = (title: string) =>
    post<ErrorBody>("/v1/blobs", blobBody("brief", briefOf(title)), alice, app);

  expect((await upload("one")).status).toBe(200);
  expectRefused(await upload("two"), 429, UPLOADED_TOO_MUCH, 300);
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect((await upload("two")).status).toBe(200);
});
