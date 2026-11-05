import { execFile } from "node:child_process";
import { expect, test } from "vitest";
import { REPO_ROOT } from "./lib/env";

// Each command a person runs checks the Node it is on before the rest of it runs or starts anything:
// `pnpm demo:local`, the swarm demo, `pnpm serve`, the agent commands, the sandbox-node fetch that
// CI runs, the MCP server and the agent runner. The test runs each as its own process on a Node
// that says it is 22, or 25 (the one place the check reads, `process.version`, is set before the
// command is loaded) and reads what it printed.

const ENTRY_POINTS = [
  "scripts/demo-local.ts",
  "scripts/swarm-demo.ts",
  "scripts/serve.ts",
  "scripts/agent.ts",
  "scripts/fetch-sandbox-node.ts",
  "packages/mcp/bin/tender-mcp.ts",
  "packages/agents/bin/run-agent.ts",
];

/** A module that makes this Node say it is `version`, loaded before the command. */
const fakeNode = (version: string) =>
  `data:text/javascript,${encodeURIComponent(
    `Object.defineProperty(process, "version", { value: "${version}" });`,
  )}`;

function runOnNode(
  version: string,
  entry: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", fakeNode(version), "--import", "tsx", entry],
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
  const { code, stdout, stderr } = await runOnNode("v22.22.2", entry);
  expect(stderr).toBe(
    "Tender needs Node 24.21 or a later 24, or Node 26 and newer; this is v22.22.2\n",
  );
  expect(stdout).toBe("");
  expect(code).toBe(1);
});

test("node_25_is_refused_as_well", async () => {
  // Some test dependencies leave 25 out of their `engines`, so `package.json` does too.
  const { code, stderr } = await runOnNode("v25.1.0", "scripts/demo-local.ts");
  expect(stderr).toBe(
    "Tender needs Node 24.21 or a later 24, or Node 26 and newer; this is v25.1.0\n",
  );
  expect(code).toBe(1);
});
