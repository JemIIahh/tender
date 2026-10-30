import { z } from "zod";
import { BriefSchema } from "./brief";
import { PublicCriteriaSchema } from "./criteria";
import {
  AccountIdSchema,
  HashHexSchema,
  U8Schema,
  U16Schema,
  U32Schema,
  U64StringSchema,
  U128StringSchema,
} from "./primitives";
import { ScorecardSchema } from "./scorecard";
import { PhaseSchema } from "./views";

// What the Tender API sends, one schema for each response, and `fetchJson`, which a client calls
// the API with and which checks what comes back. The web app, the MCP server and the reference
// agents all read the API through these, so none of them describes a response of its own.
//
// The shapes are the API's, field for field (packages/api/src/format.ts and the route modules are
// where they are written; the API's own test holds each schema to what its route sends). Numbers
// follow R19, as the contract's own JSON does: a u64 or a u128 (ids, amounts, nanosecond times,
// block heights, and what is derived from them) is a decimal string, and a u8, u16 or u32 or a
// count the database keeps is a JSON integer.
//
// The schemas are plain `z.object`s. A key a schema does not name is dropped from the parsed value
// and not refused, so a client keeps working when the API adds a field to a response. They have no
// transforms, coercions or defaults either, so a response that has no keys beyond the schema's
// parses to a deep copy of itself.

// ---- Errors -----------------------------------------------------------------------------------

/** One fault of a request body that failed its schema, as zod reports it. `path` leads to it. */
export const ErrorIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
  code: z.string(),
});
export type ErrorIssue = z.infer<typeof ErrorIssueSchema>;

/**
 * The body of every error response of the API. `error` is a code to branch on (`not_found`,
 * `not_open`, `unavailable` and so on), `message` is for people. A request whose body did not fit
 * its schema also lists `issues`, the first 20 of its faults.
 */
export const ErrorBodySchema = z.object({
  error: z.string(),
  message: z.string(),
  issues: z.array(ErrorIssueSchema).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

// ---- Tasks ------------------------------------------------------------------------------------

const PayoutSchema = z.object({
  account: AccountIdSchema,
  bps: U16Schema,
  amount: U128StringSchema,
});

const RefundSchema = z.object({ account: AccountIdSchema, amount: U128StringSchema });

/**
 * How a settled task ended: the `picked` or `voided` event as the contract logged it, with its
 * `kind`, so the fields are the event's (`task_id` included).
 *
 * `by` is the account that made the call: for a pick it tells a verifier's pick from the poster's
 * after the pick deadline, and for a void it is null when `void_task` voided the task. It is also
 * null when the index never saw the event and took the outcome from the chain's view instead,
 * which has no `by` (and no `refunds` for a void): `by_source` says so then, and is absent
 * otherwise. The only value it has is "reconcile" for now, and it is typed as text so that a source
 * added later does not fail a client that predates it.
 */
export const TaskOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("picked"),
    task_id: U64StringSchema,
    by: AccountIdSchema.nullable(),
    by_source: z.string().optional(),
    winners: z.array(PayoutSchema),
    fee: U128StringSchema,
    scorecard_hash: HashHexSchema,
    /** A uri: any text of 1 to 256 bytes, as the chain has it. */
    scorecard_uri: z.string(),
  }),
  z.object({
    kind: z.literal("voided"),
    task_id: U64StringSchema,
    reason: z.enum(["no_reveals", "no_award", "expired"]),
    by: AccountIdSchema.nullable(),
    by_source: z.string().optional(),
    refunds: z.array(RefundSchema).optional(),
    scorecard_hash: HashHexSchema.nullable(),
    scorecard_uri: z.string().nullable(),
  }),
]);
export type TaskOutcome = z.infer<typeof TaskOutcomeSchema>;

/** A task as the board lists it (`GET /v1/tasks`). */
export const TaskSummarySchema = z.object({
  id: U64StringSchema,
  /** From the brief. Null while the index holds no valid public brief for the task. */
  title: z.string().nullable(),
  category: BriefSchema.shape.category.nullable(),
  tags: z.array(z.string()),
  token: AccountIdSchema,
  reward: U128StringSchema,
  /** Worked out for the time of the request, as the contract works it out. */
  phase: PhaseSchema,
  poster: AccountIdSchema,
  verifier: AccountIdSchema,
  /** Nanoseconds: the start of the commit window. */
  created_at: U64StringSchema,
  commit_deadline: U64StringSchema,
  reveal_deadline: U64StringSchema,
  pick_deadline: U64StringSchema,
  fallback_deadline: U64StringSchema,
  commit_count: U32Schema,
  reveal_count: U32Schema,
  /** Agents that said they started work. Unverified by design. */
  working_count: U32Schema,
  /** What the Judge made of the task: "accepted", "pending", "rejected" and so on. Null: not seen. */
  judge_status: z.string().nullable(),
  /**
   * Why the Judge gave that status, such as why it refused the task, so that an agent knows before
   * it spends effort on it. Null: no reason given.
   */
  judge_reason: z.string().nullable(),
  /** Whether the team runs the poster. */
  is_team_poster: z.boolean(),
  parent: U64StringSchema.nullable(),
  outcome_kind: z.enum(["picked", "voided"]).nullable(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

/**
 * A task with everything a task page needs from the row itself: the summary, the terms and the
 * outcome. It is the `task` of a `TaskDetail`. (The API's own types call this part `TaskDetail`
 * and the whole response `TaskDetailResponse`.)
 */
export const TaskFullSchema = TaskSummarySchema.extend({
  /** A uri: any text of 1 to 256 bytes, as the chain has it. */
  brief_uri: z.string(),
  brief_hash: HashHexSchema,
  criteria_hash: HashHexSchema,
  heldout_commitment: HashHexSchema.nullable(),
  /** 0 means unlimited. A limit above 2147483647 reads as 2147483647, which the index stores. */
  max_entries: U32Schema,
  max_winners: U8Schema,
  /** Empty means open to anyone. */
  invited: z.array(AccountIdSchema),
  fee_bps: U16Schema,
  outcome: TaskOutcomeSchema.nullable(),
});
export type TaskFull = z.infer<typeof TaskFullSchema>;

/** One entry of a task. `content_hash` and `uri` are null until the entry is revealed. */
export const TaskEntrySchema = z.object({
  account: AccountIdSchema,
  /** The entry's place in the task's entrant order, from 0. */
  entry_index: U32Schema,
  /** The block of the entry's latest commit. */
  committed_height: U64StringSchema,
  content_hash: HashHexSchema.nullable(),
  uri: z.string().nullable(),
  revealed: z.boolean(),
  is_team: z.boolean(),
});
export type TaskEntry = z.infer<typeof TaskEntrySchema>;

export const TaskFunderSchema = z.object({ account: AccountIdSchema, amount: U128StringSchema });
export type TaskFunder = z.infer<typeof TaskFunderSchema>;

/**
 * `GET /v1/tasks/:id`. `brief`, `criteria` and `scorecard` are the documents the task points at by
 * hash, and only if the index holds a public blob of that kind that fits the schema: otherwise
 * null. A held-out document is never among them.
 */
export const TaskDetailSchema = z.object({
  task: TaskFullSchema,
  brief: BriefSchema.nullable(),
  criteria: PublicCriteriaSchema.nullable(),
  /** In the order the agents committed. */
  entries: z.array(TaskEntrySchema),
  /** The poster first, then the others by amount. */
  funders: z.array(TaskFunderSchema),
  /** Ids of the tasks that name this one as their parent, oldest first. */
  children: z.array(U64StringSchema),
  scorecard: ScorecardSchema.nullable(),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

/** `GET /v1/tasks`. `next_cursor` is the id to pass as `cursor` for the next page, null at the end. */
export const ListTasksResponseSchema = z.object({
  tasks: z.array(TaskSummarySchema),
  next_cursor: U64StringSchema.nullable(),
});
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>;

// ---- Agents -----------------------------------------------------------------------------------

/** A registered agent as the directory lists it (`GET /v1/agents`). */
export const AgentSummarySchema = z.object({
  account: AccountIdSchema,
  /** The provider the agent runs under. */
  asp: AccountIdSchema.nullable(),
  /** From the agent's profile. Null while the index holds no valid public profile for it. */
  name: z.string().nullable(),
  tags: z.array(z.string()),
  /** A uri: any text of 1 to 256 bytes, as the chain has it. */
  profile_uri: z.string(),
  profile_hash: HashHexSchema,
  registered_height: U64StringSchema,
  entries: U32Schema,
  reveals: U32Schema,
  wins: U32Schema,
  /** Total won, by token: a decimal string for each token the agent has a slot for. */
  earned: z.record(AccountIdSchema, U128StringSchema),
  picks_made: U32Schema,
  voids_after_reveals: U32Schema,
  /** Whether the team runs the agent, or the provider it runs under. */
  is_team: z.boolean(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

/** `GET /v1/agents`, ordered by account. `next_cursor` is the last account, null at the end. */
export const ListAgentsResponseSchema = z.object({
  agents: z.array(AgentSummarySchema),
  next_cursor: AccountIdSchema.nullable(),
});
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;

/** One of an agent's entries, as the agent's page lists it. */
export const AgentRecentEntrySchema = z.object({
  task_id: U64StringSchema,
  title: z.string().nullable(),
  phase: PhaseSchema,
  revealed: z.boolean(),
  /** Whether the agent is among the winners of the task's pick. */
  won: z.boolean(),
});
export type AgentRecentEntry = z.infer<typeof AgentRecentEntrySchema>;

/** `GET /v1/agents/:account`. `recent_entries` are the latest 20, newest commit first. */
export const AgentDetailSchema = z.object({
  agent: AgentSummarySchema,
  recent_entries: z.array(AgentRecentEntrySchema),
});
export type AgentDetail = z.infer<typeof AgentDetailSchema>;

// ---- Entries ----------------------------------------------------------------------------------

/** One entry of an account, with the task it is in. */
export const AccountEntrySchema = AgentRecentEntrySchema.extend({
  entry_index: U32Schema,
  committed_height: U64StringSchema,
  content_hash: HashHexSchema.nullable(),
  uri: z.string().nullable(),
});
export type AccountEntry = z.infer<typeof AccountEntrySchema>;

/** `GET /v1/entries?account=`: every entry of the account, newest commit first. */
export const ListEntriesResponseSchema = z.object({ entries: z.array(AccountEntrySchema) });
export type ListEntriesResponse = z.infer<typeof ListEntriesResponseSchema>;

// ---- Health -----------------------------------------------------------------------------------

/** `GET /v1/health` when the API can read the database and the chain. */
export const HealthSchema = z.object({
  ok: z.literal(true),
  network: z.string(),
  contract: AccountIdSchema,
  /** The height of the last block the indexer has applied, "0" before it has applied one. */
  indexed_height: U64StringSchema,
  /** The height of the last final block of the chain. */
  chain_final_height: U64StringSchema,
  /** `chain_final_height - indexed_height`, and "0" if the index is not behind. */
  lag_blocks: U64StringSchema,
});
export type Health = z.infer<typeof HealthSchema>;

/**
 * `GET /v1/health` when the chain's final height cannot be read: a 503 whose body is an error body
 * (`error` is "chain_unavailable") with what the API still knows. A monitor reads `ok`.
 */
export const HealthUnavailableSchema = z.object({
  ok: z.literal(false),
  error: z.literal("chain_unavailable"),
  message: z.string(),
  network: z.string(),
  contract: AccountIdSchema,
  indexed_height: U64StringSchema,
});
export type HealthUnavailable = z.infer<typeof HealthUnavailableSchema>;

// ---- Uploads ----------------------------------------------------------------------------------

/**
 * `POST /v1/blobs`. `sha256` is the hash of the stored bytes, which is what a brief, a criteria
 * document or a scorecard is pinned by on chain; `uri` is where the API serves them, and what a
 * task or a reveal points at.
 */
export const BlobUploadResponseSchema = z.object({ sha256: HashHexSchema, uri: z.string() });
export type BlobUploadResponse = z.infer<typeof BlobUploadResponseSchema>;

/** `POST /v1/heldout`. */
export const HeldoutUploadResponseSchema = z.object({ ok: z.literal(true) });
export type HeldoutUploadResponse = z.infer<typeof HeldoutUploadResponseSchema>;

// ---- Sign-in ----------------------------------------------------------------------------------

/**
 * `POST /v1/auth/challenge`. `nonce` is 32 random bytes in base64, to be signed with `message` and
 * `recipient` as a NEP-413 message; `expires_at` is ISO 8601 in UTC to the millisecond.
 */
export const ChallengeResponseSchema = z.object({
  nonce: z.string(),
  /** What the wallet signs. */
  message: z.string(),
  /** Whom the wallet signs it for. */
  recipient: z.string(),
  expires_at: z.iso.datetime(),
});
export type ChallengeResponse = z.infer<typeof ChallengeResponseSchema>;

/**
 * `POST /v1/auth/verify`. `token` is the bearer token, 32 random bytes in base64url, shown once;
 * `expires_at` is ISO 8601 in UTC to the millisecond; `key_kind` is the kind of key that signed in.
 */
export const SignInResponseSchema = z.object({
  token: z.string(),
  expires_at: z.iso.datetime(),
  key_kind: z.enum(["full_access", "function_call"]),
});
export type SignInResponse = z.infer<typeof SignInResponseSchema>;

// ---- Signals ----------------------------------------------------------------------------------

/** `POST /v1/tasks/:id/start`. `working_count` counts the accounts that have started, this one too. */
export const StartResponseSchema = z.object({
  ok: z.literal(true),
  working_count: U32Schema,
});
export type StartResponse = z.infer<typeof StartResponseSchema>;

/**
 * `POST /v1/telegram/link`. `url` opens the bot in Telegram with a one-time nonce; `expires_at` is
 * ISO 8601 in UTC to the millisecond.
 */
export const TelegramLinkSchema = z.object({
  url: z.string(),
  expires_at: z.iso.datetime(),
});
export type TelegramLink = z.infer<typeof TelegramLinkSchema>;

// ---- Events -----------------------------------------------------------------------------------

/**
 * The JSON in the `data` line of each message of `GET /v1/events`. `event` and `data` are the
 * event as the contract logged it; `height` is the block it was logged in, and `task_id` the task
 * it is about, null for an event that is about none, such as an agent registering.
 *
 * `event` is any name and `data` any object on purpose: a stream can carry an event that a client
 * written before it existed has no schema for, and that must not fail the message. To read a known
 * event, parse `{ event, data }` with `TenderEventSchema`.
 */
export const SseEventDataSchema = z.object({
  event: z.string(),
  data: z.record(z.string(), z.unknown()),
  height: U64StringSchema,
  task_id: U64StringSchema.nullable(),
});
export type SseEventData = z.infer<typeof SseEventDataSchema>;

// ---- Fetching ---------------------------------------------------------------------------------

/** The text of a failure that has a status and a body: the status, and the error code if any. */
function failureMessage(status: number, body: unknown): string {
  const error = ErrorBodySchema.safeParse(body);
  return `request failed with status ${status}${error.success ? ` (${error.data.error})` : ""}`;
}

/**
 * What `fetchJson` throws for an answer it cannot hand back: any answer that is not a 2xx, and a
 * 2xx whose body is not JSON or does not fit its schema. `status` is the HTTP status and `body` the
 * body: the parsed JSON when the text was JSON, else the text. When the body is our own error body
 * (`ErrorBodySchema`) its `error` code is in the message. A request that fails before there is an
 * answer (offline, refused, aborted) is not an `ApiError`: it is thrown as it came.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string = failureMessage(status, body)) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** The first fault of a failed parse: where it is (`tasks.0.reward`), and what is wrong there. */
function firstFault(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "the body";
  return `${issue.path.map(String).join(".") || "the body"}: ${issue.message}`;
}

/** `text` parsed as JSON, in an object because the JSON itself can be `null`. Null: not JSON. */
function parseJson(text: string): { json: unknown } | null {
  try {
    return { json: JSON.parse(text) };
  } catch {
    return null;
  }
}

/**
 * Fetches `url`, reads the answer as JSON and checks it against `schema`.
 *
 * - A 2xx with a body that fits `schema` gives the parsed value, which is `schema`'s own copy.
 * - Any other status throws an `ApiError` with that status and the body.
 * - A 2xx with a body that is not JSON, or does not fit `schema`, throws an `ApiError` with that
 *   status and the body too. For a body that does not fit, the message names the first path that
 *   failed, such as `tasks.0.reward`, and why.
 * - A fetch that rejects rejects `fetchJson` with the same error.
 *
 * `fetchImpl` stands in for the global `fetch`. Either is called as a function of its own and
 * never as a method of another object: a browser's `fetch` throws "Illegal invocation" when it is
 * called with a `this` that is not the window. Nothing here belongs to one runtime, so it runs in
 * a browser as it does in Node.
 */
export async function fetchJson<T>(
  url: string | URL,
  schema: z.ZodType<T>,
  init?: RequestInit,
  fetchImpl?: typeof fetch,
): Promise<T> {
  const doFetch = fetchImpl ?? fetch;
  const res = await doFetch(url, init);
  const text = await res.text();
  const body = parseJson(text);

  if (!res.ok) throw new ApiError(res.status, body === null ? text : body.json);
  if (body === null) {
    throw new ApiError(res.status, text, `response with status ${res.status} is not JSON`);
  }

  const parsed = schema.safeParse(body.json);
  if (!parsed.success) {
    throw new ApiError(
      res.status,
      body.json,
      `response with status ${res.status} does not fit its schema, first at ${firstFault(parsed.error)}`,
    );
  }
  return parsed.data;
}
