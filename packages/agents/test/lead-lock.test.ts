import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JOURNAL_LOCK_FILE, JournalLockedError, lockJournal } from "../src/agents/lead-lock";
import { deadPid, holdJournal, killHolders } from "./journal-holder";

// One swarm lead per journal. The lead keeps a journal so that it never pays for a part twice, and
// two leads on one journal could both act on it. So a lead takes a lock file in the journal
// directory when it starts (`lockJournal`: written whole, then linked in, holding its pid and its
// start time),
// and these tests use processes of their own (`holdJournal`) for the second lead, the one that dies
// by a signal and the one that is killed.

/** A child process can be slow to start on a busy machine. */
const PROCESSES = { timeout: 180_000 };

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lead-lock-"));
  file = join(dir, JOURNAL_LOCK_FILE);
});
afterEach(() => {
  killHolders();
  rmSync(dir, { recursive: true, force: true });
});

const holderIn = () =>
  JSON.parse(readFileSync(file, "utf8")) as { pid: number; started_at: string };

/** What `lockJournal` threw, or undefined if it took the lock (which is then let go). */
function refusalOf(): JournalLockedError | undefined {
  try {
    lockJournal(dir, () => undefined).release();
    return undefined;
  } catch (error) {
    if (error instanceof JournalLockedError) return error;
    throw error;
  }
}

describe("the lead's journal lock", () => {
  test(
    "a_second_process_on_the_journal_is_refused_with_the_pid_that_holds_it",
    PROCESSES,
    async () => {
      const first = holdJournal(dir);
      await first.ready;
      // The file holds the holder's pid and the time it started.
      expect(holderIn().pid).toBe(first.pid);
      expect(holderIn().started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // This process is a second one.
      const refused = refusalOf();
      expect(refused).toBeInstanceOf(JournalLockedError);
      expect(refused?.pid).toBe(first.pid);
      expect(refused?.message).toBe(
        `the journal ${dir} is held by another lead, process ${first.pid} (started ${holderIn().started_at}): ` +
          "one lead at a time works from a journal. Stop that process, or give this lead a journal " +
          `of its own. If process ${first.pid} is no lead (its number was taken by another process), ` +
          `delete ${file}`,
      );

      // And so is a third, which does not start.
      const third = holdJournal(dir);
      const ended = await third.exited;
      expect(ended.code).toBe(1);
      expect(third.stdout()).not.toContain("ready");
      expect(third.stderr()).toContain(`is held by another lead, process ${first.pid}`);
      // The lock is still the first one's.
      expect(holderIn().pid).toBe(first.pid);
    },
  );

  test("a_stale_lock_is_taken_over_and_the_takeover_is_logged", PROCESSES, async () => {
    // A lock of a process that has ended.
    const dead = await deadPid();
    const started = "2026-11-04T10:00:00.000Z";
    writeFileSync(file, `${JSON.stringify({ pid: dead, started_at: started, token: "old" })}\n`);
    const lines: string[] = [];
    const lock = lockJournal(dir, (line) => lines.push(line));
    expect(lines).toEqual([
      `took over the journal ${dir} from process ${dead} (started ${started}), which no longer runs`,
    ]);
    expect(holderIn().pid).toBe(process.pid);
    lock.release();
    // Nothing is left behind: the lock, the copy it was written to and the leftover are all gone.
    expect(readdirSync(dir)).toEqual([]);

    // A lead that was killed, which runs no handler, leaves its lock behind: the next takes it over.
    const killed = holdJournal(dir);
    await killed.ready;
    killed.child.kill("SIGKILL");
    await killed.exited;
    expect(holderIn().pid).toBe(killed.pid);
    const next = holdJournal(dir, "exit");
    expect((await next.exited).code).toBe(0);
    expect(next.stdout()).toContain(`from process ${killed.pid} (started `);
    expect(next.stdout()).toContain("ready\n");
  });

  test(
    "the_lock_is_released_on_SIGTERM_and_on_SIGINT_so_a_new_process_starts",
    PROCESSES,
    async () => {
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        const holder = holdJournal(dir);
        await holder.ready;
        holder.child.kill(signal);
        // The process ends by the signal, as one without the lock would: the lock does not keep it.
        expect(await holder.exited, signal).toEqual({ code: null, signal });
        expect(existsSync(file), signal).toBe(false);
        // A new lead starts, and takes nothing over.
        const next = holdJournal(dir, "exit");
        expect((await next.exited).code, signal).toBe(0);
        expect(next.stdout(), signal).toBe("ready\n");
      }
    },
  );

  test("the_lock_is_released_on_a_normal_exit", PROCESSES, async () => {
    for (const mode of ["end", "exit"] as const) {
      const holder = holdJournal(dir, mode);
      await holder.ready;
      expect(await holder.exited, mode).toEqual({ code: 0, signal: null });
      expect(existsSync(file), mode).toBe(false);
    }
  });

  test("a_host_that_handles_SIGTERM_keeps_the_journal_until_it_stops", PROCESSES, async () => {
    // A host with an orderly stop lets its lead finish the pass in hand: the lock is its until the
    // process ends, and not from the moment the signal comes.
    const holder = holdJournal(dir, "handled");
    await holder.ready;
    holder.child.kill("SIGTERM");
    await vi.waitFor(() => expect(holder.stdout()).toContain("stopping\n"), {
      timeout: 60_000,
      interval: 20,
    });
    expect(refusalOf()?.pid).toBe(holder.pid);

    // It ends with process.exit, and the lock goes with it.
    holder.child.kill("SIGINT");
    expect(await holder.exited).toEqual({ code: 0, signal: null });
    expect(existsSync(file)).toBe(false);
  });

  test("a_lock_file_that_names_no_process_is_refused_and_says_what_to_do", () => {
    for (const text of ["", "{", '{"pid":"12"}', '{"pid":0}', "[1]"]) {
      writeFileSync(file, text);
      const refused = refusalOf();
      expect(refused, text).toBeInstanceOf(JournalLockedError);
      expect(refused?.pid, text).toBeNull();
      expect(refused?.message, text).toBe(
        `the journal ${dir} has a lock file that names no process, ${file}: a lead writes its ` +
          "lock whole, so no lead made this one, or it was damaged. If no lead works from this " +
          "journal, delete it",
      );
      // Left as it was, and nothing else is left.
      expect(readFileSync(file, "utf8"), text).toBe(text);
      expect(readdirSync(dir), text).toEqual([JOURNAL_LOCK_FILE]);
    }
  });

  test("one_lead_per_journal_in_a_process_too_and_a_lock_let_go_can_be_taken_again", () => {
    const lock = lockJournal(dir, () => undefined);
    expect(() => lockJournal(dir, () => undefined)).toThrow(
      new JournalLockedError(
        `the journal ${dir} is held already by a lead in this process`,
        process.pid,
      ),
    );
    // The same directory by another spelling of its path.
    expect(() => lockJournal(`${dir}/.`, () => undefined)).toThrow(JournalLockedError);
    lock.release();
    lock.release();
    expect(existsSync(file)).toBe(false);
    lockJournal(dir, () => undefined).release();
  });

  test("letting_go_leaves_a_lock_file_that_is_no_longer_this_leads", () => {
    const lock = lockJournal(dir, () => undefined);
    // Only the lock is in the directory while it is held.
    expect(readdirSync(dir)).toEqual([JOURNAL_LOCK_FILE]);
    // Someone deleted the file and another lead took the journal since.
    const other = `${JSON.stringify({ pid: 1, started_at: "2026-11-04T10:00:00.000Z", token: "x" })}\n`;
    writeFileSync(file, other);
    lock.release();
    expect(readFileSync(file, "utf8")).toBe(other);
  });

  test("the_directory_is_made_if_it_is_not_there", () => {
    const deeper = join(dir, "a", "b");
    const lock = lockJournal(deeper, () => undefined);
    expect(existsSync(join(deeper, JOURNAL_LOCK_FILE))).toBe(true);
    lock.release();
  });
});
