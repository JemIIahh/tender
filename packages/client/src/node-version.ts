import { writeSync } from "node:fs";

// The Node that Tender's commands run on. An older Node installs Tender (unless `engine-strict`
// stops it) and starts its commands, which then fail far from the cause: `pnpm demo:local` on Node
// 22 runs for a minute and fails at the Judge. So each command checks first, and says so in one line.

/** The oldest Node that Tender runs on, as `engines.node` in the root `package.json` has it. */
export const MIN_NODE_VERSION = "24.21.0";

/** The numbers of a version, `v24.21.0` or `24.21.0`; a part that is missing or not a number is 0. */
function partsOf(version: string): number[] {
  return version
    .replace(/^v/, "")
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

/**
 * What is wrong with `version` for Tender, in one line, or undefined if it is `MIN_NODE_VERSION` or
 * newer. `version` is `process.version` unless given.
 */
export function nodeVersionProblem(version: string = process.version): string | undefined {
  const have = partsOf(version);
  const need = partsOf(MIN_NODE_VERSION);
  for (let at = 0; at < need.length; at++) {
    const a = have[at] ?? 0;
    const b = need[at] ?? 0;
    if (a > b) return undefined;
    if (a < b) return `Tender needs Node ${need[0]}.${need[1]} or newer; this is ${version}`;
  }
  return undefined;
}

/**
 * Ends the process with exit code 1, and the problem on stderr, if this Node is older than
 * `MIN_NODE_VERSION`. A command calls it before it does anything else. The line is written at once
 * (`writeSync`): stderr to a pipe is not, on macOS, and the exit would cut it.
 */
export function requireNodeVersion(): void {
  const problem = nodeVersionProblem();
  if (problem === undefined) return;
  writeSync(2, `${problem}\n`);
  process.exit(1);
}
