import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { TenderClient } from "@tender/client";
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
// hires a part twice. A post is written down before it is sent as an intent, and a job that finds
// an intent it cannot account for asks the chain whether the post landed (`reconcile`) before it
// posts anything.
//
// A call that fails and says nothing of the chain (a timeout, a 5xx, a node that blinked) is tried
// again, after a pause that doubles up to `maxBackoffMs`, until the parent's commit deadline; one
// failed poll never costs the parent. What the contract refuses (a code of its own: `E_AUTH` past
// a cap, `E_PARENT`, `E_PHASE`) is not tried again: the job gives up, and nothing more is spent.
// Giving up leaves the placeholder as the parent's entry, which the runner reveals in its time and
// which scores nothing; the sub-tasks already hired settle on their own and are paid to their
// winners.
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
// it cannot see through. If the clock still outruns it, it gives up at once and posts no more.

/** The tag of the parent tasks the lead takes on. No sub-task carries it. */
export const LEAD_TAG = "swarm";

/** What the placeholder commitment opens to. */
const PLACEHOLDER = "placeholder";
/** How much of the parent's commit window the lead keeps in hand after its last sub-task is due. */
const DEFAULT_MARGIN_SECS = 60;
/** What one hire is taken to cost in time, in seconds: its uploads, its post, and the wait. */
const DEFAULT_HIRE_SECS = 20;
/** How long the lead waits between two passes over its jobs. */
const DEFAULT_POLL_MS = 2_000;
/** The first pause after a call fails, in milliseconds. It doubles for each failure in a row. */
const DEFAULT_BACKOFF_MS = 1_000;
/** The longest pause between two tries of a job that keeps failing, in milliseconds. */
const DEFAULT_MAX_BACKOFF_MS = 30_000;
/**
 * How long, by the chain's clock, a post the lead cannot find on the chain is given before it is
 * taken for lost, in seconds: a transaction that was sent is in a block within seconds or never.
 */
const RECONCILE_SECS = 60;
/** The most tasks a lookup for a lost post reads. */
const RECONCILE_SCAN = 200;
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
 * account it signs as, the commit, the post, the chain's clock, its own entry and the tasks it has
 * posted (to find a post that was lost), and the delegate key's caps and the vault (`view`,
 * `balanceOf`).
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
  | "getTask"
  | "balanceOf"
  | "view"
>;

/** What the lead needs of the API: the sub-tasks it watches, and the uploads of a poster. */
export type LeadApi = Pick<TenderApi, "getTask" | "getBlob" | "uploadBlob" | "uploadHeldout">;

export interface LeadSolverOptions {
  /**
   * The folder of the sub-tasks: one folder for each, in the format of the seeds (`task.json`,
   * `brief.json`, `criteria.json`). They are posted in name order, and their results are the
   * parts, in the same order. Only the files the lead posts from are read; a `solution.txt` beside
   * them is for whoever plays the specialists.
   */
  seedsDir: string;
  /**
   * Where the held-out checks of the sub-tasks are: `<heldoutDir>/<name>/heldout.json` for each
   * sub-task whose criteria have a held-out part. They are secret until a task is judged, so they
   * are kept outside the folders of `seedsDir`, which are public, and a sub-task whose file is
   * not there is a mistake found when the solver is made: the lead never posts a task without its
   * checks.
   */
  heldoutDir: string;
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
  /** Replaces the windows of every sub-task, for a demo that cannot wait a whole phase. */
  windows?: ChildWindows;
  /** Seconds before the parent's commit deadline by which every sub-task must be due. Default 60. */
  marginSecs?: number;
  /** Seconds that one hire is taken to take, for the check that the parts fit in time. Default 20. */
  hireSecs?: number;
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
  /** One pass over every job that is under way. Passes never overlap: a second call joins the first. */
  tick(): Promise<void>;
  /** Passes every `pollMs` until `signal` aborts. It resolves once the pass in hand is done. */
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
function readChild(dir: string, heldoutDir: string, slug: string): ChildSpec {
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
    if (!existsSync(join(heldoutDir, slug, "heldout.json"))) {
      throw new Error(
        `held-out for ${slug} not found in ${heldoutDir}; set TENDER_SEEDS_PRIVATE_DIR`,
      );
    }
    const checks = parsed(
      HeldoutSchema,
      readJson(join(heldoutDir, slug), slug, "heldout.json"),
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
function readChildren(seedsDir: string, heldoutDir: string): ChildSpec[] {
  const slugs = readdirSync(seedsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (slugs.length === 0)
    throw new Error(`${seedsDir} has no sub-tasks: a lead needs at least one`);
  return slugs.map((slug) => readChild(join(seedsDir, slug), heldoutDir, slug));
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
 * A post the lead is about to send, written down first. `countBefore` is the chain's task count
 * before it, so that a lost post is looked for among the tasks made since; `at` is the chain's clock
 * in nanoseconds.
 */
interface Intent {
  slug: string;
  countBefore: string;
  at: string;
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
  token: string;
  status: JobStatus;
  /** In the order of the pack: `hires[i]` is for the i-th sub-task folder. */
  hires: Hire[];
  intent?: Intent;
  /** Why the job was given up. */
  reason?: string;
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

function isIntent(value: unknown): value is Intent {
  if (typeof value !== "object" || value === null) return false;
  const i = value as Record<string, unknown>;
  return isText(i.slug) && isText(i.countBefore) && isText(i.at);
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
    isText(j.token) &&
    statuses.includes(j.status) &&
    Array.isArray(j.hires) &&
    j.hires.every(isHire) &&
    (j.intent === undefined || isIntent(j.intent)) &&
    (j.reason === undefined || isText(j.reason));
  if (!ok) throw new Error(`the lead's job file ${file} is corrupt: it is not a job`);
  return json as Job;
}

/** Writes `text` to `file` so that a reader, or a crash, finds the old file or the new one. */
async function writeFileAtomic(file: string, text: string): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
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
  const log = (line: string) => (o.log ?? console.log)(`lead: ${line}`);
  const marginSecs = o.marginSecs ?? DEFAULT_MARGIN_SECS;
  const hireSecs = o.hireSecs ?? DEFAULT_HIRE_SECS;
  const pollMs = o.pollMs ?? DEFAULT_POLL_MS;
  const backoffMs = o.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxBackoffMs = o.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  checkCount("marginSecs", marginSecs, 0);
  checkCount("hireSecs", hireSecs, 0);
  checkCount("pollMs", pollMs, 1);
  checkCount("backoffMs", backoffMs, 1);
  checkCount("maxBackoffMs", maxBackoffMs, backoffMs);
  if (o.journalDir === "") throw new Error("the lead's journal directory must not be empty");
  if (o.delegateKey === "") throw new Error("the lead needs the public key of its delegate key");
  // Read now, so a pack that is wrong fails when the lead is made and not on the first parent.
  const specs = readChildren(o.seedsDir, o.heldoutDir);
  const posters = postersOf(o);
  // Resolved now, so that a later `chdir` cannot move the journal.
  const journalDir = resolve(o.journalDir);

  /** The windows a sub-task is posted with. */
  const windowsOf = (spec: ChildSpec): ChildWindows => o.windows ?? spec.windows;
  const settleSecs = (w: ChildWindows) => w.commit_secs + w.reveal_secs + w.pick_secs;

  // ---- The journal

  const fileOf = (parent: string) => join(journalDir, `${parent}.json`);

  async function readJob(parent: string): Promise<Job | null> {
    const file = fileOf(parent);
    let text: string;
    try {
      text = await readFile(file, "utf8");
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
      names = await readdir(journalDir);
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
    await writeFileAtomic(fileOf(job.parent), `${JSON.stringify(job, null, 2)}\n`);
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
    // Written down before it is sent, so that a restart that finds it can ask the chain whether the
    // post landed, and never posts the part twice.
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
    );
    log(`hired for part ${spec.slug}: task ${posted.taskId}`);
    return save({
      ...start,
      intent: undefined,
      hires: [...start.hires, { slug: spec.slug, id: posted.taskId.toString() }],
    });
  }

  /**
   * Settles an intent the job holds: asks the chain whether the post landed. If a task of the lead,
   * under the parent, with the part's brief, was made since, that is the hire. If none was and the
   * intent is old enough that a sent transaction would be in a block by now, the post is lost and
   * the intent goes. Otherwise it is too soon to say: null, and the job is looked at again later.
   */
  async function reconcile(job: Job): Promise<Job | null> {
    const intent = job.intent;
    const spec = specs.find((one) => one.slug === intent?.slug);
    if (intent === undefined || spec === undefined) return save({ ...job, intent: undefined });
    const first = BigInt(intent.countBefore) + 1n;
    const count = await client.taskCount();
    const stop = first + BigInt(RECONCILE_SCAN);
    for (let id = first; id <= count && id < stop; id++) {
      const task = await client.getTask(id);
      if (
        task !== null &&
        task.poster === job.account &&
        task.parent === job.parent &&
        task.brief_hash === spec.brief.hash
      ) {
        log(`part ${spec.slug} was posted already, as task ${id}`);
        return save({
          ...job,
          intent: undefined,
          hires: [...job.hires, { slug: spec.slug, id: id.toString() }],
        });
      }
    }
    const age = (await client.blockTimestampNs()) - BigInt(intent.at);
    if (age >= BigInt(RECONCILE_SECS) * NS_PER_SEC) {
      log(`the post for part ${spec.slug} did not land; it will be sent again`);
      return save({ ...job, intent: undefined });
    }
    return null;
  }

  async function hiring(start: Job): Promise<Job> {
    let job = start;
    const deadline = BigInt(job.commitDeadline);
    if (job.intent !== undefined) {
      const settled = await reconcile(job);
      if (settled === null) return job;
      job = settled;
    }
    // A sub-task can name the parent only if the lead has an entry on it: the placeholder.
    const entry = await client.getEntry(BigInt(job.parent), job.account);
    while (job.hires.length < specs.length) {
      const todo = specs.slice(job.hires.length);
      const why = fits(await client.blockTimestampNs(), deadline, todo);
      if (why !== null) return abandon(job, why);
      const next = todo[0];
      if (next === undefined) break;
      // Time permitting, the placeholder is on its way: the runner commits it, with its retries.
      if (entry === null) return job;
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
    const ended = await save({ ...job, intent: undefined, status: "abandoned", reason: why });
    const paid = job.hires.length;
    const spent =
      paid === 0 ? "nothing was spent" : `${paid} sub-task(s) are paid for and settle on their own`;
    log(`giving up on task ${job.parent}: ${why}; no more is spent (${spent})`);
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

  async function pass(): Promise<void> {
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
      await rename(
        fileOf(ctx.task.id),
        join(journalDir, `${ctx.task.id}.orphaned-${Date.now()}.json`),
      );
    }
    await save({
      parent: ctx.task.id,
      contractId: client.contractId,
      account,
      parentCreatedAt: ctx.task.created_at,
      commitDeadline: ctx.task.commit_deadline,
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
      while (!signal.aborted) {
        await tick().catch((error: unknown) => log(`ERROR a pass failed (${describe(error)})`));
        await sleep(pollMs, signal);
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
