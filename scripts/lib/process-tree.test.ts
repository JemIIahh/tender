import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  descendantsOf,
  killStartedProcesses,
  listFromProc,
  listProcesses,
  listWithPs,
  type ProcessRow,
  parentOfStat,
  type RunSync,
} from "./process-tree";

// The table of processes comes from `ps`, and from `/proc` on a host without `ps`. macOS has `ps`
// and no `/proc`, so the fallback is tested by standing in for the two sources, and by a `/proc`
// that a test lays out in a temp dir. The real processes below use whatever the host has.

const rows = (...pairs: [number, number][]): ProcessRow[] =>
  pairs.map(([pid, ppid]) => ({ pid, ppid }));

/** A tree below 100: 101 and 102 are its children, 103 is 101's, 104 is 103's. 200 is not in it. */
const TREE = rows(
  [1, 0],
  [99, 1], // the parent of 100
  [100, 99],
  [101, 100],
  [102, 100],
  [103, 101],
  [104, 103],
  [200, 1], // another tree
  [201, 200],
  [150, 99], // a sibling of 100
);

// ---------------------------------------------------------------------------------------------
// The tree.

test("descendants_of_are_the_children_and_theirs_and_nothing_else", () => {
  expect(descendantsOf(TREE, 100).sort()).toEqual([101, 102, 103, 104]);
  expect(descendantsOf(TREE, 101).sort()).toEqual([103, 104]);
  expect(descendantsOf(TREE, 104)).toEqual([]);
  expect(descendantsOf(TREE, 4242)).toEqual([]); // not in the table
  expect(descendantsOf([], 100)).toEqual([]);
});

test("descendants_of_never_include_the_root_even_in_a_table_with_a_loop", () => {
  // A table read while processes come and go can pair an id with a parent that has since gone.
  const odd = rows([10, 20], [20, 10], [30, 10]);
  expect(descendantsOf(odd, 10).sort()).toEqual([20, 30]);
});

// ---------------------------------------------------------------------------------------------
// ps.

const ok = (stdout: string): ReturnType<RunSync> => ({ pid: 777, status: 0, stdout });

test("ps_is_asked_for_every_process_with_its_parent_and_its_own_row_is_dropped", () => {
  const run = vi.fn<RunSync>(() =>
    ok("    1     0\n  100     1\n  101   100\n  777   100\n\ngarbage line\n  12\n"),
  );
  expect(listWithPs(run)).toEqual(rows([1, 0], [100, 1], [101, 100]));
  expect(run).toHaveBeenCalledWith(
    "ps",
    ["-A", "-o", "pid=,ppid="],
    expect.objectContaining({ encoding: "utf8", timeout: 5_000 }),
  );
});

test("ps_gives_no_table_when_it_is_missing_or_fails", () => {
  const missing = Object.assign(new Error("spawnSync ps ENOENT"), { code: "ENOENT" });
  expect(listWithPs(() => ({ pid: 0, status: null, stdout: "", error: missing }))).toBeUndefined();
  expect(listWithPs(() => ({ pid: 777, status: 1, stdout: "1 0\n" }))).toBeUndefined();
  expect(listWithPs(() => ({ pid: 777, status: null, stdout: "" }))).toBeUndefined();
});

// ---------------------------------------------------------------------------------------------
// /proc.

test("the_parent_is_the_second_field_after_the_command_whatever_the_command_is_called", () => {
  expect(parentOfStat("4242 (node) S 100 4242 4242 0 -1 4194560")).toBe(100);
  // A command can hold spaces and brackets: the fields are those after the last bracket.
  expect(parentOfStat("4242 (my (odd) cmd) R 77 4242 4242 0 -1")).toBe(77);
  expect(parentOfStat("4242 (a) b) S 5 1")).toBe(5);
  expect(parentOfStat("4242 (init) S 0 1 1")).toBe(0);
  expect(parentOfStat("")).toBeUndefined();
  expect(parentOfStat("no brackets 5 6")).toBeUndefined();
  expect(parentOfStat("4242 (node) S")).toBeUndefined();
  expect(parentOfStat("4242 (node) S x 1")).toBeUndefined();
  expect(parentOfStat("4242 (node) S -1 1")).toBeUndefined();
});

const dirs: string[] = [];

async function fakeProc(files: Record<string, string | null>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tender-proc-"));
  dirs.push(dir);
  for (const [name, stat] of Object.entries(files)) {
    if (stat === null) {
      await mkdir(join(dir, name), { recursive: true }); // a process directory with no stat file
    } else if (name.includes("/")) {
      await mkdir(join(dir, name.split("/")[0] ?? ""), { recursive: true });
      await writeFile(join(dir, name), stat);
    } else {
      await writeFile(join(dir, name), stat); // a file of /proc that is no process
    }
  }
  return dir;
}

test("a_proc_directory_is_read_as_a_process_for_each_numbered_entry", async () => {
  const dir = await fakeProc({
    "100/stat": "100 (sh) S 99 100 100 0 -1 4194560",
    "101/stat": "101 (sleep 300) S 100 100 100 0 -1",
    "102/stat": "102 (a (b) c) R 101 100 100 0 -1",
    "103/stat": "garbage",
    "104": null, // it ended while the table was read
    "self/stat": "1 (self) S 0 1 1",
    cpuinfo: "processor : 0",
  });
  const listed = listFromProc(dir);
  expect(listed?.sort((a, b) => a.pid - b.pid)).toEqual(rows([100, 99], [101, 100], [102, 101]));
});

test("a_host_with_no_proc_gives_no_table", async () => {
  const dir = await fakeProc({});
  await rm(dir, { recursive: true });
  expect(listFromProc(dir)).toBeUndefined();
});

// ---------------------------------------------------------------------------------------------
// The fallback.

test("proc_is_read_when_ps_gives_no_table", () => {
  const proc = vi.fn(() => TREE);
  expect(listProcesses({ ps: () => undefined, proc })).toBe(TREE);
  expect(proc).toHaveBeenCalledOnce();
});

test("proc_is_not_read_when_ps_gives_a_table", () => {
  const proc = vi.fn(() => rows([5, 1]));
  expect(listProcesses({ ps: () => TREE, proc })).toBe(TREE);
  expect(proc).not.toHaveBeenCalled();
});

test("no_table_at_all_is_no_table", () => {
  expect(listProcesses({ ps: () => undefined, proc: () => undefined })).toBeUndefined();
});

test("the_end_of_a_process_kills_the_tree_by_id_from_proc_when_ps_is_missing", () => {
  const kill = vi.fn();
  const list = () => listProcesses({ ps: () => undefined, proc: () => TREE });
  const killed = killStartedProcesses({ root: 100, list, kill });
  expect(killed.sort()).toEqual([101, 102, 103, 104]);
  // Exactly those, by id, with SIGKILL: not the root, its parent, its sibling, or the other tree.
  expect(kill.mock.calls.map(([pid]) => pid).sort()).toEqual([101, 102, 103, 104]);
  for (const [, signal] of kill.mock.calls) expect(signal).toBe("SIGKILL");
});

test("a_process_that_has_gone_does_not_stop_the_others_being_killed", () => {
  const gone = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  const kill = vi.fn((pid: number) => {
    if (pid === 101) throw gone;
  });
  expect(killStartedProcesses({ root: 100, list: () => TREE, kill }).sort()).toEqual([
    101, 102, 103, 104,
  ]);
  expect(kill).toHaveBeenCalledTimes(4);
});

test("nothing_is_killed_where_the_table_cannot_be_read", () => {
  const kill = vi.fn();
  expect(killStartedProcesses({ root: 100, list: () => undefined, kill })).toEqual([]);
  expect(kill).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------------------------
// Real processes.

const started: number[] = [];

afterEach(async () => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It has gone already.
    }
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const giveUp = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > giveUp) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A shell with two `sleep`s below it, whose ids it prints, and a `sleep` of its own beside it. */
async function startTree(): Promise<{ shell: number; sleepers: number[]; bystander: number }> {
  const shell: ChildProcess = spawn(
    "sh",
    ["-c", "sleep 300 & echo $!; sleep 300 & echo $!; wait"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const bystander = spawn("sleep", ["300"], { stdio: "ignore" });
  if (shell.pid === undefined || bystander.pid === undefined) throw new Error("no pid");
  started.push(shell.pid, bystander.pid);
  let out = "";
  shell.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  await until(() => out.split("\n").filter(Boolean).length >= 2, "the shell to print its sleeps");
  const sleepers = out.split("\n").filter(Boolean).map(Number);
  started.push(...sleepers);
  return { shell: shell.pid, sleepers, bystander: bystander.pid };
}

test("the_real_processes_below_a_root_are_killed_and_no_others", async () => {
  const { shell, sleepers, bystander } = await startTree();

  // The table of this host, from `ps` or `/proc`, whichever it has: the shell's tree is in it.
  const table = listProcesses();
  expect(table, "this host has neither ps nor /proc").toBeDefined();
  expect(descendantsOf(table ?? [], shell).sort()).toEqual([...sleepers].sort());

  const killed = killStartedProcesses({ root: shell });
  expect(killed.sort()).toEqual([...sleepers].sort());
  await until(() => sleepers.every((pid) => !alive(pid)), "the sleeps to end");
  // The shell, its parent (this process) and a process beside it were never the target.
  expect(alive(bystander)).toBe(true);
  expect(alive(process.pid)).toBe(true);
});

test.skipIf(process.platform !== "linux")(
  "the_real_processes_below_a_root_are_found_and_killed_from_proc_alone",
  async () => {
    const { shell, sleepers, bystander } = await startTree();

    const killed = killStartedProcesses({
      root: shell,
      list: () => listProcesses({ ps: () => undefined, proc: listFromProc }),
    });
    expect(killed.sort()).toEqual([...sleepers].sort());
    await until(() => sleepers.every((pid) => !alive(pid)), "the sleeps to end");
    expect(alive(bystander)).toBe(true);
  },
);
