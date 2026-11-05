import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

// One swarm lead per journal. The lead keeps a journal so that it never pays for a part twice, and
// two lead processes on one journal directory could both act on it: both hire, both assemble. So a
// lead holds the journal while it runs (`run` of `createLeadSolver`): a lock file in the directory,
// holding its pid, the time it started, and a random token by which the holder tells its own file
// from another's. The file is written whole under a name of its own first (made with O_EXCL, the
// `wx` flag, and synced), and then linked to the lock's name: a link fails if the name is taken, so
// only one lead can make it, and the lock is never seen half written. So the journal directory's
// file system must support hard links (FAT and some network and FUSE mounts do not): on one that
// does not, `run` fails at its start, and says so.
//
// - A second lead on the journal refuses to start, and its message names the pid that holds it.
// - A lock whose pid is not alive is a leftover (a lead that was killed runs nothing): it is taken
//   over, and the log says so. It is first renamed aside, which moves the one file there is under
//   the name, whatever it holds by then, and read where it went: if it is the leftover, it goes,
//   and the lead links its own lock in; if another lead took the leftover over in between, its lock
//   is linked back where it was, and this lead is refused by it. Only a third lead that makes a
//   lock in the moment between the move and the link back can leave two leads with the journal, and
//   the one that lost its file stands back at its next pass (`journalHeldElsewhere`).
// - A pid can come back as another process's, and then the lock looks held: the message says to
//   delete the file in that case. Pids are judged on this host alone: leads on two hosts, or two
//   containers, that share a journal are not told apart, so each host gets a journal of its own.
// - A file that names no process is refused: no lead made it (a lead writes its lock whole), or it
//   was damaged.
// - The files a lead makes beside the lock while it takes it (the lock written whole, a leftover
//   moved aside) carry its pid in their names. A lead killed in that moment leaves them behind, and
//   the next lead to take the lock removes those of a pid that is not alive.
// - The lock goes when the lead lets it go, when the process exits (`process.exit`, or the end of
//   its work), and on SIGINT and SIGTERM. For those two: when the process has no other handler for
//   the signal, which would then end it at once, the lock is let go and the signal is raised again,
//   so that the process ends by it as it would have. When the host handles the signal itself (an
//   orderly stop), the host's stop ends the lead's `run`, which lets the lock go, and the exit
//   lets it go at the latest: until then the lead may be in the middle of a post, and the journal
//   stays its own. A kill (SIGKILL) runs nothing, and leaves the lock for the next lead to take over.

/** The lock file in a lead's journal directory. It is no job: the journal reads `<id>.json` only. */
export const JOURNAL_LOCK_FILE = "lead.lock";

/** How many times the file is looked at before the journal is given up as being taken. */
const ATTEMPTS = 3;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** The journal is another lead's, or cannot be told to be free. */
export class JournalLockedError extends Error {
  /** The pid that holds the journal, or null when the lock file names none. */
  readonly pid: number | null;

  constructor(message: string, pid: number | null) {
    super(message);
    this.name = "JournalLockedError";
    this.pid = pid;
  }
}

/** Who a lock file says holds the journal. */
export interface JournalHolder {
  pid: number;
  /** When it started, as the file says it, or null when the file has no time that reads as one. */
  startedAt: string | null;
}

/** A lock this process holds on a journal. */
export interface JournalLock {
  /** The lock file. */
  readonly file: string;
  /** Removes the lock file if it is still this lock's. Safe to call twice. */
  release(): void;
}

/** The locks this process holds, by the real path of their journal, with the text written in each. */
const held = new Map<string, { file: string; text: string }>();

/** Who `text`, a lock file's, says holds it; undefined if it names no process. */
function holderOf(text: string): JournalHolder | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  const { pid, started_at: started } = json as { pid?: unknown; started_at?: unknown };
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) return undefined;
  const startedAt = typeof started === "string" && ISO_TIME.test(started) ? started : null;
  return { pid: pid as number, startedAt };
}

/** Whether process `pid` runs: a signal 0 reaches it, or is refused for want of rights. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The text of `file`, or undefined once it is gone. */
function readLock(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** What a link fails with on a file system that has no hard links, or will not make one there. */
const NO_HARD_LINKS: ReadonlySet<string> = new Set([
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EXDEV",
  "ENOSYS",
]);

/**
 * The files the lock makes beside itself while a lead takes it: the lock written whole (`.tmp`) and a
 * leftover moved aside (`.stale`), with the pid of the lead that made them and a random token.
 */
const BESIDE_THE_LOCK =
  /^\.lead\.lock\.([1-9][0-9]*)\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:tmp|stale)$/;

/** Writes `text` to a new file `file` (O_EXCL), and syncs it, so that what is linked to it is whole. */
function writeWhole(file: string, text: string): void {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(file, { force: true });
    throw error;
  }
  closeSync(fd);
}

/**
 * Links `from` to the name `to`, if no file has that name. Returns whether it did. A file system
 * that makes no hard links is said in plain words, and not as the system's error, which names two
 * paths and a code.
 */
function linkIfFree(from: string, to: string): boolean {
  try {
    linkSync(from, to);
    return true;
  } catch (error) {
    const code = codeOf(error);
    if (code === "EEXIST") return false;
    if (code !== undefined && NO_HARD_LINKS.has(code)) {
      throw new Error(
        `the journal directory's file system must support hard links: the lead takes the lock of ` +
          `${dirname(to)} by linking a file it wrote whole, and the link failed (${code})`,
      );
    }
    throw error;
  }
}

/**
 * Removes the files a lead that was killed while it took the lock left beside it
 * (`BESIDE_THE_LOCK`), those of a pid that is not alive and is not this process. They are harmless
 * (the journal reads `<id>.json` only), so this is best effort: a file that cannot be removed is left.
 */
function sweep(journal: string): void {
  let names: string[];
  try {
    names = readdirSync(journal);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(BESIDE_THE_LOCK.exec(name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid === process.pid || alive(pid)) continue;
    try {
      rmSync(join(journal, name), { force: true });
    } catch {
      // Left for the next lead to try.
    }
  }
}

/**
 * Moves the leftover lock `found` out of `file`'s way, through `aside`. The rename moves whatever is
 * under the name now, so the file is read where it went: if it is the leftover, it is removed and
 * this returns true. If it is not, another lead made its lock in place of the leftover since it was
 * read, and that lock is linked back under the name it had (unless yet another lead has made one
 * there meanwhile), and this returns false: the next look finds the live lock.
 */
function setAside(file: string, found: string, aside: string): boolean {
  try {
    renameSync(file, aside);
  } catch (error) {
    // Gone since the read: another lead took the leftover over, and the next look finds its lock.
    if (codeOf(error) === "ENOENT") return false;
    throw error;
  }
  let moved: string | undefined;
  try {
    moved = readLock(aside);
  } finally {
    if (moved !== found) linkIfFree(aside, file);
    rmSync(aside, { force: true });
  }
  return moved === found;
}

const started = (holder: JournalHolder) =>
  holder.startedAt === null ? "" : ` (started ${holder.startedAt})`;

/**
 * Makes `dir` and what is above it that is missing, and puts each new folder's name on the disk, as
 * the journal's own writes do (`ensureDirectory` of `lead.ts`). The journal is made here when a lead
 * runs first, and a journal whose folder a power cut can lose is no journal: the writes after this
 * find the folder there and do not sync its name again. Only Windows, which cannot open a directory,
 * is let off.
 */
function makeDirectory(dir: string): void {
  const first = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (first === undefined || process.platform === "win32") return;
  // `first` is the topmost folder made. Its name is in its parent, and so on down to `dir`.
  for (let made = dir; ; made = dirname(made)) {
    const fd = openSync(dirname(made), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (made === first || dirname(made) === made) return;
  }
}

/**
 * Takes the lock of the journal `dir` for this process, making the directory if it is not there,
 * and first removes what dead leads left beside the lock (`sweep`). Throws a `JournalLockedError`
 * when a live process holds it, this one included, or when its lock file names no process, and an
 * error that says so when the directory's file system makes no hard links. A leftover lock is taken
 * over, and `log` is told. See the top of the file.
 */
export function lockJournal(dir: string, log: (line: string) => void): JournalLock {
  if (dir === "") throw new Error("the lead's journal directory must not be empty");
  const journal = resolve(dir);
  makeDirectory(journal);
  const key = realpathSync(journal);
  if (held.has(key)) {
    throw new JournalLockedError(
      `the journal ${journal} is held already by a lead in this process`,
      process.pid,
    );
  }
  const file = join(journal, JOURNAL_LOCK_FILE);
  const token = randomUUID();
  const text = `${JSON.stringify({
    pid: process.pid,
    started_at: new Date().toISOString(),
    token,
  })}\n`;
  // Names of this lead's own, which no other lead uses: the lock written whole, and a leftover
  // moved aside (`BESIDE_THE_LOCK`). Neither ends in `.json`, so the journal never takes one for a
  // job.
  const whole = join(journal, `.${JOURNAL_LOCK_FILE}.${process.pid}.${token}.tmp`);
  const aside = join(journal, `.${JOURNAL_LOCK_FILE}.${process.pid}.${token}.stale`);
  sweep(journal);
  writeWhole(whole, text);
  try {
    let leftover: JournalHolder | undefined;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (linkIfFree(whole, file)) {
        held.set(key, { file, text });
        hookProcess();
        if (leftover !== undefined) {
          log(
            `took over the journal ${journal} from process ${leftover.pid}${started(leftover)}, which no longer runs`,
          );
        }
        return {
          file,
          release() {
            if (held.get(key)?.text !== text) return;
            held.delete(key);
            removeIfOwn(file, text);
            if (held.size === 0) unhookProcess();
          },
        };
      }
      const found = readLock(file);
      // Gone since the try: try again.
      if (found === undefined) continue;
      const holder = holderOf(found);
      if (holder === undefined) {
        throw new JournalLockedError(
          `the journal ${journal} has a lock file that names no process, ${file}: a lead writes its ` +
            "lock whole, so no lead made this one, or it was damaged. If no lead works from this " +
            "journal, delete it",
          null,
        );
      }
      // A lock with this process's pid that this process does not hold is a leftover of an earlier
      // process that had the same pid.
      if (holder.pid !== process.pid && alive(holder.pid)) {
        throw new JournalLockedError(
          `the journal ${journal} is held by another lead, process ${holder.pid}${started(holder)}: ` +
            "one lead at a time works from a journal. Stop that process, or give this lead a journal " +
            `of its own. If process ${holder.pid} is no lead (its number was taken by another ` +
            `process), delete ${file}`,
          holder.pid,
        );
      }
      if (setAside(file, found, aside)) leftover = holder;
    }
    throw new JournalLockedError(
      `the journal ${journal} is being taken by another lead just now: try again`,
      null,
    );
  } finally {
    rmSync(whole, { force: true });
  }
}

/**
 * Who holds the journal `dir`, when it is a live process other than this one, or a lock file that
 * names no process (`pid` null); null when no other process holds it. A lead that does not hold the
 * journal itself asks this before it acts, so that it does not act beside the one that does.
 */
export function journalHeldElsewhere(dir: string): { pid: number | null } | null {
  let found: string | undefined;
  try {
    found = readLock(join(resolve(dir), JOURNAL_LOCK_FILE));
  } catch {
    // A file that cannot be read cannot be said to be free.
    return { pid: null };
  }
  if (found === undefined) return null;
  const holder = holderOf(found);
  if (holder === undefined) return { pid: null };
  if (holder.pid === process.pid || !alive(holder.pid)) return null;
  return { pid: holder.pid };
}

/** Removes `file` if it still holds `text`, and leaves anything else alone. */
function removeIfOwn(file: string, text: string): void {
  try {
    if (readLock(file) === text) rmSync(file, { force: true });
  } catch {
    // A lock that stays is a leftover, which the next lead takes over.
  }
}

function releaseAll(): void {
  for (const { file, text } of held.values()) removeIfOwn(file, text);
  held.clear();
}

let hooked = false;

function onExit(): void {
  releaseAll();
}

/**
 * The handler of SIGINT and SIGTERM while a lock is held. It is the first of the process's handlers
 * (`prependListener`), so that the others are all still there when it counts them.
 */
function onSignal(signal: NodeJS.Signals): void {
  // The host handles it: its stop lets the lock go (or the exit does).
  if (process.listenerCount(signal) > 1) return;
  // Nothing else does: the process would have ended at once. It still does, by the same signal.
  releaseAll();
  unhookProcess();
  process.kill(process.pid, signal);
}

function hookProcess(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", onExit);
  for (const signal of SIGNALS) process.prependListener(signal, onSignal);
}

function unhookProcess(): void {
  if (!hooked) return;
  hooked = false;
  process.off("exit", onExit);
  for (const signal of SIGNALS) process.off(signal, onSignal);
}
