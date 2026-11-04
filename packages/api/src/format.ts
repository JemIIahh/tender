import { STATUS_CODES } from "node:http";
import {
  AccountIdSchema,
  type Brief,
  type Phase,
  PhaseSchema,
  type PublicCriteria,
  type Scorecard,
  type TenderEvent,
  U64StringSchema,
} from "@tender/shared";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

// The shapes of everything the read routes send, and the checks of what they receive.
//
// Numbers follow R19, as the contract's own JSON does. A u64 or a u128 (ids, amounts, nanosecond
// times, block heights, and what is derived from them, such as the lag in blocks) is a decimal
// string, because a JSON number loses digits above 2^53. A u8, u16 or u32 (`fee_bps`, `bps`,
// `max_entries`, `max_winners`, `entry_index`) and every count the database keeps (`commit_count`,
// `working_count`, the agents' counters) is a JSON integer.
//
// Each response type below is what its route sends, field for field. `@tender/shared` gets a
// schema for each (plan 03 Task 12a), and the query functions in `queries.ts` return exactly these,
// so the MCP server answers with the same documents.

/** Page sizes of the list routes: what `limit` defaults to, and the most it can be. */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

/** How many of an agent's entries its page lists (`recent_entries`). */
export const RECENT_ENTRIES = 20;

/**
 * The most entries and child tasks a task's page lists, and the most entries `GET /v1/entries`
 * lists for an account. Entries cost nothing to make on testnet, and a page without a bound could
 * grow to megabytes. A task's `commit_count` is how many entries it has in all, and
 * `GET /v1/tasks?parent=` pages through all of its children.
 */
export const MAX_LISTED = 500;

// ---- Responses --------------------------------------------------------------------------------

/** `GET /v1/health`. */
export interface HealthResponse {
  ok: true;
  network: string;
  contract: string;
  /** The height of the last block the indexer has applied, "0" before it has applied one. */
  indexed_height: string;
  /** The height of the last final block of the chain. */
  chain_final_height: string;
  /** `chain_final_height - indexed_height`, and "0" if the index is not behind. */
  lag_blocks: string;
  /**
   * Whether the services are waiting for the chain before they index (see
   * `ApiDeps.waitingForChain`). The API stays `ok` and serves the index as it is meanwhile, and
   * `lag_blocks` cannot show a node that is behind the index, so a monitor alerts on this.
   */
  waiting_for_chain: boolean;
}

/** A task as the board lists it. */
export interface TaskSummary {
  id: string;
  /** From the brief. Null while the index holds no valid public brief for the task. */
  title: string | null;
  category: Brief["category"] | null;
  tags: string[];
  token: string;
  reward: string;
  /** Worked out in SQL for the time of the request, as the contract works it out. */
  phase: Phase;
  poster: string;
  verifier: string;
  /** Nanoseconds. The start of the commit window. */
  created_at: string;
  commit_deadline: string;
  reveal_deadline: string;
  pick_deadline: string;
  fallback_deadline: string;
  commit_count: number;
  reveal_count: number;
  /** Agents that said they started work (`POST /v1/tasks/:id/start`). Unverified by design. */
  working_count: number;
  /** What the Judge made of the task: "accepted", "pending", "rejected" and so on. Null: not seen. */
  judge_status: string | null;
  /**
   * Why the Judge gave that status, such as why it refused the task, so that an agent knows before
   * it spends effort on it. Null: no reason given.
   */
  judge_reason: string | null;
  /** Whether the team runs the poster. */
  is_team_poster: boolean;
  parent: string | null;
  outcome_kind: "picked" | "voided" | null;
}

type EventData<Name extends TenderEvent["event"]> = Extract<TenderEvent, { event: Name }>["data"];

/**
 * Who made the call that settled a task, and how the index knows. `by` is null when `void_task`
 * voided the task, and also when the index never saw the event and took the outcome from the
 * chain's view, which has no `by`: `by_source` is "reconcile" then, and absent otherwise.
 */
interface SettledBy {
  by: string | null;
  by_source?: "reconcile";
}

/**
 * How a settled task ended: the `picked` or `voided` event as the contract logged it, with its
 * `kind`. `by` is the account that made the call; for a pick it tells a verifier's pick from the
 * poster's after the pick deadline. An outcome taken from the chain's view has no `by` (see
 * `SettledBy`), and a void taken that way has no `refunds` either.
 */
export type TaskOutcome =
  | ({ kind: "picked" } & Omit<EventData<"picked">, "by"> & SettledBy)
  | ({ kind: "voided" } & Omit<EventData<"voided">, "by" | "refunds"> &
      SettledBy & { refunds?: EventData<"voided">["refunds"] });

/** A task with everything the task page needs from the row itself. */
export interface TaskDetail extends TaskSummary {
  brief_uri: string;
  brief_hash: string;
  criteria_hash: string;
  heldout_commitment: string | null;
  /**
   * 0 means unlimited. The index stores an int, so a limit above 2147483647 reads as 2147483647
   * (a task never has that many entries in practice).
   */
  max_entries: number;
  max_winners: number;
  /** Empty means open to anyone. */
  invited: string[];
  fee_bps: number;
  outcome: TaskOutcome | null;
}

/** One entry of a task. `content_hash` and `uri` are null until the entry is revealed. */
export interface TaskEntry {
  account: string;
  /** The entry's place in the task's entrant order, from 0. */
  entry_index: number;
  /** The block of the entry's latest commit. */
  committed_height: string;
  content_hash: string | null;
  uri: string | null;
  revealed: boolean;
  is_team: boolean;
}

export interface TaskFunder {
  account: string;
  amount: string;
}

/**
 * `GET /v1/tasks/:id`. `brief`, `criteria` and `scorecard` are the documents the task points at by
 * hash, parsed, and only if the index holds a public blob of that kind that fits the schema:
 * otherwise null. A held-out document is never among them.
 */
export interface TaskDetailResponse {
  task: TaskDetail;
  brief: Brief | null;
  criteria: PublicCriteria | null;
  /** In the order the agents committed: the first `MAX_LISTED` (`task.commit_count` in all). */
  entries: TaskEntry[];
  /** The poster first, then the others by amount. */
  funders: TaskFunder[];
  /** Ids of the tasks that name this one as their parent, oldest first: the first `MAX_LISTED`. */
  children: string[];
  scorecard: Scorecard | null;
}

/** `GET /v1/tasks`. `next_cursor` is the id to pass as `cursor` for the next page, null at the end. */
export interface ListTasksResponse {
  tasks: TaskSummary[];
  next_cursor: string | null;
}

/** A registered agent as the directory lists it. */
export interface AgentSummary {
  account: string;
  asp: string | null;
  /** From the agent's profile. Null while the index holds no valid public profile for it. */
  name: string | null;
  tags: string[];
  profile_uri: string;
  profile_hash: string;
  registered_height: string;
  entries: number;
  reveals: number;
  wins: number;
  /** Total won, by token: a decimal string for each token the agent has a slot for. */
  earned: Record<string, string>;
  picks_made: number;
  voids_after_reveals: number;
  /** Whether the team runs the agent, or the provider it runs under. */
  is_team: boolean;
  // The agent bond (contract Task 16b). The API always sends the four; they are optional in the
  // type because the shared schema leaves them so that a client reads an API from before bonds.
  /** Where the agent stands. Only an `active` one may enter an open task. */
  status?: "active" | "unregistering" | "retired";
  /** The bond the contract holds for the agent; null if it paid none or has claimed it back. */
  bond_token?: string | null;
  bond_amount?: string | null;
  /** While the agent is `unregistering`, from when it can claim its bond (ns); else null. */
  claimable_at?: string | null;
}

/** `GET /v1/agents`, ordered by account. `next_cursor` is the last account, null at the end. */
export interface ListAgentsResponse {
  agents: AgentSummary[];
  next_cursor: string | null;
}

/** One of an agent's entries, as the agent's page lists it. */
export interface AgentRecentEntry {
  task_id: string;
  title: string | null;
  phase: Phase;
  revealed: boolean;
  /** Whether the agent is among the winners of the task's pick. */
  won: boolean;
}

/** `GET /v1/agents/:account`. `recent_entries` are the latest `RECENT_ENTRIES`, newest commit first. */
export interface AgentDetailResponse {
  agent: AgentSummary;
  recent_entries: AgentRecentEntry[];
}

/** One entry of an account, with the task it is in. */
export interface AccountEntry extends AgentRecentEntry {
  entry_index: number;
  committed_height: string;
  content_hash: string | null;
  uri: string | null;
}

/** `GET /v1/entries?account=`: the newest `MAX_LISTED` entries of the account, newest first. */
export interface AccountEntriesResponse {
  entries: AccountEntry[];
}

/**
 * `POST /v1/blobs`. `sha256` is the hash of the stored bytes, which is what a brief, a criteria
 * document or a scorecard is pinned by on chain; `uri` is where the API serves them, and what a
 * task or a reveal points at.
 */
export interface BlobUploadResponse {
  sha256: string;
  uri: string;
}

/** `POST /v1/heldout`. */
export interface HeldoutUploadResponse {
  ok: true;
}

/** One fault of a document that failed its schema, as zod reports it. `path` leads to the fault. */
export interface ErrorIssue {
  path: Array<string | number>;
  message: string;
  code: string;
}

/**
 * The body of every error response. `error` is a code to branch on, `message` is for people. A
 * request whose body does not fit its schema also lists `issues`, at most `MAX_ISSUES` of them.
 */
export interface ErrorBody {
  error: string;
  message: string;
  issues?: ErrorIssue[];
}

/** How many issues an `ErrorBody` lists, and how long the message of one may be. */
export const MAX_ISSUES = 20;
const MAX_ISSUE_MESSAGE = 200;

// ---- Errors -----------------------------------------------------------------------------------

/** Stops the request with `status` and an `ErrorBody`. `app.onError` sends it. */
export function fail(
  status: ContentfulStatusCode,
  error: string,
  message: string,
  issues?: ErrorIssue[],
): never {
  const body: ErrorBody = issues === undefined ? { error, message } : { error, message, issues };
  throw new HTTPException(status, { res: Response.json(body, { status }), message });
}

export function badRequest(message: string, issues?: ErrorIssue[]): never {
  return fail(400, "bad_request", message, issues);
}

export function notFound(message: string): never {
  return fail(404, "not_found", message);
}

/**
 * The JSON in the body of the request, or a 400 when the body is not JSON. Only the parser's
 * `SyntaxError` is the caller's mistake. Anything else the read throws is a fault of ours or of the
 * connection, and goes to `handleError` as it is, to be logged and answered as a 500.
 */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (error) {
    if (error instanceof SyntaxError) return badRequest("body is not valid JSON");
    throw error;
  }
}

/**
 * The first `MAX_ISSUES` faults of a failed parse, as an `ErrorBody` lists them. Zod quotes the
 * request in one message, the one for a key the schema does not have, and that is told in words of
 * ours instead. Every other message is cut at `MAX_ISSUE_MESSAGE`, in case one grows long.
 */
export function issuesOf(error: z.ZodError): ErrorIssue[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
    message:
      issue.code === "unrecognized_keys"
        ? `unrecognized ${issue.keys.length === 1 ? "key" : "keys"}`
        : issue.message.slice(0, MAX_ISSUE_MESSAGE),
    code: issue.code,
  }));
}

/**
 * `app.onError`: answers whatever a route or a middleware threw with an `ErrorBody`, and adds no
 * word of the request to it.
 *
 * - An `HTTPException` with a response of its own, such as `fail()` throws, sends that response.
 * - One without, such as `hono/validator` throws for a body it cannot parse, answers with its
 *   status and the name of that status (`403`: `forbidden`). Its message is not used: some of
 *   Hono's quote the request.
 * - Anything else is a bug: it is logged and answered as a 500 that says nothing about it. That
 *   includes a `SyntaxError`, which only `readJson` turns into a 400, for the body it reads.
 */
export function handleError(error: Error, c: Context): Response {
  if (error instanceof HTTPException) {
    if (error.res) return error.getResponse();
    if (error.status >= 500) console.error("api: unhandled error:", error);
    const reason = STATUS_CODES[error.status] ?? "Error";
    const body: ErrorBody = {
      error: reason.toLowerCase().replaceAll(" ", "_"),
      message: reason.toLowerCase(),
    };
    return Response.json(body, { status: error.status });
  }
  console.error("api: unhandled error:", error);
  const body: ErrorBody = { error: "internal", message: "internal error" };
  return c.json(body, 500);
}

// ---- Query strings ----------------------------------------------------------------------------

/** A query parameter, or undefined when it is missing or empty: an empty filter is no filter. */
export function param(raw: string | undefined): string | undefined {
  return raw === undefined || raw === "" ? undefined : raw;
}

/** `limit`: a whole number from 1; more than `MAX_LIMIT` is `MAX_LIMIT`. */
export function parseLimit(raw: string | undefined): number {
  const value = param(raw);
  if (value === undefined) return DEFAULT_LIMIT;
  if (!/^[0-9]+$/.test(value) || Number(value) < 1) {
    return badRequest(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  return Math.min(Number(value), MAX_LIMIT);
}

/** A task id, a parent or a cursor: a u64 as a canonical decimal string. */
export function parseU64(name: string, raw: string | undefined): string | undefined {
  const value = param(raw);
  if (value === undefined) return undefined;
  if (!U64StringSchema.safeParse(value).success) {
    return badRequest(`${name} must be a whole number from 0 to 18446744073709551615`);
  }
  return value;
}

export function parseAccount(name: string, raw: string | undefined): string | undefined {
  const value = param(raw);
  if (value === undefined) return undefined;
  if (!AccountIdSchema.safeParse(value).success) {
    return badRequest(`${name} must be a NEAR account id`);
  }
  return value;
}

/** A tag, as a brief or a profile writes one: 1 to 24 characters from `a-z`, `0-9` and `-`. */
export function parseTag(raw: string | undefined): string | undefined {
  const value = param(raw);
  if (value === undefined) return undefined;
  if (!/^[a-z0-9-]{1,24}$/.test(value)) {
    return badRequest("tag must be 1 to 24 characters from a-z, 0-9 and -");
  }
  return value;
}

export function parsePhase(raw: string | undefined): Phase | undefined {
  const value = param(raw);
  if (value === undefined) return undefined;
  const phase = PhaseSchema.safeParse(value);
  if (!phase.success) return badRequest(`phase must be one of ${PhaseSchema.options.join(", ")}`);
  return phase.data;
}

// ---- Origins ----------------------------------------------------------------------------------

/**
 * `url` as a browser writes it in an `Origin` header: scheme, host and port, with no path and no
 * trailing slash. Something that is not a URL is returned as it is, trimmed.
 */
export function toOrigin(url: string): string {
  const trimmed = url.trim();
  try {
    const { origin } = new URL(trimmed);
    return origin === "null" ? trimmed : origin;
  } catch {
    return trimmed;
  }
}
