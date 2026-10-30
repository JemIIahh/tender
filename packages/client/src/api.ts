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
  fetchJson,
  type HealthResponse,
  HealthResponseSchema,
  HeldoutUploadResponseSchema,
  hexToBytes,
  type ListAgentsFilter,
  type ListAgentsResponse,
  ListAgentsResponseSchema,
  type ListTasksFilter,
  type ListTasksResponse,
  ListTasksResponseSchema,
  type Scorecard,
  ScorecardSchema,
  SignInResponseSchema,
  type StartResponse,
  StartResponseSchema,
  sha256Hex,
  type TaskDetailResponse,
  TaskDetailResponseSchema,
  type TelegramLinkResponse,
  TelegramLinkResponseSchema,
  type TenderApi,
} from "@tender/shared";
import { KeyPair, type KeyPairString } from "near-api-js";
import type { Signer } from "./client";
import { serializeNep413 } from "./nep413";

/** How long before a token expires the client stops using it and signs in again. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** How many bytes go to `String.fromCharCode` in one call, which takes them as arguments. */
const BASE64_CHUNK = 0x8000;

export interface ApiClientOptions {
  /**
   * Where the API is served, as `PUBLIC_API_URL` has it: `https://api.example`, with no `/v1`. The
   * client adds that, and drops a trailing slash.
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
}

/**
 * A list filter whose cursor can be null, which is no cursor. The `next_cursor` of the last page is
 * null, and a caller can hand back whatever it was given.
 */
type WithNullCursor<F extends { cursor?: string | null }> = Omit<F, "cursor"> & {
  cursor?: string | null;
};

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

/** The `init` of a POST: signed in as the owner of `token` if there is one, with `body` as JSON. */
function post(token?: string, body?: unknown): RequestInit {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) };
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
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
 * An `ApiError` holds the body of the answer for the caller to read, and for a sign-in that can be
 * the bearer token. So nothing here logs a body or puts one in a message.
 */
export class ApiClient implements TenderApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly now: () => number;
  private readonly accountId: string | undefined;
  private readonly keyPair: KeyPair | undefined;
  private session: Session | undefined;
  private signingIn: Promise<string> | undefined;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl;
    // The clock is called as a function of its own, like `fetch`. The default looks `Date.now` up
    // on each call, so a test that fakes the clock after this is built is seen.
    const clock = opts.now;
    this.now = clock === undefined ? () => Date.now() : () => clock();
    if (opts.signer !== undefined) {
      this.accountId = opts.signer.accountId;
      this.keyPair = KeyPair.fromString(opts.signer.privateKey as KeyPairString);
    }
  }

  // ---- Public reads ---------------------------------------------------------------------------

  listTasks(filter: WithNullCursor<ListTasksFilter> = {}): Promise<ListTasksResponse> {
    const query = queryOf({
      phase: filter.phase,
      tag: filter.tag,
      poster: filter.poster,
      verifier: filter.verifier,
      parent: filter.parent,
      limit: filter.limit,
      cursor: filter.cursor,
    });
    return fetchJson(
      this.url(`/tasks${query}`),
      ListTasksResponseSchema,
      undefined,
      this.fetchImpl,
    );
  }

  getTask(id: bigint): Promise<TaskDetailResponse | null> {
    return orNull(
      fetchJson(this.url(`/tasks/${id}`), TaskDetailResponseSchema, undefined, this.fetchImpl),
    );
  }

  listAgents(filter: WithNullCursor<ListAgentsFilter> = {}): Promise<ListAgentsResponse> {
    const query = queryOf({
      tag: filter.tag,
      asp: filter.asp,
      limit: filter.limit,
      cursor: filter.cursor,
    });
    return fetchJson(
      this.url(`/agents${query}`),
      ListAgentsResponseSchema,
      undefined,
      this.fetchImpl,
    );
  }

  // Async, so that an `account` that cannot be put in a path (a lone surrogate) rejects, as every
  // other failure does, and does not throw before a promise is returned.
  async getAgent(account: string): Promise<AgentDetailResponse | null> {
    return orNull(
      fetchJson(
        this.url(`/agents/${encodeURIComponent(account)}`),
        AgentDetailResponseSchema,
        undefined,
        this.fetchImpl,
      ),
    );
  }

  listEntries(account: string): Promise<AccountEntriesResponse> {
    return fetchJson(
      this.url(`/entries${queryOf({ account })}`),
      AccountEntriesResponseSchema,
      undefined,
      this.fetchImpl,
    );
  }

  health(): Promise<HealthResponse> {
    return fetchJson(this.url("/health"), HealthResponseSchema, undefined, this.fetchImpl);
  }

  getScorecard(taskId: bigint): Promise<Scorecard | null> {
    return orNull(
      fetchJson(this.url(`/scorecards/${taskId}`), ScorecardSchema, undefined, this.fetchImpl),
    );
  }

  /**
   * The bytes of the blob stored under `sha256`. The store is addressed by content, so the bytes
   * are hashed and must give `sha256`: bytes that do not are an `ApiError` with the status of the
   * answer, never data. This is the one request that does not go through `fetchJson`, as the
   * answer is not JSON.
   */
  async getBlob(sha256: string): Promise<Uint8Array | null> {
    // A local, so that it is called as a function of its own and not as a method of the client.
    const doFetch = this.fetchImpl ?? fetch;
    const res = await doFetch(this.url(`/blobs/${encodeURIComponent(sha256)}`));
    if (!res.ok) {
      // Read to its end either way, so that the connection is free for the next request.
      const body = bodyOf(await res.text());
      if (res.status === 404) return null;
      throw new ApiError(res.status, body);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const actual = sha256Hex(bytes);
    if (actual !== sha256) {
      throw new ApiError(
        res.status,
        null,
        `the bytes served for blob ${sha256} do not match it, they hash to ${actual}`,
      );
    }
    return bytes;
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
    return this.signedIn((token) =>
      fetchJson(this.url("/blobs"), BlobUploadResponseSchema, post(token, body), this.fetchImpl),
    );
  }

  async uploadHeldout(commitment: string, bytes: Uint8Array): Promise<void> {
    const body = { commitment, content_base64: toBase64(bytes) };
    await this.signedIn((token) =>
      fetchJson(
        this.url("/heldout"),
        HeldoutUploadResponseSchema,
        post(token, body),
        this.fetchImpl,
      ),
    );
  }

  start(taskId: bigint): Promise<StartResponse> {
    return this.signedIn((token) =>
      fetchJson(
        this.url(`/tasks/${taskId}/start`),
        StartResponseSchema,
        post(token),
        this.fetchImpl,
      ),
    );
  }

  telegramLink(): Promise<TelegramLinkResponse> {
    return this.signedIn((token) =>
      fetchJson(
        this.url("/telegram/link"),
        TelegramLinkResponseSchema,
        post(token),
        this.fetchImpl,
      ),
    );
  }

  // ---- Signing in -----------------------------------------------------------------------------

  /**
   * A bearer token that is good now: the one kept from the last sign-in while it is more than 5
   * minutes from its expiry, else the token of a new sign-in (challenge, signature, verify). Calls
   * made while a sign-in is under way wait for it and get its token. A sign-in that fails leaves
   * nothing behind, so the next call tries again.
   */
  signIn(): Promise<string> {
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
    const challenge = await fetchJson(
      this.url("/auth/challenge"),
      ChallengeResponseSchema,
      post(),
      this.fetchImpl,
    );
    const { message, nonce, recipient } = challenge;
    // The signature is of the SHA-256 of the NEP-413 bytes, the same digest `verifyNep413` checks.
    const digest = hexToBytes(sha256Hex(serializeNep413({ message, nonce, recipient })));
    const { signature, publicKey } = keyPair.sign(digest);
    const issued = await fetchJson(
      this.url("/auth/verify"),
      SignInResponseSchema,
      post(undefined, {
        account_id: accountId,
        public_key: publicKey.toString(),
        signature: toBase64(signature),
        nonce,
        message,
        recipient,
      }),
      this.fetchImpl,
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
   * Runs `send` with a token. If the API answers it with a 401, the token is dropped, a new one is
   * signed in for and `send` runs once more; the answer of that second run is final. A 401 from
   * the sign-in itself is not retried: the key was refused, and `signIn` throws that.
   */
  private async signedIn<T>(send: (token: string) => Promise<T>): Promise<T> {
    const token = await this.signIn();
    try {
      return await send(token);
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      this.forget(token);
    }
    const fresh = await this.signIn();
    try {
      return await send(fresh);
    } catch (error) {
      if (isUnauthorized(error)) this.forget(fresh);
      throw error;
    }
  }

  private url(path: string): string {
    return `${this.baseUrl}/v1${path}`;
  }
}
