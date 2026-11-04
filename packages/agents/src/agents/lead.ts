import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { SignedTx, TenderClient } from "@tender/client";
import { type Draft, isDraftOf, type StateStore } from "@tender/mcp";
import {
  AccountIdSchema,
  BriefSchema,
  canonicalJson,
  computeCommitment,
  DelegateViewSchema,
  formatTokenAmount,
  HeldoutSchema,
  heldoutMatchesCriteria,
  PublicCriteriaSchema,
  parseTokenAmount,
  randomSalt,
  sha256Hex,
  type TaskDetailResponse,
  type TenderApi,
  tokenMeta,
  U64StringSchema,
} from "@tender/shared";
import type { Solver, TaskContext } from "../types";
import { journalHeldElsewhere, lockJournal } from "./lead-lock";

// The lead agent of a swarm: it takes a parent task that is too big to answer alone, hires
// specialists for its parts with sub-tasks of its own, and answers the parent with what they hand in.
//
// It has two halves, and the split between them is what keeps it safe to run beside the runner.
//
// The solver half is a `Solver`, so the ordinary runner (`runAgent`) finds the parent, announces
// the work and commits. Its `solve` is quick: it takes the parent through the gate below, writes a
// job for it (the journal, below), and returns the placeholder bytes, which the runner commits and
// saves as the parent's draft like any other answer, with all of its recovery. A sub-task can name a
// parent only if its poster has an entry on it (`E_PARENT`), and that entry is the placeholder's.
// The placeholder is harmless: if the lead never finishes, the runner reveals it, it fails the
// parent's schema, and the parent is not paid.
//
// The job half is the lead's own loop (`run`, or a `tick` at a time), and it is not the runner's.
// Hiring and waiting take as long as the parent's commit window, which can be an hour, and a
// solve that takes that long would either be dropped by the runner's `solveTimeoutMs` (default
// 120 s) while the lead went on paying, or, with a timeout long enough, hold up every reveal the
// agent owes. So `solve` never waits for anything, and the job runs beside the runner, whose tick
// is never held up by it:
//
// 1. hiring: once the placeholder is an entry on the chain, one sub-task for each folder of
//    `seedsDir`, in name order, with `parent` set, the Judge as verifier and `{ delegate: true }`
//    (the lead signs with a function-call key, which cannot attach a deposit, so each post spends
//    the lead's vault within the caps its account registered for that key). The brief, the criteria
//    and the held-out checks are uploaded first, by the lead, who is the poster of the sub-task;
// 2. waiting: for the Judge to pick every sub-task, and then for each winner's result;
// 3. assembling: `{ "parts": [result of the first, ...] }`, saved as the parent's draft over the
//    placeholder's and committed (a second commit by an entrant replaces its commitment). If the
//    lead dies between the two, the runner finds a draft with no commit on the chain and sends
//    it. The reveal is the runner's, from that draft, once the parent's reveal window opens.
//
// Every step of a job is written down before it is taken (the journal: one small file for each
// parent, `journalDir/<parent id>.json`), so a restart picks the job up where it stopped and never
// hires a part twice. One lead works from a journal at a time: `run` holds it with a lock file
// (`lead-lock.ts`), a second lead's `run` on it is refused with the pid that holds it, and a lead
// that does not hold it takes no parent and makes no pass while another live process does. A post
// is written down before it is sent as an intent, and a job that finds an intent it cannot account
// for asks the chain whether the post landed (`reconcile`) before it posts anything. A note is only
// a note if it outlives a power cut, so a write returns once the file is on the disk and its name is
// too (`writeFileAtomic`: temp file synced, renamed, folder synced); a write that cannot be made so
// fails, and the post that waited on it is not sent.
//
// A post is sent again only when its transaction cannot land. The client tells the lead the hash of
// each transaction it signs, before it is sent (`beforeSend`), and the lead writes the hash and the
// transaction's reference block down first; the chain's word on that hash decides: executed (the
// child is the hire), failed on chain (sent once more with a new note if the contract did not refuse
// it, and the job is given up if it fails again), or not final or unknown (it may still land: a
// transaction is includable until its reference block is a day old, so no time limit says it will
// not). In that case nothing is sent, and if the parent's commit deadline nears with the part
// unresolved the job is given up and the part is not posted again, with the placeholder still the
// parent's entry. A note without a transaction is a post that was never signed, which cannot have
// been sent: it is made again. The lead also looks through the tasks made on the chain since the
// note for a child of its own, which settles a hash the node has forgotten.
//
// A call that fails and says nothing of the chain (a timeout, a 5xx, a node that blinked) is tried
// again, after a pause that doubles up to `maxBackoffMs`, until the parent's commit deadline; one
// failed poll never costs the parent. What the contract refuses (a code of its own: `E_AUTH` past
// a cap, `E_PARENT`, `E_PHASE`) is not tried again: the job gives up, and nothing more is spent.
// Giving up leaves the placeholder as the parent's entry, which the runner reveals in its time and
// which scores nothing; the sub-tasks already hired settle on their own and are paid to their
// winners. A job whose placeholder is not an entry after `entrySecs` (the runner's commit was
// refused for good, or never tried) is let go the same way: nothing can have been hired without the
// entry, so nothing is lost, and the lead is free to take another parent.
//
// The tag is no reason to spend. Anyone can post a task with it, and the lead's vault is what pays
// for the sub-tasks, so before it does anything the lead takes the parent through the gate and
// declines (answers null, commits nothing, uploads nothing, writes no job, logs one line) unless
// all of these hold:
//
// 1. its poster is on the lead's list of posters (`posters`, by default `TEAM_ACCOUNTS`);
// 2. its verifier is the Judge the lead was given (`judgeAccount`);
// 3. it pays in the token of the lead's delegate key (`token`);
// 4. what it pays after its platform fee is more than the sub-tasks cost, so that a parent the lead
//    wins leaves it in profit (the fee is the task's own `fee_bps`, taken as the contract takes it);
// 5. the lead has no other job under way, and has not had one for this parent before: it works on
//    one parent at a time;
// 6. the delegate key, as the chain shows it (`get_delegate`), is the lead's, in the token of the
//    parent, and can pay for all of the sub-tasks: each reward within `per_task_cap`, and their
//    sum within `total_cap - spent` and within the lead's vault. A job that is half paid for is
//    worse than none, so the whole plan is covered before the first part is bought;
// 7. every sub-task can be due before the parent's commit deadline, with room to spare, counting
//    the time it takes to hire the parts before it (below).
//
// Time is the other hard constraint. A sub-task's pick deadline may not be later than its parent's
// commit deadline (the contract, I12), and the lead needs time left to assemble and commit. Hiring
// takes time too (the uploads, the post, the wait for it to be final), so a part posted k-th is
// posted at about `k * hireSecs` from now. The lead hires a part only if its three windows end
// `marginSecs` (60 s) before the parent's commit deadline from that moment, by the chain's clock,
// and it checks that for every part still to hire, again, before each hire, so it never starts one
// it cannot see through. If the clock still outruns it, it gives up at once and posts no more. That
// can be after the first hire: `hireSecs` is the lead's estimate, not a promise, and hires that run
// longer than it leave the parts already bought paid for and the parent unanswered. Set it above
// what a hire takes on the network in use.

/** The tag of the parent tasks the lead takes on. No sub-task carries it. */
export const LEAD_TAG = "swarm";

/** What the placeholder commitment opens to. */
const PLACEHOLDER = "placeholder";
/** How much of the parent's commit window the lead keeps in hand after its last sub-task is due. */
const DEFAULT_MARGIN_SECS = 60;
/** What one hire is taken to cost in time, in seconds: its uploads, its post, and the wait. */
const DEFAULT_HIRE_SECS = 20;
/**
 * How long, by the chain's clock, a job waits for the placeholder to be an entry before it is let
 * go, in seconds. Until it is, nothing can be hired, so nothing has been spent.
 */
const DEFAULT_ENTRY_SECS = 300;
/** How long the lead waits between two passes over its jobs. */
const DEFAULT_POLL_MS = 2_000;
/** The first pause after a call fails, in milliseconds. It doubles for each failure in a row. */
const DEFAULT_BACKOFF_MS = 1_000;
/** The longest pause between two tries of a job that keeps failing, in milliseconds. */
const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** How many times a post whose transaction failed on chain is sent once more: one. */
const POST_RETRIES = 1;
/** The tasks of one page of a look for a lost post: the most the contract's `get_tasks` gives. */
const SCAN_PAGE = 50;
/** The pages one pass reads when it looks for a lost post, so that a long look does not hold up the rest. */
const SCAN_PAGES_PER_PASS = 10;
const NS_PER_SEC = 1_000_000_000n;
const NO_SIGNER = "this lead's client has no signer, so it cannot commit or post";

/** The four windows of a task, in seconds, under the names `task.json` gives them. */
export interface ChildWindows {
  commit_secs: number;
  reveal_secs: number;
  pick_secs: number;
  fallback_secs: number;
}

/**
 * What the lead needs of a `TenderClient`: the network and contract its drafts are bound to, the
 * account it signs as, the commit, the post, the chain's clock, its own entry and the tasks on the
 * chain (to find a post that was lost, `taskCount` and `getTasks`), what became of a transaction
 * (`txStatus`), and the delegate key's caps and the vault (`view`, `balanceOf`).
 */
export type LeadChain = Pick<
  TenderClient,
  | "network"
  | "contractId"
  | "accountId"
  | "commit"
  | "postTask"
  | "blockTimestampNs"
  | "getEntry"
  | "taskCount"
  | "getTasks"
  | "txStatus"
  | "balanceOf"
  | "view"
>;

/** What the lead needs of the API: the sub-tasks it watches, and the uploads of a poster. */
export type LeadApi = Pick<TenderApi, "getTask" | "getBlob" | "uploadBlob" | "uploadHeldout">;

export interface LeadSolverOptions {
  /**
   * The folder of the sub-tasks: one folder for each, in the format of the seeds (`task.json`,
   * `brief.json`, `criteria.json`, `heldout.json` when the criteria have a held-out part). They are
   * posted in name order, and their results are the parts, in the same order. Only the files the
   * lead posts from are read; a `solution.txt` beside them is for whoever plays the specialists.
   */
  seedsDir: string;
  /** Signs as the lead. For a swarm it signs with a delegate key, and the posts carry no deposit. */
  client: LeadChain;
  /** Signed in as the lead: the uploads are the poster's. */
  api: LeadApi;
  /**
   * The account that a sub-task's `"judge"` verifier means, and the only verifier of a parent the
   * lead takes on.
   */
  judgeAccount: string;
  /**
   * The token of the lead's delegate key, as an account id: the only token of a parent the lead
   * takes on, and the one its sub-tasks are paid in.
   */
  token: string;
  /** The public key the client signs with, as `ed25519:...`: its caps are read from the chain. */
  delegateKey: string;
  /**
   * The posters whose parents the lead takes on. Default: the accounts of `TEAM_ACCOUNTS` in `env`.
   * A lead with none is a mistake, found when it is made, and not a lead that declines everything.
   */
  posters?: readonly string[];
  /** Where `TEAM_ACCOUNTS` is read from when `posters` is not given. Default: `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Where the lead's jobs are kept: a folder of its own, the same after a restart, which only this
   * lead writes in. A job that is lost with it is a parent the lead no longer knows it has hired for.
   */
  journalDir: string;
  /**
   * Where the lead's drafts live: the same store the runner uses, so that the answer the lead
   * saves is the one the runner reveals.
   */
  state: StateStore;
  /**
   * The file system the journal is on. Default: the real one. A test gives one that can lose power.
   * The lock that `run` holds on the journal (`lead-lock.ts`) is on the real one, at `journalDir`.
   */
  fs?: JournalFs;
  /** Replaces the windows of every sub-task, for a demo that cannot wait a whole phase. */
  windows?: ChildWindows;
  /** Seconds before the parent's commit deadline by which every sub-task must be due. Default 60. */
  marginSecs?: number;
  /**
   * Seconds that one hire is taken to take, for the check that the parts fit in time. Default 20.
   * Set it above the longest a hire takes on the network in use: a hire that runs over it can end
   * the job after some parts are bought (they settle and are paid to their winners, and the parent
   * is not answered).
   */
  hireSecs?: number;
  /**
   * Seconds the lead waits for the placeholder to become an entry before it lets the job go. The
   * runner commits it at once, and a commit that is refused for good, or never tried, would
   * otherwise keep the lead from taking another parent until this one's commit deadline. Nothing
   * has been spent by then, so nothing is lost. Default 300.
   */
  entrySecs?: number;
  /** Milliseconds between two passes over the jobs, in `run`. Default 2000. */
  pollMs?: number;
  /** The first pause after a failure, in milliseconds; it doubles up to `maxBackoffMs`. Default 1000. */
  backoffMs?: number;
  /** The longest pause between two tries of a failing job, in milliseconds. Default 30000. */
  maxBackoffMs?: number;
  /** Receives the lead's lines. Default: `console.log`. */
  log?: (line: string) => void;
}

/**
 * The lead as the runner sees it (a `Solver`), and as its host runs the rest: `run` beside the
 * runner's loop, or `tick` once, for a test. Nothing is hired until one of them runs.
 */
export interface LeadSolver extends Solver {
  /**
   * One pass over every job that is under way. Passes never overlap: a second call joins the first.
   * A pass does nothing while another live process holds the journal (`run` of another lead).
   */
  tick(): Promise<void>;
  /**
   * Holds the journal (`lockJournal`: a lock file in `journalDir`, with this process's pid and start
   * time) and passes every `pollMs` until `signal` aborts. It resolves once the pass in hand is done
   * and the journal is let go. It rejects at once, having done nothing, with a `JournalLockedError`
   * when another lead holds the journal: one in another process (the message names its pid) or in
   * this one.
   */
  run(signal: AbortSignal): Promise<void>;
  /** The parents the lead has a job for that is not over. */
  active(): Promise<string[]>;
}

// ---- The sub-tasks ------------------------------------------------------------------------------

/** A document as it goes up: its canonical bytes, and the SHA-256 of them that goes on chain. */
interface Doc {
  bytes: Uint8Array;
  hash: string;
}

/** One sub-task, read and checked: its documents as they go up, and its terms. */
interface ChildSpec {
  slug: string;
  brief: Doc;
  criteria: Doc;
  heldout?: Doc;
  /** In the token's units, as text: `"2.00"`. */
  reward: string;
  windows: ChildWindows;
  maxWinners: number;
  verifier: "judge" | "poster";
}

const TERMS_KEYS = [
  "commit_secs",
  "fallback_secs",
  "max_winners",
  "pick_secs",
  "reveal_secs",
  "reward",
  "token",
  "verifier",
];

const isCount = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0;

const docOf = (value: unknown): Doc => {
  const bytes = canonicalJson(value);
  return { bytes, hash: sha256Hex(bytes) };
};

function readJson(dir: string, slug: string, name: string): unknown {
  let text: string;
  try {
    text = readFileSync(join(dir, name), "utf8");
  } catch {
    throw new Error(`${slug}/${name} cannot be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${slug}/${name} is not valid JSON`);
  }
}

interface Schema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
      };
}

function parsed<T>(schema: Schema<T>, json: unknown, where: string): T {
  const result = schema.safeParse(json);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const at =
    issue === undefined ? "the document" : issue.path.map(String).join(".") || "the document";
  throw new Error(
    `${where} does not fit its schema, first at ${at}${issue ? `: ${issue.message}` : ""}`,
  );
}

/** Reads and checks one sub-task folder. Nothing here touches the API or the chain. */
function readChild(dir: string, slug: string): ChildSpec {
  const terms = readJson(dir, slug, "task.json");
  const where = `${slug}/task.json`;
  if (typeof terms !== "object" || terms === null || Array.isArray(terms)) {
    throw new Error(`${where} is not a task's terms: it is not an object`);
  }
  const t = terms as Record<string, unknown>;
  const extra = Object.keys(t).filter((key) => !TERMS_KEYS.includes(key));
  if (extra.length > 0)
    throw new Error(`${where} has keys that are not terms: ${extra.join(", ")}`);
  if (typeof t.reward !== "string")
    throw new Error(`${where}: reward must be text, such as "2.00"`);
  if (t.verifier !== "judge" && t.verifier !== "poster") {
    throw new Error(`${where}: verifier must be "judge" or "poster"`);
  }
  if (!isCount(t.max_winners))
    throw new Error(`${where}: max_winners must be a whole number above 0`);
  const secs = (key: keyof ChildWindows): number => {
    const value = t[key];
    if (!isCount(value))
      throw new Error(`${where}: ${key} must be a whole number of seconds above 0`);
    return value;
  };

  const brief = parsed(BriefSchema, readJson(dir, slug, "brief.json"), `${slug}/brief.json`);
  const criteria = parsed(
    PublicCriteriaSchema,
    readJson(dir, slug, "criteria.json"),
    `${slug}/criteria.json`,
  );
  let heldout: Doc | undefined;
  if (criteria.has_heldout) {
    const checks = parsed(
      HeldoutSchema,
      readJson(dir, slug, "heldout.json"),
      `${slug}/heldout.json`,
    );
    if (!heldoutMatchesCriteria(criteria, checks)) {
      throw new Error(`${slug}/heldout.json is not a held-out document of kind ${criteria.kind}`);
    }
    heldout = docOf(checks);
  }
  return {
    slug,
    brief: docOf(brief),
    criteria: docOf(criteria),
    heldout,
    reward: t.reward,
    windows: {
      commit_secs: secs("commit_secs"),
      reveal_secs: secs("reveal_secs"),
      pick_secs: secs("pick_secs"),
      fallback_secs: secs("fallback_secs"),
    },
    maxWinners: t.max_winners,
    verifier: t.verifier,
  };
}

/** Every sub-task folder of `seedsDir`, in name order. Throws for a folder that does not fit. */
function readChildren(seedsDir: string): ChildSpec[] {
  const slugs = readdirSync(seedsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (slugs.length === 0)
    throw new Error(`${seedsDir} has no sub-tasks: a lead needs at least one`);
  return slugs.map((slug) => readChild(join(seedsDir, slug), slug));
}

// ---- The journal --------------------------------------------------------------------------------

/** Where a job is: hiring its parts, waiting for them, assembling the answer, or over. */
type JobStatus = "hiring" | "waiting" | "assembling" | "done" | "abandoned";

const isActive = (status: JobStatus) =>
  status === "hiring" || status === "waiting" || status === "assembling";

/** A sub-task the lead has posted, and, once it is picked, the hash of the winner's result. */
interface Hire {
  slug: string;
  /** The task id, as a u64 in decimal. */
  id: string;
  winner?: string;
}

/**
 * A transaction as the client signed it, noted before it is sent: the hash to ask the chain about,
 * and the reference block, which says until when the transaction can still be included (the chain
 * takes it while that block is less than `transaction_validity_period` blocks old, a day or so, and
 * not after the key's nonce has passed its own).
 */
interface SignedPost {
  txHash: string;
  publicKey: string;
  nonce: string;
  blockHash: string;
  blockHeight: string;
}

/**
 * A post the lead is about to send, written down first. `countBefore` is the chain's task count
 * before it, so that a post whose transaction is lost to the lead is looked for among the tasks
 * made since; `at` is the chain's clock in nanoseconds. `tx` is added once the client has signed the
 * transaction, before it is sent: an intent without it is a post that was never signed, so never
 * sent.
 */
interface Intent {
  slug: string;
  countBefore: string;
  at: string;
  tx?: SignedPost;
}

/** One parent's job, as the journal keeps it. */
interface Job {
  parent: string;
  contractId: string;
  account: string;
  /** The parent's creation time: with the contract, it says whose task this is. */
  parentCreatedAt: string;
  /** In nanoseconds. */
  commitDeadline: string;
  /** The chain's clock when the job began, in nanoseconds. Jobs from before it was kept have none. */
  beganAt?: string;
  token: string;
  status: JobStatus;
  /** In the order of the pack: `hires[i]` is for the i-th sub-task folder. */
  hires: Hire[];
  intent?: Intent;
  /** The part whose post failed on chain, and how many times. */
  failedPosts?: { slug: string; count: number };
  /** Why the job was given up. */
  reason?: string;
  /**
   * A post whose transaction was signed and never settled: it may still land. Kept when the job is
   * given up, so that a person can look the transaction up.
   */
  unresolved?: Intent;
}

const isText = (value: unknown): value is string => typeof value === "string";

function isHire(value: unknown): value is Hire {
  if (typeof value !== "object" || value === null) return false;
  const h = value as Record<string, unknown>;
  return (
    isText(h.slug) &&
    isText(h.id) &&
    U64StringSchema.safeParse(h.id).success &&
    (h.winner === undefined || isText(h.winner))
  );
}

function isSignedPost(value: unknown): value is SignedPost {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    isText(t.txHash) &&
    isText(t.publicKey) &&
    isText(t.nonce) &&
    isText(t.blockHash) &&
    isText(t.blockHeight)
  );
}

function isIntent(value: unknown): value is Intent {
  if (typeof value !== "object" || value === null) return false;
  const i = value as Record<string, unknown>;
  return (
    isText(i.slug) &&
    isText(i.countBefore) &&
    isText(i.at) &&
    (i.tx === undefined || isSignedPost(i.tx))
  );
}

function isFailedPosts(value: unknown): value is { slug: string; count: number } {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return isText(f.slug) && Number.isInteger(f.count) && (f.count as number) > 0;
}

/** Reads a job from the text of its file. The error names the file and never quotes it. */
function parseJob(text: string, file: string): Job {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`the lead's job file ${file} is corrupt: it is not valid JSON`);
  }
  const j = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
  const statuses: unknown[] = ["hiring", "waiting", "assembling", "done", "abandoned"];
  const ok =
    isText(j.parent) &&
    U64StringSchema.safeParse(j.parent).success &&
    isText(j.contractId) &&
    isText(j.account) &&
    isText(j.parentCreatedAt) &&
    isText(j.commitDeadline) &&
    /^\d+$/.test(j.commitDeadline) &&
    (j.beganAt === undefined || (isText(j.beganAt) && /^\d+$/.test(j.beganAt))) &&
    isText(j.token) &&
    statuses.includes(j.status) &&
    Array.isArray(j.hires) &&
    j.hires.every(isHire) &&
    (j.intent === undefined || isIntent(j.intent)) &&
    (j.failedPosts === undefined || isFailedPosts(j.failedPosts)) &&
    (j.unresolved === undefined || isIntent(j.unresolved)) &&
    (j.reason === undefined || isText(j.reason));
  if (!ok) throw new Error(`the lead's job file ${file} is corrupt: it is not a job`);
  return json as Job;
}

/** An open file, as far as the journal uses one. */
export interface JournalFile {
  writeFile(text: string, encoding: "utf8"): Promise<void>;
  /** Makes what was written, or for a directory what was renamed in it, survive a power cut. */
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * What the journal needs of a file system. Node's own (`node:fs/promises`) is the default; a test
 * replaces it with one that can lose power, to show what a power cut leaves behind.
 */
export interface JournalFs {
  /** Gives the first directory it made, or undefined if the directory was there already. */
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<string | undefined>;
  open(path: string, flags: string, mode?: number): Promise<JournalFile>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readdir(path: string): Promise<string[]>;
}

const nodeFs: JournalFs = { mkdir, open, rename, rm, readFile, readdir };

/**
 * Makes the names in directory `path` (what was created, renamed or removed in it) survive a power
 * cut: a rename is in the directory, and the directory is on the disk only once it is synced. A
 * failure to sync is the write's failure, not something to hide: a note the disk may not have must
 * not be taken for a note (the lead sends its post on the strength of it). Only Windows, which
 * cannot open a directory, is let off.
 */
async function syncDirectory(fs: JournalFs, path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Makes `dir` and what is above it that is missing, and puts each new folder's name on the disk. */
async function ensureDirectory(fs: JournalFs, dir: string): Promise<void> {
  const first = await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (first === undefined) return;
  // `first` is the topmost folder made. Its name is in its parent, and so on down to `dir`.
  for (let made = dir; ; made = dirname(made)) {
    await syncDirectory(fs, dirname(made));
    if (made === first || dirname(made) === made) return;
  }
}

/**
 * Writes `text` to `file` so that a reader, or a crash, finds the old file or the new one, and so
 * that once it returns the new one is on the disk and stays there through a power cut. In order:
 * the text goes to a temp file in the same directory, which is synced; the temp file is renamed
 * over `file`; the directory is synced, which is what makes the rename last. A cut before the last
 * step finds the old file (or none), a cut after it the new one; the half of a file is not a state.
 */
export async function writeFileAtomic(fs: JournalFs, file: string, text: string): Promise<void> {
  const dir = dirname(file);
  await ensureDirectory(fs, dir);
  const temp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectory(fs, dir);
}

// ---- The lead -----------------------------------------------------------------------------------

/** What a log line says of an error: its name and its code, never its message (it can quote a URL). */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = codeOf(error);
  return code === undefined ? error.name : `${error.name} ${code}`;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code) ? code : undefined;
}

/**
 * Whether the contract refused a call, as opposed to a call that failed in a way that says nothing
 * of the chain. A refusal has a code of the contract's own (`E_AUTH`, `E_PARENT`, `E_PHASE`...), and
 * a second try meets it again. `E_TIMEOUT` is the client giving up on the node, and `E_UNKNOWN` a
 * failure it could not name: either may have landed, and neither is a refusal.
 */
function refused(error: unknown): boolean {
  const code = codeOf(error);
  return code?.startsWith("E_") === true && code !== "E_TIMEOUT" && code !== "E_UNKNOWN";
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** A winner's result as the part it is: the JSON it holds, or else the text itself. */
function partOf(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The posters a lead works for: the given ones, else `TEAM_ACCOUNTS`. Throws if there are none. */
function postersOf(o: LeadSolverOptions): readonly string[] {
  const listed =
    o.posters ??
    (o.env ?? process.env).TEAM_ACCOUNTS?.split(",")
      .map((account) => account.trim())
      .filter((account) => account !== "") ??
    [];
  if (listed.length === 0) {
    throw new Error(
      "the lead has no posters to work for: pass `posters`, or set TEAM_ACCOUNTS to account ids separated by commas",
    );
  }
  const bad = listed.find((account) => !AccountIdSchema.safeParse(account).success);
  if (bad !== undefined) {
    throw new Error(`the lead's posters must be account ids; ${JSON.stringify(bad)} is not one`);
  }
  return listed;
}

/** Throws unless `value` is a whole number of at least `min`. */
function checkCount(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} must be a whole number, at least ${min}`);
  }
}

export function createLeadSolver(o: LeadSolverOptions): LeadSolver {
  const { client, api, state } = o;
  const fs = o.fs ?? nodeFs;
  const log = (line: string) => (o.log ?? console.log)(`lead: ${line}`);
  const marginSecs = o.marginSecs ?? DEFAULT_MARGIN_SECS;
  const hireSecs = o.hireSecs ?? DEFAULT_HIRE_SECS;
  const entrySecs = o.entrySecs ?? DEFAULT_ENTRY_SECS;
  const pollMs = o.pollMs ?? DEFAULT_POLL_MS;
  const backoffMs = o.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxBackoffMs = o.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  checkCount("marginSecs", marginSecs, 0);
  checkCount("hireSecs", hireSecs, 0);
  checkCount("entrySecs", entrySecs, 1);
  checkCount("pollMs", pollMs, 1);
  checkCount("backoffMs", backoffMs, 1);
  checkCount("maxBackoffMs", maxBackoffMs, backoffMs);
  if (o.journalDir === "") throw new Error("the lead's journal directory must not be empty");
  if (o.delegateKey === "") throw new Error("the lead needs the public key of its delegate key");
  // Read now, so a pack that is wrong fails when the lead is made and not on the first parent.
  const specs = readChildren(o.seedsDir);
  const posters = postersOf(o);
  // Resolved now, so that a later `chdir` cannot move the journal.
  const journalDir = resolve(o.journalDir);
  /** Where each look for a lost post has got to, so that a pass goes on where the last stopped. */
  const scanned = new Map<string, bigint>();

  /** The windows a sub-task is posted with. */
  const windowsOf = (spec: ChildSpec): ChildWindows => o.windows ?? spec.windows;
  const settleSecs = (w: ChildWindows) => w.commit_secs + w.reveal_secs + w.pick_secs;

  // ---- The journal

  const fileOf = (parent: string) => join(journalDir, `${parent}.json`);

  async function readJob(parent: string): Promise<Job | null> {
    const file = fileOf(parent);
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return null;
      throw error;
    }
    const job = parseJob(text, file);
    if (job.parent !== parent) {
      throw new Error(`the lead's job file ${file} is corrupt: it holds task ${job.parent}`);
    }
    return job;
  }

  /** Every job of the journal, by parent. A file that is not a job fails the read, and the caller. */
  async function listJobs(): Promise<Job[]> {
    let names: string[];
    try {
      names = await fs.readdir(journalDir);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return [];
      throw error;
    }
    const parents = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => U64StringSchema.safeParse(id).success)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const jobs: Job[] = [];
    for (const parent of parents) {
      const job = await readJob(parent);
      if (job !== null) jobs.push(job);
    }
    return jobs;
  }

  async function save(job: Job): Promise<Job> {
    await writeFileAtomic(fs, fileOf(job.parent), `${JSON.stringify(job, null, 2)}\n`);
    return job;
  }

  /** The jobs that are the lead's own, on this contract, and not over. */
  const ownActive = (jobs: Job[]) =>
    jobs.filter(
      (job) =>
        isActive(job.status) &&
        job.contractId === client.contractId &&
        job.account === client.accountId,
    );

  // ---- The time

  /**
   * Whether every part in `todo` can still be hired and be due `marginSecs` before the parent's
   * commit deadline `deadline`, if the clock now reads `now`. The part hired k-th (from 1) is
   * posted about `k * hireSecs` from now, and settles `commit + reveal + pick` after that. Gives
   * why not, or null.
   */
  function fits(now: bigint, deadline: bigint, todo: readonly ChildSpec[]): string | null {
    const left = (deadline - now) / NS_PER_SEC;
    for (const [k, spec] of todo.entries()) {
      const hiring = BigInt((k + 1) * hireSecs);
      const needs = BigInt(settleSecs(windowsOf(spec)));
      const spare = left - hiring - BigInt(marginSecs);
      if (spare < needs) {
        const room = left - hiring;
        return (
          `part ${spec.slug} needs ${needs} s from its post to its pick deadline once ${hiring} s of hiring ` +
          `are done, and the parent's commit deadline leaves ${room < 0n ? 0n : room} s, less a ` +
          `${marginSecs} s margin, so it cannot be hired in time`
        );
      }
    }
    return null;
  }

  // ---- The gate

  /**
   * Why the lead will not take `ctx` on, or null if it will. The first check that fails speaks, so
   * a refusal is one line. The checks that need only the task come first; the ones that read the
   * journal or the chain follow, and the clock comes before the checks that use it.
   */
  async function declines(ctx: TaskContext): Promise<string | null> {
    const { poster, verifier, token, reward, fee_bps: feeBps } = ctx.task;
    if (!posters.includes(poster)) return `its poster ${poster} is not one the lead works for`;
    if (verifier !== o.judgeAccount) {
      return `its verifier ${verifier} is not the Judge, ${o.judgeAccount}`;
    }
    if (token !== o.token) {
      return `it pays in ${token}, and the lead's delegate key spends ${o.token}`;
    }
    const meta = tokenMeta(token, client.network);
    if (meta.symbol === token) return `the decimals of ${token} are unknown on ${client.network}`;
    const show = (amount: bigint) => `${formatTokenAmount(amount, meta.decimals)} ${meta.symbol}`;

    // The contract takes `reward * fee_bps / 10_000`, rounded down, and the winner gets the rest.
    const gross = BigInt(reward);
    const payout = gross - (gross * BigInt(feeBps)) / 10_000n;
    const rewards = specs.map((spec) => parseTokenAmount(spec.reward, meta.decimals));
    const cost = rewards.reduce((sum, one) => sum + one, 0n);
    if (payout <= cost) {
      return (
        `it pays ${show(payout)} after its ${feeBps / 100}% fee, and its ${specs.length} sub-tasks ` +
        `cost ${show(cost)}, which leaves the lead no profit`
      );
    }

    const now = await client.blockTimestampNs();
    const jobs = await listJobs();
    const busy = ownActive(jobs).find((job) => BigInt(job.commitDeadline) > now);
    if (busy !== undefined) {
      return `the lead is working on task ${busy.parent} and takes one parent at a time`;
    }
    const before = jobs.find((job) => job.parent === ctx.task.id);
    if (
      before !== undefined &&
      before.contractId === client.contractId &&
      before.parentCreatedAt === ctx.task.created_at
    ) {
      return `the lead has had a job for it already (${before.status})`;
    }

    // The whole plan is covered, or none of it is bought.
    const account = client.accountId;
    if (account === undefined) throw new Error(NO_SIGNER);
    const raw = await client.view<unknown>(client.contractId, "get_delegate", {
      account_id: account,
      public_key: o.delegateKey,
    });
    if (raw === null || raw === undefined) {
      return `the lead's key ${o.delegateKey} is not a delegate key of ${account}`;
    }
    const caps = DelegateViewSchema.parse(raw);
    if (caps.token !== token) {
      return `the lead's delegate key spends ${caps.token}, and the parent pays in ${token}`;
    }
    const perTask = BigInt(caps.per_task_cap);
    const over = rewards.findIndex((one) => one > perTask);
    if (over >= 0) {
      return (
        `part ${specs[over]?.slug} costs ${show(rewards[over] ?? 0n)}, above the ${show(perTask)} ` +
        `a task may cost the lead's delegate key`
      );
    }
    const remaining = BigInt(caps.total_cap) - BigInt(caps.spent);
    if (cost > remaining) {
      return (
        `the sub-tasks cost ${show(cost)}, and the lead's delegate key has ${show(remaining < 0n ? 0n : remaining)} ` +
        `left of its total cap`
      );
    }
    const vault = await client.balanceOf(account, token);
    if (cost > vault) {
      return `the sub-tasks cost ${show(cost)}, and the lead's vault holds ${show(vault)}`;
    }

    return fits(now, BigInt(ctx.task.commit_deadline), specs);
  }

  // ---- The job: hiring

  /** What the journal keeps of a signed transaction. */
  const noteOf = (tx: SignedTx): SignedPost => ({
    txHash: tx.txHash,
    publicKey: tx.publicKey,
    nonce: tx.nonce.toString(),
    blockHash: tx.blockHash,
    blockHeight: tx.blockHeight.toString(),
  });

  /** Uploads a sub-task's documents and posts it under the job's parent. Gives the job with the hire. */
  async function hire(start: Job, spec: ChildSpec): Promise<Job> {
    const upload = async (kind: "brief" | "criteria", doc: Doc): Promise<string> => {
      const stored = await api.uploadBlob({
        kind,
        contentType: "application/json",
        bytes: doc.bytes,
      });
      // The post pins the hash on chain: a blob stored under another one could not be judged.
      if (stored.sha256 !== doc.hash) {
        throw new Error(`the API stored the ${kind} of ${spec.slug} under another hash`);
      }
      return stored.uri;
    };
    const briefUri = await upload("brief", spec.brief);
    await upload("criteria", spec.criteria);
    if (spec.heldout !== undefined) await api.uploadHeldout(spec.heldout.hash, spec.heldout.bytes);

    const meta = tokenMeta(start.token, client.network);
    if (meta.symbol === start.token) {
      throw new Error(`the decimals of ${start.token} are unknown on ${client.network}`);
    }
    // Written down before it is signed, and again, with the transaction's hash and reference block,
    // after it is signed and before it is sent (the client's `beforeSend`, which can stop the send
    // by throwing). A restart that finds the note can then ask the chain what became of that very
    // transaction, and never posts the part twice. A note without a transaction is a post that was
    // never signed.
    const intent: Intent = {
      slug: spec.slug,
      countBefore: (await client.taskCount()).toString(),
      at: (await client.blockTimestampNs()).toString(),
    };
    await save({ ...start, intent });

    const w = windowsOf(spec);
    const posted = await client.postTask(
      {
        token: start.token,
        reward: parseTokenAmount(spec.reward, meta.decimals),
        briefUri,
        briefHash: spec.brief.hash,
        criteriaHash: spec.criteria.hash,
        heldoutCommitment: spec.heldout?.hash,
        verifier: spec.verifier === "judge" ? o.judgeAccount : start.account,
        commitSecs: w.commit_secs,
        revealSecs: w.reveal_secs,
        pickSecs: w.pick_secs,
        fallbackSecs: w.fallback_secs,
        maxWinners: spec.maxWinners,
        parent: BigInt(start.parent),
      },
      { delegate: true },
      {
        beforeSend: async (tx) => {
          await save({ ...start, intent: { ...intent, tx: noteOf(tx) } });
        },
      },
    );
    log(`hired for part ${spec.slug}: task ${posted.taskId}`);
    return save({
      ...start,
      intent: undefined,
      failedPosts: undefined,
      hires: [...start.hires, { slug: spec.slug, id: posted.taskId.toString() }],
    });
  }

  /**
   * Settles an intent the job holds: finds out what became of the post, and sends it again only if
   * it cannot have landed and cannot land. Gives the job as it is after, or null if the post is
   * unresolved: it may still land, and nothing is sent.
   *
   * Time is no evidence. A transaction stays includable until its reference block is a day old
   * (`SignedPost`), so a client's timeout, or any wait after it, says nothing of whether it will
   * land. What is evidence is the chain's word on the very transaction that was signed, which the
   * intent names by its hash:
   *
   * - executed: the post landed. The new task's id is in its outcome, and that is the hire.
   * - failed on chain: nothing it did is kept. A refusal by the contract (`E_AUTH`, `E_PARENT`...)
   *   would be met again, and ends the job; any other failure (gas, a key) is sent once more,
   *   with a new intent, and ends the job if it fails again (`POST_RETRIES`).
   * - unknown or pending: it may still land. Nothing is sent. The job waits, and is given up if
   *   the parent's commit deadline comes near before the post settles (`hiring`).
   *
   * Besides, the lead looks through the tasks made on the chain since the note for a child of its
   * own under the parent with the part's brief, which covers a node that no longer remembers the
   * transaction (a node keeps a few days) or an answer that could not be read. The chain is the
   * authority, read as final blocks (the API's index trails it); the look goes through every task,
   * a few pages a pass, and goes on where it stopped, and a look that is not over proves nothing.
   *
   * An intent without a transaction was never signed, so never sent: once the look finds nothing
   * it is cleared, and the part is posted at once.
   */
  async function reconcile(job: Job): Promise<Job | null> {
    const intent = job.intent;
    const spec = specs.find((one) => one.slug === intent?.slug);
    if (intent === undefined || spec === undefined) return save({ ...job, intent: undefined });
    const hired = (id: string, how: string): Promise<Job> => {
      scanned.delete(`${job.parent}/${intent.slug}/${intent.countBefore}`);
      log(`part ${spec.slug} was posted already, as task ${id} (${how})`);
      return save({
        ...job,
        intent: undefined,
        failedPosts: undefined,
        hires: [...job.hires, { slug: spec.slug, id }],
      });
    };

    if (intent.tx !== undefined) {
      const status = await client.txStatus(intent.tx.txHash, job.account);
      if (status.kind === "executed") {
        const id = U64StringSchema.parse(status.result.returnValue);
        return hired(id, `transaction ${intent.tx.txHash}`);
      }
      if (status.kind === "failed") {
        if (refused(status.error)) {
          return abandon(
            { ...job, intent: undefined },
            `the contract refused part ${spec.slug} (${describe(status.error)}, transaction ${intent.tx.txHash})`,
          );
        }
        const count = (job.failedPosts?.slug === spec.slug ? job.failedPosts.count : 0) + 1;
        if (count > POST_RETRIES) {
          return abandon(
            { ...job, intent: undefined },
            `the post for part ${spec.slug} failed on chain twice (${describe(status.error)}, transaction ${intent.tx.txHash})`,
          );
        }
        log(
          `the post for part ${spec.slug} failed on chain (${describe(status.error)}); it will be sent once more`,
        );
        return save({ ...job, intent: undefined, failedPosts: { slug: spec.slug, count } });
      }
    }

    const count = await client.taskCount();
    const key = `${job.parent}/${intent.slug}/${intent.countBefore}`;
    let next = scanned.get(key) ?? BigInt(intent.countBefore) + 1n;
    for (let pages = 0; next <= count && pages < SCAN_PAGES_PER_PASS; pages++) {
      const room = count - next + 1n;
      const page = await client.getTasks(next, Number(room < BigInt(SCAN_PAGE) ? room : SCAN_PAGE));
      const last = page.at(-1);
      // An empty page, or one that does not move on, is a look that cannot be finished.
      if (last === undefined || BigInt(last.id) < next) break;
      const found = page.find(
        (task) =>
          task.poster === job.account &&
          task.parent === job.parent &&
          task.brief_hash === spec.brief.hash,
      );
      if (found !== undefined) return hired(found.id, "found on the chain");
      next = BigInt(last.id) + 1n;
    }
    scanned.set(key, next);
    if (next <= count) return null;
    if (intent.tx !== undefined) return null;
    scanned.delete(key);
    log(`the post for part ${spec.slug} was never signed, so never sent; it will be made again`);
    return save({ ...job, intent: undefined });
  }

  async function hiring(start: Job): Promise<Job> {
    let job = start;
    const deadline = BigInt(job.commitDeadline);
    if (job.intent !== undefined) {
      const settled = await reconcile(job);
      if (settled === null) {
        // The post may still land, so nothing is sent. If the parent's deadline comes near with the
        // part unresolved, the job is given up, and the part is not posted again.
        const why = fits(await client.blockTimestampNs(), deadline, specs.slice(job.hires.length));
        if (why !== null) {
          return abandon(job, `the post for part ${job.intent.slug} is unresolved and ${why}`);
        }
        return job;
      }
      if (settled.status !== "hiring") return settled;
      job = settled;
    }
    // A sub-task can name the parent only if the lead has an entry on it: the placeholder.
    const entry = await client.getEntry(BigInt(job.parent), job.account);
    while (job.hires.length < specs.length) {
      const todo = specs.slice(job.hires.length);
      const now = await client.blockTimestampNs();
      const why = fits(now, deadline, todo);
      if (why !== null) return abandon(job, why);
      const next = todo[0];
      if (next === undefined) break;
      // Time permitting, the placeholder is on its way: the runner commits it, with its retries.
      // If it is not an entry after `entrySecs` nothing has been hired (a hire needs the entry), so
      // the job is let go and does not keep the lead from the next parent until the deadline.
      if (entry === null) {
        const waited = job.beganAt === undefined ? 0n : now - BigInt(job.beganAt);
        if (job.hires.length === 0 && waited >= BigInt(entrySecs) * NS_PER_SEC) {
          return abandon(
            job,
            `the placeholder was not an entry ${entrySecs} s after the job began`,
          );
        }
        return job;
      }
      try {
        job = await hire(job, next);
      } catch (error) {
        if (refused(error)) {
          return abandon(
            { ...job, intent: undefined },
            `the contract refused part ${next.slug} (${describe(error)})`,
          );
        }
        throw error;
      }
    }
    return save({ ...job, status: "waiting" });
  }

  // ---- The job: waiting

  /**
   * Looks at a hired sub-task once. Gives "voided" if it was voided, the hash of the winner's result
   * if it is picked and the result is served, and null if there is nothing to take yet.
   */
  async function look(hired: Hire): Promise<string | "voided" | null> {
    const found: TaskDetailResponse | null = await api.getTask(BigInt(hired.id));
    // The index trails the chain: a task posted a moment ago may not be there yet.
    const outcome = found?.task.outcome;
    if (found === null || outcome === null || outcome === undefined) return null;
    if (outcome.kind === "voided") return "voided";
    const winner = outcome.winners[0]?.account;
    const hash = found.entries.find((one) => one.account === winner)?.content_hash ?? null;
    if (hash === null) return null;
    // The API serves a result from its task's reveal deadline, and a pick comes after it.
    return (await api.getBlob(hash)) === null ? null : hash;
  }

  async function waiting(start: Job): Promise<Job> {
    let job = start;
    // A call that fails is tried again; the others are still looked at, and the deadline still counts.
    let trouble: unknown;
    for (const [index, hired] of start.hires.entries()) {
      if (hired.winner !== undefined) continue;
      let seen: string | null;
      try {
        seen = await look(hired);
      } catch (error) {
        trouble ??= error;
        continue;
      }
      if (seen === "voided") return abandon(job, `task ${hired.id} (${hired.slug}) was voided`);
      if (seen === null) continue;
      log(`task ${hired.id} (${hired.slug}) is picked`);
      job = await save({
        ...job,
        hires: job.hires.map((one, at) => (at === index ? { ...one, winner: seen } : one)),
      });
    }
    if (job.hires.every((one) => one.winner !== undefined)) {
      return save({ ...job, status: "assembling" });
    }
    if ((await client.blockTimestampNs()) >= BigInt(job.commitDeadline)) {
      return abandon(job, "the sub-tasks had not settled when its commit deadline came");
    }
    if (trouble !== undefined) throw trouble;
    return job;
  }

  // ---- The job: assembling

  /** The draft for `bytes`: the one the state holds if it is already for them, else a fresh one. */
  async function draftFor(job: Job, bytes: Uint8Array): Promise<Draft> {
    const contentHash = sha256Hex(bytes);
    // A retry after a commit that failed must not take a new salt: the saved draft may be on chain.
    const saved = await state.getDraft(job.parent);
    if (saved !== null && saved.contentHash === contentHash && isDraftOf(saved, job.account)) {
      return saved;
    }
    const salt = randomSalt();
    const draft: Draft = {
      taskId: job.parent,
      contentBase64: Buffer.from(bytes).toString("base64"),
      contentHash,
      salt,
      commitment: computeCommitment(BigInt(job.parent), job.account, contentHash, salt),
      contractId: job.contractId,
      taskCreatedAt: job.parentCreatedAt,
    };
    // On disk before the commit leaves, as the runner does: a crash after it leaves the salt behind,
    // and the runner, finding a draft with no commit on the chain, sends it.
    await state.saveDraft(draft);
    return draft;
  }

  async function assembling(job: Job): Promise<void> {
    const parts: unknown[] = [];
    for (const hired of job.hires) {
      const bytes = await api.getBlob(hired.winner ?? "");
      if (bytes === null) throw new Error(`the result of task ${hired.id} is not served yet`);
      parts.push(partOf(bytes));
    }
    const bytes = new TextEncoder().encode(JSON.stringify({ parts }));
    if ((await client.blockTimestampNs()) >= BigInt(job.commitDeadline)) {
      await abandon(job, "the parent's commit deadline came before the answer was ready");
      return;
    }
    log(`assembled ${parts.length} parts for task ${job.parent}`);
    const draft = await draftFor(job, bytes);
    try {
      await client.commit(BigInt(job.parent), draft.commitment);
    } catch (error) {
      if (refused(error)) {
        await abandon(job, `the contract refused the answer's commit (${describe(error)})`);
        return;
      }
      throw error;
    }
    await state.saveDraft({ ...draft, committedAt: new Date().toISOString() });
    await save({ ...job, status: "done" });
    log(`committed the answer to task ${job.parent}`);
  }

  // ---- The job: giving up

  /**
   * Ends the job without an answer. Nothing more is hired. The placeholder stays the parent's entry
   * and its draft, and the runner reveals it in its time, where it scores nothing; the sub-tasks
   * already hired settle on their own and are paid to their winners.
   */
  async function abandon(job: Job, why: string): Promise<Job> {
    const ended = await save({
      ...job,
      intent: undefined,
      unresolved: job.intent,
      status: "abandoned",
      reason: why,
    });
    const paid = job.hires.length;
    const spent =
      paid === 0 ? "nothing was spent" : `${paid} sub-task(s) are paid for and settle on their own`;
    const open =
      job.intent?.tx === undefined
        ? ""
        : `; the post for part ${job.intent.slug} (transaction ${job.intent.tx.txHash}) may still land and is not sent again`;
    log(`giving up on task ${job.parent}: ${why}; no more is spent (${spent})${open}`);
    return ended;
  }

  // ---- The passes

  /** How many times in a row each job has failed, and when it may be tried again. */
  const failing = new Map<string, { fails: number; retryAt: number }>();

  async function advance(start: Job): Promise<void> {
    let job = start;
    if (job.status === "hiring") job = await hiring(job);
    if (job.status === "waiting") job = await waiting(job);
    if (job.status === "assembling") await assembling(job);
  }

  /** Whether the journal is another live process's, said once each time it becomes so. */
  let heldBy: number | null | undefined;
  function heldElsewhere(): { pid: number | null } | null {
    const other = journalHeldElsewhere(journalDir);
    if (other !== null && other.pid !== heldBy) {
      const who = other.pid === null ? "a lock file that names no process" : `process ${other.pid}`;
      log(
        `WARN another lead, ${who}, holds the journal ${journalDir}: this lead does nothing with it until that one stops`,
      );
    }
    heldBy = other === null ? undefined : other.pid;
    return other;
  }

  async function pass(): Promise<void> {
    // Two leads on one journal could both hire. One that runs holds the lock, and this is how a lead
    // driven a pass at a time (`tick`) keeps out of its way.
    if (heldElsewhere() !== null) return;
    let jobs: Job[];
    try {
      jobs = await listJobs();
    } catch (error) {
      log(`ERROR the jobs cannot be read (${describe(error)})`);
      return;
    }
    for (const job of ownActive(jobs)) {
      const wait = failing.get(job.parent);
      if (wait !== undefined && Date.now() < wait.retryAt) continue;
      try {
        await advance(job);
        failing.delete(job.parent);
      } catch (error) {
        const fails = (wait?.fails ?? 0) + 1;
        const delay = Math.min(maxBackoffMs, backoffMs * 2 ** Math.min(fails - 1, 30));
        failing.set(job.parent, { fails, retryAt: Date.now() + delay });
        log(
          `WARN task ${job.parent} (${job.status}) failed (${describe(error)}), trying again in ${delay} ms`,
        );
      }
    }
  }

  let running: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    running ??= pass().finally(() => {
      running = null;
    });
    return running;
  };

  // ---- The solver

  /** Starts the job for a parent the lead has taken on. A job of another life of the chain is set aside. */
  async function begin(ctx: TaskContext, account: string): Promise<void> {
    const old = await readJob(ctx.task.id);
    if (old !== null) {
      await fs.rename(
        fileOf(ctx.task.id),
        join(journalDir, `${ctx.task.id}.orphaned-${Date.now()}.json`),
      );
      await syncDirectory(fs, journalDir);
    }
    await save({
      parent: ctx.task.id,
      contractId: client.contractId,
      account,
      parentCreatedAt: ctx.task.created_at,
      commitDeadline: ctx.task.commit_deadline,
      beganAt: (await client.blockTimestampNs()).toString(),
      token: ctx.task.token,
      status: "hiring",
      hires: [],
    });
  }

  return {
    name: "lead",
    // Its answer is worked out from what other agents hand in, not read from a file.
    scripted: false,
    tick,
    async run(signal) {
      // Before the first pass, and before anything is awaited: a lead that cannot hold the journal
      // does nothing at all.
      const lock = lockJournal(journalDir, log);
      try {
        while (!signal.aborted) {
          await tick().catch((error: unknown) => log(`ERROR a pass failed (${describe(error)})`));
          await sleep(pollMs, signal);
        }
        // A pass that a direct `tick` started is over before the journal is let go.
        await running?.catch(() => undefined);
      } finally {
        lock.release();
      }
    },
    async active() {
      return ownActive(await listJobs()).map((job) => job.parent);
    },
    async solve(ctx) {
      if (!ctx.brief.tags.includes(LEAD_TAG)) return null;
      try {
        const account = client.accountId;
        if (account === undefined) throw new Error(NO_SIGNER);
        // A job begun here would be the other lead's to run as well.
        const other = journalHeldElsewhere(journalDir);
        if (other !== null) {
          const who =
            other.pid === null ? "a lock file that names no process" : `process ${other.pid}`;
          log(
            `declining task ${ctx.task.id}: another lead, ${who}, holds the journal ${journalDir}`,
          );
          return null;
        }
        const declined = await declines(ctx);
        if (declined !== null) {
          log(`declining task ${ctx.task.id}: ${declined}`);
          return null;
        }
        await begin(ctx, account);
        log(
          `taking on task ${ctx.task.id}: it will hire ${specs.length} sub-tasks once the placeholder is an entry`,
        );
        // The placeholder: the runner commits it as the lead's answer, which gives the entry.
        return new TextEncoder().encode(PLACEHOLDER);
      } catch (error) {
        log(`ERROR task ${ctx.task.id} failed (${describe(error)})`);
        return null;
      }
    },
  };
}
