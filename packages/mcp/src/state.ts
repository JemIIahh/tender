import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  AccountIdSchema,
  computeCommitment,
  NETWORKS,
  type NetworkId,
  U64StringSchema,
} from "@tender/shared";
import { z } from "zod";

// The drafts of an agent that commits to tasks. A commit puts only a hash on chain, so the work and
// the salt that open it stay here until the reveal, and nothing else holds them. Lose a draft and
// the agent loses its entry; leak one and the work is out before the reveal. So the store is
//
// - private: its directories are 0700 and its files 0600;
// - crash safe: a draft is written whole to a temp file and renamed over the old one, so a crash
//   or a failed write leaves the old draft or the new one, never half of either;
// - path safe: the task id becomes part of a file name, so it must be a u64 in decimal first;
// - never destroyed by the store on its own account: a draft that is not wanted any more is set
//   aside under another name, and the file stays, because it holds the only copy of a work and its
//   salt (`setAside`).
//
// The caller picks the directory, and `defaultStateDir` gives the usual one. Calls for one task are
// expected one after another, as commit and reveal are, and the store does not lock: the MCP tools
// queue their calls for a task in the one process, and two processes on one directory are not
// supported.

/** The owner may read and write a draft file, and nobody else may do anything. */
const FILE_MODE = 0o600;
/** The owner may do anything in a directory of the store, and nobody else may enter it. */
const DIR_MODE = 0o700;
const DRAFT_SUFFIX = ".json";
/** Between the task id and the time, in the name of a draft that was set aside. */
const ASIDE_INFIX = ".orphaned-";

/**
 * What the agent keeps for one task between its commit and its reveal. Apart from the task id, the
 * store keeps the strings as they are given: it checks that they are strings, not that they are
 * well-formed hashes.
 */
export interface Draft {
  /** The task, as a u64 in decimal. It names the file, so the store checks it first. */
  taskId: string;
  /** The work itself, as base64. It may be empty. */
  contentBase64: string;
  /** The SHA-256 of the work, 64 lowercase hex characters. */
  contentHash: string;
  /** The random salt that opens the commitment, 64 lowercase hex characters. */
  salt: string;
  /** What the commit puts on chain: the hash of the task id, account, content hash and salt. */
  commitment: string;
  /**
   * The contract the task is on, as the server that made the draft was set up. A task id counts up
   * from 1 on each contract, and a chain that is started again (every sandbox, a redeploy) hands
   * the same ids out once more, so a task id names a task only on one contract and one run of it.
   * Together with `taskCreatedAt` this says whose draft it is (`staleReason`). Unset in a draft
   * that an older server made, which cannot say.
   */
  contractId?: string;
  /**
   * When the task was created, in nanoseconds since the epoch as a decimal string, as the API had
   * it when the draft was made. A task keeps its creation time for good, and the tasks that share
   * an id on two runs of a chain differ in it. Unset when the API could not be asked then, and in a
   * draft that an older server made.
   */
  taskCreatedAt?: string;
  /** When the commit went through, as an ISO 8601 time. Unset while the commit is in flight. */
  committedAt?: string;
  /** Where the revealed work was uploaded. Unset until the reveal has gone through. */
  revealedUri?: string;
  /**
   * Set when the contract refused this draft's commit for good (see `markDead`). A dead draft is
   * kept, so that the agent can read why, and is never sent or revealed again.
   */
  dead?: { reason: string; at: string };
}

export interface StateStore {
  /**
   * Writes the draft, replacing the one for the same task if there is one, as when a commit is
   * replaced before the reveal. The old draft stays whole until the new one is complete. Rejects
   * before touching the disk if the task id is not a u64 in decimal, or a field is missing or is
   * not a string.
   */
  saveDraft(draft: Draft): Promise<void>;
  /**
   * The draft for the task, or null if there is none. Rejects if the file is there but is not a
   * readable draft: that is not "no draft", and a caller that took it for one would write over
   * what may still be recoverable.
   */
  getDraft(taskId: string): Promise<Draft | null>;
  /** Records where the work was revealed, keeping the rest. Rejects if there is no draft. */
  markRevealed(taskId: string, uri: string): Promise<void>;
  /**
   * Retires the draft: records why the contract refused its commit for good and when, keeping the
   * rest. A draft that is dead already keeps its first reason. Rejects if there is no draft.
   */
  markDead(taskId: string, reason: string): Promise<void>;
  /**
   * Takes the draft for the task out of use without destroying it: the file is renamed to
   * `{task id}.orphaned-{time}.json` in the same directory, whole, and the name is returned. After
   * that `getDraft` finds no draft for the task and `listDrafts` does not list the file (its name is
   * no task number), so a new draft can be saved for the id. Nothing is read, so a file that is not
   * a readable draft is set aside as well. Returns null if there was no draft. A name that is taken
   * is never reused.
   */
  setAside(taskId: string): Promise<string | null>;
  /**
   * Every draft, revealed, dead or not, by task number. A caller that wants the ones still to
   * reveal filters on `revealedUri` and `dead`. Rejects if any file is not a readable draft.
   */
  listDrafts(): Promise<Draft[]>;
}

// A draft the store reads is checked as closely as one it writes: the disk can hold anything.
const DraftSchema: z.ZodType<Draft> = z.object({
  taskId: U64StringSchema,
  contentBase64: z.string(),
  contentHash: z.string(),
  salt: z.string(),
  commitment: z.string(),
  contractId: z.string().optional(),
  taskCreatedAt: z.string().optional(),
  committedAt: z.string().optional(),
  revealedUri: z.string().optional(),
  dead: z.object({ reason: z.string(), at: z.string() }).optional(),
});

/** A value for an error message: quoted, and cut short so a huge one cannot flood a log. */
function show(value: unknown): string {
  return JSON.stringify(String(value).slice(0, 40));
}

/**
 * Refuses anything but a u64 in decimal. Digits cannot make a `..` or a path separator, so an id
 * that passes cannot name a file outside `drafts/`.
 */
function assertTaskId(taskId: string): void {
  if (!U64StringSchema.safeParse(taskId).success) {
    throw new Error(`invalid task id ${show(taskId)}: expected a u64 as a decimal string`);
  }
}

/**
 * Whether `draft` was made by `accountId`: its commitment is the one that `accountId`, its task,
 * its content hash and its salt give. A state directory that two accounts share holds a draft of
 * each under the task's one file name, and a tool must not extend or reveal the other's. A draft
 * whose parts do not make a commitment at all is nobody's.
 */
export function isDraftOf(draft: Draft, accountId: string): boolean {
  try {
    const commitment = computeCommitment(
      BigInt(draft.taskId),
      accountId,
      draft.contentHash,
      draft.salt,
    );
    return commitment === draft.commitment;
  } catch {
    return false;
  }
}

/**
 * Why `draft` is not the draft of the task as it stands now, or null when nothing says that it is
 * not. `contractId` is the contract this server is set up for, and `taskCreatedAt` the creation time
 * of the task as the API has it now, if the caller has asked.
 *
 * A draft is for the task it was made for: the same id on the same contract, and the same run of it.
 * Task ids start at 1 on every contract, and a chain that is started again (every sandbox, a
 * redeploy) hands them out again, so an old draft can meet a new task with its id. What it records
 * tells them apart, and a draft is stale when it records a contract other than this server's, or
 * a creation time other than the task's. A draft that records nothing, or too little to compare, is
 * not called stale here: that is a draft from before drafts were bound, or one made while the API
 * was out of reach, and the caller has the chain to ask.
 */
export function staleReason(
  draft: Draft,
  contractId: string,
  taskCreatedAt?: string,
): string | null {
  if (draft.contractId !== undefined && draft.contractId !== contractId) {
    return `it was made for the contract ${show(draft.contractId)}, and this server uses ${show(contractId)}`;
  }
  if (
    draft.taskCreatedAt !== undefined &&
    taskCreatedAt !== undefined &&
    draft.taskCreatedAt !== taskCreatedAt
  ) {
    return (
      "it was made for a task with this number that was created at another time: a chain that " +
      "was started again hands out its task numbers once more"
    );
  }
  return null;
}

/** Orders task ids as numbers, so that "2" comes before "10". */
function compareTaskIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  if (x < y) return -1;
  return x > y ? 1 : 0;
}

/** Whether `error` is a file system error with this code, such as `ENOENT`. */
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Whether anything is at `path`. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

/**
 * Writes `text` to `file` so that a reader, or a crash, finds the old file or the new one and never
 * part of either. The text goes to a temp file in the same directory, so that the rename stays on
 * one filesystem and is atomic, and is on disk before the rename.
 */
async function writeFileAtomic(file: string, text: string): Promise<void> {
  const temp = join(
    dirname(file),
    `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  // `wx` fails rather than reuse a file that is already there, and so nothing below can remove
  // somebody else's file. The mode is set by the create itself, so the file is private from its
  // first moment and not only once it has been written.
  const handle = await open(temp, "wx", FILE_MODE);
  try {
    try {
      await handle.writeFile(text, "utf8");
      // Without this, a power cut after the rename can leave an empty file under the real name.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    // The write or the rename failed. Take the unfinished copy away, and report that failure, not
    // one of this cleanup.
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectory(dirname(file));
}

/** Makes a rename survive a power cut. Best effort, since not every platform opens a directory. */
async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The rename has happened, so the draft is in place. This only hardens it.
  }
}

/**
 * The directory that holds every default state directory, for each network and each account:
 * `{home}/.tender`, the parent of what `defaultStateDir` gives. `home` must be an absolute path (see
 * `defaultStateDir`).
 */
export function defaultStateRoot(home: string = homedir()): string {
  // An empty or relative home would put the state wherever the process happens to run.
  if (!isAbsolute(home)) {
    throw new Error(`the home directory must be an absolute path, got ${show(home)}`);
  }
  return join(home, ".tender");
}

/**
 * Where an agent's state lives unless the operator names another directory:
 * `{home}/.tender/{network}/{account}`. Each network and each account gets its own, so two agents
 * on one machine never share drafts. It returns a path and creates nothing: the store makes the
 * directories, private, when it first writes.
 *
 * The network and the account become path segments, so both are checked. The network must be one
 * of Tender's, and the account a NEAR account id, which cannot hold a `/` or a `..`, so a crafted
 * `TENDER_ACCOUNT` cannot move the state out of `{home}/.tender`.
 *
 * `home` must be a real, absolute path, and a relative one is refused. Nothing here expands a
 * leading `~`, which a JSON config such as an MCP client's can hold in `TENDER_STATE_DIR`, and
 * `createStateStore` does not either. The server's `bin` (plan 04 Task 6) expands it before it
 * calls either.
 */
export function defaultStateDir(
  network: NetworkId,
  account: string,
  home: string = homedir(),
): string {
  // Own keys only: "constructor" and "toString" are on every object and are not networks.
  if (!Object.hasOwn(NETWORKS, network)) {
    const known = Object.keys(NETWORKS).join(", ");
    throw new Error(`invalid network ${show(network)}: expected one of ${known}`);
  }
  if (!AccountIdSchema.safeParse(account).success) {
    throw new Error(`invalid account ${show(account)}: expected a NEAR account id`);
  }
  return join(defaultStateRoot(home), network, account);
}

/**
 * The folder, inside a state directory, that holds the drafts: `{dir}/drafts/{taskId}.json`. Every
 * store has it, whatever its directory is called, so a path with a folder of this name on the way
 * may be one of a store's.
 */
export const DRAFTS_DIR = "drafts";

/**
 * The store for the drafts in `{dir}/drafts/{taskId}.json`. It creates `dir` on the first write,
 * and reading from a `dir` that does not exist yet finds no drafts. Pass a real path: a relative
 * `dir` is taken from the current directory, and a leading `~` is not expanded.
 */
export function createStateStore(dir: string): StateStore {
  // An empty path would resolve to the current directory and put the drafts wherever the process
  // happens to run, which is what `process.env.X ?? fallback` gives when X is set but empty.
  if (dir === "") {
    throw new Error("the state directory must not be empty");
  }
  // Resolved now, so that a later `chdir` cannot move the store.
  const draftsDir = join(resolve(dir), DRAFTS_DIR);
  const fileOf = (taskId: string) => join(draftsDir, `${taskId}${DRAFT_SUFFIX}`);

  async function readDraft(taskId: string): Promise<Draft | null> {
    const file = fileOf(taskId);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
    // The errors below name the file and never quote it, because it holds the work and the salt.
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`draft file ${file} is corrupt: it is not valid JSON`);
    }
    const parsed = DraftSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`draft file ${file} is corrupt: ${z.prettifyError(parsed.error)}`);
    }
    if (parsed.data.taskId !== taskId) {
      throw new Error(`draft file ${file} is corrupt: it holds task ${parsed.data.taskId}`);
    }
    return parsed.data;
  }

  async function writeDraft(draft: Draft): Promise<void> {
    const parsed = DraftSchema.safeParse(draft);
    if (!parsed.success) {
      throw new Error(`invalid draft: ${z.prettifyError(parsed.error)}`);
    }
    // `mkdir` gives each directory it creates the mode, and leaves one that exists alone. A
    // directory made by hand has the default umask's 0755, so tighten it.
    await mkdir(draftsDir, { recursive: true, mode: DIR_MODE });
    await chmod(draftsDir, DIR_MODE);
    await writeFileAtomic(fileOf(parsed.data.taskId), `${JSON.stringify(parsed.data, null, 2)}\n`);
  }

  return {
    async saveDraft(draft) {
      assertTaskId(draft.taskId);
      await writeDraft(draft);
    },

    async getDraft(taskId) {
      assertTaskId(taskId);
      return readDraft(taskId);
    },

    async markRevealed(taskId, uri) {
      assertTaskId(taskId);
      // Without this, an undefined uri would write the draft back as it was and look like success.
      if (typeof uri !== "string") {
        throw new TypeError("markRevealed needs the uri the work was revealed at");
      }
      const draft = await readDraft(taskId);
      if (draft === null) {
        throw new Error(`no draft for task ${taskId}`);
      }
      await writeDraft({ ...draft, revealedUri: uri });
    },

    async markDead(taskId, reason) {
      assertTaskId(taskId);
      if (typeof reason !== "string") {
        throw new TypeError("markDead needs the reason the draft was retired for");
      }
      const draft = await readDraft(taskId);
      if (draft === null) {
        throw new Error(`no draft for task ${taskId}`);
      }
      // The first reason is the one that matters: a mark that is repeated must not hide it.
      if (draft.dead !== undefined) return;
      await writeDraft({ ...draft, dead: { reason, at: new Date().toISOString() } });
    },

    async setAside(taskId) {
      assertTaskId(taskId);
      const file = fileOf(taskId);
      // The time in milliseconds, and the next millisecond if that name is taken: the move is a
      // rename, which would replace a file of that name, and a draft that was set aside before must
      // survive this one.
      for (let at = Date.now(); ; at += 1) {
        const aside = `${taskId}${ASIDE_INFIX}${at}${DRAFT_SUFFIX}`;
        if (await exists(join(draftsDir, aside))) continue;
        try {
          await rename(file, join(draftsDir, aside));
        } catch (error) {
          if (hasCode(error, "ENOENT")) return null;
          throw error;
        }
        await syncDirectory(draftsDir);
        return aside;
      }
    },

    async listDrafts() {
      let names: string[];
      try {
        names = await readdir(draftsDir);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return [];
        throw error;
      }
      // Only `{task id}.json` is a draft. A temp file left by a writer that was killed, and
      // anything else in the directory, is none.
      const taskIds = names
        .filter((name) => name.endsWith(DRAFT_SUFFIX))
        .map((name) => name.slice(0, -DRAFT_SUFFIX.length))
        .filter((id) => U64StringSchema.safeParse(id).success)
        .sort(compareTaskIds);
      // One file at a time, so that many drafts cannot run the process out of open files, and the
      // first unreadable draft in task order is the one that is reported.
      const drafts: Draft[] = [];
      for (const taskId of taskIds) {
        const draft = await readDraft(taskId);
        // A draft that was there when the directory was read may be gone when it is read.
        if (draft !== null) drafts.push(draft);
      }
      return drafts;
    },
  };
}
