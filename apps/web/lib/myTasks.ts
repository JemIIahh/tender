import type { TaskSummary } from "@tender/shared";
import { type Posted, readTaskPages } from "./account";
import { phaseOfTask } from "./phase";

// My tasks: the tasks a connected account posted, the ones it has to pick, and the hires it made of
// a service. Every row is the API's (`GET /v1/tasks` with `poster`, `verifier`, `phase` or `hire`),
// and its phase and next step are worked out by the clock, as the task's page works them out.

/**
 * What the account can do next on a task, by the contract's rules (docs/ARCHITECTURE.md, "A task's
 * life"), or nothing:
 *
 * - `pick`: the account picks the winners now: as the verifier in the judge window, or as the
 *   poster in the fallback window, when the verifier has not picked. Only revealed entries can win,
 *   so a task with none has no pick.
 * - `refund`: the task can be voided and its reward sent back to its funders, which anyone may do:
 *   once every window is past, or once the reveal window has closed with nothing revealed.
 * - `top-up`: the reward can still be raised, while entries are open (`top_up_task`).
 */
export type NextStep = "pick" | "refund" | "top-up";

/** The next step `account` can take on `task` at `nowNs`, or null when there is none. */
export function nextStep(task: TaskSummary, account: string, nowNs: bigint): NextStep | null {
  const phase = phaseOfTask(task, nowNs);
  switch (phase) {
    case "open":
      return "top-up";
    case "judging":
    case "fallback": {
      if (task.reveal_count === 0) return "refund";
      const picker = phase === "judging" ? task.verifier : task.poster;
      return picker === account ? "pick" : null;
    }
    case "expired":
      return "refund";
    default:
      return null;
  }
}

/** When the window the account picks in closes: the pick deadline, or the fallback deadline. */
function pickDueNs(task: TaskSummary, nowNs: bigint): bigint {
  return BigInt(
    phaseOfTask(task, nowNs) === "judging" ? task.pick_deadline : task.fallback_deadline,
  );
}

/**
 * The tasks `account` can pick now, the one whose window closes first at the top: those it verifies
 * that are in the judge window, and those it posted that are in the fallback window, as the API
 * lists them, kept only if the clock still says the account can pick (`nextStep`).
 */
export async function readToPick(
  account: string,
  nowNs: () => bigint,
  wanted: () => boolean = () => true,
): Promise<Posted | null> {
  const [verifies, posted] = await Promise.all([
    readTaskPages({ verifier: account, phase: "judging" }, wanted),
    readTaskPages({ poster: account, phase: "fallback" }, wanted),
  ]);
  if (verifies === null || posted === null || !wanted()) return null;
  const now = nowNs();
  const byId = new Map<string, TaskSummary>();
  for (const task of [...verifies.tasks, ...posted.tasks]) byId.set(task.id, task);
  const tasks = [...byId.values()]
    .filter((task) => nextStep(task, account, now) === "pick")
    .sort((a, b) => {
      const left = pickDueNs(a, now);
      const right = pickDueNs(b, now);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  return { tasks, truncated: verifies.truncated || posted.truncated };
}

/** The hires `account` made of a service (`GET /v1/tasks?poster=&hire=true`), newest first. */
export function readHires(
  account: string,
  wanted: () => boolean = () => true,
): Promise<Posted | null> {
  return readTaskPages({ poster: account, hire: true }, wanted);
}
