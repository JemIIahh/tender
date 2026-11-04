import {
  type AccountEntriesResponse,
  AccountEntriesResponseSchema,
  AccountIdSchema,
  type AgentDetailResponse,
  AgentDetailResponseSchema,
  type AgentSummary,
  AgentSummarySchema,
  ApiError,
  type BlobUpload,
  type BlobUploadResponse,
  BlobUploadResponseSchema,
  type ChallengeResponse,
  ChallengeResponseSchema,
  type ClarificationResponse,
  ClarificationResponseSchema,
  type CreateServiceRequest,
  fetchJson,
  type HealthResponse,
  HealthResponseSchema,
  HeldoutUploadResponseSchema,
  type ListAgentsFilter,
  type ListAgentsResponse,
  ListAgentsResponseSchema,
  type ListServicesFilter,
  type ListServicesResponse,
  ListServicesResponseSchema,
  type ListTasksFilter,
  type ListTasksResponse,
  ListTasksResponseSchema,
  type QuestionResponse,
  QuestionResponseSchema,
  type Scorecard,
  ScorecardSchema,
  type ServiceResponse,
  ServiceResponseSchema,
  type SignInResponse,
  SignInResponseSchema,
  type StartResponse,
  StartResponseSchema,
  type TaskBoard,
  TaskBoardSchema,
  type TaskDetailResponse,
  TaskDetailResponseSchema,
  type TelegramLinkResponse,
  TelegramLinkResponseSchema,
  U64StringSchema,
  type UpdateServiceRequest,
} from "@tender/shared";
import { toBase64 } from "./base64";
import { config } from "./config";
import { withTimeout } from "./timeout";

// The Tender API as the web app calls it, from the browser. Each function is one request, checked
// by `fetchJson` against the schema of `@tender/shared` for its answer, so every type here is the
// schema's. The names and the null-for-404 rule follow `TenderApi` (packages/shared/src/api.ts),
// which this is not an implementation of: the web app has no signer, so the calls that need an
// account take the bearer token as an argument (lib/auth.ts holds it, 06-T3).
//
// Any answer that is not a 2xx throws an `ApiError`, except that a 404 is null where a function
// says so. A request that fails before there is an answer (offline, refused) is thrown as it
// came, and so is one that gets none in time: a `TimeoutError`. `errorMessage` (lib/errors.ts)
// turns any of them into words for a person.
//
// An id is checked before anything is sent: a task id is a u64 as a decimal string, an account a
// NEAR account id. A page's address can hold anything, `..` among it, and a string that is no id
// is no task or agent, so a read of one thing gives null for it without asking. A call that has no
// null to give throws an `Error` that names the value.

/** How long a read may take before it is given up on. */
const READ_TIMEOUT_MS = 15_000;
/** How long a write may take. An upload of the largest result is a few hundred kilobytes. */
const WRITE_TIMEOUT_MS = 60_000;

const V1 = `${config.apiUrl}/v1`;

/** The schema type `fetchJson` takes, so that this file needs no import of zod. */
type Schema<T> = Parameters<typeof fetchJson<T>>[1];

type Query = Record<string, string | number | bigint | undefined>;

/** The address of `path` under `/v1`, with the query parameters that have a value. */
function url(path: string, query: Query = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return `${V1}${path}${text === "" ? "" : `?${text}`}`;
}

/**
 * `id` as the text of a task id, or undefined if it is none: a u64 as a decimal string. That is
 * digits and nothing else, so what passes can go into a path as it is.
 */
function taskIdText(id: bigint | string): string | undefined {
  const text = String(id);
  return U64StringSchema.safeParse(text).success ? text : undefined;
}

/**
 * `account` if it is a NEAR account id, else undefined. An id is lowercase letters and digits
 * joined by `.`, `-` or `_`, so it needs no escape in a path, and `.` and `..` are not ids.
 */
function accountIdText(account: string): string | undefined {
  return AccountIdSchema.safeParse(account).success ? account : undefined;
}

/** The error of a call that was given a value that is no id, thrown before any request. */
function notAnId(call: string, what: string, value: unknown): never {
  throw new Error(`${call}: ${JSON.stringify(String(value))} is not ${what}`);
}

function get<T>(path: string, schema: Schema<T>, query?: Query): Promise<T> {
  return withTimeout(READ_TIMEOUT_MS, (signal) => fetchJson(url(path, query), schema, { signal }));
}

function post<T>(
  path: string,
  schema: Schema<T>,
  { token, body }: { token?: string; body?: object } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return withTimeout(WRITE_TIMEOUT_MS, (signal) =>
    fetchJson(url(path), schema, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    }),
  );
}

/**
 * An agent with every field the API sent, the ones `AgentSummarySchema` names checked and any other
 * kept as it came. The agent bond (contract Task 16b: `status`, `bond_token`, `bond_amount`,
 * `claimable_at`) reaches the API after this app; the account pages read it from here when it is
 * there (lib/account.ts `bondOf`), and checking it is theirs.
 */
export type AgentRecord = AgentSummary & { readonly [field: string]: unknown };

const AgentRecordSchema = AgentSummarySchema.loose();
const AgentRecordsSchema = ListAgentsResponseSchema.extend({ agents: AgentRecordSchema.array() });
const AgentRecordDetailSchema = AgentDetailResponseSchema.extend({ agent: AgentRecordSchema });

/** What a read finds when the API has no such thing: null. Any other failure is thrown. */
async function orNull<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * A sign-in challenge (`authChallenge`) with the wallet's signature of it, which is what
 * `POST /v1/auth/verify` takes. `signature` and `nonce` are base64, `publicKey` is
 * `ed25519:<base58>`; `nonce`, `message` and `recipient` are the challenge's, unchanged.
 */
export interface SignedChallenge {
  accountId: string;
  publicKey: string;
  signature: string;
  nonce: string;
  message: string;
  recipient: string;
}

export const api = {
  // ---- Reads ----------------------------------------------------------------------------------

  /** `GET /v1/tasks`: one page of tasks, newest first. */
  listTasks(filter: ListTasksFilter = {}): Promise<ListTasksResponse> {
    const { phase, tag, poster, verifier, parent, limit, cursor } = filter;
    return get("/tasks", ListTasksResponseSchema, {
      phase,
      tag,
      poster,
      verifier,
      parent,
      limit,
      // A null cursor, as a page's next_cursor can be, asks for the first page.
      cursor: cursor ?? undefined,
    });
  },

  /**
   * `GET /v1/tasks/:id`: one task with its entries and funders; null if there is no such task. The
   * id is a bigint, or the string an address holds: a string that is no id is no task, so null,
   * and nothing is sent.
   */
  async getTask(id: bigint | string): Promise<TaskDetailResponse | null> {
    const task = taskIdText(id);
    if (task === undefined) return null;
    return orNull(get(`/tasks/${task}`, TaskDetailResponseSchema));
  },

  /** `GET /v1/agents`: one page of registered agents, in the order of their accounts. */
  listAgents(filter: ListAgentsFilter = {}): Promise<ListAgentsResponse> {
    const { tag, asp, limit, cursor } = filter;
    return get("/agents", ListAgentsResponseSchema, {
      tag,
      asp,
      limit,
      cursor: cursor ?? undefined,
    });
  },

  /**
   * `GET /v1/agents/:account`: an agent and its recent entries; null if there is no such agent. A
   * string that is no account id is no agent, so null, and nothing is sent.
   */
  async getAgent(account: string): Promise<AgentDetailResponse | null> {
    const agent = accountIdText(account);
    if (agent === undefined) return null;
    return orNull(get(`/agents/${agent}`, AgentDetailResponseSchema));
  },

  /** `GET /v1/agents`, as `listAgents`, with the fields of each agent the schema does not name kept. */
  listAgentRecords(
    filter: ListAgentsFilter = {},
  ): Promise<{ agents: AgentRecord[]; next_cursor: string | null }> {
    const { tag, asp, limit, cursor } = filter;
    return get("/agents", AgentRecordsSchema, {
      tag,
      asp,
      limit,
      cursor: cursor ?? undefined,
    });
  },

  /** `GET /v1/agents/:account`, as `getAgent`, with the fields of the agent the schema does not name kept. */
  async getAgentRecord(
    account: string,
  ): Promise<{ agent: AgentRecord; recent_entries: AgentDetailResponse["recent_entries"] } | null> {
    const agent = accountIdText(account);
    if (agent === undefined) return null;
    return orNull(get(`/agents/${agent}`, AgentRecordDetailSchema));
  },

  /**
   * `GET /v1/entries?account=`: every entry of one account, newest commit first. It throws for a
   * string that is no account id, as the API would answer 400, without asking.
   */
  async listEntries(account: string): Promise<AccountEntriesResponse> {
    const owner = accountIdText(account) ?? notAnId("listEntries", "a NEAR account id", account);
    return get("/entries", AccountEntriesResponseSchema, { account: owner });
  },

  /**
   * `GET /v1/scorecards/:task_id`: the scorecard a task was settled with; null if it has none, as
   * for an id that is no task id.
   */
  async getScorecard(taskId: bigint | string): Promise<Scorecard | null> {
    const task = taskIdText(taskId);
    if (task === undefined) return null;
    return orNull(get(`/scorecards/${task}`, ScorecardSchema));
  },

  /**
   * `GET /v1/tasks/:id/questions`: the task's public question board, every question and every
   * clarification oldest first; null if the API has none for it (no such task, or an API from
   * before the board), as for an id that is no task id.
   */
  async getQuestions(taskId: bigint | string): Promise<TaskBoard | null> {
    const task = taskIdText(taskId);
    if (task === undefined) return null;
    return orNull(get(`/tasks/${task}/questions`, TaskBoardSchema));
  },

  /** `GET /v1/health`: how far the index is behind the chain; a 503 throws an `ApiError`. */
  health(): Promise<HealthResponse> {
    return get("/health", HealthResponseSchema);
  },

  /** `GET /v1/services`: one page of services, newest first; those that can be hired by default. */
  listServices(filter: ListServicesFilter = {}): Promise<ListServicesResponse> {
    const { q, tag, provider, agent, token, maxPrice, status, limit, cursor } = filter;
    return get("/services", ListServicesResponseSchema, {
      q,
      tag,
      provider,
      agent,
      token,
      max_price: maxPrice,
      status,
      limit,
      cursor: cursor ?? undefined,
    });
  },

  /**
   * `GET /v1/services/:id`: one service, whatever its status; null if there is none. A string that
   * is no id is no service, so null, and nothing is sent.
   */
  async getService(id: bigint | string): Promise<ServiceResponse | null> {
    const service = taskIdText(id);
    if (service === undefined) return null;
    return orNull(get(`/services/${service}`, ServiceResponseSchema));
  },

  // ---- Writes ---------------------------------------------------------------------------------

  /** `POST /v1/auth/challenge`: a nonce, and the message and recipient to have a wallet sign. */
  authChallenge(): Promise<ChallengeResponse> {
    return post("/auth/challenge", ChallengeResponseSchema);
  },

  /** `POST /v1/auth/verify`: the signed challenge, for the bearer token. It is shown once. */
  authVerify(signed: SignedChallenge): Promise<SignInResponse> {
    return post("/auth/verify", SignInResponseSchema, {
      body: {
        account_id: signed.accountId,
        public_key: signed.publicKey,
        signature: signed.signature,
        nonce: signed.nonce,
        message: signed.message,
        recipient: signed.recipient,
      },
    });
  },

  /** `POST /v1/blobs`: stores a brief, criteria, result, scorecard or profile. Needs a token. */
  uploadBlob(token: string, blob: BlobUpload): Promise<BlobUploadResponse> {
    return post("/blobs", BlobUploadResponseSchema, {
      token,
      body: {
        kind: blob.kind,
        content_type: blob.contentType,
        content_base64: toBase64(blob.bytes),
        ...(blob.taskId === undefined ? {} : { task_id: blob.taskId.toString() }),
      },
    });
  },

  /** `POST /v1/heldout`: stores a held-out document, which no one can read back. Needs a token. */
  async uploadHeldout(token: string, commitment: string, bytes: Uint8Array): Promise<void> {
    await post("/heldout", HeldoutUploadResponseSchema, {
      token,
      body: { commitment, content_base64: toBase64(bytes) },
    });
  },

  /**
   * `POST /v1/tasks/:id/start`: says this account has started on an open task. Needs a token. It
   * throws for an id that is no task id, without asking.
   */
  async start(token: string, taskId: bigint | string): Promise<StartResponse> {
    const task = taskIdText(taskId) ?? notAnId("start", "a task id", taskId);
    return post(`/tasks/${task}/start`, StartResponseSchema, { token });
  },

  /** `POST /v1/services`: lists a service of one of the signed-in account's agents. */
  createService(token: string, body: CreateServiceRequest): Promise<ServiceResponse> {
    return post("/services", ServiceResponseSchema, { token, body });
  },

  /**
   * `POST /v1/services/:id`: changes, pauses or resumes one of the signed-in account's services. It
   * throws for an id that is no service's, without asking.
   */
  async updateService(
    token: string,
    id: string,
    body: UpdateServiceRequest,
  ): Promise<ServiceResponse> {
    const service = taskIdText(id) ?? notAnId("updateService", "a service id", id);
    return post(`/services/${service}`, ServiceResponseSchema, { token, body });
  },

  /** `POST /v1/telegram/link`: a one-time link from this account to the bot. Needs a token. */
  telegramLink(token: string): Promise<TelegramLinkResponse> {
    return post("/telegram/link", TelegramLinkResponseSchema, { token });
  },

  // ---- The question board (spec 7.2.1). Each needs a token, and throws for an id that is no
  // task's or question's without asking. `text` is sent as it was typed: the API trims it and
  // holds it to its rules, and the page shows its refusal (lib/questions.ts).

  /** `POST /v1/tasks/:id/questions`: an entrant asks the poster a question, in public. */
  async askQuestion(
    token: string,
    taskId: bigint | string,
    text: string,
  ): Promise<QuestionResponse> {
    const task = taskIdText(taskId) ?? notAnId("askQuestion", "a task id", taskId);
    return post(`/tasks/${task}/questions`, QuestionResponseSchema, { token, body: { text } });
  },

  /** `POST /v1/tasks/:id/questions/:question_id/answer`: the poster answers a question. */
  async answerQuestion(
    token: string,
    taskId: bigint | string,
    questionId: string,
    text: string,
  ): Promise<QuestionResponse> {
    const task = taskIdText(taskId) ?? notAnId("answerQuestion", "a task id", taskId);
    const question =
      taskIdText(questionId) ?? notAnId("answerQuestion", "a question id", questionId);
    return post(`/tasks/${task}/questions/${question}/answer`, QuestionResponseSchema, {
      token,
      body: { text },
    });
  },

  /** `POST /v1/tasks/:id/questions/:question_id/hide`: the poster hides a question for good. */
  async hideQuestion(
    token: string,
    taskId: bigint | string,
    questionId: string,
  ): Promise<QuestionResponse> {
    const task = taskIdText(taskId) ?? notAnId("hideQuestion", "a task id", taskId);
    const question = taskIdText(questionId) ?? notAnId("hideQuestion", "a question id", questionId);
    return post(`/tasks/${task}/questions/${question}/hide`, QuestionResponseSchema, { token });
  },

  /** `POST /v1/tasks/:id/clarifications`: the poster posts a clarification of the brief. */
  async postClarification(
    token: string,
    taskId: bigint | string,
    text: string,
  ): Promise<ClarificationResponse> {
    const task = taskIdText(taskId) ?? notAnId("postClarification", "a task id", taskId);
    return post(`/tasks/${task}/clarifications`, ClarificationResponseSchema, {
      token,
      body: { text },
    });
  },
};
