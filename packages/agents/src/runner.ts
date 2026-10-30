import { Buffer } from "node:buffer";
import type { TenderClient } from "@tender/client";
import type { Draft, StateStore } from "@tender/mcp";
import {
  ApiError,
  computeCommitment,
  type EntryView,
  ErrorBodySchema,
  type ListTasksFilter,
  randomSalt,
  sha256Hex,
  storageShortfall,
  type TaskDetail,
  type TaskSummary,
  type TenderApi,
} from "@tender/shared";
import type { Solver, TaskContext } from "./types";

// The agent runner: a loop that finds the open tasks of its tags, has a solver answer them, enters
// them with a commit, reveals the answer once the task's reveal window opens, and says in its log
// how each task it entered ended. It is what the scripted demo agents and the reference agents run.
//
// An entry has two halves on the chain, a commit (a hash) and, later, a reveal (the work and the
// salt that open it), and the agent is the only one that holds the salt in between. So the runner
// keeps its draft on disk through the `StateStore` and works from it:
//
// - the draft is saved, and so on disk, before the commit is sent. A crash after the commit left
//   the salt behind; a crash before it left a draft the chain may know nothing of. A draft that is
//   not marked committed is taken neither for sent nor for lost: the chain is asked
//   (`recoverCommit`). If it has the commit, the draft is marked. If not, and the task is still
//   open, the same commitment is sent again from the draft, never with a new solve. If the commit
//   window is over, or the contract refuses for good, the draft is dead and is let alone (P05-R14);
// - a draft is never replaced. A task with a draft is not entered again, in this run or after a
//   restart, because a second commit with another salt would replace the one the draft opens;
// - the reveal is driven by the drafts and not by what the run remembers, so a restart picks up
//   every entry where it stopped. The upload comes first and the reveal second, so a crash between
//   the two leaves a draft that is still unrevealed, and the next tick does both again: the upload
//   is idempotent (the API stores bytes by their hash) and the reveal is only sent once.

/** How long `runAgent` waits after a tick ends before the next one starts, by default. */
const DEFAULT_POLL_MS = 15_000;
/** The longest wait `setTimeout` keeps: it runs anything above this after 1 ms instead. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/**
 * How many pages of one tag's open tasks a tick reads. The API gives 20 a page, so this is 200
 * tasks, far more than a board has open at once. The bound is for an API that never stops giving
 * a cursor, which would keep a tick from ever ending.
 */
const MAX_PAGES = 10;
/** The most code points of the Judge's reason that a log line carries. */
const MAX_REASON_CHARS = 200;
/** What a code looks like: the contract's (`E_AUTH`), Node's (`ECONNREFUSED`), the API's (`not_open`). */
const CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/**
 * The failures of a commit that a second try meets again (P05-R14), by the code they carry. The
 * contract's own, from the rules of `commit`: no such task (`E_NOT_FOUND`), the task is past its
 * commit deadline (`E_PHASE`), the agent is its poster or its verifier (`E_AUTH`), it takes
 * invited entrants only and the agent is not one (`E_INVITE`), the commitment is not 64 lowercase
 * hex characters (`E_HASH`), and the task is full (`E_FULL`: entrants cannot leave, so no place
 * frees up). And the client's own `E_ARGS`, for arguments the contract cannot read.
 *
 * `E_STORAGE` is not among them, as a top-up makes it come right. Neither is a failure with no
 * code (a node that is down, a timeout) or one the client could not name (`E_UNKNOWN`): none of
 * these is known to repeat, and the commit is tried again until its window ends.
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
const NO_SIGNER = "this agent's client has no signer, so it can neither commit nor reveal";

/**
 * What the runner needs of a `TenderClient` (X-12): the account it signs as, the two transactions
 * of an entry, the storage view for R22, and the entry view that tells whether a commit landed
 * (P05-R14). Tests pass a fake with these members.
 */
export type AgentChain = Pick<
  TenderClient,
  "accountId" | "commit" | "reveal" | "storageBalanceOf" | "getEntry"
>;

/**
 * What a run remembers from one tick to the next. It is only a cache of decisions already made,
 * so that a task is not looked at, solved and logged over and over. Everything that must survive
 * a restart is in the drafts instead.
 */
export class AgentMemory {
  /**
   * Tasks the agent is done with for this run: it committed to them, or it will not: the Judge
   * rejected the task, the solver had no answer or failed, or the storage was too low to commit.
   */
  readonly seen = new Set<string>();
  /** Tasks whose outcome has been logged. */
  readonly settled = new Set<string>();
  /**
   * Tasks whose draft is dead for this run: its commit is not on the chain and cannot be, as the
   * contract refused it for good or the commit window is over. Nothing more is done for them. A
   * draft has no slot to say so on disk, so a restart judges each of them again.
   */
  readonly dead = new Set<string>();
  /** Tasks whose low storage has been warned of, so that a later tick does not say it again. */
  readonly warned = new Set<string>();
}

export interface AgentTickOptions {
  /** The agent's name. Its log lines start with it. */
  name: string;
  /** Signs as the agent. It needs a signer: without one the tick throws. */
  client: AgentChain;
  api: TenderApi;
  /** Where the drafts live. Its directory is the agent's own: two agents never share one. */
  state: StateStore;
  /** The tags of the tasks the agent looks for. A task counts if its brief carries any of them. */
  tags: readonly string[];
  solver: Solver;
  /**
   * Receives the agent's lines. `WARN` and `ERROR` lines say something is wrong; the rest say what
   * the agent did. An error line names the error and its code and never quotes its message, which
   * can hold a URL, and so a key (P03-R16). Default: `console.log`.
   */
  log?: (message: string) => void;
  /** Ends the tick before it starts on its next task or draft once it aborts. */
  signal?: AbortSignal;
  /**
   * What the agent remembers between ticks. `runAgent` keeps one for the whole run. A tick that is
   * given none starts from nothing, which is right for a one-off call and for a test.
   */
  memory?: AgentMemory;
}

export interface RunAgentOptions extends Omit<AgentTickOptions, "signal" | "memory"> {
  /** How long to wait after a tick ends before the next one starts. Default 15 s. */
  pollMs?: number;
  /** Stops the agent once the tick in hand is done. */
  signal: AbortSignal;
}

/** Everything a step of a tick needs, with the defaults filled in. */
interface Run {
  name: string;
  account: string;
  client: AgentChain;
  api: TenderApi;
  state: StateStore;
  tags: readonly string[];
  solver: Solver;
  log: (message: string) => void;
  signal: AbortSignal | undefined;
  memory: AgentMemory;
}

/** The text of `error`'s code if it has one that looks like a code, else undefined. */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && CODE.test(code) ? code : undefined;
}

/** Whether `error` is a failure of a commit that a second try would meet again. */
function refusedForGood(error: unknown): boolean {
  const code = codeOf(error);
  return code !== undefined && REFUSED_FOR_GOOD.has(code);
}

/**
 * What a log line says of an error: its name and its code, or for an `ApiError` its status and
 * the API's own error code. Never its message (P03-R16): a message can quote the URL of the RPC or
 * of the API, and a URL can hold a key. A code that does not look like one is dropped too, since a
 * foreign error may put anything there.
 */
function describe(error: unknown): string {
  if (error instanceof ApiError) {
    const body = ErrorBodySchema.safeParse(error.body);
    const code = body.success && CODE.test(body.data.error) ? ` ${body.data.error}` : "";
    return `ApiError ${error.status}${code}`;
  }
  if (!(error instanceof Error)) return typeof error;
  const code = codeOf(error);
  return code === undefined ? error.name : `${error.name} ${code}`;
}

/**
 * `text` as one line of at most 200 code points, for a log. The Judge's reason is text from a
 * stranger's task, and a newline or an escape sequence in it would write lines of its own.
 */
function oneLine(text: string): string {
  const flat = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
  const points = [...flat];
  return points.length > MAX_REASON_CHARS ? `${points.slice(0, MAX_REASON_CHARS).join("")}…` : flat;
}

/** Every open task tagged `tag`, page after page, newest first. */
async function listOpen(api: TenderApi, tag: string): Promise<TaskSummary[]> {
  const tasks: TaskSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const filter: ListTasksFilter =
      cursor === undefined ? { phase: "open", tag } : { phase: "open", tag, cursor };
    const found = await api.listTasks(filter);
    tasks.push(...found.tasks);
    if (found.next_cursor === null) break;
    cursor = found.next_cursor;
  }
  return tasks;
}

// ---- Entering tasks ---------------------------------------------------------------------------

/**
 * Looks for the open tasks of each tag and enters those the agent can answer. A task goes through
 * these steps, and the first that says no ends it:
 *
 * 1. The Judge rejected it (`judge_status` "rejected"): logged with its reason, once.
 * 2. The agent has a draft for it already: it is the agent's, and the drafts take it from here.
 * 3. The index shows it no longer open, or without its brief or criteria: left for the next tick.
 * 4. The agent's storage on the contract is below what a commit and a reveal need (R22): logged as
 *    a warning. A function-call key cannot top it up, so the agent can only wait for someone to.
 * 5. `start`, the signal that the agent is working on it, then the solver. No answer: logged.
 * 6. The answer is committed to (`commit`). If the commit does not end well, the draft it saved is
 *    settled by the next ticks (`recoverCommit`): the answer is not solved for again.
 *
 * A task is `seen` once step 4 has turned it down and once `start` has gone through, whatever
 * happens after, so a solver is asked at most once per task in a run and a failing task cannot cost
 * a model call every tick. A failure before that is a call that did not go through, and the task
 * is looked at again next tick.
 */
async function enterTasks(run: Run): Promise<void> {
  // A task carries several tags and is listed under each: it is looked at once per tick.
  const looked = new Set<string>();

  for (const tag of run.tags) {
    if (run.signal?.aborted) return;
    let open: TaskSummary[];
    try {
      open = await listOpen(run.api, tag);
    } catch (error) {
      run.log(
        `ERROR ${run.name}: listing the open tasks tagged ${tag} failed (${describe(error)})`,
      );
      continue;
    }
    for (const summary of open) {
      if (run.signal?.aborted) return;
      if (looked.has(summary.id) || run.memory.seen.has(summary.id)) continue;
      looked.add(summary.id);
      try {
        await enter(run, summary);
      } catch (error) {
        run.log(`ERROR ${run.name}: task ${summary.id} failed (${describe(error)})`);
      }
    }
  }
}

/** One task of `enterTasks`. Throws for what is not the task's fault; the caller logs it. */
async function enter(run: Run, summary: TaskSummary): Promise<void> {
  const { id } = summary;
  const { memory } = run;

  if (summary.judge_status === "rejected") {
    memory.seen.add(id);
    const reason = summary.judge_reason === null ? "" : `: ${oneLine(summary.judge_reason)}`;
    run.log(`${run.name}: skipping task ${id}, the Judge rejected it${reason}`);
    return;
  }

  // Not `memory`: a restart has none, and the draft holds the salt of a commitment that may be on
  // chain. Entering again would save a new salt over it, and the reveal could never open the commit.
  if ((await run.state.getDraft(id)) !== null) {
    memory.seen.add(id);
    return;
  }

  const found = await run.api.getTask(BigInt(id));
  if (found === null) return;
  const { task, brief, criteria } = found;
  if (brief === null || criteria === null) return;
  // The listing is a moment old. `start` and the commit would refuse a task past its window.
  if (task.phase !== "open") return;

  // R22 (P05-P2): an entry that runs out of storage cannot reveal, and its window does not wait.
  // Checked here, ahead of `start` and the solver, rather than at the commit itself: an agent
  // that cannot commit then neither announces itself on the task nor spends a model call on it.
  if (await storageLow(run, id)) {
    memory.seen.add(id);
    return;
  }

  await run.api.start(BigInt(id));
  memory.seen.add(id);

  const ctx: TaskContext = { task, brief, criteria };
  let content: Uint8Array | null;
  try {
    content = await run.solver.solve(ctx);
  } catch (error) {
    run.log(
      `ERROR ${run.name}: the ${run.solver.name} solver failed on task ${id} (${describe(error)})`,
    );
    return;
  }
  if (content === null) {
    run.log(`${run.name}: no answer for task ${id}`);
    return;
  }
  await commit(run, id, content);
}

/**
 * Enters task `id` with `content`: saves the draft, then sends the commit (`sendCommit`). The draft
 * is on disk (`saveDraft` writes and syncs a temp file and renames it) before the commit leaves,
 * which is the whole of the crash safety of the commit half. What a crash or a failed send leaves
 * behind, `recoverCommit` settles.
 */
async function commit(run: Run, id: string, content: Uint8Array): Promise<void> {
  const contentHash = sha256Hex(content);
  const salt = randomSalt();
  const draft: Draft = {
    taskId: id,
    contentBase64: Buffer.from(content).toString("base64"),
    contentHash,
    salt,
    commitment: computeCommitment(BigInt(id), run.account, contentHash, salt),
  };

  await run.state.saveDraft(draft);
  await sendCommit(run, draft, false);
}

// ---- Settling a commit ------------------------------------------------------------------------

/**
 * Sends the commit of `draft`, and marks the draft committed once it has gone through. `again` says
 * the send repeats one that did not end well, for the log. Returns whether the commit went through.
 *
 * A failure that a second try would meet again (`REFUSED_FOR_GOOD`) makes the draft dead. Any
 * other is logged and left for a later tick: a transaction that failed to finish does not say
 * whether it reached the chain, and sending the draft's commitment again is harmless, as a commit
 * by an account that has an entry only replaces the entry's commitment, here with the same one.
 */
async function sendCommit(run: Run, draft: Draft, again: boolean): Promise<boolean> {
  const id = draft.taskId;
  let txHash: string;
  try {
    txHash = (await run.client.commit(BigInt(id), draft.commitment)).txHash;
  } catch (error) {
    if (refusedForGood(error)) {
      markDead(run, id, `commit to task ${id} refused for good (${describe(error)})`);
    } else {
      run.log(`ERROR ${run.name}: commit to task ${id} failed (${describe(error)})`);
    }
    return false;
  }
  run.log(`${run.name}: committed to task ${id} tx=${txHash}${again ? " (sent again)" : ""}`);
  await markCommitted(run, draft);
  return true;
}

/**
 * Marks `draft` committed, at the time the agent learned of it (for a commit found on the chain,
 * not when it landed). A failure is logged and changes nothing: the chain has the commit.
 */
async function markCommitted(run: Run, draft: Draft): Promise<void> {
  try {
    await run.state.saveDraft({ ...draft, committedAt: new Date().toISOString() });
  } catch (error) {
    run.log(
      `ERROR ${run.name}: task ${draft.taskId} committed, but its draft could not be marked (${describe(error)})`,
    );
  }
}

/**
 * Gives the draft of task `id` up for this run, and says why (P05-R14). That is said once, as
 * `tendDrafts` lets a dead draft alone from then on: it is neither sent nor revealed nor reported
 * on, and its task is not entered again.
 */
function markDead(run: Run, id: string, why: string): void {
  run.memory.dead.add(id);
  run.log(`ERROR ${run.name}: ${why}, the draft is dead`);
}

/**
 * Settles a draft that is not marked committed (P05-R14). Its commit was cut short by a crash, or
 * failed in a way that said nothing of the chain, or went through and was not marked. The chain
 * knows which, and is asked (`get_entry`) before anything is sent. `task` is what the index shows
 * of the draft's task.
 *
 * - The account has an entry with the draft's commitment: the commit landed, and the draft is
 *   marked committed. This is the only way to learn it, as the contract has no "already
 *   committed" error: a second commit by the same account succeeds and replaces the first.
 * - It has none (or one with another commitment, which the draft's replaces) and the task is
 *   open: the draft's own commitment is sent again. It carries the draft's salt and hash, so that
 *   it opens with the draft's work, and no solver is asked.
 * - It has none and the task is no longer open: the commit deadline has passed, nothing can be
 *   sent or revealed, and the draft is dead.
 *
 * Returns whether the commit is on the chain, which is when the draft may be revealed. A lookup
 * that fails, a storage balance too low to commit (R22) and a send that fails in a way that may
 * pass leave the draft for a later tick. A send the contract refuses for good makes it dead
 * (`sendCommit`).
 */
async function recoverCommit(run: Run, draft: Draft, task: TaskDetail): Promise<boolean> {
  const id = draft.taskId;

  let entry: EntryView | null;
  try {
    entry = await run.client.getEntry(BigInt(id), run.account);
  } catch (error) {
    run.log(`ERROR ${run.name}: the entry in task ${id} cannot be read (${describe(error)})`);
    return false;
  }
  if (entry !== null && entry.commitment === draft.commitment) {
    run.log(`${run.name}: the commit to task ${id} was on chain already`);
    await markCommitted(run, draft);
    return true;
  }

  if (task.phase !== "open") {
    const why = `task ${id} has no commit of its draft on chain and its commit window is over`;
    markDead(run, id, why);
    return false;
  }
  if (await storageLow(run, id)) return false;
  return sendCommit(run, draft, true);
}

/**
 * Whether the agent's storage on the contract is below what a commit and a reveal need (R22). It
 * reads the balance now, and warns once for each task if it is short. A function-call key cannot
 * top the account up, so the agent can only wait for someone to.
 */
async function storageLow(run: Run, id: string): Promise<boolean> {
  const storage = await run.client.storageBalanceOf(run.account);
  if (storageShortfall(storage) <= 0n) return false;
  if (!run.memory.warned.has(id)) {
    run.memory.warned.add(id);
    run.log(`WARN storage low account=${run.account} available=${storage?.available ?? "0"}`);
  }
  return true;
}

// ---- Revealing and settling -------------------------------------------------------------------

/**
 * Goes through every draft the agent holds, oldest task first:
 *
 * - a draft not marked committed is settled first (`recoverCommit`): the chain is asked, and the
 *   commit is marked, sent again or given up;
 * - a draft that is not revealed, for a task in its reveal window, is revealed;
 * - a draft whose task has settled is logged as `won`, `lost` or `refunded`, once.
 *
 * It works from the drafts and from what the API and the chain say of their tasks, and from nothing
 * the run remembers apart from which outcomes it has logged and which drafts are dead, so it
 * finishes the work of a run that was killed. A commit that went through just before a crash
 * stopped the draft from being marked is found by `recoverCommit`, and the reveal follows in the
 * same pass. A dead draft is let alone: it is not revealed, and no outcome is logged for an entry
 * the agent never made.
 */
async function tendDrafts(run: Run): Promise<void> {
  let drafts: Draft[];
  try {
    drafts = await run.state.listDrafts();
  } catch (error) {
    // The store's errors name the file and never quote it (it holds the work and the salt), so
    // this one is logged whole: it is how the operator learns which draft file to fix.
    const why = error instanceof Error ? oneLine(error.message) : typeof error;
    run.log(`ERROR ${run.name}: the drafts cannot be read (${why})`);
    return;
  }

  for (const draft of drafts) {
    if (run.signal?.aborted) return;
    const { taskId } = draft;
    if (run.memory.settled.has(taskId) || run.memory.dead.has(taskId)) continue;
    try {
      await tendDraft(run, draft);
    } catch (error) {
      run.log(`ERROR ${run.name}: task ${draft.taskId} failed (${describe(error)})`);
    }
  }
}

async function tendDraft(run: Run, draft: Draft): Promise<void> {
  const found = await run.api.getTask(BigInt(draft.taskId));
  // The index does not know the task (yet): there is nothing to compare the draft with.
  if (found === null) return;
  const { task } = found;

  let revealed = draft.revealedUri !== undefined;
  // A revealed draft was committed. One that is neither revealed nor marked committed may or may
  // not have its commit on the chain, and nothing is revealed or sent before that is known.
  if (!revealed && draft.committedAt === undefined) {
    if (!(await recoverCommit(run, draft, task))) return;
  }
  if (!revealed && task.phase === "revealing") revealed = await reveal(run, draft);
  if (task.outcome !== null) {
    logOutcome(run, task, revealed);
    run.memory.settled.add(draft.taskId);
  }
}

/**
 * Uploads the draft's work and reveals it with the URI the upload gave, then marks the draft
 * revealed. Returns whether the work is revealed on the chain. A step that fails is logged and the
 * draft stays as it was, so the next tick tries again from the top:
 *
 * - The upload comes before the reveal. The API counts the upload as the entrant's only while the
 *   bytes have not been served (P03-R22), and an honest entrant has sent them before its own
 *   reveal; the other order would reveal a URI that serves nothing yet.
 * - The upload can be refused because the API's index has not seen the commit yet (a 403), and the
 *   reveal because the node's final block is behind. Both come right within the window.
 * - A reveal that fails with `E_REVEALED` has been done before: a crash after it went through
 *   stopped the draft from being marked. The URI is the same, as the upload is idempotent, so the
 *   draft is marked now.
 */
async function reveal(run: Run, draft: Draft): Promise<boolean> {
  const taskId = BigInt(draft.taskId);
  const bytes = new Uint8Array(Buffer.from(draft.contentBase64, "base64"));

  let uri: string;
  try {
    const stored = await run.api.uploadBlob({
      kind: "result",
      contentType: "text/plain",
      bytes,
      taskId,
    });
    // What the reveal names on chain is the hash the draft committed to. If the API stored other
    // bytes, the Judge would find a result that does not match it, and the entry would score 0.
    if (stored.sha256 !== draft.contentHash) {
      run.log(`ERROR ${run.name}: task ${taskId} not revealed, the API stored other bytes`);
      return false;
    }
    uri = stored.uri;
  } catch (error) {
    run.log(`ERROR ${run.name}: upload for task ${taskId} failed (${describe(error)})`);
    return false;
  }

  let done = "";
  try {
    await run.client.reveal(taskId, draft.contentHash, draft.salt, uri);
  } catch (error) {
    if (codeOf(error) !== "E_REVEALED") {
      run.log(`ERROR ${run.name}: reveal of task ${taskId} failed (${describe(error)})`);
      return false;
    }
    done = " (it had been revealed already)";
  }

  try {
    await run.state.markRevealed(draft.taskId, uri);
  } catch (error) {
    // Revealed all the same. The next tick uploads and reveals again, is told it is done, and
    // marks the draft then.
    run.log(
      `ERROR ${run.name}: task ${taskId} revealed, but its draft could not be marked (${describe(error)})`,
    );
    return true;
  }
  run.log(`${run.name}: revealed task ${taskId}${done} uri=${uri}`);
  return true;
}

/**
 * Logs how a settled task ended for the agent: `won` with what it was paid, `lost` (it was not
 * among the winners, and if it never revealed, that is said), or `refunded` (the task was voided).
 */
function logOutcome(run: Run, task: TaskDetail, revealed: boolean): void {
  const { outcome } = task;
  if (outcome === null) return;
  if (outcome.kind === "voided") {
    run.log(`${run.name}: refunded task ${task.id} (${outcome.reason})`);
    return;
  }
  const win = outcome.winners.find((winner) => winner.account === run.account);
  if (win !== undefined) {
    run.log(`${run.name}: won task ${task.id} amount=${win.amount} token=${task.token}`);
  } else {
    run.log(`${run.name}: lost task ${task.id}${revealed ? "" : " (never revealed)"}`);
  }
}

// ---- The loop ---------------------------------------------------------------------------------

/**
 * One pass of the agent: first the drafts it holds (commits to settle, reveals that are due,
 * outcomes to log), then the open tasks to enter. The drafts come first because they have a
 * deadline and a solver can take minutes: a reveal that is due when the tick starts never waits
 * behind the work of the same tick.
 *
 * Nothing that goes wrong with one task or one draft stops the tick: it is logged, and the tick
 * goes on with the next. A step that cannot be taken (the API is down) is logged and left to the
 * next tick. It throws only when the client has no signer. Pass `signal` to have it end before it
 * starts on its next task or draft; the one in hand is seen through, so that a commit that went
 * out has its draft marked.
 *
 * Known limits, accepted (P05-R14):
 *
 * - A solver that takes long delays the agent's later tasks in the same tick, and a reveal that
 *   falls due during a solve waits for the tick to end.
 * - A `won`, `lost` or `refunded` line is logged again for each settled draft after a restart, as
 *   a draft has no slot to say its outcome was logged.
 * - The storage view is read once for a task, before the solver is asked, and not again before
 *   the commit.
 * - A draft is dead for the run only, as it has no slot to say so either: a restart judges it
 *   again, which costs a lookup and, for a task still open, one more refused commit and one more
 *   ERROR line.
 *
 * `runAgent` calls this in a loop; it is exported so that a test can run one tick at a time.
 */
export async function agentTick(opts: AgentTickOptions): Promise<void> {
  const account = opts.client.accountId;
  if (account === undefined) throw new Error(NO_SIGNER);
  const run: Run = {
    name: opts.name,
    account,
    client: opts.client,
    api: opts.api,
    state: opts.state,
    tags: opts.tags,
    solver: opts.solver,
    log: opts.log ?? console.log,
    signal: opts.signal,
    memory: opts.memory ?? new AgentMemory(),
  };
  await tendDrafts(run);
  await enterTasks(run);
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Runs the agent: a tick (`agentTick`) now, and again `pollMs` (default 15 s) after each tick
 * ends, until `signal` aborts. The wait starts when a tick ends, so ticks never overlap, however
 * long a solver takes. A tick that throws is logged and the loop goes on.
 *
 * An abort during the wait ends the loop at once. An abort during a tick lets the task in hand
 * finish first, and the tick starts on no other. A signal that is aborted already runs no tick. The
 * returned promise resolves once the loop has stopped. It rejects only at once, without running a
 * tick, for a client with no signer or a `pollMs` that `setTimeout` cannot keep.
 *
 * The first line says which account the agent signs as, and whether its solver is scripted, so
 * that a run of the team's scripted agents cannot be mistaken for something else.
 */
export async function runAgent(o: RunAgentOptions): Promise<void> {
  const { signal } = o;
  const pollMs = o.pollMs ?? DEFAULT_POLL_MS;
  if (!Number.isFinite(pollMs) || pollMs < 1 || pollMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`pollMs must be from 1 to ${MAX_TIMEOUT_MS} milliseconds`);
  }
  const account = o.client.accountId;
  if (account === undefined) throw new Error(NO_SIGNER);

  const log = o.log ?? console.log;
  const memory = new AgentMemory();
  const tags = o.tags.length === 0 ? "none" : o.tags.join(", ");
  const kind = o.solver.scripted ? " (scripted)" : "";
  log(`${o.name}: running as ${account}, tags ${tags}, ${o.solver.name} solver${kind}`);

  while (!signal.aborted) {
    try {
      await agentTick({ ...o, log, signal, memory });
    } catch (error) {
      log(`ERROR ${o.name}: tick failed (${describe(error)})`);
    }
    await sleep(pollMs, signal);
  }
}
