import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JOURNAL_LOCK_FILE, JournalLockedError, lockJournal } from "../src/agents/lead-lock";
import { deadPid } from "./journal-holder";

// Two leads that take over the same leftover lock at once. The lock module's file calls are wrapped
// here, so that the test acts at the one moment that matters: after this lead has read the leftover
// and before it moves it aside, another lead has taken the leftover over and made its own lock.
// This lead must then be refused by that lock, and leave it where it was.

const hooks = vi.hoisted(() => ({
  /** Runs once, before the next rename of the lock module. */
  beforeRename: undefined as undefined | (() => void),
  /** Runs once, before the next link whose source is a leftover moved aside. */
  beforeLinkBack: undefined as undefined | (() => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      const hook = hooks.beforeRename;
      hooks.beforeRename = undefined;
      hook?.();
      real.renameSync(from, to);
    },
    linkSync: (from: string, to: string) => {
      if (String(from).endsWith(".stale")) {
        const hook = hooks.beforeLinkBack;
        hooks.beforeLinkBack = undefined;
        hook?.();
      }
      real.linkSync(from, to);
    },
  };
});

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lead-lock-race-"));
  file = join(dir, JOURNAL_LOCK_FILE);
});
afterEach(() => {
  hooks.beforeRename = undefined;
  hooks.beforeLinkBack = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const lockOf = (pid: number, token: string) =>
  `${JSON.stringify({ pid, started_at: "2026-11-04T10:00:00.000Z", token })}\n`;

describe("two leads take over the same leftover lock", () => {
  test("the_one_that_comes_second_is_refused_and_leaves_the_others_lock_where_it_was", async () => {
    writeFileSync(file, lockOf(await deadPid(), "leftover"));
    // The other lead runs as a live process: the one that started this test's.
    const theirs = lockOf(process.ppid, "theirs");
    hooks.beforeRename = () => {
      rmSync(file);
      writeFileSync(file, theirs);
    };

    expect(() => lockJournal(dir, () => undefined)).toThrow(
      expect.objectContaining({ name: "JournalLockedError", pid: process.ppid }),
    );
    // Its lock is there, as it made it, and nothing of this lead's is left.
    expect(readFileSync(file, "utf8")).toBe(theirs);
    expect(readdirSync(dir)).toEqual([JOURNAL_LOCK_FILE]);
  });

  test("a_third_lock_made_while_the_second_is_moved_aside_is_not_written_over", async () => {
    writeFileSync(file, lockOf(await deadPid(), "leftover"));
    const second = lockOf(process.ppid, "second");
    // pid 1 runs on every system, and is no process of this test's.
    const third = lockOf(1, "third");
    hooks.beforeRename = () => {
      rmSync(file);
      writeFileSync(file, second);
    };
    hooks.beforeLinkBack = () => writeFileSync(file, third);

    let refused: unknown;
    try {
      lockJournal(dir, () => undefined).release();
    } catch (error) {
      refused = error;
    }
    // The third lock holds the journal, and this lead is refused by it.
    expect(refused).toBeInstanceOf(JournalLockedError);
    expect((refused as JournalLockedError).pid).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(third);
    expect(readdirSync(dir)).toEqual([JOURNAL_LOCK_FILE]);
  });
});
