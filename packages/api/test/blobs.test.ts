import { Buffer } from "node:buffer";
import { getBlob, putBlob, setBlobPublic } from "@tender/db";
import { applyBlock } from "@tender/indexer";
import {
  blockOf,
  eventLine,
  FIXTURE_ACCOUNTS,
  FIXTURE_BRIEF,
  FIXTURE_BRIEF_HASH,
  FIXTURE_OPTIONS,
  FIXTURE_PROFILE,
  FIXTURE_PROFILE_HASH,
} from "@tender/indexer/testing";
import { canonicalJson, type PublicCriteria, type Scorecard, sha256Hex } from "@tender/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { z } from "zod";
import { handleError } from "../src/format";
import {
  type AgentDetailResponse,
  type ApiDeps,
  createApp,
  type ErrorBody,
  type TaskDetailResponse,
} from "../src/index";
import { publicDocument } from "../src/queries";
import { type AuthVariables, blobRoutes, type RequireAuth } from "../src/routes/blobs";
import { resetDb, seedLifecycle, TEST_NOW, testDeps } from "./helpers";

// The blob store and the held-out intake. The upload routes are mounted on an app of their own
// with `stubAuth`, which reads the signed-in account from a header, because sign-in is a later task;
// `createApp` has a placeholder that refuses every upload, and `uploads_are_refused_without_sign_in`
// holds it to that. The two GET routes need no sign-in and are also read through `createApp`.
//
// The data is the lifecycle of `@tender/indexer/testing`: task 1 has the poster, the judge as its
// verifier, and alice and bob as entrants. Its reveal deadline is `REVEAL_DEADLINE`, and the clock
// is a variable, so a test can move it across the deadline.

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
  deps = await testDeps({ now: () => nowNs });
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

/** A `task_created` line for task `id`: the captured one, with the given fields replaced. */
function taskLine(id: number, over: Record<string, string> = {}): string {
  return eventLine("task_created", { id: String(id), ...over });
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

const NOT_FOUND = { error: "not_found", message: expect.any(String) };

// ---- The brief's tests ------------------------------------------------------------------------

test("result_hidden_until_reveal_deadline", async () => {
  await seedLifecycle(deps.db);
  const put = await post("/v1/blobs", resultBody("the answer is 42", "1"), alice);
  expect(put.status).toBe(200);
  const path = `/v1/blobs/${put.body.sha256}`;

  // Nobody reads it while the task is still taking reveals, the uploader included.
  for (const at of [TEST_NOW, REVEAL_DEADLINE - SECOND, REVEAL_DEADLINE - 1n]) {
    nowNs = at;
    const hidden = await get(path);
    expect(hidden.status, `at ${at}`).toBe(404);
    expect(JSON.parse(hidden.text())).toMatchObject(NOT_FOUND);
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

test("result_is_served_only_through_its_own_task", async () => {
  await seedLifecycle(deps.db);
  nowNs = REVEAL_DEADLINE + SECOND;
  // A result with no task, or with a task the index does not know, has no deadline to wait for.
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
  // Making a result row public does not skip the deadline either: the deadline is its only rule.
  const early = await post("/v1/blobs", resultBody("early", "1"), alice);
  nowNs = TEST_NOW;
  await setBlobPublic(deps.db, early.body.sha256, true);

  for (const sha256 of [noTask, lostTask, early.body.sha256]) {
    expect((await get(`/v1/blobs/${sha256}`)).status, sha256).toBe(404);
  }
  nowNs = REVEAL_DEADLINE;
  expect((await get(`/v1/blobs/${early.body.sha256}`)).status).toBe(200);
  expect((await get(`/v1/blobs/${noTask}`)).status).toBe(404);
  expect((await get(`/v1/blobs/${lostTask}`)).status).toBe(404);

  // Sending their bytes as the result of a task does not give them a deadline either. A row is moved
  // to a later deadline, and one bound to no known task has none to move from.
  for (const text of ["no task", "lost task"]) {
    expect((await post("/v1/blobs", resultBody(text, "1"), alice)).status, text).toBe(200);
  }
  expect((await get(`/v1/blobs/${noTask}`)).status).toBe(404);
  expect((await get(`/v1/blobs/${lostTask}`)).status).toBe(404);
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
  const upload = (document: Scorecard, over = {}) =>
    blobBody("scorecard", canonicalJson(document), over);

  // The verifier and the poster of task 1 may publish its scorecard.
  const byVerifier = await post("/v1/blobs", upload(scorecardOf("1")), judge);
  expect(byVerifier.status).toBe(200);
  const byPoster = await post(
    "/v1/blobs",
    upload(scorecardOf("1", { generated_at: "2026-10-30T11:00:00Z" })),
    poster,
  );
  expect(byPoster.status).toBe(200);
  expect(byPoster.body.sha256).not.toBe(byVerifier.body.sha256);

  // Nobody else may, the entrants included.
  for (const account of [alice, bob, carol]) {
    const refused = await post<ErrorBody>(
      "/v1/blobs",
      upload(scorecardOf("1", { generated_at: "2026-10-30T12:00:00Z" })),
      account,
    );
    expect(refused.status, account).toBe(403);
    expect(refused.body.error).toBe("forbidden");
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
  // It is stored private, as the poster's, under the hash the chain will hold as the commitment.
  expect(await rowOf(HELDOUT_HASH)).toEqual({
    kind: "heldout",
    content_type: "application/json",
    task_id: null,
    uploader: poster,
    is_public: false,
  });

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
  const result = await post("/v1/blobs", resultBody("plain answer", "1"), alice);
  const asJson = await post(
    "/v1/blobs",
    resultBody('{"total":"1.00"}', "1", { content_type: "application/json" }),
    alice,
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
  // The real app: until sign-in exists nobody can upload, whatever they send.
  const app = createApp(deps);
  const tries: Array<[string, unknown]> = [
    ["/v1/blobs", blobBody("brief", canonicalJson(FIXTURE_BRIEF))],
    ["/v1/heldout", { commitment: HELDOUT_HASH, content_base64: b64(HELDOUT_BYTES) }],
  ];
  for (const [path, body] of tries) {
    const signedIn: Array<Record<string, string>> = [
      {},
      { authorization: "Bearer anything" },
      { "x-test-account": alice },
    ];
    for (const headers of signedIn) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      expect(res.status, path).toBe(401);
      expect(await res.json()).toEqual({
        error: "unauthorized",
        message: "sign-in is not available yet",
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

  // Text that is not UTF-8, or not JSON, is not canonical JSON either.
  for (const bytes of [new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]), utf8("{"), utf8("")]) {
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

  const publicBrief = canonicalJson({ ...FIXTURE_BRIEF, title: "Already public" });
  const brief = await post("/v1/blobs", blobBody("brief", publicBrief), carol);
  const asResult = await post<ErrorBody>(
    "/v1/blobs",
    resultBody(publicBrief, "1", { content_type: "application/json" }),
    alice,
  );
  expect(asResult.status).toBe(409);
  expect(asResult.body).toEqual(conflict);
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

test("heldout_from_another_uploader_is_409", async () => {
  const body = { commitment: HELDOUT_HASH, content_base64: b64(HELDOUT_BYTES) };
  expect((await post("/v1/heldout", body, poster)).status).toBe(200);

  // Another account holding the same bytes would leave a document the Judge does not accept
  // (it takes a held-out only from the task's poster), so the poster is told now.
  const other = await post<ErrorBody>("/v1/heldout", body, carol);
  expect(other.status).toBe(409);
  expect(other.body.error).toBe("conflict");
  expect(await rowOf(HELDOUT_HASH)).toMatchObject({ uploader: poster, is_public: false });

  // The poster can say it again, and it is the same blob.
  const again = await post("/v1/heldout", body, poster);
  expect(again.status).toBe(200);
  expect(again.body).toEqual({ ok: true });
  expect(await blobCount()).toBe(1);

  // Carol, first with other bytes, is the uploader of those.
  const mine = canonicalJson({ exact: { expected: ["44"] } });
  expect(
    (await post("/v1/heldout", { commitment: sha256Hex(mine), content_base64: b64(mine) }, carol))
      .status,
  ).toBe(200);
  expect((await rowOf(sha256Hex(mine)))?.uploader).toBe(carol);
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

test("result_visibility_never_earlier_than_any_uploaders_deadline", async () => {
  await seedLifecycle(deps.db);
  // Task 2 reveals 1000 seconds after task 1. Alice entered task 1 and carol entered task 2.
  const late = REVEAL_DEADLINE + 1000n * SECOND;
  await apply(
    taskLine(2, {
      reveal_deadline: late.toString(),
      pick_deadline: (late + 60n * SECOND).toString(),
      fallback_deadline: (late + 120n * SECOND).toString(),
    }),
    eventLine("committed", { task_id: "2", account: carol, block_height: "130" }),
  );

  // The same bytes sent for both tasks are one row. Whichever task they were sent for first, they
  // wait for the later deadline, and nothing else about the row changes.
  const forTask1 = { task: "1", by: alice };
  const forTask2 = { task: "2", by: carol };
  const orders = [
    { name: "task 1 first", first: forTask1, second: forTask2 },
    { name: "task 2 first", first: forTask2, second: forTask1 },
  ];
  for (const { name, first, second } of orders) {
    const text = `the same answer, ${name}`;
    const sent = await post("/v1/blobs", resultBody(text, first.task), first.by);
    const again = await post("/v1/blobs", resultBody(text, second.task), second.by);
    expect(again.status, name).toBe(200);
    expect(again.body, name).toEqual(sent.body);
    expect(await rowOf(sent.body.sha256), name).toMatchObject({
      kind: "result",
      content_type: "text/plain",
      task_id: "2",
      uploader: first.by,
      is_public: false,
    });

    const path = `/v1/blobs/${sent.body.sha256}`;
    for (const at of [TEST_NOW, REVEAL_DEADLINE, late - 1n]) {
      nowNs = at;
      expect((await get(path)).status, `${name} at ${at}`).toBe(404);
    }
    nowNs = late;
    const shown = await get(path);
    expect(shown.status, name).toBe(200);
    expect(shown.text(), name).toBe(text);
  }

  // A result is sent for a task by its entrants only, so no one else can hold a result back with a
  // task of their own: alice did not enter task 2, she is refused, and the row stays task 1's.
  const mine = await post("/v1/blobs", resultBody("alice only", "1"), alice);
  const refused = await post<ErrorBody>("/v1/blobs", resultBody("alice only", "2"), alice);
  expect(refused.status).toBe(403);
  expect(await rowOf(mine.body.sha256)).toMatchObject({ task_id: "1" });
  nowNs = REVEAL_DEADLINE;
  expect((await get(`/v1/blobs/${mine.body.sha256}`)).status).toBe(200);
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
    // Over the limit, the body is refused before it is read: it would be a 400 as JSON.
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

// ---- The scorecard route ----------------------------------------------------------------------

test("scorecard_route_serves_the_scorecard_of_a_settled_task", async () => {
  await seedLifecycle(deps.db);
  await apply(taskLine(2));
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
    winners: [{ account: alice, bps: 10_000 }],
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

test("scorecard_route_hides_a_private_scorecard", async () => {
  await seedLifecycle(deps.db);
  const document = scorecardOf("3", { heldout: HELDOUT, heldout_commitment: HELDOUT_HASH });
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
    scorecardOf("3", { heldout, heldout_commitment: sha256Hex(canonicalJson(heldout)) }),
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
