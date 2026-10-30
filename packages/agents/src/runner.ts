import { Buffer } from "node:buffer";
import type { TenderClient } from "@tender/client";
import type { Draft, StateStore } from "@tender/mcp";
import {
  ApiError,
  computeCommitment,
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
//   the salt behind; a crash before it left a draft the chain knows nothing of, which costs nothing;
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
const NO_SIGNER = "this agent's client has no signer, so it can neither commit nor reveal";

/**
 * What the runner needs of a `TenderClient` (X-12): the account it signs as, the two transactions
 * of an entry, and the storage view for R22. Tests pass a fake with these members.
 */
export type AgentChain = Pick<TenderClient, "accountId" | "commit" | "reveal" | "storageBalanceOf">;

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
 * 6. The answer is committed to (`commit`).
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
  const storage = await run.client.storageBalanceOf(run.account);
  if (storageShortfall(storage) > 0n) {
    memory.seen.add(id);
    run.log(`WARN storage low account=${run.account} available=${storage?.available ?? "0"}`);
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
 * Enters task `id` with `content`: saves the draft, sends the commit, then marks the draft
 * committed. The draft is on disk (`saveDraft` writes and syncs a temp file and renames it) before
 * the commit leaves, which is the whole of the crash safety of the commit half.
 */
async function commit(run: Run, id: string, content: Uint8Array): Promise<void> {
  const taskId = BigInt(id);
  const contentHash = sha256Hex(content);
  const salt = randomSalt();
  const draft: Draft = {
    taskId: id,
    contentBase64: Buffer.from(content).toString("base64"),
    contentHash,
    salt,
    commitment: computeCommitment(taskId, run.account, contentHash, salt),
  };

  await run.state.saveDraft(draft);
  let txHash: string;
  try {
    txHash = (await run.client.commit(taskId, draft.commitment)).txHash;
  } catch (error) {
    // The draft stays: whether the commit reached the chain is not known to a transaction that
    // failed to finish, and a draft that was never committed does no harm (see `tendDrafts`).
    run.log(`ERROR ${run.name}: commit to task ${id} failed (${describe(error)})`);
    return;
  }
  run.log(`${run.name}: committed to task ${id} tx=${txHash}`);

  try {
    await run.state.saveDraft({ ...draft, committedAt: new Date().toISOString() });
  } catch (error) {
    // The commit is on chain all the same, and the reveal does not wait for this mark.
    run.log(
      `ERROR ${run.name}: task ${id} committed, but its draft could not be marked (${describe(error)})`,
    );
  }
}

// ---- Revealing and settling -------------------------------------------------------------------

/**
 * Goes through every draft the agent holds, oldest task first:
 *
 * - a draft that is not revealed, for a task in its reveal window, is revealed;
 * - a draft whose task has settled is logged as `won`, `lost` or `refunded`, once.
 *
 * It works from the drafts and from what the API says of their tasks, and from nothing the run
 * remembers apart from which outcomes it has logged, so it finishes the work of a run that was
 * killed. It does not wait for `committedAt`: the commit can have gone through just before a crash
 * stopped the draft from being marked, and the reveal must not be lost to that. A draft whose
 * commit never reached the chain makes the reveal fail until its window ends, which is logged.
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
    if (run.memory.settled.has(draft.taskId)) continue;
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
 * One pass of the agent: first the drafts it holds (reveals that are due, outcomes to log), then
 * the open tasks to enter. The reveals come first because they have a deadline and a solver can
 * take minutes: a reveal never waits behind the work of the same tick.
 *
 * Nothing that goes wrong with one task or one draft stops the tick: it is logged, and the tick
 * goes on with the next. A step that cannot be taken (the API is down) is logged and left to the
 * next tick. It throws only when the client has no signer. Pass `signal` to have it end before it
 * starts on its next task or draft; the one in hand is seen through, so that a commit that went
 * out has its draft marked.
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
