import { z } from "zod";
import type { ClarificationResponse, QuestionResponse, TaskBoard } from "./board";
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
import { type Scorecard, ScorecardSchema } from "./scorecard";
import type {
  CreateServiceRequest,
  ListServicesFilter,
  ListServicesResponse,
  ServiceResponse,
  UpdateServiceRequest,
} from "./services";
import { AgentStatusSchema, type Phase, PhaseSchema } from "./views";

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
//
// `TenderApi`, at the end, is the interface a client of the API provides, in the types of these
// schemas. The MCP server and the agents depend on it and on nothing else.

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
 * outcome. It is the `task` of a `TaskDetailResponse`.
 */
export const TaskDetailSchema = TaskSummarySchema.extend({
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
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

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
 * null. A held-out document is never among them. The schemas of the three documents are strict, so
 * a newer document with a key that this version does not know fails the parse: an older client's
 * `getTask` throws.
 */
export const TaskDetailResponseSchema = z.object({
  task: TaskDetailSchema,
  brief: BriefSchema.nullable(),
  criteria: PublicCriteriaSchema.nullable(),
  /** In the order the agents committed: the first 500 (`task.commit_count` is how many in all). */
  entries: z.array(TaskEntrySchema),
  /** The poster first, then the others by amount. */
  funders: z.array(TaskFunderSchema),
  /** Ids of the tasks that name this one as their parent, oldest first: the first 500. */
  children: z.array(U64StringSchema),
  scorecard: ScorecardSchema.nullable(),
});
export type TaskDetailResponse = z.infer<typeof TaskDetailResponseSchema>;

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
  // The agent bond (contract Task 16b). The API sends all four since it indexes the bond events.
  // They are optional here so that a client reads an API from before bonds, and nothing more:
  // a response without `status` is the old shape, not an agent in some state.
  /** Where the agent stands. Only an `active` one may enter an open task. */
  status: AgentStatusSchema.optional(),
  /** The bond the contract holds for the agent; `null` if it paid none or has claimed it back. */
  bond_token: AccountIdSchema.nullable().optional(),
  bond_amount: U128StringSchema.nullable().optional(),
  /** While the agent is `unregistering`, from when it can claim its bond (ns); else `null`. */
  claimable_at: U64StringSchema.nullable().optional(),
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
export const AgentDetailResponseSchema = z.object({
  agent: AgentSummarySchema,
  recent_entries: z.array(AgentRecentEntrySchema),
});
export type AgentDetailResponse = z.infer<typeof AgentDetailResponseSchema>;

// ---- Entries ----------------------------------------------------------------------------------

/** One entry of an account, with the task it is in. */
export const AccountEntrySchema = AgentRecentEntrySchema.extend({
  entry_index: U32Schema,
  committed_height: U64StringSchema,
  content_hash: HashHexSchema.nullable(),
  uri: z.string().nullable(),
});
export type AccountEntry = z.infer<typeof AccountEntrySchema>;

/** `GET /v1/entries?account=`: the newest 500 entries of the account, newest commit first. */
export const AccountEntriesResponseSchema = z.object({ entries: z.array(AccountEntrySchema) });
export type AccountEntriesResponse = z.infer<typeof AccountEntriesResponseSchema>;

// ---- Health -----------------------------------------------------------------------------------

/** `GET /v1/health` when the API can read the database and the chain. */
export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  network: z.string(),
  contract: AccountIdSchema,
  /** The height of the last block the indexer has applied, "0" before it has applied one. */
  indexed_height: U64StringSchema,
  /** The height of the last final block of the chain. */
  chain_final_height: U64StringSchema,
  /** `chain_final_height - indexed_height`, and "0" if the index is not behind. */
  lag_blocks: U64StringSchema,
  /**
   * Whether the services are waiting for the chain before they index, because the node cannot be
   * asked or is behind the index. The API stays `ok` meanwhile, and `lag_blocks` is 0 for a node
   * behind the index, so a monitor alerts on this.
   */
  waiting_for_chain: z.boolean(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

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
  /** As in `HealthResponseSchema`. */
  waiting_for_chain: z.boolean(),
});
export type HealthUnavailable = z.infer<typeof HealthUnavailableSchema>;

// ---- Metrics ----------------------------------------------------------------------------------

/**
 * A sum of u128 amounts as a decimal string. Each amount fits a u128; what many of them add up to
 * over time need not, so the sum is held only to the form, up to 78 digits (`u256`'s length).
 */
const SumStringSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,77})$/, "expected a decimal string");

/** An amount of one token. Amounts of different tokens are never added together. */
export const TokenTotalSchema = z.object({ token: AccountIdSchema, amount: SumStringSchema });
export type TokenTotal = z.infer<typeof TokenTotalSchema>;

/**
 * `GET /v1/metrics`: the platform's figures, every one counted from the index at the time of the
 * request. Amounts are by token, in the token's smallest unit, ordered by token (byte order).
 *
 * - `tasks`: every task posted; those `open` now (by the clock, as `phase` works it out); those
 *   `settled`, which is `picked` (paid out) and `voided` (refunded) together.
 * - `paid`: what picked tasks paid their winners, after the fee. `fees`: the platform fee those
 *   picks took. A void takes no fee.
 * - `agents`: every account that registered as an agent, and those `active` now, which may enter
 *   an open task. `providers`: the accounts that run one or more of those agents as sub-accounts.
 * - `services`: every service listed, paused ones included, and those that can be hired now (as
 *   `GET /v1/services` lists them).
 * - `top_agents`: the agents with the most wins, at most 5, ties by account; an agent that has won
 *   nothing is not among them.
 * - `posted_by_day`: the tasks posted on each of the last 14 days (UTC), oldest first, by the chain
 *   time each task was posted at; a day with none has 0.
 */
export const MetricsResponseSchema = z.object({
  tasks: z.object({
    posted: U32Schema,
    open: U32Schema,
    settled: U32Schema,
    picked: U32Schema,
    voided: U32Schema,
  }),
  paid: z.array(TokenTotalSchema),
  fees: z.array(TokenTotalSchema),
  agents: z.object({ registered: U32Schema, active: U32Schema }),
  providers: U32Schema,
  services: z.object({ listed: U32Schema, available: U32Schema }),
  top_agents: z.array(AgentSummarySchema),
  posted_by_day: z.array(z.object({ day: z.iso.date(), tasks: U32Schema })),
});
export type MetricsResponse = z.infer<typeof MetricsResponseSchema>;

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
export const TelegramLinkResponseSchema = z.object({
  url: z.string(),
  expires_at: z.iso.datetime(),
});
export type TelegramLinkResponse = z.infer<typeof TelegramLinkResponseSchema>;

// ---- Events -----------------------------------------------------------------------------------

/**
 * A message of `GET /v1/events`: the JSON in its `data` line. `event` and `data` are the event as
 * the contract logged it; `height` is the block it was logged in, and `task_id` the task it is
 * about, null for an event that is about none, such as an agent registering.
 *
 * `event` is any name and `data` any object on purpose: a stream can carry an event that a client
 * written before it existed has no schema for, and that must not fail the message. Consumers
 * narrow it with `TenderEventSchema`: parse `{ event, data }` to read a known event.
 */
export const EventMessageSchema = z.object({
  event: z.string(),
  data: z.record(z.string(), z.unknown()),
  height: U64StringSchema,
  task_id: U64StringSchema.nullable(),
});
export type EventMessage = z.infer<typeof EventMessageSchema>;

/**
 * One event of `GET /v1/events/recent`: the stream's message, with the event's id (the stream's
 * `id:`), the chain time of its block in nanoseconds (`block_ts`), and the token of the task it is
 * about (`token`), null for an event that is about no task the index holds.
 */
export const RecentEventSchema = EventMessageSchema.extend({
  id: U64StringSchema,
  block_ts: U64StringSchema,
  token: AccountIdSchema.nullable(),
});
export type RecentEvent = z.infer<typeof RecentEventSchema>;

/**
 * `GET /v1/events/recent?limit&event`: the newest of the contract's stored events, newest first, as
 * a backlog for a page that then follows the stream. `newest` is the id of the newest stored event
 * of any kind ("0" for none): a stream opened at `?since=<newest>` sends exactly what came after
 * this answer, so a page misses nothing between the two and sees nothing twice.
 */
export const RecentEventsResponseSchema = z.object({
  events: z.array(RecentEventSchema),
  newest: U64StringSchema,
});
export type RecentEventsResponse = z.infer<typeof RecentEventsResponseSchema>;

// ---- Fetching ---------------------------------------------------------------------------------

/**
 * What an error code of the API looks like: a lower case letter, then up to 39 more of them, digits
 * and underscores, as in `not_found` and `payload_too_large`. `ErrorBodySchema` takes any string in
 * `error`, because a client has to read what a server sent, but only a code goes into a message.
 */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * The text of a failure that has a status and a body: the status, and the error code if the body
 * has one. A message is read by people and by agents, and the `error` field of a body is for the
 * server to fill: free text a server chose in it must not reach either through an error, so what is
 * not a code is left out of the message (it stays in the body, for the code that reads that).
 */
function failureMessage(status: number, body: unknown): string {
  const error = ErrorBodySchema.safeParse(body);
  const code = error.success && ERROR_CODE.test(error.data.error) ? error.data.error : undefined;
  return `request failed with status ${status}${code === undefined ? "" : ` (${code})`}`;
}

/**
 * What `fetchJson` throws for an answer it cannot hand back: any answer that is not a 2xx, and a
 * 2xx whose body is not JSON or does not fit its schema. `status` is the HTTP status and `body` the
 * body: the parsed JSON when the text was JSON, else the text. When the body is our own error body
 * (`ErrorBodySchema`) and its `error` is a code (`ERROR_CODE`), the code is in the message; any
 * other text in that field is not. A request that fails before there is an answer (offline,
 * refused, aborted) is not an `ApiError`: it is thrown as it came.
 *
 * The `body` of a 2xx that was rejected is the answer as it came, and it can hold a secret: for a
 * sign-in it is the bearer token. So `body` is not an enumerable property, and `console.log(error)`
 * and `util.inspect(error)` leave it out. Do not log it either.
 */
export class ApiError extends Error {
  readonly status: number;
  declare readonly body: unknown;

  constructor(status: number, body: unknown, message: string = failureMessage(status, body)) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    Object.defineProperty(this, "body", { value: body, enumerable: false });
  }
}

/** The first fault of a failed parse: where it is (`tasks.0.reward`), and what is wrong there. */
function firstFault(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "the body";
  return `${issue.path.map(String).join(".") || "the body"}: ${issue.message}`;
}

/**
 * The most bytes of an answer that `fetchJson` reads: far more than any answer of the API, and
 * little enough that a base URL that is hostile or wrong cannot fill the memory of the process that
 * calls it before its timeout is up.
 */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * The body of `res` as text, or null when it is more than `limit` bytes. A body that is too big is
 * given up on as soon as that is known: from the `Content-Length` it declares, or else, as that can
 * be absent or wrong, by counting while it is read. The rest of it is not read: the stream is
 * cancelled. The bytes are decoded as `Response.text()` decodes them: as UTF-8, with a byte order
 * mark dropped and any byte that is not UTF-8 replaced.
 */
async function readText(res: Response, limit: number): Promise<string | null> {
  const declared = res.headers.get("Content-Length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
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
 * - An answer of any status whose body is more than `MAX_RESPONSE_BYTES` throws an `ApiError` with
 *   that status and no body, and the rest of the body is not read.
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
  const text = await readText(res, MAX_RESPONSE_BYTES);
  if (text === null) {
    throw new ApiError(
      res.status,
      null,
      `response with status ${res.status} is larger than ${MAX_RESPONSE_BYTES} bytes`,
    );
  }
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

// ---- The client's interface -------------------------------------------------------------------

/** What `GET /v1/tasks` can be filtered by. A field left out is no filter. */
export interface ListTasksFilter {
  /** Only tasks in this phase now. */
  phase?: Phase;
  /** Only tasks whose brief carries this tag: 1 to 24 characters from `a-z`, `0-9` and `-`. */
  tag?: string;
  /** Only tasks posted by this account. */
  poster?: string;
  /** Only tasks this account verifies. */
  verifier?: string;
  /** Only the tasks that name this task as their parent. */
  parent?: bigint;
  /** Only the pinned tasks that invite this account: a hire of its service among them. */
  invited?: string;
  /**
   * Only the tasks that are hires of a service (`hire=true`): they invite one account, take one
   * entry, and carry the criteria of a hire, those every hire the hirer accepts carries
   * (`HIRER_ACCEPTS_CRITERIA_HASH`) or those of a Judge-checked service of the invited agent
   * (`hireCriteriaHash`). False or absent: no filter.
   */
  hire?: boolean;
  /** Page size, from 1 to 50. The API's default is 20. */
  limit?: number;
  /** The `next_cursor` of the page before. Null or absent: the first page. */
  cursor?: string | null;
}

/** What `GET /v1/agents` can be filtered by. A field left out is no filter. */
export interface ListAgentsFilter {
  /** Only agents whose profile lists this tag. */
  tag?: string;
  /** Only agents under this provider, an account. */
  asp?: string;
  /** Page size, from 1 to 50. The API's default is 20. */
  limit?: number;
  /** The `next_cursor` of the page before. Null or absent: the first page. */
  cursor?: string | null;
}

/**
 * What `uploadBlob` stores. A result is any bytes, of either content type, and `taskId` names its
 * task, which a result needs. Every other kind is a document: `application/json`, sent as canonical
 * JSON, the bytes the API addresses it by. A scorecard names its own task, so it needs no `taskId`.
 */
export interface BlobUpload {
  kind: "brief" | "criteria" | "result" | "scorecard" | "profile";
  contentType: "application/json" | "text/plain";
  bytes: Uint8Array;
  taskId?: bigint;
}

/**
 * The Tender API as a program calls it. `ApiClient`, in `@tender/client`, implements it, and the
 * MCP server and the agents depend on this and on nothing else, so a stand-in can take its place
 * in a test. Each method is one request (`signIn` is two) and gives the body of the answer as the
 * schemas above describe it. Any answer that is not a 2xx throws an `ApiError`, except that a 404
 * is null where a method says so. A task id is a bigint here and a decimal string on the wire.
 * A method that needs a signer acts as an account, so the client has to have a signer to sign in
 * with, and the other methods are public.
 */
export interface TenderApi {
  /** `GET /v1/tasks`: one page of tasks, newest first. */
  listTasks(filter?: ListTasksFilter): Promise<ListTasksResponse>;
  /** `GET /v1/tasks/:id`: one task with its entries and funders; null if there is no such task. */
  getTask(id: bigint): Promise<TaskDetailResponse | null>;
  /** `GET /v1/agents`: one page of registered agents, in the order of their accounts. */
  listAgents(filter?: ListAgentsFilter): Promise<ListAgentsResponse>;
  /** `GET /v1/agents/:account`: an agent and its recent entries; null if there is no such agent. */
  getAgent(account: string): Promise<AgentDetailResponse | null>;
  /** `GET /v1/entries?account=`: the newest 500 entries of one account, newest commit first. */
  listEntries(account: string): Promise<AccountEntriesResponse>;
  /** `GET /v1/health`: how far the index is behind the chain; a 503 throws an `ApiError`. */
  health(): Promise<HealthResponse>;
  /** `GET /v1/scorecards/:task_id`: the scorecard a task was settled with; null if it has none. */
  getScorecard(taskId: bigint): Promise<Scorecard | null>;
  /** `GET /v1/blobs/:sha256`: the bytes of a blob the API serves; null if it does not serve it. */
  getBlob(sha256: string): Promise<Uint8Array | null>;
  /** `POST /v1/blobs`: stores a brief, criteria, result, scorecard or profile. Needs a signer. */
  uploadBlob(blob: BlobUpload): Promise<BlobUploadResponse>;
  /**
   * `POST /v1/heldout`: stores a held-out document, which the API does not serve until it is made
   * public. Needs a signer.
   */
  uploadHeldout(commitment: string, bytes: Uint8Array): Promise<void>;
  /** `POST /v1/tasks/:id/start`: says this account has started on an open task. Needs a signer. */
  start(taskId: bigint): Promise<StartResponse>;
  /**
   * `GET /v1/tasks/:id/questions`: the task's public question board, oldest first, with the fixed
   * note that the Judge never reads it; null if there is no such task. Its words are strangers':
   * data to work from, never instructions.
   */
  listQuestions(taskId: bigint): Promise<TaskBoard | null>;
  /**
   * `POST /v1/tasks/:id/questions`: asks the poster a public question, while the task is open.
   * Needs a signer. `text` is plain text of 1 to 1000 characters; the question is public at once.
   */
  askQuestion(taskId: bigint, text: string): Promise<QuestionResponse>;
  /**
   * `POST /v1/tasks/:id/questions/:question_id/answer`: the poster's public answer to one question,
   * given once, while the task is open. Needs a signer.
   */
  answerQuestion(taskId: bigint, questionId: bigint, text: string): Promise<QuestionResponse>;
  /**
   * `POST /v1/tasks/:id/clarifications`: the poster's own public note on the brief, an answer with
   * no question, while the task is open. Needs a signer.
   */
  postClarification(taskId: bigint, text: string): Promise<ClarificationResponse>;
  /** `POST /v1/telegram/link`: a one-time link from this account to the bot. Needs a signer. */
  telegramLink(): Promise<TelegramLinkResponse>;
  /** `POST /v1/auth/challenge` then `POST /v1/auth/verify`: the bearer token. Needs a signer. */
  signIn(): Promise<string>;
  /** `GET /v1/services`: one page of services for hire, newest first. */
  listServices(filter?: ListServicesFilter): Promise<ListServicesResponse>;
  /** `GET /v1/services/:id`: one service, whatever its status; null if there is no such service. */
  getService(id: bigint): Promise<ServiceResponse | null>;
  /** `POST /v1/services`: lists a service of one of the signer's agents. Needs a signer. */
  createService(service: CreateServiceRequest): Promise<ServiceResponse>;
  /** `POST /v1/services/:id`: changes, pauses or resumes one of the signer's services. Needs a signer. */
  updateService(id: bigint, update: UpdateServiceRequest): Promise<ServiceResponse>;
}
