import { type Db, getBlob, migrate, openDb, putBlob } from "@tender/db";
import { canonicalJson, type EntryView, sha256Hex, type TaskView } from "@tender/shared";
import { vi } from "vitest";
import type { FetchIo, JudgeChain, JudgeDeps } from "../src/index";

// Shared by the intake and judging tests: the accounts, a clock, a task whose deadlines put that
// clock inside its judging window, a fake chain, and the rows and blobs the API would have stored.

export const JUDGE = "judge.test.near";
export const POSTER = "poster.test.near";
/** A poster the team runs (`JudgeDeps.teamAccounts`). */
export const TEAM_POSTER = "team.test.near";
export const PUBLIC_URL = "http://api.test";

/** The time every test runs at unless it sets its own. */
export const NOW = new Date("2026-11-08T12:00:00.000Z");

const NS_PER_MS = 1_000_000n;
export const MINUTE_NS = 60_000n * NS_PER_MS;
export const NOW_NS = BigInt(NOW.getTime()) * NS_PER_MS;

/** A clock that reads `NOW` plus `minutes`. */
export const at = (minutes: number) => () => new Date(NOW.getTime() + minutes * 60_000);

/**
 * A task posted 20 minutes before `NOW` and judged by `JUDGE`: its reveals closed a minute before
 * `NOW`, and its pick window runs for 10 minutes after, so at `NOW` it is in `judging`. Its
 * criteria and held-out hashes are placeholders; a test sets them to what it stored.
 */
export function taskView(over: Partial<TaskView> = {}): TaskView {
  return {
    id: "7",
    poster: POSTER,
    token: "usdc.test.near",
    reward: "5000000",
    fee_bps: 500,
    brief_uri: `${PUBLIC_URL}/v1/blobs/${sha256Hex("brief")}`,
    brief_hash: sha256Hex("brief"),
    criteria_hash: sha256Hex("criteria"),
    heldout_commitment: null,
    verifier: JUDGE,
    created_at: (NOW_NS - 20n * MINUTE_NS).toString(),
    commit_deadline: (NOW_NS - 10n * MINUTE_NS).toString(),
    reveal_deadline: (NOW_NS - MINUTE_NS).toString(),
    pick_deadline: (NOW_NS + 10n * MINUTE_NS).toString(),
    fallback_deadline: (NOW_NS + 20n * MINUTE_NS).toString(),
    max_entries: 0,
    max_winners: 2,
    invited: [],
    parent: null,
    commit_count: 0,
    reveal_count: 0,
    cleaned: 0,
    funders: [{ account: POSTER, amount: "5000000" }],
    outcome: null,
    phase: "judging",
    ...over,
  };
}

/** A migrated in-memory database. Close it when the test file is done. */
export async function testDb(): Promise<Db> {
  const db = await openDb("pglite:memory");
  await migrate(db);
  return db;
}

/**
 * The result uploads the API has recorded (P03-R17), as `sha256 task account`. `putResult` adds
 * to them, and the `resultUploaded` of `judgeDeps` reads them.
 */
const uploads = new Set<string>();
const upload = (sha256: string, taskId: bigint, account: string) =>
  `${sha256} ${taskId} ${account}`;

/** Empties the two tables the Judge works with, so one database can serve a whole test file. */
export async function resetDb(db: Db): Promise<void> {
  await db.exec("truncate tasks, blobs");
  uploads.clear();
}

/** Stores `view` as the indexer would have, with the Judge's `judge_status` already `status`. */
export async function insertTask(
  db: Db,
  view: TaskView,
  status: string | null = null,
  reason: string | null = null,
): Promise<void> {
  await db.query(
    `insert into tasks (
       id, poster, token, reward, fee_bps, brief_uri, brief_hash, criteria_hash,
       heldout_commitment, verifier, created_at, commit_deadline, reveal_deadline, pick_deadline,
       fallback_deadline, max_entries, max_winners, invited, parent, judge_status, judge_reason,
       created_height)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
             $20, $21, 1)`,
    [
      view.id,
      view.poster,
      view.token,
      view.reward,
      view.fee_bps,
      view.brief_uri,
      view.brief_hash,
      view.criteria_hash,
      view.heldout_commitment,
      view.verifier,
      view.created_at,
      view.commit_deadline,
      view.reveal_deadline,
      view.pick_deadline,
      view.fallback_deadline,
      view.max_entries,
      view.max_winners,
      JSON.stringify(view.invited),
      view.parent,
      status,
      reason,
    ],
  );
}

/** What the Judge wrote about a task: its `judge_status` and `judge_reason`. */
export async function judgeRow(
  db: Db,
  id: number | bigint,
): Promise<{ judge_status: string | null; judge_reason: string | null } | undefined> {
  const [row] = await db.query<{ judge_status: string | null; judge_reason: string | null }>(
    "select judge_status, judge_reason from tasks where id = $1",
    [id],
  );
  return row;
}

/** Stores public criteria as the upload route does: canonical bytes, public. Returns the hash. */
export function putCriteria(db: Db, criteria: unknown): Promise<string> {
  return putBlob(db, {
    kind: "criteria",
    contentType: "application/json",
    bytes: canonicalJson(criteria),
    uploader: POSTER,
    isPublic: true,
  });
}

/** Stores a held-out document as `POST /v1/heldout` does: private, with its uploader. */
export function putHeldout(db: Db, heldout: unknown, uploader = POSTER): Promise<string> {
  return putBlob(db, {
    kind: "heldout",
    contentType: "application/json",
    bytes: canonicalJson(heldout),
    uploader,
    isPublic: false,
  });
}

/**
 * Stores an entry's answer as `POST /v1/blobs` kind `result` does: private until served, and
 * recorded as `uploader`'s upload for task `taskId`. Identical answers share one blob, and each
 * uploader has a record of its own.
 */
export async function putResult(
  db: Db,
  text: string,
  uploader: string,
  taskId = 7n,
): Promise<string> {
  const sha256 = await putBlob(db, {
    kind: "result",
    contentType: "text/plain",
    bytes: new TextEncoder().encode(text),
    uploader,
    isPublic: false,
  });
  uploads.add(upload(sha256, taskId, uploader));
  return sha256;
}

/** Whether the blob stored under `sha256` is public. */
export async function isPublic(db: Db, sha256: string): Promise<boolean | undefined> {
  return (await getBlob(db, sha256))?.isPublic;
}

/** Our own blob URI for `sha256`. */
export const blobUri = (sha256: string): string => `${PUBLIC_URL}/v1/blobs/${sha256}`;

/** A revealed entry of task 7. */
export function entry(
  account: string,
  contentHash: string,
  uri: string,
  committedAtBlock = 100n,
): EntryView {
  return {
    task_id: "7",
    account,
    index: 0,
    commitment: sha256Hex(`commitment of ${account}`),
    committed_at_block: committedAtBlock.toString(),
    content_hash: contentHash,
    uri,
  };
}

/** A chain that knows one task and its entries. `pick` succeeds unless a test says otherwise. */
export function fakeChain(task: TaskView | null, entries: EntryView[] = []) {
  return {
    getTask: vi.fn(async (_id: bigint) => task),
    getAllEntries: vi.fn(async (_taskId: bigint) => entries),
    pick: vi.fn(
      async (
        _taskId: bigint,
        _winners: readonly { account: string; bps: number }[],
        _scorecardHash: string,
        _scorecardUri: string,
      ): Promise<unknown> => ({}),
    ),
  } satisfies JudgeChain;
}

/**
 * A network that refuses to be used: any lookup or request fails the test that made it. Tests that
 * fetch from other hosts pass a fake network of their own.
 */
export const NO_NETWORK: FetchIo = {
  lookup: async (host) => {
    throw new Error(`a test looked up ${host}`);
  },
  fetchImpl: async (input) => {
    throw new Error(`a test fetched ${String(input)}`);
  },
};

/**
 * The deps of a test Judge: `JUDGE` at `NOW`, with `TEAM_POSTER` on the team, the result uploads
 * that `putResult` recorded, and no network.
 */
export function judgeDeps(db: Db, client: JudgeChain, over: Partial<JudgeDeps> = {}): JudgeDeps {
  return {
    db,
    client,
    judgeAccount: JUDGE,
    teamAccounts: [TEAM_POSTER],
    publicUrl: PUBLIC_URL,
    resultUploaded: async (sha256, taskId, account) => uploads.has(upload(sha256, taskId, account)),
    now: () => NOW,
    fetchIo: NO_NETWORK,
    ...over,
  };
}
