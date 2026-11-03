import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { KeyPair } from "near-api-js";
import { afterEach, expect, test, vi } from "vitest";
import { ApiClient, type ApiClientOptions, ApiTimeoutError } from "../src/index";

// What the timeout comes to against a real server. A server that takes a request and never
// answers it, or answers and stops in the middle of the body, would hold a caller for ever; the
// client gives up on it, and the request it sent is cancelled, so that the connection does not
// stay open on both sides. (That every method has the timeout, what it says and how it counts is
// held in api.test.ts, over a fake `fetch`; this is the real `fetch` and the real sockets.)
//
// These tests run on real time, and the machine they run on may be busy: the gates of this repo run
// several test files at once. So a request that must be answered, such as the control, the sign-in
// and the calls that follow a timeout, has all of `TIMEOUT_MS` to be, and the first request of the
// process, which starts `fetch` up and opens a connection, is made before any of them is timed.

const ACCOUNT = "alice.test.near";
/**
 * How long a request may take here. One that must be answered has all of it, and one that must time
 * out takes all of it, so it is a middle: two seconds is long for a loopback request, even on a
 * machine at a high load (a bare first `fetch` took up to 339 ms at a load average of 50 to 77, and
 * a warm one 105 ms), and the five tests take about nine seconds together.
 */
const TIMEOUT_MS = 2_000;
const HOUR = 3_600_000;
/** The most a wait for something the server does may take. A test that needs it has failed. */
const PATIENCE_MS = 10_000;
/** The path of the request that warms a server up, which the server answers and does not note. */
const WARM_UP = "/warm-up";

// A test here waits out `TIMEOUT_MS` once, and the default of 5 s leaves a machine that is busy too
// little room beyond that.
vi.setConfig({ testTimeout: 15_000 });

/** What a route does: answers, never answers, or answers and then stops in the middle. */
type Mode = "answer" | "hang" | "stall";

interface Hit {
  method: string;
  /** The path and the query. */
  url: string;
  /** Whether the connection of the request has been closed: the client gave up on it. */
  closed: boolean;
}

interface Api {
  url: string;
  hits: Hit[];
  /** What each route does, by `METHOD /path`. A route that is not here answers. */
  modes: Map<string, Mode>;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(stop));
});

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

/** Waits until `done`, which the server makes true by itself, and fails if it never does. */
async function until(done: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > PATIENCE_MS) throw new Error(`gave up waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Makes the first request to `url`, the one that is not any test's. The first `fetch` of a process
 * starts the runtime's client up and opens its first connection, and the first request to a new
 * server opens one more: done here, they are not part of what a test times, and the connection is
 * kept for the requests of the client that follow.
 */
async function warmUp(url: string): Promise<void> {
  const res = await fetch(`${url}${WARM_UP}`);
  await res.arrayBuffer();
}

/** What a call rejected with: the test fails if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject, and it resolved");
}

/** A small API on the loopback interface that a client can sign in to. */
async function serveApi(): Promise<Api> {
  const api: Api = { url: "", hits: [], modes: new Map() };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === WARM_UP) {
      req.resume();
      res.writeHead(204).end();
      return;
    }
    const hit: Hit = { method: req.method ?? "", url: req.url ?? "", closed: false };
    res.on("close", () => {
      hit.closed = true;
    });
    api.hits.push(hit);
    req.resume();
    const route = `${hit.method} ${hit.url.split("?")[0]}`;
    const mode = api.modes.get(route) ?? "answer";
    if (mode === "hang") return;
    if (mode === "stall") {
      // The head, and a part of a body that is longer: then nothing more.
      if (route.startsWith("GET /v1/blobs/")) {
        res.writeHead(200, { "Content-Length": "64" }).write("0123456789");
      } else {
        res.writeHead(200, { "Content-Type": "application/json" }).write('{"tasks":[');
      }
      return;
    }
    if (route === "POST /v1/auth/challenge") {
      json(res, {
        nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
        message: "Sign in to Tender",
        recipient: api.url,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
    } else if (route === "POST /v1/auth/verify") {
      json(res, {
        token: "token-1",
        expires_at: new Date(Date.now() + 12 * HOUR).toISOString(),
        key_kind: "full_access",
      });
    } else if (route === "POST /v1/tasks/7/start") {
      json(res, { ok: true, working_count: 1 });
    } else if (route === "GET /v1/health") {
      json(res, {
        ok: true,
        network: "sandbox",
        contract: "tender.test.near",
        indexed_height: "90",
        chain_final_height: "100",
        lag_blocks: "10",
        waiting_for_chain: false,
      });
    } else {
      res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not_found"}');
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  api.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await warmUp(api.url);
  return api;
}

function clientOf(api: Api, over: Partial<ApiClientOptions> = {}): ApiClient {
  return new ApiClient({
    baseUrl: api.url,
    signer: { accountId: ACCOUNT, privateKey: KeyPair.fromRandom("ed25519").toString() },
    timeoutMs: TIMEOUT_MS,
    ...over,
  });
}

/** The hits of a route, which the server has noted. */
const hitsOf = (api: Api, route: string) =>
  api.hits.filter((hit) => `${hit.method} ${hit.url.split("?")[0]}` === route);

test("a_server_that_never_answers_fails_the_call_at_the_timeout_and_the_request_is_cancelled", async () => {
  const api = await serveApi();
  const client = clientOf(api);

  // The control: a server that answers is no timeout, so the failure below is the server's doing.
  expect((await client.health()).ok).toBe(true);

  api.modes.set("GET /v1/health", "hang");
  const started = Date.now();
  const error = await rejection(client.health());
  const took = Date.now() - started;

  expect(error).toBeInstanceOf(ApiTimeoutError);
  expect((error as Error).message).toBe(`ApiClient.health timed out after ${TIMEOUT_MS} ms`);
  expect(took).toBeGreaterThanOrEqual(TIMEOUT_MS - 20);
  expect(took).toBeLessThan(PATIENCE_MS);

  // The request was cancelled and not only given up on: the server sees the connection close.
  const hit = hitsOf(api, "GET /v1/health").at(-1);
  await until(() => hit?.closed === true, "the server to see the connection close");
});

test("an_answer_that_stops_in_the_middle_is_given_up_on_too", async () => {
  const api = await serveApi();
  const client = clientOf(api);
  api.modes.set("GET /v1/tasks", "stall");
  api.modes.set(`GET /v1/blobs/${"ab".repeat(32)}`, "stall");

  // Both at once, so that the test waits for one timeout and not for two.
  const [read, blob] = await Promise.all([
    rejection(client.listTasks()),
    rejection(client.getBlob("ab".repeat(32))),
  ]);
  expect(read).toBeInstanceOf(ApiTimeoutError);
  expect((read as Error).message).toBe(`ApiClient.listTasks timed out after ${TIMEOUT_MS} ms`);
  expect(blob).toBeInstanceOf(ApiTimeoutError);
  expect((blob as Error).message).toBe(`ApiClient.getBlob timed out after ${TIMEOUT_MS} ms`);

  // Both connections were cancelled, though each had been answered with a head.
  await until(
    () => api.hits.length === 2 && api.hits.every((hit) => hit.closed),
    "the server to see both connections close",
  );
});

test("a_call_that_times_out_leaves_the_session_alone", async () => {
  const api = await serveApi();
  const client = clientOf(api);

  // The sign-in goes through and the call itself hangs.
  api.modes.set("POST /v1/tasks/7/start", "hang");
  const error = await rejection(client.start(7n));
  expect(error).toBeInstanceOf(ApiTimeoutError);
  expect((error as Error).message).toBe(`ApiClient.start timed out after ${TIMEOUT_MS} ms`);
  expect(hitsOf(api, "POST /v1/auth/verify")).toHaveLength(1);

  // The next call uses the token it has, and the server answers it.
  api.modes.set("POST /v1/tasks/7/start", "answer");
  expect(await client.start(7n)).toEqual({ ok: true, working_count: 1 });
  expect(hitsOf(api, "POST /v1/auth/verify")).toHaveLength(1);
});

test("a_sign_in_that_hangs_names_the_sign_in_and_the_next_call_signs_in_again", async () => {
  const api = await serveApi();
  const client = clientOf(api);

  api.modes.set("POST /v1/auth/challenge", "hang");
  const error = await rejection(client.start(7n));
  expect(error).toBeInstanceOf(ApiTimeoutError);
  expect((error as Error).message).toBe(`ApiClient.signIn timed out after ${TIMEOUT_MS} ms`);
  // The call itself was never sent: it had no token.
  expect(hitsOf(api, "POST /v1/tasks/7/start")).toHaveLength(0);

  // Nothing of the failed sign-in stuck: the next call asks for a new challenge and goes through.
  api.modes.set("POST /v1/auth/challenge", "answer");
  expect(await client.start(7n)).toEqual({ ok: true, working_count: 1 });
  expect(hitsOf(api, "POST /v1/auth/challenge")).toHaveLength(2);
});

test("the_signal_of_the_client_cancels_what_it_has_in_flight", async () => {
  const api = await serveApi();
  const stopped = new AbortController();
  // A timeout far off, so that it is the signal that ends the call.
  const client = clientOf(api, { signal: stopped.signal, timeoutMs: 60_000 });

  api.modes.set("GET /v1/health", "hang");
  const call = rejection(client.health());
  await until(() => api.hits.length === 1, "the request to arrive");
  const reason = new Error("shutting down");
  stopped.abort(reason);

  // The call fails with the reason it was given, which is no timeout, and the request is cancelled.
  expect(await call).toBe(reason);
  await until(() => api.hits[0]?.closed === true, "the server to see the connection close");
});
