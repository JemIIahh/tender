import { createHash } from "node:crypto";
import type { Db } from "./adapters";

export type BlobKind = "brief" | "criteria" | "heldout" | "result" | "scorecard" | "profile";

export interface NewBlob {
  kind: BlobKind;
  contentType: string;
  bytes: Uint8Array;
  taskId?: bigint;
  uploader?: string;
  isPublic: boolean;
}

export interface StoredBlob {
  kind: BlobKind;
  contentType: string;
  bytes: Uint8Array;
  /** Decimal text, as every id and amount is outside the database. */
  taskId: string | null;
  uploader: string | null;
  isPublic: boolean;
}

/**
 * Stores `bytes` under their own sha256 (lowercase hex, returned) and does nothing if that hash
 * is already stored. An existing blob is never changed by a second put, not even its visibility:
 * uploading a private blob's bytes again as public does not publish it. Use `setBlobPublic`.
 * The table rejects a `kind` outside `BlobKind`.
 */
export async function putBlob(db: Db, b: NewBlob): Promise<string> {
  return (await insertBlob(db, b)).sha256;
}

/**
 * `putBlob`, and whether this call stored a row: `created` is false when the hash was stored
 * already, whatever its kind. Of calls that race with the same bytes, exactly one is told it
 * stored them.
 */
export async function insertBlob(
  db: Db,
  b: NewBlob,
): Promise<{ sha256: string; created: boolean }> {
  const sha256 = createHash("sha256").update(b.bytes).digest("hex");
  const rows = await db.query(
    `insert into blobs (sha256, kind, content_type, bytes, task_id, uploader, is_public)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (sha256) do nothing
     returning sha256`,
    [sha256, b.kind, b.contentType, b.bytes, b.taskId ?? null, b.uploader ?? null, b.isPublic],
  );
  return { sha256, created: rows.length > 0 };
}

/** The blob stored under `sha256`, or null. Visibility (`isPublic`) is the caller's to enforce. */
export async function getBlob(db: Db, sha256: string): Promise<StoredBlob | null> {
  const [row] = await db.query<{
    kind: BlobKind;
    content_type: string;
    bytes: Uint8Array;
    task_id: string | null;
    uploader: string | null;
    is_public: boolean;
  }>(
    `select kind, content_type, bytes, task_id::text as task_id, uploader, is_public
       from blobs where sha256 = $1`,
    [sha256],
  );
  if (!row) return null;
  return {
    kind: row.kind,
    contentType: row.content_type,
    bytes: row.bytes,
    taskId: row.task_id,
    uploader: row.uploader,
    isPublic: row.is_public,
  };
}

/** Changes who may read a stored blob. A hash that is not stored is ignored. */
export async function setBlobPublic(db: Db, sha256: string, isPublic: boolean): Promise<void> {
  await db.query("update blobs set is_public = $2 where sha256 = $1", [sha256, isPublic]);
}
