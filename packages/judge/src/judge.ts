import { putBlob, setBlobPublic } from "@tender/db";
import { type EntryView, type Heldout, phaseOfTaskView, sha256Hex } from "@tender/shared";
import { fetchEntryContent, ownBlobHash } from "./fetch";
import { loadDocuments, type P0Criteria } from "./intake";
import type { HeldoutOf } from "./kinds/common";
import { scoreExact } from "./kinds/exact";
import { scoreJsonSchema } from "./kinds/json_schema";
import { scoreRegexCases } from "./kinds/regex_cases";
import { chooseWinners, rankEntries, type ScoredEntry } from "./rank";
import { buildScorecard } from "./scorecard";
import type { EntryScore, JudgeDeps } from "./types";

/** How many entries' contents are fetched at once. */
const FETCHES_AT_ONCE = 8;
const NS_PER_MS = 1_000_000n;

/** An entry that has revealed its content's hash and where the content is. */
type RevealedEntry = EntryView & { content_hash: string; uri: string };

/**
 * Judges task `taskId` and settles it with `pick`, once. What it came to:
 *
 * - `picked`: the winners are paid. `no_award`: nobody passed, and an empty `pick` refunded the
 *   task at once.
 * - `skipped`: nothing was settled. The task is not one to judge now: the chain has no such task,
 *   it is settled, it names another verifier, it is not in its judging window, or intake did not
 *   accept it. Or judging hit trouble of the Judge's own, which it logs as a `WARN` and leaves for
 *   the next tick: a scorer that could not run, a scorecard that could not be built, a `pick` that
 *   failed. `E_SETTLED` from `pick` means someone settled the task first, and is not logged.
 * - `failed_closed`: the criteria or held-out checks that the chain names cannot be read or used
 *   (they passed intake, so they are gone or changed). The task is never judged: its status
 *   becomes `failed_closed` with the reason, and the poster's fallback window applies.
 *
 * The task is read from the chain first, every time, so a `pick` that landed before a crash shows
 * as an outcome and nothing is done again. It must be in `judging` both by `deps.now` and by the
 * final block the chain answered from, which is after every reveal that can land.
 *
 * Each revealed entry's content is fetched (`fetchEntryContent`) and must hash to the entry's
 * `content_hash`; one of our own blob URIs counts only when `deps.resultUploaded` says the entrant
 * uploaded it for this task. One that cannot be fetched or does not count (`content unavailable:
 * …`), or that does not match (`content hash mismatch`), scores 0 and never passes, whatever the
 * pass mark, so it cannot be paid. The rest are scored by `scoreEntry`; a scorer that throws
 * scores that entry 0 (`scoring failed`). Then the entries are ranked, the winners chosen, and the
 * scorecard built from exactly the winners `pick` is sent. The scorecard is stored as a public
 * blob, the held-out checks are made public, and `pick` is called with the scorecard's hash and
 * URI, in that order, so that the pick never points at something that cannot be read. A retry
 * stores the same scorecard again unless the clock moved: its bytes depend on the entries and
 * `generated_at` only.
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
  if ((await judgeStatusOf(deps, taskId)) !== "accepted") return "skipped";

  const loaded = await loadDocuments(deps.db, task, {
    teamAccounts: deps.teamAccounts,
    nowNs,
    waitForHeldout: false,
  });
  if (!loaded.ok) {
    await deps.db.query(
      `update tasks set judge_status = 'failed_closed', judge_reason = $2
        where id = $1 and judge_status = 'accepted'`,
      [taskId, loaded.reason],
    );
    return "failed_closed";
  }
  const { criteria, heldout } = loaded.documents;

  const revealed = (await deps.client.getAllEntries(taskId)).filter(isRevealed);
  const fetched = await inParallel(revealed, FETCHES_AT_ONCE, async (entry) => ({
    entry,
    content: await contentOf(deps, taskId, entry),
  }));
  const scored: ScoredEntry[] = [];
  // One entry at a time: the regex sandbox runs on this thread.
  for (const { entry, content } of fetched) {
    let score: EntryScore;
    try {
      score = await scoreContent(criteria, heldout, content);
    } catch (error) {
      return retryLater(taskId, `a scorer could not be run (${describeError(error)})`);
    }
    scored.push({
      account: entry.account,
      contentHash: entry.content_hash,
      uri: entry.uri,
      committedAtBlock: BigInt(entry.committed_at_block),
      ...score,
    });
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
 * The scorer could not be run at all, such as the regex sandbox when its engine cannot be
 * loaded. That is the Judge's trouble and not the entry's, so the task is judged again on a later
 * tick, and no entry is scored 0 for it.
 */
export class ScorerUnavailableError extends Error {
  override name = "ScorerUnavailableError";
}

/** What `scoreEntry` scores: an entry's content, against the task's checked documents. */
export interface ScoreInput {
  criteria: P0Criteria;
  /** The held-out document as parsed from its bytes, or `null` when the task has none. */
  heldout: Heldout | null;
  /** The bytes the entry revealed, already checked against its `content_hash`. */
  content: Uint8Array;
}

/**
 * Scores one entry by the kind of its task's criteria. Every scorer the Judge runs is called from
 * here and nowhere else, so that running them apart, in a worker with a hard time limit, is a
 * change to this one function.
 *
 * It resolves with the entry's score whatever the content is. It rejects with
 * `ScorerUnavailableError` when the scorer cannot be run at all, and with whatever else a scorer
 * throws, which the caller scores 0 for that entry alone.
 */
export async function scoreEntry(input: ScoreInput): Promise<EntryScore> {
  const { criteria: c, heldout, content } = input;
  switch (c.kind) {
    case "exact":
      return scoreExact(c, heldoutPart(heldout, "exact"), content);
    case "json_schema":
      return scoreJsonSchema(c, heldoutPart(heldout, "json_schema"), content);
    case "regex_cases": {
      const cases = heldout === null ? null : heldoutPart(heldout, "regex_cases");
      try {
        return await scoreRegexCases(c, cases, content);
      } catch (error) {
        // It rejects only when the sandbox cannot be started.
        throw new ScorerUnavailableError("the regex sandbox could not be started", {
          cause: error,
        });
      }
    }
  }
}

/**
 * The part of `heldout` for `kind`. Intake checked that the document is of the criteria's kind,
 * and that `exact` and `json_schema` have one, so a missing part is a slip of the Judge's own.
 */
function heldoutPart<K extends "exact" | "json_schema" | "regex_cases">(
  heldout: Heldout | null,
  kind: K,
): HeldoutOf<K> {
  if (heldout === null || !Object.hasOwn(heldout, kind)) {
    throw new ScorerUnavailableError(`the held-out checks have no ${kind} part`);
  }
  return (heldout as unknown as Record<K, HeldoutOf<K>>)[kind];
}

/**
 * The score of one entry, from its content or from the reason it has none. Content that could not
 * be fetched or checked scores 0 and does not pass. A scorer that throws scores the entry 0; a
 * scorer that cannot run rejects, with `ScorerUnavailableError`.
 */
async function scoreContent(
  criteria: P0Criteria,
  heldout: Heldout | null,
  content: Uint8Array | string,
): Promise<EntryScore> {
  if (typeof content === "string") return { score: 0, passed: false, reasons: [content] };
  try {
    return await scoreEntry({ criteria, heldout, content });
  } catch (error) {
    if (error instanceof ScorerUnavailableError) throw error;
    return { score: 0, passed: false, reasons: ["scoring failed"] };
  }
}

/** The bytes that `entry` of task `taskId` revealed, or the reason the Judge has none to score. */
async function contentOf(
  deps: JudgeDeps,
  taskId: bigint,
  entry: RevealedEntry,
): Promise<Uint8Array | string> {
  // Our own store keeps results private until their task's reveals close. Revealing a hash that
  // is in it does not make the result yours: only bytes the entrant uploaded for this task count.
  // The record is asked first, before the store is read; it may be for another task.
  const ours = typeof ownBlobHash(deps.publicUrl, entry.uri) === "string";
  if (ours && !(await deps.resultUploaded(entry.content_hash, taskId, entry.account))) {
    return "content unavailable: not uploaded for this task";
  }
  const fetched = await fetchEntryContent(deps, entry.uri);
  if ("error" in fetched) return `content unavailable: ${fetched.error}`;
  // The hash of the exact bytes fetched, never of anything parsed from them.
  if (sha256Hex(fetched) !== entry.content_hash) return "content hash mismatch";
  return fetched;
}

function isRevealed(entry: EntryView): entry is RevealedEntry {
  return entry.content_hash !== null && entry.uri !== null;
}

async function judgeStatusOf(deps: JudgeDeps, taskId: bigint): Promise<string | null | undefined> {
  const [row] = await deps.db.query<{ judge_status: string | null }>(
    "select judge_status from tasks where id = $1",
    [taskId],
  );
  return row?.judge_status;
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
