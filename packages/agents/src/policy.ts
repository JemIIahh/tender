import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// An agent's entry policy: which of the open tasks of its tags, and of its hires, it will spend work
// on. The runner (`runner.ts`) applies it after the checks of its own (the Judge's verdict, the
// contract's rules, a hire's terms) and before it announces a task or asks its solver.
//
// Why. The tag is no reason to spend. Anyone can post a task with an agent's tags at the token's
// least reward, name themselves its verifier, read the revealed answers and pick nobody: they have
// the work for free, and the agent's model calls are spent. A hire is held to its service's terms
// already (the price, the checker), so it is not held to the least reward or to the verifiers. It
// counts toward the daily cap all the same, as its solve costs the same. A hire that its hirer
// checks is the same free-work path again (the hirer is its verifier, and can pick nobody), so it is
// held to the hirer's record (`maxVoidsAfterReveals`) and to the cap; a hire the Judge checks is not
// held back by either.

/**
 * Who may check the work the agent enters: `"judge"`, the Judge that the API serves
 * (`judgeAccount`); `"any"` account; or the accounts of a list.
 */
export type VerifierRule = "judge" | "any" | readonly string[];

export interface EntryPolicy {
  /**
   * The least reward the agent enters a task for, by token: the token's account id, and an amount
   * in its smallest unit. A task that pays less is skipped. A token with no amount here is held to
   * none (the contract's own minimum is the floor of every task). Default: none.
   */
  minReward?: Readonly<Record<string, bigint>>;
  /** Whose tasks the agent enters, by the verifier the task names. Default: `"any"`. */
  verifiers?: VerifierRule;
  /** The account that `"judge"` means: the Judge the API serves (`JUDGE_ACCOUNT`). Needed with it. */
  judgeAccount?: string;
  /**
   * Skips a task whose verifier has made more empty picks after a reveal than this
   * (`voids_after_reveals` of the verifier's record in the API), and a hire its hirer checks whose
   * hirer has. A verifier the API has no record of is not held to it. Default: no limit.
   */
  maxVoidsAfterReveals?: number;
  /**
   * The most tasks the agent takes on in a UTC day: it bounds what the solver spends. Every task
   * and every hire counts. The count is kept on the disk (`EntryCounts`), so that a restart does
   * not reset it. Once the day is full, a task of the agent's tags waits for the next day; a hire
   * its hirer checks is refused for good (a wait would only let it be voided, and its hirer is
   * refunded); a hire the Judge checks is taken on all the same, as it is when the count cannot be
   * read. Default: no cap.
   */
  dailyEntries?: number;
}

/**
 * Where an agent keeps the count of the tasks it took on today, for `dailyEntries`. One process
 * writes it: the agent's own, as with its drafts.
 */
export interface EntryCounts {
  /** How many tasks the agent took on in `day` (a UTC date, `YYYY-MM-DD`): 0 if the count is of another day. */
  read(day: string): Promise<number>;
  /** Records `count` as the tasks of `day`, and returns once that is on the disk. */
  write(day: string, count: number): Promise<void>;
}

/** The file in an agent's state directory that holds its count of the day (`createEntryCounts`). */
export const ENTRY_COUNTS_FILE = "entries-per-day.json";

/** The UTC date of `ms` (milliseconds since the epoch), as `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

/**
 * The count of the day in `file`, a JSON file of its own: `{"day": "2026-11-04", "entries": 3}`.
 * A missing file is a count of 0. A file that is not a count fails the read, and the runner then
 * enters no task until it can be read: a count it cannot read is a cap it cannot keep. A write is
 * made so that a crash leaves the old count or the new one, and once it returns the new one is on
 * the disk (a temp file synced, renamed over the file, and the directory synced).
 */
export function createEntryCounts(file: string): EntryCounts {
  if (file === "") throw new Error("the file of the entry counts must not be empty");
  return {
    async read(day) {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`the entry count file ${file} is corrupt: it is not valid JSON`);
      }
      const { day: kept, entries } = (json ?? {}) as { day?: unknown; entries?: unknown };
      if (typeof kept !== "string" || !DAY.test(kept) || !isCount(entries)) {
        throw new Error(`the entry count file ${file} is corrupt: it is not a day's count`);
      }
      return kept === day ? entries : 0;
    },
    async write(day, count) {
      if (!DAY.test(day) || !isCount(count)) throw new RangeError("not a day's count");
      await writeFileAtomic(file, `${JSON.stringify({ day, entries: count })}\n`);
    },
  };
}

async function syncDirectory(path: string): Promise<void> {
  // Windows cannot open a directory.
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeFileAtomic(file: string, text: string): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectory(dir);
}

/**
 * Throws unless `policy` can be applied: a verifier rule of the three kinds (a list with at least one
 * account in it), a Judge's account for `"judge"`, amounts of 0 or more, whole numbers for the
 * limits, and `counts` for a daily cap.
 */
export function checkPolicy(policy: EntryPolicy, counts: EntryCounts | undefined): void {
  const { verifiers = "any", judgeAccount, minReward, maxVoidsAfterReveals, dailyEntries } = policy;
  if (Array.isArray(verifiers)) {
    if (
      verifiers.length === 0 ||
      !verifiers.every((one) => typeof one === "string" && one !== "")
    ) {
      throw new TypeError(
        "policy.verifiers: a list must name at least one account, and only accounts",
      );
    }
  } else if (verifiers !== "judge" && verifiers !== "any") {
    throw new TypeError('policy.verifiers must be "judge", "any" or a list of accounts');
  }
  if (verifiers === "judge" && (typeof judgeAccount !== "string" || judgeAccount === "")) {
    throw new TypeError(
      'policy.verifiers "judge" needs policy.judgeAccount, the Judge the API serves',
    );
  }
  for (const amount of Object.values(minReward ?? {})) {
    if (typeof amount !== "bigint" || amount < 0n) {
      throw new RangeError("policy.minReward: each amount must be a bigint of 0 or more");
    }
  }
  if (maxVoidsAfterReveals !== undefined && !isCount(maxVoidsAfterReveals)) {
    throw new RangeError("policy.maxVoidsAfterReveals must be a whole number, at least 0");
  }
  if (dailyEntries !== undefined) {
    if (!isCount(dailyEntries) || dailyEntries < 1) {
      throw new RangeError("policy.dailyEntries must be a whole number, at least 1");
    }
    if (counts === undefined) {
      throw new TypeError("policy.dailyEntries needs entryCounts, where the day's count is kept");
    }
  }
}

/** What the policy needs of a task: its verifier, and what it pays in which token. */
export interface PolicyTask {
  verifier: string;
  token: string;
  /** A u128 as a decimal string. */
  reward: string;
}

/**
 * Why `policy` turns `task` away by its reward or its verifier, or null if neither does. The reason
 * is for a log line: it quotes the task's figures and accounts, and no words of it. The record of
 * the verifier (`maxVoidsAfterReveals`) is the runner's to read and judge.
 */
export function policyRefusal(policy: EntryPolicy, task: PolicyTask): string | null {
  const { minReward, verifiers = "any", judgeAccount } = policy;
  if (minReward !== undefined && Object.hasOwn(minReward, task.token)) {
    const least = minReward[task.token] as bigint;
    if (BigInt(task.reward) < least) {
      return `it pays ${task.reward} of ${task.token}, below the ${least} the agent enters for`;
    }
  }
  if (verifiers === "judge" && task.verifier !== judgeAccount) {
    return `its verifier ${task.verifier} is not the Judge, ${judgeAccount}`;
  }
  if (Array.isArray(verifiers) && !verifiers.includes(task.verifier)) {
    return `its verifier ${task.verifier} is not one the agent lets check its work`;
  }
  return null;
}

/** The policy in one line of the log, by the names of its fields. */
export function describePolicy(policy: EntryPolicy): string {
  const { minReward, verifiers = "any", judgeAccount, maxVoidsAfterReveals, dailyEntries } = policy;
  const who =
    verifiers === "judge"
      ? `judge (${judgeAccount})`
      : verifiers === "any"
        ? "any"
        : verifiers.join(",");
  const floors = Object.entries(minReward ?? {})
    .map(([token, amount]) => `${token}:${amount}`)
    .join(",");
  return [
    `verifiers=${who}`,
    `minReward=${floors === "" ? "none" : floors}`,
    `maxVoidsAfterReveals=${maxVoidsAfterReveals ?? "none"}`,
    `dailyEntries=${dailyEntries ?? "none"}`,
  ].join(" ");
}
