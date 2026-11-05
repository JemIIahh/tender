import {
  type AccountEntriesResponse,
  AccountEntriesResponseSchema,
  type AgentDetailResponse,
  AgentDetailResponseSchema,
  ApiError,
  type BlobUpload,
  type BlobUploadResponse,
  BlobUploadResponseSchema,
  ChallengeResponseSchema,
  type ClarificationResponse,
  ClarificationResponseSchema,
  type ConnectLookup,
  ConnectLookupSchema,
  type ConnectRegistered,
  ConnectRegisteredSchema,
  type CreateServiceRequest,
  canonicalBase,
  fetchJson,
  type HealthResponse,
  HealthResponseSchema,
  HeldoutUploadResponseSchema,
  hexToBytes,
  type ListAgentsFilter,
  type ListAgentsResponse,
  ListAgentsResponseSchema,
  type ListServicesFilter,
  type ListServicesResponse,
  ListServicesResponseSchema,
  type ListTasksFilter,
  type ListTasksResponse,
  ListTasksResponseSchema,
  MAX_RESULT_BYTES,
  type QuestionResponse,
  QuestionResponseSchema,
  type Scorecard,
  ScorecardSchema,
  type ServiceResponse,
  ServiceResponseSchema,
  SIGN_IN_MESSAGE,
  SignInResponseSchema,
  type StartResponse,
  StartResponseSchema,
  sha256Hex,
  type TaskBoard,
  TaskBoardSchema,
  type TaskDetailResponse,
  TaskDetailResponseSchema,
  type TelegramLinkResponse,
  TelegramLinkResponseSchema,
  type TenderApi,
  type UpdateServiceRequest,
} from "@tender/shared";
import { KeyPair, type KeyPairString } from "near-api-js";
import type { Signer } from "./client";
import { serializeNep413 } from "./nep413";

/** How long before a token expires the client stops using it and signs in again. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** How many bytes go to `String.fromCharCode` in one call, which takes them as arguments. */
const BASE64_CHUNK = 0x8000;

/** Hosts that are this machine, where plain http cannot be read or changed on the way. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A nonce as the API makes it: 32 bytes in base64, which is 43 characters and one `=`. */
const NONCE_SHAPE = /^[A-Za-z0-9+/]{43}=$/;

/** How long a request may take unless `timeoutMs` says otherwise. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The longest wait `setTimeout` keeps: it runs anything above this after 1 ms instead. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * A request that was not answered in time. It names the method of the client that sent it, which
 * is `signIn` for the two requests of a sign-in, and the time it was given. It holds nothing else:
 * not the URL, and not a word of what the server sent or of what was sent to it. It is not an
 * `ApiError`, as the server did not answer.
 */
export class ApiTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`ApiClient.${method} timed out after ${timeoutMs} ms`);
    this.name = "ApiTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A request to the API that got no answer at all: nothing listens at the address, its name does not
 * resolve, or the connection was refused or cut. It names the API's base, as `canonicalBase` reads
 * it, which holds no user name, password, query or fragment, and a space follows it in the message.
 * Of the error `fetch` gave, which is its `cause`, the message only names the code (`ECONNREFUSED`).
 */
export class ApiUnreachableError extends Error {
  /** The API's base, as `canonicalBase` reads it: `http://127.0.0.1:8787`. */
  readonly base: string;

  constructor(base: string, cause: unknown) {
    const code =
      cause instanceof Error ? (cause.cause as { code?: unknown } | undefined)?.code : undefined;
    const said = cause instanceof Error ? cause.message : String(cause);
    super(
      `could not reach the Tender API at ${base} (${said}${typeof code === "string" ? `, ${code}` : ""})`,
      { cause },
    );
    this.name = "ApiUnreachableError";
    this.base = base;
  }
}

/**
 * Whether `error` is `fetch` getting no answer: undici's `TypeError("fetch failed")`, or a
 * `TypeError` whose cause has a system code (`ECONNREFUSED`, `ENOTFOUND`). Other `TypeError`s of
 * `fetch` are mistakes of the request itself (a header value it refuses, say), and not the address.
 * The chain client's calls fail the same way when the RPC node does not answer.
 */
export function isNoAnswer(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const code = (error.cause as { code?: unknown } | null | undefined)?.code;
  return error.message === "fetch failed" || typeof code === "string";
}

/**
 * `fetchImpl` (the global `fetch`, looked up at each call, by default) for an `ApiClient` of
 * `baseUrl`, whose requests that get no answer at all fail with an `ApiUnreachableError` that names
 * the base, in place of `fetch`'s bare "fetch failed". For a command line or a server whose reader
 * set the address, and needs to see which one did not answer. A request that was cancelled (by its
 * timeout or a signal) fails as it did, and so does a failure that is not one of the network's.
 */
export function fetchNamingApi(baseUrl: string, fetchImpl?: typeof fetch): typeof fetch {
  const base = canonicalBase(baseUrl);
  return async (input, init) => {
    // A local, so that it is called as a function of its own and not as a method of anything.
    const doFetch = fetchImpl ?? fetch;
    try {
      return await doFetch(input, init);
    } catch (error) {
      if (init?.signal?.aborted === true || !isNoAnswer(error)) throw error;
      throw new ApiUnreachableError(base, error);
    }
  };
}

export interface ApiClientOptions {
  /**
   * Where the API is served, as `PUBLIC_API_URL` has it: `https://api.example`. The client adds
   * `/v1`, so a trailing slash and a trailing `/v1` are both dropped. It is read once, by
   * `canonicalBase`, when the client is made, and a base that `canonicalBase` refuses (a query, a
   * fragment, a user name or password, an empty path segment `//`, a repeated `/v1`, a dot at the
   * end of the host, or no host) throws then, with a signer or without one. Every request and the
   * recipient of the sign-in come from that one reading. With a `signer` it must be https, or http
   * to this machine (`localhost`, `127.0.0.1` or `[::1]`): the signature and the bearer token travel
   * to it. It is also whom the sign-in is signed for (the scheme, the host, the port if that is not
   * the default, and the path), so it has to name the API as the API's own `PUBLIC_API_URL` does: an
   * API reached under another name, an address in place of its domain, say, is refused at sign-in.
   */
  baseUrl: string;
  /**
   * The account to act as, and the key of it to sign in with. Without one, the public methods work
   * and the others throw before they send anything.
   */
  signer?: Signer;
  /**
   * Stands in for the global `fetch`. It is called as a function of its own, never as a method of
   * the client or of anything else: a browser's `fetch` throws "Illegal invocation" otherwise.
   */
  fetchImpl?: typeof fetch;
  /**
   * The time in milliseconds since the epoch, which decides when a token is due to be replaced.
   * Default: `Date.now`. It is called as a function of its own, like `fetchImpl`.
   */
  now?: () => number;
  /**
   * How long one request may take, from when it is sent to the last byte of its answer, in
   * milliseconds: from 1 to 2147483647. Default: 30000. A request that is not answered in time is
   * cancelled, and its call fails with an `ApiTimeoutError`. The time is that of each request and
   * not of a call: a call that has to sign in first sends three.
   */
  timeoutMs?: number;
  /**
   * Cancels the calls of this client. A request in flight is cancelled and its call fails with the
   * reason of the signal, and a call made once it has aborted fails with that reason before it
   * sends anything. It works with `timeoutMs`: whichever comes first ends the request.
   */
  signal?: AbortSignal;
}

/** A bearer token, and the time (ms since the epoch) from which the client no longer uses it. */
interface Session {
  token: string;
  refreshAt: number;
}

/** The text of a failed answer read as JSON when it is JSON, as `fetchJson` reads one. */
function bodyOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `promise`, or null when it failed with a 404: how the API says that something is not there. */
async function orNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** The `?name=value&...` of the fields that are set, or nothing if none is. Null is not set. */
function queryOf(fields: Record<string, string | number | bigint | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) query.set(name, String(value));
  }
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

/**
 * Standard base64 with padding, which is what the API reads. `btoa` takes text, so the bytes are
 * turned into it a chunk at a time: a result can be 256 KiB, which is more than a call can take as
 * arguments.
 */
function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(text);
}

/**
 * The `init` of a GET, which `signal` cancels. No request of the client follows a redirect, this
 * one or a POST: the API never redirects, and the server at `baseUrl` could use one to send what a
 * request holds (the signature of a sign-in, a brief, the bearer token) on to a place of its
 * choosing, over plain http even. A redirect fails the request with the error `fetch` gives for it.
 */
function get(signal: AbortSignal): RequestInit {
  return { redirect: "error", signal };
}

/**
 * The `init` of a POST, which `signal` cancels: signed in as the owner of `token` if there is one,
 * with `body` as JSON.
 */
function post(signal: AbortSignal, token?: string, body?: unknown): RequestInit {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return {
    method: "POST",
    redirect: "error",
    signal,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/**
 * Throws unless `base`, a canonical base, is https, or http to this machine. A client with a signer
 * sends the server a signature and then its bearer token: over plain http to another host the
 * challenge can be swapped on the way and the token can be read.
 */
function requireSecure(base: string): void {
  const url = new URL(base);
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return;
  throw new Error(
    "an ApiClient with a signer needs an https baseUrl, or http to localhost, 127.0.0.1 or [::1]: over plain http the sign-in can be swapped and the bearer token is sent in the clear",
  );
}

/**
 * The time a request has: `timeoutMs`, or the default if it is not set. Anything that is set and
 * is not a number from 1 to what a timer keeps is a mistake: `setTimeout` would turn it into a
 * wait of a millisecond, and every request would fail at once. It is refused with an error that
 * names the option, when the client is made.
 */
function timeoutOf(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `ApiClient: timeoutMs must be a number of milliseconds from 1 to ${MAX_TIMEOUT_MS}, not ${String(timeoutMs)}`,
    );
  }
  return timeoutMs;
}

/** Whether `nonce` is one the API could have made: 32 bytes in the one base64 spelling of them. */
function isNonce(nonce: string): boolean {
  return NONCE_SHAPE.test(nonce) && btoa(atob(nonce)) === nonce;
}

/**
 * Why a challenge is not signed. It names the field and never quotes it: the text comes from a
 * server that is not trusted, and an error is read by people and by agents. A recipient that is
 * not `baseUrl` can also be an API whose `PUBLIC_API_URL` is not the address it is called at,
 * which is why the error says what the recipient should have been.
 */
function refusal(field: "message" | "recipient" | "nonce"): Error {
  const wanted = field === "recipient" ? "this client's baseUrl" : "that of a Tender sign-in";
  return new Error(`refusing to sign the API's sign-in challenge: its ${field} is not ${wanted}`);
}

/**
 * The body of `res` as bytes, or null if it is more than `limit` bytes. A body that is too big is
 * given up on as soon as that is known: from the `Content-Length` it declares, and else, as that
 * can be absent or wrong, by counting while it is read. The rest of it is not read: the stream is
 * cancelled.
 */
async function readCapped(res: Response, limit: number): Promise<Uint8Array | null> {
  const declared = res.headers.get("Content-Length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * The Tender API as a program calls it: `TenderApi`, over HTTP. The MCP server, the reference
 * agents and the seed script read and write the board through it.
 *
 * Every answer is checked against its schema in `@tender/shared` (`fetchJson`), so a method gives
 * the type it says or throws. A 404 is `null` where `TenderApi` says it can be, and anything else
 * that is not a 2xx is an `ApiError`, a 429 and a 503 included: there is no retry loop here, except
 * the one for a token the API refuses. Ids go into paths and bodies as decimal strings.
 *
 * The public methods need no signer. The others act as the signer's account: they sign in on the
 * first call and send the token with each request. Signing in is NEP-413: the API sends a
 * challenge, the client signs its SHA-256 with the key of the signer, and the API trades the
 * signature for a bearer token. The token is kept until 5 minutes before it expires; calls that
 * come while it is being fetched share that one sign-in. A request the API refuses with a 401 has
 * the token dropped, signs in again and is sent once more, and a second 401 is thrown.
 *
 * The server at `baseUrl` is not trusted with the key. A challenge is signed only if its message
 * is `SIGN_IN_MESSAGE`, its recipient is the base of this client and its nonce is 32 bytes in
 * base64; any other is refused, with nothing signed. The base is `canonicalBase` of `baseUrl`,
 * taken once when the client is made: it is where every request goes (`<base>/v1/...`) and it is
 * the recipient, so a base cannot be called as one thing and signed for as another. The recipient
 * is what ties a signature to this API: a server that hands over the challenge of another API, to
 * use there what the key signs, is refused because that challenge names the base of the other
 * API and not this one's, even when the other is under another path of the same host.
 * A client with a signer needs an https `baseUrl` (http only to this machine), as the signature
 * and the token go to it, and no request follows a redirect, so the server cannot send them on.
 *
 * Every request has `timeoutMs` to be answered in full, 30 seconds unless it is set, and is
 * cancelled when that is out. The call then fails with an `ApiTimeoutError` that names the method.
 * That holds for a `fetchImpl` that never looks at the signal it is given, too: the call is let go
 * of at the time, and whatever the `fetchImpl` does after that is dropped. The signal of the
 * client, if it has one, ends the requests in flight and refuses the calls made after it. A
 * timeout is no answer of the API: it is not retried, and the token the client holds stays good.
 * A sign-in that times out fails the calls waiting for it, and the next call signs in again.
 *
 * An `ApiError` holds the body of the answer for the caller to read, and for a sign-in that can be
 * the bearer token. So nothing here logs a body or puts one in a message. The `error` field of a
 * body is in the message only when it is a code such as `not_found`, and never as a sentence: text
 * a server chose must not reach an agent through an error.
 */
export class ApiClient implements TenderApi {
  /** `canonicalBase` of the `baseUrl` given: where the routes are, and the recipient of a sign-in. */
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly callerSignal: AbortSignal | undefined;
  private readonly accountId: string | undefined;
  private readonly keyPair: KeyPair | undefined;
  private session: Session | undefined;
  private signingIn: Promise<string> | undefined;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = canonicalBase(opts.baseUrl);
    this.fetchImpl = opts.fetchImpl;
    // The clock is called as a function of its own, like `fetch`. The default looks `Date.now` up
    // on each call, so a test that fakes the clock after this is built is seen.
    const clock = opts.now;
    this.now = clock === undefined ? () => Date.now() : () => clock();
    this.timeoutMs = timeoutOf(opts.timeoutMs);
    this.callerSignal = opts.signal;
    if (opts.signer !== undefined) {
      requireSecure(this.baseUrl);
      this.accountId = opts.signer.accountId;
      this.keyPair = KeyPair.fromString(opts.signer.privateKey as KeyPairString);
    }
  }

  // ---- Public reads ---------------------------------------------------------------------------

  listTasks(filter: ListTasksFilter = {}): Promise<ListTasksResponse> {
    const query = queryOf({
      phase: filter.phase,
      tag: filter.tag,
      poster: filter.poster,
      verifier: filter.verifier,
      parent: filter.parent,
      invited: filter.invited,
      hire: filter.hire === true ? "true" : undefined,
      limit: filter.limit,
      cursor: filter.cursor,
    });
    return this.timed("listTasks", (signal) =>
      fetchJson(this.url(`/tasks${query}`), ListTasksResponseSchema, get(signal), this.fetchImpl),
    );
  }

  getTask(id: bigint): Promise<TaskDetailResponse | null> {
    return orNull(
      this.timed("getTask", (signal) =>
        fetchJson(this.url(`/tasks/${id}`), TaskDetailResponseSchema, get(signal), this.fetchImpl),
      ),
    );
  }

  listAgents(filter: ListAgentsFilter = {}): Promise<ListAgentsResponse> {
    const query = queryOf({
      tag: filter.tag,
      asp: filter.asp,
      limit: filter.limit,
      cursor: filter.cursor,
    });
    return this.timed("listAgents", (signal) =>
      fetchJson(this.url(`/agents${query}`), ListAgentsResponseSchema, get(signal), this.fetchImpl),
    );
  }

  // Async, so that an `account` that cannot be put in a path (a lone surrogate) rejects, as every
  // other failure does, and does not throw before a promise is returned.
  async getAgent(account: string): Promise<AgentDetailResponse | null> {
    return orNull(
      this.timed("getAgent", (signal) =>
        fetchJson(
          this.url(`/agents/${encodeURIComponent(account)}`),
          AgentDetailResponseSchema,
          get(signal),
          this.fetchImpl,
        ),
      ),
    );
  }

  listEntries(account: string): Promise<AccountEntriesResponse> {
    return this.timed("listEntries", (signal) =>
      fetchJson(
        this.url(`/entries${queryOf({ account })}`),
        AccountEntriesResponseSchema,
        get(signal),
        this.fetchImpl,
      ),
    );
  }

  health(): Promise<HealthResponse> {
    return this.timed("health", (signal) =>
      fetchJson(this.url("/health"), HealthResponseSchema, get(signal), this.fetchImpl),
    );
  }

  getScorecard(taskId: bigint): Promise<Scorecard | null> {
    return orNull(
      this.timed("getScorecard", (signal) =>
        fetchJson(this.url(`/scorecards/${taskId}`), ScorecardSchema, get(signal), this.fetchImpl),
      ),
    );
  }

  listQuestions(taskId: bigint): Promise<TaskBoard | null> {
    return orNull(
      this.timed("listQuestions", (signal) =>
        fetchJson(
          this.url(`/tasks/${taskId}/questions`),
          TaskBoardSchema,
          get(signal),
          this.fetchImpl,
        ),
      ),
    );
  }

  listServices(filter: ListServicesFilter = {}): Promise<ListServicesResponse> {
    const query = queryOf({
      q: filter.q,
      tag: filter.tag,
      provider: filter.provider,
      agent: filter.agent,
      token: filter.token,
      max_price: filter.maxPrice,
      status: filter.status,
      limit: filter.limit,
      cursor: filter.cursor,
    });
    return this.timed("listServices", (signal) =>
      fetchJson(
        this.url(`/services${query}`),
        ListServicesResponseSchema,
        get(signal),
        this.fetchImpl,
      ),
    );
  }

  getService(id: bigint): Promise<ServiceResponse | null> {
    return orNull(
      this.timed("getService", (signal) =>
        fetchJson(this.url(`/services/${id}`), ServiceResponseSchema, get(signal), this.fetchImpl),
      ),
    );
  }

  /**
   * The bytes of the blob stored under `sha256`. The store is addressed by content, so the bytes
   * are hashed and must give `sha256`: bytes that do not are an `ApiError` with the status of the
   * answer, never data. The API stores at most `MAX_RESULT_BYTES` in a blob, and an answer of any
   * status is read only up to that: a larger one is an `ApiError` too, and the rest of it is not
   * read. This is the one request that does not go through `fetchJson`, as the answer is not JSON.
   * Its time is for the whole of it, the bytes included.
   */
  async getBlob(sha256: string): Promise<Uint8Array | null> {
    // A local, so that it is called as a function of its own and not as a method of the client.
    const doFetch = this.fetchImpl ?? fetch;
    return this.timed("getBlob", async (signal) => {
      const res = await doFetch(this.url(`/blobs/${encodeURIComponent(sha256)}`), get(signal));
      const bytes = await readCapped(res, MAX_RESULT_BYTES);
      if (bytes === null) {
        throw new ApiError(
          res.status,
          null,
          `the blob ${sha256} is larger than the API allows, which is ${MAX_RESULT_BYTES} bytes`,
        );
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new ApiError(res.status, bodyOf(new TextDecoder().decode(bytes)));
      const actual = sha256Hex(bytes);
      if (actual !== sha256) {
        throw new ApiError(
          res.status,
          null,
          `the bytes served for blob ${sha256} do not match it, they hash to ${actual}`,
        );
      }
      return bytes;
    });
  }

  // ---- Calls that act as the signer's account -------------------------------------------------

  // Async, so that bytes that cannot be turned into base64 reject, as getAgent's account does.
  async uploadBlob(blob: BlobUpload): Promise<BlobUploadResponse> {
    const body = {
      kind: blob.kind,
      content_type: blob.contentType,
      content_base64: toBase64(blob.bytes),
      // Undefined when there is none, and JSON leaves it out: the API takes a u64 string or no key.
      task_id: blob.taskId?.toString(),
    };
    return this.signedIn("uploadBlob", (token, signal) =>
      fetchJson(
        this.url("/blobs"),
        BlobUploadResponseSchema,
        post(signal, token, body),
        this.fetchImpl,
      ),
    );
  }

  async uploadHeldout(commitment: string, bytes: Uint8Array): Promise<void> {
    const body = { commitment, content_base64: toBase64(bytes) };
    await this.signedIn("uploadHeldout", (token, signal) =>
      fetchJson(
        this.url("/heldout"),
        HeldoutUploadResponseSchema,
        post(signal, token, body),
        this.fetchImpl,
      ),
    );
  }

  start(taskId: bigint): Promise<StartResponse> {
    return this.signedIn("start", (token, signal) =>
      fetchJson(
        this.url(`/tasks/${taskId}/start`),
        StartResponseSchema,
        post(signal, token),
        this.fetchImpl,
      ),
    );
  }

  askQuestion(taskId: bigint, text: string): Promise<QuestionResponse> {
    return this.signedIn("askQuestion", (token, signal) =>
      fetchJson(
        this.url(`/tasks/${taskId}/questions`),
        QuestionResponseSchema,
        post(signal, token, { text }),
        this.fetchImpl,
      ),
    );
  }

  answerQuestion(taskId: bigint, questionId: bigint, text: string): Promise<QuestionResponse> {
    return this.signedIn("answerQuestion", (token, signal) =>
      fetchJson(
        this.url(`/tasks/${taskId}/questions/${questionId}/answer`),
        QuestionResponseSchema,
        post(signal, token, { text }),
        this.fetchImpl,
      ),
    );
  }

  postClarification(taskId: bigint, text: string): Promise<ClarificationResponse> {
    return this.signedIn("postClarification", (token, signal) =>
      fetchJson(
        this.url(`/tasks/${taskId}/clarifications`),
        ClarificationResponseSchema,
        post(signal, token, { text }),
        this.fetchImpl,
      ),
    );
  }

  createService(service: CreateServiceRequest): Promise<ServiceResponse> {
    return this.signedIn("createService", (token, signal) =>
      fetchJson(
        this.url("/services"),
        ServiceResponseSchema,
        post(signal, token, service),
        this.fetchImpl,
      ),
    );
  }

  updateService(id: bigint, update: UpdateServiceRequest): Promise<ServiceResponse> {
    return this.signedIn("updateService", (token, signal) =>
      fetchJson(
        this.url(`/services/${id}`),
        ServiceResponseSchema,
        post(signal, token, update),
        this.fetchImpl,
      ),
    );
  }

  telegramLink(): Promise<TelegramLinkResponse> {
    return this.signedIn("telegramLink", (token, signal) =>
      fetchJson(
        this.url("/telegram/link"),
        TelegramLinkResponseSchema,
        post(signal, token),
        this.fetchImpl,
      ),
    );
  }

  // ---- Connect your agent --------------------------------------------------------------------
  //
  // The four routes of "Connect your agent" that no account signs: the connect code in the body is
  // their credential (`@tender/shared`'s `connect.ts`). A client with no signer calls them.

  /** `POST /v1/connect/lookup`: what a connect code is for (the agent's account, where) and how it stands. */
  connectLookup(code: string): Promise<ConnectLookup> {
    return this.timed("connectLookup", (signal) =>
      fetchJson(
        this.url("/connect/lookup"),
        ConnectLookupSchema,
        post(signal, undefined, { code }),
        this.fetchImpl,
      ),
    );
  }

  /** `POST /v1/connect/attach`: attaches the agent's PUBLIC key to the code, once. */
  connectAttach(code: string, publicKey: string): Promise<ConnectLookup> {
    return this.timed("connectAttach", (signal) =>
      fetchJson(
        this.url("/connect/attach"),
        ConnectLookupSchema,
        post(signal, undefined, { code, public_key: publicKey }),
        this.fetchImpl,
      ),
    );
  }

  /**
   * `POST /v1/connect/contest`: says the key attached to the code is not this agent's. Nothing
   * secret is sent; the owner's page then refuses the code.
   */
  connectContest(code: string): Promise<ConnectLookup> {
    return this.timed("connectContest", (signal) =>
      fetchJson(
        this.url("/connect/contest"),
        ConnectLookupSchema,
        post(signal, undefined, { code }),
        this.fetchImpl,
      ),
    );
  }

  /**
   * `POST /v1/connect/registered`: says the agent has registered. The API takes it once its index
   * shows the agent active, and answers 409 `not_registered` until then.
   */
  connectRegistered(code: string): Promise<ConnectRegistered> {
    return this.timed("connectRegistered", (signal) =>
      fetchJson(
        this.url("/connect/registered"),
        ConnectRegisteredSchema,
        post(signal, undefined, { code }),
        this.fetchImpl,
      ),
    );
  }

  // ---- Signing in -----------------------------------------------------------------------------

  /**
   * A bearer token that is good now: the one kept from the last sign-in while it is more than 5
   * minutes from its expiry, else the token of a new sign-in (challenge, signature, verify). Calls
   * made while a sign-in is under way wait for it and get its token. A sign-in that fails leaves
   * nothing behind, so the next call tries again. Once the signal of the client has aborted it
   * fails with the reason of that, as every call does, though a token is held.
   */
  signIn(): Promise<string> {
    if (this.callerSignal?.aborted) return Promise.reject(this.callerSignal.reason);
    const session = this.session;
    if (session !== undefined && this.now() < session.refreshAt) {
      return Promise.resolve(session.token);
    }
    this.signingIn ??= this.runSignIn().finally(() => {
      this.signingIn = undefined;
    });
    return this.signingIn;
  }

  private async runSignIn(): Promise<string> {
    const { accountId, keyPair } = this;
    if (accountId === undefined || keyPair === undefined) {
      throw new Error("this ApiClient has no signer, so it cannot sign in");
    }
    const challenge = await this.timed("signIn", (signal) =>
      fetchJson(this.url("/auth/challenge"), ChallengeResponseSchema, post(signal), this.fetchImpl),
    );
    const { message, nonce, recipient } = challenge;
    // The server chose all three, and the key signs them: only a Tender sign-in for this API is
    // signed, and nothing a server that is not Tender's would put in its place. The recipient is
    // the base this client calls, which is how the API puts its own public URL there. A server that
    // passes on the challenge of another API, to use there what the key signs, names that API.
    if (message !== SIGN_IN_MESSAGE) throw refusal("message");
    if (recipient !== this.baseUrl) throw refusal("recipient");
    if (!isNonce(nonce)) throw refusal("nonce");
    // The signature is of the SHA-256 of the NEP-413 bytes, the same digest `verifyNep413` checks.
    const digest = hexToBytes(sha256Hex(serializeNep413({ message, nonce, recipient })));
    const { signature, publicKey } = keyPair.sign(digest);
    const verification = {
      account_id: accountId,
      public_key: publicKey.toString(),
      signature: toBase64(signature),
      nonce,
      message,
      recipient,
    };
    const issued = await this.timed("signIn", (signal) =>
      fetchJson(
        this.url("/auth/verify"),
        SignInResponseSchema,
        post(signal, undefined, verification),
        this.fetchImpl,
      ),
    );
    this.session = {
      token: issued.token,
      refreshAt: Date.parse(issued.expires_at) - TOKEN_MARGIN_MS,
    };
    return issued.token;
  }

  /**
   * Drops the token the API refused, unless a newer one has replaced it since: a call that was
   * refused late must not throw away the token another call signed in for.
   */
  private forget(token: string): void {
    if (this.session?.token === token) this.session = undefined;
  }

  /**
   * Runs `send` with a token, as the request of `method` (see `timed`). If the API answers it with
   * a 401, the token is dropped, a new one is signed in for and `send` runs once more, as a request
   * of its own; the answer of that second run is final. A 401 from the sign-in itself is not
   * retried: the key was refused, and `signIn` throws that. A request that is out of time is not
   * a 401, and leaves the token as it was.
   */
  private async signedIn<T>(
    method: string,
    send: (token: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const token = await this.signIn();
    try {
      return await this.timed(method, (signal) => send(token, signal));
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      this.forget(token);
    }
    const fresh = await this.signIn();
    try {
      return await this.timed(method, (signal) => send(fresh, signal));
    } catch (error) {
      if (isUnauthorized(error)) this.forget(fresh);
      throw error;
    }
  }

  /**
   * Runs `send`, which makes one request with the signal it is given, and gives its result. The
   * signal aborts when `timeoutMs` has passed, with an `ApiTimeoutError` for `method`, and when
   * the signal of the client does, with the reason of that. Either way the call fails with that
   * reason at once, and does not wait for `send`: a `fetchImpl` is not bound to look at its
   * signal, and one that never answers must not hold a caller for ever. (A `fetch` that does look
   * at it cancels the request, and the connection with it.) What `send` does after that, it does
   * unobserved. If the signal of the client has aborted already, the call fails before `send` is
   * called.
   *
   * The timer and the listener are put away however the request ends.
   */
  private async timed<T>(method: string, send: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.callerSignal?.throwIfAborted();
    const timeout = new AbortController();
    // The signal of the client is combined, and not listened to for each request: one client has
    // any number of requests in flight, and Node warns of a leak when a signal has more than ten
    // listeners.
    const signal =
      this.callerSignal === undefined
        ? timeout.signal
        : AbortSignal.any([timeout.signal, this.callerSignal]);
    const timer = setTimeout(() => {
      timeout.abort(new ApiTimeoutError(method, this.timeoutMs));
    }, this.timeoutMs);
    let interrupt: (reason: unknown) => void = () => undefined;
    const interrupted = new Promise<never>((_, reject) => {
      interrupt = reject;
    });
    const onAbort = () => interrupt(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([send(signal), interrupted]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private url(path: string): string {
    return `${this.baseUrl}/v1${path}`;
  }
}
