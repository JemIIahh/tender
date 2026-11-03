import { spawnSync } from "node:child_process";

// What the chain suite needs to know about processes, to leave none behind. A near-sandbox node
// that a test left running once spent four days at full CPU on the owner's machine, so the stop of
// the suite does not rest on the hope that every owner of a process got to stop it: it looks at
// the process table and ends what belongs to the run. It ends a process only by its own pid, and
// only one that is the run's: a child or a grandchild of this process.

/** One row of `ps`. */
export interface Proc {
  pid: number;
  ppid: number;
  /**
   * When the process started, as `ps` prints it. A pid and a start time name one process: the
   * system gives a pid to another process once the first has gone, but not at the same second.
   */
  started: string;
  /** The whole command line, as `ps` prints it. A process can rename itself, so it is not an id. */
  command: string;
}

const PS_MS = 5_000;
/** A row of `ps -o pid=,ppid=,lstart=,command=`: `lstart` is like `Mon Nov  3 14:05:09 2026`. */
const ROW = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;
/** How often `terminate` looks to see whether a process has gone. */
const POLL_MS = 100;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Every process on the machine. Throws where `ps` cannot be run, since a stop that cannot see the
 * processes has to say so and not take it for a clean machine.
 */
export function listProcesses(): Proc[] {
  const listing = spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,lstart=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PS_MS,
    maxBuffer: 64 * 1024 * 1024,
    // The start time is spelt the same way whatever the language of the machine.
    env: { ...process.env, LC_ALL: "C" },
  });
  if (listing.error !== undefined || listing.status !== 0) {
    const why =
      listing.error?.message ?? (listing.stderr.trim() || `exit status ${listing.status}`);
    throw new Error(`cannot list the processes with ps: ${why}`);
  }
  const rows: Proc[] = [];
  for (const line of listing.stdout.split("\n")) {
    const fields = ROW.exec(line);
    if (fields === null) continue;
    rows.push({
      pid: Number(fields[1]),
      ppid: Number(fields[2]),
      started: fields[3] ?? "",
      command: fields[4] ?? "",
    });
  }
  return rows;
}

/** The processes below `roots` in the tree of parents, not the roots themselves. */
export function descendantsOf(roots: readonly number[], table: readonly Proc[]): Proc[] {
  const found = new Map<number, Proc>();
  const parents = [...roots];
  for (let parent = parents.pop(); parent !== undefined; parent = parents.pop()) {
    for (const row of table) {
      if (row.ppid !== parent || found.has(row.pid) || roots.includes(row.pid)) continue;
      found.set(row.pid, row);
      parents.push(row.pid);
    }
  }
  return [...found.values()];
}

/** Whether a process with this pid exists. (EPERM says it does, and belongs to someone else.) */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalTo(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // It has gone already, which is what was wanted.
  }
}

/**
 * The processes of `wanted` that are still the ones listed: same pid, started at the same time.
 * Where `ps` cannot be run it is all of them, since a process cannot be shown to be gone.
 */
function stillThere(wanted: readonly Proc[]): Proc[] {
  let table: Proc[];
  try {
    table = listProcesses();
  } catch {
    return [...wanted];
  }
  return wanted.filter((one) =>
    table.some((row) => row.pid === one.pid && row.started === one.started),
  );
}

/**
 * Ends `wanted`: SIGTERM to each, and SIGKILL to each that has not exited when `graceMs` is up.
 * A pid is signalled again only while it still has the start time it was listed with, so that a
 * pid the system has given to another process in the meantime is left alone. Resolves with what is
 * still there at the end, which is nothing unless a process cannot be killed.
 */
export async function terminate(wanted: readonly Proc[], graceMs: number): Promise<Proc[]> {
  for (const one of wanted) signalTo(one.pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  let left = wanted.filter((one) => isAlive(one.pid));
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(POLL_MS);
    left = left.filter((one) => isAlive(one.pid));
  }
  if (left.length === 0) return [];

  for (const one of stillThere(left)) signalTo(one.pid, "SIGKILL");
  const killDeadline = Date.now() + graceMs;
  while (left.length > 0 && Date.now() < killDeadline) {
    await sleep(POLL_MS);
    left = left.filter((one) => isAlive(one.pid));
  }
  return stillThere(left);
}

/**
 * SIGKILL for each of `wanted` that is still there, with no wait. It is for the end of the
 * process, where nothing can be waited for.
 */
export function killNow(wanted: readonly Proc[]): void {
  for (const one of stillThere(wanted)) signalTo(one.pid, "SIGKILL");
}
