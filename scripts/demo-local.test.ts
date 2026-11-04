import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { demoOptionsOf, keptLines, nodeStartLine, shellWord } from "./demo-local";

// The parts of `pnpm demo:local` that need no chain: its flags, the line before the node starts,
// and the lines `--keep` prints for the MCP server. `demo-local.sandbox.test.ts` runs the whole of
// `--keep` on a local chain.

test("the_demo_takes_keep_and_nothing_else", () => {
  expect(demoOptionsOf([])).toEqual({ keep: false });
  expect(demoOptionsOf(["--keep"])).toEqual({ keep: true });
  expect(demoOptionsOf(["--", "--keep"])).toEqual({ keep: true });
  for (const args of [["--kept"], ["keep"], ["--keep=1"], ["--", "keep"]]) {
    expect(() => demoOptionsOf(args), args.join(" ")).toThrow(/usage: pnpm demo:local \[--keep\]/);
  }
});

test("the_line_before_the_node_says_whether_it_downloads", () => {
  expect(nodeStartLine({})).toBe(
    "starting a local NEAR node (the first run downloads it: about 30 MB, 70 MB on disk; " +
      "later runs skip this)",
  );
  expect(nodeStartLine({ NEAR_SANDBOX_BIN_PATH: "/opt/near-sandbox" })).toBe(
    "starting a local NEAR node (the one NEAR_SANDBOX_BIN_PATH names)",
  );
});

test("a_word_for_the_shell_is_quoted_only_when_it_has_to_be", () => {
  expect(shellWord("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  expect(shellWord("/var/folders/x/T/tender-demo-a1/keep/lead.json")).toBe(
    "/var/folders/x/T/tender-demo-a1/keep/lead.json",
  );
  expect(shellWord("/tmp/a dir/it's")).toBe(`'/tmp/a dir/it'\\''s'`);
  // What the shell makes of each is the text itself.
  for (const text of ["/tmp/a dir/it's", "$HOME", "a;b", "`x`", "plain"]) {
    expect(execFileSync("sh", ["-c", `printf %s ${shellWord(text)}`], { encoding: "utf8" })).toBe(
      text,
    );
  }
});

test("keep_prints_the_mcp_servers_environment_as_a_shell_takes_it", () => {
  const lines = keptLines({
    rpcUrl: "http://127.0.0.1:61001",
    apiUrl: "http://127.0.0.1:61002",
    contractId: "tender.sandbox",
    judgeAccount: "judge.sandbox",
    account: "lead.sandbox",
    keyFile: "/tmp/tender demo/keep/lead.json",
    stateDir: "/tmp/tender demo/mcp-state",
    holds: "999999.00 tUSDC in its wallet, and NEAR for gas and storage",
  });
  expect(lines[0]).toMatch(/^KEPT the local chain and the services, until Ctrl-C\./);
  const exports = lines.filter((line) => line.startsWith("  export "));
  expect(exports.map((line) => line.split("=")[0]?.trim())).toEqual([
    "export TENDER_NETWORK",
    "export TENDER_CONTRACT",
    "export NEAR_RPC_URL",
    "export TENDER_API_URL",
    "export TENDER_JUDGE_ACCOUNT",
    "export TENDER_ACCOUNT",
    "export TENDER_STATE_DIR",
    "export TENDER_PRIVATE_KEY",
  ]);
  expect(lines).toContain("  pnpm --silent tsx packages/mcp/bin/tender-mcp.ts");
  // The key itself is never in the lines: they name its file.
  expect(lines.join("\n")).not.toMatch(/ed25519:/);
  expect(lines.at(-1)).toContain("Its full-access key is in /tmp/tender demo/keep/lead.json");
});
