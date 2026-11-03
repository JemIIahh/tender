import type { TaskDetail } from "@tender/shared";

// What the web app knows of the Tender Judge: whether a task is waiting on its verdict, and (in
// `components/JudgeNote`) what its status words mean. The Judge's account is `config.judgeAccount`;
// the pages that need it take it as a prop, so that a test can give its own.

/** How often a task page asks again while the Judge has not said what it makes of the task. */
export const JUDGE_POLL_MS = 5_000;

/**
 * How long after a task is created the page keeps asking. The Judge stops waiting for the held-out
 * checks at 10 minutes (and then rejects the task), so by 15 minutes there is a verdict or the
 * Judge is not running, and asking more would be asking for nothing.
 */
export const JUDGE_POLL_WINDOW_NS = 15n * 60n * 1_000_000_000n;

/** Whether `account` is the Tender Judge, by the account this build knows. */
export function isJudgeAccount(account: string, judgeAccount: string | null): boolean {
  return judgeAccount !== null && account === judgeAccount;
}

/**
 * Whether the Judge's verdict on `task` is still to come, so that a page showing it should ask
 * again: the Judge is the verifier, the task has no outcome, the Judge has said nothing yet or only
 * "pending", and the task is not older than `JUDGE_POLL_WINDOW_NS`.
 *
 * Intake writes `judge_status` to the database and logs no chain event, so the event stream does
 * not say when it changes. And most tasks go from nothing straight to `accepted` or `rejected`:
 * "pending" is only while the held-out checks are missing. Asking again on "pending" alone would
 * miss the refusal a poster most needs to see.
 */
export function awaitsJudge(
  task: Pick<TaskDetail, "verifier" | "outcome" | "judge_status" | "created_at">,
  judgeAccount: string | null,
  nowNs: bigint,
): boolean {
  return (
    isJudgeAccount(task.verifier, judgeAccount) &&
    task.outcome === null &&
    (task.judge_status === null || task.judge_status === "pending") &&
    nowNs < BigInt(task.created_at) + JUDGE_POLL_WINDOW_NS
  );
}
