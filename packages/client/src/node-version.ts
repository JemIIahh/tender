import { writeSync } from "node:fs";

// The Node that Tender's commands run on. An older Node installs Tender (unless `engine-strict`
// stops it) and starts its commands, which then fail far from the cause: `pnpm demo:local` on Node
// 22 runs for a minute and fails at the Judge. So each command checks first, and says so in one line.
//
// The rule is `engines.node` of the root `package.json`, `^24.21.0 || >=26`: Node 24 from 24.21 on,
// or Node 26 and newer. Node 25 is out because some test dependencies (vitest, jsdom) leave it out of
// their own `engines`, and `engine-strict` stops the install on it.

/** `engines.node` of the root `package.json`, which `nodeVersionProblem` holds a version to. */
export const NODE_ENGINES = "^24.21.0 || >=26";

/** The rule in words, for the line that refuses a Node. */
export const NODE_RULE = "Node 24.21 or a later 24, or Node 26 and newer";

/** The numbers of a version, `v24.21.0` or `24.21.0`; a part that is missing or not a number is 0. */
function partsOf(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/, "")
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

/** Whether `version` meets `NODE_ENGINES`: 24.21.0 up to the last 24, or 26.0.0 and up. */
export function nodeVersionOk(version: string): boolean {
  const [major, minor] = partsOf(version);
  return (major === 24 && minor >= 21) || major >= 26;
}

/**
 * What is wrong with `version` for Tender, in one line, or undefined if it meets `NODE_ENGINES`.
 * `version` is `process.version` unless given.
 */
export function nodeVersionProblem(version: string = process.version): string | undefined {
  return nodeVersionOk(version) ? undefined : `Tender needs ${NODE_RULE}; this is ${version}`;
}

/**
 * Ends the process with exit code 1, and the problem on stderr, if this Node does not meet
 * `NODE_ENGINES`. A command calls it before it does anything else. The line is written at once
 * (`writeSync`): stderr to a pipe is not, on macOS, and the exit would cut it.
 */
export function requireNodeVersion(): void {
  const problem = nodeVersionProblem();
  if (problem === undefined) return;
  writeSync(2, `${problem}\n`);
  process.exit(1);
}
