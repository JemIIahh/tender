import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { afterEach, expect, test, vi } from "vitest";
import { REPO_ROOT } from "./lib/env";

// scripts/run-agents.mjs, the supervisor of the agents' service, run as a process, with a stand-in
// agent run as a real child of it (the command after `--`). The stand-in prints its command line and
// lines on both streams, and stops on SIGTERM or SIGINT the way run-agent does: it says so and ends
// with 0. Its environment says which agent ends on its own and which one will not stop. The last
// test runs the real run-agent command, which ends at once for want of its variables.

const SCRIPT = join(REPO_ROOT, "scripts", "run-agents.mjs");

/** The stand-in agent. */
const STUB = `
const name = process.argv[process.argv.indexOf("--agent") + 1];
console.log("stub up " + JSON.stringify(process.argv.slice(2)));
console.log("stub pid " + process.pid);
console.log("has its key variable: " + (process.env["AGENT_" + name.toUpperCase() + "_PRIVATE_KEY"] ? "yes" : "no"));
console.error("stub says on stderr");
const ignore = process.env.STUB_IGNORE === name;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log((ignore ? "ignores " : "got ") + signal);
    if (ignore) return;
    // A last line with no newline, which must be printed all the same.
    process.stdout.write("last words");
    setTimeout(() => process.exit(0), 100);
  });
}
if (process.env.STUB_EXIT === name) {
  setTimeout(() => {
    process.stdout.write("ends on its own");
    process.exit(3);
  }, 1500);
}
setInterval(() => {}, 1000);
`;

/** A key that must never be printed: the supervisor hands it to the agents and shows nothing of it. */
const AGENT_KEY = KeyPair.fromRandom("ed25519").toString();
const LLM_KEY = "llm-key-for-the-run-agents-tests";

const dirs: string[] = [];
const runs: Run[] = [];

afterEach(async () => {
  // Whatever a failed test left running, by the exact pids it started.
  for (const run of runs.splice(0)) {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
    for (const pid of stubPids(run)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone already, as it should be.
      }
    }
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tender-run-agents-"));
  dirs.push(dir);
  return dir;
}

interface Run {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Starts the supervisor with only `env` (and a PATH and a home of the test's), and the stand-in as
 * its agent command unless `real` is set.
 */
async function startSupervisor(env: Record<string, string>, real = false): Promise<Run> {
  const dir = await tempDir();
  const stub = join(dir, "stub-agent.mjs");
  await writeFile(stub, STUB);
  const args = real ? [SCRIPT] : [SCRIPT, "--", process.execPath, stub];
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: dir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const run = { child, stdout: () => stdout, stderr: () => stderr, ended };
  runs.push(run);
  return run;
}

/** The pids of the stand-ins a run started, as their own lines give them. */
const stubPids = (run: Run) =>
  [...run.stdout().matchAll(/^\[[a-z]+\] stub pid (\d+)$/gm)].map((match) => Number(match[1]));

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

/** True while a process with this pid runs (or waits to be reaped). */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every stand-in the run started has ended. */
async function expectStubsGone(run: Run, count: number): Promise<void> {
  expect(stubPids(run)).toHaveLength(count);
  await vi.waitFor(() => expect(stubPids(run).filter(running)).toEqual([]), { timeout: 5_000 });
}

/** Nothing printed holds a key, or any part of one. */
function expectNoKeys(run: Run): void {
  const printed = run.stdout() + run.stderr();
  const body = AGENT_KEY.slice("ed25519:".length);
  for (const piece of [AGENT_KEY, body.slice(0, 8), body.slice(-8), LLM_KEY]) {
    expect(printed).not.toContain(piece);
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`run_agents_prefixes_each_agents_lines_and_passes_${signal}_on_then_exits_0`, async () => {
    const state = await tempDir();
    const run = await startSupervisor({
      TENDER_AGENTS: " analyst , coder ",
      TENDER_AGENT_FLAGS: " --daily-entries 5   --max-llm-calls-per-hour 10 ",
      TENDER_STATE_HOME: state,
      AGENT_ANALYST_PRIVATE_KEY: AGENT_KEY,
      AGENT_CODER_PRIVATE_KEY: AGENT_KEY,
      LLM_API_KEY: LLM_KEY,
    });
    await vi.waitFor(() => expect(stubPids(run)).toHaveLength(2), { timeout: 30_000 });
    await vi.waitFor(() => expect(run.stderr()).toContain("[coder] stub says on stderr"));
    await vi.waitFor(() => expect(run.stderr()).toContain("[analyst] stub says on stderr"));

    run.child.kill(signal);
    const ended = await run.ended;

    expect(ended).toEqual({ code: 0, signal: null });
    const out = lines(run.stdout());
    // Each agent with the llm solver on testnet (TENDER_NETWORK is not set), and the flags after.
    for (const name of ["analyst", "coder"]) {
      const command = [
        ...["--agent", name, "--solver", "llm", "--network", "testnet"],
        ...["--daily-entries", "5", "--max-llm-calls-per-hour", "10"],
      ];
      expect(out).toContain(`[${name}] stub up ${JSON.stringify(command)}`);
      // It has the environment, its key included, which the supervisor does not print.
      expect(out).toContain(`[${name}] has its key variable: yes`);
      expect(out).toContain(`[${name}] got ${signal}`);
      // The last line, which had no newline, is printed whole.
      expect(out).toContain(`[${name}] last words`);
      expect(out).toContain(`run-agents: ${name} ended with code 0`);
      expect(out.filter((line) => line.startsWith(`[${name}] stub up`))).toHaveLength(1);
    }
    expect(out).toContain("run-agents: starting analyst, coder");
    expect(out).toContain(`run-agents: ${signal}: stopping the agents`);
    // Each agent's stdout lines on stdout, its stderr lines on stderr.
    expect(run.stdout()).not.toContain("stub says on stderr");
    expect(run.stderr()).not.toContain("stub up");
    // With TENDER_STATE_HOME set, no warning about where the drafts are kept.
    expect(run.stderr()).not.toContain("TENDER_STATE_HOME");
    expectNoKeys(run);
    await expectStubsGone(run, 2);
  });
}

test("run_agents_stops_the_others_and_exits_non_zero_when_an_agent_ends_on_its_own", async () => {
  const run = await startSupervisor({
    STUB_EXIT: "coder",
    AGENT_CODER_PRIVATE_KEY: AGENT_KEY,
    LLM_API_KEY: LLM_KEY,
  });

  const ended = await run.ended;

  // Non-zero, so that the host restarts the service.
  expect(ended).toEqual({ code: 1, signal: null });
  const out = lines(run.stdout());
  const err = lines(run.stderr());
  // The three agents of the default list.
  expect(out).toContain("run-agents: starting analyst, coder, extractor");
  expect(out).toContain("[coder] ends on its own");
  expect(err).toContain("run-agents: coder ended with code 3; stopping the others");
  for (const name of ["analyst", "extractor"]) {
    expect(out).toContain(`[${name}] got SIGTERM`);
    expect(out).toContain(`run-agents: ${name} ended with code 0`);
  }
  // It restarts nothing itself: each agent was started once.
  for (const name of ["analyst", "coder", "extractor"]) {
    expect(out.filter((line) => line.startsWith(`[${name}] stub up`))).toHaveLength(1);
  }
  // TENDER_STATE_HOME is not set, and a warning says what that means.
  expect(run.stderr()).toContain(
    "WARN run-agents: TENDER_STATE_HOME is not set, so each agent keeps its drafts under the home directory",
  );
  expectNoKeys(run);
  await expectStubsGone(run, 3);
});

test("run_agents_kills_an_agent_that_is_still_running_10_s_after_sigterm", {
  timeout: 60_000,
}, async () => {
  const run = await startSupervisor({
    TENDER_AGENTS: "analyst,coder",
    STUB_EXIT: "coder",
    STUB_IGNORE: "analyst",
  });
  await vi.waitFor(() => expect(run.stdout()).toContain("[analyst] ignores SIGTERM"), {
    timeout: 30_000,
  });
  const sentAt = performance.now();

  const ended = await run.ended;

  expect(ended).toEqual({ code: 1, signal: null });
  const waited = performance.now() - sentAt;
  expect(waited).toBeGreaterThan(9_000);
  expect(waited).toBeLessThan(20_000);
  const err = lines(run.stderr());
  expect(err).toContain("run-agents: analyst is still running 10 s after SIGTERM: SIGKILL");
  expect(lines(run.stdout())).toContain("run-agents: analyst ended on SIGKILL");
  await expectStubsGone(run, 2);
});

test("run_agents_refuses_a_setting_it_cannot_use_and_does_not_show_it", async () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ TENDER_AGENTS: "analyst,analyst" }, "TENDER_AGENTS names an agent twice"],
    [{ TENDER_AGENTS: "analyst;touch-x" }, "TENDER_AGENTS must be agent names"],
    [{ TENDER_AGENTS: "Analyst" }, "TENDER_AGENTS must be agent names"],
    [{ TENDER_AGENTS: " , " }, "TENDER_AGENTS must be agent names"],
    [{ TENDER_NETWORK: "test net" }, "TENDER_NETWORK must be a network name"],
    [{ TENDER_AGENT_FLAGS: "--solver offline" }, "TENDER_AGENT_FLAGS may not hold --agent"],
    [{ TENDER_AGENT_FLAGS: "--network=mainnet" }, "TENDER_AGENT_FLAGS may not hold --agent"],
    [{ TENDER_AGENT_FLAGS: "--daily-entries 3 --agent coder" }, "TENDER_AGENT_FLAGS may not"],
  ];
  for (const [env, sentence] of cases) {
    const run = await startSupervisor(env);
    const ended = await run.ended;

    expect(ended).toEqual({ code: 1, signal: null });
    expect(run.stderr()).toContain(`run-agents: ${sentence}`);
    // The value is named by its variable, never shown (the ones long enough to tell), and no
    // agent was started.
    for (const value of Object.values(env)) {
      if (value.trim().length >= 4) expect(run.stderr()).not.toContain(value.trim());
    }
    expect(run.stdout()).toBe("");
  }
});

test("run_agents_with_none_starts_no_agent_and_waits_to_be_stopped", async () => {
  const run = await startSupervisor({ TENDER_AGENTS: "none" });
  await vi.waitFor(() =>
    expect(run.stdout()).toContain(
      "run-agents: TENDER_AGENTS is none: no agent runs, and this waits to be stopped",
    ),
  );
  // Still up a moment later, so that a volume can be filled meanwhile.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(run.child.exitCode).toBeNull();

  run.child.kill("SIGTERM");

  expect(await run.ended).toEqual({ code: 0, signal: null });
  expect(run.stdout()).not.toContain("stub up");
});

test("run_agents_runs_the_run_agent_command_by_default", { timeout: 120_000 }, async () => {
  // The real agent, from the repository root, with no variables and no env files (an empty
  // TENDER_ENV_DIR, as every test that starts it as a process must give): it says what it lacks and
  // ends with 1, under its name, and the supervisor ends with 1 too.
  const noFiles = await tempDir();
  const run = await startSupervisor({ TENDER_AGENTS: "analyst", TENDER_ENV_DIR: noFiles }, true);

  const ended = await run.ended;

  expect(ended).toEqual({ code: 1, signal: null });
  expect(run.stderr()).toMatch(
    /^\[analyst\] run-agent: missing environment variables: TENDER_CONTRACT, TENDER_API_URL, AGENT_ANALYST_ACCOUNT, AGENT_ANALYST_PRIVATE_KEY, LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, JUDGE_ACCOUNT /m,
  );
  expect(run.stderr()).toContain("run-agents: analyst ended with code 1; stopping the others");
});
