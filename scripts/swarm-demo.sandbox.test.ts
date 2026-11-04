import { spawn } from "node:child_process";
import { expect, test } from "vitest";
import { REPO_ROOT } from "./lib/env";

// `scripts/swarm-demo.ts` run the way a person runs it, on a local chain, from start to its last
// line: a lead agent that holds a delegate key with caps of 2 tUSDC a task and 6 tUSDC in all takes a
// parent task of 10 tUSDC, hires three specialists with sub-tasks of 2 tUSDC each, and answers the
// parent with what they hand in. The script judges its own run (it ends with `SWARM OK` only if
// every fact it prints held), and the test reads what it printed: those lines come from the API and
// the chain, and not from what the lead said it did.

const TIMEOUT_MS = 540_000;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the script as `pnpm exec tsx scripts/swarm-demo.ts` does, and gives what it printed. */
function runSwarmDemo(): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/swarm-demo.ts"], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    // The script stops its own chain. Past this long something is stuck, and the test kills it.
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS - 20_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** The first line that matches `pattern` after index `after`; fails the test naming what is missing. */
function find(
  lines: string[],
  pattern: RegExp,
  after = -1,
): { at: number; match: RegExpMatchArray } {
  for (let at = after + 1; at < lines.length; at++) {
    const match = lines[at]?.match(pattern);
    if (match) return { at, match };
  }
  throw new Error(`no line matching ${pattern} after line ${after}:\n${lines.join("\n")}`);
}

test(
  "swarm_demo_ok_and_lineage_visible",
  async () => {
    const { code, stdout, stderr } = await runSwarmDemo();
    expect(code, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines.at(-1)).toBe("SWARM OK");

    // The banner is plain about who the agents are.
    expect(lines[0]).toMatch(/^Scripted demo agents run by the Tender team/);
    const chain = find(lines, /^CHAIN sandbox nearcore /);

    // The lead's key: caps of 2.00 and 6.00 tUSDC, four methods, and a finite allowance.
    // The lead, alice and bob register with the bond before the lead's key is set up.
    const registered = find(lines, /^REGISTERED lead, alice, bob bond=1\.00 tUSDC each$/, chain.at);
    const key = find(lines, /^LEAD key /, registered.at);
    expect(lines[key.at]).toContain("per_task_cap=2.00 tUSDC");
    expect(lines[key.at]).toContain("total_cap=6.00 tUSDC");
    expect(lines[key.at]).toContain("methods=post_task,top_up_task,commit,reveal");
    expect(lines[key.at]).toMatch(/allowance=\d+(\.\d+)? NEAR/);
    expect(lines[key.at]).not.toContain("allowance=none");

    // The parent, and the lead's placeholder entry on it, which comes before any hire.
    const parent = find(lines, /^PARENT task=(\d+)$/, key.at);
    const parentId = BigInt(parent.match[1] ?? "");
    const placeholder = find(lines, /^LEAD placeholder committed$/, parent.at);

    // Three sub-tasks, one after the other.
    let after = placeholder.at;
    const childIds: bigint[] = [];
    for (let n = 0; n < 3; n++) {
      const child = find(lines, /^CHILD task=(\d+)$/, after);
      childIds.push(BigInt(child.match[1] ?? ""));
      after = child.at;
    }
    expect(new Set(childIds).size).toBe(3);

    // The API's detail of the parent lists the same three as its children.
    const lineage = find(
      lines,
      /^LINEAGE parent=(\d+) children=([\d,]+) as listed by the API$/,
      after,
    );
    expect(BigInt(lineage.match[1] ?? "")).toBe(parentId);
    expect((lineage.match[2] ?? "").split(",").map(BigInt)).toEqual(childIds);
    expect(lineage.match[2]?.split(",")).toHaveLength(3);

    // A fourth hire, over the total cap, is refused by the contract with E_AUTH.
    const cap = find(lines, /^CAP /, after);
    expect(lines[cap.at]).toContain("E_AUTH");
    expect(lines[cap.at]).toContain("fourth");
    expect(lines[cap.at]).toContain("spent 6.00 tUSDC of 6.00 tUSDC");

    // Each sub-task is won, by a specialist: alice has two parts, bob the middle one.
    const won = new Map<bigint, string>();
    after = cap.at;
    for (let n = 0; n < 3; n++) {
      const line = find(lines, /^CHILD WON task=(\d+) by=(\S+)$/, after);
      won.set(BigInt(line.match[1] ?? ""), line.match[2] ?? "");
      after = line.at;
    }
    expect([...won.keys()].sort()).toEqual([...childIds].sort());
    expect(childIds.map((id) => won.get(id))).toEqual([
      "alice.sandbox",
      "bob.sandbox",
      "alice.sandbox",
    ]);

    // Then the lead puts the parts together, commits that, reveals, and is paid and in profit.
    const recommit = find(lines, /^LEAD recommitted$/, after);
    const reveal = find(lines, /^LEAD revealed$/, recommit.at);
    const paid = find(lines, /^PARENT PAID lead=([\d.]+) tUSDC$/, reveal.at);
    // 10.00 tUSDC less the 5% fee.
    expect(paid.match[1]).toBe("9.50");
    const margin = find(lines, /^MARGIN lead=([\d.]+) tUSDC$/, paid.at);
    // What the parent paid after the fee, less what the three sub-tasks cost: 9.50 - 3 x 2.00.
    expect(margin.match[1]).toBe("3.50");
    expect(Number(margin.match[1])).toBeGreaterThan(0);
    expect(lines.indexOf("SWARM OK")).toBeGreaterThan(margin.at);
  },
  TIMEOUT_MS,
);
