import { execFile } from "node:child_process";
import { expect, test } from "vitest";
import { REPO_ROOT } from "./lib/env";

// Each command a person runs checks the Node it is on before it loads or starts anything else:
// `pnpm demo:local`, the swarm demo, `pnpm serve`, the agent commands, the MCP server and the agent
// runner. The test runs each as its own process on a Node that says it is 22 (the one place the
// check reads, `process.version`, is set before the command is loaded) and reads what it printed.

const ENTRY_POINTS = [
  "scripts/demo-local.ts",
  "scripts/swarm-demo.ts",
  "scripts/serve.ts",
  "scripts/agent.ts",
  "packages/mcp/bin/tender-mcp.ts",
  "packages/agents/bin/run-agent.ts",
];

/** A module that makes this Node say it is 22.22.2, loaded before the command. */
const OLD_NODE = `data:text/javascript,${encodeURIComponent(
  'Object.defineProperty(process, "version", { value: "v22.22.2" });',
)}`;

function runOnOldNode(entry: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", OLD_NODE, "--import", "tsx", entry],
      // No environment beyond the path: nothing the command might read is set.
      { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "" }, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

test.each(ENTRY_POINTS)("%s_names_an_old_node_in_one_line_and_exits_1", async (entry) => {
  const { code, stdout, stderr } = await runOnOldNode(entry);
  expect(stderr).toBe("Tender needs Node 24.21 or newer; this is v22.22.2\n");
  expect(stdout).toBe("");
  expect(code).toBe(1);
});
