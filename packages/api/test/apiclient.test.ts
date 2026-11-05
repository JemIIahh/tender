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
  fixtureData,
} from "@tender/indexer/testing";
import { ApiError, canonicalJson, type Scorecard, sha256Hex } from "@tender/shared";
import { Hono } from "hono";
import { KeyPair } from "near-api-js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { type ApiDeps, createApp } from "../src/index";
import { fakeClient, SALT, seedLifecycle, TEST_NOW, testDeps } from "./helpers";

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

/** The winners of the captured `picked` event, as a scorecard names them: account and share. */
const PICKED_WINNERS = fixtureData("picked").winners.map(({ account, bps }) => ({ account, bps }));

/** What the captured task committed to, as the board's task 3 does: its scorecard has to rest on it. */
const COMMITTED = fixtureData("task_created");

/** The scorecard of the board's task 3, which pays what the task's pick paid. */
const SCORECARD: Scorecard = {
  version: 1,
  task_id: SCORECARD_TASK,
  verifier: judge,
  kind: "exact",
  criteria_hash: COMMITTED.criteria_hash,
  heldout_commitment: COMMITTED.heldout_commitment,
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
  winners: PICKED_WINNERS,
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

type Handler = (request: Request) => Response | Promise<Response>;

/**
 * Serves what `build` makes of the URL it is served at, on an ephemeral port of the loopback
 * interface. The port is known only once it is bound, and the API signs a sign-in for its own
 * base URL, port included: so the app is made after the server is, from the URL it is at.
 */
function listen(build: (url: string) => Handler): Promise<{ server: ServerType; url: string }> {
  return new Promise((resolve) => {
    let handler: Handler | undefined;
    const server = serve(
      { fetch: (request) => (handler as Handler)(request), hostname: "127.0.0.1", port: 0 },
      (info) => {
        const url = `http://127.0.0.1:${info.port}`;
        handler = build(url);
        resolve({ server, url });
      },
    );
  });
}

/** The app, as the API would be served at `url`: its public URL is where it is. */
function appAt(url: string, over: Partial<ApiDeps> = {}): Handler {
  const app: Hono = createApp({ ...deps, publicUrl: url, ...over });
  return (request) => app.fetch(request);
}

function stop(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
}

/**
 * A client of the app, which is served for the test and closed after it. The app's public URL is
 * the address it is served at, as a deployed API's is the address its clients call (`over` can
 * change that too). The client signs in as alice with a key of its own, which the app's chain stub
 * accepts (`over.client` changes that), and keeps the time the API keeps.
 */
async function connect(over: Partial<ApiDeps> = {}) {
  const { server, url } = await listen((url) => appAt(url, over));
  cleanups.push(() => stop(server));
  return { ...clientOf(url), url };
}

/** A client of the API at `url`, as alice, with a key of its own and the time the API keeps. */
function clientOf(url: string, fetchImpl?: typeof fetch) {
  const key = KeyPair.fromRandom("ed25519");
  const client = new ApiClient({
    baseUrl: url,
    signer: { accountId: alice, privateKey: key.toString() },
    fetchImpl,
    now: () => Number(TEST_NOW / 1_000_000n),
  });
  return { client, key };
}

async function count(table: "auth_challenges" | "auth_tokens"): Promise<number> {
  const [row] = await deps.db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return row?.n ?? 0;
}

/** What the promise rejected with: the test fails if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject, and it resolved");
}

/** What the promise rejected with, which is an `ApiError`: the test fails if it resolved. */
async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

// ---- Tests ------------------------------------------------------------------------------------

test("client_round_trips_against_in_process_app", async () => {
  const { client, key, url } = await connect();

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
    uri: `${url}/v1/blobs/${sha256Hex(bytes)}`,
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
  // The poster's record: its tasks, and none of them voided after a reveal.
  const { poster } = FIXTURE_ACCOUNTS;
  expect(await client.getPoster(poster)).toEqual({
    account: poster,
    tasks_posted: (await client.listTasks({ poster })).tasks.length,
    voided_after_reveals: 0,
    is_team: false,
  });

  // How far the index is behind the chain.
  expect(await client.health()).toEqual({
    ok: true,
    network: "sandbox",
    contract: FIXTURE_CONTRACT,
    indexed_height: "100",
    chain_final_height: "100",
    lag_blocks: "0",
    waiting_for_chain: false,
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
  const heldout = canonicalJson({ exact: { expected: ["42"] }, salt: SALT });
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

// ---- A server that is not the API ---------------------------------------------------------------

/**
 * A server at an address of its own that passes every request on to the API at `target`, as a
 * hostile `baseUrl` would. With `renamed` it also names itself, by its base URL, as the recipient
 * of the challenges it passes back. `passed` lists what it was asked.
 */
function relayTo(target: string, passed: string[], renamed: boolean): (url: string) => Handler {
  return (url) => async (request) => {
    const { pathname, search } = new URL(request.url);
    passed.push(`${request.method} ${pathname}`);
    const body = request.method === "POST" ? await request.text() : "";
    const upstream = await fetch(`${target}${pathname}${search}`, {
      method: request.method,
      headers: { "Content-Type": "application/json" },
      body: body === "" ? undefined : body,
      redirect: "error",
    });
    const text = await upstream.text();
    const answer =
      renamed && pathname === "/v1/auth/challenge"
        ? JSON.stringify({ ...JSON.parse(text), recipient: url })
        : text;
    return new Response(answer, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

test("a_server_that_passes_the_apis_challenge_on_gets_no_token", async () => {
  const api = await listen((url) => appAt(url));
  cleanups.push(() => stop(api.server));
  /** A client at a relay of the API, and what the relay is asked. */
  const viaRelay = async (renamed: boolean) => {
    const passed: string[] = [];
    const relay = await listen(relayTo(api.url, passed, renamed));
    cleanups.push(() => stop(relay.server));
    return { ...clientOf(relay.url), passed };
  };

  // As the API made it, the challenge names the API's base URL, and this client called the
  // relay's: it signs nothing, so the relay has no signature to present to the API, and does not
  // ask. (An API whose public URL is not the address its clients call looks the same to a client.)
  const plain = await viaRelay(false);
  const refused = await rejection(plain.client.signIn());
  expect(refused).not.toBeInstanceOf(ApiError);
  expect((refused as Error).message).toBe(
    "refusing to sign the API's sign-in challenge: its recipient is not this client's baseUrl",
  );
  expect(plain.passed).toEqual(["POST /v1/auth/challenge"]);

  // Renamed to the relay's own base URL, the challenge is signed, for that. The API takes a
  // signature for its own base URL only, so what the relay passes on to it is refused.
  const renamed = await viaRelay(true);
  const error = await apiError(renamed.client.signIn());
  expect(error.status).toBe(401);
  expect(error.body).toMatchObject({ error: "wrong_recipient" });
  expect(renamed.passed).toEqual(["POST /v1/auth/challenge", "POST /v1/auth/verify"]);

  // By neither way was a token made, for anyone.
  expect(await count("auth_tokens")).toBe(0);
  expect(await count("auth_challenges")).toBe(2);
});

test("two_apis_under_paths_of_one_host_do_not_take_each_others_sign_ins", async () => {
  // Two real APIs, /a and /b of one server and so of one host, on one database: all that tells a
  // sign-in to one from a sign-in to the other is whom it is signed for.
  const both = await listen((url) => {
    const root = new Hono();
    root.route("/a", createApp({ ...deps, publicUrl: `${url}/a` }));
    root.route("/b", createApp({ ...deps, publicUrl: `${url}/b` }));
    return (request) => root.fetch(request);
  });
  cleanups.push(() => stop(both.server));

  // A path in the public URL is no obstacle to signing in to either.
  for (const path of ["/a", "/b"]) {
    expect(await clientOf(`${both.url}${path}`).client.signIn(), path).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  }
  expect(await count("auth_tokens")).toBe(2);
  await deps.db.exec("truncate auth_challenges, auth_tokens");

  const verifyAt = (path: string, body: string) =>
    fetch(`${both.url}${path}/v1/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  for (const [from, to] of [
    ["/a", "/b"],
    ["/b", "/a"],
  ] as const) {
    // What a client signs for `from`, caught on its way: the verify is not sent.
    let signed: string | undefined;
    const caught = ((input, init) => {
      if (!String(input).endsWith("/auth/verify")) return fetch(input, init);
      signed = String(init?.body);
      return Promise.reject(new Error("held back"));
    }) as typeof fetch;
    await rejection(clientOf(`${both.url}${from}`, caught).client.signIn());
    expect(signed, from).toBeDefined();

    // The other API refuses it, though it knows the nonce, and the one it is for takes it.
    const refused = await verifyAt(to, signed as string);
    expect(refused.status, `${from} signed, shown at ${to}`).toBe(401);
    expect(await refused.json()).toMatchObject({ error: "wrong_recipient" });
    const taken = await verifyAt(from, signed as string);
    expect(taken.status, `${from} signed, shown at ${from}`).toBe(200);
  }
});
