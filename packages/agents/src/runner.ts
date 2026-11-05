import { Buffer } from "node:buffer";
import type { TenderClient } from "@tender/client";
import { type Draft, isDraftOf, type StateStore, staleReason } from "@tender/mcp";
import {
  type AccountEntry,
  ApiError,
  computeCommitment,
  type EntryView,
  ErrorBodySchema,
  hireCriteriaHash,
  hireeOf,
  hireMismatch,
  isHireCriteriaOf,
  type ListTasksFilter,
  MAX_URI_BYTES,
  randomSalt,
  type Service,
  sha256Hex,
  storageShortfall,
  type TaskBoard,
  type TaskDetail,
  type TaskDetailResponse,
  type TaskSummary,
  type TenderApi,
  U64StringSchema,
} from "@tender/shared";
import {
  checkPolicy,
  type DayCount,
  describePolicy,
  type EntryCounts,
  type EntryPolicy,
  policyRefusal,
  utcDay,
} from "./policy";
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
//   open, the same commitment is sent again from the draft, never with a new solve. If the reveal
//   window is over with no commit of the draft on the chain, or if the contract refuses for good,
//   the draft is dead and is let alone (P05-R14), which is written on the draft itself (`dead`, the
//   MCP server's too), so that a restart lets it alone as well. A draft whose commit is on the chain is never
//   dead: it is revealed whenever its window is open, marked or not, and however late the agent
//   comes back to it. The chain is read at its last final block, which trails the newest by about
//   two, so a commit that has just landed can be missing from the view for a moment. That is why a
//   draft with no commit in view is given up only once the reveal window is over, and not when the
//   commit window ends (review N1). Nor do five failed resends give it up: the commit is not sent
//   again after them, but the last may have landed, so the draft is looked for all the same
//   (review R1);
// - a draft is the agent's only if its commitment is the one that the agent's account, the task,
//   the draft's hash and its salt give. A draft that another account made, in a state directory
//   that the two share, is dead for this run, and nothing is sent or revealed for it (review N3).
//   That one is not written on the file: the file is the other account's;
// - a draft is bound to the task it was made for (P05 whole-branch review I4). Task ids count up
//   from 1 on every contract, and a chain that is started again (every sandbox, a fresh deploy) hands
//   them out once more, so the draft records the contract and the task's creation time
//   (`contractId`, `taskCreatedAt`), and a draft whose record does not fit the task it meets is
//   another task's (`staleReason`, as the MCP server tells them). Unless the chain shows an entry
//   of the account with the draft's commitment, which proves the draft belongs, it is set aside,
//   whole and kept (`setAside`), never sent or revealed, and the task is entered afresh if it is
//   open. A draft that records nothing (one from before drafts were bound) is taken as it is;
// - a draft is never replaced. A task with a draft of its own is not entered again, in this run or
//   after a restart, because a second commit with another salt would replace the one the draft
//   opens;
// - the reveal is driven by the drafts and not by what the run remembers, so a restart picks up
//   every entry where it stopped. The upload comes first and the reveal second, so a crash between
//   the two leaves a draft that is still unrevealed, and the next tick does both again: the upload
//   is idempotent (the API stores bytes by their hash) and the reveal is only sent once;
// - one draft file that cannot be read does not stop the reveals of the others: the account's
//   entries, as the API lists them, say which reveals are due, and each draft is read by itself.
//
// What the API says is checked where a check is cheap (review M3), so that a broken one cannot
// make the agent start and solve every task it lists, or enter a task under another spelling of its
// id: a page is cut to the 50 tasks asked for, a task must carry the tag it was listed under, an id
// must be a u64 as the contract writes one, and the detail that answers for a task must be its own.

/** How long `runAgent` waits after a tick ends before the next one starts, by default. */
const DEFAULT_POLL_MS = 15_000;
/** How long the runner waits for a solver to answer one task, by default. */
const DEFAULT_SOLVE_TIMEOUT_MS = 120_000;
/** The longest wait `setTimeout` keeps: it runs anything above this after 1 ms instead. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/**
 * How many tasks the runner asks for in a page of a listing, and takes from one: the most the API
 * gives (its default is 20).
 */
const PAGE_SIZE = 50;
/**
 * How many pages of one tag's open tasks a tick reads. A page is 50 tasks, so this is 500, far more
 * than a board has open at once. The bound is for an API that never stops giving a cursor, which
 * would keep a tick from ever ending.
 */
const MAX_PAGES = 10;
/** The most code points of the Judge's reason that a log line carries. */
const MAX_REASON_CHARS = 200;
/** The most code points of an id that a log line carries when the id is not a task id. */
const MAX_ID_CHARS = 40;
/** The most code points of an account id that a log line carries: the longest account id. */
const MAX_ACCOUNT_CHARS = 64;
/**
 * The most code points of the policy's reason for a skip: room for two u128 amounts and two
 * account ids, the longest reason it gives.
 */
const MAX_POLICY_REASON_CHARS = 300;
/**
 * How many times a draft's commit is sent again in a run before the runner stops sending it. The
 * draft is not given up for that (review R1): it is looked for to the end of the reveal window.
 */
const MAX_RESENDS = 5;
/**
 * The contract storage that the agent must have free before it enters a task (R22), in bytes: 1
 * KiB, room for the entry's commit and its reveal.
 */
const STORAGE_FLOOR_BYTES = 1024n;
/**
 * What each reveal the agent still owes adds to that floor (review M1), in bytes: the dearest
 * reveal, which writes 36 bytes and a URI of at most `MAX_URI_BYTES`. A run of commits made each at
 * the floor would leave the last reveals without storage, and their windows do not wait.
 */
const STORAGE_PER_OWED_BYTES = 36n + BigInt(MAX_URI_BYTES);
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
 * code (a node that is down), one the client could not name (`E_UNKNOWN`) or one it gave up on
 * (`E_TIMEOUT`: the node did not answer in time, and the commit may have landed): none of these is
 * known to repeat, and the commit is tried again until its window ends, or until `MAX_RESENDS`
 * resends have failed.
 *
 * `E_PHASE` counts only for a commit that is sent for the first time (`refusedForGood`). A resend
 * can meet it with the earlier send in a block that is not final yet, so that it says nothing of
 * whether the commit is on the chain (review N1). The other six cannot be met by a commit that
 * has landed: the first send would have been refused for the same reason, or, for `E_FULL`, the
 * account would hold an entry and be let in.
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
/** What a solve gives when the solver is not done in time. */
const TIMED_OUT = Symbol("timed out");

/**
 * What the runner needs of a `TenderClient` (X-12): the account it signs as, the contract it uses
 * (a draft is bound to it), the two transactions of an entry, the storage view for R22, and the
 * entry view that tells whether a commit landed (P05-R14). Tests pass a fake with these members.
 */
export type AgentChain = Pick<
  TenderClient,
  "accountId" | "contractId" | "commit" | "reveal" | "storageBalanceOf" | "getEntry"
>;

/**
 * What a run remembers from one tick to the next. It is only a cache of decisions already made,
 * so that a task is not looked at, solved and logged over and over. Everything that must survive
 * a restart is in the drafts instead.
 */
export class AgentMemory {
  /**
   * Tasks the agent is done with for this run: it committed to them, or it will not: the Judge
   * rejected the task, the contract would refuse the agent, the solver had no answer or failed or
   * took too long, or the storage was too low to commit.
   */
  readonly seen = new Set<string>();
  /** Tasks whose outcome has been logged. */
  readonly settled = new Set<string>();
  /**
   * Tasks whose draft is dead: its commit is not on the chain and cannot be, as the contract
   * refused it for good or the reveal window is over; or the draft is not the account's (review
   * N3). Nothing more is done for them. A draft of the account's own is marked dead on disk as
   * well (`Draft.dead`), and a restart lets it alone; a draft of another account is only dead for
   * this run, as its file is not ours to write on, and a restart judges it again.
   */
  readonly dead = new Set<string>();
  /** Tasks whose low storage has been warned of, so that a later tick does not say it again. */
  readonly warned = new Set<string>();
  /**
   * Tasks whose draft has no commit in view and is looked for again each tick until the task's
   * reveal window is over, which has been said once: in the reveal window itself (review N1), or in
   * the commit window once the resends are used up (review R1).
   */
  readonly waiting = new Set<string>();
  /**
   * How many times the commit of each draft has been sent again in this run, by task. A resend is
   * one that the recovery of a draft makes (`recoverCommit`); the send that enters a task is not
   * one. At `MAX_RESENDS` the commit is not sent again. A restart starts the count again.
   */
  readonly resends = new Map<string, number>();
  /**
   * The tasks of the agent's tags that passed every rule but the daily cap
   * (`EntryPolicy.dailyEntries`), with the UTC day the cap was full. Such a task is not seen: the
   * same day it is passed over without a call to the API (a day's count only grows), and the next
   * day it is looked at afresh.
   * A hire is never here: the cap refuses one its hirer checks for good, and holds back no other.
   */
  readonly capped = new Map<string, string>();
  /**
   * Tasks the Judge checks that wait, under the Judge-only rule, for the Judge to accept them, which
   * has been said once (`awaitsTheJudge`). They are not seen: each tick looks at them again.
   */
  readonly awaitingJudge = new Set<string>();
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
   * How long the runner waits for the solver to answer one task before it gives up on it, in
   * milliseconds, from 1 to 2^31 - 1. A solver that runs out of time is treated like one that has
   * no answer: the task is left alone for the rest of the run, and the error is logged. Without a
   * limit, a solver stuck on a hung socket would hold the tick for good, and with it every reveal
   * that falls due. Default: 120 s.
   */
  solveTimeoutMs?: number;
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
  /**
   * Which of the tasks of its tags the agent spends work on (`EntryPolicy`): the least reward of a
   * token, the verifiers it lets check its work, their record of empty picks, and a cap on the
   * tasks of a UTC day. A hire is held to its service's terms instead, and counts toward the cap: a
   * hire its hirer checks is held to the hirer's record and refused once the day is full, and one
   * the Judge checks is refused once the day's own cap of them is full (`dailyJudgedHires`). Every
   * cap fails closed. Without a policy the agent enters every task of its tags that it can, as the
   * demos' scripted agents do. The command line gives one by the solver (`cli.ts`).
   */
  policy?: EntryPolicy;
  /** Where the count of the day is kept, for `policy.dailyEntries` and `dailyJudgedHires`. */
  entryCounts?: EntryCounts;
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
  /**
   * The services the agent offers, as the API listed them at the start of this tick's pass over the
   * tasks (`ownServices`), or null when they could not be read. They decide whether the agent takes
   * hires at all, and which (`hireOf`).
   */
  services: Service[] | null;
  solver: Solver;
  solveTimeoutMs: number;
  log: (message: string) => void;
  signal: AbortSignal | undefined;
  memory: AgentMemory;
  /**
   * How many reveals the agent owes so far in this tick (review M1): the drafts that are not
   * revealed and whose task is open or revealing, counted as the tick goes through them, and each
   * commit made since. It sets how much storage the next entry needs. It is whole before the first
   * entry is made or the first commit is sent again, since both wait for the pass over the drafts
   * to end (review N2).
   */
  owed: number;
  /**
   * The drafts whose commit is to be sent again (`recoverCommit`), in the order they were found.
   * They are sent once the pass over the drafts is done (`tendDrafts`), when `owed` is whole.
   */
  due: Draft[];
  policy: EntryPolicy | undefined;
  entryCounts: EntryCounts | undefined;
  /**
   * The verifiers' counts of empty picks after reveals, as this tick read them from the API
   * (`voidsOf`): a number, null for a verifier the API has no record of, or undefined for one whose
   * record could not be read (said once in the tick).
   */
  records: Map<string, number | null | undefined>;
  /**
   * The posters' counts of tasks voided after a reveal, as this tick read them from the API
   * (`posterVoidsOf`): a number, or undefined for a record that could not be read (said once in the
   * tick). Null for a poster the API labels as the team's, which `maxPosterVoids` does not hold.
   */
  posters: Map<string, number | null | undefined>;
  /**
   * The count of the day, as this tick read it and has added to it: the UTC day and the tasks taken
   * on in it. Null until it is needed; `unreadable` once it could not be read in this tick.
   */
  today: { day: string; count: DayCount } | null | "unreadable";
}

/** The text of `error`'s code if it has one that looks like a code, else undefined. */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && CODE.test(code) ? code : undefined;
}

/**
 * Whether `error`, the failure of a commit, is one that a second try would meet again. `again` says
 * the commit repeats an earlier send: for that, `E_PHASE` is no verdict (review N1). The commit
 * window ended since, and the earlier send may have landed just before it, in a block the view
 * of the chain cannot show yet. The next tick looks again.
 */
function refusedForGood(error: unknown, again: boolean): boolean {
  const code = codeOf(error);
  if (code === undefined || !REFUSED_FOR_GOOD.has(code)) return false;
  return !(again && code === "E_PHASE");
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
 * `text` as one line of at most `max` code points (default 200), for a log. The Judge's reason is
 * text from a stranger's task, and a newline, an escape sequence or a bidi control in it would
 * write lines of its own or reorder the line it is in: the control characters (`Cc`), the format
 * characters (`Cf`, among them the bidi controls) and the line and paragraph separators go.
 */
function oneLine(text: string, max = MAX_REASON_CHARS): string {
  const flat = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
  const points = [...flat];
  return points.length > max ? `${points.slice(0, max).join("")}…` : flat;
}

/**
 * Whether `id` is a task id as the contract writes one: a u64 in decimal, with no sign, no space
 * and no leading zero. `BigInt` reads "07", " 7 " and "0x7" as 7 too, and the store's file name is
 * the id as given, so a task that a listing spelled another way would be entered a second time
 * under a new salt (review M3).
 */
function isTaskId(id: string): boolean {
  return U64StringSchema.safeParse(id).success;
}

/** Throws a `RangeError` unless `ms` is a wait that `setTimeout` keeps. */
function checkMs(name: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 1 || ms > MAX_TIMEOUT_MS) {
    throw new RangeError(`${name} must be from 1 to ${MAX_TIMEOUT_MS} milliseconds`);
  }
}

/**
 * Every open task tagged `tag`, page after page, newest first; or, given `{ invited }`, every open
 * task whose invited list names that account.
 */
async function listOpen(api: TenderApi, by: string | { invited: string }): Promise<TaskSummary[]> {
  const tasks: TaskSummary[] = [];
  const which = typeof by === "string" ? { tag: by } : { invited: by.invited };
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const filter: ListTasksFilter =
      cursor === undefined
        ? { phase: "open", ...which, limit: PAGE_SIZE }
        : { phase: "open", ...which, limit: PAGE_SIZE, cursor };
    const found = await api.listTasks(filter);
    // A page is what was asked for. An API that gives more is not taken at its word.
    tasks.push(...found.tasks.slice(0, PAGE_SIZE));
    if (found.next_cursor === null) break;
    cursor = found.next_cursor;
  }
  return tasks;
}

// ---- Entering tasks ---------------------------------------------------------------------------

/**
 * Looks for the open tasks of each tag and enters those the agent can answer. A task that the
 * listing shows without the tag it was listed under is skipped, since the API was asked for that
 * tag only (a count of them is logged). A solver that is not available (`Solver.available`: it has
 * used up its requests for the hour) is asked before each task, and for a task it takes on none of
 * the steps below is taken: the task is left as it is, not announced and not seen, and a later tick
 * looks at it again. Any other task goes through these steps, and the first that says no ends it:
 *
 * 1. Its id is not a task id (review M3): logged as a warning.
 * 2. The Judge rejected it (`judge_status` "rejected"): logged with its reason, once.
 * 3. The agent has a draft for it already: it is the agent's, and the drafts take it from here.
 * 4. The index no longer shows it open, or without its brief or criteria: left for the next tick.
 *    So is a detail that is another task's (review M3), with a warning.
 * 5. The detail says the Judge rejected it: as in step 2 (review M7), as the detail is fresher.
 * 6. The contract would refuse the agent (review M4): it is the task's poster or verifier, the
 *    task takes invited entrants only and the agent is not one, or the task is full. Logged.
 * 7. The entry policy turns it away (`EntryPolicy`): it pays less than the agent's least for its
 *    token, its verifier is not one the agent lets check its work, or the verifier's record shows
 *    more empty picks after reveals than the agent accepts. Logged. A record that cannot be read
 *    leaves the task for the next tick. A hire is held to its service's terms in place of the first
 *    two; a hire its hirer checks is held to the hirer's record, and one the Judge checks to none.
 *    Every kind is held to its poster's record of tasks voided after their reveals
 *    (`maxPosterVoids`), unless the API labels the poster as the team's.
 *    Under the Judge-only rule, a task of the agent's tags or a hire the Judge checks then waits
 *    until the Judge has accepted it (`awaitsTheJudge`): said once, and left unseen.
 * 8. The agent's storage on the contract is below what a commit and a reveal need (R22), with the
 *    reveals it already owes (review M1): logged as a warning. A function-call key cannot top it
 *    up, so the agent can only wait for someone to.
 * 9. The day's count (`EntryPolicy.dailyEntries`, which every kind counts toward, and
 *    `dailyJudgedHires`). A task of the agent's tags that finds the day full waits for the next UTC
 *    day, logged once; a hire its hirer checks is refused for good, logged; a hire the Judge checks
 *    is held to `dailyJudgedHires` alone, and refused for good over it. A count that cannot be read
 *    or written takes nothing on (`roomToday`, `countEntry`). The task is counted, on the disk,
 *    before the next step.
 * 10. The solver, and `start`, the signal that the agent is working on the task. A scripted solver
 *    answers from files, which costs nothing and has no side effect (review M6): it is asked
 *    first, and `start` goes out only for a task it has an answer to, so that the agent does not
 *    announce itself on strangers' tasks it will not enter. Any other solver is a model call, and
 *    `start` comes first. No answer, an error and a solver that takes too long (`solveTimeoutMs`)
 *    are logged.
 * 11. The answer is committed to (`commit`). If the commit does not end well, the draft it saved is
 *    settled by the next ticks (`recoverCommit`): the answer is not solved for again.
 *
 * A task is `seen` once step 2, 3, 5, 6, 7 or 8 has turned it down (or step 9, a hire) and once
 * the solver has been asked (for a scripted solver with an answer: once `start` has gone through),
 * whatever happens after, so a solver is asked at most once per task in a run and a failing task
 * cannot cost a model call every tick. Steps 1 and 4, a record that cannot be read, a task that
 * waits for the Judge to accept it, a full day for a task of the agent's tags, a solver that is not
 * available and a call that fails leave the task
 * unseen: it is looked at again next tick (a task of a full day, the next day), and nothing of a
 * task id that is not one is kept.
 */
async function enterTasks(run: Run): Promise<void> {
  // A task carries several tags and is listed under each: it is looked at once per tick.
  const looked = new Set<string>();
  // A task that waited for another day than today is looked at afresh.
  const today = utcDay(Date.now());
  for (const [id, day] of run.memory.capped) if (day !== today) run.memory.capped.delete(id);
  run.services = await ownServices(run);

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
    let strays = 0;
    for (const summary of open) {
      if (run.signal?.aborted) return;
      // The listing was asked for this tag. A task without it is not the agent's to answer, and
      // an API that ignores the filter would otherwise make the agent start and solve all of them.
      if (!summary.tags.includes(tag)) {
        strays += 1;
        continue;
      }
      if (looked.has(summary.id) || run.memory.seen.has(summary.id)) continue;
      looked.add(summary.id);
      try {
        await enter(run, summary);
      } catch (error) {
        run.log(`ERROR ${run.name}: task ${summary.id} failed (${describe(error)})`);
      }
    }
    if (strays > 0) {
      const tasks = strays === 1 ? "task" : "tasks";
      run.log(
        `WARN ${run.name}: the API listed ${strays} ${tasks} without the tag ${tag}, skipped`,
      );
    }
  }

  // Hires are taken only by an agent that offers a service now, and only on its terms.
  if (run.services?.some((service) => service.status === "active") === true) {
    await enterInvitations(run, looked);
  }
}

/** The most services one agent can have: a provider keeps 50 at the most (`SERVICES_PER_PROVIDER`). */
const SERVICES_PAGE = 50;

/**
 * The services the agent offers, paused ones too, as the API lists them: read once a tick, before
 * any task is looked at. A service of another agent, which an API that ignores the filter could
 * send, is dropped: only the agent's own listings set the terms it works on. Null, with an ERROR
 * line, when they cannot be read: the tick goes on without hires, and every task pinned to the
 * agent waits, unseen, for the next tick, which reads them again.
 */
async function ownServices(run: Run): Promise<Service[] | null> {
  try {
    const page = await run.api.listServices({
      agent: run.account,
      status: "all",
      limit: SERVICES_PAGE,
    });
    return page.services.filter((service) => service.agent === run.account);
  } catch (error) {
    run.log(`ERROR ${run.name}: reading its services failed (${describe(error)})`);
    return null;
  }
}

/**
 * Whether a task with `criteriaHash` claims to be a hire: it carries the criteria of a hire the
 * hirer accepts, which are the same for every service, or those of one of the agent's own
 * Judge-checked services (`isHireCriteriaOf` of `@tender/shared`, the rule the API's `hire` filter
 * and the web app use too).
 */
function isHireCriteria(run: Run, criteriaHash: string): boolean {
  return isHireCriteriaOf(criteriaHash, run.account, run.services ?? []);
}

/**
 * What the agent takes on a task as: a task of its tags (`task`), or a hire of one of its services
 * that the Judge checks (`judged hire`) or that its hirer checks (`hirer hire`). The entry policy
 * holds each to other rules (`enter`).
 */
type Kind = "task" | "judged hire" | "hirer hire";

/**
 * Whom the agent will take `task` as a hire of, or why it will not: the task invites it alone, once
 * (`max_entries` 1, `invited` exactly the agent), and one of the agent's active services whose
 * criteria the task carries has terms the task meets (`hireMismatch`: its token, at least its price,
 * the verifier it names, its windows). The kind is that service's checker: the Judge the API names,
 * or the hirer, who is the task's poster and its verifier. The reason of an active service comes
 * before that of a paused one.
 */
function hireOf(run: Run, task: TaskDetail): { kind: Kind } | { refusal: string } {
  // Pinned as a hire is (`hireeOf` of `@tender/shared`), and to this agent.
  if (hireeOf(task) !== run.account) {
    return {
      refusal: "it is pinned as a hire and does not invite the agent alone, once, as a hire does",
    };
  }
  const offered = (run.services ?? [])
    .filter((service) => hireCriteriaHash(service) === task.criteria_hash)
    .sort((a, b) => Number(b.status === "active") - Number(a.status === "active"));
  if (offered.length === 0) {
    return { refusal: "its criteria are not those of a service the agent offers" };
  }
  let reason: string | undefined;
  for (const service of offered) {
    const why = hireMismatch(task, service);
    if (why === null) {
      return { kind: service.verification.kind === "judge" ? "judged hire" : "hirer hire" };
    }
    reason ??= why;
  }
  return { refusal: reason ?? "its criteria are not those of a service the agent offers" };
}

/**
 * The open pinned tasks that invite the agent, whatever their tags: the hires of its services. Only an
 * agent that offers an active service looks for them. They go through `enter` like the tasks of its
 * tags, with two steps more: the detail must name the agent in its invited list, since the API was
 * asked for those only, and an API that ignored the filter would otherwise have the agent enter every
 * open task (a task that does not is skipped, and a count of them is logged); and the task must be a
 * hire of one of its services on that service's terms (`hireOf`), or it is skipped and the
 * reason logged.
 */
async function enterInvitations(run: Run, looked: Set<string>): Promise<void> {
  if (run.signal?.aborted) return;
  let open: TaskSummary[];
  try {
    open = await listOpen(run.api, { invited: run.account });
  } catch (error) {
    run.log(`ERROR ${run.name}: listing the open tasks that invite it failed (${describe(error)})`);
    return;
  }
  let strays = 0;
  for (const summary of open) {
    if (run.signal?.aborted) return;
    if (looked.has(summary.id) || run.memory.seen.has(summary.id)) continue;
    looked.add(summary.id);
    try {
      if ((await enter(run, summary, true)) === "not_invited") strays += 1;
    } catch (error) {
      run.log(`ERROR ${run.name}: task ${summary.id} failed (${describe(error)})`);
    }
  }
  if (strays > 0) {
    const tasks = strays === 1 ? "task" : "tasks";
    run.log(`WARN ${run.name}: the API listed ${strays} ${tasks} that do not invite it, skipped`);
  }
}

/**
 * Whether the Judge has rejected `task`, by what the listing or the detail says. If so, the task
 * is seen and the skip is logged with the Judge's reason, flattened to one line.
 */
function rejectedByTheJudge(run: Run, task: TaskSummary): boolean {
  if (task.judge_status !== "rejected") return false;
  run.memory.seen.add(task.id);
  const reason = task.judge_reason === null ? "" : `: ${oneLine(task.judge_reason)}`;
  run.log(`${run.name}: skipping task ${task.id}, the Judge rejected it${reason}`);
  return true;
}

/**
 * Why the contract is sure to refuse the agent's commit to `task`, if it is (review M4), else null.
 * All of it is in the detail: the poster and the verifier may not enter (`E_AUTH`), a task with an
 * invite list takes the invited only (`E_INVITE`), and a task with a cap on entries that has
 * reached it takes no more (`E_FULL`, which holds for good, as entrants cannot leave). Without the
 * check each one costs a `start`, a solve and a draft that dies at the first commit.
 */
function refusalOf(run: Run, task: TaskDetail): string | null {
  if (task.poster === run.account) return "the agent is its poster";
  if (task.verifier === run.account) return "the agent is its verifier";
  if (task.invited.length > 0 && !task.invited.includes(run.account)) {
    return "it takes invited entrants only and the agent is not one";
  }
  if (task.max_entries > 0 && task.commit_count >= task.max_entries) {
    return "it has all the entries it takes";
  }
  return null;
}

/**
 * One task of `enterTasks`. Throws for what is not the task's fault; the caller logs it. `invited`
 * says the task was listed as one that invites the agent: it is entered only if its detail says so,
 * and `not_invited` is the answer for one that does not.
 */
async function enter(
  run: Run,
  summary: TaskSummary,
  invited = false,
): Promise<"not_invited" | undefined> {
  const { id } = summary;
  const { memory } = run;

  // First of all, and for every task, since a solver can use up its last request in the middle of a
  // tick. A solver at its limit costs the API and the chain no call, and the task is left as it is,
  // unannounced and unseen, for a tick at which the solver has room. One that throws here has it
  // logged for the task by the caller, and the task is left as it is too.
  if (run.solver.available?.() === false) return;

  if (!isTaskId(id)) {
    const shown = oneLine(id, MAX_ID_CHARS);
    run.log(`WARN ${run.name}: skipping a listed task whose id is not a task id (${shown})`);
    return;
  }

  // A task that met a full count today waits for tomorrow, and costs no call until then.
  if (memory.capped.get(id) === utcDay(Date.now())) return;

  if (rejectedByTheJudge(run, summary)) return;

  // Not `memory`: a restart has none, and the draft holds the salt of a commitment that may be on
  // chain. Entering again would save a new salt over it, and the reveal could never open the commit.
  // Unless the draft is another task's with this number (`checkBinding`): a task is entered afresh
  // only once that draft is set aside.
  const draft = await run.state.getDraft(id);
  if (draft !== null) {
    // Another account's draft is not ours to look at, and `tendDrafts` is told of it.
    if (isDraftOf(draft, run.account)) {
      const binding = await checkBinding(run, draft, summary.created_at);
      // The chain could not be asked: the task is looked at again next tick.
      if (binding === "unknown") return;
      if (binding === "stands") {
        memory.seen.add(id);
        return;
      }
    } else {
      memory.seen.add(id);
      return;
    }
  }

  const found = await run.api.getTask(BigInt(id));
  if (found === null) return;
  const { task, brief, criteria } = found;
  // The solver answers the brief in the detail, and the commit goes under `id`: a detail that is
  // another task's would have the agent answer one task and enter another.
  if (task.id !== id) {
    run.log(`WARN ${run.name}: skipping task ${id}, the API answered with another task`);
    return;
  }
  // The listing is a moment old, and so is the verdict in it: the detail is fresher. `start` and
  // the commit would refuse a task past its window as well.
  if (rejectedByTheJudge(run, task)) return;
  if (brief === null || criteria === null) return;
  if (task.phase !== "open") return;
  if (invited && !task.invited.includes(run.account)) {
    memory.seen.add(id);
    return "not_invited";
  }
  // Without the agent's services, which this tick could not read, no task pinned to it can be told
  // from a hire or held to a service's terms: a Judge-checked hire's criteria are the service's own.
  // So each one waits, unseen, for a tick that reads them (the read is made again each tick), and is
  // neither entered on no terms nor turned away for good. The guard fails closed.
  if (run.services === null && task.invited.includes(run.account)) return;
  // A hire is taken only on the terms of a service the agent offers, whichever listing found it:
  // the invited one, or a tag the hire's brief carries. A pinned task that is no hire (other
  // criteria, found by a tag) is entered as it was before services, as any task of the agent's tags.
  let kind: Kind = "task";
  if (invited || (task.invited.includes(run.account) && isHireCriteria(run, task.criteria_hash))) {
    const hire = hireOf(run, task);
    if ("refusal" in hire) {
      memory.seen.add(id);
      run.log(`${run.name}: skipping task ${id}, ${hire.refusal}`);
      return;
    }
    kind = hire.kind;
  }

  const refusal = refusalOf(run, task);
  if (refusal !== null) {
    memory.seen.add(id);
    run.log(`${run.name}: skipping task ${id}, ${refusal}`);
    return;
  }

  // The entry policy. A hire is held to its service's terms already (the listing chose its price
  // and its checker), so it is not held to the least reward or to the verifiers. A hire its hirer
  // checks is held to the hirer's record of empty picks (`maxVoidsAfterReveals`), as the hirer is
  // its verifier; a hire the Judge checks is not.
  if (kind !== "judged hire") {
    const why = await policyRefusalOf(run, task, kind);
    // The verifier's record could not be read: the task waits, unseen, for the next tick.
    if (why === undefined) return;
    if (why !== null) {
      memory.seen.add(id);
      run.log(`${run.name}: skipping task ${id}, ${why}`);
      return;
    }
  }

  // The record of the poster (`maxPosterVoids`), for every kind: a hirer is a poster too.
  const posterWhy = await posterRefusalOf(run, task);
  // The poster's record could not be read: the task waits, unseen, for the next tick.
  if (posterWhy === undefined) return;
  if (posterWhy !== null) {
    memory.seen.add(id);
    run.log(`${run.name}: skipping task ${id}, ${posterWhy}`);
    return;
  }

  // Under the Judge-only rule, a task the Judge checks waits until the Judge has accepted it.
  if (awaitsTheJudge(run, task, kind)) return;

  // R22 (P05-P2): an entry that runs out of storage cannot reveal, and its window does not wait.
  // Checked here, ahead of `start` and the solver, rather than at the commit itself: an agent
  // that cannot commit then neither announces itself on the task nor spends a model call on it.
  if (await storageLow(run, id)) {
    memory.seen.add(id);
    return;
  }

  // The daily cap comes last, so that a task that fails another rule is turned away for good by
  // that rule (`roomToday` says what the cap does to each kind).
  if (!(await roomToday(run, id, kind))) return;

  // A solver that thinks reads what the poster has said in public on the task. A scripted one
  // answers from a file and has no use for it, so the API is not asked.
  const board = run.solver.scripted ? null : await boardOf(run, id);
  const ctx: TaskContext = { task, brief, criteria, board };
  let content: Uint8Array | null;
  if (run.solver.scripted) {
    // Review M6: a scripted solver reads its answer from a file, so asking is free, and a
    // stranger's task that it has no answer to is not announced. A `start` that fails leaves the
    // task unseen, and the next tick asks again.
    content = await ask(run, id, ctx);
    if (content === null) {
      memory.seen.add(id);
      return;
    }
    if (!(await countEntry(run, id, kind))) return;
    await run.api.start(BigInt(id));
    memory.seen.add(id);
  } else {
    if (!(await countEntry(run, id, kind))) return;
    await run.api.start(BigInt(id));
    memory.seen.add(id);
    content = await ask(run, id, ctx);
    if (content === null) return;
  }
  await commit(run, id, content, task.created_at);
}

/**
 * Why the entry policy turns `task` away, null if it does not, or undefined if it cannot tell now:
 * the record of the verifier, which `maxVoidsAfterReveals` needs, could not be read. Then the task
 * waits for the next tick, which reads the record again. The guard fails closed. A task of the
 * agent's tags is held to every rule; a hire its hirer checks to the record of its verifier, the
 * hirer, alone (`kind`). The rules compare the task's own values; only the log line is flattened.
 */
async function policyRefusalOf(
  run: Run,
  task: TaskDetail,
  kind: Kind,
): Promise<string | null | undefined> {
  const { policy } = run;
  if (policy === undefined) return null;
  if (kind === "task") {
    const why = policyRefusal(policy, task);
    if (why !== null) return oneLine(why, MAX_POLICY_REASON_CHARS);
  }
  const most = policy.maxVoidsAfterReveals;
  if (most === undefined) return null;
  const voids = await voidsOf(run, task.verifier);
  if (voids === undefined) return undefined;
  if (voids === null || voids <= most) return null;
  const verifier = oneLine(task.verifier, MAX_ACCOUNT_CHARS);
  const who =
    kind === "hirer hire" ? `its verifier, the hirer ${verifier},` : `its verifier ${verifier}`;
  return `${who} has voided ${voids} tasks after their reveals, more than the ${most} the agent accepts`;
}

/**
 * Whether `task`, a task of the agent's tags or a hire the Judge checks, waits for the Judge under
 * the Judge-only rule (`verifiers: "judge"`): until its `judge_status` is `accepted`. A task the
 * Judge has not looked at yet (null), or holds `pending` (its held-out checks are not in), may never
 * be accepted: a poster who never sends the checks has the revealed work and a full refund once it
 * is voided. So it is left unseen, for a later tick to look at again, and that it waits is said once.
 * A rejected task never gets here (`rejectedByTheJudge`). A hire its hirer checks has no Judge.
 */
function awaitsTheJudge(run: Run, task: TaskDetail, kind: Kind): boolean {
  if (run.policy?.verifiers !== "judge" || kind === "hirer hire") return false;
  if (task.judge_status === "accepted") {
    run.memory.awaitingJudge.delete(task.id);
    return false;
  }
  if (!run.memory.awaitingJudge.has(task.id)) {
    run.memory.awaitingJudge.add(task.id);
    const where =
      task.judge_status === null
        ? "it has not looked at it yet"
        : `it is ${oneLine(task.judge_status, MAX_ACCOUNT_CHARS)}`;
    run.log(`${run.name}: task ${task.id} waits until the Judge has accepted it (${where})`);
  }
  return true;
}

/**
 * Why `maxPosterVoids` turns `task` away, null if it does not, or undefined if it cannot tell now:
 * the poster's record could not be read, and the task waits for the next tick. A poster the API
 * labels as the team's (`is_team_poster`) is not held to it.
 */
async function posterRefusalOf(run: Run, task: TaskDetail): Promise<string | null | undefined> {
  const most = run.policy?.maxPosterVoids;
  if (most === undefined || task.is_team_poster) return null;
  const voided = await posterVoidsOf(run, task.poster);
  if (voided === undefined) return undefined;
  if (voided === null || voided <= most) return null;
  const poster = oneLine(task.poster, MAX_ACCOUNT_CHARS);
  return `its poster ${poster} has had ${voided} tasks voided after their reveals, more than the ${most} the agent accepts`;
}

/**
 * The tasks of `poster` voided after a reveal (`voided_after_reveals`), by its record in the API,
 * read once a tick: null for a poster the API labels as the team's, undefined if the record cannot
 * be read now, or is no count, which is said once in the tick.
 */
async function posterVoidsOf(run: Run, poster: string): Promise<number | null | undefined> {
  if (run.posters.has(poster)) return run.posters.get(poster);
  let voided: number | null | undefined;
  let why: string | undefined;
  try {
    const record = await run.api.getPoster(poster);
    voided = record.is_team ? null : record.voided_after_reveals;
    if (voided !== null && !(Number.isSafeInteger(voided) && voided >= 0)) {
      voided = undefined;
      why = "it holds no count";
    }
  } catch (error) {
    voided = undefined;
    why = describe(error);
  }
  run.posters.set(poster, voided);
  if (why !== undefined) {
    const shown = oneLine(poster, MAX_ACCOUNT_CHARS);
    run.log(
      `WARN ${run.name}: the record of poster ${shown} cannot be read (${why}), so its tasks wait`,
    );
  }
  return voided;
}

/**
 * The empty picks after reveals of `verifier` (`voids_after_reveals`), by its record in the API,
 * read once a tick: null if the API has no record of it (it is no registered agent), undefined if
 * the record cannot be read now, or is no count, which is said once in the tick.
 */
async function voidsOf(run: Run, verifier: string): Promise<number | null | undefined> {
  if (run.records.has(verifier)) return run.records.get(verifier);
  let voids: number | null | undefined;
  let why: string | undefined;
  try {
    const found = await run.api.getAgent(verifier);
    voids = found === null ? null : found.agent.voids_after_reveals;
    if (voids !== null && !(Number.isSafeInteger(voids) && voids >= 0)) {
      voids = undefined;
      why = "it holds no count";
    }
  } catch (error) {
    voids = undefined;
    why = describe(error);
  }
  run.records.set(verifier, voids);
  if (why !== undefined) {
    const shown = oneLine(verifier, MAX_ACCOUNT_CHARS);
    run.log(
      `WARN ${run.name}: the record of verifier ${shown} cannot be read (${why}), so its tasks wait`,
    );
  }
  return voids;
}

/**
 * Whether a task of `kind` is counted, and so held to a cap: a task of the agent's tags and a hire
 * its hirer checks while there is a `dailyEntries`, and a hire the Judge checks while there is
 * either cap (it counts toward `dailyEntries` too, though that cap does not hold it back).
 */
function counted(run: Run, kind: Kind): boolean {
  const { policy } = run;
  if (policy === undefined || run.entryCounts === undefined) return false;
  if (policy.dailyEntries !== undefined) return true;
  return kind === "judged hire" && policy.dailyJudgedHires !== undefined;
}

/**
 * The count of the day, read once a tick, and again when the UTC day turns. A count that cannot be
 * read is `unreadable` for the rest of the tick, which is said once.
 */
async function today(
  run: Run,
  counts: EntryCounts,
): Promise<{ day: string; count: DayCount } | "unreadable"> {
  const day = utcDay(Date.now());
  if (run.today === "unreadable") return run.today;
  if (run.today !== null && run.today.day === day) return run.today;
  try {
    run.today = { day, count: await counts.read(day) };
  } catch (error) {
    run.today = "unreadable";
    // The store's own errors name its file and quote nothing else, which is how the operator
    // learns which file to fix.
    const why = error instanceof Error ? oneLine(error.message) : typeof error;
    run.log(
      `ERROR ${run.name}: the count of the day's entries cannot be read (${why}), so the agent takes on nothing that its caps count until it can`,
    );
  }
  return run.today;
}

/** Refuses hire `id` for good: it is seen, and the reason is said once. Returns false. */
function refuseHire(run: Run, id: string, kind: Kind, why: string): false {
  run.memory.seen.add(id);
  const what = kind === "judged hire" ? "a hire the Judge checks" : "a hire its hirer checks";
  run.log(`${run.name}: skipping task ${id}, ${what}, as ${why}`);
  return false;
}

/**
 * Whether the day's count leaves room for task `id` of `kind`: always, for a kind no cap holds
 * (`counted`). Every cap fails closed, and each holds its kind differently:
 *
 * - `dailyEntries` holds the tasks of the agent's tags and the hires its hirer checks. A task that
 *   finds the day full waits, unseen, for the next UTC day, which is said once for it; with a count
 *   that cannot be read it waits for a tick that can read it, as a cap that is not known cannot be
 *   kept. A hire its hirer checks is refused for good, seen and said once, by a full day or a count
 *   that cannot be read: its hirer is its verifier, and a wait would only let its windows run out.
 * - `dailyJudgedHires` holds the hires the Judge checks, which `dailyEntries` does not hold back. A
 *   hirer can still ask for a delivery that fails the criteria, read it, and be refunded when the
 *   Judge picks nobody, so this caps what such hires cost. One over it, or met by a count that
 *   cannot be read, is refused for good like a hire its hirer checks.
 *
 * The void refunds a refused hire's hirer whole.
 */
async function roomToday(run: Run, id: string, kind: Kind): Promise<boolean> {
  const { policy, entryCounts } = run;
  if (!counted(run, kind) || policy === undefined || entryCounts === undefined) return true;
  const now = await today(run, entryCounts);
  const unreadable =
    "the count of the day's entries cannot be read, so the agent cannot keep its cap";
  if (kind === "judged hire") {
    if (now === "unreadable") return refuseHire(run, id, kind, unreadable);
    const most = policy.dailyJudgedHires;
    if (most === undefined || now.count.judgedHires < most) return true;
    const taken = `the agent has taken on ${now.count.judgedHires} of them today, its most`;
    return refuseHire(run, id, kind, `${taken} (dailyJudgedHires ${most})`);
  }
  const most = policy.dailyEntries;
  if (most === undefined) return true;
  if (now !== "unreadable" && now.count.entries < most) return true;
  if (now === "unreadable") {
    // A task of the agent's tags waits for a tick that can read it; a hire is refused.
    if (kind === "hirer hire") refuseHire(run, id, kind, unreadable);
    return false;
  }
  if (kind === "hirer hire") {
    const taken = `the agent has taken on ${now.count.entries} tasks today, its most`;
    return refuseHire(run, id, kind, `${taken} (dailyEntries ${most})`);
  }
  if (run.memory.capped.get(id) !== now.day) {
    run.memory.capped.set(id, now.day);
    run.log(
      `${run.name}: task ${id} waits for the next day (UTC): the agent has taken on ${now.count.entries} tasks today, its most (dailyEntries ${most})`,
    );
  }
  return false;
}

/**
 * Counts the task the agent is taking on, on the disk, before it is announced and before the solver
 * is asked: a crash after the solve has it counted. Returns whether the task may be taken on. A
 * write that fails takes nothing on: a task of the agent's tags is left for the next tick (the
 * error is thrown, and logged by the caller), and a hire is refused for good, as by a count that
 * cannot be read. A `start` that fails after the count leaves the task for the next tick, which
 * counts it again: a failure can cost a place under a cap, never a solve over it.
 */
async function countEntry(run: Run, id: string, kind: Kind): Promise<boolean> {
  if (!counted(run, kind) || run.entryCounts === undefined) return true;
  // `roomToday` read the count just before, in the same task, and took nothing on without it.
  if (run.today === null || run.today === "unreadable") {
    throw new Error("the count of the day was not read before a task was taken on");
  }
  const { day, count } = run.today;
  const next: DayCount = {
    entries: count.entries + 1,
    judgedHires: count.judgedHires + (kind === "judged hire" ? 1 : 0),
  };
  try {
    await run.entryCounts.write(day, next);
  } catch (error) {
    if (kind === "task") throw error;
    const why = `the count of the day's entries cannot be written (${describe(error)})`;
    return refuseHire(run, id, kind, why);
  }
  run.today = { day, count: next };
  return true;
}

/**
 * The question board of task `id`, or null when the API has none or cannot be read. A board is a
 * help and never a condition: a failure is logged by its type and code and nothing it came from,
 * and the task is entered without it.
 */
async function boardOf(run: Run, id: string): Promise<TaskBoard | null> {
  try {
    return await run.api.listQuestions(BigInt(id));
  } catch (error) {
    run.log(`WARN ${run.name}: could not read the board of task ${id} (${describe(error)})`);
    return null;
  }
}

/**
 * Asks the solver for the answer to task `id`, and gives up on it after `solveTimeoutMs` (review
 * M2). Returns the bytes, or null if the solver has no answer, failed or took too long; the reason
 * is logged. A solver cannot be stopped, so one that gives up late is let go: the race has settled
 * by then, and its late answer or error is dropped.
 */
async function ask(run: Run, id: string, ctx: TaskContext): Promise<Uint8Array | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), run.solveTimeoutMs);
  });
  let answer: Uint8Array | null | typeof TIMED_OUT;
  try {
    answer = await Promise.race([run.solver.solve(ctx), late]);
  } catch (error) {
    run.log(
      `ERROR ${run.name}: the ${run.solver.name} solver failed on task ${id} (${describe(error)})`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (answer === TIMED_OUT) {
    const limit = `${run.solveTimeoutMs} ms`;
    run.log(`ERROR ${run.name}: the ${run.solver.name} solver took over ${limit} on task ${id}`);
    return null;
  }
  if (answer === null) run.log(`${run.name}: no answer for task ${id}`);
  return answer;
}

/**
 * Enters task `id` with `content`: saves the draft, then sends the commit (`sendCommit`). The draft
 * is on disk (`saveDraft` writes and syncs a temp file and renames it) before the commit leaves,
 * which is the whole of the crash safety of the commit half. What a crash or a failed send leaves
 * behind, `recoverCommit` settles. The draft records the contract and `createdAt`, the creation time
 * of the task as the API has it, which say whose task it is (`checkBinding`).
 */
async function commit(run: Run, id: string, content: Uint8Array, createdAt: string): Promise<void> {
  const contentHash = sha256Hex(content);
  const salt = randomSalt();
  const draft: Draft = {
    taskId: id,
    contentBase64: Buffer.from(content).toString("base64"),
    contentHash,
    salt,
    commitment: computeCommitment(BigInt(id), run.account, contentHash, salt),
    contractId: run.client.contractId,
    taskCreatedAt: createdAt,
  };

  await run.state.saveDraft(draft);
  // The entry owes a reveal from here on, whether or not the commit goes through at once.
  run.owed += 1;
  await sendCommit(run, draft, false);
}

// ---- Settling a commit ------------------------------------------------------------------------

/**
 * Sends the commit of `draft`, and marks the draft committed once it has gone through. `again` says
 * the send repeats one that did not end well, for the log. Returns whether the commit went through.
 *
 * A failure that a second try would meet again (`REFUSED_FOR_GOOD`) makes the draft dead. Any
 * other is logged and left for a later tick: a transaction that failed to finish, or that timed
 * out (`E_TIMEOUT`), does not say whether it reached the chain (the next tick asks the chain,
 * `recoverCommit`), and sending the draft's commitment again is harmless, as a commit by an
 * account that has an entry only replaces the entry's commitment, here with the same one.
 * `E_PHASE` is that kind of failure for a resend too (review N1): the commit window has ended
 * since the send before, and that send may have landed just inside it. The next tick looks.
 */
async function sendCommit(run: Run, draft: Draft, again: boolean): Promise<boolean> {
  const id = draft.taskId;
  let txHash: string;
  try {
    txHash = (await run.client.commit(BigInt(id), draft.commitment)).txHash;
  } catch (error) {
    if (refusedForGood(error, again)) {
      await markDead(run, id, `commit to task ${id} refused for good (${describe(error)})`);
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
 * not when it landed). A failure is logged and changes nothing: the chain has the commit, and a
 * draft that is not marked is asked about again, and revealed all the same once the chain says so.
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
 * Gives the draft of task `id` up, and says why (P05-R14). That is said once, as `tendDrafts` lets a
 * dead draft alone from then on: it is neither sent nor revealed nor reported on, and its task is
 * not entered again. The reason is written on the draft (`StateStore.markDead`), so that a restart
 * lets it alone too, unless `own` is false: the draft is another account's, the file is not ours
 * to write on, and the run alone gives it up. A draft that cannot be marked is dead for this run all
 * the same, and a restart judges it again.
 */
async function markDead(run: Run, id: string, why: string, own = true): Promise<void> {
  run.memory.dead.add(id);
  run.log(`ERROR ${run.name}: ${why}, the draft is dead`);
  if (!own) return;
  try {
    await run.state.markDead(id, why);
  } catch (error) {
    run.log(
      `ERROR ${run.name}: the draft of task ${id} is dead, but could not be marked so (${describe(error)})`,
    );
  }
}

/**
 * Forgets what the run knew of task `id`, as a draft was set aside and the number may be a task of
 * another life of the chain: the new one is looked at from nothing.
 */
function forget(memory: AgentMemory, id: string): void {
  memory.seen.delete(id);
  memory.settled.delete(id);
  memory.dead.delete(id);
  memory.warned.delete(id);
  memory.waiting.delete(id);
  memory.resends.delete(id);
  memory.capped.delete(id);
}

/**
 * Whether `draft`, the account's own, is the draft of task `draft.taskId` as it stands, given
 * `createdAt`, the task's creation time as the API has it now (P05 whole-branch review I4):
 *
 * - `stands`: nothing says it is another task's (`staleReason`: the contract and the creation time
 *   it records fit, or it records too little to tell, as a draft from before drafts were bound), or
 *   the chain holds an entry of the account with the draft's commitment, which proves that it
 *   belongs here whatever the record says (the chain has the last word, as in the MCP server);
 * - `aside`: it is another task's, and the chain does not hold its commitment. It has been set aside
 *   with `StateStore.setAside`, whole and kept (it holds a work and a salt that are the other
 *   chain's), and the run has forgotten the task, so that the task has no draft and is entered
 *   afresh if it is open. Nothing is sent or revealed from it;
 * - `unknown`: the chain could not be asked, or the draft could not be set aside. Nothing is done
 *   for the draft or the task, and the next tick looks again. (The MCP server sets a draft aside
 *   when the chain cannot be asked; the runner has a next tick, so it waits.)
 */
async function checkBinding(
  run: Run,
  draft: Draft,
  createdAt: string,
): Promise<"stands" | "aside" | "unknown"> {
  const id = draft.taskId;
  const reason = staleReason(draft, run.client.contractId, createdAt);
  if (reason === null) return "stands";
  const looked = await lookUp(run, id);
  if (looked === undefined) return "unknown";
  if (looked.entry !== null && looked.entry.commitment === draft.commitment) return "stands";
  let kept: string | null;
  try {
    kept = await run.state.setAside(id);
  } catch (error) {
    run.log(
      `ERROR ${run.name}: the draft saved for task ${id} is not this task's, and it could not be set aside, so nothing is done for task ${id} (${describe(error)})`,
    );
    return "unknown";
  }
  forget(run.memory, id);
  const file = kept === null ? "" : `, kept whole as ${oneLine(kept, MAX_ID_CHARS)}`;
  run.log(
    `WARN ${run.name}: the draft saved for task ${id} is not this task's (${oneLine(reason)}), so it is set aside${file}`,
  );
  return "aside";
}

/**
 * The agent's entry in task `id` on the chain, in an object so that no entry (`null`) is not
 * mistaken for an entry that could not be read (`undefined`, logged). The chain is the authority
 * on an entry: the API's index trails it by a few blocks, and its entries carry no commitment.
 */
async function lookUp(run: Run, id: string): Promise<{ entry: EntryView | null } | undefined> {
  try {
    return { entry: await run.client.getEntry(BigInt(id), run.account) };
  } catch (error) {
    run.log(`ERROR ${run.name}: the entry in task ${id} cannot be read (${describe(error)})`);
    return undefined;
  }
}

/**
 * Settles a draft that is not marked committed (P05-R14). Its commit was cut short by a crash, or
 * failed in a way that said nothing of the chain, or went through and was not marked. The chain
 * knows which, and is asked (`get_entry`) before anything is sent. `task` is what the index shows
 * of the draft's task.
 *
 * - The account has an entry with the draft's commitment: the commit landed, and the draft is
 *   marked committed. This is the only way to learn it, as the contract has no "already
 *   committed" error: a second commit by the same account succeeds and replaces the first. It is
 *   asked before the phase of the task, so that a draft whose commit is on the chain is never
 *   given up, however late the agent comes back to it.
 * - It has none (or one with another commitment, which the draft's replaces) and the task is
 *   open: the draft's own commitment is to be sent again, at most `MAX_RESENDS` times in a run. It
 *   carries the draft's salt and hash, so that it opens with the draft's work, and no solver is
 *   asked. The send is not made here but queued (`Run.due`) for the end of the pass over the
 *   drafts (`resend`), so that the storage it needs is judged with every reveal owed (review N2).
 *   Once the resends are used up nothing more is sent, but the draft is not given up: the last
 *   send may have landed in a block that is not final yet, and a dead draft would lose its
 *   reveal. It is kept and looked up each tick like one in the reveal window (review R1).
 * - It has none and the task is in its reveal window: the commit window is over, so nothing can
 *   be sent, but the commit may be there all the same. The view is of the last final block, and a
 *   commit that landed one or two blocks ago is not in it yet. The draft is kept and looked up
 *   again next tick (review N1).
 * - It has none and the reveal window is over too: a commit that had landed would be final long
 *   since, so there is none, nothing can be sent or revealed, and the draft is dead. A task whose
 *   entries the keeper has cleaned up (`cleanup`, after the task has settled) shows none either,
 *   so a draft first looked at after that is given up as well, though it may have been entered
 *   (review N4).
 *
 * Returns whether the commit is on the chain, which is when the draft may be revealed. A lookup
 * that fails and a draft waiting for its resend or for the commit to show leave it for a later
 * tick.
 */
async function recoverCommit(run: Run, draft: Draft, task: TaskDetail): Promise<boolean> {
  const id = draft.taskId;

  const looked = await lookUp(run, id);
  if (looked === undefined) return false;
  const { entry } = looked;
  if (entry !== null && entry.commitment === draft.commitment) {
    run.log(`${run.name}: the commit to task ${id} was on chain already`);
    await markCommitted(run, draft);
    return true;
  }

  if (task.phase === "revealing") {
    if (!run.memory.waiting.has(id)) {
      run.memory.waiting.add(id);
      run.log(
        `${run.name}: task ${id} has no commit of its draft on chain yet, looking again until its reveal window is over`,
      );
    }
    return false;
  }
  if (task.phase !== "open") {
    const why = `task ${id} has no commit of its draft on chain and its reveal window is over`;
    await markDead(run, id, why);
    return false;
  }
  if ((run.memory.resends.get(id) ?? 0) >= MAX_RESENDS) {
    // Review R1: said once, as the draft is looked for from here to the end of the reveal window,
    // and the line of the reveal window (above) would only repeat it.
    if (!run.memory.waiting.has(id)) {
      run.memory.waiting.add(id);
      run.log(
        `ERROR ${run.name}: commit to task ${id} did not go through in ${MAX_RESENDS} resends, not sending it again, looking for it until its reveal window is over`,
      );
    }
    return false;
  }
  run.due.push(draft);
  return false;
}

/**
 * Sends the commit of a draft that `recoverCommit` found missing from the chain, once the pass over
 * the drafts is done (review N2). The send enters the agent's account in a task, which needs the
 * storage of an entry (R22), and the drafts that come after this one in the pass owe reveals
 * that the storage must cover too. Judged with the count of the drafts so far, a resend could
 * take storage from the reveals of the drafts it was ahead of.
 *
 * The draft's own reveal is in `owed` (it is not revealed, and its task is open) and in the 1 KiB
 * of the entry, so the count the storage check takes leaves it out. A draft that the contract
 * refuses for good owes no reveal after all.
 */
async function resend(run: Run, draft: Draft): Promise<void> {
  const id = draft.taskId;
  if (await storageLow(run, id, Math.max(0, run.owed - 1))) return;
  run.memory.resends.set(id, (run.memory.resends.get(id) ?? 0) + 1);
  await sendCommit(run, draft, true);
  if (run.memory.dead.has(id)) run.owed -= 1;
}

/**
 * Whether the agent's storage on the contract is below what a new entry needs (R22): 1 KiB, and
 * the storage of the reveal of each of the `owed` entries the agent has already (review M1: the
 * drafts that are still to be revealed, and the commits made earlier in the tick; by default all
 * that the tick has counted). It reads the balance now, and warns once for each task if it is
 * short. A function-call key cannot top the account up, so the agent can only wait for someone to.
 */
async function storageLow(run: Run, id: string, owed = run.owed): Promise<boolean> {
  const storage = await run.client.storageBalanceOf(run.account);
  const needed = STORAGE_FLOOR_BYTES + BigInt(owed) * STORAGE_PER_OWED_BYTES;
  if (storageShortfall(storage, needed) <= 0n) return false;
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
 * - a draft that is not the account's is dead, and nothing is done for it (`isDraftOf`);
 * - a draft that is dead on its file is let alone (`Draft.dead`);
 * - a draft that is another task's with this number is set aside, and not tended (`checkBinding`);
 * - a draft not marked committed is settled first (`recoverCommit`): the chain is asked, and the
 *   commit is marked, kept for the next tick, queued to be sent again or given up;
 * - a draft that is not revealed, for a task in its reveal window, is revealed;
 * - a draft whose task has settled is logged as `won`, `lost` or `refunded`, once;
 * - then, with every draft counted, the commits that were queued are sent again (`resend`).
 *
 * It works from the drafts and from what the API and the chain say of their tasks, and from nothing
 * the run remembers apart from which outcomes it has logged and which drafts are dead, so it
 * finishes the work of a run that was killed. A commit that went through just before a crash
 * stopped the draft from being marked is found by `recoverCommit`, and the reveal follows in the
 * same pass. A dead draft is let alone: it is not revealed, and no outcome is logged for an entry
 * the agent never made.
 *
 * The store refuses to list the drafts if one file is not a draft, and a reveal's window does not
 * wait for someone to fix it. So when the list is refused the error is logged, and the reveals
 * that are due are found another way (`tendRevealing`).
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
    await tendRevealing(run);
    return;
  }

  for (const draft of drafts) {
    if (run.signal?.aborted) return;
    await tendOne(run, draft);
  }
  // Review N2: a resend makes an entry that takes storage, and the reveals of the drafts it was
  // ahead of in the pass must be counted before it is judged. The ones in `due` are in the count.
  for (const draft of run.due) {
    if (run.signal?.aborted) return;
    await resendOne(run, draft);
  }
}

/**
 * The drafts that are due a reveal when the store cannot list them (review I1). The account's
 * entries, as the API lists them, name the tasks in their reveal window whose entry is not
 * revealed; the draft of each is read by its own, so that the one file that cannot be read costs
 * only its own task, and tended as usual. The entries also say how many reveals the agent owes,
 * which sets the storage that new entries need (review M1), since the drafts are not there to
 * count.
 *
 * The answer is the API's word, and a broken one costs what it breaks (review N5): a body whose
 * entries are no list is logged and the tick goes on to the open tasks, and an entry that cannot
 * be read is logged without keeping the others from being tended. Only reveals are the fallback's
 * business, so a commit that a draft is waiting to have sent again is left for a tick that can
 * read the drafts.
 */
async function tendRevealing(run: Run): Promise<void> {
  let entries: AccountEntry[];
  try {
    const listed = await run.api.listEntries(run.account);
    if (!Array.isArray(listed.entries)) throw new TypeError("the entries are not a list");
    entries = listed.entries;
  } catch (error) {
    run.log(`ERROR ${run.name}: the entries of the account cannot be listed (${describe(error)})`);
    return;
  }

  let owed = 0;
  for (const entry of entries) {
    if (run.signal?.aborted) return;
    try {
      if (entry.revealed) continue;
      if (entry.phase === "open") owed += 1;
      if (entry.phase === "revealing") {
        owed += 1;
        await tendDue(run, entry.task_id);
      }
    } catch (error) {
      run.log(`ERROR ${run.name}: an entry of the account cannot be read (${describe(error)})`);
    }
  }
  run.owed = Math.max(run.owed, owed);
}

/** The draft of task `taskId`, which the API's entries name as due a reveal, tended by itself. */
async function tendDue(run: Run, taskId: string): Promise<void> {
  // The id is the API's word: it is used only once it is known to be a task id.
  if (!isTaskId(taskId)) return;
  let draft: Draft | null;
  try {
    draft = await run.state.getDraft(taskId);
  } catch (error) {
    run.log(`ERROR ${run.name}: task ${taskId} failed (${describe(error)})`);
    return;
  }
  if (draft !== null) await tendOne(run, draft);
}

/**
 * One draft of `tendDrafts`: skipped if it is dead or settled, and a failure is its own. A draft is
 * dead for the run (`AgentMemory.dead`) or on its file (`Draft.dead`), where an earlier run wrote
 * it. A dead draft that is another task's does not hold its number: `enter` sets it aside when the
 * number comes up as an open task (`checkBinding`).
 */
async function tendOne(run: Run, draft: Draft): Promise<void> {
  const { taskId } = draft;
  if (run.memory.settled.has(taskId) || run.memory.dead.has(taskId)) return;
  if (draft.dead !== undefined) return;
  try {
    await tendDraft(run, draft);
  } catch (error) {
    run.log(`ERROR ${run.name}: task ${taskId} failed (${describe(error)})`);
  }
}

/** One send again of `tendDrafts`: a failure is its own, as in `tendOne`. */
async function resendOne(run: Run, draft: Draft): Promise<void> {
  try {
    await resend(run, draft);
  } catch (error) {
    run.log(`ERROR ${run.name}: task ${draft.taskId} failed (${describe(error)})`);
  }
}

async function tendDraft(run: Run, draft: Draft): Promise<void> {
  const id = draft.taskId;
  if (!isTaskId(id)) {
    const shown = oneLine(id, MAX_ID_CHARS);
    run.log(`WARN ${run.name}: skipping a draft whose task id is not a task id (${shown})`);
    return;
  }
  // Review N3: before anything is sent, uploaded or revealed for it, and before the API is asked.
  if (!isDraftOf(draft, run.account)) {
    await markDead(run, id, `the draft saved for task ${id} was not made by ${run.account}`, false);
    return;
  }
  const found = await run.api.getTask(BigInt(id));
  // The index does not know the task (yet): there is nothing to compare the draft with.
  if (found === null) return;
  const { task } = found;
  // The phase and the outcome of another task would have the draft revealed early, or its task
  // reported settled for the rest of the run.
  if (task.id !== id) {
    run.log(`WARN ${run.name}: task ${id} not tended, the API answered with another task`);
    return;
  }
  // I4: before the draft is sent, revealed or counted. A draft that is another task's, however
  // far on it is, would send its commitment to this task, reveal into it, or log its outcome.
  if ((await checkBinding(run, draft, task.created_at)) !== "stands") return;

  let revealed = draft.revealedUri !== undefined;
  // A revealed draft was committed. One that is neither revealed nor marked committed may or may
  // not have its commit on the chain, and nothing is revealed or sent before that is known.
  const committed =
    revealed || draft.committedAt !== undefined || (await recoverCommit(run, draft, task));
  if (committed && !revealed && task.phase === "revealing") revealed = await reveal(run, draft);

  if (committed && task.outcome !== null) {
    await logOutcome(run, found, revealed);
    run.memory.settled.add(id);
    return;
  }
  // Review M1: what is still to be revealed holds back storage for the reveal.
  const live = task.phase === "open" || task.phase === "revealing";
  if (!revealed && live && !run.memory.dead.has(id)) run.owed += 1;
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
 * Whether the agent's entry in the task is revealed, by the API's entries and, if they do not show
 * it, by the chain's: the index trails the chain, and a revealed entry may not be shown yet.
 * `undefined` if the chain could not be read, or no longer has the entry: the keeper's `cleanup`
 * deletes the entries of a settled task, revealed or not, so none says nothing (review N4).
 */
async function entryRevealed(run: Run, found: TaskDetailResponse): Promise<boolean | undefined> {
  if (found.entries.some((entry) => entry.account === run.account && entry.revealed)) return true;
  const looked = await lookUp(run, found.task.id);
  if (looked === undefined || looked.entry === null) return undefined;
  return looked.entry.uri !== null;
}

/**
 * Logs how a settled task ended for the agent: `won` with what it was paid, `lost` (it was not
 * among the winners, and if it never revealed, that is said), or `refunded` (the task was voided).
 * `revealed` is what the draft says. A draft that does not say so may have lost its mark after
 * the reveal went through, so "never revealed" is said only when the API and the chain agree that
 * the entry is not revealed (review M7), and not at all if the chain cannot be read or has cleaned
 * the entry up (review N4).
 */
async function logOutcome(run: Run, found: TaskDetailResponse, revealed: boolean): Promise<void> {
  const { task } = found;
  const { outcome } = task;
  if (outcome === null) return;
  if (outcome.kind === "voided") {
    run.log(`${run.name}: refunded task ${task.id} (${outcome.reason})`);
    return;
  }
  const win = outcome.winners.find((winner) => winner.account === run.account);
  if (win !== undefined) {
    run.log(`${run.name}: won task ${task.id} amount=${win.amount} token=${task.token}`);
    return;
  }
  const never = !revealed && (await entryRevealed(run, found)) === false;
  run.log(`${run.name}: lost task ${task.id}${never ? " (never revealed)" : ""}`);
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
 * next tick. It throws only when the client has no signer, or `solveTimeoutMs` is not a wait that
 * `setTimeout` keeps. Pass `signal` to have it end before it starts on its next task or draft; the
 * one in hand is seen through, so that a commit that went out has its draft marked.
 *
 * Known limits, accepted (P05-R14):
 *
 * - A solver that takes long delays the agent's later tasks in the same tick, and a reveal that
 *   falls due during a solve waits for the tick to end. A solve is bounded by `solveTimeoutMs`.
 * - A `won`, `lost` or `refunded` line is logged again for each settled draft after a restart, as
 *   a draft has no slot to say its outcome was logged.
 * - The storage view is read once for a task, before the solver is asked, and not again before
 *   the commit.
 * - A draft of another account's is dead for the run only, as its file is not the agent's to
 *   write on: a restart judges it again, which costs a lookup. A draft of the agent's own that is
 *   given up is marked dead on its file, and a restart lets it alone.
 * - A draft with no commit in view in its task's reveal window costs a lookup each tick until the
 *   window is over (review N1), and so does one whose five resends are used up, from the tick that
 *   finds them so (review R1). A commit that never landed is given up only when the window is over.
 * - One process owns a state directory (review M5): nothing locks it, and two runners on one
 *   directory (or a runner beside the MCP server's `commit_result`) can interleave their commits
 *   so that a draft's salt no longer opens the commitment on the chain. A directory shared by
 *   two accounts is caught where the drafts differ in who made them: a draft of another account
 *   is dead (review N3), and its task is never entered from here.
 * - The keeper's `cleanup` deletes the entries of a settled task from the chain (review N4). A
 *   draft that was never marked and is first looked at after that is given up as having no
 *   commit on chain, whether or not it ever had one, and no outcome line is written for it. A
 *   draft that is marked but not revealed is not called "never revealed" once the chain has no
 *   entry to show it by.
 *
 * `runAgent` calls this in a loop; it is exported so that a test can run one tick at a time.
 */
export async function agentTick(opts: AgentTickOptions): Promise<void> {
  const account = opts.client.accountId;
  if (account === undefined) throw new Error(NO_SIGNER);
  const solveTimeoutMs = opts.solveTimeoutMs ?? DEFAULT_SOLVE_TIMEOUT_MS;
  checkMs("solveTimeoutMs", solveTimeoutMs);
  if (opts.policy !== undefined) checkPolicy(opts.policy, opts.entryCounts);
  const run: Run = {
    name: opts.name,
    account,
    client: opts.client,
    api: opts.api,
    state: opts.state,
    tags: opts.tags,
    services: null,
    solver: opts.solver,
    solveTimeoutMs,
    log: opts.log ?? console.log,
    signal: opts.signal,
    memory: opts.memory ?? new AgentMemory(),
    owed: 0,
    due: [],
    policy: opts.policy,
    entryCounts: opts.entryCounts,
    records: new Map(),
    posters: new Map(),
    today: null,
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
 * long a solver takes (up to `solveTimeoutMs`, default 120 s, for each task). A tick that throws is
 * logged and the loop goes on.
 *
 * An abort during the wait ends the loop at once. An abort during a tick lets the task in hand
 * finish first, and the tick starts on no other. A signal that is aborted already runs no tick. The
 * returned promise resolves once the loop has stopped. It rejects only at once, without running a
 * tick, for a client with no signer, for a `pollMs` or `solveTimeoutMs` that `setTimeout` cannot
 * keep, or for a `policy` that cannot be applied (`checkPolicy`).
 *
 * The first line says which account the agent signs as, and whether its solver is scripted, so
 * that a run of the team's scripted agents cannot be mistaken for something else. With a policy,
 * the second line says it.
 */
export async function runAgent(o: RunAgentOptions): Promise<void> {
  const { signal } = o;
  const pollMs = o.pollMs ?? DEFAULT_POLL_MS;
  checkMs("pollMs", pollMs);
  // Refused here and not left to the first tick, which would throw it again every time.
  checkMs("solveTimeoutMs", o.solveTimeoutMs ?? DEFAULT_SOLVE_TIMEOUT_MS);
  if (o.policy !== undefined) checkPolicy(o.policy, o.entryCounts);
  const account = o.client.accountId;
  if (account === undefined) throw new Error(NO_SIGNER);

  const log = o.log ?? console.log;
  const memory = new AgentMemory();
  const tags = o.tags.length === 0 ? "none" : o.tags.join(", ");
  const kind = o.solver.scripted ? " (scripted)" : "";
  log(`${o.name}: running as ${account}, tags ${tags}, ${o.solver.name} solver${kind}`);
  if (o.policy !== undefined) log(`${o.name}: entry policy ${describePolicy(o.policy)}`);

  while (!signal.aborted) {
    try {
      await agentTick({ ...o, log, signal, memory });
    } catch (error) {
      log(`ERROR ${o.name}: tick failed (${describe(error)})`);
    }
    await sleep(pollMs, signal);
  }
}
