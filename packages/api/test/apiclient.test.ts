import { type ServerType, serve } from "@hono/node-server";
import { ApiClient } from "@tender/client";
import { putBlob } from "@tender/db";
import { applyBlock } from "@tender/indexer";
import {
  blockOf,
  eventLine,
  FIXTURE_ACCOUNTS,
  FIXTURE_BRIEF,
  FIXTURE_BRIEF_HASH,
  FIXTURE_CONTRACT,
  FIXTURE_OPTIONS,
} from "@tender/indexer/testing";
import { ApiError, canonicalJson, type Scorecard, sha256Hex } from "@tender/shared";
import type { Hono } from "hono";
import { KeyPair } from "near-api-js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { type ApiDeps, createApp } from "../src/index";
import { fakeClient, seedLifecycle, TEST_NOW, testDeps } from "./helpers";

// `ApiClient` against the real app, served on an ephemeral port of the loopback interface, so that
// the requests it builds are the ones the routes read: the paths, the queries, the JSON of the
// uploads and the NEP-413 sign-in, which the API checks with `verifyNep413` and the client signs
// with near-api-js's keys. (The client's own unit tests, over a fake `fetch`, are in
// packages/client/test/api.test.ts; the round trip lives here because this package depends on the
// client and not the other way round.) The board is built once and only read, by the indexer's
// captured events as in mcp.test.ts. The API's clock is fixed at `TEST_NOW`, and so is the
// client's, so that the token it is given (good for 12 hours of the API's time) is still good.

const { alice, bob, judge } = FIXTURE_ACCOUNTS;
const BOT = "tender_test_bot";
const OPEN_TASK = "2";
const SCORECARD_TASK = "3";

/** The scorecard of the board's task 3. */
const SCORECARD: Scorecard = {
  version: 1,
  task_id: SCORECARD_TASK,
  verifier: judge,
  kind: "exact",
  criteria_hash: sha256Hex("criteria"),
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

let deps: ApiDeps;

beforeAll(async () => {
  deps = await testDeps({ telegramBotUsername: BOT });
  await seedBoard();
});

afterAll(() => deps.db.close());

beforeEach(async () => {
  // Sign-in leaves rows behind; the board stays.
  await deps.db.exec("truncate auth_challenges, auth_tokens");
});

/**
 * The lifecycle's task 1 and two more, read at `TEST_NOW`:
 *
 * | id | phase   | scorecard                        |
 * | -- | ------- | -------------------------------- |
 * | 1  | settled | none: its blob is not stored     |
 * | 2  | open    | none                             |
 * | 3  | settled | public, the verifier's `SCORECARD` |
 *
 * The captured deadlines put a new task in its commit window at `TEST_NOW`, so task 2 is open.
 * The lifecycle's blocks end at height 90.
 */
async function seedBoard(): Promise<void> {
  await seedLifecycle(deps.db);
  const scorecardHash = await putBlob(deps.db, {
    kind: "scorecard",
    contentType: "application/json",
    bytes: canonicalJson(SCORECARD),
    isPublic: true,
  });
  await applyBlock(
    deps.db,
    blockOf(100n, [
      eventLine("task_created", { id: OPEN_TASK }),
      eventLine("task_created", { id: SCORECARD_TASK, brief_hash: FIXTURE_BRIEF_HASH }),
      eventLine("picked", { task_id: SCORECARD_TASK, scorecard_hash: scorecardHash }),
    ]),
    FIXTURE_OPTIONS,
  );
}

// ---- Serving and calling ----------------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Serves `app` on an ephemeral port of the loopback interface. */
function listen(app: Hono): Promise<{ server: ServerType; url: string }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) =>
      resolve({ server, url: `http://127.0.0.1:${info.port}` }),
    );
  });
}

function stop(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
}

/**
 * A client of the app, which is served for the test and closed after it. It signs in as alice with
 * a key of its own, which the app's chain stub accepts (`over.client` changes that), and keeps the
 * time the API keeps.
 */
async function connect(over: Partial<ApiDeps> = {}) {
  const { server, url } = await listen(createApp({ ...deps, ...over }));
  cleanups.push(() => stop(server));
  const key = KeyPair.fromRandom("ed25519");
  const client = new ApiClient({
    baseUrl: url,
    signer: { accountId: alice, privateKey: key.toString() },
    now: () => Number(TEST_NOW / 1_000_000n),
  });
  return { client, key };
}

async function count(table: "auth_challenges" | "auth_tokens"): Promise<number> {
  const [row] = await deps.db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return row?.n ?? 0;
}

/** What the promise rejected with: the test fails if it resolved. */
async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected the call to reject, and it resolved");
}

// ---- Tests ------------------------------------------------------------------------------------

test("client_round_trips_against_in_process_app", async () => {
  const { client, key } = await connect();

  // Signs in with the key of its signer: the API issues a token for alice and that key.
  const token = await client.signIn();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await deps.db.query("select account, public_key, key_kind from auth_tokens")).toEqual([
    { account: alice, public_key: key.getPublicKey().toString(), key_kind: "full_access" },
  ]);

  // A brief goes up, and the same bytes come back by their hash.
  const bytes = canonicalJson({ ...FIXTURE_BRIEF, title: "Summarise the changelog" });
  const stored = await client.uploadBlob({ kind: "brief", contentType: "application/json", bytes });
  expect(stored).toEqual({
    sha256: sha256Hex(bytes),
    uri: `${deps.publicUrl}/v1/blobs/${sha256Hex(bytes)}`,
  });
  expect(await client.getBlob(stored.sha256)).toEqual(bytes);
  expect(await client.getBlob(sha256Hex("never stored"))).toBeNull();

  // The board, newest first, in pages, and by phase.
  expect((await client.listTasks()).tasks.map((task) => task.id)).toEqual(["3", "2", "1"]);
  const ids = async (filter: Parameters<ApiClient["listTasks"]>[0]) =>
    (await client.listTasks(filter)).tasks.map((task) => task.id);
  expect(await ids({ phase: "open" })).toEqual(["2"]);
  // Tasks 1 and 3 point at the stored brief, and so have its tags; task 2's brief is not stored.
  expect(await ids({ tag: "regex", poster: FIXTURE_ACCOUNTS.poster, verifier: judge })).toEqual([
    "3",
    "1",
  ]);
  expect(await ids({ tag: "regex", poster: bob })).toEqual([]);
  expect(await ids({ parent: 1n })).toEqual([]);
  const first = await client.listTasks({ limit: 2 });
  expect(first.tasks.map((task) => task.id)).toEqual(["3", "2"]);
  expect(first.next_cursor).toBe("2");
  const second = await client.listTasks({ limit: 2, cursor: first.next_cursor });
  expect(second.tasks.map((task) => task.id)).toEqual(["1"]);
  expect(second.next_cursor).toBeNull();
  // The null at the end of the board, handed back as it is, is no cursor: the first page again.
  const again = await client.listTasks({ limit: 2, cursor: second.next_cursor });
  expect(again.tasks.map((task) => task.id)).toEqual(["3", "2"]);

  const detail = await client.getTask(1n);
  expect(detail?.task.id).toBe("1");
  expect(detail?.brief?.title).toBe(FIXTURE_BRIEF.title);
  expect(detail?.entries.map((entry) => entry.account)).toEqual([alice, bob]);
  expect(await client.getTask(99n)).toBeNull();

  // The agents, and the entries of one.
  const agents = await client.listAgents();
  expect(agents.agents.map((agent) => agent.account)).toEqual([alice, bob, judge]);
  expect(agents.next_cursor).toBeNull();
  expect((await client.listAgents({ cursor: agents.next_cursor })).agents).toHaveLength(3);
  const page = await client.listAgents({ limit: 1 });
  expect(page.next_cursor).toBe(alice);
  expect(
    (await client.listAgents({ limit: 1, cursor: page.next_cursor })).agents.map(
      (agent) => agent.account,
    ),
  ).toEqual([bob]);
  // The filters reach the API: all three registered with these tags, under this provider.
  const accounts = async (filter: Parameters<ApiClient["listAgents"]>[0]) =>
    (await client.listAgents(filter)).agents.map((agent) => agent.account);
  expect(await accounts({ tag: "regex", asp: "test.near" })).toEqual([alice, bob, judge]);
  expect(await accounts({ tag: "no-such-tag" })).toEqual([]);
  expect(await accounts({ asp: "other.near" })).toEqual([]);
  const agent = await client.getAgent(alice);
  expect(agent?.agent.name).toBe("Alice Extractor");
  expect(await client.getAgent("nobody.test.near")).toBeNull();
  const entries = await client.listEntries(alice);
  expect(entries.entries.map((entry) => entry.task_id)).toEqual(["1"]);

  // How far the index is behind the chain.
  expect(await client.health()).toEqual({
    ok: true,
    network: "sandbox",
    contract: FIXTURE_CONTRACT,
    indexed_height: "100",
    chain_final_height: "100",
    lag_blocks: "0",
  });

  // One sign-in served all of it.
  expect(await count("auth_challenges")).toBe(1);
  expect(await count("auth_tokens")).toBe(1);
});

test("client_reaches_the_rest_of_the_routes", async () => {
  const { client } = await connect();

  // The working signal: the first start counts, asking again changes nothing, and a task that is
  // not open or not there is an error that says so.
  expect(await client.start(BigInt(OPEN_TASK))).toEqual({ ok: true, working_count: 1 });
  expect(await client.start(BigInt(OPEN_TASK))).toEqual({ ok: true, working_count: 1 });
  const settled = await apiError(client.start(1n));
  expect(settled.status).toBe(409);
  expect(settled.body).toMatchObject({ error: "not_open" });
  expect((await apiError(client.start(99n))).status).toBe(404);

  // A held-out document goes up and cannot be read back; one that does not hash to its commitment
  // is refused.
  const heldout = canonicalJson({ exact: { expected: ["42"] } });
  expect(await client.uploadHeldout(sha256Hex(heldout), heldout)).toBeUndefined();
  expect(await client.getBlob(sha256Hex(heldout))).toBeNull();
  const mismatch = await apiError(client.uploadHeldout(sha256Hex("something else"), heldout));
  expect(mismatch.status).toBe(400);
  expect(mismatch.body).toMatchObject({ error: "bad_request" });

  // A result is an entrant's: alice has no entry in the open task, so the API refuses it.
  const forbidden = await apiError(
    client.uploadBlob({
      kind: "result",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("my answer"),
      taskId: BigInt(OPEN_TASK),
    }),
  );
  expect(forbidden.status).toBe(403);

  // The Telegram link is for this account, good for ten minutes by the database's clock.
  const link = await client.telegramLink();
  expect(link.url).toMatch(new RegExp(`^https://t\\.me/${BOT}\\?start=[A-Za-z0-9_-]{22}$`));
  const lasts = Date.parse(link.expires_at) - Date.now();
  expect(lasts).toBeGreaterThan(9 * 60_000);
  expect(lasts).toBeLessThanOrEqual(10 * 60_000);
  const [nonce] = await deps.db.query<{ account: string }>("select account from tg_link_nonces");
  expect(nonce?.account).toBe(alice);

  // The scorecard a task was settled with, the same document; none for a task without one.
  expect(await client.getScorecard(BigInt(SCORECARD_TASK))).toEqual(SCORECARD);
  expect(await client.getScorecard(BigInt(OPEN_TASK))).toBeNull();
  expect(await client.getScorecard(99n)).toBeNull();

  expect(await count("auth_challenges")).toBe(1);
});

test("client_signs_in_again_when_the_api_forgets_its_token", async () => {
  const { client } = await connect();
  const first = await client.telegramLink();
  expect(first.url).toContain(BOT);
  expect(await count("auth_challenges")).toBe(1);

  // The API drops the token. The next call finds out from the 401, signs in again and succeeds.
  await deps.db.query("delete from auth_tokens");
  expect((await client.telegramLink()).url).toContain(BOT);
  expect(await count("auth_challenges")).toBe(2);
  expect(await count("auth_tokens")).toBe(1);

  // The new token is kept.
  await client.telegramLink();
  expect(await count("auth_challenges")).toBe(2);
});

test("a_sign_in_the_api_refuses_is_an_api_error_and_is_not_retried", async () => {
  // The chain says the key is not on the account.
  const { client } = await connect({ client: fakeClient({ viewAccessKey: async () => null }) });

  const error = await apiError(client.start(BigInt(OPEN_TASK)));
  expect(error.status).toBe(401);
  expect(error.body).toMatchObject({ error: "key_not_found" });
  expect(await count("auth_challenges")).toBe(1);
  expect(await count("auth_tokens")).toBe(0);
});
