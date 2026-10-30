import { createServer, type ServerResponse } from "node:http";
import { type AddressInfo, createServer as createNetServer, type Socket } from "node:net";
import { type TenderClient, TenderError } from "@tender/client";
import { type Db, getBlob, putBlob, setBlobPublic } from "@tender/db";
import {
  canonicalJson,
  type EntryView,
  ScorecardSchema,
  sha256Hex,
  type TaskView,
} from "@tender/shared";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { pinnedFetch } from "../src/fetch";
import {
  type FetchIo,
  fetchEntryContent,
  intakeTask,
  type JudgeChain,
  judgeTask,
  judgeTick,
  startJudge,
} from "../src/index";
import { checkJsonSchemaIsolated, openTaskScorer, type TaskScorer } from "../src/isolate";
import {
  at,
  blobUri,
  entry,
  fakeChain,
  insertTask,
  isPublic,
  JUDGE,
  judgeDeps,
  judgeRow,
  MINUTE_NS,
  NO_NETWORK,
  NOW,
  NOW_NS,
  PUBLIC_URL,
  putCriteria,
  putHeldout,
  putResult,
  resetDb,
  taskView,
  testDb,
} from "./helpers";

// The scorers run in workers, out of reach of a mock in this file. What starts the workers is
// real unless a test queues something else for it: a worker that misbehaves on cue, one that
// cannot be loaded, or a scorer that also moves the clock.
vi.mock("../src/isolate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/isolate")>();
  return {
    ...actual,
    openTaskScorer: vi.fn(actual.openTaskScorer),
    checkJsonSchemaIsolated: vi.fn(actual.checkJsonSchemaIsolated),
  };
});
const isolate = await vi.importActual<typeof import("../src/isolate")>("../src/isolate");

/** A worker that misbehaves on cue (see fixtures/rogue-worker.ts), and one that is not there. */
const ROGUE_WORKER = new URL("./fixtures/rogue-worker.ts", import.meta.url);
const NO_WORKER = new URL("./fixtures/no-such-worker.ts", import.meta.url);

/** Makes the next task's scorer start its workers from `workerUrl`. */
function nextScorerFrom(workerUrl: URL) {
  vi.mocked(openTaskScorer).mockImplementationOnce((task, options) =>
    isolate.openTaskScorer(task, { ...options, workerUrl }),
  );
}

/**
 * Makes the next task's scorer call `each` before it scores an entry, with the time left before
 * the stop line that the entry is given.
 */
function nextScorerCalls(each: (leftMs: number | undefined) => void) {
  vi.mocked(openTaskScorer).mockImplementationOnce((task, options): TaskScorer => {
    const real = isolate.openTaskScorer(task, options);
    return {
      score: (content, leftMs) => {
        each(leftMs);
        return real.score(content, leftMs);
      },
      close: () => real.close(),
    };
  });
}

const SECOND_NS = 1_000_000_000n;
/**
 * A pick window from 31 s before NOW to 9 s after it, for a test whose clock runs with real time
 * from NOW (`runningClock`): a tenth of it is 4 s, so the stop line is 5 s in, and a pick has until
 * 9 s to land.
 */
const SHORT_WINDOW: Partial<TaskView> = {
  reveal_deadline: (NOW_NS - 31n * SECOND_NS).toString(),
  pick_deadline: (NOW_NS + 9n * SECOND_NS).toString(),
};
/** A clock that reads NOW at the moment it is made, and runs with real time from there. */
function runningClock(): () => Date {
  const start = Date.now();
  return () => new Date(NOW.getTime() + (Date.now() - start));
}

const EXACT = {
  version: 1,
  kind: "exact",
  min_score: 100,
  split: [7000, 3000],
  has_heldout: true,
  normalize: ["trim", "lowercase"],
};
const HELDOUT = { exact: { expected: ["42", "forty-two"] } };
const REGEX = {
  version: 1,
  kind: "regex_cases",
  min_score: 100,
  split: "winner_take_all",
  has_heldout: false,
  examples: { match: ["a"], no_match: ["b"] },
};

/** Addresses on the public internet, for names that the fake networks resolve. */
const PUBLIC_IP = "93.184.216.34";
const OTHER_PUBLIC_IP = "151.101.1.69";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

let db: Db;

beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  vi.restoreAllMocks();
});

/** An answer revealed as one of our own blobs: who, what, and the block of the commit. */
type Answer = [account: string, text: string, block: bigint];

/**
 * Task 7, accepted at intake and in its judging window at `NOW`: `criteria` and `heldout` (the
 * exact task above unless given) are stored, and so is each answer, as its entrant's result blob.
 * `extra` entries are revealed after them, as they are. `view` changes the task.
 */
async function postJudged(
  answers: Answer[],
  o: {
    criteria?: object;
    heldout?: object | null;
    extra?: EntryView[];
    view?: Partial<TaskView>;
  } = {},
) {
  const heldout = o.heldout === undefined ? HELDOUT : o.heldout;
  const view = taskView({
    criteria_hash: await putCriteria(db, o.criteria ?? EXACT),
    heldout_commitment: heldout === null ? null : await putHeldout(db, heldout),
    ...o.view,
  });
  await insertTask(db, view, "accepted");
  const entries: EntryView[] = [];
  for (const [account, answer, block] of answers) {
    const sha = await putResult(db, answer, account);
    entries.push(entry(account, sha, blobUri(sha), block));
  }
  entries.push(...(o.extra ?? []));
  return { view, chain: fakeChain(view, entries), commitment: view.heldout_commitment ?? "" };
}

/** What the one `pick` was called with, and the scorecard it points at, as stored. */
async function picked(chain: ReturnType<typeof fakeChain>) {
  expect(chain.pick).toHaveBeenCalledTimes(1);
  const [taskId, winners, sha, uri] = chain.pick.mock.calls[0] ?? [];
  const blob = await getBlob(db, sha ?? "");
  if (blob === null) throw new Error("the scorecard pick names is not stored");
  // `written` is the document as stored. The schema's copy is not used for hashes: zod rebuilds
  // objects, and a copy can differ from what was hashed.
  const written = JSON.parse(text(blob.bytes));
  return { taskId, winners, sha, uri, blob, written, scorecard: ScorecardSchema.parse(written) };
}

async function scorecardCount(): Promise<number> {
  const rows = await db.query("select 1 from blobs where kind = 'scorecard'");
  return rows.length;
}

/** How many workers are running: each shows as a `MessagePort`, which vitest does not use. */
const workers = (): number =>
  process.getActiveResourcesInfo().filter((type) => type === "MessagePort").length;

/**
 * A network that exists only in the test. `hosts` says what each name resolves to; `routes`
 * answers a request by the Host it names and its path, and a request with no route, or sent to
 * one of the `down` addresses, fails as an unreachable server does. Each lookup and each request
 * is recorded, the request with the URL it was sent to and its Host header.
 */
function fakeNetwork(
  hosts: Record<string, string[]>,
  routes: Record<string, () => Response> = {},
  down: readonly string[] = [],
) {
  const lookups: string[] = [];
  const requests: { url: string; host: string | null }[] = [];
  const io: FetchIo = {
    lookup: async (host) => {
      lookups.push(host);
      const addresses = hosts[host];
      if (addresses === undefined) {
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      }
      return addresses;
    },
    fetchImpl: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const host = new Headers(init?.headers).get("host");
      requests.push({ url: url.href, host });
      const route = routes[`${host}${url.pathname}`];
      if (route === undefined || down.includes(url.hostname.replace(/^\[(.*)\]$/, "$1"))) {
        throw new TypeError("fetch failed");
      }
      return route();
    },
  };
  return { io, lookups, requests };
}

const ok = (body: BodyInit) => () => new Response(body);
const redirect =
  (location: string, status = 302) =>
  () =>
    new Response(null, { status, headers: { location } });

// ---------------------------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------------------------

test("judge_picks_best_and_publishes_heldout", async () => {
  const { view, chain, commitment } = await postJudged([
    ["alice.test.near", "42", 12n],
    ["bob.test.near", "41", 10n],
    ["cat.test.near", "  Forty-Two ", 11n],
    ["dan.test.near", "42", 13n],
  ]);
  expect(await isPublic(db, commitment)).toBe(false);

  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("picked");

  // Three answers are right. The earlier blocks come first, so cat and alice fill the two places
  // of the split and dan, who is just as right, is third.
  const winners = [
    { account: "cat.test.near", bps: 7000 },
    { account: "alice.test.near", bps: 3000 },
  ];
  const card = await picked(chain);
  expect(card.taskId).toBe(7n);
  expect(card.winners).toEqual(winners);
  expect(card.uri).toBe(blobUri(card.sha ?? ""));

  // The scorecard is stored under the hash that `pick` records, public, as the Judge's.
  expect(card.blob).toMatchObject({
    kind: "scorecard",
    contentType: "application/json",
    taskId: "7",
    uploader: JUDGE,
    isPublic: true,
  });
  expect(sha256Hex(card.blob.bytes)).toBe(card.sha);
  expect(card.scorecard).toMatchObject({
    task_id: "7",
    verifier: JUDGE,
    kind: "exact",
    criteria_hash: view.criteria_hash,
    heldout_commitment: commitment,
    winners,
    generated_at: NOW.toISOString(),
    judge: { software: "tender-judge/1", model: null },
  });
  expect(card.scorecard.entries.map((e) => [e.account, e.score, e.passed])).toEqual([
    ["cat.test.near", 100, true],
    ["alice.test.near", 100, true],
    ["dan.test.near", 100, true],
    ["bob.test.near", 0, false],
  ]);
  expect(card.scorecard.entries[3]?.reasons).toEqual(["expected one of 2 accepted answers"]);

  // It publishes the held-out checks: the scorecard carries them, they hash to the commitment on
  // chain, and their own blob is public now.
  expect(card.written.heldout).toEqual(HELDOUT);
  expect(sha256Hex(canonicalJson(card.written.heldout))).toBe(commitment);
  expect(await isPublic(db, commitment)).toBe(true);
  // The task stays accepted; the chain says it is settled.
  expect(await judgeRow(db, 7)).toEqual({ judge_status: "accepted", judge_reason: null });
});

test("judge_no_award_when_none_pass", async () => {
  const { chain, commitment } = await postJudged([
    ["alice.test.near", "41", 10n],
    ["bob.test.near", "forty-one", 11n],
  ]);

  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("no_award");

  // A pick with no winners settles the task at once and refunds it. It still has its scorecard,
  // and the held-out checks are still published, so anyone can see why nobody passed.
  const card = await picked(chain);
  expect(card.winners).toEqual([]);
  expect(card.scorecard.winners).toEqual([]);
  expect(card.scorecard.entries.map((e) => e.passed)).toEqual([false, false]);
  expect(card.blob.isPublic).toBe(true);
  expect(await isPublic(db, commitment)).toBe(true);
});

test("mismatched_or_missing_content_scores_zero", async () => {
  // A pass mark of 0, so that every entry the Judge could check passes, even with a score of 0.
  const criteria = { ...EXACT, min_score: 0, split: "winner_take_all" };
  // The entrant uploaded both answers for this task, so the record for the hash it revealed is
  // there, but the URI it revealed serves the other one.
  const served = await putResult(db, "42", "mismatch.test.near");
  const revealed = await putResult(db, "forty-two", "mismatch.test.near");
  // Another task's held-out checks, private, under a hash that its task shows on chain.
  const othersHeldout = await putHeldout(db, { exact: { expected: ["another task's answer"] } });
  const extra = [
    // Reveals the hash of other bytes than its URI serves.
    entry("mismatch.test.near", revealed, blobUri(served), 1n),
    // Points at a blob that nobody stored, so nobody uploaded it either.
    entry("missing.test.near", sha256Hex("42 "), blobUri(sha256Hex("42 ")), 2n),
    // A server that answers 404, with words of its own that the reason does not repeat.
    entry("gone.test.near", sha256Hex("42"), "http://files.example/gone", 3n),
    // A server that cannot be reached.
    entry("down.test.near", sha256Hex("42"), "http://down.example/answer", 4n),
    // Names those held-out checks as its content. They are no entry's result: a score of them
    // would tell this task's poster how another task's checks look.
    entry("peek.test.near", othersHeldout, blobUri(othersHeldout), 5n),
  ];
  const { chain } = await postJudged([["honest.test.near", "41", 9n]], { criteria, extra });
  const { io } = fakeNetwork(
    { "files.example": [PUBLIC_IP], "down.example": [OTHER_PUBLIC_IP] },
    { "files.example/gone": () => new Response("<p>the server's own words</p>", { status: 404 }) },
  );

  expect(await judgeTask(judgeDeps(db, chain, { fetchIo: io }), 7n)).toBe("picked");

  // The five came first on the tie-break (all score 0, and their blocks are earlier), and none of
  // them can win: the one entry whose content the Judge could check does.
  const card = await picked(chain);
  expect(card.winners).toEqual([{ account: "honest.test.near", bps: 10_000 }]);
  expect(card.scorecard.entries.map((e) => [e.account, e.score, e.passed, e.reasons])).toEqual([
    ["mismatch.test.near", 0, false, ["content hash mismatch"]],
    ["missing.test.near", 0, false, ["content unavailable: not uploaded for this task"]],
    ["gone.test.near", 0, false, ["content unavailable: http status 404"]],
    ["down.test.near", 0, false, ["content unavailable: fetch failed"]],
    ["peek.test.near", 0, false, ["content unavailable: not uploaded for this task"]],
    ["honest.test.near", 0, true, ["expected one of 2 accepted answers"]],
  ]);
  // Those checks are still private: judging this task publishes its own held-out checks only.
  expect(await isPublic(db, othersHeldout)).toBe(false);
});

test("our_blob_uris_count_only_when_uploaded_for_this_task", async () => {
  // Alice and dan each uploaded the same answer for this task, and revealed it. Its hash is on
  // chain from alice's reveal on, and mallory, who never had the bytes, copied it with our URI.
  // Bob uploaded his answer, but for another task. Mallory and bob come first on the tie-break, and
  // neither may win with bytes that were not uploaded by them for this task.
  const bobs = await putResult(db, "forty-two", "bob.test.near", 8n);
  // Eve uploaded her own answer for this task, revealed its hash, and pointed the URI at alice's
  // blob. The record she has is for the hash she revealed, so the bytes are read, and they do not
  // match it.
  const eves = await putResult(db, "41", "eve.test.near");
  const extra = [
    entry("eve.test.near", eves, blobUri(sha256Hex("42")), 9n),
    entry("mallory.test.near", sha256Hex("42"), blobUri(sha256Hex("42")), 10n),
    entry("bob.test.near", bobs, blobUri(bobs), 11n),
    // Content on another host is not in our store, and has no upload to look for.
    entry("carol.test.near", sha256Hex("42"), "http://files.example/42", 14n),
  ];
  const { chain } = await postJudged(
    [
      ["alice.test.near", "42", 12n],
      ["dan.test.near", "42", 13n],
    ],
    { extra },
  );
  const { io } = fakeNetwork({ "files.example": [PUBLIC_IP] }, { "files.example/42": ok("42") });

  // A tick on which the records cannot be read: nothing is judged on a guess, no entry is scored 0
  // for it, and the error goes to the loop.
  const unreadable = judgeDeps(db, chain, {
    fetchIo: io,
    resultUploaded: async () => {
      throw new Error("connection terminated");
    },
  });
  await expect(judgeTask(unreadable, 7n)).rejects.toThrow("connection terminated");
  expect(chain.pick).not.toHaveBeenCalled();
  expect(await scorecardCount()).toBe(0);

  // The next tick can read them.
  const deps = judgeDeps(db, chain, { fetchIo: io });
  const resultUploaded = vi.spyOn(deps, "resultUploaded");
  expect(await judgeTask(deps, 7n)).toBe("picked");

  // Alice and dan both score, and fill the two places of the split.
  const card = await picked(chain);
  expect(card.winners).toEqual([
    { account: "alice.test.near", bps: 7000 },
    { account: "dan.test.near", bps: 3000 },
  ]);
  expect(card.scorecard.entries.map((e) => [e.account, e.score, e.passed, e.reasons])).toEqual([
    ["alice.test.near", 100, true, []],
    ["dan.test.near", 100, true, []],
    ["carol.test.near", 100, true, []],
    ["eve.test.near", 0, false, ["content hash mismatch"]],
    ["mallory.test.near", 0, false, ["content unavailable: not uploaded for this task"]],
    ["bob.test.near", 0, false, ["content unavailable: not uploaded for this task"]],
  ]);
  // Each entry with one of our URIs is looked up by the hash it revealed, not by the URI, for this
  // task, at the Judge's own time.
  expect(resultUploaded.mock.calls).toEqual(
    expect.arrayContaining([
      [sha256Hex("42"), 7n, "alice.test.near", NOW_NS],
      [sha256Hex("42"), 7n, "dan.test.near", NOW_NS],
      [eves, 7n, "eve.test.near", NOW_NS],
      [sha256Hex("42"), 7n, "mallory.test.near", NOW_NS],
      [bobs, 7n, "bob.test.near", NOW_NS],
    ]),
  );
  expect(resultUploaded).toHaveBeenCalledTimes(5);
});

test("judge_is_idempotent_after_settlement", async () => {
  // The Judge crashed after its pick landed and before it recorded anything. On restart the chain
  // says the task is settled, and the Judge does nothing at all.
  const { view, chain, commitment } = await postJudged([["alice.test.near", "42", 10n]]);
  const settled: TaskView[] = [
    {
      ...view,
      phase: "settled",
      outcome: {
        kind: "picked",
        winners: [{ account: "alice.test.near", bps: 10_000, amount: "4750000" }],
        fee: "250000",
        scorecard_hash: sha256Hex("scorecard"),
        scorecard_uri: blobUri(sha256Hex("scorecard")),
      },
    },
    {
      ...view,
      phase: "settled",
      outcome: { kind: "voided", reason: "no_award", scorecard_hash: null, scorecard_uri: null },
    },
  ];

  for (const task of settled) {
    chain.getTask.mockResolvedValue(task);
    expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("skipped");
  }
  expect(chain.pick).not.toHaveBeenCalled();
  expect(chain.getAllEntries).not.toHaveBeenCalled();
  expect(await scorecardCount()).toBe(0);
  expect(await isPublic(db, commitment)).toBe(false);
});

test("e_settled_race_is_skipped", async () => {
  const { chain } = await postJudged([["alice.test.near", "42", 10n]]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  chain.pick.mockRejectedValueOnce(
    new TenderError("E_SETTLED", "Smart contract panicked: E_SETTLED: task 7 is settled"),
  );

  // Someone settled the task between the read and the pick: there is nothing left to do.
  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("skipped");
  expect(chain.pick).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();
});

test("judge_skips_what_it_must_not_judge", async () => {
  const { view, chain } = await postJudged([["alice.test.near", "42", 10n]]);
  const deps = judgeDeps(db, chain);

  // Before the reveal deadline and from the pick deadline on, by the clock.
  expect(await judgeTask({ ...deps, now: at(-2) }, 7n)).toBe("skipped");
  expect(await judgeTask({ ...deps, now: at(10) }, 7n)).toBe("skipped");
  // The clock says judging, but the final block is still before the reveal deadline, so a reveal
  // can still land.
  chain.getTask.mockResolvedValueOnce({ ...view, phase: "revealing" });
  expect(await judgeTask(deps, 7n)).toBe("skipped");
  // Another verifier's task, and a task the chain does not have.
  chain.getTask.mockResolvedValueOnce({ ...view, verifier: "other-judge.test.near" });
  expect(await judgeTask(deps, 7n)).toBe("skipped");
  chain.getTask.mockResolvedValueOnce(null);
  expect(await judgeTask(deps, 7n)).toBe("skipped");
  // A task intake did not accept.
  for (const status of [null, "pending", "rejected", "failed_closed"]) {
    await db.query("update tasks set judge_status = $1 where id = 7", [status]);
    expect(await judgeTask(deps, 7n), String(status)).toBe("skipped");
  }

  expect(chain.pick).not.toHaveBeenCalled();
  expect(await scorecardCount()).toBe(0);
});

test("judge_fails_closed_when_its_criteria_are_gone", async () => {
  // Intake accepted the task, but the criteria the chain names cannot be read at judging time.
  const { view, chain } = await postJudged([["alice.test.near", "42", 10n]]);
  chain.getTask.mockResolvedValue({ ...view, criteria_hash: sha256Hex("never stored") });

  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("failed_closed");
  expect(await judgeRow(db, 7)).toEqual({
    judge_status: "failed_closed",
    judge_reason: "criteria not found or invalid",
  });
  expect(chain.pick).not.toHaveBeenCalled();
  expect(await scorecardCount()).toBe(0);
  // It is not judged again: the poster's fallback window applies.
  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("skipped");
});

const DYNAMIC_REFERENCE =
  "criteria schema is not supported: $dynamicRef and $recursiveRef are not supported, use $ref";
/** json_schema criteria over `schema`, whose held-out check is that `$.x` is 1. */
const jsonSchemaCriteria = (schema: object) => ({
  version: 1,
  kind: "json_schema",
  min_score: 100,
  split: "winner_take_all",
  has_heldout: true,
  schema,
});
const X_IS_1 = { json_schema: { assertions: [{ path: "$.x", equals: 1 }] } };

test("judge_rejects_criteria_that_fail_the_criteria_check_now", async () => {
  // P05-R12: the task was accepted under an older rule, which let $dynamicRef through; Ajv would
  // check `t` against the root, so `t: "text"` would score 100. The criteria check runs again
  // before any entry is scored, and the task is not judged: it is rejected with the reason, and
  // one WARN. No pick, so its funders get their refund through the fallback window.
  const schema = {
    $defs: { n: { type: "number" } },
    properties: { t: { $dynamicRef: "#/$defs/n" } },
  };
  const { chain, commitment } = await postJudged([["alice.test.near", '{"x":1,"t":"text"}', 10n]], {
    criteria: jsonSchemaCriteria(schema),
    heldout: X_IS_1,
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("failed_closed");
  expect(await judgeRow(db, 7)).toEqual({
    judge_status: "rejected",
    judge_reason: DYNAMIC_REFERENCE,
  });
  expect(chain.getAllEntries).not.toHaveBeenCalled();
  expect(chain.pick).not.toHaveBeenCalled();
  expect(await scorecardCount()).toBe(0);
  expect(await isPublic(db, commitment)).toBe(false);

  // A rejected task is not looked at again, and the WARN is not repeated.
  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("skipped");
  expect(warn.mock.calls).toEqual([
    [expect.stringMatching(/^judge: WARN task 7: rejected at judging, its criteria fail/)],
  ]);
});

test("judge_runs_the_criteria_check_intake_ran_again_before_scoring", async () => {
  // The same check, the same function, on both paths: criteria that pass the real check at intake
  // and fail it at judging time (here the compile step, as a newer Ajv or rule might) are rejected.
  const criteriaHash = await putCriteria(db, jsonSchemaCriteria({ type: "object" }));
  const view = taskView({
    criteria_hash: criteriaHash,
    heldout_commitment: await putHeldout(db, X_IS_1),
  });
  await insertTask(db, view);
  const chain = fakeChain(view, []);
  expect(await intakeTask(judgeDeps(db, chain), 7n)).toBe("accepted");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const refusal = "criteria schema cannot be compiled: refused at judging time";
  vi.mocked(checkJsonSchemaIsolated).mockResolvedValueOnce({ ok: false, reason: refusal });
  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("failed_closed");
  expect(await judgeRow(db, 7)).toEqual({ judge_status: "rejected", judge_reason: refusal });
  expect(chain.pick).not.toHaveBeenCalled();
});

/** A schema near the size cap: it takes a few hundred milliseconds to compile and try. */
function slowSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 3_000; i++) {
    properties[`p${i}`] = { type: "string", pattern: "^[a-z]{1,8}$", maxLength: 8 };
  }
  return { type: "object", properties };
}

test("a_schema_that_compiles_past_the_budget_is_rejected_at_intake_and_at_judging", {
  timeout: 60_000,
}, async () => {
  const tooSlow = "criteria schema is not supported: it takes too long to compile";
  const criteriaHash = await putCriteria(db, jsonSchemaCriteria(slowSchema()));
  // At intake: compiling and trying it takes longer than the budget, cut to 25 ms here.
  await insertTask(
    db,
    taskView({
      id: "6",
      criteria_hash: criteriaHash,
      heldout_commitment: await putHeldout(db, {
        json_schema: { assertions: [{ path: "$.p0", equals: "a" }] },
      }),
    }),
  );
  const short = { scoringLimits: { compileBudgetMs: 25 } };
  expect(await intakeTask(judgeDeps(db, fakeChain(null), short), 6n)).toBe("rejected");
  expect(await judgeRow(db, 6)).toEqual({ judge_status: "rejected", judge_reason: tooSlow });

  // At judging (P05-R12): a task accepted under a budget it met is checked again before any entry
  // is read, with 4 times intake's budget (100 ms here, still too little), and refused.
  const view = taskView({
    criteria_hash: criteriaHash,
    heldout_commitment: await putHeldout(db, X_IS_1),
  });
  await insertTask(db, view);
  const chain = fakeChain(view, []);
  const long = { scoringLimits: { compileBudgetMs: 60_000 } };
  expect(await intakeTask(judgeDeps(db, chain, long), 7n)).toBe("accepted");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  expect(await judgeTask(judgeDeps(db, chain, short), 7n)).toBe("failed_closed");
  expect(await judgeRow(db, 7)).toEqual({ judge_status: "rejected", judge_reason: tooSlow });
  expect(chain.getAllEntries).not.toHaveBeenCalled();
  expect(chain.pick).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(1);
});

test("judging_gives_the_compile_check_four_times_intakes_budget", { timeout: 60_000 }, async () => {
  // A compile that takes 500 ms, injected through the rogue worker, and intake's budget cut to
  // 250 ms: intake refuses it, and judging, with 1 s, does not. A busy machine cannot refuse at
  // judging what compiled in time at intake; the check is the same on both paths (P05-R12).
  const criteria = jsonSchemaCriteria({ title: "rogue:slow:500", type: "object" });
  vi.mocked(checkJsonSchemaIsolated).mockClear();
  for (let i = 0; i < 2; i++) {
    vi.mocked(checkJsonSchemaIsolated).mockImplementationOnce((schema, options) =>
      isolate.checkJsonSchemaIsolated(schema, { ...options, workerUrl: ROGUE_WORKER }),
    );
  }
  const budget = { scoringLimits: { compileBudgetMs: 250 } };

  await insertTask(
    db,
    taskView({
      id: "6",
      criteria_hash: await putCriteria(db, criteria),
      heldout_commitment: await putHeldout(db, {
        json_schema: { assertions: [{ path: "$.x", equals: 6 }] },
      }),
    }),
  );
  expect(await intakeTask(judgeDeps(db, fakeChain(null), budget), 6n)).toBe("rejected");
  expect(await judgeRow(db, 6)).toEqual({
    judge_status: "rejected",
    judge_reason: "criteria schema is not supported: it takes too long to compile",
  });

  const { chain } = await postJudged([["alice.test.near", '{"x":1}', 10n]], {
    criteria,
    heldout: X_IS_1,
  });
  expect(await judgeTask(judgeDeps(db, chain, budget), 7n)).toBe("picked");
  expect((await picked(chain)).winners).toEqual([{ account: "alice.test.near", bps: 10_000 }]);
  expect(vi.mocked(checkJsonSchemaIsolated).mock.calls.map(([, options]) => options)).toEqual([
    { budgetMs: 250 },
    { budgetMs: 1_000 },
  ]);
});

test("judge_fails_closed_when_its_heldout_checks_were_used_first", async () => {
  // Intake accepted the task. Then an earlier task of the same poster, with the same held-out
  // commitment, reached the database late, so these checks are not this task's to use: judging
  // fails closed, and does not publish them. (`taskView` posts both as `POSTER`.)
  const { view, chain, commitment } = await postJudged([["alice.test.near", "42", 10n]]);
  await insertTask(
    db,
    taskView({
      id: "3",
      verifier: "other-judge.test.near",
      criteria_hash: view.criteria_hash,
      heldout_commitment: commitment,
    }),
  );

  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("failed_closed");
  expect(await judgeRow(db, 7)).toEqual({
    judge_status: "failed_closed",
    judge_reason: "held-out checks already used by task 3",
  });
  expect(chain.pick).not.toHaveBeenCalled();
  expect(await isPublic(db, commitment)).toBe(false);
});

/**
 * The middle of task 7's pick window, as `taskView` sets it: reveals close a minute before `NOW`
 * and picks end 10 minutes after, so the middle is 4.5 minutes after `NOW`. A task sharing task
 * 7's held-out checks is waited for only when its reveals close by then (P05-R8).
 */
const PICK_WINDOW_MIDDLE_NS = NOW_NS - MINUTE_NS + (11n * MINUTE_NS) / 2n;

/** Stores the poster's task `id`, of another verifier, sharing task 7's checks until `revealNs`. */
async function postSharing(
  view: TaskView,
  id: string,
  revealNs: bigint,
  over: Partial<TaskView> = {},
) {
  await insertTask(
    db,
    taskView({
      id,
      verifier: "other-judge.test.near",
      criteria_hash: view.criteria_hash,
      heldout_commitment: view.heldout_commitment,
      reveal_deadline: revealNs.toString(),
      ...over,
    }),
  );
}

const WAITING_FOR_9 = "waiting: held-out checks shared with task 9";

test("judge_waits_while_a_task_sharing_its_heldout_checks_takes_reveals", async () => {
  // The poster's later task 9 commits to the same held-out checks and names another verifier, so
  // this Judge's intake never saw it. Judging task 7 would publish the checks, and with them task
  // 9's answers, while task 9 still takes reveals, and those close before the middle of task 7's
  // pick window: task 7 waits. Nothing is fetched, stored, published or scored.
  const { view, chain, commitment } = await postJudged([["alice.test.near", "42", 10n]]);
  await postSharing(view, "9", NOW_NS + 4n * MINUTE_NS);
  // A stranger's task with the same commitment does not hold it up: it can never publish them.
  await postSharing(view, "11", NOW_NS + 4n * MINUTE_NS, { poster: "stranger.test.near" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  for (const minutes of [0, 1, 3.99]) {
    expect(await judgeTask(judgeDeps(db, chain, { now: at(minutes) }), 7n)).toBe("skipped");
  }
  // One line for the whole wait, and the reason shows meanwhile.
  expect(warn.mock.calls).toEqual([
    [expect.stringMatching(/^judge: WARN task 7: waiting for task 9: it shares the held-out/)],
  ]);
  expect(await judgeRow(db, 7)).toEqual({ judge_status: "accepted", judge_reason: WAITING_FOR_9 });
  expect(chain.getAllEntries).not.toHaveBeenCalled();
  expect(chain.pick).not.toHaveBeenCalled();
  expect(await scorecardCount()).toBe(0);
  expect(await isPublic(db, commitment)).toBe(false);

  // Task 9's reveals close at its deadline, and task 7 is judged; its reason is cleared.
  expect(await judgeTask(judgeDeps(db, chain, { now: at(4) }), 7n)).toBe("picked");
  expect(await judgeRow(db, 7)).toEqual({ judge_status: "accepted", judge_reason: null });
  expect(await isPublic(db, commitment)).toBe(true);
});

test("judge_looks_again_for_a_task_sharing_its_heldout_checks_before_publishing", async () => {
  // The indexer stores the poster's task 9 while task 7's entries are being read. The look just
  // before publishing finds it, and nothing is stored or published.
  const { view, chain, commitment } = await postJudged([["alice.test.near", "42", 10n]]);
  const entries = chain.getAllEntries.getMockImplementation();
  chain.getAllEntries.mockImplementationOnce(async (taskId) => {
    await postSharing(view, "9", NOW_NS + 4n * MINUTE_NS);
    return (await entries?.(taskId)) ?? [];
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("skipped");
  expect(chain.getAllEntries).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    expect.stringMatching(/^judge: WARN task 7: waiting for task 9/),
  );
  expect(await judgeRow(db, 7)).toEqual({ judge_status: "accepted", judge_reason: WAITING_FOR_9 });
  expect(chain.pick).not.toHaveBeenCalled();
  expect(await scorecardCount()).toBe(0);
  expect(await isPublic(db, commitment)).toBe(false);
});

test("a_task_sharing_the_heldout_checks_cannot_cost_this_one_its_pick_window", async () => {
  // The re-review's probe A: the poster posts task 9 with task 7's commitment, and its reveals
  // close after task 7's pick deadline. Were task 7 to wait, it would never be picked, and its
  // winners would be left to the poster's fallback window. It is judged and picked now, and the
  // checks are published while task 9 still takes reveals, which its poster brought about.
  const { view, chain, commitment } = await postJudged([["alice.test.near", "42", 10n]]);
  await postSharing(view, "9", NOW_NS + 11n * MINUTE_NS);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("picked");
  expect((await picked(chain)).winners).toEqual([{ account: "alice.test.near", bps: 10_000 }]);
  expect(await isPublic(db, commitment)).toBe(true);
  expect(warn).not.toHaveBeenCalled();
});

test("judge_waits_for_a_sharing_task_only_up_to_the_middle_of_its_pick_window", async () => {
  // Reveals that close at the middle of the window itself are waited for; one nanosecond later,
  // they are not.
  const { view, chain } = await postJudged([["alice.test.near", "42", 10n]]);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await postSharing(view, "9", PICK_WINDOW_MIDDLE_NS);

  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("skipped");
  expect(await judgeRow(db, 7)).toEqual({ judge_status: "accepted", judge_reason: WAITING_FOR_9 });

  await db.query("update tasks set reveal_deadline = $1 where id = 9", [
    PICK_WINDOW_MIDDLE_NS + 1n,
  ]);
  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("picked");
  expect(await judgeRow(db, 7)).toEqual({ judge_status: "accepted", judge_reason: null });
});

test("judge_does_not_wait_once_its_heldout_checks_are_public", async () => {
  // The re-review's probe E: a pick that failed has published the checks already, so a sharing
  // task that closes its reveals in time is not waited for: there is nothing left to keep.
  const { view, chain, commitment } = await postJudged([["alice.test.near", "42", 10n]]);
  await postSharing(view, "9", NOW_NS + 4n * MINUTE_NS);
  await setBlobPublic(db, commitment, true);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("picked");
  expect(warn).not.toHaveBeenCalled();
});

test("a_scorer_that_cannot_start_is_retried_next_tick", { timeout: 60_000 }, async () => {
  const { chain } = await postJudged(
    [
      ["alice.test.near", '{"pattern":"^a$"}', 10n],
      ["zed.test.near", "rogue:unavailable", 11n],
    ],
    { criteria: REGEX, heldout: null },
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  // A score worker that cannot be loaded, and a scorer that says it cannot run, as the regex
  // sandbox does when its engine cannot be loaded (the rogue worker does it for zed's entry).
  // That is the Judge's trouble, so no entry is scored 0 for it, and nothing is picked.
  for (const workerUrl of [NO_WORKER, ROGUE_WORKER]) {
    nextScorerFrom(workerUrl);
    expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("skipped");
  }
  expect(chain.pick).not.toHaveBeenCalled();
  expect(await scorecardCount()).toBe(0);
  const retried =
    "judge: WARN task 7: a scorer could not be run (ScorerUnavailableError); trying again next tick";
  expect(warn.mock.calls).toEqual([[retried], [retried]]);

  // The next tick has a worker that runs, and judges the task.
  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("picked");
  expect((await picked(chain)).winners).toEqual([{ account: "alice.test.near", bps: 10_000 }]);
});

test("a_scorer_that_throws_scores_that_entry_zero", { timeout: 60_000 }, async () => {
  // Alice's entry makes the scorer throw, in the rogue worker; bob's is scored as usual.
  const { chain } = await postJudged([
    ["alice.test.near", "rogue:throw", 10n],
    ["bob.test.near", "42", 11n],
  ]);
  nextScorerFrom(ROGUE_WORKER);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("picked");

  const card = await picked(chain);
  expect(card.winners).toEqual([{ account: "bob.test.near", bps: 10_000 }]);
  expect(card.scorecard.entries.map((e) => [e.account, e.score, e.passed, e.reasons])).toEqual([
    ["bob.test.near", 100, true, []],
    ["alice.test.near", 0, false, ["scoring failed"]],
  ]);
  // One line for the crash: the error's name, and nothing of what it says.
  expect(warn.mock.calls).toEqual([["judge: WARN task 7: scoring an entry failed (TypeError)"]]);
});

test("an_entry_whose_scoring_times_out_scores_zero_and_the_others_are_scored", {
  timeout: 60_000,
}, async () => {
  // The poster's pattern backtracks without end on mallory's string: V8's regex engine, run by
  // Ajv in the worker. Mallory's entry has its time (1 s here) and scores 0. That is no trouble
  // of the task's: the other entries are scored, by a new worker, and the task is picked.
  const criteria = jsonSchemaCriteria({
    type: "object",
    required: ["x"],
    properties: { x: { type: "integer" }, s: { type: "string", pattern: "^(a+)+$" } },
  });
  const { chain } = await postJudged(
    [
      ["mallory.test.near", `{"x":1,"s":"${"a".repeat(40)}!"}`, 9n],
      ["alice.test.near", '{"x":1,"s":"aaaa"}', 10n],
      ["bob.test.near", '{"x":2}', 11n],
    ],
    { criteria, heldout: X_IS_1 },
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const before = workers();

  const deps = judgeDeps(db, chain, { scoringLimits: { entryTimeoutMs: 1_000 } });
  expect(await judgeTask(deps, 7n)).toBe("picked");

  const card = await picked(chain);
  expect(card.winners).toEqual([{ account: "alice.test.near", bps: 10_000 }]);
  expect(card.scorecard.entries.map((e) => [e.account, e.score, e.passed, e.reasons])).toEqual([
    ["alice.test.near", 100, true, []],
    ["mallory.test.near", 0, false, ["scoring timed out"]],
    ["bob.test.near", 0, false, ["$.x expected 1"]],
  ]);
  expect(warn).not.toHaveBeenCalled();
  // The task's workers are gone with it.
  expect(workers()).toBe(before);
});

test("judge_scores_in_commit_order_until_the_stop_line_and_picks_from_those", {
  timeout: 60_000,
}, async () => {
  // Ten answers, revealed in entrant order and committed in another. Scoring one moves the
  // Judge's clock on by 1.6 minutes. The pick window runs from a minute before NOW to 10 minutes
  // after it, and a tenth of it is 66 s, so the stop line is 30 s, the most, before the pick
  // deadline: NOW + 9.5 minutes. Six entries are scored, the six committed first; the right
  // answers committed after them cannot win, and the scorecard says why.
  const answers: Answer[] = [
    ["late1.test.near", "42", 20n],
    ["early1.test.near", "41", 11n],
    ["early2.test.near", " 42", 12n],
    ["late2.test.near", "forty-two", 21n],
    ["early3.test.near", "40", 13n],
    ["early4.test.near", "42 ", 14n],
    ["late3.test.near", " forty-two ", 22n],
    ["early5.test.near", "\t42", 15n],
    ["early6.test.near", "39", 16n],
    ["late4.test.near", "42\n", 23n],
  ];
  const { chain } = await postJudged(answers);
  let minutes = 0;
  let scores = 0;
  nextScorerCalls(() => {
    scores++;
    minutes += 1.6;
  });

  const deps = judgeDeps(db, chain, { now: () => at(minutes)() });
  expect(await judgeTask(deps, 7n)).toBe("picked");

  expect(scores).toBe(6);
  const card = await picked(chain);
  expect(card.winners).toEqual([
    { account: "early2.test.near", bps: 7000 },
    { account: "early4.test.near", bps: 3000 },
  ]);
  const notScored = ["not scored before the pick deadline"];
  expect(card.scorecard.entries.map((e) => [e.account, e.score, e.passed, e.reasons])).toEqual([
    ["early2.test.near", 100, true, []],
    ["early4.test.near", 100, true, []],
    ["early5.test.near", 100, true, []],
    ["early1.test.near", 0, false, ["expected one of 2 accepted answers"]],
    ["early3.test.near", 0, false, ["expected one of 2 accepted answers"]],
    ["early6.test.near", 0, false, ["expected one of 2 accepted answers"]],
    ["late1.test.near", 0, false, notScored],
    ["late2.test.near", 0, false, notScored],
    ["late3.test.near", 0, false, notScored],
    ["late4.test.near", 0, false, notScored],
  ]);
});

/** The reason, and the one `WARN`, of a task that judging got to too late (P05-R13). */
const TOO_LATE = "not judged: judging started too late to score any entry";
const TOO_LATE_WARN =
  "judge: WARN task 7: judging started too late to score any entry; it is not picked, and is left to its fallback window";

test("the_stop_line_is_drawn_from_the_pick_window", { timeout: 60_000 }, async () => {
  // A tenth of the pick window before the pick deadline, and no less than 3 s or more than 30 s
  // (P05-R13). Judged at NOW, the entry is given exactly the time to the line, and is picked;
  // judged at the line, nothing can be scored, and the task is not picked.
  const windows = [
    // From a minute before NOW, taskView's reveal deadline, to 10 minutes after it: a tenth is
    // 66 s, and the most is 30 s.
    { pickMs: 10 * 60_000, marginMs: 30_000 },
    // To 3 minutes after: a tenth, 24 s.
    { pickMs: 3 * 60_000, marginMs: 24_000 },
  ];
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const judgeAt = async (view: Partial<TaskView>, atMs: number) => {
    await resetDb(db);
    const { chain } = await postJudged([["alice.test.near", "42", 10n]], { view });
    const given: (number | undefined)[] = [];
    nextScorerCalls((leftMs) => given.push(leftMs));
    const deps = judgeDeps(db, chain, { now: () => new Date(NOW.getTime() + atMs) });
    return { outcome: await judgeTask(deps, 7n), chain, given };
  };
  const cases = [
    ...windows.map(({ pickMs, marginMs }) => ({
      view: { pick_deadline: (NOW_NS + BigInt(pickMs) * 1_000_000n).toString() },
      stopMs: pickMs - marginMs,
    })),
    {
      // A window of 10 s, as the local sandbox has, from a second before NOW: a tenth is 1 s, and
      // the least is 3 s.
      view: {
        reveal_deadline: (NOW_NS - 1_000_000_000n).toString(),
        pick_deadline: (NOW_NS + 9_000_000_000n).toString(),
      },
      stopMs: 9_000 - 3_000,
    },
  ];
  for (const { view, stopMs } of cases) {
    const scored = await judgeAt(view, 0);
    expect(scored.outcome, `${stopMs} ms`).toBe("picked");
    expect(scored.given).toEqual([stopMs]);
    expect((await picked(scored.chain)).winners).toEqual([
      { account: "alice.test.near", bps: 10_000 },
    ]);
    const late = await judgeAt(view, stopMs);
    expect(late.outcome, `${stopMs} ms`).toBe("skipped");
    expect(late.given).toEqual([]);
    expect(late.chain.pick).not.toHaveBeenCalled();
  }
  expect(warn.mock.calls).toEqual(cases.map(() => [TOO_LATE_WARN]));
});

test("a_short_window_with_the_midpoint_wait_is_scored_and_picked", {
  timeout: 60_000,
}, async () => {
  // P05-R13: a pick window of 10 s, as the local sandbox has, from a second before NOW. The task
  // waits (P05-R8) for another task of its poster's that shares its held-out checks and closes its
  // reveals at the middle of the window, 4 s after NOW. The stop line is 3 s before the pick
  // deadline, at NOW + 6 s: judging that starts at the middle has 2 s, and picks.
  const { view, chain } = await postJudged([["alice.test.near", "42", 10n]], {
    view: {
      reveal_deadline: (NOW_NS - SECOND_NS).toString(),
      pick_deadline: (NOW_NS + 9n * SECOND_NS).toString(),
    },
  });
  await postSharing(view, "9", NOW_NS + 4n * SECOND_NS);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const atSecond = (seconds: number) => () => new Date(NOW.getTime() + seconds * 1_000);

  expect(await judgeTask(judgeDeps(db, chain, { now: atSecond(3) }), 7n)).toBe("skipped");
  expect(chain.pick).not.toHaveBeenCalled();
  expect(await judgeTask(judgeDeps(db, chain, { now: atSecond(4) }), 7n)).toBe("picked");
  const card = await picked(chain);
  expect(card.winners).toEqual([{ account: "alice.test.near", bps: 10_000 }]);
  expect(card.scorecard.entries.map((e) => [e.account, e.score])).toEqual([
    ["alice.test.near", 100],
  ]);
});

test("judging_that_starts_past_the_stop_line_does_not_pick", async () => {
  // P05-R13: this task's stop line is 30 s before its pick deadline, at NOW + 9.5 minutes. A tick
  // that starts past it can score nothing, and a pick would pay nobody for the Judge's own
  // lateness. There is none: no scorecard, the held-out checks stay private, and the task is left
  // to its fallback window, which refunds it unless its poster picks. One WARN, whatever the
  // ticks before the pick deadline, and the reason in the row.
  const { chain, commitment } = await postJudged([["alice.test.near", "42", 10n]]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  for (const minutes of [9.5, 9.7, 9.9]) {
    expect(await judgeTask(judgeDeps(db, chain, { now: at(minutes) }), 7n)).toBe("skipped");
  }
  expect(chain.pick).not.toHaveBeenCalled();
  expect(await scorecardCount()).toBe(0);
  expect(await isPublic(db, commitment)).toBe(false);
  expect(warn.mock.calls).toEqual([[TOO_LATE_WARN]]);
  expect(await judgeRow(db, 7)).toEqual({ judge_status: "accepted", judge_reason: TOO_LATE });
});

test("judging_whose_worker_cannot_be_ready_before_the_stop_line_does_not_pick", {
  timeout: 60_000,
}, async () => {
  // The criteria take 3 s to compile in the rogue worker, and judging starts a second before the
  // stop line (taskView's is at NOW + 9.5 minutes): the worker cannot be ready in time. That is the
  // Judge's own lateness (P05-R16), so with no entry scored the task is not picked, as when judging
  // starts past the line. A task with some entries scored is picked from those
  // (judge_scores_in_commit_order_until_the_stop_line_and_picks_from_those).
  const { chain } = await postJudged([["alice.test.near", '{"x":1}', 10n]], {
    criteria: jsonSchemaCriteria({ title: "rogue:slow:3000", type: "object" }),
    heldout: X_IS_1,
  });
  nextScorerFrom(ROGUE_WORKER);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const now = () => new Date(NOW.getTime() + 9.5 * 60_000 - 1_000);
  expect(await judgeTask(judgeDeps(db, chain, { now }), 7n)).toBe("skipped");
  expect(chain.pick).not.toHaveBeenCalled();
  expect(await scorecardCount()).toBe(0);
  expect(warn.mock.calls).toEqual([[TOO_LATE_WARN]]);
});

test("a_scoring_run_that_would_cross_the_stop_line_is_cut_at_it_and_the_pick_lands", {
  timeout: 30_000,
}, async () => {
  // P05-R15: nothing runs past the stop line. The Judge's clock runs with real time, and the line
  // is 5 s in (SHORT_WINDOW). Alice's answer is scored; mallory's makes the scorer loop, and with
  // 20 s to its own limit it is cut at the stop line instead, so that the pick lands before the
  // pick deadline. The cut is the line's, not mallory's: not scored, rather than timed out.
  const { chain } = await postJudged(
    [
      ["alice.test.near", "42", 10n],
      ["mallory.test.near", "rogue:loop", 11n],
    ],
    { view: SHORT_WINDOW },
  );
  nextScorerFrom(ROGUE_WORKER);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const before = workers();

  const deps = judgeDeps(db, chain, {
    now: runningClock(),
    scoringLimits: { entryTimeoutMs: 20_000 },
  });
  const started = performance.now();
  expect(await judgeTask(deps, 7n)).toBe("picked");
  expect(performance.now() - started).toBeLessThan(5_000 + 3_000);

  const card = await picked(chain);
  expect(card.winners).toEqual([{ account: "alice.test.near", bps: 10_000 }]);
  expect(card.scorecard.entries.map((e) => [e.account, e.score, e.reasons])).toEqual([
    ["alice.test.near", 100, []],
    ["mallory.test.near", 0, ["not scored before the pick deadline"]],
  ]);
  expect(warn).not.toHaveBeenCalled();
  expect(workers()).toBe(before);
});

test("nothing_is_published_when_the_pick_could_not_land_in_time", { timeout: 60_000 }, async () => {
  // P05-R15: scoring alice's answer takes the Judge's clock to a second before the pick deadline,
  // which leaves the pick less than the 2 s it takes to land. The scorecard, which carries the
  // held-out checks, is not stored, the checks stay private, and there is no pick: one WARN, and
  // the reason in the row.
  const { chain, commitment } = await postJudged([["alice.test.near", "42", 10n]]);
  let seconds = 0;
  nextScorerCalls(() => {
    seconds = 10 * 60 - 1;
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const now = () => new Date(NOW.getTime() + seconds * 1_000);
  expect(await judgeTask(judgeDeps(db, chain, { now }), 7n)).toBe("skipped");
  expect(chain.pick).not.toHaveBeenCalled();
  expect(await scorecardCount()).toBe(0);
  expect(await isPublic(db, commitment)).toBe(false);
  expect(warn.mock.calls).toEqual([
    [
      "judge: WARN task 7: too late to pick before the pick deadline, so nothing is published; it is not picked, and is left to its fallback window",
    ],
  ]);
  expect(await judgeRow(db, 7)).toEqual({
    judge_status: "accepted",
    judge_reason: "not judged: the pick could not land before the pick deadline",
  });
});

/**
 * A network on which some hosts never answer: `dark.example` takes no connection, so the
 * transport gives up at the connect timeout (3 s), and `stuck.example` takes it and never sends a
 * byte, until the fetch is out of time. `files.example/42` answers `42`. Each request is recorded.
 */
function hangingNetwork() {
  const requests: string[] = [];
  const never = (signal: AbortSignal | null | undefined) =>
    new Promise<Response>((_, reject) => {
      signal?.addEventListener("abort", () => reject(new TypeError("fetch failed")));
    });
  const io: FetchIo = {
    lookup: async () => [PUBLIC_IP],
    fetchImpl: (url, init) => {
      const host = new Headers(init.headers).get("host");
      requests.push(`${host}${url.pathname}`);
      if (host === "dark.example") return never(init.connectSignal);
      if (host === "stuck.example") return never(init.signal);
      return Promise.resolve(new Response("42"));
    },
  };
  return { io, requests };
}

test("hanging_entries_elsewhere_cannot_crowd_out_an_entry_of_ours", {
  timeout: 30_000,
}, async () => {
  // P05-R16: twenty entrants name files elsewhere that never answer, and committed before honest,
  // whose answer is ours. Ours come first: honest is scored, and wins. The hanging fetches go 8
  // at a time, each with the time left before the stop line (5 s in), which lets them go: the
  // first 8 are let go there, and the rest are never started. The task is picked.
  const hanging = Array.from({ length: 20 }, (_, i) =>
    entry(
      `stuck${String(i).padStart(2, "0")}.test.near`,
      sha256Hex(`${i}`),
      `http://stuck.example/${i}`,
      BigInt(1 + i),
    ),
  );
  const { chain } = await postJudged([["honest.test.near", "42", 30n]], {
    extra: hanging,
    view: SHORT_WINDOW,
  });
  const network = hangingNetwork();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const deps = judgeDeps(db, chain, { fetchIo: network.io, now: runningClock() });
  const started = performance.now();
  expect(await judgeTask(deps, 7n)).toBe("picked");
  expect(performance.now() - started).toBeLessThan(5_000 + 3_000);

  const card = await picked(chain);
  expect(card.winners).toEqual([{ account: "honest.test.near", bps: 10_000 }]);
  expect(network.requests).toHaveLength(8);
  const late = card.scorecard.entries.filter((e) => e.account.startsWith("stuck"));
  expect(late).toHaveLength(20);
  for (const e of late) expect(e.reasons).toEqual(["not scored before the pick deadline"]);
});

test("hanging_entries_elsewhere_alone_are_picked_with_their_reasons", {
  timeout: 30_000,
}, async () => {
  // P05-R16: only entries hosted elsewhere, none of which answers. Two hosts take no connection,
  // and are given up at the connect timeout, in time: they score 0 for it. Two take it and never
  // answer, and the stop line (5 s in) lets them go: not scored. The time went on the entrants'
  // fetches, and not on the Judge's own work, so the task is picked from what was found out: no
  // award, with each entry's reason, rather than left unpicked.
  const extra = [
    entry("d1.test.near", sha256Hex("1"), "http://dark.example/1", 1n),
    entry("d2.test.near", sha256Hex("2"), "http://dark.example/2", 2n),
    entry("s1.test.near", sha256Hex("3"), "http://stuck.example/3", 3n),
    entry("s2.test.near", sha256Hex("4"), "http://stuck.example/4", 4n),
  ];
  const { chain } = await postJudged([], { extra, view: SHORT_WINDOW });
  const network = hangingNetwork();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const deps = judgeDeps(db, chain, { fetchIo: network.io, now: runningClock() });
  expect(await judgeTask(deps, 7n)).toBe("no_award");

  const card = await picked(chain);
  expect(card.scorecard.entries.map((e) => [e.account, e.score, e.passed, e.reasons])).toEqual([
    ["d1.test.near", 0, false, ["content unavailable: fetch failed"]],
    ["d2.test.near", 0, false, ["content unavailable: fetch failed"]],
    ["s1.test.near", 0, false, ["not scored before the pick deadline"]],
    ["s2.test.near", 0, false, ["not scored before the pick deadline"]],
  ]);
  expect(warn).not.toHaveBeenCalled();
});

test("a_slow_compile_within_the_judging_budget_costs_no_entry_its_time", {
  timeout: 60_000,
}, async () => {
  // P05-R17: the criteria take 2 s to compile, in the rogue worker. Intake's budget is cut to 1 s
  // here, so judging's is 4 s, and each entry has 1 s of its own. The worker compiles before it
  // takes an entry, so every entry is scored as usual, the first one too. When mallory's entry
  // crashes the worker, the one that replaces it compiles again, within the same budget.
  const { chain } = await postJudged(
    [
      ["alice.test.near", '{"x":1}', 10n],
      ["mallory.test.near", "rogue:throw", 11n],
      ["bob.test.near", '{"x":2}', 12n],
    ],
    { criteria: jsonSchemaCriteria({ title: "rogue:slow:2000", type: "object" }), heldout: X_IS_1 },
  );
  nextScorerFrom(ROGUE_WORKER);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const limits = { scoringLimits: { compileBudgetMs: 1_000, entryTimeoutMs: 1_000 } };
  expect(await judgeTask(judgeDeps(db, chain, limits), 7n)).toBe("picked");
  const card = await picked(chain);
  expect(card.scorecard.entries.map((e) => [e.account, e.score, e.reasons])).toEqual([
    ["alice.test.near", 100, []],
    ["mallory.test.near", 0, ["scoring failed"]],
    ["bob.test.near", 0, ["$.x expected 1"]],
  ]);
});

test("a_compile_that_fails_at_judging_rejects_the_task", { timeout: 60_000 }, async () => {
  // P05-R17: the criteria check passes, in the Judge's own worker, and then the scoring worker
  // (the rogue) cannot compile the criteria: it takes 3 s, past judging's budget (4 × 250 ms), or
  // it crashes. The task is refused as the criteria check refuses it (P05-R12), with the reason,
  // and not judged: no entry is scored 0 for the criteria, nothing is published, there is no pick.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const cases = [
    {
      title: "rogue:slow:3000",
      reason: "criteria schema is not supported: it takes too long to compile",
    },
    { title: "rogue:compile-throws", reason: "criteria could not be checked" },
  ];
  for (const { title, reason } of cases) {
    await resetDb(db);
    const { chain, commitment } = await postJudged([["alice.test.near", '{"x":1}', 10n]], {
      criteria: jsonSchemaCriteria({ title, type: "object" }),
      heldout: X_IS_1,
    });
    nextScorerFrom(ROGUE_WORKER);
    const deps = judgeDeps(db, chain, { scoringLimits: { compileBudgetMs: 250 } });
    expect(await judgeTask(deps, 7n), title).toBe("failed_closed");
    expect(await judgeRow(db, 7)).toEqual({ judge_status: "rejected", judge_reason: reason });
    expect(chain.pick).not.toHaveBeenCalled();
    expect(await scorecardCount()).toBe(0);
    expect(await isPublic(db, commitment)).toBe(false);
  }
  expect(warn).toHaveBeenCalledTimes(cases.length);
});

test("tasks_the_judge_was_not_late_for_are_picked_as_before", { timeout: 60_000 }, async () => {
  // A task with no entries past the stop line: nobody to pay, and nothing the Judge could have
  // scored. The empty pick refunds it at once, as before P05-R13.
  const empty = await postJudged([]);
  expect(await judgeTask(judgeDeps(db, empty.chain, { now: at(9.5) }), 7n)).toBe("no_award");
  expect((await picked(empty.chain)).scorecard.entries).toEqual([]);

  // A task whose entries were all turned away for their own faults, in time: nothing was left
  // for the stop line, and the scorecard says why each scores 0.
  await resetDb(db);
  const missing = sha256Hex("never uploaded");
  const unusable = await postJudged([], {
    extra: [entry("mallory.test.near", missing, blobUri(missing), 10n)],
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  expect(await judgeTask(judgeDeps(db, unusable.chain), 7n)).toBe("no_award");
  expect((await picked(unusable.chain)).scorecard.entries.map((e) => e.reasons)).toEqual([
    ["content unavailable: not uploaded for this task"],
  ]);
  expect(warn).not.toHaveBeenCalled();
});

test("entries_with_the_same_uri_and_hash_are_fetched_and_scored_once", {
  timeout: 60_000,
}, async () => {
  // Two entrants name the same file elsewhere; a third names it by another URI. Two more each
  // uploaded the same answer here, which is one blob with one URI.
  const extra = [
    entry("a.test.near", sha256Hex("42"), "http://files.example/42", 10n),
    entry("b.test.near", sha256Hex("42"), "http://files.example/42", 11n),
    entry("c.test.near", sha256Hex("42"), "http://files.example/42?copy", 12n),
  ];
  const { chain } = await postJudged(
    [
      ["d.test.near", "42", 13n],
      ["e.test.near", "42", 14n],
    ],
    { extra },
  );
  const { io, requests } = fakeNetwork(
    { "files.example": [PUBLIC_IP] },
    { "files.example/42": ok("42") },
  );
  let scores = 0;
  nextScorerCalls(() => {
    scores++;
  });
  const deps = judgeDeps(db, chain, { fetchIo: io });
  const resultUploaded = vi.spyOn(deps, "resultUploaded");

  expect(await judgeTask(deps, 7n)).toBe("picked");

  // One fetch and one score for each content; each entrant's upload is looked up all the same.
  expect(requests.map(({ url }) => url)).toEqual([
    `http://${PUBLIC_IP}/42`,
    `http://${PUBLIC_IP}/42?copy`,
  ]);
  expect(scores).toBe(3);
  expect(resultUploaded).toHaveBeenCalledTimes(2);
  const card = await picked(chain);
  expect(card.scorecard.entries.map((e) => [e.account, e.score])).toEqual(
    ["a", "b", "c", "d", "e"].map((name) => [`${name}.test.near`, 100]),
  );
  expect(card.winners).toEqual([
    { account: "a.test.near", bps: 7000 },
    { account: "b.test.near", bps: 3000 },
  ]);
});

test("no_more_than_32_contents_are_held_at_once", { timeout: 30_000 }, async () => {
  // Seventy entrants whose answers are ours, twenty whose files are elsewhere, and two late ones
  // that uploaded the first entrant's answer too. Ours are read 32 at a time and the others
  // fetched 8 at a time, and a batch is scored before the next one is read: no more than 32
  // contents are held at once. The late two share the first one's score.
  const answers: Answer[] = Array.from({ length: 70 }, (_, i) => [
    `e${String(i).padStart(2, "0")}.test.near`,
    `${i}`,
    BigInt(100 + i),
  ]);
  const files = Array.from({ length: 20 }, (_, i) => `${100 + i}`);
  const extra = files.map((name, i) =>
    entry(`x${name}.test.near`, sha256Hex(name), `http://files.example/${name}`, BigInt(200 + i)),
  );
  for (const late of ["late1.test.near", "late2.test.near"]) {
    const sha = await putResult(db, "0", late);
    extra.push(entry(late, sha, blobUri(sha), 300n));
  }
  const { chain } = await postJudged(answers, { extra });
  const network = fakeNetwork(
    { "files.example": [PUBLIC_IP] },
    Object.fromEntries(files.map((name) => [`files.example/${name}`, ok(name)])),
  );
  // Our answers, as the database is asked for them.
  const ours = new Set(answers.map(([, answer]) => sha256Hex(answer)));
  let reads = 0;
  const counting: Db = {
    ...db,
    query: async (sql, params) => {
      if (sql.includes("from blobs where sha256") && ours.has(String(params?.[0]))) reads++;
      return db.query(sql, params);
    },
  };
  let scored = 0;
  let mostHeld = 0;
  nextScorerCalls(() => {
    mostHeld = Math.max(mostHeld, reads + network.requests.length - scored);
    scored++;
  });

  const deps = judgeDeps(counting, chain, { fetchIo: network.io });
  expect(await judgeTask(deps, 7n)).toBe("picked");

  expect(reads).toBe(70);
  expect(network.requests).toHaveLength(20);
  expect(scored).toBe(90);
  expect(mostHeld).toBe(32);
  const card = await picked(chain);
  expect(card.winners).toEqual([{ account: "e42.test.near", bps: 10_000 }]);
  const late = card.scorecard.entries.filter((e) => e.account.startsWith("late"));
  expect(late.map((e) => [e.account, e.score, e.reasons])).toEqual([
    ["late1.test.near", 0, ["expected one of 2 accepted answers"]],
    ["late2.test.near", 0, ["expected one of 2 accepted answers"]],
  ]);
});

test("a_scorecard_that_cannot_be_built_is_retried_next_tick", async () => {
  // An account the scorecard schema refuses. The chain never returns one; it stands for any slip
  // that makes `buildScorecard` throw.
  const { chain, commitment } = await postJudged([["alice.test.near", "42", 10n]], {
    extra: [entry("Not An Account", sha256Hex("x"), "ipfs://x", 11n)],
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("skipped");
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^judge: WARN task 7: .*scorecard/));
  expect(chain.pick).not.toHaveBeenCalled();
  expect(await scorecardCount()).toBe(0);
  expect(await isPublic(db, commitment)).toBe(false);
  expect(await judgeRow(db, 7)).toEqual({ judge_status: "accepted", judge_reason: null });
});

test("a_failed_pick_is_retried_next_tick", async () => {
  const { chain } = await postJudged([["alice.test.near", "42", 10n]]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  chain.pick.mockRejectedValueOnce(new TenderError("E_UNKNOWN", "no final outcome"));

  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("skipped");
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^judge: WARN task 7: pick failed/));
  expect(await judgeRow(db, 7)).toEqual({ judge_status: "accepted", judge_reason: null });

  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("picked");
  // Both tries sent the same scorecard: its bytes depend only on what was judged, and the time.
  const [first, second] = chain.pick.mock.calls;
  expect(second).toEqual(first);
  expect(await scorecardCount()).toBe(1);
});

// ---------------------------------------------------------------------------------------------
// Fetching an entry's content
// ---------------------------------------------------------------------------------------------

test("fetch_refuses_private_addresses", async () => {
  const { io, requests } = fakeNetwork(
    { "files.example": [PUBLIC_IP], localhost: ["127.0.0.1", "::1"] },
    { "files.example/moved": redirect("http://localhost/x") },
  );
  const refused = [
    "http://127.0.0.1/x",
    "http://10.0.0.5/x",
    "http://169.254.169.254/latest",
    "http://files.example/moved",
  ];
  const deps = judgeDeps(db, fakeChain(null));
  for (const uri of refused) {
    expect(await fetchEntryContent(deps, uri, io), uri).toEqual({ error: "address not allowed" });
  }
  // The one request made went to the public address, which answered with the redirect.
  expect(requests).toEqual([{ url: `http://${PUBLIC_IP}/moved`, host: "files.example" }]);

  // As entries, each scores 0 with that reason and can never win, even with a pass mark of 0.
  const criteria = { ...EXACT, min_score: 0, split: "winner_take_all" };
  const extra = refused.map((uri, i) => entry(`e${i}.test.near`, sha256Hex("42"), uri, BigInt(i)));
  const { chain } = await postJudged([["honest.test.near", "41", 9n]], { criteria, extra });

  expect(await judgeTask(judgeDeps(db, chain, { fetchIo: io }), 7n)).toBe("picked");
  const card = await picked(chain);
  expect(card.winners).toEqual([{ account: "honest.test.near", bps: 10_000 }]);
  for (const scored of card.scorecard.entries.slice(0, 4)) {
    expect(scored).toMatchObject({
      score: 0,
      passed: false,
      reasons: ["content unavailable: address not allowed"],
    });
  }
});

test("fetch_refuses_every_address_that_is_not_public", async () => {
  const deps = judgeDeps(db, fakeChain(null));
  const refused = [
    ["0.0.0.0", "this network"],
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "RFC 1918"],
    ["172.16.0.1", "RFC 1918"],
    ["172.31.255.255", "RFC 1918"],
    ["192.168.1.1", "RFC 1918"],
    ["100.100.100.200", "shared address space, where a cloud keeps its metadata"],
    ["169.254.169.254", "link-local metadata"],
    ["192.0.0.192", "IETF protocol assignments, where a cloud keeps its metadata"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:a00:1", "IPv4-mapped RFC 1918"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["64:ff9b::a00:1", "NAT64"],
    ["fc00::1", "RFC 4193"],
    ["fd12:3456::1", "RFC 4193"],
    ["fe80::1", "link-local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["2002:a00:1::1", "6to4"],
    ["not an address", "not an address at all"],
  ];
  for (const [address, what] of refused) {
    const { io, requests } = fakeNetwork(
      { "host.example": [address ?? ""] },
      { "host.example/a": ok("42") },
    );
    expect(await fetchEntryContent(deps, "http://host.example/a", io), what).toEqual({
      error: "address not allowed",
    });
    expect(requests, what).toEqual([]);
  }

  // Every address a name resolves to must be public, not only the first.
  const mixed = fakeNetwork(
    { "host.example": [PUBLIC_IP, "10.0.0.1"] },
    { "host.example/a": ok("42") },
  );
  expect(await fetchEntryContent(deps, "http://host.example/a", mixed.io)).toEqual({
    error: "address not allowed",
  });
  expect(mixed.requests).toEqual([]);

  // A host written as an address is checked the same way, in any spelling the URL parser takes.
  const literal = fakeNetwork({});
  for (const uri of [
    "http://[::1]/a",
    "http://[::ffff:7f00:1]/a",
    "http://2130706433/a",
    "http://0x7f.1/a",
    "https://[fd00::1]:8443/a",
  ]) {
    expect(await fetchEntryContent(deps, uri, literal.io), uri).toEqual({
      error: "address not allowed",
    });
  }
  expect(literal.lookups).toEqual([]);
  expect(literal.requests).toEqual([]);

  // Public addresses, of either family, are fetched.
  for (const address of [PUBLIC_IP, "::ffff:8.8.8.8", "2606:4700:4700::1111"]) {
    const { io } = fakeNetwork({ "host.example": [address] }, { "host.example/a": ok("42") });
    expect(await fetchEntryContent(deps, "http://host.example/a", io), address).toEqual(
      bytes("42"),
    );
  }
});

test("fetch_connects_only_to_the_address_it_checked", async () => {
  // A name that answers with a public address once, and with loopback after that: a DNS
  // rebinding. The Judge resolves a name once per request and sends the request to the address
  // it checked, naming the host in the Host header.
  let answers = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("42"));
  const io: FetchIo = {
    lookup: async () => (answers++ === 0 ? [PUBLIC_IP] : ["127.0.0.1"]),
    fetchImpl,
  };
  const deps = judgeDeps(db, fakeChain(null));

  expect(await fetchEntryContent(deps, "http://rebind.example:8080/answer?v=1", io)).toEqual(
    bytes("42"),
  );
  expect(answers).toBe(1);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = fetchImpl.mock.calls[0] ?? [];
  expect(String(url)).toBe(`http://${PUBLIC_IP}:8080/answer?v=1`);
  expect(new Headers(init?.headers).get("host")).toBe("rebind.example:8080");
  expect(init?.redirect).toBe("manual");

  // An IPv6 address goes in brackets, and the default port stays out of the Host header.
  const v6 = fakeNetwork({ "v6.example": ["2606:4700:4700::1111"] }, { "v6.example/a": ok("42") });
  expect(await fetchEntryContent(deps, "https://v6.example/a", v6.io)).toEqual(bytes("42"));
  expect(v6.requests).toEqual([{ url: "https://[2606:4700:4700::1111]/a", host: "v6.example" }]);
});

test("fetch_follows_at_most_three_redirects_and_checks_each", async () => {
  const { io, lookups, requests } = fakeNetwork(
    { "a.example": [PUBLIC_IP], "b.example": [OTHER_PUBLIC_IP] },
    {
      "a.example/1": redirect("http://b.example/2"),
      // A relative location is taken from the host that sent it.
      "b.example/2": redirect("/3", 301),
      "b.example/3": redirect("http://a.example/4", 307),
      "a.example/4": ok("42"),
      "a.example/loop": redirect("/loop"),
    },
  );
  const deps = judgeDeps(db, fakeChain(null));

  expect(await fetchEntryContent(deps, "http://a.example/1", io)).toEqual(bytes("42"));
  expect(requests).toEqual([
    { url: `http://${PUBLIC_IP}/1`, host: "a.example" },
    { url: `http://${OTHER_PUBLIC_IP}/2`, host: "b.example" },
    { url: `http://${OTHER_PUBLIC_IP}/3`, host: "b.example" },
    { url: `http://${PUBLIC_IP}/4`, host: "a.example" },
  ]);
  // Each hop is resolved and checked again.
  expect(lookups).toEqual(["a.example", "b.example", "b.example", "a.example"]);

  // Three redirects are followed; a fourth is one too many.
  requests.length = 0;
  expect(await fetchEntryContent(deps, "http://a.example/loop", io)).toEqual({
    error: "too many redirects",
  });
  expect(requests).toHaveLength(4);
});

test("fetch_tries_the_next_checked_address_when_one_cannot_be_reached", async () => {
  // A host with an IPv6 and an IPv4 address, whose IPv6 cannot be reached from here: the request
  // goes to the IPv4 one next, with the same Host. A status is an answer, and no other address is
  // asked. One address of each family is tried, however many the name has, and when neither can
  // be reached, the fetch fails.
  const v6 = "2606:4700:4700::1111";
  const otherV6 = "2606:4700:4700::1001";
  const { io, requests } = fakeNetwork(
    {
      "dual.example": [v6, PUBLIC_IP],
      "busy.example": [OTHER_PUBLIC_IP, PUBLIC_IP],
      "dark.example": ["8.8.8.8", "1.1.1.1"],
      "many.example": [v6, otherV6, "8.8.8.8", "1.1.1.1", "9.9.9.9"],
    },
    {
      "dual.example/a": ok("42"),
      "busy.example/a": () => new Response("busy", { status: 503 }),
      "dark.example/a": ok("42"),
      "many.example/a": ok("42"),
    },
    [v6, otherV6, "8.8.8.8", "1.1.1.1", "9.9.9.9"],
  );
  const deps = judgeDeps(db, fakeChain(null));

  expect(await fetchEntryContent(deps, "http://dual.example/a", io)).toEqual(bytes("42"));
  expect(requests).toEqual([
    { url: `http://[${v6}]/a`, host: "dual.example" },
    { url: `http://${PUBLIC_IP}/a`, host: "dual.example" },
  ]);

  requests.length = 0;
  expect(await fetchEntryContent(deps, "http://busy.example/a", io)).toEqual({
    error: "http status 503",
  });
  expect(requests).toHaveLength(1);

  requests.length = 0;
  expect(await fetchEntryContent(deps, "http://dark.example/a", io)).toEqual({
    error: "fetch failed",
  });
  expect(requests.map(({ url }) => url)).toEqual(["http://8.8.8.8/a"]);

  requests.length = 0;
  expect(await fetchEntryContent(deps, "http://many.example/a", io)).toEqual({
    error: "fetch failed",
  });
  expect(requests.map(({ url }) => url)).toEqual([`http://[${v6}]/a`, "http://8.8.8.8/a"]);
});

test("fetch_gives_up_on_an_address_that_does_not_connect_and_tries_the_next", async () => {
  // A host whose IPv6 address never completes the connection, as one that drops the attempt
  // does. The transport gives up on it when `connectSignal` aborts, 3 s in, and the IPv4 address
  // answers, well within the 10 s of the whole fetch.
  const v6 = "2606:4700:4700::1111";
  const requests: string[] = [];
  const io: FetchIo = {
    lookup: async () => [v6, PUBLIC_IP],
    fetchImpl: (url, init) => {
      requests.push(url.href);
      if (url.hostname !== `[${v6}]`) return Promise.resolve(new Response("42"));
      return new Promise<Response>((_, reject) => {
        init.connectSignal?.addEventListener("abort", () => reject(new TypeError("fetch failed")));
      });
    },
  };
  const deps = judgeDeps(db, fakeChain(null));

  vi.useFakeTimers();
  try {
    let settled = false;
    const result = fetchEntryContent(deps, "http://dual.example/a", io).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    expect(requests).toEqual([`http://[${v6}]/a`]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual(bytes("42"));
    expect(requests).toEqual([`http://[${v6}]/a`, `http://${PUBLIC_IP}/a`]);
  } finally {
    vi.useRealTimers();
  }
});

test("the_default_transport_gives_up_on_a_connection_that_is_not_made", async () => {
  // A server that takes the TCP connection and never says a word, so TLS is never set up: the
  // request ends when its `connectSignal` aborts, and the connection is closed.
  const sockets: Socket[] = [];
  let closed = 0;
  const silent = createNetServer((socket) => {
    sockets.push(socket);
    // It reads what comes, so that it sees the connection end.
    socket.resume();
    socket.on("close", () => closed++);
  });
  // A server that answers when the test says so.
  const held: ServerResponse[] = [];
  const answering = createServer((_request, response) => held.push(response));
  for (const server of [silent, answering]) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  }
  const portOf = (server: { address(): unknown }) => (server.address() as AddressInfo).port;
  const waitLong = { timeout: 5_000 };
  try {
    const connect = new AbortController();
    const attempt = pinnedFetch(`https://127.0.0.1:${portOf(silent)}/a`, {
      headers: { host: "judge.invalid" },
      connectSignal: connect.signal,
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1), waitLong);
    connect.abort();
    await expect(attempt).rejects.toThrow();
    await vi.waitFor(() => expect(closed).toBe(1), waitLong);

    // Once the connection is made, `connectSignal` no longer counts: the request goes on.
    const late = new AbortController();
    const answered = pinnedFetch(`http://127.0.0.1:${portOf(answering)}/a`, {
      headers: { host: "judge.invalid" },
      connectSignal: late.signal,
    });
    await vi.waitFor(() => expect(held).toHaveLength(1), waitLong);
    late.abort();
    held[0]?.end("42");
    expect(await (await answered).text()).toBe("42");
  } finally {
    for (const socket of sockets) socket.destroy();
    answering.closeAllConnections();
    for (const server of [silent, answering]) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("the_default_transport_goes_to_the_address_and_names_the_host", async () => {
  // A server in this process, on loopback, which is not the network. The URL holds the address and
  // the host header a name that cannot resolve (`.invalid` never does), so the request reached the
  // server only by going to the address.
  const seen: { host?: string; encoding?: string; path?: string }[] = [];
  let closed = 0;
  const server = createServer((request, response) => {
    seen.push({
      host: request.headers.host,
      encoding: request.headers["accept-encoding"],
      path: request.url,
    });
    // `/hold` is never answered.
    if (request.url === "/hold") request.socket.on("close", () => closed++);
    else response.end("42");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await pinnedFetch(`http://127.0.0.1:${port}/answer?v=1`, {
      headers: { host: "judge.invalid" },
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes("42"));
    expect(seen).toEqual([{ host: "judge.invalid", encoding: "identity", path: "/answer?v=1" }]);

    // An abort stops a request that is never answered, and closes its connection.
    const controller = new AbortController();
    const held = pinnedFetch(`http://127.0.0.1:${port}/hold`, {
      headers: { host: "judge.invalid" },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    controller.abort();
    await expect(held).rejects.toThrow();
    await vi.waitFor(() => expect(closed).toBe(1));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetch_caps_the_body_while_it_streams", async () => {
  let pulls = 0;
  /** A body that never ends, 64 KiB at a time. */
  const endless = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(65_536));
        },
      }),
    );
  const { io } = fakeNetwork(
    { "big.example": [PUBLIC_IP] },
    {
      "big.example/endless": endless,
      "big.example/declared": () => {
        const response = endless();
        response.headers.set("content-length", "262145");
        return response;
      },
      "big.example/limit": ok(new Uint8Array(262_144)),
    },
  );
  const deps = judgeDeps(db, fakeChain(null));

  // It stops reading once the body is past 262_144 bytes, five chunks in, not at its end.
  expect(await fetchEntryContent(deps, "http://big.example/endless", io)).toEqual({
    error: "too large",
  });
  expect(pulls).toBeLessThanOrEqual(6);
  // A length declared past the cap is refused before any of the body is read.
  pulls = 0;
  expect(await fetchEntryContent(deps, "http://big.example/declared", io)).toEqual({
    error: "too large",
  });
  expect(pulls).toBeLessThanOrEqual(1);
  // 262_144 bytes is not too many.
  expect(await fetchEntryContent(deps, "http://big.example/limit", io)).toEqual(
    new Uint8Array(262_144),
  );
});

test("fetch_gives_up_after_ten_seconds", async () => {
  const signals: AbortSignal[] = [];
  const never = (init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise<Response>(() => undefined);
  };
  const stalls: [string, FetchIo][] = [
    [
      "a lookup that never answers",
      { lookup: () => new Promise(() => undefined), fetchImpl: (_, init) => never(init) },
    ],
    [
      "a server that never answers",
      { lookup: async () => [PUBLIC_IP], fetchImpl: (_, init) => never(init) },
    ],
    [
      "a body that stops halfway",
      {
        lookup: async () => [PUBLIC_IP],
        fetchImpl: async () =>
          new Response(
            new ReadableStream({ start: (controller) => controller.enqueue(bytes("4")) }),
          ),
      },
    ],
  ];
  const deps = judgeDeps(db, fakeChain(null));

  vi.useFakeTimers();
  try {
    for (const [what, io] of stalls) {
      let settled = false;
      const result = fetchEntryContent(deps, "http://slow.example/a", io).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled, what).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result, what).toEqual({ error: "timed out" });
    }
  } finally {
    vi.useRealTimers();
  }
  // The request that was waiting was told to stop.
  expect(signals.map((signal) => signal.aborted)).toEqual([true]);
});

test("fetch_failures_have_fixed_reasons", async () => {
  const { io } = fakeNetwork(
    { "files.example": [PUBLIC_IP], "empty.example": [] },
    {
      "files.example/404": () => new Response("<h1>details of the server</h1>", { status: 404 }),
      "files.example/500": () => new Response("a stack trace", { status: 500 }),
      "files.example/no-location": () => new Response(null, { status: 302 }),
      "files.example/to-ftp": redirect("ftp://files.example/a"),
      "files.example/to-file": redirect("file:///etc/passwd"),
    },
  );
  const deps = judgeDeps(db, fakeChain(null));
  const reasons: [string, string][] = [
    ["http://files.example/404", "http status 404"],
    ["http://files.example/500", "http status 500"],
    ["http://files.example/no-location", "bad redirect"],
    ["http://files.example/to-ftp", "unsupported uri"],
    ["http://files.example/to-file", "unsupported uri"],
    ["http://files.example/unrouted", "fetch failed"],
    ["http://nowhere.example/a", "host not found"],
    ["http://empty.example/a", "host not found"],
    ["ftp://files.example/a", "unsupported uri"],
    ["file:///etc/passwd", "unsupported uri"],
    ["data:text/plain,42", "unsupported uri"],
    ["ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", "unsupported uri"],
    ["not a uri", "unsupported uri"],
    ["http://user:secret@files.example/a", "unsupported uri"],
  ];
  for (const [uri, error] of reasons) {
    expect(await fetchEntryContent(deps, uri, io), uri).toEqual({ error });
  }
});

test("fetch_reads_our_own_blobs_from_the_database", async () => {
  // A result blob is private until the API serves it, and the Judge reads it all the same, from
  // the database and not over HTTP.
  const sha = await putResult(db, "42", "alice.test.near");
  const deps = judgeDeps(db, fakeChain(null));

  expect(await fetchEntryContent(deps, blobUri(sha), NO_NETWORK)).toEqual(bytes("42"));
  expect(
    await fetchEntryContent({ ...deps, publicUrl: `${PUBLIC_URL}/` }, blobUri(sha), NO_NETWORK),
  ).toEqual(bytes("42"));
  expect(await fetchEntryContent(deps, blobUri(sha256Hex("never stored")), NO_NETWORK)).toEqual({
    error: "not found",
  });
  const large = await putBlob(db, {
    kind: "result",
    contentType: "text/plain",
    bytes: new Uint8Array(262_145),
    isPublic: false,
  });
  expect(await fetchEntryContent(deps, blobUri(large), NO_NETWORK)).toEqual({ error: "too large" });

  // A blob of another kind is no entry's content, whether it is private, as the held-out checks
  // of an open task are, or public.
  const heldout = await putHeldout(db, { exact: { expected: ["secret"] } });
  const criteria = await putCriteria(db, EXACT);
  for (const other of [heldout, criteria]) {
    expect(await fetchEntryContent(deps, blobUri(other), NO_NETWORK)).toEqual({
      error: "not found",
    });
  }

  // Under our blob path, anything but a hash is refused rather than fetched.
  for (const uri of [
    `${PUBLIC_URL}/v1/blobs/${sha.toUpperCase()}`,
    `${PUBLIC_URL}/v1/blobs/${sha}?download=1`,
    `${PUBLIC_URL}/v1/blobs/../${sha}`,
    `${PUBLIC_URL}/v1/blobs/`,
  ]) {
    expect(await fetchEntryContent(deps, uri, NO_NETWORK), uri).toEqual({
      error: "unsupported uri",
    });
  }
});

// ---------------------------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------------------------

test("tender_client_is_a_judge_chain", () => {
  // Checked by the compiler: `pnpm typecheck` fails here if TenderClient stops being a JudgeChain.
  const asJudgeChain = (client: TenderClient): JudgeChain => client;
  expect(asJudgeChain).toBeTypeOf("function");
});

test("judge_tick_takes_a_task_from_intake_to_pick", async () => {
  // A task intake has not seen yet, in its judging window, with its documents and an answer.
  const criteriaHash = await putCriteria(db, EXACT);
  const view = taskView({
    criteria_hash: criteriaHash,
    heldout_commitment: await putHeldout(db, HELDOUT),
  });
  await insertTask(db, view);
  const sha = await putResult(db, "42", "alice.test.near");
  const chain = fakeChain(view, [entry("alice.test.near", sha, blobUri(sha))]);
  // Another verifier's task, which the tick leaves alone.
  await insertTask(
    db,
    taskView({ id: "8", verifier: "other-judge.test.near", criteria_hash: criteriaHash }),
  );

  await judgeTick(judgeDeps(db, chain));

  expect(await judgeRow(db, 7)).toEqual({ judge_status: "accepted", judge_reason: null });
  expect((await picked(chain)).winners).toEqual([{ account: "alice.test.near", bps: 10_000 }]);
  expect(await judgeRow(db, 8)).toEqual({ judge_status: null, judge_reason: null });
  expect(chain.getTask.mock.calls).toEqual([[7n]]);
});

test("judge_tick_clears_a_waiting_reason_that_outlives_the_wait", async () => {
  // The Judge was not running when task 7's wait ended, and comes back as its pick window closes:
  // left alone, the reason would say for ever that it waits. A tick clears it once the pick
  // deadline has passed, and from a settled task, but not from a task that can still be judged,
  // nor a reason of another kind.
  const waiting = "waiting: held-out checks shared with task 99";
  const stillOpen = {
    reveal_deadline: (NOW_NS + 9n * MINUTE_NS).toString(),
    pick_deadline: (NOW_NS + 20n * MINUTE_NS).toString(),
    fallback_deadline: (NOW_NS + 30n * MINUTE_NS).toString(),
  };
  await insertTask(db, taskView({ id: "7" }), "accepted", waiting);
  await insertTask(db, taskView({ id: "8", ...stillOpen }), "accepted", waiting);
  await db.query("update tasks set outcome = $1 where id = 8", [
    JSON.stringify({ kind: "voided", reason: "expired" }),
  ]);
  await insertTask(db, taskView({ id: "9", ...stillOpen }), "accepted", waiting);
  await insertTask(db, taskView({ id: "10" }), "rejected", "criteria not found or invalid");
  // The chain has none of them, so judging does nothing with tasks 7 and 9 in their windows.
  const chain = fakeChain(null);

  // Just before task 7's pick deadline: only the settled task is cleared.
  await judgeTick(judgeDeps(db, chain, { now: at(9.99) }));
  expect(await judgeRow(db, 7)).toEqual({ judge_status: "accepted", judge_reason: waiting });
  expect(await judgeRow(db, 8)).toEqual({ judge_status: "accepted", judge_reason: null });

  // At the deadline its window is over, and its reason goes too.
  await judgeTick(judgeDeps(db, chain, { now: at(10) }));
  expect(await judgeRow(db, 7)).toEqual({ judge_status: "accepted", judge_reason: null });
  expect(await judgeRow(db, 9)).toEqual({ judge_status: "accepted", judge_reason: waiting });
  expect(await judgeRow(db, 10)).toEqual({
    judge_status: "rejected",
    judge_reason: "criteria not found or invalid",
  });
});

test("judge_tick_goes_on_after_a_task_fails", async () => {
  const criteriaHash = await putCriteria(db, EXACT);
  // Held-out checks of its own for each task: they are single-use.
  const checksOf = (id: string) => putHeldout(db, { exact: { expected: ["42", `task ${id}`] } });
  const sha = await putResult(db, "42", "alice.test.near", 8n);
  const views: TaskView[] = [];
  for (const id of ["7", "8"]) {
    views.push(
      taskView({ id, criteria_hash: criteriaHash, heldout_commitment: await checksOf(id) }),
    );
  }
  for (const view of views) await insertTask(db, view, "accepted");
  // A task in its reveal window by the database's deadlines, which the tick does not judge yet.
  await insertTask(
    db,
    taskView({
      id: "9",
      criteria_hash: criteriaHash,
      heldout_commitment: await checksOf("9"),
      reveal_deadline: views[0]?.pick_deadline,
    }),
    "accepted",
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const pick = vi.fn<JudgeChain["pick"]>(async () => ({}));
  const chain: JudgeChain = {
    // The chain cannot be read for task 7.
    getTask: async (id) => {
      if (id === 7n) throw new Error("rpc unavailable");
      return views[1] ?? null;
    },
    getAllEntries: async () => [{ ...entry("alice.test.near", sha, blobUri(sha)), task_id: "8" }],
    pick,
  };

  await judgeTick(judgeDeps(db, chain));

  expect(error).toHaveBeenCalledWith(expect.stringMatching(/^judge: judging task 7 failed/));
  expect(pick.mock.calls.map(([taskId, winners]) => [taskId, winners])).toEqual([
    [8n, [{ account: "alice.test.near", bps: 10_000 }]],
  ]);
});

/**
 * A database that only counts ticks. A tick starts by asking for the tasks intake waits on; every
 * query returns no rows, so a tick is two queries and nothing else. `hold`, while set, keeps that
 * first query of a tick waiting.
 */
function countingDb() {
  const state = {
    ticks: 0,
    failNext: false,
    hold: undefined as Promise<void> | undefined,
  };
  const db = {
    query: async (sql: string) => {
      if (sql.includes("judge_status is null")) {
        state.ticks++;
        if (state.failNext) {
          state.failNext = false;
          throw new Error("the database went away");
        }
        await state.hold;
      }
      return [];
    },
  } as unknown as Db;
  return { db, state };
}

test("start_judge_ticks_until_aborted", async () => {
  const { db: counting, state } = countingDb();
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.useFakeTimers();
  try {
    // A tick that throws is logged, and the next tick runs 10 s after it ended.
    state.failNext = true;
    const controller = new AbortController();
    let stopped = false;
    const loop = startJudge({ ...judgeDeps(counting, fakeChain(null)), signal: controller.signal });
    void loop.then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.ticks).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^judge: tick failed/));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(state.ticks).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.ticks).toBe(2);

    // An abort during the wait stops the loop at once.
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.ticks).toBe(2);

    // A signal that is aborted already runs no tick.
    await startJudge({ ...judgeDeps(counting, fakeChain(null)), signal: AbortSignal.abort() });
    expect(state.ticks).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

test("start_judge_never_overlaps_ticks", async () => {
  const { db: counting, state } = countingDb();
  vi.useFakeTimers();
  try {
    let release: () => void = () => undefined;
    state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    let stopped = false;
    const loop = startJudge({
      ...judgeDeps(counting, fakeChain(null)),
      intervalMs: 100,
      signal: controller.signal,
    });
    void loop.then(() => {
      stopped = true;
    });

    // The first tick takes longer than the interval. No second tick starts while it runs.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.ticks).toBe(1);
    state.hold = undefined;
    release();
    await vi.advanceTimersByTimeAsync(99);
    expect(state.ticks).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.ticks).toBe(2);

    // An abort during a tick lets the tick finish, and then the loop stops.
    state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(state.ticks).toBe(3);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.ticks).toBe(3);
  } finally {
    vi.useRealTimers();
  }
});
