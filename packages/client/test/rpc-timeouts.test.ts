import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { KeyPair } from "near-api-js";
import { afterEach, expect, test, vi } from "vitest";
import {
  DEFAULT_RPC_TIMEOUT_MS,
  DEFAULT_SEND_TIMEOUT_MS,
  TenderClient,
  TenderError,
} from "../src/index";

// What the time limits of the chain calls come to. The sockets are real: a node on the loopback
// interface that takes a request and never answers it, as a stuck one does, and a client that has
// to give up on it. (timeouts.test.ts holds the same for the API client, which has its own.)
//
// These tests run on real time, and the machine they run on may be busy: the gates of this repo run
// several test files at once. So a limit is a lower bound, which no call may undercut, and an upper
// bound is only a wait that no healthy run comes near.

const CONTRACT = "tender.test.near";
const BLOCK = { block_hash: "6kSpdaiEGudXLa4p43ALXFHCu96ozdEJ3c8KsCuajXyj", block_height: 34 };
const COMMITMENT = "ab".repeat(32);
/** How long a read has here, and the longer time a send has, so that the two tell apart. */
const READ_MS = 300;
const SEND_MS = 900;
/** The most a wait for something that happens by itself may take. A test that needs it has failed. */
const PATIENCE_MS = 10_000;

// A test here waits out a limit once, and the default of 5 s leaves a busy machine too little room.
vi.setConfig({ testTimeout: 20_000 });

/** What the node does with a JSON-RPC method: answers it, takes it and never answers, or says 503. */
type Mode = "answer" | "hang" | "unavailable";

interface Hit {
  /** The JSON-RPC method of the request, such as `query` or `send_tx`. */
  method: string;
  /** Whether the node left the request without an answer. */
  hung: boolean;
  /** Whether the connection of the request has closed: the client gave up on it. */
  closed: boolean;
}

interface FakeNode {
  url: string;
  hits: Hit[];
  /** What each method does, by name. A method that is not here is answered. */
  modes: Map<string, Mode>;
}

interface RpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(stop));
});

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** What the node answers to `request` when it answers: just enough for the calls made here. */
function answerOf(request: RpcRequest): object {
  if (request.method === "block") {
    return { header: { hash: BLOCK.block_hash, height: 100, timestamp_nanosec: "1000" } };
  }
  if (request.method === "send_tx") {
    return {
      status: { SuccessValue: "" },
      transaction: { hash: "TX" },
      transaction_outcome: { id: "TX", block_hash: BLOCK.block_hash },
      receipts_outcome: [],
    };
  }
  if (request.params.request_type === "view_access_key") {
    return { ...BLOCK, nonce: 7, permission: "FullAccess" };
  }
  // Any other query is a view, and every view here returns null.
  return { ...BLOCK, result: [...Buffer.from("null")], logs: [] };
}

/** A JSON-RPC node on the loopback interface. `modes` says what it does, by method. */
async function startNode(modes: Record<string, Mode> = {}): Promise<FakeNode> {
  const node: FakeNode = { url: "", hits: [], modes: new Map(Object.entries(modes)) };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const request = JSON.parse(body) as RpcRequest;
      const mode = node.modes.get(request.method) ?? "answer";
      const hit: Hit = { method: request.method, hung: mode === "hang", closed: false };
      res.on("close", () => {
        hit.closed = true;
      });
      node.hits.push(hit);
      if (mode === "hang") return;
      if (mode === "unavailable") {
        res.writeHead(503).end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: answerOf(request) }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  node.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return node;
}

type ClientOptions = ConstructorParameters<typeof TenderClient>[0];

function clientOf(node: FakeNode, over: Partial<ClientOptions> = {}): TenderClient {
  return new TenderClient({
    network: "testnet",
    contractId: CONTRACT,
    rpcUrl: node.url,
    rpcTimeoutMs: READ_MS,
    sendTimeoutMs: SEND_MS,
    ...over,
  });
}

/** A signer of its own account, so that no test waits for another's sends in the process queue. */
function signerOf(name: string) {
  return {
    accountId: `${name}.test.near`,
    privateKey: KeyPair.fromRandom("ed25519").toString(),
  };
}

/**
 * Waits until `done`, which the node or the client makes true by itself, and fails if it never is.
 * `what` says what it waited for, read when it gives up.
 */
async function until(done: () => boolean, what: string | (() => string)): Promise<void> {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > PATIENCE_MS) {
      throw new Error(`gave up waiting for ${typeof what === "string" ? what : what()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** What a call rejected with: the test fails if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<TenderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TenderError);
    return error as TenderError;
  }
  throw new Error("expected the call to reject, and it resolved");
}

/** How many timers and sockets Node says the process holds open. */
function held() {
  const resources = process.getActiveResourcesInfo();
  return {
    timers: resources.filter((resource) => resource === "Timeout").length,
    sockets: resources.filter((resource) => resource === "TCPSocketWrap").length,
  };
}

const hungHits = (node: FakeNode) => node.hits.filter((hit) => hit.hung);

// ---- The times and their checks -----------------------------------------------------------------

test("a_read_has_30_seconds_and_a_send_2_minutes_unless_they_are_set", async () => {
  const node = await startNode();
  const defaults = new TenderClient({
    network: "testnet",
    contractId: CONTRACT,
    rpcUrl: node.url,
    signer: signerOf("defaults"),
  });
  expect(DEFAULT_RPC_TIMEOUT_MS).toBe(30_000);
  expect(DEFAULT_SEND_TIMEOUT_MS).toBe(120_000);
  expect(defaults.rpcTimeoutMs).toBe(30_000);
  expect(defaults.sendTimeoutMs).toBe(120_000);
  expect(clientOf(node).rpcTimeoutMs).toBe(READ_MS);
  expect(clientOf(node).sendTimeoutMs).toBe(SEND_MS);

  // The defaults are what the calls wait with, and the timer is put away when the call is answered.
  const set = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  const timers = (ms: number) =>
    set.mock.calls.flatMap(([, delay], i) => (delay === ms ? [set.mock.results[i]?.value] : []));
  expect(await defaults.getTask(1n)).toBeNull();
  expect(timers(30_000)).toHaveLength(1);
  expect(clear).toHaveBeenCalledWith(timers(30_000)[0]);
  expect(timers(120_000)).toHaveLength(0);
  expect((await defaults.commit(1n, COMMITMENT)).txHash).toBe("TX");
  expect(timers(120_000)).toHaveLength(1);
  expect(clear).toHaveBeenCalledWith(timers(120_000)[0]);
});

test("each_time_is_a_whole_number_of_milliseconds_from_1_to_2147483647", () => {
  const make = (over: object) => () =>
    new TenderClient({
      network: "testnet",
      contractId: CONTRACT,
      rpcUrl: "http://127.0.0.1:1",
      ...over,
    });
  const refused = [
    0,
    -1,
    0.5,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    2_147_483_648,
    2 ** 53,
    "30000",
    null,
  ];
  for (const option of ["rpcTimeoutMs", "sendTimeoutMs"] as const) {
    for (const bad of refused) {
      const attempt = make({ [option]: bad });
      expect(attempt, `${option}: ${String(bad)}`).toThrow(RangeError);
      expect(attempt, `${option}: ${String(bad)}`).toThrow(
        `TenderClient: ${option} must be a whole number of milliseconds from 1 to 2147483647, not ${String(bad)}`,
      );
    }
    for (const good of [1, 2, 30_000, 2_147_483_647]) {
      expect(make({ [option]: good })()[option], `${option}: ${good}`).toBe(good);
    }
  }
});

// ---- Against a node that never answers ----------------------------------------------------------

test("a_view_the_node_never_answers_fails_at_the_limit_with_E_TIMEOUT_and_the_request_is_cancelled", async () => {
  const node = await startNode({ query: "hang" });
  const client = clientOf(node);

  const started = Date.now();
  const error = await rejection(client.getTask(1n));
  const took = Date.now() - started;

  expect(error.code).toBe("E_TIMEOUT");
  expect(error.message).toBe(`TenderClient.view get_task timed out after ${READ_MS} ms`);
  expect(error.txHash).toBeUndefined();
  expect(took).toBeGreaterThanOrEqual(READ_MS - 20);
  expect(took).toBeLessThan(PATIENCE_MS);
  // Not the node's URL, which can hold a key, and nothing of what was sent.
  expect(error.message).not.toContain("127.0.0.1");
  expect(error.message).not.toContain(node.url);

  // The request was cancelled and not only given up on: the node sees the connection close.
  expect(hungHits(node)).toHaveLength(1);
  await until(
    () => hungHits(node).every((hit) => hit.closed),
    "the node to see the connection close",
  );
});

test("every_read_has_the_limit_and_names_itself", async () => {
  const node = await startNode({ query: "hang", block: "hang" });
  const client = clientOf(node);
  const key = KeyPair.fromRandom("ed25519").getPublicKey().toString();

  // All at once, so that the test waits for one limit and not for six.
  const errors = await Promise.all([
    rejection(client.getConfig()),
    rejection(client.ftBalanceOf("usdc.test.near", "alice.test.near")),
    rejection(client.viewAccessKey("alice.test.near", key)),
    rejection(client.finalHeight()),
    rejection(client.blockTimestampNs()),
    // A read of several pages: its first page is the one that times out.
    rejection(client.getAllEntries(1n)),
  ]);

  expect(errors.map((error) => error.code)).toEqual(Array(6).fill("E_TIMEOUT"));
  expect(errors.map((error) => error.message)).toEqual([
    `TenderClient.view get_config timed out after ${READ_MS} ms`,
    `TenderClient.view ft_balance_of timed out after ${READ_MS} ms`,
    `TenderClient.viewAccessKey timed out after ${READ_MS} ms`,
    `TenderClient.finalHeight timed out after ${READ_MS} ms`,
    `TenderClient.blockTimestampNs timed out after ${READ_MS} ms`,
    `TenderClient.view get_task timed out after ${READ_MS} ms`,
  ]);
  // A timeout is no answer: a key that the node could not look up is not a key that is missing.
  await until(() => hungHits(node).every((hit) => hit.closed), "the node to see every close");
});

test("a_send_the_node_never_answers_fails_at_its_own_longer_limit_with_E_TIMEOUT", async () => {
  const signer = signerOf("sender");
  const node = await startNode({ query: "hang", block: "hang", send_tx: "hang" });
  const client = clientOf(node, { signer });

  const started = Date.now();
  const error = await rejection(client.commit(1n, COMMITMENT));
  const took = Date.now() - started;

  expect(error.code).toBe("E_TIMEOUT");
  expect(error.message).toBe(`TenderClient.send commit timed out after ${SEND_MS} ms`);
  expect(error.txHash).toBeUndefined();
  // The send's limit and not the read's: the nonce and block reads inside it are held to it.
  expect(took).toBeGreaterThanOrEqual(SEND_MS - 20);
  expect(took).toBeLessThan(PATIENCE_MS);
  // Nothing of the node or of the key in the text.
  expect(error.message).not.toContain("127.0.0.1");
  expect(error.message).not.toContain(signer.privateKey);

  expect(hungHits(node).length).toBeGreaterThan(0);
  await until(() => hungHits(node).every((hit) => hit.closed), "the node to see every close");
});

test("a_send_that_timed_out_leaves_the_account_able_to_send_once_the_node_answers", async () => {
  const signer = signerOf("recover");
  const node = await startNode({ query: "hang", block: "hang", send_tx: "hang" });
  const client = clientOf(node, { signer });

  // The send is stuck in its first read, the key's nonce, which near-api-js holds the key's lock
  // for. A call that was only given up on would leave the lock held, and every later send of the
  // key would wait behind it for ever.
  expect((await rejection(client.commit(1n, COMMITMENT))).code).toBe("E_TIMEOUT");
  await until(() => hungHits(node).every((hit) => hit.closed), "the node to see every close");

  // The node comes back. The same client, with the same account, sends again and it goes through,
  // and it asked the node for the key's nonce again, which it could not have with the lock held.
  const queriesBefore = node.hits.filter((hit) => hit.method === "query").length;
  node.modes.clear();
  const sent = await client.commit(1n, COMMITMENT);
  expect(sent.txHash).toBe("TX");
  expect(node.hits.filter((hit) => hit.method === "query").length).toBeGreaterThan(queriesBefore);
});

test("no_socket_or_timer_is_left_after_a_call_times_out", async () => {
  const node = await startNode({ query: "hang", block: "hang", send_tx: "hang" });
  const client = clientOf(node, { signer: signerOf("leaks") });
  const before = held();

  await Promise.all([
    rejection(client.getTask(1n)),
    rejection(client.finalHeight()),
    rejection(client.commit(1n, COMMITMENT)),
  ]);

  // Every connection the node was left holding is closed, and the process holds no more timers and
  // no more sockets than it did before the calls. (The node is in this process, so a socket it
  // holds would show here as well.)
  await until(() => hungHits(node).every((hit) => hit.closed), "the node to see every close");
  await until(
    () => held().timers <= before.timers && held().sockets <= before.sockets,
    () =>
      `the process to hold no more than ${JSON.stringify(before)}, it holds ${JSON.stringify(held())}`,
  );
});

test("the_limit_holds_near_api_js_s_retries_and_stops_them", async () => {
  // A node that says 503 to everything: near-api-js tries again, after 500 ms, and again, for
  // minutes. The limit is for the whole call, and not for each try.
  const node = await startNode({ query: "unavailable" });
  const client = clientOf(node, { rpcTimeoutMs: READ_MS });

  const started = Date.now();
  const error = await rejection(client.getTask(1n));
  expect(error.code).toBe("E_TIMEOUT");
  expect(Date.now() - started).toBeGreaterThanOrEqual(READ_MS - 20);
  expect(node.hits).toHaveLength(1);

  // The limit came while near-api-js was waiting to try again, after 500 ms. It does not: the
  // request it would make is cancelled before it is sent, and no more come.
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect(node.hits).toHaveLength(1);
});

test("a_fetch_that_ignores_its_signal_cannot_hold_a_call_past_its_limit", async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  // Something other than the runtime's `fetch` in place: it takes the request and never settles.
  vi.stubGlobal("fetch", (_url: unknown, init?: RequestInit) => {
    signals.push(init?.signal);
    return new Promise<Response>(() => undefined);
  });
  const client = new TenderClient({
    network: "testnet",
    contractId: CONTRACT,
    rpcUrl: "http://127.0.0.1:1",
    rpcTimeoutMs: READ_MS,
  });

  const started = Date.now();
  const error = await rejection(client.getTask(1n));

  expect(error.code).toBe("E_TIMEOUT");
  expect(Date.now() - started).toBeGreaterThanOrEqual(READ_MS - 20);
  // It was handed the call's signal all the same, and the signal says why it aborted.
  expect(signals).toHaveLength(1);
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[0]?.reason).toBe(error);
});

test("a_fetch_outside_a_call_is_left_alone_while_a_call_times_out_beside_it", async () => {
  const hanging = await startNode({ query: "hang" });
  const slow = createServer((_req, res) => {
    setTimeout(() => res.end("slow but whole"), READ_MS * 2);
  });
  servers.push(slow);
  await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
  const slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
  const client = clientOf(hanging);

  // The call has put its `fetch` in place by now. A request of the process that is made while the
  // call runs, and outlives the call's limit, is no part of the call and is not cancelled with it.
  const call = rejection(client.getTask(1n));
  const outside = fetch(slowUrl).then((res) => res.text());
  expect((await call).code).toBe("E_TIMEOUT");
  expect(await outside).toBe("slow but whole");
});
