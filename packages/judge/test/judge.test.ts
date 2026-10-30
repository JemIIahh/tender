import { type TenderClient, TenderError } from "@tender/client";
import { type Db, getBlob, putBlob } from "@tender/db";
import {
  canonicalJson,
  type EntryView,
  ScorecardSchema,
  sha256Hex,
  type TaskView,
} from "@tender/shared";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
  type FetchIo,
  fetchEntryContent,
  type JudgeChain,
  judgeTask,
  judgeTick,
  startJudge,
} from "../src/index";
import { scoreExact } from "../src/kinds/exact";
import { runInSandbox } from "../src/sandbox";
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
  NO_NETWORK,
  NOW,
  PUBLIC_URL,
  putCriteria,
  putHeldout,
  putResult,
  resetDb,
  taskView,
  testDb,
} from "./helpers";

// The real sandbox and the real exact scorer run unless a test queues something else for them.
vi.mock("../src/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sandbox")>();
  return { ...actual, runInSandbox: vi.fn(actual.runInSandbox) };
});
vi.mock("../src/kinds/exact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kinds/exact")>();
  return { ...actual, scoreExact: vi.fn(actual.scoreExact) };
});

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
 * `extra` entries are revealed after them, as they are.
 */
async function postJudged(
  answers: Answer[],
  o: { criteria?: object; heldout?: object | null; extra?: EntryView[] } = {},
) {
  const heldout = o.heldout === undefined ? HELDOUT : o.heldout;
  const view = taskView({
    criteria_hash: await putCriteria(db, o.criteria ?? EXACT),
    heldout_commitment: heldout === null ? null : await putHeldout(db, heldout),
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

/**
 * A network that exists only in the test. `hosts` says what each name resolves to; `routes`
 * answers a request by the Host it names and its path, and a request with no route fails as an
 * unreachable server does. Each lookup and each request is recorded, the request with the URL it
 * was sent to and its Host header.
 */
function fakeNetwork(hosts: Record<string, string[]>, routes: Record<string, () => Response> = {}) {
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
      const url = input instanceof Request ? input.url : String(input);
      const host = new Headers(init?.headers).get("host");
      requests.push({ url, host });
      const route = routes[`${host}${new URL(url).pathname}`];
      if (route === undefined) throw new TypeError("fetch failed");
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
  // task.
  expect(resultUploaded.mock.calls).toEqual(
    expect.arrayContaining([
      [sha256Hex("42"), 7n, "alice.test.near"],
      [sha256Hex("42"), 7n, "dan.test.near"],
      [eves, 7n, "eve.test.near"],
      [sha256Hex("42"), 7n, "mallory.test.near"],
      [bobs, 7n, "bob.test.near"],
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

test("a_scorer_that_cannot_start_is_retried_next_tick", async () => {
  const { chain } = await postJudged([["alice.test.near", '{"pattern":"^a$"}', 10n]], {
    criteria: REGEX,
    heldout: null,
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.mocked(runInSandbox).mockRejectedValueOnce(new Error("the engine could not be loaded"));

  // The sandbox could not be started: that is the Judge's trouble, so the entry is not scored 0
  // and nothing is picked.
  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("skipped");
  expect(chain.pick).not.toHaveBeenCalled();
  expect(await scorecardCount()).toBe(0);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^judge: WARN task 7: /));

  // The next tick has a sandbox, and judges the task.
  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("picked");
  expect((await picked(chain)).winners).toEqual([{ account: "alice.test.near", bps: 10_000 }]);
});

test("a_scorer_that_throws_scores_that_entry_zero", async () => {
  const { chain } = await postJudged([
    ["alice.test.near", "42", 10n],
    ["bob.test.near", "42", 11n],
  ]);
  // The first entry scored makes the scorer throw.
  vi.mocked(scoreExact).mockImplementationOnce(() => {
    throw new RangeError("Maximum call stack size exceeded");
  });

  expect(await judgeTask(judgeDeps(db, chain), 7n)).toBe("picked");

  const card = await picked(chain);
  expect(card.winners).toEqual([{ account: "bob.test.near", bps: 10_000 }]);
  expect(card.scorecard.entries.map((e) => [e.account, e.score, e.passed, e.reasons])).toEqual([
    ["bob.test.near", 100, true, []],
    ["alice.test.near", 0, false, ["scoring failed"]],
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

test("judge_tick_goes_on_after_a_task_fails", async () => {
  const criteriaHash = await putCriteria(db, EXACT);
  const commitment = await putHeldout(db, HELDOUT);
  const sha = await putResult(db, "42", "alice.test.near", 8n);
  const views = ["7", "8"].map((id) =>
    taskView({ id, criteria_hash: criteriaHash, heldout_commitment: commitment }),
  );
  for (const view of views) await insertTask(db, view, "accepted");
  // A task in its reveal window by the database's deadlines, which the tick does not judge yet.
  await insertTask(
    db,
    taskView({
      id: "9",
      criteria_hash: criteriaHash,
      heldout_commitment: commitment,
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
