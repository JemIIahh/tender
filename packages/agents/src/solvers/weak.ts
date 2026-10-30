import type { Solver } from "../types";
import { createSeedSolver } from "./offline";

/**
 * The solver that is meant to lose: it answers a task whose brief is one of `seedsDir`'s with that
 * seed's `weak.txt`, a plausible answer that misses the pass mark or scores below the solution,
 * and any other task, and a seed with no `weak.txt`, with null. It is what the second demo agent
 * enters with, so that the scorecard has a runner-up. `scripted`.
 */
export function createWeakSolver(seedsDir: string): Solver {
  return createSeedSolver({ name: "weak", seedsDir, file: "weak.txt" });
}
