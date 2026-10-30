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
import { checkJsonSchemaUsable } from "./kinds/json_schema";
import { clampReason } from "./scorecard";
import type { JudgeDeps } from "./types";

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
  | { ok: false; status: "pending" | "rejected"; reason: string };

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

/** The most bytes a criteria or held-out document may have: what the blob store takes at once. */
const MAX_DOCUMENT_BYTES = 262_144;
/** How long a poster has, from posting, to upload the held-out checks the task commits to. */
const HELDOUT_WAIT_NS = 10n * 60n * 1_000_000_000n;
const NS_PER_MS = 1_000_000n;
/** The keywords whose value is a reference to a schema. */
const REFERENCE_KEYWORDS = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);
/** An index of an array in a JSON pointer, as Ajv reads one: no sign, no leading zero. */
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;
/** A surrogate half with no partner. With the `u` flag a pair is one code point, not two halves. */
const LONE_SURROGATE = /\p{Cs}/u;

// The reasons intake gives. The API shows them to agents and posters, before anyone works.
const CRITERIA_INVALID = "criteria not found or invalid";
const CRITERIA_TOO_LARGE = "criteria too large";
const HAS_HELDOUT_MISMATCH = "has_heldout does not match the task's held-out commitment";
const BUILT_IN_REFERENCE = "criteria schema is not supported: a reference names a built-in member";
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
 * the reason in `judge_reason` (`null` once accepted), so that agents see it before they work.
 * Only a task that names `deps.judgeAccount` as its verifier is looked at. One the database does
 * not have yet, or that names another verifier, is left alone and comes back `pending`.
 *
 * A task is decided once. One that is `accepted`, `rejected` or `failed_closed` already is not
 * looked at again, and comes back as it is (`failed_closed` as `rejected`). A `pending` one is
 * looked at again, and is decided as soon as its held-out checks arrive or its time runs out.
 *
 * What makes a task `rejected`, in this order, with the reason given:
 * - criteria that are not stored under `criteria_hash`, or that are not UTF-8 JSON that fits
 *   `PublicCriteriaSchema`: `criteria not found or invalid`; criteria over 262_144 bytes:
 *   `criteria too large`;
 * - `rubric` or `tests` from a poster outside `teamAccounts`: `kind {k} is limited to team tasks
 *   in v1` (C16); from the team: `kind {k} is not available yet`, as P0 has no scorer for either;
 * - `has_heldout` that does not match whether the task has a `heldout_commitment`;
 * - `exact` or `json_schema` without held-out checks: `held-out checks required for kind {k}`;
 * - a `json_schema` schema with a reference through a built-in member (see `refersToBuiltIn`), or
 *   one that `checkJsonSchemaUsable` refuses, with its reason;
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
 * missing`). Anything that throws while the documents are checked, a RangeError included,
 * rejects the task with a fixed reason. A database error is thrown instead: it says nothing about
 * the task, and the next tick tries again. Every reason is at most 200 code points.
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
 * indexer stored late) fails closed instead of being judged with answers that may be out.
 *
 * With `waitForHeldout`, held-out checks that are not stored yet make the task `pending` for 10
 * minutes from its `created_at`. Without it they are missing at once. A database error is thrown;
 * anything else that goes wrong is a `rejected` result with its reason.
 */
export async function loadDocuments(
  db: Db,
  task: TaskTerms,
  policy: { teamAccounts: readonly string[]; nowNs: bigint; waitForHeldout: boolean },
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
    return checkDocuments(task, stored, policy);
  } catch {
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

function checkDocuments(
  task: TaskTerms,
  stored: Stored,
  policy: { teamAccounts: readonly string[]; nowNs: bigint; waitForHeldout: boolean },
): DocumentsCheck {
  const { criteria: criteriaBlob, heldout: heldoutBlob } = stored;
  if (criteriaBlob === null) return rejected(CRITERIA_INVALID);
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
  if (criteria.kind === "json_schema") {
    if (refersToBuiltIn(criteria.schema)) return rejected(BUILT_IN_REFERENCE);
    const usable = checkJsonSchemaUsable(criteria.schema);
    if (!usable.ok) return rejected(clampReason(usable.reason));
  }
  if (task.heldout_commitment === null) return { ok: true, documents: { criteria, heldout: null } };

  // Held-out checks are single-use. The Judge publishes them when it judges the first of the
  // poster's tasks that commits to them, so a later one with the same commitment has its answers
  // out, or will. A stranger's task that took the commitment first cannot publish them.
  if (stored.earlierUse !== null) {
    return rejected(`held-out checks already used by task ${stored.earlierUse}`);
  }
  if (heldoutBlob === null) {
    const waited = policy.nowNs - BigInt(task.created_at);
    if (policy.waitForHeldout && waited < HELDOUT_WAIT_NS) {
      return { ok: false, status: "pending", reason: HELDOUT_WAITING };
    }
    return rejected(HELDOUT_MISSING);
  }
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
 * Whether `schema` has a reference (`$ref`, `$dynamicRef`, `$recursiveRef`) that Ajv would
 * resolve through a member it inherits, rather than through the schema's own keys. Ajv looks the
 * names in a reference up on plain objects, so `#/constructor` finds `Object.prototype.constructor`
 * and `#/allOf/length` the length of an array, and the schema then fails on every document, or
 * worse takes every document as a fit. `checkJsonSchemaUsable` catches the first only.
 *
 * Every name in a reference counts, decoded as Ajv decodes it (percent-encoding, then `~1` and
 * `~0` in a JSON pointer): the segments of the URI before `#`, the anchor after it, or each
 * segment of a JSON pointer. A name of an `Object.prototype` member is refused wherever it is. A
 * JSON pointer with no URI before it is also walked through the schema resource the reference is
 * in (the closest object with an `$id`, or the whole schema), and each step must be an own key of
 * an object or an index of an array: `#/allOf/length` is refused, `#/$defs/total` is not. A step
 * that finds nothing ends the walk, as Ajv refuses a reference it cannot resolve on its own. A
 * reference whose percent-encoding cannot be decoded is refused.
 *
 * The criteria schema caps a document's nesting at 64, and the walk keeps its own stack.
 */
function refersToBuiltIn(schema: Record<string, unknown>): boolean {
  // Each entry is a value, and the schema resource it is in.
  const pending: [value: unknown, resource: object][] = [[schema, schema]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [value, resource] = next;
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) pending.push([item, resource]);
      continue;
    }
    const node = value as Record<string, unknown>;
    const base = typeof node.$id === "string" ? node : resource;
    for (const [key, member] of Object.entries(node)) {
      if (REFERENCE_KEYWORDS.has(key) && typeof member === "string") {
        if (namesBuiltIn(member, base)) return true;
      } else {
        pending.push([member, base]);
      }
    }
  }
  return false;
}

/** Whether `reference`, made inside `resource`, names a built-in member. See `refersToBuiltIn`. */
function namesBuiltIn(reference: string, resource: object): boolean {
  const hash = reference.indexOf("#");
  const uri = hash < 0 ? reference : reference.slice(0, hash);
  const fragment = hash < 0 ? "" : reference.slice(hash + 1);
  const isPointer = fragment.startsWith("/");
  let uriNames: string[];
  let fragmentNames: string[];
  try {
    uriNames = uri.split("/").map((segment) => decodeURIComponent(segment));
    fragmentNames = isPointer
      ? fragment
          .slice(1)
          .split("/")
          .map((segment) => decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~"))
      : [decodeURIComponent(fragment)];
  } catch {
    return true;
  }
  if ([...uriNames, ...fragmentNames].some((name) => Object.hasOwn(Object.prototype, name))) {
    return true;
  }
  return uri === "" && isPointer && !walksOwnKeys(resource, fragmentNames);
}

/**
 * Whether each step of `path` from `start` is an own key of an object or an index of an array,
 * until a step finds nothing. A step into anything else (a string, a number, a boolean, null) is
 * not: what Ajv found there would be a member of its prototype, or an error.
 */
function walksOwnKeys(start: object, path: readonly string[]): boolean {
  let current: unknown = start;
  for (const step of path) {
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(step)) return false;
      current = current[Number(step)];
    } else if (typeof current === "object" && current !== null) {
      if (!Object.hasOwn(current, step)) return true;
      current = (current as Record<string, unknown>)[step];
    } else {
      return false;
    }
    if (current === undefined) return true;
  }
  return true;
}
