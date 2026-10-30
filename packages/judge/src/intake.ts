import { type Db, getBlob, type StoredBlob } from "@tender/db";
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
import { COMPILE_BUDGET_MS, checkJsonSchemaIsolated } from "./isolate";
import { ScorerUnavailableError } from "./score";
import { clampReason } from "./scorecard";
import type { JudgeDeps, JudgeMemory } from "./types";

/** The criteria the Judge can score in P0: `exact`, `json_schema` and `regex_cases`. */
export type P0Criteria = Extract<PublicCriteria, { kind: "exact" | "json_schema" | "regex_cases" }>;

/** A task's criteria and held-out checks, read and checked: what its entries are judged by. */
export interface TaskDocuments {
  criteria: P0Criteria;
  /**
   * The held-out document exactly as `JSON.parse` read it from its bytes, or `null` for a task
   * without one. `HeldoutSchema` only checked it: zod's copy of a document can lose keys, and this
   * is the document that is scored with and published.
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
const BUILT_IN_REFERENCE = "criteria schema is not supported: a reference names a built-in member";
const REFERENCE_NOT_ALLOWED =
  'criteria schema is not supported: a reference must be "#" or point to a $defs or definitions entry (move the schema it points to into $defs)';
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
 *   in v1` (C16); from the team: `kind {k} is not available yet`, as P0 has no scorer for either;
 * - `has_heldout` that does not match whether the task has a `heldout_commitment`;
 * - `exact` or `json_schema` without held-out checks: `held-out checks required for kind {k}`;
 * - a `json_schema` schema with an `$id` below its root, a root `$id` with a fragment, or a
 *   reference other than `#` and one to an entry of its `$defs` or `definitions` (see
 *   `referenceProblem`), or one that `checkJsonSchemaUsable` refuses, with its reason. That check
 *   compiles the schema and tries it, in a worker with a budget of 2 s, and a schema that takes
 *   longer is refused: `criteria schema is not supported: it takes too long to compile`;
 * - a `heldout_commitment` that an earlier task of the same poster (a lower id, of any verifier)
 *   commits to as well: `held-out checks already used by task {id}`, naming the lowest. Held-out
 *   checks are single-use, as judging a task publishes them. Another poster's task with the same
 *   commitment does not count (P05-R7): the checks are not its poster's upload, so it is never
 *   judged and never publishes them, and a stranger who posted one first must not block the
 *   poster's own;
 * - held-out checks that are stored under the commitment but not as the poster's `heldout` blob,
 *   that are over 262_144 bytes, that do not fit `HeldoutSchema`, that are of another kind than
 *   the criteria, that hold a surrogate half with no partner, or whose bytes are not their
 *   canonical form. The scorecard republishes them, and has to hash to the commitment.
 *
 * Held-out checks that are not stored yet leave the task `pending` (`waiting for held-out
 * checks`) for 10 minutes from its `created_at`, and then it is `rejected` (`held-out checks
 * missing`). While it waits, the schema's compile check, which needs a worker, is not run yet,
 * and the reasons that come after it are not given: the cheap checks before it are. Anything that
 * throws while the documents are checked, a RangeError included,
 * rejects the task with a fixed reason, and so does a check that crashes its worker. A database
 * error is thrown instead, and so is a worker that cannot be started (`ScorerUnavailableError`):
 * neither says anything about the task, and the next tick tries again. Every reason is at most 200
 * code points.
 */
export async function intakeTask(
  deps: JudgeDeps,
  taskId: bigint,
): Promise<"accepted" | "pending" | "rejected"> {
  const [task] = await deps.db.query<TaskTerms & { judge_status: string | null }>(
    `select id::text as id, poster, criteria_hash, heldout_commitment,
            created_at::text as created_at, judge_status
       from tasks where id = $1 and verifier = $2`,
    [taskId, deps.judgeAccount],
  );
  if (task === undefined) return "pending";
  if (task.judge_status === "accepted") return "accepted";
  if (task.judge_status === "rejected" || task.judge_status === "failed_closed") return "rejected";

  const nowNs = BigInt((deps.now ?? (() => new Date()))().getTime()) * NS_PER_MS;
  const checked = await loadDocuments(deps.db, task, {
    teamAccounts: deps.teamAccounts,
    nowNs,
    waitForHeldout: true,
    compileBudgetMs: deps.scoringLimits?.compileBudgetMs,
    checks: deps.memory?.checks,
  });
  const [status, reason] = checked.ok
    ? (["accepted", null] as const)
    : [checked.status, checked.reason];
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
    earlierUse: null,
  };
  if (task.heldout_commitment !== null) {
    stored.heldout = await getBlob(db, task.heldout_commitment);
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
 * chain anyone can post a task with it, and that task can never publish the checks.
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

  if (criteria.kind === "rubric" || criteria.kind === "tests") {
    return rejected(
      policy.teamAccounts.includes(task.poster)
        ? `kind ${criteria.kind} is not available yet`
        : `kind ${criteria.kind} is limited to team tasks in v1`,
    );
  }
  if (criteria.has_heldout !== (task.heldout_commitment !== null)) {
    return rejected(HAS_HELDOUT_MISMATCH);
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
  try {
    problem = await compileProblem(criteria, task.criteria_hash, policy);
  } catch (error) {
    if (error instanceof ScorerUnavailableError) throw error;
    problem = CHECK_FAILED;
  }
  if (problem !== null) return criteriaRefused(problem);
  if (task.heldout_commitment === null) return { ok: true, documents: { criteria, heldout: null } };

  // Held-out checks are single-use. The Judge publishes them when it judges the first of the
  // poster's tasks that commits to them, so a later one with the same commitment has its answers
  // out, or will. A stranger's task that took the commitment first cannot publish them.
  if (stored.earlierUse !== null) {
    return rejected(`held-out checks already used by task ${stored.earlierUse}`);
  }
  // Their 10 minutes are over, or this is judging, which does not wait.
  if (heldoutBlob === null) return rejected(HELDOUT_MISSING);
  // Blobs are content-addressed and the first upload of some bytes decides their kind and
  // uploader. Checks that someone else stored first can never become the poster's.
  if (heldoutBlob.kind !== "heldout" || heldoutBlob.uploader !== task.poster) {
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

/** Criteria that fail the criteria check (`shapeProblem`, `compileProblem`), for `reason`. */
function criteriaRefused(reason: string): DocumentsCheck {
  return { ok: false, status: "rejected", reason, criteriaCheck: true };
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
 * `checkJsonSchemaIsolated`). Judging gives the compile 4 times intake's time, so that criteria that
 * compiled in time at intake are not refused because the machine is busier. The outcome is kept in
 * `policy.checks` by criteria hash and budget, and taken from there the next time: the check is
 * the same, and so is what comes of it. It rejects when the check crashes its worker, and with
 * `ScorerUnavailableError` when the worker cannot be started; neither is kept.
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
    usable = await checkJsonSchemaIsolated(criteria.schema, { budgetMs });
    policy.checks?.set(key, usable);
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
 *   anywhere else, a missing entry. The reason says to move the schema into `$defs`.
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
  if (keyword === undefined || segment === undefined || segment.includes("%")) {
    return REFERENCE_NOT_ALLOWED;
  }
  const name = segment.replace(/~1/g, "/").replace(/~0/g, "~");
  if (Object.hasOwn(Object.prototype, name)) return BUILT_IN_REFERENCE;
  const entries = Object.hasOwn(root, keyword) ? root[keyword] : undefined;
  if (!isPlainObject(entries) || !Object.hasOwn(entries, name)) return REFERENCE_NOT_ALLOWED;
  const target = entries[name];
  return typeof target === "boolean" || isPlainObject(target) ? null : REFERENCE_NOT_ALLOWED;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
