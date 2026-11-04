import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { SCORECARD_FILE } from "./demo-local";
import { REPO_ROOT } from "./lib/env";

// `pnpm demo:local` the way a person runs it: through tsx's command line, as the script `demo:local`
// does, in a process group of its own, as a terminal runs a command, and with an OS temp dir of the
// test's own (TMPDIR), so that what the demo leaves there can be seen.
//
// With `--keep`: once the demo has printed the environment of the MCP server, the test starts the
// server with exactly those lines (a shell runs them), lists the tasks through it, commits to the
// open task, and then sends the group a SIGINT, which is what Ctrl-C does. The demo must end with
// `DEMO OK` and exit code 0, with its temp dir gone. Without it: a Ctrl-C in the middle of the
// scenario stops what the demo started, removes its temp dir, and exits with 130.

const TIMEOUT_MS = 420_000;
const TSX_CLI = fileURLToPath(import.meta.resolve("tsx/cli"));
const MCP_BIN = "packages/mcp/bin/tender-mcp.ts";
/** Whether the scorecard file was there before the demo ran: if not, the test removes it. */
const hadScorecard = existsSync(SCORECARD_FILE);

/** The OS temp dir the demos run with, and the process groups they run in. */
const ownTmp = realpathSync(mkdtempSync(join(tmpdir(), "tender-demo-test-")));
const groups: number[] = [];

afterAll(() => {
  // A demo stops itself on the SIGINTs below; a group still there after a failure is killed. Only
  // the groups this file started are, by their ids.
  for (const group of groups) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
  if (!hadScorecard) rmSync(SCORECARD_FILE, { force: true });
  rmSync(ownTmp, { recursive: true, force: true });
});

/** What a demo left in the OS temp dir: the run dirs whose names start with `tender-demo-`. */
const leftInTmp = () => readdirSync(ownTmp).filter((name) => name.startsWith("tender-demo-"));

/** Whether a process of `group` is still there. */
function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

/** `pnpm demo:local` with `args`, as a terminal runs it, and what it prints as it prints it. */
function startDemo(args: string[]) {
  const out = { stdout: "", stderr: "" };
  const demo: ChildProcess = spawn(process.execPath, [TSX_CLI, "scripts/demo-local.ts", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, TMPDIR: ownTmp },
    stdio: ["ignore", "pipe", "pipe"],
    // A group of its own, as a terminal gives a command: a SIGINT to it reaches every process.
    detached: true,
  });
  if (demo.pid !== undefined) groups.push(demo.pid);
  demo.stdout?.on("data", (chunk: Buffer) => {
    out.stdout += chunk.toString("utf8");
  });
  demo.stderr?.on("data", (chunk: Buffer) => {
    out.stderr += chunk.toString("utf8");
  });
  const closed = new Promise<number | null>((resolve) => demo.on("close", resolve));
  /** Ctrl-C: a SIGINT to the whole group. */
  const interrupt = () => {
    if (demo.pid !== undefined) process.kill(-demo.pid, "SIGINT");
  };
  return { out, closed, interrupt, group: demo.pid ?? 0 };
}

/** Resolves once `read()` matches `pattern`, or rejects after `ms`. */
function until(read: () => string, pattern: RegExp, ms: number): Promise<void> {
  const giveUpAt = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const look = () => {
      if (pattern.test(read())) resolve();
      else if (Date.now() > giveUpAt)
        reject(new Error(`no ${pattern} within ${ms} ms:\n${read()}`));
      else setTimeout(look, 250);
    };
    look();
  });
}

/**
 * The MCP server started as docs/MCP.md says, with `env`, and spoken to over stdio as a client does:
 * one JSON-RPC message a line. `call` runs a tool and gives whether it failed and its text.
 */
function startMcp(env: Record<string, string>) {
  const server = spawn("pnpm", ["--silent", "tsx", MCP_BIN], {
    cwd: REPO_ROOT,
    env,
    // Its one line on stderr ("serving ... on sandbox") is not the test's to show.
    stdio: ["pipe", "pipe", "ignore"],
  });
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  createInterface({ input: server.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (typeof message.id === "number") waiting.get(message.id)?.(message);
  });
  let next = 0;
  const request = (method: string, params: object) =>
    new Promise<Record<string, unknown>>((resolve) => {
      next += 1;
      waiting.set(next, resolve);
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`);
    });
  const ready = request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "demo-keep-test", version: "0.0.0" },
  }).then(() => {
    server.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  });
  return {
    async call(name: string, args: object = {}): Promise<{ isError: boolean; text: string }> {
      await ready;
      const answer = await request("tools/call", { name, arguments: args });
      const result = answer.result as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: result.isError === true, text: result.content[0]?.text ?? "" };
    },
    /** Closes its input, as a client that goes does: the server exits (docs/MCP.md). */
    close: () =>
      new Promise<void>((resolve) => {
        server.once("close", () => resolve());
        server.stdin.end();
      }),
  };
}

test(
  "keep_serves_the_mcp_server_from_the_lines_it_prints_and_ends_well_on_ctrl_c",
  async () => {
    const { out, closed, interrupt, group } = startDemo(["--keep"]);

    await until(() => out.stdout, new RegExp(`^ {2}pnpm --silent tsx ${MCP_BIN}$`, "m"), 300_000);
    await until(() => out.stdout, /^OPEN task=\d+ /m, 30_000);
    const lines = out.stdout.split("\n");
    expect(lines).toContain("SCORECARD FILE .tender/demo/scorecard.json");
    expect(existsSync(SCORECARD_FILE)).toBe(true);
    const openId = /^OPEN task=(\d+) /m.exec(out.stdout)?.[1];
    expect(openId).toBe("2");

    // The server's environment, from the printed lines as a shell runs them.
    const exports = lines.filter((line) => line.startsWith("  export ")).join("\n");
    const env = JSON.parse(
      execFileSync("sh", ["-c", `${exports}\nnode -p 'JSON.stringify(process.env)'`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }),
    ) as Record<string, string>;
    expect(env.TENDER_NETWORK).toBe("sandbox");
    expect(env.TENDER_ACCOUNT).toBe("lead.sandbox");
    expect(env.TENDER_PRIVATE_KEY).toMatch(/^ed25519:/);
    expect(out.stdout).not.toContain(env.TENDER_PRIVATE_KEY);

    const mcp = startMcp(env);
    try {
      const listed = await mcp.call("list_tasks");
      expect(listed.isError).toBe(false);
      const { tasks } = JSON.parse(listed.text) as {
        tasks: Array<{ id: string; phase: string; outcome_kind: string | null }>;
      };
      expect(tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "1", phase: "settled", outcome_kind: "picked" }),
          expect.objectContaining({ id: openId, phase: "open" }),
        ]),
      );
      const balance = await mcp.call("balance");
      expect(balance.isError).toBe(false);
      expect(balance.text).toContain('"full_access"');

      // The agent enters the open task: a hash on chain, the work and the salt in its draft.
      const answer = readFileSync(
        join(REPO_ROOT, "scripts", "demo-seeds", "demo-divisor-counts", "solution.txt"),
        "utf8",
      ).trim();
      const committed = await mcp.call("commit_result", { task_id: openId, content: answer });
      expect(committed.isError, committed.text).toBe(false);
      expect(committed.text).toContain("reveal_opens_at");
      // The API's index shows the entry a moment later.
      let status = "";
      for (let tries = 0; status !== "committed" && tries < 60; tries++) {
        const task = await mcp.call("get_task", { task_id: openId });
        expect(task.isError, task.text).toBe(false);
        status = (JSON.parse(task.text) as { own_entry: { status: string } }).own_entry.status;
        if (status !== "committed") await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(status).toBe("committed");
    } finally {
      await mcp.close();
    }

    // Ctrl-C.
    const tempDir = dirname(env.TENDER_STATE_DIR ?? "");
    expect(existsSync(join(tempDir, "keep", "lead.json"))).toBe(true);
    expect(leftInTmp()).toHaveLength(1);
    interrupt();
    const code = await closed;
    expect(out.stderr).toContain("demo: SIGINT; stopping");
    expect(out.stdout.trimEnd().split("\n").at(-1), out.stderr).toBe("DEMO OK");
    expect(code, out.stderr).toBe(0);
    expect(existsSync(tempDir)).toBe(false);
    expect(leftInTmp()).toEqual([]);
    expect(groupAlive(group)).toBe(false);
  },
  TIMEOUT_MS,
);

test(
  "ctrl_c_in_the_middle_of_the_demo_stops_it_and_leaves_no_temp_dir",
  async () => {
    const { out, closed, interrupt, group } = startDemo([]);
    // The chain and the services are up, the task is posted, and the agents are about to start.
    await until(() => out.stdout, /^POSTED task=1 /m, 300_000);
    expect(leftInTmp()).toHaveLength(1);
    interrupt();
    const code = await closed;
    expect(out.stderr).toContain("demo: interrupted by SIGINT; stopped what it started");
    expect(out.stdout).not.toContain("DEMO OK");
    expect(code, out.stderr).toBe(130);
    expect(leftInTmp()).toEqual([]);
    expect(groupAlive(group)).toBe(false);
  },
  TIMEOUT_MS,
);
