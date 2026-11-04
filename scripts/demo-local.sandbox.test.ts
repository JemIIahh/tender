import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { SCORECARD_FILE } from "./demo-local";
import { REPO_ROOT } from "./lib/env";

// `pnpm demo:local --keep` the way a person runs it: through tsx's command line, as the script
// `demo:local` does, in a process group of its own, as a terminal runs a command. Once the demo has
// printed the environment of the MCP server, the test starts the server with exactly those lines
// (a shell runs them), lists the tasks through it, and then sends the group a SIGINT, which is what
// Ctrl-C does. The demo must end with `DEMO OK` and exit code 0, with its temp dir gone.

const TIMEOUT_MS = 420_000;
const TSX_CLI = fileURLToPath(import.meta.resolve("tsx/cli"));
const MCP_BIN = "packages/mcp/bin/tender-mcp.ts";
/** Whether the scorecard file was there before the demo ran: if not, the test removes it. */
const hadScorecard = existsSync(SCORECARD_FILE);

let demo: ChildProcess | undefined;

afterAll(() => {
  // The demo stops itself on the SIGINT below; one that is still there is stuck, and goes.
  if (demo?.pid !== undefined && demo.exitCode === null) process.kill(-demo.pid, "SIGKILL");
  if (!hadScorecard) rmSync(SCORECARD_FILE, { force: true });
});

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
    async call(name: string): Promise<{ isError: boolean; text: string }> {
      await ready;
      const answer = await request("tools/call", { name, arguments: {} });
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
    let stdout = "";
    let stderr = "";
    demo = spawn(process.execPath, [TSX_CLI, "scripts/demo-local.ts", "--keep"], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // A group of its own, as a terminal gives a command: a SIGINT to it reaches every process.
      detached: true,
    });
    demo.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    demo.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const closed = new Promise<number | null>((resolve) => demo?.on("close", resolve));

    await until(() => stdout, new RegExp(`^ {2}pnpm --silent tsx ${MCP_BIN}$`, "m"), 300_000);
    const lines = stdout.split("\n");
    expect(lines).toContain("SCORECARD FILE .tender/demo/scorecard.json");
    expect(existsSync(SCORECARD_FILE)).toBe(true);

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
    expect(stdout).not.toContain(env.TENDER_PRIVATE_KEY);

    const mcp = startMcp(env);
    try {
      const listed = await mcp.call("list_tasks");
      expect(listed.isError).toBe(false);
      const { tasks } = JSON.parse(listed.text) as {
        tasks: Array<{ id: string; phase: string; outcome_kind: string }>;
      };
      expect(tasks).toEqual([
        expect.objectContaining({ id: "1", phase: "settled", outcome_kind: "picked" }),
      ]);
      const balance = await mcp.call("balance");
      expect(balance.isError).toBe(false);
      expect(balance.text).toContain('"full_access"');
    } finally {
      await mcp.close();
    }

    // Ctrl-C.
    const tempDir = dirname(env.TENDER_STATE_DIR ?? "");
    expect(existsSync(join(tempDir, "keep", "lead.json"))).toBe(true);
    if (demo.pid !== undefined) process.kill(-demo.pid, "SIGINT");
    const code = await closed;
    expect(stderr).toContain("demo: SIGINT; stopping");
    expect(stdout.trimEnd().split("\n").at(-1), stderr).toBe("DEMO OK");
    expect(code, stderr).toBe(0);
    expect(existsSync(tempDir)).toBe(false);
  },
  TIMEOUT_MS,
);
