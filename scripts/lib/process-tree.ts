import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The processes a script started, found by the tree of parents and children and not by name, so that
 * the end of a script can kill exactly what it started and nothing else. The table of processes is
 * read with `ps`, or, on a host that has none (a slim Linux container), from `/proc`.
 */

/** One process of the table: its id and its parent's. */
export interface ProcessRow {
  pid: number;
  ppid: number;
}

/**
 * Reads the table of processes, or returns undefined if it cannot. A lister leaves out its own
 * process, if it has one (the `ps` it runs), since that one is gone by the time the table is read.
 */
export type ProcessLister = () => ProcessRow[] | undefined;

/** How long `ps` may take: a stuck one must not hold up the end of a script. */
const PS_MS = 5_000;

/** The part of `spawnSync` that `listWithPs` uses, so that a test can stand in for it. */
export type RunSync = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; stdio: ["ignore", "pipe", "ignore"]; timeout: number },
) => Pick<SpawnSyncReturns<string>, "pid" | "status" | "stdout" | "error">;

/** The rows in the text of `ps -o pid=,ppid=`: two numbers to a line. Anything else is skipped. */
function parseTable(text: string): ProcessRow[] {
  return text.split("\n").flatMap((line) => {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    return pid === undefined || ppid === undefined || Number.isNaN(pid) || Number.isNaN(ppid)
      ? []
      : [{ pid, ppid }];
  });
}

/**
 * The table from `ps -A`. It is undefined if `ps` cannot be run (it is not installed: the error is
 * ENOENT), fails, or does not answer in time.
 */
export function listWithPs(run: RunSync = spawnSync): ProcessRow[] | undefined {
  const listing = run("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PS_MS,
  });
  if (listing.error !== undefined || listing.status !== 0) return undefined;
  // `ps` is a child of this process too, and has exited by now.
  return parseTable(listing.stdout).filter((row) => row.pid !== listing.pid);
}

/**
 * The parent's id in the text of a `/proc/<pid>/stat` file: `pid (command) state ppid …`. The
 * command is whatever the program is called, spaces and brackets included, so the fields are those
 * after its last `)`.
 */
export function parentOfStat(stat: string): number | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const [, ppid] = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  return ppid !== undefined && /^[0-9]+$/.test(ppid) ? Number(ppid) : undefined;
}

/**
 * The table from `/proc` (`procDir`): a directory for each process, named by its id, holding a
 * `stat` file. It is undefined if `procDir` cannot be read, which is so on macOS. A process that
 * ends while the table is read, or that is not ours to look at, is left out.
 */
export function listFromProc(procDir = "/proc"): ProcessRow[] | undefined {
  let names: string[];
  try {
    names = readdirSync(procDir);
  } catch {
    return undefined;
  }
  const rows: ProcessRow[] = [];
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(join(procDir, name, "stat"), "utf8");
    } catch {
      continue;
    }
    const ppid = parentOfStat(stat);
    if (ppid !== undefined) rows.push({ pid: Number(name), ppid });
  }
  return rows;
}

/** The two ways to read the table, in the order they are tried. A test can replace either. */
export interface ProcessSources {
  ps: ProcessLister;
  proc: ProcessLister;
}

/**
 * The table of processes: from `ps`, or, if `ps` gives none (not installed, as in a slim Linux
 * container; or failing), from `/proc`. It is undefined where neither works, such as macOS without
 * `ps`, and the caller then has nothing to go by.
 */
export function listProcesses(
  sources: ProcessSources = { ps: listWithPs, proc: listFromProc },
): ProcessRow[] | undefined {
  return sources.ps() ?? sources.proc();
}

/**
 * The ids of every process below `root` in `rows`: its children, their children, and so on. Not
 * `root` itself, and nothing that is not in its tree, whatever its name.
 */
export function descendantsOf(rows: readonly ProcessRow[], root: number): number[] {
  const seen = new Set<number>([root]);
  const found: number[] = [];
  const parents = [root];
  for (let parent = parents.pop(); parent !== undefined; parent = parents.pop()) {
    for (const row of rows) {
      if (row.ppid !== parent || seen.has(row.pid)) continue;
      seen.add(row.pid);
      found.push(row.pid);
      parents.push(row.pid);
    }
  }
  return found;
}

/** What `killStartedProcesses` needs, besides what to kill. A test replaces them. */
export interface KillOptions {
  /** The process whose descendants are killed. Defaults to this process. */
  root?: number;
  /** Reads the table of processes. Defaults to `listProcesses`. */
  list?: ProcessLister;
  /** Sends the signal. Defaults to `process.kill`. */
  kill?: (pid: number, signal: "SIGKILL") => void;
}

/**
 * Kills, each by its process id, every process still running below `root` (this process, unless
 * told): the children, their children, and so on. Nothing else is touched: the ids are those of the
 * tree, taken from one table before the first kill, and no name is matched. It is for the end of a
 * process, where nothing can be waited for, and does nothing where the table cannot be read.
 * Returns the ids it sent the signal to.
 */
export function killStartedProcesses(options: KillOptions = {}): number[] {
  const {
    root = process.pid,
    list = listProcesses,
    kill = (pid, signal) => process.kill(pid, signal),
  } = options;
  const rows = list();
  if (rows === undefined) return [];
  const started = descendantsOf(rows, root);
  for (const pid of started) {
    try {
      kill(pid, "SIGKILL");
    } catch {
      // It has gone already.
    }
  }
  return started;
}
