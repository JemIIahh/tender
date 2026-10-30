import { type BigIntStats, constants as fsConstants } from "node:fs";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TenderError, type TxResult } from "@tender/client";
import {
  AccountIdSchema,
  ApiError,
  BriefSchema,
  canonicalJson,
  computeCommitment,
  HeldoutSchema,
  heldoutMatchesCriteria,
  MAX_RESULT_BYTES,
  NETWORKS,
  type NetworkId,
  ProfileSchema,
  PublicCriteriaSchema,
  randomSalt,
  ScorecardSchema,
  STORAGE_MIN_DEPOSIT,
  sha256Hex,
  storageShortfall,
  tokenMeta,
  U128StringSchema,
} from "@tender/shared";
import { z } from "zod";
import { secretCheck } from "../secrets";
import type { McpDeps, OpenFileLookup } from "../server";
import { type Draft, isDraftOf } from "../state";
import {
  describeError,
  errorText,
  formatAmount,
  formatNear,
  guarded,
  isoOfNs,
  jsonResult,
  scrub,
  TaskId,
  ToolError,
} from "./format";

// The tools that change something: start work, commit a result, reveal it, post a task, pick the
// winners, move money and register a profile. Each says so to the client (`readOnlyHint: false`),
// so that a client asks before it runs one.
//
// COMMIT AND REVEAL. A commit puts a hash on chain and keeps the work and the salt that open it in
// a draft on this machine, and nothing else holds them. So `commit_result` saves the draft BEFORE it
// sends the commit, and sets `committedAt` after: a crash at any point leaves a draft that the next
// call can finish. A draft with no `committedAt` may or may not have reached the chain, and the
// answer is never a new draft, because a new salt would orphan a commitment that did land. The next
// call asks the chain (`getEntry`) and sends the draft's own commitment, or marks it done. The
// contract has no "already committed" error, since `commit` replaces a commitment while the task is
// open, so the chain's entry is the only way to know. A commit that the contract refuses for good
// retires its draft (`markDead`), and a dead draft is never sent or revealed again.
//
// The store does not lock, so the calls of one task run one after another in this process. Two
// servers on one state directory are not supported, and the descriptions say so.
//
// MONEY. `deposit`, `withdraw` and `post_task` attach a deposit, which only a full-access key may.
// With any other key they answer `NEEDS_FULL_ACCESS_KEY` before they upload or send anything.
//
// FILES. `commit_result` takes its work as text or as a file, and `reveal_result` later publishes
// it, so a file path is a way to publish whatever the server can read. The server therefore reads
// only inside the one directory that the user named (`filesDir`, from `TENDER_FILES_DIR`), and
// none at all when there is none (P04-R1). That directory must be the user's alone (`readConfig`,
// P04-R2), and on Linux the open file is traced back to a path through its descriptor
// (`OpenFileLookup`). Work that holds one of the server's own secrets is
// refused, whether it came as text or as a file, since the scrubber sees what a tool says and never
// what a reveal uploads. The secret is looked for as it is and in the usual disguises (best effort),
// where the work comes in (a commit), where a draft's commit is sent again, and a last time just
// before a reveal uploads the work: a draft may hold what an earlier check did not see.
//
// PICKS. A scorecard is public, immutable and hashed on chain, and it says who made it. The API
// serves whichever one a pick names without reading that field, so `pick_winners` is where a
// scorecard is held to its picker: it must name the account that signs, and only the Judge's
// account may name the Judge's software. The contract's rules for the winners (`E_WINNERS`) are
// checked before the upload too, since a pick that the chain then refuses would leave the scorecard
// public all the same.

/** The most bytes a result may have: a brief's `output.max_bytes` can be no more. */
const MAX_RESULT = MAX_RESULT_BYTES;
/** The largest a window can be: the contract keeps one in a u32. */
const MAX_WINDOW_SECS = 4_294_967_295;
/**
 * What a top-up pays on top of the shortfall: 0.01 NEAR, so that the next entry does not need
 * another one (ruling P04-P2).
 */
const STORAGE_TOP_UP_MARGIN = STORAGE_MIN_DEPOSIT;
/**
 * The codes with which the contract refuses a commit that no retry can fix (P05-R14): the task is
 * not there, is not open, does not take this account, or the arguments are wrong. Anything else
 * may pass: storage can be topped up, a pause can end, a node can come back.
 */
const REFUSED_FOR_GOOD: ReadonlySet<string> = new Set([
  "E_NOT_FOUND",
  "E_PHASE",
  "E_AUTH",
  "E_INVITE",
  "E_HASH",
  "E_FULL",
  "E_ARGS",
]);
/** How long the reason stored with a retired draft may be. */
const MAX_REASON = 300;
/**
 * A `judge.software` that claims to be the team's Judge, which writes `tender-judge/1`. The name is
 * free text, so it is matched in any case and after spaces.
 */
const JUDGE_SOFTWARE = /^\s*tender-judge/i;
/** What the winners' shares of a pick add up to, in basis points. */
const BPS_WHOLE = 10_000;

const FULL_ACCESS_ONLY =
  "this tool moves money; run it with a full-access key or set up a delegate key with caps (docs/MCP.md)";

/**
 * What the tools tell a client about themselves; none is read-only. A tool that moves money or
 * cannot be taken back is destructive and not idempotent, and a client may ask before it runs one.
 */
const IDEMPOTENT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const SPENDS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

type TxEvent = TxResult["events"][number];

/** The first fault or few of a failed parse, on one line: where each is, and what is wrong there. */
function issuesOf(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const where = issue.path.map(String).join(".");
      return where === "" ? issue.message : `${where}: ${issue.message}`;
    })
    .join("; ");
}

/** `value`, if it is a NEAR account id; else a `BAD_INPUT` naming `what`. */
function asAccount(value: string, what: string): string {
  if (!AccountIdSchema.safeParse(value).success) {
    throw new ToolError("BAD_INPUT", `${what} must be a NEAR account id`);
  }
  return value;
}

/**
 * An amount as the write tools take it: a whole number above 0 of the token's smallest unit, in
 * digits. "1.5" is no amount, and neither is "1e6": reading either as a number of whole tokens would
 * move a thousand times too much or too little, so the text says what a whole token is.
 */
function asAmount(value: string, token: string, network: NetworkId): bigint {
  if (/^[0-9]+$/.test(value) && U128StringSchema.safeParse(value).success && BigInt(value) > 0n) {
    return BigInt(value);
  }
  const { symbol, decimals } = tokenMeta(token, network);
  throw new ToolError(
    "BAD_AMOUNT",
    "the amount must be a whole number above 0 of the token's smallest unit, in digits only " +
      `(no point, sign, space or exponent). For ${symbol}, "${10n ** BigInt(decimals)}" is 1 ${symbol}.`,
  );
}

/**
 * Whether `path` lies under `dir` (and is not `dir`), going by how the two are written: neither is
 * looked up. Whole path segments are compared, so that `/files-evil` is not under `/files`.
 */
function isInside(dir: string, path: string): boolean {
  const start = resolve(dir);
  return resolve(path).startsWith(start.endsWith(sep) ? start : start + sep);
}

/**
 * The one answer to a file that cannot be read from the directory, whatever the reason: missing,
 * outside, a link that leads out, or a file with another name. A reason would say what is on the disk
 * beyond the directory, to anyone who can put a link inside it that leads out.
 */
function unreadable(): ToolError {
  return new ToolError("FILE_UNREADABLE", "cannot read that file inside TENDER_FILES_DIR");
}

/**
 * Where `path` leads (a real path), if that is a place under `directory` (a real path as well). A
 * path that leads nowhere and one that leads out get the same answer, `unreadable()`.
 */
async function realInside(path: string, directory: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw unreadable();
  }
  if (!isInside(directory, real)) throw unreadable();
  return real;
}

/** The real lookup of an open file: on Linux, `/proc/self/fd/N` is where the kernel has file N. */
const PROCESS_FILES: OpenFileLookup = {
  platform: process.platform,
  pathOf: (fd) => realpath(`/proc/self/fd/${fd}`),
};

/**
 * The bytes of the file at `path`, at most `limit` of them, if it is a regular file inside
 * `filesDir` (P04-R1). Where a path leads is what counts, and not how it is written: `realpath`
 * follows every link and every `..`, and the file's real path must lie under the directory's real
 * path, so that no link, `..` or other name for the same place gets a file out of the directory.
 *
 * Three gaps are closed after that. The path is looked up and the file opened a moment later, and a
 * folder on the way could be swapped for a link in between; so once the file is open, the path is
 * looked up again, and must still lead inside, to the very file that is open (the same device and
 * inode). A hard link inside the directory to a file outside it leads nowhere that a path shows, so
 * a file with more than one name counts as outside; the count is read at both looks, since a name
 * made after the first shows only in the second. And on Linux the kernel is asked where the open
 * file is (`openFiles`), which is a look at the descriptor and not at a name, and must be inside.
 *
 * What is left (P04-R2). Looking a path up again is a look at a name, and a name can be swapped back
 * and forth between the looks, so that each look finds what it expects. On macOS, and on any
 * platform without the descriptor, somebody who can already write in your own directory can still
 * race the check. `readConfig` refuses a directory that anyone but the user (or root) can write in,
 * which limits that somebody to you.
 *
 * A path that leads nowhere, out, or to a file that fails any check gets `unreadable()` and
 * nothing more, and nothing is said about a file (what it is, how big) until it has passed them all.
 * (A file that passes may still fail to open or to be read, and says why. The directory is the
 * user's to get right, and its own faults are named.)
 */
async function readLocalFile(
  path: string,
  limit: number,
  filesDir: string | undefined,
  openFiles: OpenFileLookup,
): Promise<Uint8Array> {
  if (filesDir === undefined) {
    throw new ToolError(
      "FILES_DIR_NOT_SET",
      "file_path is not available: this server was not given a directory to read files from. " +
        "Set TENDER_FILES_DIR to one, or pass the result as content.",
    );
  }
  if (!isAbsolute(path)) throw new ToolError("BAD_INPUT", "file_path must be an absolute path");
  let directory: string;
  try {
    directory = await realpath(filesDir);
  } catch (error) {
    throw new ToolError(
      "FILE_UNREADABLE",
      `the directory that files are read from (${filesDir}) cannot be used: ${errorText(error)}`,
    );
  }
  const real = await realInside(path, directory);

  let handle: FileHandle;
  try {
    // Non-blocking, so that opening a named pipe cannot hang until somebody writes to it, and never
    // through a link, so that a name swapped for one since the check is not followed.
    handle = await open(
      real,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new ToolError("FILE_UNREADABLE", errorText(error));
  }
  try {
    // Where the kernel has the open file, if it can say (Linux): the descriptor cannot be swapped.
    if (openFiles.platform === "linux") {
      let opened: string;
      try {
        opened = await openFiles.pathOf(handle.fd);
      } catch {
        throw unreadable();
      }
      if (!isInside(directory, opened)) throw unreadable();
    }
    // Whole numbers (bigint), so that inodes beyond 2^53 are told apart too.
    const stats = await handle.stat({ bigint: true });
    // Is the file that is open the one the path leads to now, and is that inside still?
    const again = await realInside(path, directory);
    let there: BigIntStats;
    try {
      there = await stat(again, { bigint: true });
    } catch {
      throw unreadable();
    }
    if (there.dev !== stats.dev || there.ino !== stats.ino) throw unreadable();
    // Another name for the file may be outside. (A folder's link count does not count names.) The
    // later look counts too: a name made since the first shows only in it.
    if ((stats.nlink > 1n || there.nlink > 1n) && !stats.isDirectory()) throw unreadable();
    if (!stats.isFile()) throw new ToolError("BAD_INPUT", "file_path is not a regular file");
    if (stats.size > BigInt(limit)) throw tooLarge(Number(stats.size), limit);
    // One byte more than the limit, so that a file that grew since the `stat` is still caught.
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > limit) throw tooLarge(total, limit);
    return new Uint8Array(buffer.subarray(0, total));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("FILE_UNREADABLE", errorText(error));
  } finally {
    await handle.close();
  }
}

function tooLarge(size: number, limit: number): ToolError {
  return new ToolError(
    "TOO_LARGE",
    `the result is ${size} bytes, and the most a result may have is ${limit}`,
  );
}

/** Registers the write tools on `server`. */
export function registerWriteTools(server: McpServer, deps: McpDeps): void {
  const { api, client, state, network, accountId, contractId, filesDir } = deps;
  const secrets = deps.secrets ?? [];
  const minWindowSecs = NETWORKS[network].minWindowSecs;

  // ---- Shared steps ---------------------------------------------------------------------------

  /** The tail of each task's queue of calls; see `withTaskLock`. */
  const queues = new Map<string, Promise<void>>();

  /**
   * Runs `run` once every call that came before it for `taskId` has finished, however it ended. The
   * state store does not lock, and a commit or reveal reads the draft, talks to the chain and
   * writes the draft: two of them at once for one task could each act on a draft that the other
   * is about to change. Calls for other tasks do not wait.
   */
  async function withTaskLock<T>(taskId: string, run: () => Promise<T>): Promise<T> {
    const result = (queues.get(taskId) ?? Promise.resolve()).then(run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(taskId, tail);
    try {
      return await result;
    } finally {
      // Nothing came after this call, so there is no queue to keep.
      if (queues.get(taskId) === tail) queues.delete(taskId);
    }
  }

  function requireFullAccess(): void {
    if (deps.keyKind !== "full_access") {
      throw new ToolError("NEEDS_FULL_ACCESS_KEY", FULL_ACCESS_ONLY);
    }
  }

  /**
   * Whether `bytes` hold any secret of the server, which a reveal would make public: as it is or in
   * a disguise (best effort; see `secretCheck`).
   */
  const holdsSecret = secretCheck(secrets);

  /** The work that a draft holds. */
  function workOf(draft: Draft): Uint8Array {
    return new Uint8Array(Buffer.from(draft.contentBase64, "base64"));
  }

  /** The draft of `taskId`, or null. A draft that another account made is refused, not returned. */
  async function loadDraft(taskId: string): Promise<Draft | null> {
    let draft: Draft | null;
    try {
      draft = await state.getDraft(taskId);
    } catch (error) {
      throw new ToolError("DRAFT_UNREADABLE", errorText(error));
    }
    if (draft !== null && !isDraftOf(draft, accountId)) {
      throw new ToolError(
        "DRAFT_NOT_YOURS",
        `the draft saved here for task ${taskId} was not made by ${accountId}, so it is left ` +
          "alone. Give each account a state directory of its own (TENDER_STATE_DIR).",
      );
    }
    return draft;
  }

  function deadError(draft: Draft): ToolError {
    return new ToolError(
      "DRAFT_DEAD",
      `the draft for task ${draft.taskId} was retired: ${draft.dead?.reason ?? "refused by the contract"}. ` +
        "It will not be sent or revealed.",
    );
  }

  /** When the reveal opens (the commit window's end), if the API says. It is a courtesy. */
  async function revealOpensAt(taskId: string): Promise<string | null> {
    try {
      const detail = await api.getTask(BigInt(taskId));
      return detail === null ? null : isoOfNs(detail.task.commit_deadline);
    } catch {
      return null;
    }
  }

  /**
   * Makes sure that `accountId` has the storage for what it is about to do: 1,024 bytes of contract
   * state. That is what an entry's commit and reveal need (an entry that runs out cannot reveal,
   * and its window does not wait), and it covers a deposit's vault slot and a profile too. A
   * full-access key pays the shortfall in, and 0.01 NEAR more. Any other key cannot attach the
   * deposit, so the call stops and says who must; `purpose` is what it was going to do, in words
   * that finish "more to ...". Returns the yoctoNEAR that were added, 0 if none had to be.
   */
  async function ensureStorage(purpose: string): Promise<bigint> {
    const view = await client.storageBalanceOf(accountId);
    const shortfall = storageShortfall(view);
    if (shortfall === 0n) return 0n;
    if (deps.keyKind === "full_access") {
      const added = shortfall + STORAGE_TOP_UP_MARGIN;
      await client.storageDeposit(added);
      return added;
    }
    const has =
      view === null ? "no storage deposit" : `${view.available} yoctoNEAR of free storage`;
    throw new ToolError(
      "STORAGE_LOW",
      `${accountId} has ${has} in ${contractId} and needs ${shortfall} yoctoNEAR ` +
        `(${formatNear(shortfall)}) more to ${purpose}. This key cannot attach a deposit, ` +
        `so nothing was sent. Ask a full-access account to call storage_deposit on the contract ` +
        `with account_id ${accountId} and at least that much attached; then call this tool again.`,
    );
  }

  /** The answer's note that NEAR was added to the storage deposit for `need`, if any was. */
  function topUpNote(added: bigint, need: string): { note?: string } {
    if (added === 0n) return {};
    return {
      note: `added ${formatNear(added)} to your storage deposit in ${contractId} first, which ${need} needs`,
    };
  }

  /** Uploads a document the way every document goes up, and checks what the API stored. */
  async function uploadDocument(
    kind: "brief" | "criteria" | "scorecard" | "profile",
    bytes: Uint8Array,
  ): Promise<{ hash: string; uri: string }> {
    const hash = sha256Hex(bytes);
    const stored = await api.uploadBlob({ kind, contentType: "application/json", bytes });
    if (stored.sha256 !== hash) {
      throw new ToolError(
        "HASH_MISMATCH",
        `the API stored the ${kind} under a hash other than ${hash}, so nothing was sent to the chain`,
      );
    }
    return { hash, uri: stored.uri };
  }

  // ---- start_task -----------------------------------------------------------------------------

  server.registerTool(
    "start_task",
    {
      title: "Start a task",
      description:
        "Say that you have started work on an open task. It changes nothing on chain; it lets the " +
        "poster and other agents see how many are working (working_count). Optional, and safe to " +
        "repeat.",
      inputSchema: { task_id: TaskId },
      annotations: IDEMPOTENT,
    },
    guarded(secrets, async ({ task_id }) => {
      const { working_count } = await api.start(BigInt(task_id));
      return jsonResult({ working_count });
    }),
  );

  // ---- commit_result --------------------------------------------------------------------------

  /** The answer of a commit: the draft's own numbers, and whether this call sent anything. */
  async function commitAnswer(
    draft: Draft,
    txHash: string | null,
    note?: string,
  ): Promise<CallToolResult> {
    return jsonResult({
      commitment: draft.commitment,
      content_hash: draft.contentHash,
      tx_hash: txHash,
      reveal_opens_at: await revealOpensAt(draft.taskId),
      ...(note !== undefined && { note }),
    });
  }

  /** Whether the chain has this draft's commitment as `accountId`'s entry; null if it cannot say. */
  async function isOnChain(draft: Draft): Promise<boolean | null> {
    try {
      const entry = await client.getEntry(BigInt(draft.taskId), accountId);
      return entry !== null && entry.commitment === draft.commitment;
    } catch {
      return null;
    }
  }

  /**
   * Marks the draft committed. The commit is on chain, so a disk that fails only costs a note. The
   * note rides in an answer that succeeded, which no `guarded` cleans, so it is cleaned here.
   */
  async function markCommitted(draft: Draft): Promise<string | undefined> {
    try {
      await state.saveDraft({ ...draft, committedAt: new Date().toISOString() });
      return undefined;
    } catch (error) {
      return (
        `the draft could not be marked as committed (${scrub(errorText(error), secrets)}); ` +
        "calling commit_result again will find the commit on chain and mark it"
      );
    }
  }

  /** Sends the draft's commitment, and says what became of the draft. */
  async function sendCommit(draft: Draft, note?: string): Promise<CallToolResult> {
    let sent: TxResult;
    try {
      sent = await client.commit(BigInt(draft.taskId), draft.commitment);
    } catch (error) {
      const { code, message } = describeError(error);
      if (error instanceof TenderError && REFUSED_FOR_GOOD.has(error.code)) {
        // An earlier send of this very commitment may have landed before the process died, and then
        // the contract refuses this one (the window has closed since). That draft is not dead: it
        // is the key to an entry that stands.
        const landed = await isOnChain(draft);
        if (landed === true) {
          const markNote = await markCommitted(draft);
          return commitAnswer(
            draft,
            null,
            [note, "the commit is on chain already; nothing more was sent", markNote]
              .filter(Boolean)
              .join(" "),
          );
        }
        if (landed === null) {
          throw new ToolError(
            code,
            `${message} (the chain could not be asked whether an earlier send of this commit ` +
              "landed, so the draft is left as it is; try again)",
          );
        }
        // No retry will do: say so on the draft, so that nothing sends or reveals it again.
        const reason = scrub(`${code}: ${message}`, secrets).slice(0, MAX_REASON);
        let fate = "this draft is retired";
        try {
          await state.markDead(draft.taskId, reason);
        } catch (markError) {
          fate = `this draft could not be retired (${errorText(markError)})`;
        }
        throw new ToolError(
          code,
          `${message} (the contract refused this commit for good, so ${fate} and will not be sent again)`,
        );
      }
      throw new ToolError(
        code,
        `${message} (the draft is saved; call commit_result again with the same content to ` +
          "finish this commit)",
      );
    }
    const markNote = await markCommitted(draft);
    return commitAnswer(
      draft,
      sent.txHash,
      [note, markNote].filter(Boolean).join(" ") || undefined,
    );
  }

  /**
   * What the task allows a result to have: the `output.max_bytes` of its brief, which the API
   * serves and the contract does not know. When the API cannot say, the answer is why, and the
   * commit goes on, as it did before the limit was checked: a commit does not hang on an API. When
   * it answers that there is no such task, the commit stops (`NO_TASK`): the contract would refuse
   * it with E_NOT_FOUND, and that retires the draft for good, so a mistyped id would leave a draft
   * that blocks the id if a task is posted under it later.
   */
  async function taskLimit(taskId: string): Promise<{ max: number } | { unknown: string }> {
    let detail: Awaited<ReturnType<typeof api.getTask>>;
    try {
      detail = await api.getTask(BigInt(taskId));
    } catch {
      return { unknown: "the API did not answer" };
    }
    if (detail === null) throw new ToolError("NO_TASK", `no task ${taskId}`);
    const max = detail.brief?.output.max_bytes;
    return max === undefined ? { unknown: "the API has no brief for this task yet" } : { max };
  }

  /** A first commit for a task: the task's limit, the storage, then the draft, then the commit. */
  async function commitNew(taskId: string, bytes: Uint8Array): Promise<CallToolResult> {
    // The task comes before anything is made or spent: work that its task will not take can be
    // committed and never revealed, a task that is not there leaves a draft that blocks its id, and
    // the storage top-up below would be paid for nothing.
    const allowed = await taskLimit(taskId);
    if ("max" in allowed && bytes.length > allowed.max) {
      throw new ToolError("TOO_LARGE", `the task allows at most ${allowed.max} bytes`);
    }
    await ensureStorage("commit and reveal");
    const contentHash = sha256Hex(bytes);
    const salt = randomSalt();
    const draft: Draft = {
      taskId,
      contentBase64: Buffer.from(bytes).toString("base64"),
      contentHash,
      salt,
      commitment: computeCommitment(BigInt(taskId), accountId, contentHash, salt),
    };
    // The draft goes to disk first. Once the commit is sent it may land at any moment, and without
    // the salt the entry could never be revealed.
    await state.saveDraft(draft);
    return sendCommit(
      draft,
      "unknown" in allowed
        ? `the task's own size limit could not be checked (${allowed.unknown})`
        : undefined,
    );
  }

  /** A draft whose commit may or may not have reached the chain: find out, then finish it. */
  async function commitPending(draft: Draft, differs: boolean): Promise<CallToolResult> {
    const note = differs
      ? "the content you gave differs from the draft saved earlier, which was finished as it was " +
        "because its commitment may already be on chain (see content_hash)"
      : undefined;
    let entry: Awaited<ReturnType<typeof client.getEntry>>;
    try {
      entry = await client.getEntry(BigInt(draft.taskId), accountId);
    } catch (error) {
      const { code, message } = describeError(error);
      throw new ToolError(
        code,
        `${message} (the chain could not be asked whether this commit landed, so nothing was sent; ` +
          "try again)",
      );
    }
    if (entry !== null && entry.commitment === draft.commitment) {
      const markNote = await markCommitted(draft);
      return commitAnswer(
        draft,
        null,
        [note, "the commit is on chain already; nothing was sent", markNote]
          .filter(Boolean)
          .join(" "),
      );
    }
    // The commit is about to be sent again, for work that the draft holds and this call has not
    // seen. If that work holds a secret, the entry would be one that only a reveal that publishes
    // the secret can use.
    if (holdsSecret(workOf(draft))) {
      throw new ToolError(
        "SECRET_IN_CONTENT",
        `the draft saved for task ${draft.taskId} holds a secret that this server was given (such as ` +
          "its private key), and reveal_result would publish it, so its commit was not sent. " +
          "Nothing was sent or spent. A draft cannot be changed: remove it from this server's " +
          "state directory to commit other work for this task",
      );
    }
    await ensureStorage("commit and reveal");
    return sendCommit(draft, note);
  }

  const resultSource =
    filesDir === undefined
      ? "Give the result as content (the text); file_path is not available on this server, which " +
        "has no directory to read files from"
      : "Give exactly one of content (the text) and file_path (an absolute path to a file inside " +
        `${filesDir}, the only place this server reads files from; its bytes are what you commit ` +
        "and what reveal_result will publish)";
  // One answer for all of them, and so the reasons are listed here: a file that is inside and still
  // refused (it has a second hard link) would otherwise be a puzzle.
  const fileRefusal =
    filesDir === undefined
      ? ""
      : "A file that cannot be read from there (it is missing, or outside, or reached by a link that " +
        "leads out, or it has a second hard link) is refused with FILE_UNREADABLE, and the answer " +
        "does not say which. ";

  server.registerTool(
    "commit_result",
    {
      title: "Commit a result",
      description:
        "Commit to your result for a task while it is open. Only a hash goes on chain; the work " +
        "stays secret until you call reveal_result after the commit window closes (reveal_opens_at). " +
        `${resultSource}, at most ${MAX_RESULT} bytes and no more than the task allows ` +
        "(output.max_bytes in its brief; TOO_LARGE if it is more, before anything is sent). " +
        fileRefusal +
        "A task that the API does not know is refused with NO_TASK, before anything is made or " +
        "spent (one posted a moment ago may need a few seconds to appear). A result that holds this " +
        "server's private key, or another secret it was given, is refused with SECRET_IN_CONTENT, " +
        "since reveal_result publishes the work. The check is best effort: it finds a secret as it " +
        "is and in the usual disguises (base64, hex, raw bytes, split over lines, UTF-16), and " +
        "not in every way it could be hidden. The work and a random salt are saved in a draft " +
        "on this machine BEFORE the transaction is sent, so a crash loses nothing. If a call " +
        "fails or the server stops, call commit_result again with the same content: it finds out " +
        "whether the commit landed and finishes it with the same salt, and sends nothing if it " +
        "is done. Once committed, an answer cannot be " +
        "changed through this server: a task takes one result here, and a call with other content " +
        "is refused with ALREADY_COMMITTED. A key that cannot attach a deposit refuses with " +
        "STORAGE_LOW when your storage in the contract is low; a full-access key tops it up " +
        "first. The draft lives in this server's state directory: two servers on one account's " +
        "state directory are not supported.",
      inputSchema: {
        task_id: TaskId,
        content: z
          .string()
          .optional()
          .describe("The result, as text. Leave out when using file_path"),
        file_path: z
          .string()
          .optional()
          .describe(
            filesDir === undefined
              ? "File reading is not available on this server (it has no directory to read files " +
                  "from): give content"
              : `Absolute path of a file inside ${filesDir} holding the result. Leave out when ` +
                  "using content",
          ),
      },
      annotations: IDEMPOTENT,
    },
    guarded(secrets, async ({ task_id, content, file_path }) => {
      // An empty string counts as not given: it is what a client may send for an unused field.
      const hasContent = content !== undefined && content !== "";
      const hasFile = file_path !== undefined && file_path !== "";
      if (hasContent === hasFile) {
        throw new ToolError("BAD_INPUT", "give exactly one of content and file_path");
      }
      const bytes = hasContent
        ? new TextEncoder().encode(content)
        : await readLocalFile(
            file_path ?? "",
            MAX_RESULT,
            filesDir,
            deps.openFiles ?? PROCESS_FILES,
          );
      if (bytes.length > MAX_RESULT) throw tooLarge(bytes.length, MAX_RESULT);
      if (holdsSecret(bytes)) {
        // The text never says which secret, or where in the work it is.
        throw new ToolError(
          "SECRET_IN_CONTENT",
          "the result holds a secret that this server was given (such as its private key), and " +
            "reveal_result would publish it. Nothing was saved or sent: take the secret out of the " +
            "result and call commit_result again",
        );
      }

      return withTaskLock(task_id, async () => {
        const draft = await loadDraft(task_id);
        if (draft === null) return commitNew(task_id, bytes);
        if (draft.dead !== undefined) throw deadError(draft);
        if (draft.revealedUri !== undefined) {
          throw new ToolError(
            "ALREADY_REVEALED",
            `the result for task ${task_id} was revealed already, so there is nothing to commit`,
          );
        }
        const same = sha256Hex(bytes) === draft.contentHash;
        if (draft.committedAt === undefined) return commitPending(draft, !same);
        if (!same) {
          throw new ToolError(
            "ALREADY_COMMITTED",
            `task ${task_id} is committed with other content (content_hash ${draft.contentHash}). ` +
              "This server keeps one result per task and does not replace a commit",
          );
        }
        return commitAnswer(draft, null, "already committed with this content; nothing was sent");
      });
    }),
  );

  // ---- reveal_result --------------------------------------------------------------------------

  /** How the work goes up: JSON when the brief asks for JSON, text otherwise. A courtesy too. */
  async function resultContentType(taskId: string): Promise<"application/json" | "text/plain"> {
    try {
      const format = (await api.getTask(BigInt(taskId)))?.brief?.output.format;
      return format === "json" || format === "regex_json" ? "application/json" : "text/plain";
    } catch {
      return "text/plain";
    }
  }

  /**
   * Where the chain has `accountId`'s entry revealed with this draft's work, or null if it does not
   * (not revealed, other work, or the chain cannot be asked). It is how a reveal that landed is
   * known when it is sent again: the contract answers E_REVEALED while the window is open, but
   * checks the phase before it checks for a second reveal, so after the reveal deadline the answer
   * is E_PHASE, which says nothing about the entry. The entry does.
   */
  async function revealedUri(draft: Draft): Promise<string | null> {
    try {
      const entry = await client.getEntry(BigInt(draft.taskId), accountId);
      return entry?.content_hash === draft.contentHash ? entry.uri : null;
    } catch {
      return null;
    }
  }

  async function revealResult(taskId: string): Promise<CallToolResult> {
    const draft = await loadDraft(taskId);
    if (draft === null) {
      throw new ToolError(
        "NO_DRAFT",
        `no draft is saved for task ${taskId} on this machine; commit_result makes one`,
      );
    }
    if (draft.dead !== undefined) throw deadError(draft);
    if (draft.revealedUri !== undefined) {
      return jsonResult({
        uri: draft.revealedUri,
        tx_hash: null,
        note: "this result was revealed already; nothing was sent",
      });
    }
    if (draft.committedAt === undefined) {
      // The commit was sent and the process may have died before it was marked: ask the chain.
      const entry = await client.getEntry(BigInt(taskId), accountId);
      if (entry === null || entry.commitment !== draft.commitment) {
        throw new ToolError(
          "NOT_COMMITTED",
          `the commit for task ${taskId} is not on chain; call commit_result first, which finishes ` +
            "a commit that did not complete",
        );
      }
      await markCommitted(draft);
    }

    // What goes up must be what was committed. A draft file that was changed on disk would reveal
    // a hash with other bytes behind it, which scores nothing and gives the work away.
    const bytes = workOf(draft);
    if (sha256Hex(bytes) !== draft.contentHash) {
      throw new ToolError(
        "DRAFT_CORRUPT",
        `the work saved for task ${taskId} no longer matches its hash, so it was not revealed`,
      );
    }
    // The last look before the work becomes public. A draft can hold what the commit did not see: it
    // may have been saved by a server that checked less, or under another key.
    if (holdsSecret(bytes)) {
      throw new ToolError(
        "SECRET_IN_CONTENT",
        `the work saved for task ${taskId} holds a secret that this server was given (such as its ` +
          "private key), and revealing it would publish the secret. Nothing was uploaded or sent. " +
          "A committed result cannot be changed through this server, so this entry stays " +
          "unrevealed while the secret is in it",
      );
    }
    let stored: { sha256: string; uri: string };
    try {
      stored = await api.uploadBlob({
        kind: "result",
        contentType: await resultContentType(taskId),
        bytes,
        taskId: BigInt(taskId),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        throw new ToolError(
          "API_ERROR",
          `${error.message}; the API may not have indexed your commit yet, so wait a few seconds ` +
            "and call reveal_result again",
        );
      }
      throw error;
    }
    if (stored.sha256 !== draft.contentHash) {
      throw new ToolError(
        "HASH_MISMATCH",
        `the API stored the work under another hash than ${draft.contentHash}, so it was not revealed`,
      );
    }

    const notes: string[] = [];
    let txHash: string | null = null;
    let uri = stored.uri;
    try {
      txHash = (await client.reveal(BigInt(taskId), draft.contentHash, draft.salt, stored.uri))
        .txHash;
    } catch (error) {
      // An earlier call may have revealed it and died before marking the draft: the work is out, so
      // mark it. The contract's refusal does not say so by itself (see `revealedUri`).
      const landed = error instanceof TenderError ? await revealedUri(draft) : null;
      if (landed === null) throw error;
      uri = landed;
      notes.push(
        "this entry was revealed already (an earlier reveal went through); nothing more was sent",
      );
    }
    try {
      await state.markRevealed(taskId, uri);
    } catch (error) {
      // As in `markCommitted`, the note rides in an answer that succeeded.
      notes.push(
        `the draft could not be marked as revealed (${scrub(errorText(error), secrets)}); ` +
          "calling reveal_result again will mark it",
      );
    }
    return jsonResult({
      uri,
      tx_hash: txHash,
      ...(notes.length > 0 && { note: notes.join(" ") }),
    });
  }

  server.registerTool(
    "reveal_result",
    {
      title: "Reveal a result",
      description:
        "Reveal the result you committed to with commit_result, once the commit window has closed " +
        "and before the reveal deadline. It uploads the saved work, which becomes public, and sends " +
        "the reveal with the salt that proves it is the work you committed to. The work is looked " +
        "at once more for this server's secrets before it goes up (SECRET_IN_CONTENT, best effort " +
        "as at commit), and then nothing is uploaded or sent. If a call fails " +
        "part way, call it again: the upload is repeatable, and a reveal that already went " +
        "through is recognised, even after the reveal deadline. Needs a draft from commit_result " +
        "on this machine (NO_DRAFT otherwise). The draft lives in this server's state directory: " +
        "two servers on one account's state directory are not supported.",
      inputSchema: { task_id: TaskId },
      annotations: IDEMPOTENT,
    },
    guarded(secrets, ({ task_id }) => withTaskLock(task_id, () => revealResult(task_id))),
  );

  // ---- post_task ------------------------------------------------------------------------------

  const windowSecs = (what: string) =>
    z
      .int()
      .min(minWindowSecs)
      .max(MAX_WINDOW_SECS)
      .describe(`${what}, in seconds, at least ${minWindowSecs}`);

  server.registerTool(
    "post_task",
    {
      title: "Post a task",
      description:
        "Post a task and pay its reward from your vault in Tender (deposit first; balance shows " +
        "it). The brief and the public criteria are uploaded, their hashes go on chain, and the " +
        "optional held-out part (the hidden answers the Judge scores with) is uploaded to a private " +
        "intake and committed to by its hash. reward is a whole number of the token's smallest " +
        'unit: for USDC "1000000" is 1 USDC. The four windows are in seconds. verifier is "judge" ' +
        "for the Tender Judge, a NEAR account id, or left out to pick the winners yourself. Needs a " +
        "full-access key.",
      inputSchema: {
        title: BriefSchema.shape.title.describe("The task's title, 1 to 120 characters"),
        summary: BriefSchema.shape.summary.describe("One or two sentences, up to 280 characters"),
        instructions: BriefSchema.shape.instructions.describe(
          "What the agent must do and what the result must look like, up to 8000 characters",
        ),
        category: BriefSchema.shape.category,
        tags: BriefSchema.shape.tags.describe(
          "Up to 8 tags: a-z, 0-9 and -, up to 24 characters each",
        ),
        output_format: BriefSchema.shape.output.shape.format.describe("The format of a result"),
        max_bytes: BriefSchema.shape.output.shape.max_bytes
          .optional()
          .describe(`The most bytes a result may have (default ${MAX_RESULT})`),
        criteria: z
          .record(z.string(), z.unknown())
          .describe(
            "The public criteria document: { version: 1, kind, min_score, split, has_heldout, ... } " +
              "with the fields of its kind (exact, json_schema, regex_cases, tests or rubric)",
          ),
        heldout: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "The held-out document, with one key, the criteria kind. Give it exactly when " +
              "criteria.has_heldout is true. It stays private until the task is scored",
          ),
        reward: z.string().describe("The reward, a whole number of the token's smallest unit"),
        token: z
          .string()
          .optional()
          .describe("The token's account id (default: this server's token)"),
        verifier: z
          .string()
          .optional()
          .describe('"judge", or the account id of whoever picks the winners (default: you)'),
        commit_secs: windowSecs("How long entries may commit"),
        reveal_secs: windowSecs("How long entries may reveal after that"),
        pick_secs: windowSecs("How long the verifier has to pick after that"),
        fallback_secs: windowSecs("How long after that before the task can be voided"),
        max_winners: z
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("The most winners, 1 to 5 (default 1)"),
        invited: z
          .array(z.string())
          .optional()
          .describe("Accounts that may enter. Leave out to let anyone enter"),
      },
      annotations: SPENDS,
    },
    guarded(secrets, async (input) => {
      requireFullAccess();

      let verifier: string | undefined;
      if (input.verifier === "judge") {
        if (deps.judgeAccount === undefined) {
          throw new ToolError(
            "NO_JUDGE_ACCOUNT",
            'verifier "judge" needs the Judge\'s account, which this server was not told: set ' +
              "TENDER_JUDGE_ACCOUNT, or name the verifier by its account id",
          );
        }
        verifier = deps.judgeAccount;
      } else if (input.verifier !== undefined) {
        if (!AccountIdSchema.safeParse(input.verifier).success) {
          throw new ToolError("BAD_INPUT", 'verifier must be "judge" or a NEAR account id');
        }
        verifier = input.verifier;
      }
      const token = asAccount(input.token ?? deps.defaultToken, "token");
      const reward = asAmount(input.reward, token, network);
      const invited = input.invited?.map((account) => asAccount(account, "invited"));

      // Everything is checked here, before anything is uploaded or paid, against the same schemas
      // that the API and the Judge use.
      const brief = BriefSchema.safeParse({
        version: 1,
        title: input.title,
        summary: input.summary,
        instructions: input.instructions,
        category: input.category,
        tags: input.tags,
        output: { format: input.output_format, max_bytes: input.max_bytes ?? MAX_RESULT },
      });
      if (!brief.success) throw new ToolError("INVALID_BRIEF", issuesOf(brief.error));
      const criteria = PublicCriteriaSchema.safeParse(input.criteria);
      if (!criteria.success) throw new ToolError("INVALID_CRITERIA", issuesOf(criteria.error));
      if (criteria.data.has_heldout !== (input.heldout !== undefined)) {
        throw new ToolError(
          "INVALID_CRITERIA",
          criteria.data.has_heldout
            ? "criteria.has_heldout is true, but no heldout document was given"
            : "criteria.has_heldout is false, but a heldout document was given",
        );
      }
      let heldoutBytes: Uint8Array | undefined;
      if (input.heldout !== undefined) {
        const heldout = HeldoutSchema.safeParse(input.heldout);
        if (!heldout.success) throw new ToolError("INVALID_HELDOUT", issuesOf(heldout.error));
        if (!heldoutMatchesCriteria(criteria.data, heldout.data)) {
          throw new ToolError(
            "INVALID_HELDOUT",
            `the held-out document is not of the criteria's kind (${criteria.data.kind})`,
          );
        }
        heldoutBytes = canonicalJson(heldout.data);
      }

      const briefDoc = await uploadDocument("brief", canonicalJson(brief.data));
      const criteriaDoc = await uploadDocument("criteria", canonicalJson(criteria.data));
      const heldoutCommitment = heldoutBytes === undefined ? undefined : sha256Hex(heldoutBytes);
      if (heldoutBytes !== undefined && heldoutCommitment !== undefined) {
        await api.uploadHeldout(heldoutCommitment, heldoutBytes);
      }

      const posted = await client.postTask({
        token,
        reward,
        briefUri: briefDoc.uri,
        briefHash: briefDoc.hash,
        criteriaHash: criteriaDoc.hash,
        ...(heldoutCommitment !== undefined && { heldoutCommitment }),
        ...(verifier !== undefined && { verifier }),
        commitSecs: input.commit_secs,
        revealSecs: input.reveal_secs,
        pickSecs: input.pick_secs,
        fallbackSecs: input.fallback_secs,
        ...(input.max_winners !== undefined && { maxWinners: input.max_winners }),
        ...(invited !== undefined && invited.length > 0 && { invited }),
      });
      const created = posted.events.find(
        (event): event is Extract<TxEvent, { event: "task_created" }> =>
          event.event === "task_created",
      );
      return jsonResult({
        task_id: posted.taskId.toString(),
        tx_hash: posted.txHash,
        commit_deadline: created === undefined ? null : isoOfNs(created.data.commit_deadline),
      });
    }),
  );

  // ---- pick_winners ---------------------------------------------------------------------------

  /**
   * The contract's rules for a non-empty pick (`E_WINNERS`, in `check_winners`), checked before the
   * scorecard goes up: the shares add up to exactly 10,000, no account is named twice, the task pays
   * that many winners, and each winner has a revealed entry. The shares and names are the arguments'
   * own; the task and its entries come from the API, the one place that lists them. A pick that the
   * chain then refused would still leave the scorecard public.
   */
  async function checkWinners(
    taskId: string,
    winners: ReadonlyArray<{ account: string; bps: number }>,
  ): Promise<void> {
    const total = winners.reduce((sum, winner) => sum + winner.bps, 0);
    if (total !== BPS_WHOLE) {
      throw new ToolError(
        "INVALID_WINNERS",
        `the shares add up to ${total}, and they must add up to exactly ${BPS_WHOLE}`,
      );
    }
    const named = new Set<string>();
    for (const { account } of winners) {
      if (named.has(account)) {
        throw new ToolError("INVALID_WINNERS", `${account} is named more than once`);
      }
      named.add(account);
    }

    const detail = await api.getTask(BigInt(taskId));
    if (detail === null) {
      throw new ToolError("NO_TASK", `the API has no task ${taskId}, so there is nothing to pick`);
    }
    const most = detail.task.max_winners;
    if (winners.length > most) {
      throw new ToolError(
        "INVALID_WINNERS",
        `task ${taskId} pays at most ${most} winners, and ${winners.length} were named`,
      );
    }
    for (const { account } of winners) {
      if (!detail.entries.some((entry) => entry.account === account && entry.revealed)) {
        throw new ToolError(
          "INVALID_WINNERS",
          `${account} has no revealed entry in task ${taskId}, as far as the API knows. Only an ` +
            "account that revealed can win; if it revealed a moment ago, the index may not have " +
            "caught up yet, so wait a few seconds and call again",
        );
      }
    }
  }

  server.registerTool(
    "pick_winners",
    {
      title: "Pick the winners",
      description:
        "As a task's verifier, pick its winners. scorecard is the document that shows how every " +
        "revealed entry scored: make it yourself from the entries (task_entries), with verifier " +
        "set to your own account and judge.software naming your own software, because a " +
        "scorecard is published in the name of whoever picks with it (SCORECARD_MISMATCH " +
        "otherwise; software that starts with tender-judge is the Judge account's alone). " +
        "get_scorecard shows the shape, but what it returns is the Judge's, so do not reuse it. " +
        "The scorecard is checked, published and its hash goes on chain with the pick. winners " +
        "must be exactly the scorecard's winners: each account and its share in basis points of " +
        "the reward after the fee. A non-empty list must add up to exactly 10000, name each " +
        "account once, name no more accounts than the task pays (max_winners) and only accounts " +
        "that revealed an entry; INVALID_WINNERS otherwise, before anything is published. An " +
        "empty list awards nothing. Final: a pick cannot be changed.",
      inputSchema: {
        task_id: TaskId,
        winners: z
          .array(
            z.strictObject({
              account: AccountIdSchema,
              bps: z.int().min(1).max(BPS_WHOLE),
            }),
          )
          .max(5)
          .describe("The winners, at most 5, whose shares are in basis points"),
        scorecard: z.record(z.string(), z.unknown()).describe("The scorecard document"),
      },
      annotations: SPENDS,
    },
    guarded(secrets, async ({ task_id, winners, scorecard }) => {
      const card = ScorecardSchema.safeParse(scorecard);
      if (!card.success) throw new ToolError("INVALID_SCORECARD", issuesOf(card.error));
      if (card.data.task_id !== task_id) {
        throw new ToolError(
          "SCORECARD_MISMATCH",
          `the scorecard is for task ${card.data.task_id}, not task ${task_id}`,
        );
      }
      // Nothing downstream reads these two fields, so this is where they are held to the picker.
      if (card.data.verifier !== accountId) {
        throw new ToolError(
          "SCORECARD_MISMATCH",
          `the scorecard names ${card.data.verifier} as its verifier, but this server picks as ` +
            `${accountId}, and a scorecard is published in the name of the account that picks ` +
            "with it. Make your own, naming you as its verifier; do not reuse another's, the " +
            "Judge's from get_scorecard included",
        );
      }
      if (JUDGE_SOFTWARE.test(card.data.judge.software) && accountId !== deps.judgeAccount) {
        throw new ToolError(
          "SCORECARD_MISMATCH",
          "the scorecard's judge.software starts with tender-judge, which only the Judge's " +
            "account may use: name your own software",
        );
      }
      const same =
        card.data.winners.length === winners.length &&
        card.data.winners.every(
          (winner, index) =>
            winner.account === winners[index]?.account && winner.bps === winners[index]?.bps,
        );
      if (!same) {
        throw new ToolError(
          "SCORECARD_MISMATCH",
          "winners must be the scorecard's winners, in order",
        );
      }
      if (winners.length > 0) await checkWinners(task_id, winners);

      const doc = await uploadDocument("scorecard", canonicalJson(card.data));
      const picked = await client.pick(BigInt(task_id), winners, doc.hash, doc.uri);
      return jsonResult({
        tx_hash: picked.txHash,
        scorecard_uri: doc.uri,
        scorecard_hash: doc.hash,
      });
    }),
  );

  // ---- deposit and withdraw -------------------------------------------------------------------

  server.registerTool(
    "deposit",
    {
      title: "Deposit",
      description:
        "Move tokens from your account into your vault in Tender, where post_task takes rewards " +
        'from. amount is a whole number of the token\'s smallest unit: for USDC "1000000" is 1 ' +
        "USDC. Tender takes a deposit only for an account with a storage deposit, so the tool " +
        "adds the NEAR for one from your account first when you have too little (the answer's " +
        "note says how much). A deposit that Tender refuses is refunded and this tool says so. " +
        "Needs a full-access key.",
      inputSchema: {
        amount: z.string().describe("A whole number of the token's smallest unit"),
        token: z
          .string()
          .optional()
          .describe("The token's account id (default: this server's token)"),
      },
      annotations: SPENDS,
    },
    guarded(secrets, async (input) => {
      requireFullAccess();
      const token = asAccount(input.token ?? deps.defaultToken, "token");
      const amount = asAmount(input.amount, token, network);

      // Tender credits a deposit only to an account whose storage balance has room for the token's
      // slot, and refunds it otherwise: a fresh poster's first deposit would come straight back.
      const registered = await ensureStorage("make a deposit");
      const sent = await client.deposit(token, amount);
      let credited = 0n;
      for (const event of sent.events) {
        if (event.event === "deposit" && event.data.account === accountId) {
          credited += BigInt(event.data.amount);
        }
      }
      if (credited === 0n && typeof sent.returnValue === "string") {
        credited = U128StringSchema.safeParse(sent.returnValue).success
          ? BigInt(sent.returnValue)
          : 0n;
      }
      if (credited === 0n) {
        throw new ToolError(
          "DEPOSIT_REFUSED",
          `Tender refunded the deposit and credited nothing (transaction ${sent.txHash}). The ` +
            "usual cause is that the token is not enabled in Tender: balance lists the tokens " +
            "it takes",
        );
      }
      return jsonResult({
        tx_hash: sent.txHash,
        token,
        credited: credited.toString(),
        credited_formatted: formatAmount(credited, token, network),
        ...topUpNote(registered, "a deposit"),
      });
    }),
  );

  server.registerTool(
    "withdraw",
    {
      title: "Withdraw",
      description:
        "Move tokens from your vault in Tender to your account, or to another account (to). amount " +
        'is a whole number of the token\'s smallest unit: for USDC "1000000" is 1 USDC. The ' +
        "receiving account must be registered with the token; if it is not, the token refuses, " +
        "the amount stays in your vault and this tool says so. Needs a full-access key.",
      inputSchema: {
        amount: z.string().describe("A whole number of the token's smallest unit"),
        token: z
          .string()
          .optional()
          .describe("The token's account id (default: this server's token)"),
        to: z.string().optional().describe("The account to pay (default: you)"),
      },
      annotations: SPENDS,
    },
    guarded(secrets, async (input) => {
      requireFullAccess();
      const token = asAccount(input.token ?? deps.defaultToken, "token");
      const to = input.to === undefined ? undefined : asAccount(input.to, "to");
      const amount = asAmount(input.amount, token, network);

      const sent = await client.withdraw(token, amount, to);
      const failed =
        sent.returnValue === false ||
        sent.events.some((event) => event.event === "withdraw_failed");
      const paid =
        sent.returnValue === true || sent.events.some((event) => event.event === "withdraw");
      const shown = formatAmount(amount, token, network);
      if (failed) {
        throw new ToolError(
          "WITHDRAW_FAILED",
          `the token did not pay, so ${shown} is back in your vault (transaction ${sent.txHash}). ` +
            `The usual cause is that ${to ?? accountId} is not registered with the token ` +
            "(storage_deposit on the token's contract): register it, or withdraw to an account that is",
        );
      }
      if (!paid) {
        throw new ToolError(
          "WITHDRAW_UNCONFIRMED",
          `transaction ${sent.txHash} neither paid nor failed in a way this tool can read: check ` +
            "balance, and the receiver's balance of the token, before trying again",
        );
      }
      return jsonResult({
        tx_hash: sent.txHash,
        token,
        amount: amount.toString(),
        amount_formatted: shown,
        to: to ?? accountId,
      });
    }),
  );

  // ---- register_agent -------------------------------------------------------------------------

  server.registerTool(
    "register_agent",
    {
      title: "Register your agent",
      description:
        "Register this account as an agent, or update its profile: a name, a description and tags " +
        "that other agents and posters see. The profile is uploaded and its hash goes on chain. " +
        "Tender charges the profile to your storage deposit, so a full-access key adds the NEAR " +
        "for it from your account first when you have too little (the answer's note says how " +
        "much); any other key cannot attach a deposit, and the tool stops with STORAGE_LOW, " +
        "saying who must. Safe to repeat; the last profile stands.",
      inputSchema: {
        name: ProfileSchema.shape.name.describe("Your agent's name, 1 to 64 characters"),
        description: ProfileSchema.shape.description.describe(
          "What your agent does, up to 280 characters",
        ),
        tags: ProfileSchema.shape.tags.describe(
          "Up to 8 tags: a-z, 0-9 and -, up to 24 characters each",
        ),
        homepage: ProfileSchema.shape.homepage.describe("Your agent's own page, an http(s) URL"),
      },
      annotations: IDEMPOTENT,
    },
    guarded(secrets, async ({ name, description, tags, homepage }) => {
      // The contract takes the profile's bytes out of the caller's storage balance (E_STORAGE when
      // there is none), so the balance is made good first, as it is for a deposit.
      const added = await ensureStorage("register a profile");
      const profile = await uploadDocument(
        "profile",
        canonicalJson({ name, description, tags, ...(homepage !== undefined && { homepage }) }),
      );
      const registered = await client.registerAgent(profile.uri, profile.hash, tags);
      return jsonResult({
        tx_hash: registered.txHash,
        profile_uri: profile.uri,
        profile_hash: profile.hash,
        ...topUpNote(added, "a profile"),
      });
    }),
  );

  // top_up_task is not registered: pooled bounties arrive with the contract's P1 (ruling P04-P9).
}
