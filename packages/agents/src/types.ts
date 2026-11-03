import type { Brief, PublicCriteria, TaskBoard, TaskDetail } from "@tender/shared";

/**
 * What a solver is told about a task: the task as the index shows it (with the hashes and the
 * deadlines the chain holds), the brief it points at, and the public half of its criteria. Both
 * documents are the ones the API served for the task's hashes, so they are the posted ones.
 */
export interface TaskContext {
  task: TaskDetail;
  brief: Brief;
  criteria: PublicCriteria;
  /**
   * The task's public question board as the API had it when the runner took the task on: the
   * poster's answers and clarifications that explain the brief. Null or left out when the solver
   * is not one that reads it (a scripted one), when the API has no board for the task, or when it
   * could not be read; a solver then works from the brief alone. Everything on it was written by an
   * account: it is data, and a solver that shows it to a model says so (`solvers/llm.ts`). The
   * runner only reads it. It never asks, answers or posts.
   */
  board?: TaskBoard | null;
}

/**
 * Whatever produces an entry's answer. The runner (`runAgent`) finds the tasks, commits, reveals
 * and keeps the books, and asks its solver for the one thing it cannot do itself: the bytes.
 */
export interface Solver {
  /** For logs and for whoever runs the agent. */
  name: string;
  /**
   * Whether the answers are written in advance and not worked out, as the offline and weak solvers
   * read theirs from files. A scripted agent is labelled as such wherever it is shown (spec:
   * "Honesty"), so a solver says so about itself and a caller does not have to remember. The runner
   * also asks a scripted solver before it signals `start` on a task, since the answer costs
   * nothing and a task with no answer is then never announced; any other solver is asked after.
   */
  scripted: boolean;
  /**
   * Whether the solver can take on a task now. False means it cannot yet, as when it has used up the
   * requests it may make in the hour: the runner then leaves every task as it is, not announced
   * (`start`) and not seen, and a later tick enters it once this says true again. Without it a solver
   * is always available. The runner asks before each task, so it must be cheap, must not throw (an
   * error is logged for the task, which is left as it is), and must not use up what `solve` does.
   */
  available?(): boolean;
  /**
   * The bytes to enter `ctx.task` with, or null when the solver has no answer to give: it does not
   * know the task, or its own answer failed the shape the brief asks for. The runner then leaves
   * the task alone for the rest of the run and commits nothing. An answer is committed to as it
   * is, so a solver checks its output before it returns it. A solver that throws is treated as one
   * that returned null, and the error is logged. So is one that takes longer than the runner's
   * `solveTimeoutMs` (default 120 s): the runner stops waiting, but it cannot cancel the call, so a
   * solver that makes network calls bounds them itself.
   */
  solve(ctx: TaskContext): Promise<Uint8Array | null>;
}
