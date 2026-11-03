import { type Db, getBlob, hasHeldoutUpload, type StoredBlob } from "@tender/db";
import {
  canonicalJson,
  type Heldout,
  HeldoutSchema,
  heldoutMatchesCriteria,
  type PublicCriteria,
  PublicCriteriaSchema,
  sha256Hex,
  type TaskView,
} from "@tender/shared";
import {
  COMPILE_BUDGET_MS,
  checkJsonSchemaIsolated,
  type TaskWorkers,
  TOO_SLOW_TO_COMPILE,
} from "./isolate";
import { type RubricCriteria, rubricProblem, rubricTaskProblem } from "./kinds/rubric";
import { ScorerUnavailableError } from "./score";
import { clampReason } from "./scorecard";
import type { JudgeDeps, JudgeMemory } from "./types";

/**
 * The criteria the Judge scores in a score worker: `exact`, `json_schema` and `regex_cases`. A
 * `rubric` needs the network, so it is graded on the Judge's own thread (see `kinds/rubric.ts`).
 */
export type P0Criteria = Extract<PublicCriteria, { kind: "exact" | "json_schema" | "regex_cases" }>;

/** A task's criteria and held-out checks, read and checked: what its entries are judged by. */
export interface TaskDocuments {
  criteria: P0Criteria | RubricCriteria;
  /**
   * The held-out document exactly as `JSON.parse` read it from its bytes, or `null` for a task
   * without one (a `rubric` has none). `HeldoutSchema` only checked it: zod's copy of a document
   * can lose keys, and this is the document that is scored with and published.
   */
  heldout: Heldout | null;
}

/** A task's documents, or why the task cannot be judged: yet (`pending`), or ever (`rejected`). */
export type DocumentsCheck =
  | { ok: true; documents: TaskDocuments }
  | {
      ok: false;
      status: "pending" | "rejected";
      reason: string;
      /** Set when the criteria failed the criteria check (`shapeProblem`, `compileProblem`). */
      criteriaCheck?: true;
      /**
       * Set when the criteria check ran out of its time budget (`TOO_SLOW_TO_COMPILE`): the
       * machine's load as much as the schema's, so intake tries it again before it turns the task
       * away (M1).
       */
      tooSlow?: true;
    };

/** What a task's documents are checked against: fields of a `TaskView`, and of a `tasks` row. */
type TaskTerms = Pick<
  TaskView,
  "id" | "poster" | "criteria_hash" | "heldout_commitment" | "created_at"
>;

/** What the database holds for a task's documents. */
interface Stored {
  criteria: StoredBlob | null;
  heldout: StoredBlob | null;
  /** Whether the poster is among the accounts that uploaded the held-out document. */
  heldoutFromPoster: boolean;
  /** The lowest id of the poster's earlier tasks with the same held-out commitment, or `null`. */
  earlierUse: string | null;
}

/** What a task's documents are checked by. */
interface Policy {
  teamAccounts: readonly string[];
  nowNs: bigint;
  waitForHeldout: boolean;
  /**
   * How long a `json_schema` schema may take to compile and pass its trial run: 2 s at intake by
   * default. Judging passes 4 times intake's.
   */
  compileBudgetMs?: number;
  /** Where the outcomes of the compile check are kept, by criteria hash and budget, if anywhere. */
  checks?: JudgeMemory["checks"];
  /**
   * Where the compile check's worker comes from, at judging: the task's own (`TaskWorkers`), which
   * keeps it for the task's scorer. Without it, as at intake, the check starts one of its own.
   */
  workers?: TaskWorkers;
}

/** The most bytes a criteria or held-out document may have: what the blob store takes at once. */
const MAX_DOCUMENT_BYTES = 262_144;
/** How long a poster has, from posting, to upload the held-out checks the task commits to. */
const HELDOUT_WAIT_NS = 10n * 60n * 1_000_000_000n;
const NS_PER_MS = 1_000_000n;
/**
 * The keywords that Ajv resolves dynamically: to the schema being compiled, unless the fragment
 * names a dynamic anchor, whatever pointer it holds. They are refused wherever they are (P05-R11).
 */
const DYNAMIC_REFERENCE_KEYWORDS = new Set(["$dynamicRef", "$recursiveRef"]);
/** The keywords whose value is data, not a schema: what is in it is never a reference. */
const DATA_KEYWORDS = new Set(["const", "enum", "examples", "default"]);
/** The keywords whose value maps names to schemas: its keys are names, not keywords. */
const NAMED_SCHEMA_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
]);
/**
 * A reference to one entry of the root's `$defs` or `definitions`: the keyword, and the entry's
 * name as one JSON-pointer segment, `~` escapes and all.
 */
const DEFS_REFERENCE = /^#\/(\$defs|definitions)\/([^/]*)$/;
/** A surrogate half with no partner. With the `u` flag a pair is one code point, not two halves. */
const LONE_SURROGATE = /\p{Cs}/u;

// The reasons intake gives. The API shows them to agents and posters, before anyone works.
const CRITERIA_INVALID = "criteria not found or invalid";
const CRITERIA_TOO_LARGE = "criteria too large";
const HAS_HELDOUT_MISMATCH = "has_heldout does not match the task's held-out commitment";
const RUBRIC_TEAM_ONLY = "kind rubric is limited to team tasks in v1";
const RUBRIC_HAS_NO_HELDOUT = "kind rubric has no held-out checks";
const TESTS_TEAM_ONLY = "kind tests is limited to team tasks in v1";
const TESTS_NOT_AVAILABLE = "kind tests is not available yet";
const BUILT_IN_REFERENCE = "criteria schema is not supported: a reference names a built-in member";
const REFERENCE_NOT_ALLOWED =
  'criteria schema is not supported: a reference must be "#" or point to a $defs or definitions entry (move the schema it points to into $defs)';
// A reference that is already shaped like one to a `$defs` entry, where the entry is what is wrong:
// moving the schema into `$defs` is not the fix.
const REFERENCE_TARGET_UNUSABLE =
  'criteria schema is not supported: a reference points to a $defs or definitions entry that is not there, is not a schema, or has a "%" in its name';
const DYNAMIC_REFERENCE =
  "criteria schema is not supported: $dynamicRef and $recursiveRef are not supported, use $ref";
const ID_BELOW_ROOT = "criteria schema is not supported: $id is only allowed at the root";
const ROOT_ID_FRAGMENT = "criteria schema is not supported: the root $id must not have a fragment";
const HELDOUT_WAITING = "waiting for held-out checks";
const HELDOUT_MISSING = "held-out checks missing";
const HELDOUT_NOT_THE_POSTERS = "held-out checks were not uploaded by the poster";
const HELDOUT_TOO_LARGE = "held-out checks too large";
const HELDOUT_INVALID = "held-out checks invalid";
const HELDOUT_OTHER_KIND = "held-out checks are for another kind";
const HELDOUT_NOT_COMMITTED = "held-out checks do not match the commitment";
const CHECK_FAILED = "criteria could not be checked";
/** The `judge_reason` of a task whose criteria check ran out of time, while it is tried again. */
const COMPILE_RETRY = "the criteria check ran out of time, checking again";
/**
 * How many times intake tries a criteria check again after it ran out of time before it turns the
 * task away for it (M1): a load spike at intake must not reject an honest schema for good, and a
 * schema that is slow every time must not be tried for ever.
 */
const MAX_COMPILE_RETRIES = 3;

/**
 * Decides whether the Judge will judge task `taskId`, and records it in `tasks.judge_status`, with
 * the reason in `judge_reason`, so that agents see it before they work: why the task is rejected,
 * or what it waits for while `pending`, and `null` once it is accepted. Judging may set it again on
 * an accepted task, while it waits for another task to close its reveals (`waiting: …`), and
 * clears it when the wait ends or the task can no longer be judged; and for good when it got to
 * the task too late to score any entry (`not judged: …`, P05-R13).
 * Only a task that names `deps.judgeAccount` as its verifier is looked at. One the database does
 * not have yet, or that names another verifier, is left alone and comes back `pending`.
 *
 * A task is decided once. One that is `accepted`, `rejected` or `failed_closed` already is not
 * looked at again, and comes back as it is (`failed_closed` as `rejected`). A `pending` one is
 * looked at again, and is decided as soon as its held-out checks arrive or its time runs out.
 *
 * What makes a task `rejected`, in this order, with the reason given:
 * - criteria that are not stored under `criteria_hash` as a public `criteria` blob, or that are
 *   not UTF-8 JSON that fits `PublicCriteriaSchema`: `criteria not found or invalid`; criteria
 *   over 262_144 bytes: `criteria too large`. Bytes of another kind or visibility under the hash,
 *   such as someone's private result, are not read, so nothing of them reaches a reason;
 * - `rubric` or `tests` from a poster outside `teamAccounts`: `kind {k} is limited to team tasks
 *   in v1` (C16); `tests` from the team: `kind tests is not available yet`, as there is no scorer
 *   for it. A `rubric` from the team is accepted when it passes the rules below, and judging
 *   grades it with the model it is given (`JudgeDeps.llm`);
 * - `has_heldout` that does not match whether the task has a `heldout_commitment`; `rubric` with
 *   `has_heldout` set, as it has no held-out part: `kind rubric has no held-out checks`;
 * - a `rubric` that a model cannot grade, or whose pass mark a disqualified entry would reach
 *   (`rubricProblem`, which holds the rules of @tender/shared): more than 20 criteria, or one that
 *   is blank, longer than 200 characters or holds an angle bracket, or two that read the same once
 *   normalised, or a `min_score` below 1 (P05-R20). Each has a reason of its own, and judging
 *   checks them again;
 * - a `rubric` task that the Judge cannot grade before agents spend effort on it (C16, see
 *   `rubricTaskProblem`), checked after the rules above and at intake only: the Judge has no model
 *   (`no model is configured to grade rubric tasks`), its entry terms are neither an open task's
 *   (no invited list and `max_entries` 0: the Judge grades its first 50 entries, P05-R21) nor an
 *   invite-only task's (`max_entries` from 1 to 50), which is `kind rubric needs max_entries 0 for
 *   an open task, or 1 to 50 for an invite-only one`, or its brief cannot be read (`the task's
 *   brief could not be read`);
 * - `exact` or `json_schema` without held-out checks: `held-out checks required for kind {k}`;
 * - a `json_schema` schema with an `$id` below its root, a root `$id` with a fragment, or a
 *   reference other than `#` and one to an entry of its `$defs` or `definitions` (see
 *   `referenceProblem`), or one that `checkJsonSchemaUsable` refuses, with its reason. That check
 *   compiles the schema and tries it, in a worker with a budget of 2 s, and a schema that takes
 *   longer is refused: `criteria schema is not supported: it takes too long to compile`, but only
 *   when it has run out of time on 4 checks in a row (M1). Until then the task stays `pending`
 *   (`the criteria check ran out of time, checking again`), as a slow check says as much of the
 *   machine's load as of the schema; a Judge with no memory (`JudgeDeps.memory`) cannot count, and
 *   refuses it at once;
 * - a `heldout_commitment` that an earlier task of the same poster (a lower id, of any verifier)
 *   commits to as well: `held-out checks already used by task {id}`, naming the lowest. Held-out
 *   checks are single-use, as judging a task publishes them. Another poster's task with the same
 *   commitment does not count (P05-R7): once a commitment is on chain anyone can post a task
 *   with it, and only someone who holds the bytes already can have a copy judged, which
 *   publishes them. A stranger who posted one first must not block the poster's own;
 * - held-out checks that are stored under the commitment but not as the poster's `heldout` blob,
 *   that are over 262_144 bytes, that do not fit `HeldoutSchema`, that are of another kind than
 *   the criteria, that hold a surrogate half with no partner, or whose bytes are not their
 *   canonical form. The scorecard republishes them, and has to hash to the commitment.
 *
 * Held-out checks that are not stored yet leave the task `pending` (`waiting for held-out
 * checks`) for 10 minutes from its `created_at`, and then it is `rejected` (`held-out checks
 * missing`). While it waits, the schema's compile check, which needs a worker, is not run yet,
 * and the reasons that come after it are not given: the cheap checks before it are. Once the wait
 * is over, the two reasons that need no worker, `held-out checks missing` and `held-out checks
 * already used by task {id}`, are given before the compile check, so that a task that would be
 * turned away for them costs no worker (I5). Anything that throws while the documents are
 * checked, a RangeError included, rejects the task with a fixed reason, and so does a check that
 * crashes its worker. A database error is thrown instead, and so is a worker that cannot be
 * started (`ScorerUnavailableError`): neither says anything about the task, and the next tick
 * tries again. Every reason is at most 200 code points.
 */
export async function intakeTask(
  deps: JudgeDeps,
  taskId: bigint,
): Promise<"accepted" | "pending" | "rejected"> {
  const [task] = await deps.db.query<
    TaskTerms & {
      brief_hash: string;
      max_entries: number;
      invited: string[];
      judge_status: string | null;
    }
  >(
    `select id::text as id, poster, criteria_hash, heldout_commitment,
            created_at::text as created_at, brief_hash, max_entries, invited, judge_status
       from tasks where id = $1 and verifier = $2`,
    [taskId, deps.judgeAccount],
  );
  if (task === undefined) return "pending";
  if (task.judge_status === "accepted") return "accepted";
  if (task.judge_status === "rejected" || task.judge_status === "failed_closed") return "rejected";

  const nowNs = BigInt((deps.now ?? (() => new Date()))().getTime()) * NS_PER_MS;
  let checked = await loadDocuments(deps.db, task, {
    teamAccounts: deps.teamAccounts,
    nowNs,
    waitForHeldout: true,
    compileBudgetMs: deps.scoringLimits?.compileBudgetMs,
    checks: deps.memory?.checks,
  });
  // What a rubric task needs of the Judge and of the task itself, besides its criteria, is asked at
  // intake alone: judging finds each again where it needs it, with a `WARN`.
  if (checked.ok && checked.documents.criteria.kind === "rubric") {
    const problem = await rubricTaskProblem(deps, task);
    if (problem !== null) checked = rejected(problem);
  }
  let status: "accepted" | "pending" | "rejected" = checked.ok ? "accepted" : checked.status;
  let reason: string | null = checked.ok ? null : checked.reason;
  // M1: a check that ran out of time says as much of the machine as of the schema. The task stays
  // `pending` for a few ticks, counted in the Judge's memory, and is turned away if it is slow
  // every time. Without a memory there is nothing to count with, and it is turned away at once.
  const memory = deps.memory;
  if (memory !== undefined) {
    const id = `${taskId}`;
    if (!checked.ok && checked.tooSlow === true) {
      const overruns = (memory.overruns.get(id) ?? 0) + 1;
      memory.overruns.set(id, overruns);
      if (overruns <= MAX_COMPILE_RETRIES) {
        status = "pending";
        reason = COMPILE_RETRY;
      }
    }
    if (status !== "pending") memory.overruns.delete(id);
  }
  // Only an undecided task is written, so that two Judges at once cannot undo each other.
  await deps.db.query(
    `update tasks set judge_status = $3, judge_reason = $4
      where id = $1 and verifier = $2 and (judge_status is null or judge_status = 'pending')`,
    [taskId, deps.judgeAccount, status, reason],
  );
  return status;
}

/**
 * Reads the criteria and held-out checks that `task` commits to from the blob store, and checks
 * them as `intakeTask` does. Judging reads them again with this, from the hashes the chain holds,
 * so a task whose held-out checks turn out to be used by an earlier task of its poster (one the
 * indexer stored late) fails closed instead of being judged with answers that may be out, and
 * criteria that fail the criteria check now, under rules newer than the task's intake, are not
 * scored: such a result has `criteriaCheck` set.
 *
 * With `waitForHeldout`, held-out checks that are not stored yet make the task `pending` for 10
 * minutes from its `created_at`, and the compile part of the criteria check waits for them: a
 * pending task starts no worker. Without it they are missing at once. A database error is thrown,
 * and so is `ScorerUnavailableError` when the worker of the schema check cannot be started;
 * anything else that goes wrong is a `rejected` result with its reason.
 */
export async function loadDocuments(
  db: Db,
  task: TaskTerms,
  policy: Policy,
): Promise<DocumentsCheck> {
  const stored: Stored = {
    criteria: await getBlob(db, task.criteria_hash),
    heldout: null,
    heldoutFromPoster: false,
    earlierUse: null,
  };
  if (task.heldout_commitment !== null) {
    stored.heldout = await getBlob(db, task.heldout_commitment);
    stored.heldoutFromPoster = await hasHeldoutUpload(db, task.heldout_commitment, task.poster);
    stored.earlierUse = await earlierUseOf(db, task.heldout_commitment, task.id, task.poster);
  }
  try {
    return await checkDocuments(task, stored, policy);
  } catch (error) {
    if (error instanceof ScorerUnavailableError) throw error;
    // Whatever made a check throw, the task is not judged, and the loop goes on.
    return rejected(CHECK_FAILED);
  }
}

/**
 * The lowest id of a task before task `id` that `poster` posted, of any verifier, and that commits
 * to `commitment`, or `null`. Only the poster's own tasks count (P05-R7): once a commitment is on
 * chain anyone can post a task with it, and only someone who holds the bytes already can have a
 * copy judged. A stranger's task must neither use up the poster's checks nor hold up its wait.
 */
async function earlierUseOf(
  db: Db,
  commitment: string,
  id: string,
  poster: string,
): Promise<string | null> {
  // Ids are numeric: `min` and `<` compare them as numbers, and only the result is text.
  const [row] = await db.query<{ id: string | null }>(
    `select min(id)::text as id from tasks
      where heldout_commitment = $1 and id < $2 and poster = $3`,
    [commitment, BigInt(id), poster],
  );
  return row?.id ?? null;
}

async function checkDocuments(
  task: TaskTerms,
  stored: Stored,
  policy: Policy,
): Promise<DocumentsCheck> {
  const { criteria: criteriaBlob, heldout: heldoutBlob } = stored;
  // Criteria are public: agents work from them, and anyone checks a scorecard against them. Bytes
  // of any other kind under the hash, or private ones, such as someone's result, are not read:
  // what a reason quotes of them would make them public.
  if (criteriaBlob === null || criteriaBlob.kind !== "criteria" || !criteriaBlob.isPublic) {
    return rejected(CRITERIA_INVALID);
  }
  if (criteriaBlob.bytes.byteLength > MAX_DOCUMENT_BYTES) return rejected(CRITERIA_TOO_LARGE);
  const parsed = PublicCriteriaSchema.safeParse(parseJson(criteriaBlob.bytes));
  if (!parsed.success) return rejected(CRITERIA_INVALID);
  const criteria = parsed.data;

  const team = policy.teamAccounts.includes(task.poster);
  if (criteria.kind === "rubric" && !team) return rejected(RUBRIC_TEAM_ONLY);
  if (criteria.kind === "tests") return rejected(team ? TESTS_NOT_AVAILABLE : TESTS_TEAM_ONLY);
  if (criteria.has_heldout !== (task.heldout_commitment !== null)) {
    return rejected(HAS_HELDOUT_MISMATCH);
  }
  // A rubric is graded by a model against its public weights: there is no held-out part, and no
  // criteria check that needs a worker. What the model has to echo back must be something it can
  // (`rubricProblem`), which is the criteria check of this kind, run again at judging (P05-R12).
  // Whether the Judge has a model, and the task's own limits, are intake's to ask (`intakeTask`).
  if (criteria.kind === "rubric") {
    if (criteria.has_heldout) return rejected(RUBRIC_HAS_NO_HELDOUT);
    const problem = rubricProblem(criteria);
    if (problem !== null) return criteriaRefused(problem);
    return { ok: true, documents: { criteria, heldout: null } };
  }
  if (criteria.kind !== "regex_cases" && !criteria.has_heldout) {
    return rejected(`held-out checks required for kind ${criteria.kind}`);
  }
  let problem: string | null;
  try {
    problem = shapeProblem(criteria);
  } catch {
    problem = CHECK_FAILED;
  }
  if (problem !== null) return criteriaRefused(problem);
  // A task whose held-out checks have not come yet waits before anything costs a worker: its
  // poster has 10 minutes from posting to send them.
  const waited = policy.nowNs - BigInt(task.created_at);
  const stillComing = policy.waitForHeldout && waited < HELDOUT_WAIT_NS;
  if (task.heldout_commitment !== null && heldoutBlob === null && stillComing) {
    return { ok: false, status: "pending", reason: HELDOUT_WAITING };
  }
  // The refusals that cost a query and no worker come before the compile, which starts one (I5):
  // checks that are already used, or missing with the wait over, are no reason to pay for it.
  const cheap = cheapRefusal(task, stored);
  if (cheap !== null) return rejected(cheap);
  try {
    problem = await compileProblem(criteria, task.criteria_hash, policy);
  } catch (error) {
    if (error instanceof ScorerUnavailableError) throw error;
    problem = CHECK_FAILED;
  }
  if (problem !== null) return criteriaRefused(problem, problem === TOO_SLOW_TO_COMPILE);
  if (task.heldout_commitment === null) return { ok: true, documents: { criteria, heldout: null } };

  // Their 10 minutes are over, or this is judging, which does not wait. (A task whose checks are
  // missing, or already used, was turned away before the compile: `cheapRefusal`.)
  if (heldoutBlob === null) return rejected(HELDOUT_MISSING);
  // Blobs are content-addressed and the first upload of some bytes decides their kind, and anyone
  // who has the bytes can be first. The checks are the poster's when the poster is among the
  // accounts that uploaded them as a held-out document (`heldout_uploads`), whoever was first.
  if (heldoutBlob.kind !== "heldout" || !stored.heldoutFromPoster) {
    return rejected(HELDOUT_NOT_THE_POSTERS);
  }
  if (heldoutBlob.bytes.byteLength > MAX_DOCUMENT_BYTES) return rejected(HELDOUT_TOO_LARGE);
  const heldout = parseJson(heldoutBlob.bytes);
  const valid = HeldoutSchema.safeParse(heldout);
  if (!valid.success) return rejected(HELDOUT_INVALID);
  if (!heldoutMatchesCriteria(criteria, valid.data)) return rejected(HELDOUT_OTHER_KIND);
  // The scorecard publishes the document as it is. A surrogate half with no partner (`"\ud800"`
  // in the JSON) would make the scorecard text that strict readers refuse, and it is not repaired.
  if (hasLoneSurrogate(heldout)) return rejected(HELDOUT_INVALID);
  // The scorecard is checked against the commitment by the document's canonical bytes, so the
  // stored bytes must be those. A document with no canonical form is not valid checks either.
  let canonical: Uint8Array;
  try {
    canonical = canonicalJson(heldout);
  } catch {
    return rejected(HELDOUT_INVALID);
  }
  if (sha256Hex(canonical) !== task.heldout_commitment) return rejected(HELDOUT_NOT_COMMITTED);
  // `heldout` passed `HeldoutSchema`, which is strict, so it is one member of `Heldout`.
  return { ok: true, documents: { criteria, heldout: heldout as Heldout } };
}

function rejected(reason: string): DocumentsCheck {
  return { ok: false, status: "rejected", reason };
}

/**
 * Criteria that fail the criteria check (`shapeProblem`, `compileProblem`), for `reason`.
 * `tooSlow` says the check ran out of time (`DocumentsCheck`).
 */
function criteriaRefused(reason: string, tooSlow = false): DocumentsCheck {
  const refused = { ok: false, status: "rejected", reason, criteriaCheck: true } as const;
  return tooSlow ? { ...refused, tooSlow: true } : refused;
}

/**
 * Why a task with held-out checks is turned away without the compile check, which starts a worker,
 * or `null` (I5). The same reasons the held-out part gives, asked first:
 *
 * - Held-out checks are single-use. The Judge publishes them when it judges the first of the
 *   poster's tasks that commits to them, so a later one with the same commitment has its answers
 *   out, or will: `held-out checks already used by task {id}`, naming the lowest. A stranger's
 *   task that took the commitment first does not count (P05-R7): only someone who holds the
 *   bytes already can have a copy judged.
 * - The checks are not stored, and the wait for them is over (`checkDocuments` has returned
 *   `pending` while it lasts): `held-out checks missing`.
 */
function cheapRefusal(task: TaskTerms, stored: Stored): string | null {
  if (task.heldout_commitment === null) return null;
  if (stored.earlierUse !== null)
    return `held-out checks already used by task ${stored.earlierUse}`;
  return stored.heldout === null ? HELDOUT_MISSING : null;
}

/**
 * The criteria check, in two parts: why the schema of `criteria` cannot be used, or `null`. This
 * part is what it may name and refer to (`referenceProblem`: `$id`, references, dynamic
 * references), checked on this thread; `compileProblem` is the other. Only `json_schema` criteria
 * have a schema. Intake runs the check, and judging runs it again through `loadDocuments` before
 * any entry is scored (P05-R12), so that a task accepted under an older rule is not scored under a
 * check it no longer passes.
 */
function shapeProblem(criteria: P0Criteria): string | null {
  return criteria.kind === "json_schema" ? referenceProblem(criteria.schema) : null;
}

/**
 * The criteria check's other part: whether Ajv compiles and runs the schema
 * (`checkJsonSchemaUsable`), in a worker within `policy.compileBudgetMs` (2 s by default:
 * `checkJsonSchemaIsolated`). Judging gives the compile 4 times intake's time, so that criteria
 * that compiled in time at intake are not refused because the machine is busier. The outcome is
 * kept in `policy.checks` by criteria hash and budget, and taken from there the next time: the
 * check is the same, and so is what comes of it. A refusal for time (`TOO_SLOW_TO_COMPILE`) is
 * not kept: it is the machine's load as much as the schema's, and a later check may pass. It
 * rejects when the check crashes its worker, and with `ScorerUnavailableError` when the worker
 * cannot be started; neither is kept.
 */
async function compileProblem(
  criteria: P0Criteria,
  criteriaHash: string,
  policy: Policy,
): Promise<string | null> {
  if (criteria.kind !== "json_schema") return null;
  const budgetMs = policy.compileBudgetMs ?? COMPILE_BUDGET_MS;
  const key = `${criteriaHash} ${budgetMs}`;
  let usable = policy.checks?.get(key);
  if (usable === undefined) {
    usable = await checkJsonSchemaIsolated(criteria.schema, { budgetMs, workers: policy.workers });
    if (usable.ok || usable.reason !== TOO_SLOW_TO_COMPILE) policy.checks?.set(key, usable);
  }
  return usable.ok ? null : clampReason(usable.reason);
}

/**
 * Whether a string in `document`, as a key or as a value, has a surrogate half with no partner.
 * It walks with a stack of its own; `HeldoutSchema` has already capped the nesting at 64.
 */
function hasLoneSurrogate(document: unknown): boolean {
  const pending: unknown[] = [document];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next === "string") {
      if (LONE_SURROGATE.test(next)) return true;
    } else if (Array.isArray(next)) {
      for (const item of next) pending.push(item);
    } else if (typeof next === "object" && next !== null) {
      for (const [key, value] of Object.entries(next)) {
        if (LONE_SURROGATE.test(key)) return true;
        pending.push(value);
      }
    }
  }
  return false;
}

/** The JSON document in `bytes`, or `undefined` when they are not UTF-8 JSON. */
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * Why `schema` names itself or refers to something in a way that is not supported, or `null`.
 * Ajv looks the names in a reference up on plain objects, so `#/constructor` finds
 * `Object.prototype.constructor` and `#/allOf/length` the length of an array, and a pointer can
 * also land on a map of names, an array or data, which Ajv then compiles as a schema of its own
 * reading; the schema fails on every document, or worse takes every document as a fit.
 * `checkJsonSchemaUsable` catches the first only. So what may be named, and how, is an allow-list
 * rather than a model of how Ajv resolves references, which would have to be exact to be safe
 * (P05-R9, P05-R10, P05-R11):
 *
 * - `$id` is allowed only at the root, so the whole schema is one resource. An `$id` in a schema
 *   below the root is refused, whatever it says; a property named `$id` is a name, not a schema's
 *   `$id`. A root `$id` must not have a fragment, beyond a bare `#`.
 * - `$dynamicRef` and `$recursiveRef` are refused wherever they are. Ajv resolves both to the
 *   schema being compiled unless the fragment names a dynamic anchor, whatever pointer they hold,
 *   so `{"$dynamicRef": "#/$defs/n"}` checks a value against the root and not against `n`.
 * - A `$ref` is exactly `#`, the whole schema, or `#/$defs/{name}` or `#/definitions/{name}`,
 *   where the name is one pointer segment (with `~1` and `~0` decoded, and no `%`) and an own key
 *   of the root's `$defs` or `definitions`, whose value is a schema: an object or a boolean. That
 *   is what written schemas use. A name of an `Object.prototype` member, such as `constructor`, is
 *   refused even when it is defined. Anything else is refused: an anchor, a URI, a pointer
 *   anywhere else; for those the reason says to move the schema into `$defs`. A pointer that is
 *   already to a `$defs` or `definitions` entry, but with a `%` in the name, no such entry or an
 *   entry that is not a schema, has a reason of its own, as moving a schema is not the fix there.
 *
 * The values of `const`, `enum`, `examples` and `default` are data, not schemas, so a `"$ref"` in
 * them is no reference and is not looked at, nor is an `$id` in them. That holds where they are
 * keywords, in a schema, and not where they are names, as in `properties`, whose values are
 * schemas.
 *
 * The criteria schema caps a document's nesting at 64, and the walk keeps its own stack.
 */
function referenceProblem(schema: Record<string, unknown>): string | null {
  // Nothing may follow the first `#` of the root's `$id`.
  const rootId = typeof schema.$id === "string" ? schema.$id : "";
  const hash = rootId.indexOf("#");
  if (hash >= 0 && hash < rootId.length - 1) return ROOT_ID_FRAGMENT;
  // Each entry is a value, and whether it maps names to schemas, as `properties` does, rather than
  // being a schema or a list of them.
  const pending: [value: unknown, names: boolean][] = [[schema, false]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [value, names] = next;
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) pending.push([item, false]);
      continue;
    }
    const node = value as Record<string, unknown>;
    if (names) {
      for (const member of Object.values(node)) pending.push([member, false]);
      continue;
    }
    if (node !== schema && Object.hasOwn(node, "$id")) return ID_BELOW_ROOT;
    for (const [key, member] of Object.entries(node)) {
      if (DATA_KEYWORDS.has(key)) continue;
      if (DYNAMIC_REFERENCE_KEYWORDS.has(key)) return DYNAMIC_REFERENCE;
      if (key === "$ref" && typeof member === "string") {
        const problem = problemOf(member, schema);
        if (problem !== null) return problem;
      } else {
        pending.push([member, NAMED_SCHEMA_KEYWORDS.has(key)]);
      }
    }
  }
  return null;
}

/** Why `reference`, made in `root`, is not supported, or `null`. See `referenceProblem`. */
function problemOf(reference: string, root: Record<string, unknown>): string | null {
  if (reference === "#") return null;
  const [, keyword, segment] = DEFS_REFERENCE.exec(reference) ?? [];
  // A `%` is refused rather than decoded, so that the name looked up here is the very one Ajv
  // looks up: it percent-decodes a fragment as it resolves it.
  if (keyword === undefined || segment === undefined) return REFERENCE_NOT_ALLOWED;
  if (segment.includes("%")) return REFERENCE_TARGET_UNUSABLE;
  const name = segment.replace(/~1/g, "/").replace(/~0/g, "~");
  if (Object.hasOwn(Object.prototype, name)) return BUILT_IN_REFERENCE;
  const entries = Object.hasOwn(root, keyword) ? root[keyword] : undefined;
  if (!isPlainObject(entries) || !Object.hasOwn(entries, name)) return REFERENCE_TARGET_UNUSABLE;
  const target = entries[name];
  return typeof target === "boolean" || isPlainObject(target) ? null : REFERENCE_TARGET_UNUSABLE;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
