import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extractEvents } from "@tender/shared";
import { afterEach, expect, test, vi } from "vitest";
import { createNeardataSource, type NeardataOptions } from "../src/neardata";
import type { BlockSource, IndexedBlock } from "../src/types";
import { eventLine, FIXTURE_CONTRACT } from "./fixtures/blocks";

// Every test runs offline, against a fake `fetchImpl` that plays neardata.
//
// REAL FIXTURES. test/fixtures/neardata holds three consecutive testnet blocks, 275370831 to
// 275370833, recorded on 2026-10-29 with GET https://testnet.neardata.xyz/v0/block/<height> (no
// key). The files are as neardata sent them, with whitespace only changed by `biome format`; every
// number token is kept (a block's `timestamp` is a u64 that JSON.parse cannot hold, which is why
// the source reads `timestamp_nanosec`). Block 831 has no receipt, 832 has one and 833 has three,
// all successful. The only logs are two nep171 events of an unrelated contract, one in each of
// 832 and 833.
//
// PATCHED, NOT FROM CHAIN. No real Tender block exists until Tender is deployed on testnet, so
// `blockWithTenderReceipts` adds two receipt outcomes of the Tender contract to a copy of block
// 833 in memory. Each is a copy of the first recorded outcome of that shard, with only these
// fields replaced (and no others):
//   execution_outcome.id                      "patched-..."
//   execution_outcome.outcome.executor_id     the Tender contract (tender.test.near)
//   execution_outcome.outcome.status          SuccessValue, or a Failure
//   execution_outcome.outcome.logs            an EVENT_JSON line of the contract's captured logs
//                                             (packages/shared/test/fixtures/events)
//   receipt.receipt_id, receipt.receiver_id   to match
// The patched block also went through JSON.parse and JSON.stringify, which rounds the u64
// `timestamp` number of its header; the source does not read that field.
// Real Tender blocks are owed: record them once the contract is on testnet.
//
// The other tests use a synthetic chain (`chainBlock`) that has only the fields the source reads.
// A block names its parent (`prev_height`) and the source checks that against what it has yielded,
// so where a test leaves a height out, the block after it names the one before it (`parentOf`).

const FIXTURES = new URL("./fixtures/neardata/", import.meta.url);
const REAL_FIRST = 275370831;
const REAL_FINAL = 275370833;

/** The recorded block at `height`, exactly as the file has it. */
function recorded(height: number): string {
  return readFileSync(new URL(`${height}.json`, FIXTURES), "utf8");
}

const BASE = "https://neardata.test";
const FINAL = "/v0/last_block/final";
const blockPath = (height: number) => `/v0/block/${height}`;
const heightOf = (path: string) => Number(path.slice("/v0/block/".length));
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const heightsOf = (blocks: IndexedBlock[]) => blocks.map((block) => Number(block.height));

// ---- the fake server --------------------------------------------------------------------------

interface Call {
  path: string;
  /** The Nth request for this path (1 for the first). */
  n: number;
  /** `Date.now()` when it arrived: the fake clock's, in a test that fakes `Date`. */
  at: number;
  authorization: string | null;
}

interface Incoming {
  path: string;
  n: number;
  /** The signal the source gave to fetch: aborted when it gives up on the request. */
  signal: AbortSignal;
}

function fakeServer(handler: (request: Incoming) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const n = (counts.get(path) ?? 0) + 1;
    counts.set(path, n);
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ path, n, at: Date.now(), authorization });
    return handler({ path, n, signal: init?.signal ?? new AbortController().signal });
  };
  return {
    fetch: fetchImpl,
    calls,
    count: (path: string) => counts.get(path) ?? 0,
    /** How many requests for blocks (not for the final height) have arrived. */
    blockRequests: () => calls.filter((call) => call.path !== FINAL).length,
    finalRequests: () => calls.filter((call) => call.path === FINAL).length,
  };
}
type Server = ReturnType<typeof fakeServer>;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const failure = (status: number) => new Response("upstream says no", { status });

/** A request that never gets an answer, and fails as fetch does when its signal aborts. */
function hang(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("This operation was aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * A 200 whose body never arrives, and which fails as a body does when the request's signal
 * aborts. `hang` stalls before the headers; this stalls after them, where a timeout that stopped
 * counting once `fetch` had answered would be missed.
 */
function stalledBody(signal: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () =>
        controller.error(new DOMException("This operation was aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
  });
  return new Response(body, { headers: { "content-type": "application/json" } });
}

/** The parent of block `height` on a chain that has no block at the `skipped` heights. */
function parentOf(height: number, skipped: ReadonlySet<number> = new Set()): number {
  let parent = height - 1;
  while (skipped.has(parent)) parent -= 1;
  return parent;
}

const FIRST_NS = 1_793_317_828_000_000_000n;
/** A block as neardata serves it, reduced to what the source reads. */
function chainBlock(height: number, over: { prev?: number; outcomes?: unknown[] } = {}) {
  return {
    block: {
      header: {
        height,
        prev_height: over.prev ?? height - 1,
        timestamp_nanosec: String(FIRST_NS + BigInt(height) * 570_000_000n),
      },
    },
    shards: [{ shard_id: 0, receipt_execution_outcomes: over.outcomes ?? [] }],
  };
}

/** One entry of `receipt_execution_outcomes`, with the fields the source reads. */
function outcome(id: string, status: unknown, logs: string[] = [], executor = "someone.test.near") {
  return { execution_outcome: { id, outcome: { executor_id: executor, status, logs } } };
}

function source(server: Server, over: Partial<NeardataOptions> = {}): BlockSource {
  return createNeardataSource({ baseUrl: BASE, fetchImpl: server.fetch, ...over });
}

// ---- driving a source -------------------------------------------------------------------------

/** The first `count` blocks of `src` from `from`, after which the source is dropped. */
async function take(src: BlockSource, from: bigint, count: number): Promise<IndexedBlock[]> {
  const ctrl = new AbortController();
  const got: IndexedBlock[] = [];
  for await (const block of src.blocks(from, ctrl.signal)) {
    got.push(block);
    if (got.length === count) break;
  }
  ctrl.abort();
  return got;
}

/** Runs `src` in the background, collecting the heights it yields until `ctrl` aborts. */
function run(src: BlockSource, from: bigint) {
  const ctrl = new AbortController();
  const heights: number[] = [];
  const finished = (async () => {
    for await (const block of src.blocks(from, ctrl.signal)) heights.push(Number(block.height));
  })();
  return { ctrl, heights, finished };
}

// For the tests that fake the clock. `settle` lets everything that does not wait for the clock
// finish, and `tick` moves the clock and then settles. Only `setTimeout`, `clearTimeout` and
// `Date` are faked: setImmediate is the real one, which is what `settle` waits on.
function fakeClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
async function tick(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await settle();
}

afterEach(() => {
  vi.useRealTimers();
});

// ---- mapping ----------------------------------------------------------------------------------

test("maps_receipts_and_status", async () => {
  const server = fakeServer(
    ({ path }) => new Response(recorded(path === FINAL ? REAL_FINAL : heightOf(path))),
  );

  const blocks = await take(source(server), BigInt(REAL_FIRST), 3);

  // timestampNs is `timestamp_nanosec` to the last digit: the u64 `timestamp` of block 833 reads
  // as ...673600 through JSON.parse.
  expect(blocks.map((block) => [block.height, block.timestampNs])).toEqual([
    [275370831n, 1793317828477880175n],
    [275370832n, 1793317829187249685n],
    [275370833n, 1793317829783673527n],
  ]);
  // A block with no receipt is still a block: the indexer moves its cursor on it.
  expect(blocks[0]?.receipts).toEqual([]);
  expect(blocks[1]?.receipts).toEqual([
    {
      receiptId: "D3wjcuiGpyhHadNwWFe3za4pP67VVmAEYhFp5bfPezuZ",
      executorId: "epochals.testnet",
      status: "success",
      logs: [
        'EVENT_JSON:{"standard":"nep171","version":"1.0.0","event":"nft_transfer","data":[{"old_owner_id":"epochals-sphere.testnet","new_owner_id":"epochals-orbit.testnet","token_ids":["1731"],"memo":"epochals · the ark of NEAR"}]}',
      ],
    },
  ]);
  // The receipts of a block are those of its shards in the order of the file's `shards` array
  // (shard 9 sits before shard 4 there), each shard's in the order of the file.
  expect(
    blocks[2]?.receipts.map((r) => [r.receiptId, r.executorId, r.status, r.logs.length]),
  ).toEqual([
    ["Ak61Hb6FHRndnkvTi98oLLHqNXvvv9EcdfRNjjDHbmGo", "epochals.testnet", "success", 1],
    ["5A5xMLbkuBtwzYX21oGzL36coo49gZMHkuLA3k5rBo6y", "epochals-sphere.testnet", "success", 0],
    ["C5hCfr3qf2rWyyVbxQWhjPrcohUwZS1Eyg82Le2ohN7g", "p383e7a90a03a9.testnet", "success", 0],
  ]);
});

interface RecordedOutcome {
  execution_outcome: {
    id: string;
    outcome: { executor_id: string; status: unknown; logs: string[] };
  };
  receipt: { receipt_id: string; receiver_id: string };
}
interface RecordedBlock {
  shards: Array<{ receipt_execution_outcomes: RecordedOutcome[] }>;
}

/** Block 275370833 with two outcomes of the Tender contract added. See PATCHED at the top. */
function blockWithTenderReceipts(): RecordedBlock {
  const block = JSON.parse(recorded(REAL_FINAL)) as RecordedBlock;
  const shard = block.shards.find((s) => s.receipt_execution_outcomes.length > 0);
  const template = shard?.receipt_execution_outcomes[0];
  if (!shard || !template) throw new Error("block 275370833 has no receipt to copy");
  const patched = (id: string, status: unknown, line: string): RecordedOutcome => {
    const copy = structuredClone(template);
    copy.execution_outcome.id = id;
    copy.execution_outcome.outcome.executor_id = FIXTURE_CONTRACT;
    copy.execution_outcome.outcome.status = status;
    copy.execution_outcome.outcome.logs = [line];
    copy.receipt.receipt_id = id;
    copy.receipt.receiver_id = FIXTURE_CONTRACT;
    return copy;
  };
  shard.receipt_execution_outcomes.push(
    patched("patched-task-created", { SuccessValue: "" }, eventLine("task_created")),
    patched(
      "patched-committed-but-failed",
      { Failure: { ActionError: {} } },
      eventLine("committed"),
    ),
  );
  return block;
}

test("tender_events_come_through_the_mapping", async () => {
  const patched = blockWithTenderReceipts();
  const server = fakeServer(() => json(patched));

  const [block] = await take(source(server), BigInt(REAL_FINAL), 1);

  const status = Object.fromEntries((block?.receipts ?? []).map((r) => [r.receiptId, r.status]));
  expect(status["patched-task-created"]).toBe("success");
  expect(status["patched-committed-but-failed"]).toBe("failure");
  // What the indexer does with the block: the failed receipt's event and the nep171 log of the
  // other contract are not Tender events, and the successful receipt's is.
  const events = extractEvents(block?.receipts ?? [], FIXTURE_CONTRACT);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    event: "task_created",
    receiptId: "patched-task-created",
    logIndex: 0,
  });
});

test("unknown_status_is_failure", async () => {
  // Only the two success shapes of the RPC's ExecutionStatusView are a success (rulings P02-R17
  // and P03-P6): a status that is not one of them is a failure, and does not throw.
  const cases: Array<[status: unknown, expected: "success" | "failure"]> = [
    [{ SuccessValue: "" }, "success"],
    [{ SuccessReceiptId: "5A5xMLbkuBtwzYX21oGzL36coo49gZMHkuLA3k5rBo6y" }, "success"],
    [{ Failure: { ActionError: { index: 0, kind: "AccountDoesNotExist" } } }, "failure"],
    ["Unknown", "failure"],
  ];
  const body = chainBlock(10, {
    outcomes: cases.map(([status], i) => outcome(`receipt-${i}`, status)),
  });
  const server = fakeServer(() => json(body));

  const [block] = await take(source(server), 10n, 1);

  expect(block?.receipts.map((r) => r.status)).toEqual(cases.map(([, expected]) => expected));
});

// ---- order and concurrency --------------------------------------------------------------------

/** mulberry32: the same sequence for the same seed. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Serves every height up to `last` after a random delay, and watches how many are in flight.
 * `nullOnce`, if given, is a height that has a block but answers null the first time it is asked.
 */
function slowChain(last: number, seed: number, nullOnce?: number) {
  const random = seeded(seed);
  const answered: number[] = [];
  const watch = { inFlight: 0, peak: 0 };
  const server = fakeServer(async ({ path, n }) => {
    if (path === FINAL) return json(chainBlock(last));
    const height = heightOf(path);
    watch.inFlight += 1;
    watch.peak = Math.max(watch.peak, watch.inFlight);
    await new Promise((resolve) => setTimeout(resolve, random() * 20));
    watch.inFlight -= 1;
    answered.push(height);
    return json(height === nullOnce && n === 1 ? null : chainBlock(height));
  });
  return { server, answered, watch };
}

test("yields_in_order_with_concurrency", async () => {
  const first = 1000;
  const last = 1059;

  const { server, answered, watch } = slowChain(last, 7);
  const got = await take(source(server), BigInt(first), last - first + 1);

  // Every height once and in order, although the server answered them in another order.
  expect(heightsOf(got)).toEqual(range(first, last));
  expect(answered).not.toEqual(range(first, last));
  expect(answered.toSorted((a, b) => a - b)).toEqual(range(first, last));
  // The default is 4 at a time.
  expect(watch.peak).toBe(4);
});

test("concurrency_caps_requests_in_flight", async () => {
  for (const concurrency of [1, 2, 3, 12]) {
    const { server, watch } = slowChain(539, concurrency);

    const got = await take(source(server, { concurrency }), 500n, 40);

    expect(heightsOf(got)).toEqual(range(500, 539));
    expect(watch.peak).toBe(concurrency);
  }
});

test("concurrency_caps_requests_in_flight_during_a_refetch", async () => {
  // The same, with 520 answering null the first time. Fetching it again, when 521 names it, is one
  // request more: it has to take the place of one the window would have started, not come on top.
  for (const concurrency of [1, 2, 3, 12]) {
    const { server, watch } = slowChain(539, concurrency, 520);

    const got = await take(source(server, { concurrency }), 500n, 40);

    expect(heightsOf(got), `concurrency ${concurrency}`).toEqual(range(500, 539));
    expect(server.count(blockPath(520)), `concurrency ${concurrency}: 520 asked twice`).toBe(2);
    expect(watch.peak, `concurrency ${concurrency}`).toBe(concurrency);
  }
});

// ---- heights without a block ------------------------------------------------------------------

test("null_height_skipped", async () => {
  const skipped = new Set([12, 14]);
  const block = (height: number) => chainBlock(height, { prev: parentOf(height, skipped) });
  const server = fakeServer(({ path }) => {
    if (path === FINAL) return json(block(15));
    const height = heightOf(path);
    return skipped.has(height) ? json(null) : json(block(height));
  });

  const got = await take(source(server), 10n, 4);

  expect(heightsOf(got)).toEqual([10, 11, 13, 15]);
  // A null is an answer, not a failure: it is not asked for again.
  expect(server.count(blockPath(12))).toBe(1);
  expect(server.count(blockPath(14))).toBe(1);
});

test("a_genuinely_skipped_height_still_skips", async () => {
  // Heights with no block, answered null, which the blocks after them agree with: each next block
  // names a parent before the gap. They are skipped, each asked for once, and nothing is logged.
  // (A null the next block does not agree with is the next section.)
  const cases: Array<
    [name: string, from: number, final: number, skipped: number[], yielded: number[]]
  > = [
    ["the first height", 10, 13, [10], [11, 12, 13]],
    ["the first several heights", 10, 13, [10, 11], [12, 13]],
    ["several in a row", 10, 16, [12, 13, 14], [10, 11, 15, 16]],
    ["every other height", 10, 14, [11, 13], [10, 12, 14]],
    // The run starts after a gap: 8 and 9 are never asked for, but the first block names 7. That
    // is below `fromHeight - 1`, and is no cause for a warning, as nothing was yielded before it.
    ["a gap before the start", 10, 12, [8, 9], [10, 11, 12]],
  ];
  for (const [name, from, final, skipped, yielded] of cases) {
    fakeClock();
    const gaps = new Set(skipped);
    const block = (height: number) => chainBlock(height, { prev: parentOf(height, gaps) });
    const lines: string[] = [];
    const server = fakeServer(({ path }) => {
      if (path === FINAL) return json(block(final));
      const height = heightOf(path);
      return gaps.has(height) ? json(null) : json(block(height));
    });
    const src = source(server, { log: (line) => lines.push(line) });
    const { ctrl, heights, finished } = run(src, BigInt(from));

    await settle();

    expect(heights, name).toEqual(yielded);
    expect(server.blockRequests(), `${name}: every height asked for once`).toBe(final - from + 1);
    expect(lines, `${name}: nothing to report`).toEqual([]);

    ctrl.abort();
    await finished;
    vi.useRealTimers();
  }
});

test("the_next_block_for_a_skipped_height_is_a_skip", async () => {
  fakeClock();
  // The chain goes 11, 13. The spec (7.1) says a height with no block may redirect instead of
  // returning null; here the redirect lands on the next block, 13.
  const skipped = new Set([12]);
  const block = (height: number) => chainBlock(height, { prev: parentOf(height, skipped) });
  const server = fakeServer(({ path }) => {
    if (path === FINAL) return json(block(13));
    const height = heightOf(path);
    return json(height === 12 ? block(13) : block(height));
  });
  const { ctrl, heights, finished } = run(source(server), 10n);

  await settle();

  // 13 comes once, for its own request, and not a second time as the answer for 12 (all of what
  // the source has to give is here: it has caught up and is waiting to poll).
  expect(heights).toEqual([10, 11, 13]);
  expect(server.count(blockPath(12))).toBe(1);
  expect(server.count(blockPath(13))).toBe(1);

  ctrl.abort();
  await finished;
});

test("a_wrong_block_is_retried_never_yielded", async () => {
  fakeClock();
  const server = fakeServer(({ path, n }) => {
    if (path === FINAL) return json(chainBlock(13));
    const height = heightOf(path);
    if (height !== 12) return json(chainBlock(height));
    // An older block; then a later one whose parent is 12 itself, so 12 is not a skip; then 12.
    if (n === 1) return json(chainBlock(9));
    if (n === 2) return json(chainBlock(14, { prev: 12 }));
    return json(chainBlock(12));
  });
  const { ctrl, heights, finished } = run(source(server), 11n);

  await settle();
  expect(heights).toEqual([11]);
  await tick(500);
  expect(server.count(blockPath(12))).toBe(2);
  await tick(1000);
  expect(server.count(blockPath(12))).toBe(3);
  expect(heights).toEqual([11, 12, 13]);

  ctrl.abort();
  await finished;
});

// ---- a height with a block that was answered as having none -----------------------------------
//
// Every block names its parent. A server that is behind can answer null for a height that has a
// block; the block after it then names that height, and the source fetches it again and yields it
// first (ruling P03-R2).

test("null_for_an_existing_height_is_refetched", async () => {
  fakeClock();
  const lines: string[] = [];
  // Block 12 exists, and 13 names it as its parent. Neardata answers null for it the first time.
  const server = fakeServer(({ path, n }) => {
    if (path === FINAL) return json(chainBlock(14));
    const height = heightOf(path);
    return height === 12 && n === 1 ? json(null) : json(chainBlock(height));
  });
  const src = source(server, { log: (line) => lines.push(line) });
  const { ctrl, heights, finished } = run(src, 10n);

  await settle();

  // 12 comes before 13, which named it, and once. Its second answer was a block, so no wait.
  expect(heights).toEqual([10, 11, 12, 13, 14]);
  expect(server.count(blockPath(12))).toBe(2);
  expect(server.blockRequests()).toBe(6);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/block 13.*block 12/);

  ctrl.abort();
  await finished;
});

test("two_null_heights_in_a_row_are_both_refetched", async () => {
  fakeClock();
  const lines: string[] = [];
  // 11 and 12 both have a block and both answer null the first time. 13 names 12, and 12 names 11,
  // so the way back from 13 is two parents long, and the second one is found only by the block
  // that was fetched for the first.
  const server = fakeServer(({ path, n }) => {
    if (path === FINAL) return json(chainBlock(13));
    const height = heightOf(path);
    return (height === 11 || height === 12) && n === 1 ? json(null) : json(chainBlock(height));
  });
  const src = source(server, { log: (line) => lines.push(line) });
  const { ctrl, heights, finished } = run(src, 10n);

  await settle();

  expect(heights).toEqual([10, 11, 12, 13]);
  expect(server.count(blockPath(11))).toBe(2);
  expect(server.count(blockPath(12))).toBe(2);
  expect(server.blockRequests()).toBe(6);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/block 13.*block 12/);
  expect(lines[1]).toMatch(/block 12.*block 11/);

  ctrl.abort();
  await finished;
});

test("first_block_checked_against_from_height", async () => {
  fakeClock();
  // Nothing was yielded yet to check the first block against, so its parent is checked against
  // `fromHeight`. 11 names 10, which is not below 10, so 10 has a block although it answered null.
  const server = fakeServer(({ path, n }) => {
    if (path === FINAL) return json(chainBlock(12));
    const height = heightOf(path);
    return height === 10 && n === 1 ? json(null) : json(chainBlock(height));
  });
  const { ctrl, heights, finished } = run(source(server), 10n);

  await settle();

  expect(heights).toEqual([10, 11, 12]);
  expect(server.count(blockPath(10))).toBe(2);

  ctrl.abort();
  await finished;
});

test("the_refetch_waits_until_neardata_has_the_block", async () => {
  fakeClock();
  const lines: string[] = [];
  // 12 has a block, and neardata keeps saying it has none: null, then (as a redirect would) a later
  // block whose parent is before 12, then the block. The first two are errors here, not skips.
  const server = fakeServer(({ path, n }) => {
    if (path === FINAL) return json(chainBlock(15));
    const height = heightOf(path);
    if (height !== 12) return json(chainBlock(height));
    if (n <= 2) return json(null);
    return n === 3 ? json(chainBlock(13, { prev: 11 })) : json(chainBlock(12));
  });
  const src = source(server, { log: (line) => lines.push(line) });
  const { ctrl, heights, finished } = run(src, 10n);

  // 13 named 12, which is asked for again and is null again. 13, 14 and 15 are fetched already,
  // and wait behind it.
  await settle();
  expect(heights).toEqual([10, 11]);
  expect(server.count(blockPath(12))).toBe(2);
  await tick(499);
  expect(server.count(blockPath(12))).toBe(2);
  await tick(1);
  // The third answer is the redirect form, which is no answer either: the wait is now 1 s.
  expect(server.count(blockPath(12))).toBe(3);
  await tick(999);
  expect(server.count(blockPath(12))).toBe(3);
  expect(heights).toEqual([10, 11]);
  await tick(1);
  expect(server.count(blockPath(12))).toBe(4);
  expect(heights).toEqual([10, 11, 12, 13, 14, 15]);

  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(/block 13.*block 12/);
  expect(lines[1]).toContain("500 ms");
  expect(lines[2]).toContain("1000 ms");

  ctrl.abort();
  await finished;
});

test("a_null_at_the_tip_is_refetched_when_the_next_block_arrives", async () => {
  fakeClock();
  // 12 is the newest block neardata has, and it answers null for it once. No block names 12 yet.
  // When the chain moves on, 13 does, in a later poll: the check has to remember what was yielded
  // from one poll to the next.
  let final = 12;
  const server = fakeServer(({ path, n }) => {
    if (path === FINAL) return json(chainBlock(final));
    const height = heightOf(path);
    return height === 12 && n === 1 ? json(null) : json(chainBlock(height));
  });
  const { ctrl, heights, finished } = run(source(server), 10n);

  await settle();
  expect(heights).toEqual([10, 11]);

  final = 13;
  await tick(1000);

  expect(heights).toEqual([10, 11, 12, 13]);
  expect(server.count(blockPath(12))).toBe(2);
  expect(server.count(blockPath(13))).toBe(1);

  ctrl.abort();
  await finished;
});

test("a_block_naming_a_parent_below_the_last_one_yielded_is_yielded_and_warned_about", async () => {
  fakeClock();
  const lines: string[] = [];
  // 11 names 9 as its parent, although 10 was yielded just before it, so 10 is no ancestor of 11:
  // a fork, or a server that disagrees with itself. The source cannot tell which is right, and
  // does not stop for it: the block comes, and the log is told.
  const server = fakeServer(({ path }) => {
    if (path === FINAL) return json(chainBlock(12));
    const height = heightOf(path);
    return json(height === 11 ? chainBlock(11, { prev: 9 }) : chainBlock(height));
  });
  const src = source(server, { log: (line) => lines.push(line) });
  const { ctrl, heights, finished } = run(src, 10n);

  await settle();

  expect(heights).toEqual([10, 11, 12]);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/WARN.*block 11.*block 9.*block 10/);
  // Nothing was fetched again, and 12, which names 11, is as it should be.
  expect(server.blockRequests()).toBe(3);

  ctrl.abort();
  await finished;
});

// ---- retries ----------------------------------------------------------------------------------

test("retries_5xx_never_skips", async () => {
  fakeClock();
  const server = fakeServer(({ path, n }) => {
    if (path === FINAL) return json(chainBlock(12));
    const height = heightOf(path);
    return height === 11 && n <= 2 ? failure(503) : json(chainBlock(height));
  });
  const { ctrl, heights, finished } = run(source(server), 10n);

  await settle();
  // 10 came; 11 failed and waits 0.5 s; 12 is done and waits behind 11.
  expect(heights).toEqual([10]);
  expect(server.count(blockPath(11))).toBe(1);
  await tick(499);
  expect(server.count(blockPath(11))).toBe(1);
  await tick(1);
  expect(server.count(blockPath(11))).toBe(2);
  // The second 503 makes it wait 1 s.
  await tick(999);
  expect(server.count(blockPath(11))).toBe(2);
  expect(heights).toEqual([10]);
  await tick(1);
  expect(server.count(blockPath(11))).toBe(3);
  expect(heights).toEqual([10, 11, 12]);

  ctrl.abort();
  await finished;
});

test("backoff_runs_0.5_1_2_4_8_8_seconds", async () => {
  fakeClock();
  const server = fakeServer(({ path }) => (path === FINAL ? json(chainBlock(10)) : failure(500)));
  const start = Date.now();
  const { ctrl, heights, finished } = run(source(server), 10n);

  await settle();
  for (let elapsed = 0; elapsed < 40_000; elapsed += 500) await tick(500);

  const attempts = server.calls.filter((c) => c.path === blockPath(10)).map((c) => c.at - start);
  expect(attempts).toEqual([0, 500, 1500, 3500, 7500, 15_500, 23_500, 31_500, 39_500]);
  expect(heights).toEqual([]);

  ctrl.abort();
  await finished;
});

test("a_stalled_request_times_out_after_10_s_and_is_retried", async () => {
  fakeClock();
  const gaveUp: number[] = [];
  const server = fakeServer(({ path, n, signal }) => {
    if (path === FINAL) return json(chainBlock(10));
    if (n > 1) return json(chainBlock(10));
    signal.addEventListener("abort", () => gaveUp.push(Date.now()), { once: true });
    return hang(signal);
  });
  const start = Date.now();
  const { ctrl, heights, finished } = run(source(server), 10n);

  await settle();
  await tick(9999);
  expect(gaveUp).toEqual([]);
  await tick(1);
  expect(gaveUp.map((at) => at - start)).toEqual([10_000]);
  // Then the usual first wait, 0.5 s.
  await tick(499);
  expect(server.count(blockPath(10))).toBe(1);
  await tick(1);
  expect(server.count(blockPath(10))).toBe(2);
  expect(heights).toEqual([10]);

  ctrl.abort();
  await finished;
});

test("a_stalled_body_times_out_after_10_s_and_is_retried", async () => {
  fakeClock();
  const gaveUp: number[] = [];
  // The headers come at once and the body never does. The 10 s are for the answer, body included.
  const server = fakeServer(({ path, n, signal }) => {
    if (path === FINAL) return json(chainBlock(10));
    if (n > 1) return json(chainBlock(10));
    signal.addEventListener("abort", () => gaveUp.push(Date.now()), { once: true });
    return stalledBody(signal);
  });
  const start = Date.now();
  const { ctrl, heights, finished } = run(source(server), 10n);

  await settle();
  await tick(9999);
  expect(gaveUp).toEqual([]);
  expect(server.count(blockPath(10))).toBe(1);
  await tick(1);
  expect(gaveUp.map((at) => at - start)).toEqual([10_000]);
  // Then the usual first wait, 0.5 s.
  await tick(499);
  expect(server.count(blockPath(10))).toBe(1);
  await tick(1);
  expect(server.count(blockPath(10))).toBe(2);
  expect(heights).toEqual([10]);

  ctrl.abort();
  await finished;
});

test("every_kind_of_failure_is_retried", async () => {
  // Including a 4xx. The source cannot tell a trouble of the moment (a replica that is behind, a
  // rate limit) from one that will last (a wrong key), and giving up on a block is a gap.
  const failures: Array<[name: string, reply: () => Response]> = [
    [
      "network error",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
    ["HTTP 500", () => failure(500)],
    ["HTTP 502", () => failure(502)],
    ["HTTP 429", () => failure(429)],
    ["HTTP 404", () => failure(404)],
    ["a body that is not JSON", () => new Response("<html>bad gateway</html>")],
    ["a body of another shape", () => json({ error: "try later" })],
    ["a block with no timestamp", () => json({ block: { header: { height: 11 } }, shards: [] })],
    // Its parent would be a height to fetch that is not below it, and so a walk that never ends.
    ["a block that is its own parent", () => json(chainBlock(11, { prev: 11 }))],
    [
      "a receipt with logs that are not text",
      () => json(chainBlock(11, { outcomes: [outcome("r", {}, [1 as unknown as string])] })),
    ],
  ];
  for (const [name, reply] of failures) {
    fakeClock();
    const server = fakeServer(({ path, n }) => {
      if (path === FINAL) return json(chainBlock(12));
      const height = heightOf(path);
      return height === 11 && n === 1 ? reply() : json(chainBlock(height));
    });
    const { ctrl, heights, finished } = run(source(server), 10n);

    await settle();
    await tick(499);
    expect(heights, `${name}: 11 is not skipped or passed`).toEqual([10]);
    await tick(1);
    expect(heights, `${name}: 11 is tried again after 0.5 s`).toEqual([10, 11, 12]);
    expect(server.count(blockPath(11)), name).toBe(2);

    ctrl.abort();
    await finished;
    vi.useRealTimers();
  }
});

test("reports_each_failed_attempt_to_log", async () => {
  fakeClock();
  const lines: string[] = [];
  const server = fakeServer(({ path, n }) =>
    path === FINAL
      ? json(chainBlock(11))
      : n === 1
        ? failure(503)
        : json(chainBlock(heightOf(path))),
  );
  const { ctrl, finished } = run(source(server, { log: (line) => lines.push(line) }), 11n);

  await settle();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(`${BASE}${blockPath(11)}`);
  expect(lines[0]).toContain("HTTP 503");
  expect(lines[0]).toContain("500 ms");

  ctrl.abort();
  await finished;
});

// ---- polling ----------------------------------------------------------------------------------

test("polls_when_caught_up", async () => {
  fakeClock();
  let final = 12;
  const server = fakeServer(({ path }) =>
    json(path === FINAL ? chainBlock(final) : chainBlock(heightOf(path))),
  );
  // pollMs is left at its default, which is 1000.
  const { ctrl, heights, finished } = run(source(server), 10n);

  await settle();
  expect(heights).toEqual([10, 11, 12]);

  // Caught up: the final height is asked for once per pollMs, and no block is fetched.
  const polled = server.finalRequests();
  await tick(999);
  expect(server.finalRequests()).toBe(polled);
  await tick(1);
  expect(server.finalRequests()).toBe(polled + 1);
  await tick(1000);
  expect(server.finalRequests()).toBe(polled + 2);
  expect(server.blockRequests()).toBe(3);

  // The chain moves on; the next poll finds 13 and 14, and they come in order, each once.
  final = 14;
  await tick(1000);
  expect(heights).toEqual([10, 11, 12, 13, 14]);
  expect(server.blockRequests()).toBe(5);

  ctrl.abort();
  await finished;
});

test("waits_for_the_chain_to_reach_the_start_height", async () => {
  fakeClock();
  let final = 12;
  const server = fakeServer(({ path }) =>
    json(path === FINAL ? chainBlock(final) : chainBlock(heightOf(path))),
  );
  const { ctrl, heights, finished } = run(source(server, { pollMs: 500 }), 20n);

  await settle();
  await tick(2000);
  expect(heights).toEqual([]);
  expect(server.blockRequests()).toBe(0);
  final = 20;
  await tick(500);
  expect(heights).toEqual([20]);

  ctrl.abort();
  await finished;
});

// ---- stopping ---------------------------------------------------------------------------------

test("stops_on_abort", async () => {
  // Four block requests are in flight and none is ever answered.
  const gaveUp: string[] = [];
  const server = fakeServer(({ path, signal }) => {
    if (path === FINAL) return json(chainBlock(100));
    signal.addEventListener("abort", () => gaveUp.push(path), { once: true });
    return hang(signal);
  });
  const { ctrl, heights, finished } = run(source(server), 90n);
  await vi.waitFor(() => expect(server.blockRequests()).toBe(4));

  ctrl.abort();
  await finished;

  // The iteration ended by itself, no request is left running, and none was made afterwards.
  expect(heights).toEqual([]);
  expect(gaveUp.toSorted()).toEqual(range(90, 93).map(blockPath).toSorted());
  const requests = server.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(server.calls.length).toBe(requests);
});

test("stops_on_abort_while_backing_off", async () => {
  fakeClock();
  const server = fakeServer(({ path }) => (path === FINAL ? json(chainBlock(10)) : failure(503)));
  const { ctrl, finished } = run(source(server), 10n);
  await settle();
  expect(server.count(blockPath(10))).toBe(1);
  expect(vi.getTimerCount()).toBe(1); // the 0.5 s wait, and no timeout left over from the request

  ctrl.abort();
  await finished; // would hang until the clock moved if the 0.5 s wait were not cut short

  expect(vi.getTimerCount()).toBe(0);
  await tick(60_000);
  expect(server.count(blockPath(10))).toBe(1);
});

test("stops_on_abort_while_waiting_to_poll", async () => {
  fakeClock();
  const server = fakeServer(() => json(chainBlock(10)));
  const { ctrl, heights, finished } = run(source(server, { pollMs: 1000 }), 11n);
  await settle();
  expect(heights).toEqual([]);
  expect(vi.getTimerCount()).toBe(1); // the wait before the next poll

  ctrl.abort();
  await finished;

  expect(vi.getTimerCount()).toBe(0);
});

test("stops_on_abort_during_a_refetch", async () => {
  // 12 answered null the first time, so 13 (held, with 14 and 15 fetched behind it) sends the
  // source back for it. The abort comes while that second request is in flight, or while it waits
  // to be made a third time.
  const cases: Array<
    [
      name: string,
      reply: (signal: AbortSignal) => Response | Promise<Response>,
      cancelled: string[],
    ]
  > = [
    ["in flight", hang, [blockPath(12)]],
    ["waiting to retry", () => json(null), []],
  ];
  for (const [name, reply, cancelled] of cases) {
    fakeClock();
    const gaveUp: string[] = [];
    const server = fakeServer(({ path, n, signal }) => {
      if (path === FINAL) return json(chainBlock(15));
      const height = heightOf(path);
      if (height !== 12) return json(chainBlock(height));
      if (n === 1) return json(null);
      signal.addEventListener("abort", () => gaveUp.push(path), { once: true });
      return reply(signal);
    });
    const { ctrl, heights, finished } = run(source(server), 10n);
    await settle();
    expect(heights, name).toEqual([10, 11]);
    expect(server.count(blockPath(12)), `${name}: 12 is being fetched again`).toBe(2);
    expect(vi.getTimerCount(), `${name}: the 10 s limit, or the 0.5 s wait`).toBe(1);

    ctrl.abort();
    await finished; // rejects if the iteration threw

    expect(gaveUp, `${name}: the request is cancelled`).toEqual(cancelled);
    expect(vi.getTimerCount(), `${name}: no timer is left`).toBe(0);
    const requests = server.calls.length;
    await tick(60_000);
    expect(server.calls.length, `${name}: nothing is asked for afterwards`).toBe(requests);
    expect(heights, `${name}: the held blocks are not delivered`).toEqual([10, 11]);
    vi.useRealTimers();
  }
});

test("stops_between_blocks_even_when_more_are_ready", async () => {
  const server = fakeServer(({ path }) =>
    json(path === FINAL ? chainBlock(20) : chainBlock(heightOf(path))),
  );
  const ctrl = new AbortController();
  const got: number[] = [];

  for await (const block of source(server).blocks(10n, ctrl.signal)) {
    got.push(Number(block.height));
    ctrl.abort(); // blocks 11 to 13 are already fetched, and are not delivered
  }

  expect(got).toEqual([10]);
  const requests = server.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(server.calls.length).toBe(requests);
});

test("stops_between_the_blocks_of_a_walk_back", async () => {
  // 12 answered null the first time, so 13 is held while 12 is fetched again, and the two are
  // yielded one after the other. The caller aborts when it has 12: 13 is fetched, not delivered.
  const server = fakeServer(({ path, n }) => {
    if (path === FINAL) return json(chainBlock(16));
    const height = heightOf(path);
    return height === 12 && n === 1 ? json(null) : json(chainBlock(height));
  });
  const ctrl = new AbortController();
  const got: number[] = [];

  for await (const block of source(server).blocks(10n, ctrl.signal)) {
    got.push(Number(block.height));
    if (block.height === 12n) ctrl.abort();
  }

  expect(got).toEqual([10, 11, 12]);
  const requests = server.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(server.calls.length).toBe(requests);
});

test("does_nothing_when_already_aborted", async () => {
  const server = fakeServer(() => json(chainBlock(10)));
  const ctrl = new AbortController();
  ctrl.abort();
  const got: IndexedBlock[] = [];

  for await (const block of source(server).blocks(10n, ctrl.signal)) got.push(block);

  expect(got).toEqual([]);
  expect(server.calls).toEqual([]);
});

test("dropping_the_iterator_stops_what_is_in_flight", async () => {
  const gaveUp: string[] = [];
  const server = fakeServer(({ path, n, signal }) => {
    if (path === FINAL) return json(chainBlock(100));
    // Block 90 is answered; the four requests after it (91 to 94) are waiting when the caller leaves.
    if (path === blockPath(90) && n === 1) return json(chainBlock(90));
    signal.addEventListener("abort", () => gaveUp.push(path), { once: true });
    return hang(signal);
  });
  const ctrl = new AbortController();

  for await (const block of source(server).blocks(90n, ctrl.signal)) {
    expect(block.height).toBe(90n);
    break; // the caller never aborts its own signal
  }

  expect(gaveUp.toSorted()).toEqual([91, 92, 93, 94].map(blockPath).toSorted());
});

// ---- requests ---------------------------------------------------------------------------------

test("sends_the_api_key_as_a_bearer_token_only_when_set", async () => {
  const answer = ({ path }: Incoming) =>
    json(path === FINAL ? chainBlock(11) : chainBlock(heightOf(path)));

  const withKey = fakeServer(answer);
  // A trailing slash on the base URL does not double the one in the path.
  await take(source(withKey, { apiKey: "key-123", baseUrl: `${BASE}/` }), 10n, 2);
  expect(withKey.calls.map((call) => call.path).toSorted()).toEqual(
    [FINAL, blockPath(10), blockPath(11)].toSorted(),
  );
  expect(withKey.calls.map((call) => call.authorization)).toEqual(
    withKey.calls.map(() => "Bearer key-123"),
  );

  // No key, or an empty one (FASTNEAR_API_KEY= in a .env), sends no header at all.
  for (const apiKey of [undefined, ""]) {
    const without = fakeServer(answer);
    await take(source(without, { apiKey }), 10n, 2);
    expect(without.calls.length).toBeGreaterThan(0);
    expect(without.calls.map((call) => call.authorization)).toEqual(without.calls.map(() => null));
  }
});

test("rejects_options_that_cannot_work", () => {
  const server = fakeServer(() => json(null));
  for (const concurrency of [0, -1, 1.5, Number.NaN]) {
    expect(() => source(server, { concurrency })).toThrow(RangeError);
  }
  for (const pollMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => source(server, { pollMs })).toThrow(RangeError);
  }
});

// ---- the real fetch ---------------------------------------------------------------------------

interface Arrival {
  url: string;
  authorization: string | undefined;
}
type HttpServer = ReturnType<typeof createServer>;
const listening = (server: HttpServer) =>
  new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const originOf = (server: HttpServer) =>
  `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test("works_with_the_real_fetch", async () => {
  // Two local HTTP servers in neardata's manner, so that the real `fetch` runs where the fake
  // cannot show it: the relative 302 from last_block/final to the final block, the key kept on the
  // redirected request, an absolute 302 to the other server, which must not get the key, a 503
  // whose body is not read, and requests that are never answered and that an abort has to cut off.
  // Nothing leaves the machine.
  const seen: Arrival[] = [];
  const unanswered = new Set<string>();
  const cutOff: string[] = [];
  let busy = 1; // block 832 answers 503 once, and then sends the source to the other origin
  const elsewhere: Arrival[] = [];
  const other = createServer((req, res) => {
    const url = req.url ?? "";
    elsewhere.push({ url, authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" }).end(recorded(heightOf(url)));
  });
  const http = createServer((req, res) => {
    const url = req.url ?? "";
    seen.push({ url, authorization: req.headers.authorization });
    if (url === FINAL) {
      res.writeHead(302, { location: blockPath(REAL_FINAL) }).end();
    } else if (unanswered.has(url)) {
      req.on("close", () => cutOff.push(url));
    } else if (url === blockPath(REAL_FIRST + 1) && busy-- > 0) {
      res.writeHead(503, { "content-type": "text/plain" }).end("busy");
    } else if (url === blockPath(REAL_FIRST + 1)) {
      res.writeHead(302, { location: `${originOf(other)}${url}` }).end();
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(recorded(heightOf(url)));
    }
  });
  await Promise.all([listening(http), listening(other)]);
  try {
    const src = createNeardataSource({ baseUrl: originOf(http), apiKey: "key-123" });

    const got = await take(src, BigInt(REAL_FIRST), 3);

    expect(heightsOf(got)).toEqual([REAL_FIRST, REAL_FIRST + 1, REAL_FINAL]);
    expect(got[1]?.receipts).toHaveLength(1);
    // The final height, which redirects to (and so fetches) block 833; then 831, 832 twice (the
    // first answer was the 503, the second the redirect to the other server), and 833 again as a
    // block of its own. Every request to this server had the key.
    expect(seen.map((request) => request.url).toSorted()).toEqual(
      [
        FINAL,
        blockPath(REAL_FINAL),
        blockPath(REAL_FIRST),
        blockPath(REAL_FIRST + 1),
        blockPath(REAL_FIRST + 1),
        blockPath(REAL_FINAL),
      ].toSorted(),
    );
    expect(seen.map((request) => request.authorization)).toEqual(seen.map(() => "Bearer key-123"));
    // The other server was sent block 832 by an absolute URL, and fetch left the key behind.
    expect(elsewhere).toEqual([{ url: blockPath(REAL_FIRST + 1), authorization: undefined }]);

    // Now 831 and 832 are never answered, and the abort has to close their connections.
    seen.length = 0;
    unanswered.add(blockPath(REAL_FIRST)).add(blockPath(REAL_FIRST + 1));
    const { ctrl, heights, finished } = run(src, BigInt(REAL_FIRST));
    await vi.waitFor(() => expect(seen.filter((r) => unanswered.has(r.url))).toHaveLength(2));

    ctrl.abort();
    await finished;

    expect(heights).toEqual([]);
    await vi.waitFor(() => expect(cutOff.toSorted()).toEqual([...unanswered].toSorted()));
  } finally {
    for (const server of [http, other]) {
      server.close();
      server.closeAllConnections();
    }
  }
});
