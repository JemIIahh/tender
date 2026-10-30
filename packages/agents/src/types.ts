import type { Brief, PublicCriteria, TaskDetail } from "@tender/shared";

/**
 * What a solver is told about a task: the task as the index shows it (with the hashes and the
 * deadlines the chain holds), the brief it points at, and the public half of its criteria. Both
 * documents are the ones the API served for the task's hashes, so they are the posted ones.
 */
export interface TaskContext {
  task: TaskDetail;
  brief: Brief;
  criteria: PublicCriteria;
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
   * "Honesty"), so a solver says so about itself and a caller does not have to remember.
   */
  scripted: boolean;
  /**
   * The bytes to enter `ctx.task` with, or null when the solver has no answer to give: it does not
   * know the task, or its own answer failed the shape the brief asks for. The runner then leaves
   * the task alone for the rest of the run and commits nothing. An answer is committed to as it
   * is, so a solver checks its output before it returns it. A solver that throws is treated as one
   * that returned null, and the error is logged.
   */
  solve(ctx: TaskContext): Promise<Uint8Array | null>;
}
