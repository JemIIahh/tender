import { type Db, putBlob, setBlobPublic } from "@tender/db";
import { type EntryView, phaseOfTaskView, sha256Hex, type TaskView } from "@tender/shared";
import { FETCH_TIMEOUT_MS, fetchEntryContent, ownBlobHash } from "./fetch";
import { loadDocuments } from "./intake";
import { COMPILE_BUDGET_MS, openTaskScorer, type TaskScorer } from "./isolate";
import { chooseWinners, rankEntries, type ScoredEntry } from "./rank";
import { ScorerUnavailableError } from "./score";
import { buildScorecard, clampReason } from "./scorecard";
import type { EntryScore, JudgeDeps } from "./types";

/**
 * How many entries whose contents are in our own store are taken at a time: no more contents
 * than this are held at once.
 */
const OURS_PER_BATCH = 32;
/**
 * How many entries hosted elsewhere are taken at a time. They are all fetched at once, so a batch
 * of URIs that hang costs one fetch's time, not one for each (P05-R16).
 */
const ELSEWHERE_PER_BATCH = 8;
/** How many permissions are asked, and contents fetched, at once. */
const FETCHES_AT_ONCE = 8;
const NS_PER_MS = 1_000_000n;
const NS_PER_S = 1_000_000_000n;
/**
 * How long `pick` takes to land once it is sent. Nothing is published unless there is this much
 * time left before the pick deadline (P05-R15).
 */
const PICK_LATENCY_NS = 2n * NS_PER_S;
/**
 * The time judging leaves before the pick deadline, when it starts nothing new: a tenth of the
 * pick window, and no less than 3 s or more than 30 s (P05-R13).
 */
const MIN_MARGIN_NS = 3n * NS_PER_S;
const MAX_MARGIN_NS = 30n * NS_PER_S;
/**
 * How many times intake's budget judging gives the criteria check. The check is the same
 * (P05-R12); only the time differs, so that criteria that compiled in time at intake are not
 * refused at judging because the machine is busier.
 */
const JUDGING_COMPILE_BUDGET_FACTOR = 4;
const NOT_SCORED = "not scored before the pick deadline";
const NOT_UPLOADED = "content unavailable: not uploaded for this task";
/** The `judge_reason` of a task that judging got to too late to score any entry (P05-R13). */
const TOO_LATE = "not judged: judging started too late to score any entry";
/** The `judge_reason` of a task whose pick could not land before its deadline (P05-R15). */
const NO_TIME_TO_PICK = "not judged: the pick could not land before the pick deadline";

/** An entry that has revealed its content's hash and where the content is. */
type RevealedEntry = EntryView & { content_hash: string; uri: string };

/**
 * Judges task `taskId` and settles it with `pick`, once. What it came to:
 *
 * - `picked`: the winners are paid. `no_award`: nobody passed, and an empty `pick` refunded the
 *   task at once.
 * - `skipped`: nothing was settled. The task is not one to judge now: the chain has no such task,
 *   it is settled, it names another verifier, it is not in its judging window, or intake did not
 *   accept it. Or it waits for another task of its poster's with the same held-out checks to close
 *   its reveals (see `sharingTaskStillRevealing`), since publishing the checks would hand out that
 *   task's answers; the wait is a `WARN` once and the task's `judge_reason` until it ends. Or
 *   judging hit trouble of the Judge's own, which it logs as a `WARN` and leaves for the next
 *   tick: a scorer that could not run, a scorecard that could not be built, a `pick` that failed.
 *   `E_SETTLED` from `pick` means someone settled the task first, and is not logged. Or the task
 *   has entries, and the Judge's own lateness left all of them unscored (P05-R13, P05-R16):
 *   judging started past the stop line before the pick deadline, or its workers could not be
 *   loaded and the criteria compiled before it. It is not picked, as a pick would pay nobody for
 *   the Judge's lateness, and is left to its fallback window; that is one `WARN`, and its
 *   `judge_reason` from then on. When the entrants' own fetches and scores used the time, the task
 *   is picked from what was found out. Or the pick could no longer land before the pick deadline
 *   (P05-R15): nothing is published, and it is the same.
 * - `failed_closed`: the task is never judged, and the poster's fallback window applies. Either
 *   its criteria fail the criteria check now (P05-R12: the check intake runs, run again before
 *   any entry is scored, as a rule may be newer than the task's intake, with 4 times intake's
 *   time for the compile so that a busy machine does not refuse what compiled at intake), or the
 *   score worker cannot compile them within that time (P05-R17), and its status becomes
 *   `rejected` with the reason and one `WARN`; no entry is scored 0 for the criteria. Or the
 *   criteria or held-out checks that the chain names cannot be read or used (they passed intake,
 *   so they are gone or changed), and its status becomes `failed_closed` with the reason.
 *
 * The task is read from the chain first, every time, so a `pick` that landed before a crash shows
 * as an outcome and nothing is done again. It must be in `judging` both by `deps.now` and by the
 * final block the chain answered from, which is after every reveal that can land.
 *
 * Each revealed entry's content is fetched (`fetchEntryContent`) and must hash to the entry's
 * `content_hash`; one of our own blob URIs counts only when `deps.resultUploaded` says the entrant
 * may use those bytes for this task. One that cannot be fetched or does not count (`content
 * unavailable: …`), or that does not match (`content hash mismatch`), scores 0 and never passes,
 * whatever the pass mark, so it cannot be paid. The rest are scored in a worker of the task's own
 * (`openTaskScorer`), which compiles the criteria before it takes an entry, with at most 5 s for
 * each: an entry whose scoring times out, runs out of memory or crashes the worker scores 0 with
 * the reason why, and the other entries are scored as usual. In what order the entries are fetched and scored, and which are left unscored so that
 * the pick lands before the pick deadline, is `judgeEntries`'s; a task with no entries is picked
 * as before, and one with some scored is picked from those. Then the entries are ranked, the
 * winners chosen, and the scorecard built from exactly the winners `pick` is sent. The scorecard
 * is stored as a public blob, the held-out checks are made public, and `pick` is called with the
 * scorecard's hash and URI, in that order, so that the pick never points at something that cannot
 * be read. A retry stores the same scorecard again unless the clock moved: its bytes depend on the
 * entries and `generated_at` only.
 *
 * Database and chain read errors are thrown, for the loop to log; nothing is settled.
 */
export async function judgeTask(
  deps: JudgeDeps,
  taskId: bigint,
): Promise<"picked" | "no_award" | "skipped" | "failed_closed"> {
  const clock = deps.now ?? (() => new Date());
  const nowNs = BigInt(clock().getTime()) * NS_PER_MS;
  const task = await deps.client.getTask(taskId);
  if (task === null || task.outcome !== null || task.verifier !== deps.judgeAccount) {
    return "skipped";
  }
  if (task.phase !== "judging" || phaseOfTaskView(task, nowNs) !== "judging") return "skipped";
  const row = await judgeRowOf(deps, taskId);
  if (row?.judge_status !== "accepted") return "skipped";

  const compileBudgetMs =
    JUDGING_COMPILE_BUDGET_FACTOR * (deps.scoringLimits?.compileBudgetMs ?? COMPILE_BUDGET_MS);
  const loaded = await loadDocuments(deps.db, task, {
    teamAccounts: deps.teamAccounts,
    nowNs,
    waitForHeldout: false,
    compileBudgetMs,
  });
  if (!loaded.ok) {
    // P05-R12: criteria that fail the check intake runs, run again now, are refused as intake
    // would refuse them today, and not scored. Anything else means the documents cannot be used.
    const status = loaded.criteriaCheck === true ? "rejected" : "failed_closed";
    return refuse(deps, taskId, status, loaded.reason);
  }
  const { criteria, heldout } = loaded.documents;
  // Publishing the held-out checks hands out the answers of another task of the poster's that
  // commits to them, so while one still takes reveals, this task may wait. Asked here, so that a
  // task that waits costs little, and again just before publishing: the indexer may store such
  // a task while this one is judged.
  const sharing = await sharingTaskStillRevealing(deps.db, task, nowNs);
  if (sharing !== null) return waitFor(deps, taskId, sharing);
  if (row.judge_reason?.startsWith(WAITING) === true) await stopWaiting(deps, taskId);

  const revealed = (await deps.client.getAllEntries(taskId)).filter(isRevealed);
  const scorer = openTaskScorer(
    { criteria, heldout },
    {
      entryTimeoutMs: deps.scoringLimits?.entryTimeoutMs,
      // The worker compiles the criteria under the budget of the check just run (P05-R17).
      compileBudgetMs,
      onCrash: (error) => {
        console.warn(
          `judge: WARN task ${taskId}: scoring an entry failed (${describeError(error)})`,
        );
      },
    },
  );
  let judged: Judged;
  try {
    judged = await judgeEntries(deps, task, revealed, scorer, nowNs);
  } catch (error) {
    if (!(error instanceof ScorerUnavailableError)) throw error;
    return retryLater(taskId, `a scorer could not be run (${describeError(error)})`);
  } finally {
    await scorer.close();
  }
  // P05-R17: criteria that do not compile for scoring, or not within the budget, are refused as
  // the criteria check refuses them, and no entry is scored 0 for it.
  if (judged.rejected !== null) {
    return refuse(deps, taskId, "rejected", clampReason(judged.rejected));
  }
  // P05-R13, P05-R16: when the Judge's own lateness left every entry unscored (it started past the
  // stop line, or its workers could not be made ready before it), a pick would pay nobody for it.
  // The task is left to its fallback window. When the entrants' fetches and scores used the time,
  // it is picked from what was found out.
  if (judged.late && judged.scored === 0 && judged.unscored > 0) {
    return notJudged(deps, taskId, TOO_LATE, "judging started too late to score any entry");
  }

  const ranked = rankEntries(judged.entries);
  // The one list of winners: the scorecard states it and `pick` pays it.
  const winners = chooseWinners(ranked, criteria, task.max_winners);
  let scorecard: Uint8Array;
  try {
    scorecard = buildScorecard({
      task,
      kind: criteria.kind,
      criteriaHash: task.criteria_hash,
      heldoutCommitment: task.heldout_commitment,
      heldout,
      ranked,
      winners,
      model: null,
      now: clock(),
    });
  } catch (error) {
    return retryLater(taskId, `the scorecard could not be built (${describeError(error)})`);
  }

  const stillSharing = await sharingTaskStillRevealing(
    deps.db,
    task,
    BigInt(clock().getTime()) * NS_PER_MS,
  );
  if (stillSharing !== null) return waitFor(deps, taskId, stillSharing);
  // P05-R15: the scorecard carries the held-out checks, and both are public from here on. They are
  // not published for a pick that can no longer land before the pick deadline.
  if (BigInt(clock().getTime()) * NS_PER_MS + PICK_LATENCY_NS >= BigInt(task.pick_deadline)) {
    const why = "too late to pick before the pick deadline, so nothing is published";
    return notJudged(deps, taskId, NO_TIME_TO_PICK, why);
  }
  const sha256 = await putBlob(deps.db, {
    kind: "scorecard",
    contentType: "application/json",
    bytes: scorecard,
    taskId,
    uploader: deps.judgeAccount,
    isPublic: true,
  });
  if (task.heldout_commitment !== null) await setBlobPublic(deps.db, task.heldout_commitment, true);
  const uri = `${deps.publicUrl.replace(/\/+$/, "")}/v1/blobs/${sha256}`;
  try {
    await deps.client.pick(taskId, winners, sha256, uri);
  } catch (error) {
    if (codeOf(error) === "E_SETTLED") return "skipped";
    return retryLater(taskId, `pick failed (${describeError(error)})`);
  }
  return winners.length === 0 ? "no_award" : "picked";
}

/** What judging a task's entries came to. */
interface Judged {
  /** The score of each entry, for `judgeTask` to rank. */
  entries: ScoredEntry[];
  /** How many entries were left unscored at the stop line. */
  unscored: number;
  /** How many contents the scorer scored, whatever came of each. */
  scored: number;
  /**
   * Whether the Judge's own lateness used up the time: judging started past the stop line, or a
   * worker could not be loaded and its criteria compiled before it.
   */
  late: boolean;
  /** Why the criteria cannot be scored with, when the scorer found so; nothing is scored then. */
  rejected: string | null;
}

/**
 * Scores task `task`'s revealed `entries`, one score for each.
 *
 * Entries whose contents are in our own store come first, as their contents are read from the
 * database, and then those hosted elsewhere, which can hang (P05-R16): an entry elsewhere cannot
 * use up the time an entry of ours needs. Each group goes in commit order, the earliest committed
 * first (within a block by account, as the ranking breaks a tie). Ours are taken 32 at a time,
 * and the others 8 at a time, all of a batch's fetched at once, so that URIs that hang cost one
 * fetch's time a batch. A batch's contents are scored one after another by `scorer`, and each is
 * let go once it is scored: no more than 32 are held at once, and only their scores are kept, so
 * memory stays bounded however many entries the task has (`max_entries` 0 sets no limit). Entries
 * with the same URI and content hash share one fetch and one score. Whether an entrant may use one
 * of our own blobs (`resultUploaded`, asked at the Judge's clock `nowNs`) is asked of each entry
 * all the same: it is the entrant's, not the content's.
 *
 * Nothing runs past the stop line (P05-R15): the pick deadline less a tenth of the pick window
 * (from the reveal deadline to the pick deadline), and no less than 3 s or more than 30 s
 * (P05-R13). No fetch or score starts at it, each one has the smaller of its own limit and the
 * time left, and one that the line cuts short is let go. The line is drawn from the task's own
 * deadlines, as P05-R8's wait can leave judging only the second half of the window. An entry not
 * scored by then scores 0 and does not pass, and the scorecard says why: `not scored before the
 * pick deadline`. A fetch or a score that fails within its own limit is that entry's, as before.
 *
 * It throws what `resultUploaded` and the database throw, and `ScorerUnavailableError`.
 */
async function judgeEntries(
  deps: JudgeDeps,
  task: TaskView,
  entries: readonly RevealedEntry[],
  scorer: TaskScorer,
  nowNs: bigint,
): Promise<Judged> {
  const clock = deps.now ?? (() => new Date());
  const stopLine = stopLineOf(task);
  /** The time left before the stop line, in milliseconds, by the Judge's clock. */
  const leftMs = () => Number(stopLine - BigInt(clock().getTime()) * NS_PER_MS) / 1e6;
  const judging: Judging = { results: new Map(), scored: 0, late: false, rejected: null };
  // Judging that starts past the line scores nothing, through no doing of the entrants'.
  if (entries.length > 0 && leftMs() <= 0) judging.late = true;
  const ours = (entry: RevealedEntry) => ownBlobHash(deps.publicUrl, entry.uri) !== undefined;
  const groups: [RevealedEntry[], number][] = [
    [entries.filter(ours).toSorted(inCommitOrder), OURS_PER_BATCH],
    [entries.filter((entry) => !ours(entry)).toSorted(inCommitOrder), ELSEWHERE_PER_BATCH],
  ];
  const judged: Judged = { entries: [], unscored: 0, scored: 0, late: false, rejected: null };
  for (const [group, perBatch] of groups) {
    for (let first = 0; first < group.length; first += perBatch) {
      const batch = group.slice(first, first + perBatch);
      const going = leftMs() > 0 && !judging.late && judging.rejected === null;
      const scores = going
        ? await judgeBatch(deps, BigInt(task.id), batch, scorer, judging, leftMs, nowNs)
        : [];
      batch.forEach((entry, i) => {
        const score = scores[i];
        if (score === undefined) judged.unscored++;
        judged.entries.push({
          account: entry.account,
          contentHash: entry.content_hash,
          uri: entry.uri,
          committedAtBlock: BigInt(entry.committed_at_block),
          ...(score ?? zero(NOT_SCORED)),
        });
      });
    }
  }
  return { ...judged, scored: judging.scored, late: judging.late, rejected: judging.rejected };
}

/** What judging a task's entries has found out so far. */
interface Judging {
  /** The score of each content scored, or turned away, so far, by `contentKey`. */
  results: Map<string, EntryScore>;
  /** How many contents the scorer scored. */
  scored: number;
  /** See `Judged`. */
  late: boolean;
  rejected: string | null;
}

/**
 * The scores of one batch of entries of task `taskId`, `undefined` for each that has none: it was
 * not reached before the stop line, or the line cut its fetch or its score short. `judging` has
 * what earlier batches found out, and gets this one's. `leftMs` is the time left before the stop
 * line.
 */
async function judgeBatch(
  deps: JudgeDeps,
  taskId: bigint,
  batch: readonly RevealedEntry[],
  scorer: TaskScorer,
  judging: Judging,
  leftMs: () => number,
  nowNs: bigint,
): Promise<(EntryScore | undefined)[]> {
  const { results } = judging;
  const allowed = await inParallel(batch, FETCHES_AT_ONCE, (entry) =>
    mayUse(deps, taskId, entry, nowNs),
  );
  // The contents that this batch is the first to need, each once.
  const wanted = new Map<string, RevealedEntry>();
  batch.forEach((entry, i) => {
    const key = contentKey(entry);
    if (allowed[i] === true && !results.has(key) && !wanted.has(key)) wanted.set(key, entry);
  });
  const fetched = await inParallel([...wanted], FETCHES_AT_ONCE, async ([key, entry]) => {
    const left = leftMs();
    return { key, content: left > 0 ? await contentOf(deps, entry, left) : undefined };
  });
  for (const item of fetched) {
    if (typeof item.content === "string") {
      results.set(item.key, zero(item.content));
    } else if (
      item.content !== undefined &&
      leftMs() > 0 &&
      !judging.late &&
      judging.rejected === null
    ) {
      const scoring = await scorer.score(item.content, leftMs());
      if (scoring.kind === "scored") {
        results.set(item.key, scoring.score);
        judging.scored++;
      } else if (scoring.kind === "late") {
        judging.late = true;
      } else if (scoring.kind === "rejected") {
        judging.rejected = scoring.reason;
      }
      // `cut`: the stop line came while it was scored, and it has no score.
    }
    // Its score is all that is kept of it.
    item.content = undefined;
  }
  return batch.map((entry, i) =>
    allowed[i] === true ? results.get(contentKey(entry)) : zero(NOT_UPLOADED),
  );
}

/**
 * Whether the entrant of `entry`, of task `taskId`, may use what it revealed. Our own store keeps
 * results private until their task's reveals close, and revealing a hash that is in it does not
 * make the result yours: one of our own blob URIs counts only for bytes the entrant may use for
 * this task (`resultUploaded`, at the Judge's clock `nowNs`). That is asked before the store is
 * read; an upload may be for another task. Any other URI is the entrant's to name.
 */
async function mayUse(
  deps: JudgeDeps,
  taskId: bigint,
  entry: RevealedEntry,
  nowNs: bigint,
): Promise<boolean> {
  const ours = typeof ownBlobHash(deps.publicUrl, entry.uri) === "string";
  return !ours || (await deps.resultUploaded(entry.content_hash, taskId, entry.account, nowNs));
}

/**
 * The bytes at `entry`'s URI when they hash to its `content_hash`, or why there are none, or
 * `undefined` when the stop line cut the fetch short: it has the smaller of its own 10 s and
 * `leftMs`, the time left before the line, and stops where it is when that runs out (P05-R15).
 */
async function contentOf(
  deps: JudgeDeps,
  entry: RevealedEntry,
  leftMs: number,
): Promise<Uint8Array | string | undefined> {
  const timeoutMs = Math.min(FETCH_TIMEOUT_MS, leftMs);
  const fetched = await fetchEntryContent(deps, entry.uri, undefined, timeoutMs);
  if ("error" in fetched) {
    // Out of time before its own limit was: the line's doing, not the entry's.
    if (fetched.error === "timed out" && timeoutMs < FETCH_TIMEOUT_MS) return undefined;
    return `content unavailable: ${fetched.error}`;
  }
  // The hash of the exact bytes fetched, never of anything parsed from them.
  if (sha256Hex(fetched) !== entry.content_hash) return "content hash mismatch";
  return fetched;
}

/**
 * When judging `task` stops starting work, in nanoseconds: the pick deadline less a tenth of the
 * pick window, made 3 s when it is less and 30 s when it is more (P05-R13). A 10 s window, as the
 * local sandbox has, gets 3 s; a 600 s window gets 30 s.
 */
function stopLineOf(task: TaskView): bigint {
  const pick = BigInt(task.pick_deadline);
  // Bigints, which `Math.min` and `Math.max` do not take.
  let margin = (pick - BigInt(task.reveal_deadline)) / 10n;
  if (margin < MIN_MARGIN_NS) margin = MIN_MARGIN_NS;
  if (margin > MAX_MARGIN_NS) margin = MAX_MARGIN_NS;
  return pick - margin;
}

/**
 * Records that task `taskId` is not judged, with `reason` (`not judged: …`), and says nothing was
 * settled: no pick, so the task goes to its fallback window, which refunds it unless its poster
 * picks. The `WARN` (`why`) goes out once, on the first tick that finds it so: the reason in the
 * row is what later ticks compare with, as for a wait.
 */
async function notJudged(
  deps: JudgeDeps,
  taskId: bigint,
  reason: string,
  why: string,
): Promise<"skipped"> {
  const changed = await deps.db.query(
    `update tasks set judge_reason = $2
      where id = $1 and judge_status = 'accepted' and judge_reason is distinct from $2
      returning id`,
    [taskId, reason],
  );
  if (changed.length > 0) {
    const left = "it is not picked, and is left to its fallback window";
    console.warn(`judge: WARN task ${taskId}: ${why}; ${left}`);
  }
  return "skipped";
}

/**
 * Records that task `taskId` is never judged: `rejected`, with `reason`, when its criteria fail the
 * criteria check now (P05-R12) or cannot be compiled to score with (P05-R17), which is one `WARN`;
 * `failed_closed` when the documents the chain names cannot be used. Its fallback window applies.
 */
async function refuse(
  deps: JudgeDeps,
  taskId: bigint,
  status: "rejected" | "failed_closed",
  reason: string,
): Promise<"failed_closed"> {
  const changed = await deps.db.query(
    `update tasks set judge_status = $2, judge_reason = $3
      where id = $1 and judge_status = 'accepted'
      returning id`,
    [taskId, status, reason],
  );
  if (status === "rejected" && changed.length > 0) {
    console.warn(
      `judge: WARN task ${taskId}: rejected at judging, its criteria fail the criteria check now`,
    );
  }
  return "failed_closed";
}

/** The earlier commit first; in the same block, the smaller account, as `rankEntries` has it. */
function inCommitOrder(a: RevealedEntry, b: RevealedEntry): number {
  const blockA = BigInt(a.committed_at_block);
  const blockB = BigInt(b.committed_at_block);
  if (blockA !== blockB) return blockA < blockB ? -1 : 1;
  if (a.account !== b.account) return a.account < b.account ? -1 : 1;
  return 0;
}

/** What entries with the same content have in common: the content hash and the URI. */
function contentKey(entry: RevealedEntry): string {
  return JSON.stringify([entry.content_hash, entry.uri]);
}

/** A score of 0 that does not pass, whatever the pass mark: it cannot be paid. */
function zero(reason: string): EntryScore {
  return { score: 0, passed: false, reasons: [reason] };
}

function isRevealed(entry: EntryView): entry is RevealedEntry {
  return entry.content_hash !== null && entry.uri !== null;
}

/**
 * The task `task` waits for before it publishes its held-out checks, or `null`: the lowest id of
 * another task of `task`'s poster that commits to the same checks and still takes reveals at
 * `nowNs`. Judging `task` publishes the checks, and with them that task's answers, whoever its
 * verifier is and whatever intake made of it. Only the poster's own tasks count: anyone can post a
 * task with a commitment once it is on chain, and a stranger must not be able to stall this one.
 *
 * The wait never costs `task` its pick window (P05-R8). A sharing task counts only when its
 * reveals close by the middle of `task`'s pick window, which leaves the Judge half of the window at
 * least. One whose reveals close later is not waited for: `task` is judged, and the checks are
 * published while that task still takes reveals. Its poster did that, by reusing the checks, and
 * a poster must not be able to keep an accepted task from being picked, which would leave its
 * winners to the poster's fallback window. Nothing is waited for once the checks are public, after
 * a pick that failed say: there is nothing left to keep.
 */
async function sharingTaskStillRevealing(
  db: Db,
  task: TaskView,
  nowNs: bigint,
): Promise<string | null> {
  if (task.heldout_commitment === null) return null;
  const [blob] = await db.query<{ is_public: boolean }>(
    "select is_public from blobs where sha256 = $1",
    [task.heldout_commitment],
  );
  if (blob?.is_public === true) return null;
  const reveal = BigInt(task.reveal_deadline);
  const latest = reveal + (BigInt(task.pick_deadline) - reveal) / 2n;
  // Ids and deadlines are numeric: `min`, `<>`, `>` and `<=` compare them as numbers.
  const [row] = await db.query<{ id: string | null }>(
    `select min(id)::text as id from tasks
      where poster = $1 and heldout_commitment = $2 and id <> $3
        and reveal_deadline > $4 and reveal_deadline <= $5`,
    [task.poster, task.heldout_commitment, BigInt(task.id), nowNs, latest],
  );
  return row?.id ?? null;
}

/** How a waiting task's `judge_reason` starts. */
const WAITING = "waiting: ";

/**
 * Records that task `taskId` waits for task `sharing`, as its `judge_reason` (`waiting: held-out
 * checks shared with task {id}`), and says nothing was settled. The `WARN` goes out once, on the
 * tick the wait starts (or comes to another task), and not on every tick after it: the reason in
 * the row is what the next tick compares with.
 */
async function waitFor(deps: JudgeDeps, taskId: bigint, sharing: string): Promise<"skipped"> {
  const reason = `${WAITING}held-out checks shared with task ${sharing}`;
  const changed = await deps.db.query(
    `update tasks set judge_reason = $2
      where id = $1 and judge_status = 'accepted' and judge_reason is distinct from $2
      returning id`,
    [taskId, reason],
  );
  if (changed.length > 0) {
    const why = "it shares the held-out checks and still takes reveals";
    console.warn(`judge: WARN task ${taskId}: waiting for task ${sharing}: ${why}`);
  }
  return "skipped";
}

/** Clears the waiting reason of task `taskId`, as its judging goes on. */
async function stopWaiting(deps: JudgeDeps, taskId: bigint): Promise<void> {
  await deps.db.query(
    `update tasks set judge_reason = null
      where id = $1 and judge_status = 'accepted' and judge_reason like $2`,
    [taskId, `${WAITING}%`],
  );
}

/**
 * Clears the waiting reason of every accepted task of the Judge's that can no longer be judged at
 * `nowNs`: its pick deadline has passed, or it is settled. Judging clears the reason when a wait
 * ends, but a task the Judge did not get to in time, because it was not running when the wait
 * ended, would go on saying that it waits.
 */
export async function clearStaleWaits(deps: JudgeDeps, nowNs: bigint): Promise<void> {
  // Deadlines are numeric: `<=` compares them as numbers.
  await deps.db.query(
    `update tasks set judge_reason = null
      where verifier = $1 and judge_status = 'accepted' and judge_reason like $2
        and (pick_deadline <= $3 or outcome is not null)`,
    [deps.judgeAccount, `${WAITING}%`, nowNs],
  );
}

async function judgeRowOf(
  deps: JudgeDeps,
  taskId: bigint,
): Promise<{ judge_status: string | null; judge_reason: string | null } | undefined> {
  const [row] = await deps.db.query<{ judge_status: string | null; judge_reason: string | null }>(
    "select judge_status, judge_reason from tasks where id = $1",
    [taskId],
  );
  return row;
}

/** `fn` of each item, at most `limit` at a time, in the order of `items`. */
async function inParallel<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Logs why the task is left for the next tick, and says that nothing was settled. */
function retryLater(taskId: bigint, why: string): "skipped" {
  console.warn(`judge: WARN task ${taskId}: ${why}; trying again next tick`);
  return "skipped";
}

/** The contract's code on an error from the chain (`TenderError`), or `null`. */
function codeOf(error: unknown): string | null {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : null;
  return typeof code === "string" ? code : null;
}

/**
 * What a log line says about an error: its code, or else its name. Never its message, which can
 * name an RPC endpoint with a key in it, or quote what an entry wrote.
 */
export function describeError(error: unknown): string {
  return codeOf(error) ?? (error instanceof Error ? error.name : typeof error);
}
