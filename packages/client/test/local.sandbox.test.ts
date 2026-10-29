import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { expect, test } from "vitest";
import { startLocalChain, TenderError } from "../src/index";

// Each test starts its own chain, because each one breaks it.

/**
 * The nodes this process started that are still there, from `ps`: near-sandbox's `run`
 * processes whose parent is this process, with their RPC address and home directory.
 */
function ownNodes() {
  const table = execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,args="], { encoding: "utf8" });
  return table.split("\n").flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    const run = /--home (\S+) run --rpc-addr (\S+)/.exec(row?.[3] ?? "");
    if (row === null || run === null || Number(row[2]) !== process.pid) return [];
    return [{ pid: Number(row[1]), home: run[1] ?? "", rpcUrl: `http://${run[2]}` }];
  });
}

/** Waits until the process `pid` is gone: dead, and reaped by this process. */
async function gone(pid: number) {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`process ${pid} is still there after 5 s`);
}

/** `promise`, or a failure if it has not settled within `ms`. */
async function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

test("stop_survives_a_dead_node", async () => {
  const chain = await startLocalChain();
  const nodes = ownNodes().filter((node) => node.rpcUrl === chain.rpcUrl);
  expect(nodes).toHaveLength(1);
  const [node] = nodes;
  if (node === undefined) throw new Error("unreachable");
  try {
    expect(existsSync(node.home)).toBe(true);
    // nearcore dies under the chain, and its exit is over before anyone calls stop().
    process.kill(node.pid, "SIGKILL");
    await gone(node.pid);

    await within(30_000, "stop()", chain.stop());
    expect(existsSync(node.home)).toBe(false);
    // A second stop does nothing more.
    await within(1_000, "a second stop()", chain.stop());
  } finally {
    rmSync(node.home, { recursive: true, force: true });
  }
});

test("a_failed_setup_throws_its_own_error_and_stops_the_node", async () => {
  const before = ownNodes();
  // Tender's `new` refuses a minimum window of 0, while the token deploys beside it.
  const error = await startLocalChain({ minWindowSecs: 0 }).then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(TenderError);
  expect(error).toMatchObject({ code: "E_WINDOW" });
  expect(ownNodes()).toEqual(before);
});
