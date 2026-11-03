import type { Db } from "./adapters";

export interface ResultUpload {
  /** The hash of the uploaded bytes: the key of the blob. */
  sha256: string;
  /** The task the result was uploaded for. */
  taskId: bigint;
  /** The account that uploaded it. */
  account: string;
}

/**
 * Records that `account` uploaded the bytes hashing to `sha256` as a result for the task, and does
 * nothing if it did so already. The blob store keeps only the first upload of some bytes, so this is
 * the record of every account that held them: one row per hash, task and account. Whether an upload
 * is worth a record is the caller's to say: the API makes none for bytes it serves already.
 */
export async function recordResultUpload(db: Db, upload: ResultUpload): Promise<void> {
  await db.query(
    `insert into result_uploads (sha256, task_id, account) values ($1, $2, $3)
     on conflict (sha256, task_id, account) do nothing`,
    [upload.sha256, checked(upload.taskId), upload.account],
  );
}

/** Whether `account` uploaded the bytes hashing to `sha256` as a result for the task. */
export async function hasResultUpload(
  db: Db,
  sha256: string,
  taskId: bigint,
  account: string,
): Promise<boolean> {
  const [row] = await db.query<{ found: boolean }>(
    `select exists (
       select 1 from result_uploads where sha256 = $1 and task_id = $2::numeric and account = $3
     ) as found`,
    [sha256, checked(taskId), account],
  );
  return row?.found === true;
}

export interface HeldoutUpload {
  /** The hash of the uploaded bytes: the key of the blob, and the commitment a task names. */
  sha256: string;
  /** The account that uploaded them. */
  account: string;
}

/**
 * Records that `account` uploaded the held-out document hashing to `sha256`, and does nothing if it
 * did so already. The blob store keeps only the first upload of some bytes, and anyone who has the
 * bytes can be first, so this is the record of every account that sent them: one row per hash and
 * account. The Judge takes a task's held-out checks only when its poster is among them.
 */
export async function recordHeldoutUpload(db: Db, upload: HeldoutUpload): Promise<void> {
  await db.query(
    `insert into heldout_uploads (sha256, account) values ($1, $2)
     on conflict (sha256, account) do nothing`,
    [upload.sha256, upload.account],
  );
}

/** Whether `account` uploaded the held-out document hashing to `sha256`. */
export async function hasHeldoutUpload(db: Db, sha256: string, account: string): Promise<boolean> {
  const [row] = await db.query<{ found: boolean }>(
    `select exists (
       select 1 from heldout_uploads where sha256 = $1 and account = $2
     ) as found`,
    [sha256, account],
  );
  return row?.found === true;
}

/**
 * `taskId`, if it is a bigint, and a `TypeError` for anything else, whatever the caller's types say.
 * The column rounds a fraction: "2.5" would be recorded for task 3 and, asked for as 2.5, not be
 * found. A number loses digits past 2^53, and a task id is a u64.
 */
function checked(taskId: bigint): bigint {
  if (typeof taskId !== "bigint") throw new TypeError("a task id must be a bigint");
  return taskId;
}
