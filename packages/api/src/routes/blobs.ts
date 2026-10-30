import { Buffer } from "node:buffer";
import {
  type Db,
  getBlob,
  type NewBlob,
  putBlob,
  type StoredBlob,
  setBlobPublic,
} from "@tender/db";
import {
  BriefSchema,
  canonicalJson,
  HashHexSchema,
  HeldoutSchema,
  MAX_RESULT_BYTES,
  ProfileSchema,
  PublicCriteriaSchema,
  ScorecardSchema,
  sha256Hex,
  U64StringSchema,
} from "@tender/shared";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type ApiDeps, nowNs } from "../deps";
import {
  type BlobUploadResponse,
  badRequest,
  type ErrorBody,
  fail,
  type HeldoutUploadResponse,
  issuesOf,
  notFound,
} from "../format";
import { getScorecard } from "../queries";

/** What sign-in leaves for a route to read: the account the request is signed in as. */
export type AuthVariables = { account: string };

/** The middleware that signs a request in: it sets `c.var.account`, or answers 401 itself. */
export type RequireAuth = MiddlewareHandler<{ Variables: AuthVariables }>;

type BlobApp = Hono<{ Variables: AuthVariables }>;

/**
 * The most a request body may hold, which is the largest content as base64 (a third more than
 * `MAX_CONTENT_BYTES`) and room for the rest of the JSON. A larger body is refused unread.
 */
const MAX_BODY_BYTES = 400_000;

/** The most a blob may hold, decoded. It is the largest result the result store keeps. */
const MAX_CONTENT_BYTES = MAX_RESULT_BYTES;

/**
 * What a blob that is served carries. It never changes, so it can be cached for good; it is
 * somebody's content, so it is never sniffed into another type and never runs as a page.
 */
const SERVED_HEADERS = {
  "Cache-Control": "public, max-age=31536000, immutable",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
};

/** A 404 may turn into a 200 later (a result is served at its deadline), so no cache keeps it. */
const NOT_SERVED_HEADERS = { "Cache-Control": "no-store" };

const CONFLICT = "these bytes are already stored as another kind";
const NOT_CANONICAL = "not canonical JSON";

/** `POST /v1/blobs`. `task_id` is the task of a result; a scorecard names its own. */
const UploadSchema = z.strictObject({
  kind: z.enum(["brief", "criteria", "result", "scorecard", "profile"]),
  content_type: z.enum(["application/json", "text/plain"]),
  content_base64: z.string(),
  task_id: U64StringSchema.optional(),
});
type Upload = z.infer<typeof UploadSchema>;

/** `POST /v1/heldout`. */
const HeldoutUploadSchema = z.strictObject({
  commitment: HashHexSchema,
  content_base64: z.string(),
});

/**
 * The blob store and the held-out intake.
 *
 * - `POST /v1/blobs` (signed in): stores a brief, criteria, scorecard or profile, which anyone may
 *   read at once, or an entrant's result, which nobody may read before the task's reveal deadline.
 * - `POST /v1/heldout` (signed in): stores a held-out document, which nobody may read.
 * - `GET /v1/blobs/:sha256`: the bytes of a blob that may be read.
 * - `GET /v1/scorecards/:task_id`: the scorecard the task was settled with.
 *
 * Blobs are addressed by the SHA-256 of their bytes, and the hashes on chain are SHA-256s of
 * canonical JSON, so the JSON kinds have to arrive as those bytes. The first upload of some bytes
 * fixes their kind, and nothing re-kinds them: a held-out document made public as a brief would be
 * out, and its task could not be judged. `requireAuth` is the sign-in middleware, which the
 * caller passes in.
 */
export function blobRoutes(deps: ApiDeps, requireAuth: RequireAuth): BlobApp {
  const app: BlobApp = new Hono();

  // Refuses a body over `MAX_BODY_BYTES` as it arrives, before anything parses it. It comes after
  // sign-in on the routes, so a request that is not signed in is turned away without being read.
  const tooLarge = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => {
      const body: ErrorBody = {
        error: "payload_too_large",
        message: "the request body is too large",
      };
      return c.json(body, 413);
    },
  });

  app.post("/blobs", requireAuth, tooLarge, async (c) => {
    const account = c.var.account;
    const upload = parse(UploadSchema, await c.req.json(), "the request body");
    const bytes = decodeContent(upload.content_base64);
    const blob = await blobOf(deps.db, upload, bytes, account);

    const { sha256, stored } = await store(deps.db, blob);
    if (stored.kind !== blob.kind) return fail(409, "conflict", CONFLICT);
    // Its first uploader may have stored it as private, which keeps the indexer from reading it.
    // The one uploading it now holds the bytes, so making it public gives nothing away.
    if (blob.isPublic && !stored.isPublic) await setBlobPublic(deps.db, sha256, true);

    const body: BlobUploadResponse = { sha256, uri: `${deps.publicUrl}/v1/blobs/${sha256}` };
    return c.json(body);
  });

  app.post("/heldout", requireAuth, tooLarge, async (c) => {
    const account = c.var.account;
    const upload = parse(HeldoutUploadSchema, await c.req.json(), "the request body");
    const bytes = decodeContent(upload.content_base64);
    if (sha256Hex(bytes) !== upload.commitment) {
      return badRequest("the content does not hash to the commitment");
    }
    checkDocument("the held-out document", bytes, HeldoutSchema);

    const { stored } = await store(deps.db, {
      kind: "heldout",
      contentType: "application/json",
      bytes,
      uploader: account,
      isPublic: false,
    });
    if (stored.kind !== "heldout") return fail(409, "conflict", CONFLICT);
    // The Judge takes a held-out only from the poster of the task. Bytes that another account
    // stored first would not be taken from this one, so it learns that before it posts.
    if (stored.uploader !== account) {
      return fail(
        409,
        "conflict",
        "these bytes are already stored as a held-out by another account",
      );
    }

    const body: HeldoutUploadResponse = { ok: true };
    return c.json(body);
  });

  app.get("/blobs/:sha256", async (c) => {
    const sha256 = c.req.param("sha256");
    const blob = HashHexSchema.safeParse(sha256).success ? await getBlob(deps.db, sha256) : null;
    if (blob === null || !(await mayServe(deps, blob))) return notServed(c, "blob");
    return served(c, blob.bytes, servedType(blob.contentType));
  });

  app.get("/scorecards/:task_id", async (c) => {
    const scorecard = await getScorecard(deps.db, c.req.param("task_id"));
    if (scorecard === null) return notServed(c, "scorecard");
    // The canonical bytes of the document, which are the bytes that were stored.
    return served(c, canonicalJson(scorecard), "application/json");
  });

  return app;
}

// ---- Uploads ----------------------------------------------------------------------------------

/** `value` as `schema` reads it, or a 400 that lists what is wrong with it. */
function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return badRequest(`${what} does not fit its schema`, issuesOf(parsed.error));
  return parsed.data;
}

/**
 * The bytes that `text` stands for, or a 400 for text that is not base64 or a 413 for too many
 * bytes. Node's decoder skips what it cannot read (line breaks, the URL-safe letters, a missing
 * pad) and ignores stray bits, so the text is taken only if the bytes encode back to exactly it.
 */
function decodeContent(text: string): Buffer {
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text) {
    return badRequest("content_base64 must be standard base64 with padding");
  }
  if (bytes.length > MAX_CONTENT_BYTES) {
    return fail(413, "payload_too_large", `content is over ${MAX_CONTENT_BYTES} bytes`);
  }
  return bytes;
}

/**
 * The document in `bytes`, or a 400 unless `bytes` are exactly the canonical bytes of a JSON
 * document that fits `schema`. The hash on chain is the SHA-256 of those bytes, so pretty printing,
 * a different key order or a byte order mark would store a document that no hash names. Text that
 * is not strict UTF-8, or not JSON, is not canonical JSON either. The comparison is with the JSON
 * as it was parsed, not as `schema` returns it. A document that does not fit is told so first: its
 * faults are what the caller needs, and its form is of no use until they are fixed.
 */
function checkDocument<T>(what: string, bytes: Uint8Array, schema: z.ZodType<T>): T {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return badRequest(NOT_CANONICAL);
  }
  const parsed = parse(schema, document, what);
  if (!isCanonical(document, bytes)) return badRequest(NOT_CANONICAL);
  return parsed;
}

function isCanonical(document: unknown, bytes: Uint8Array): boolean {
  try {
    return Buffer.compare(canonicalJson(document), bytes) === 0;
  } catch {
    // `canonicalJson` throws for a value JSON cannot write, such as the Infinity that 1e999 parses to.
    return false;
  }
}

/**
 * The blob that `upload` asks to store, once its content is what the kind needs and the account
 * may upload it, or the error that says why not. The content is looked at first, so a request that
 * is wrong in itself is a 400 whoever sends it, and the account's right to send it is a 403 or a
 * 404 after that. Visibility is the kind's: all but a result are public, which is what lets the
 * indexer read a brief or a profile, and the API a scorecard.
 */
async function blobOf(
  db: Db,
  upload: Upload,
  bytes: Uint8Array,
  account: string,
): Promise<NewBlob> {
  const { kind } = upload;
  if (kind === "result") {
    // Any bytes of either type: the entrant's own, and nobody's to check until the Judge reads them.
    if (upload.task_id === undefined) return badRequest("task_id is required for a result");
    await requireEntry(db, upload.task_id, account);
    return {
      kind,
      contentType: upload.content_type,
      bytes,
      taskId: BigInt(upload.task_id),
      uploader: account,
      isPublic: false,
    };
  }

  if (upload.content_type !== "application/json") {
    return badRequest(`a ${kind} must be sent as application/json`);
  }
  if (kind === "scorecard") {
    const scorecard = checkDocument("the scorecard", bytes, ScorecardSchema);
    // The scorecard says which task it is for; a body that says another one is mistaken.
    if (upload.task_id !== undefined && upload.task_id !== scorecard.task_id) {
      return badRequest("task_id is not the task of the scorecard");
    }
    await requireVerifierOrPoster(db, scorecard.task_id, account);
    return {
      kind,
      contentType: upload.content_type,
      bytes,
      taskId: BigInt(scorecard.task_id),
      uploader: account,
      isPublic: true,
    };
  }

  if (kind === "brief") checkDocument("the brief", bytes, BriefSchema);
  else if (kind === "criteria") checkDocument("the criteria", bytes, PublicCriteriaSchema);
  else checkDocument("the profile", bytes, ProfileSchema);
  return { kind, contentType: upload.content_type, bytes, uploader: account, isPublic: true };
}

/**
 * A result is an entrant's, so the account must have an entry on the task. The index can be a few
 * blocks behind the chain, so a 403 can also mean that the commit is too fresh to be in it yet.
 */
async function requireEntry(db: Db, taskId: string, account: string): Promise<void> {
  const [task] = await db.query<{ entered: boolean }>(
    `select exists (select 1 from entries e where e.task_id = t.id and e.account = $2) as entered
       from tasks t
      where t.id = $1::numeric`,
    [taskId, account],
  );
  if (!task) return notFound("no such task");
  if (!task.entered) {
    return fail(
      403,
      "forbidden",
      "this account has no entry on that task in the index; if it committed a moment ago, the indexer may not have seen the commit yet, so try again shortly",
    );
  }
}

/** A scorecard is the verifier's, or the poster's when the poster picks after the pick window. */
async function requireVerifierOrPoster(db: Db, taskId: string, account: string): Promise<void> {
  const [task] = await db.query<{ poster: string; verifier: string }>(
    "select poster, verifier from tasks where id = $1::numeric",
    [taskId],
  );
  if (!task) return notFound("no such task");
  if (account !== task.verifier && account !== task.poster) {
    return fail(
      403,
      "forbidden",
      "only the verifier or the poster of the task may upload its scorecard",
    );
  }
}

/**
 * Stores `blob` unless these bytes are stored already, and returns the row that holds them now.
 * The first upload wins and an existing row is never changed, so the row is not necessarily
 * `blob`: the caller compares. Reading it back after the put, not before, also settles two
 * uploads of the same bytes that race.
 */
async function store(db: Db, blob: NewBlob): Promise<{ sha256: string; stored: StoredBlob }> {
  const sha256 = await putBlob(db, blob);
  const stored = await getBlob(db, sha256);
  if (stored === null) throw new Error("a blob that was just stored is not there");
  return { sha256, stored };
}

// ---- Reads ------------------------------------------------------------------------------------

/**
 * Whether the API may serve `blob`. A result waits for the reveal deadline of its task (the
 * contract's rule, `now >= reveal_deadline`), and is never served without a task that has one.
 * Anything else is served while it is public: a held-out document is not, until it is made so.
 */
async function mayServe(deps: ApiDeps, blob: StoredBlob): Promise<boolean> {
  if (blob.kind !== "result") return blob.isPublic;
  if (blob.taskId === null) return false;
  const [task] = await deps.db.query<{ revealed: boolean }>(
    "select reveal_deadline <= $2::numeric as revealed from tasks where id = $1::numeric",
    [blob.taskId, nowNs(deps)],
  );
  return task?.revealed === true;
}

/** The `Content-Type` a stored blob is served with. Text is declared UTF-8, so no one has to guess. */
function servedType(contentType: string): string {
  return contentType === "text/plain" ? "text/plain; charset=utf-8" : contentType;
}

function served(c: Context, bytes: Uint8Array, contentType: string): Response {
  // A copy, because Hono's body type leaves out bytes that may sit on a `SharedArrayBuffer`.
  return c.body(new Uint8Array(bytes), 200, { "Content-Type": contentType, ...SERVED_HEADERS });
}

/** The answer for a blob that is not there and for one that may not be read yet: the same. */
function notServed(c: Context, what: string): Response {
  const body: ErrorBody = { error: "not_found", message: `no such ${what}` };
  return c.json(body, 404, NOT_SERVED_HEADERS);
}
