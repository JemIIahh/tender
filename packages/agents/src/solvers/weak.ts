import type { Solver } from "../types";
import { createSeedSolver } from "./offline";

/**
 * The solver that is meant to lose: it answers a task whose brief is one of `seedsDir`'s with that
 * seed's `weak.txt`, a plausible answer that misses the pass mark or scores below the solution,
 * and any other task, and a seed with no `weak.txt`, with null. The real seeds keep theirs in
 * `privateDir`, which is looked in first, and the demo tasks in their own folders. It is what the
 * second demo agent enters with, so that the scorecard has a runner-up. `scripted`.
 */
export function createWeakSolver(seedsDir: string, privateDir?: string): Solver {
  return createSeedSolver({
    name: "weak",
    seedsDir,
    file: "weak.txt",
    ...(privateDir === undefined ? {} : { privateDir }),
  });
}
