import { type Db, putBlob, setBlobPublic } from "@tender/db";
import { type EntryView, phaseOfTaskView, sha256Hex, type TaskView } from "@tender/shared";
import { fetchEntryContent, ownBlobHash } from "./fetch";
import { loadDocuments } from "./intake";
import { openTaskScorer, type TaskScorer } from "./isolate";
import { chooseWinners, rankEntries, type ScoredEntry } from "./rank";
import { ScorerUnavailableError } from "./score";
import { buildScorecard } from "./scorecard";
import type { EntryScore, JudgeDeps } from "./types";

/** How many entries are taken at a time: no more contents than this are held at once. */
const ENTRIES_PER_BATCH = 32;
/** How many entries' contents are fetched at once. */
const FETCHES_AT_ONCE = 8;
/** The least time judging leaves before the pick deadline: it starts nothing new after that. */
const MIN_MARGIN_NS = 30n * 1_000_000_000n;
const NS_PER_MS = 1_000_000n;
const NOT_SCORED = "not scored before the pick deadline";
const NOT_UPLOADED = "content unavailable: not uploaded for this task";

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
 *   `E_SETTLED` from `pick` means someone settled the task first, and is not logged.
 * - `failed_closed`: the task is never judged, and the poster's fallback window applies. Either
 *   its criteria fail the criteria check now (P05-R12: the check intake runs, run again before
 *   any entry is scored, as a rule may be newer than the task's intake), and its status becomes
 *   `rejected` with the reason and one `WARN`. Or the criteria or held-out checks that the chain
 *   names cannot be read or used (they passed intake, so they are gone or changed), and its
 *   status becomes `failed_closed` with the reason.
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
 * (`openTaskScorer`), with at most 5 s for each: an entry whose scoring times out, runs out of
 * memory or crashes the worker scores 0 with the reason why, and the other entries are scored as
 * usual. In what order the entries are fetched and scored, and which are left unscored so that
 * the pick lands before the pick deadline, is `judgeEntries`'s. Then the entries are ranked, the
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

  const loaded = await loadDocuments(deps.db, task, {
    teamAccounts: deps.teamAccounts,
    nowNs,
    waitForHeldout: false,
    compileBudgetMs: deps.scoringLimits?.compileBudgetMs,
  });
  if (!loaded.ok) {
    // P05-R12: criteria that fail the check intake runs, run again now, are refused as intake
    // would refuse them today, and not scored. Anything else means the documents cannot be used.
    const status = loaded.criteriaCheck === true ? "rejected" : "failed_closed";
    const changed = await deps.db.query(
      `update tasks set judge_status = $2, judge_reason = $3
        where id = $1 and judge_status = 'accepted'
        returning id`,
      [taskId, status, loaded.reason],
    );
    if (status === "rejected" && changed.length > 0) {
      console.warn(
        `judge: WARN task ${taskId}: rejected at judging, its criteria fail the criteria check now`,
      );
    }
    return "failed_closed";
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
      onCrash: (error) => {
        console.warn(
          `judge: WARN task ${taskId}: scoring an entry failed (${describeError(error)})`,
        );
      },
    },
  );
  let scored: ScoredEntry[];
  try {
    scored = await judgeEntries(deps, task, revealed, scorer, nowNs);
  } catch (error) {
    if (!(error instanceof ScorerUnavailableError)) throw error;
    return retryLater(taskId, `a scorer could not be run (${describeError(error)})`);
  } finally {
    await scorer.close();
  }

  const ranked = rankEntries(scored);
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

/**
 * The scores of task `task`'s revealed `entries`, one for each, for `judgeTask` to rank.
 *
 * The entries are taken in commit order, the earliest committed first (within a block by account,
 * as the ranking breaks a tie), 32 at a time. A batch's contents are fetched 8 at a time and then
 * scored one after another by `scorer`, and each is let go once it is scored: no more than 32 are
 * held at once, and only their scores are kept, so memory stays bounded however many entries the
 * task has (`max_entries` 0 sets no limit). Entries with the same URI and content hash share one
 * fetch and one score. Whether an entrant may use one of our own blobs (`resultUploaded`, asked at
 * the Judge's clock `nowNs`) is asked of each entry all the same: it is the entrant's, not the
 * content's.
 *
 * No fetch and no score starts once the clock reaches the stop line: the pick deadline less the
 * larger of 30 s and a tenth of the pick window (from the reveal deadline to the pick deadline),
 * which leaves time for the work in flight and for the pick. The line is drawn from the task's own
 * deadlines, as P05-R8's wait can leave judging only the second half of the window. An entry not
 * scored by then scores 0 and does not pass, and the scorecard says why: `not scored before the
 * pick deadline`.
 *
 * It throws what `resultUploaded` and the database throw, and `ScorerUnavailableError`.
 */
async function judgeEntries(
  deps: JudgeDeps,
  task: TaskView,
  entries: readonly RevealedEntry[],
  scorer: TaskScorer,
  nowNs: bigint,
): Promise<ScoredEntry[]> {
  const clock = deps.now ?? (() => new Date());
  const stopLine = stopLineOf(task);
  const inTime = () => BigInt(clock().getTime()) * NS_PER_MS < stopLine;
  // The score of each content scored so far, by `contentKey`.
  const results = new Map<string, EntryScore>();
  const ordered = entries.toSorted(inCommitOrder);
  const scored: ScoredEntry[] = [];
  for (let first = 0; first < ordered.length; first += ENTRIES_PER_BATCH) {
    const batch = ordered.slice(first, first + ENTRIES_PER_BATCH);
    const scores = inTime()
      ? await judgeBatch(deps, BigInt(task.id), batch, scorer, results, inTime, nowNs)
      : [];
    batch.forEach((entry, i) => {
      scored.push({
        account: entry.account,
        contentHash: entry.content_hash,
        uri: entry.uri,
        committedAtBlock: BigInt(entry.committed_at_block),
        ...(scores[i] ?? zero(NOT_SCORED)),
      });
    });
  }
  return scored;
}

/**
 * The scores of one batch of entries of task `taskId`, `undefined` for each that was not scored in
 * time. `results` has the score of each content scored before, and gets those of this batch.
 */
async function judgeBatch(
  deps: JudgeDeps,
  taskId: bigint,
  batch: readonly RevealedEntry[],
  scorer: TaskScorer,
  results: Map<string, EntryScore>,
  inTime: () => boolean,
  nowNs: bigint,
): Promise<(EntryScore | undefined)[]> {
  const allowed = await inParallel(batch, FETCHES_AT_ONCE, (entry) =>
    mayUse(deps, taskId, entry, nowNs),
  );
  // The contents that this batch is the first to need, each once.
  const wanted = new Map<string, RevealedEntry>();
  batch.forEach((entry, i) => {
    const key = contentKey(entry);
    if (allowed[i] === true && !results.has(key) && !wanted.has(key)) wanted.set(key, entry);
  });
  const fetched = await inParallel([...wanted], FETCHES_AT_ONCE, async ([key, entry]) => ({
    key,
    content: inTime() ? await contentOf(deps, entry) : undefined,
  }));
  for (const item of fetched) {
    if (typeof item.content === "string") results.set(item.key, zero(item.content));
    else if (item.content !== undefined && inTime()) {
      results.set(item.key, await scorer.score(item.content));
    }
    // The score is all that is kept of it.
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

/** The bytes at `entry`'s URI when they hash to its `content_hash`, or why there are none. */
async function contentOf(deps: JudgeDeps, entry: RevealedEntry): Promise<Uint8Array | string> {
  const fetched = await fetchEntryContent(deps, entry.uri);
  if ("error" in fetched) return `content unavailable: ${fetched.error}`;
  // The hash of the exact bytes fetched, never of anything parsed from them.
  if (sha256Hex(fetched) !== entry.content_hash) return "content hash mismatch";
  return fetched;
}

/**
 * When judging `task` stops starting work, in nanoseconds: the pick deadline less the larger of
 * 30 s and a tenth of the pick window.
 */
function stopLineOf(task: TaskView): bigint {
  const pick = BigInt(task.pick_deadline);
  // Bigints, which `Math.max` does not take.
  let margin = (pick - BigInt(task.reveal_deadline)) / 10n;
  if (margin < MIN_MARGIN_NS) margin = MIN_MARGIN_NS;
  return pick - margin;
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
