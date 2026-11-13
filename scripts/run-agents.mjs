#!/usr/bin/env node
// The team's reference agents as one service, for a host that runs one command (docs/RUNBOOK.md,
// "11b. Hosting the agents on Railway"; `railway.agents.json` starts this):
//
//   node scripts/run-agents.mjs
//
// It starts one run-agent process for each agent that TENDER_AGENTS names, with the llm solver, and
// prints each line each one writes as `[<name>] <line>`: its stdout to stdout and its stderr to
// stderr. It reads, each one optional:
//
//   TENDER_AGENTS       the agents, by name, separated by commas: analyst,coder,extractor when
//                       unset. `none` starts no agent and waits to be stopped, for a deploy whose
//                       volume is being filled before any agent runs
//   TENDER_NETWORK      the network: testnet when unset
//   TENDER_AGENT_FLAGS  more flags for every agent, separated by spaces (`--daily-entries 10`), but
//                       not --agent, --solver or --network, which are this script's
//
// Everything else (the keys, the model, the API, TENDER_STATE_HOME) each agent reads for itself, as
// `packages/agents/src/cli.ts` says: every agent gets this process's environment as it is. When
// TENDER_STATE_HOME is not set, a warning says that the drafts are kept under the home directory.
//
// Each agent runs `node --import tsx packages/agents/bin/run-agent.ts --agent <name> --solver llm
// --network <network> <flags>` from the repository root: what `pnpm exec tsx` runs, without the two
// processes in front of it. pnpm ends at a SIGTERM while the agent is still stopping, so a
// supervisor that waited for pnpm would not know when the agent has gone. A command after `--` takes
// the place of the part before `--agent` (the tests run a stand-in this way).
//
// How it ends:
// - An agent that ends on its own, with any code, is logged; the others are stopped, and this ends
//   with 1, so that the host restarts the service. It restarts nothing itself.
// - SIGTERM or SIGINT is passed on to every agent once, and this ends with 0 once all have ended.
// - Stopping an agent is that signal (SIGTERM when an agent ended), then SIGKILL 10 s later if the
//   agent is still there.
// - Each agent runs in a process group of its own, which the signals go to, so that a Ctrl-C in a
//   terminal reaches it once, through this process, and not twice. If this process is killed with
//   SIGKILL, its agents are not stopped: in a container they end with the container; elsewhere,
//   stop them by the pids that their start lines print.
//
// It prints no value of the environment: a setting it refuses is named, not shown.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AGENT_COMMAND = [process.execPath, "--import", "tsx", "packages/agents/bin/run-agent.ts"];
const DEFAULT_AGENTS = ["analyst", "coder", "extractor"];
const DEFAULT_NETWORK = "testnet";
/** How long an agent has between the stop signal and SIGKILL. */
const KILL_AFTER_MS = 10_000;
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const NETWORK_NAME = /^[a-z]{1,32}$/;
/** The flags that this script sets, which TENDER_AGENT_FLAGS may not. */
const OWN_FLAGS = ["--agent", "--solver", "--network"];
const USAGE = "usage: node scripts/run-agents.mjs [-- <agent command> [<arg>...]]";

const say = (line) => process.stdout.write(`run-agents: ${line}\n`);
const complain = (line) => process.stderr.write(`run-agents: ${line}\n`);

/** A variable of the environment, trimmed; set to nothing counts as not set. */
const setting = (name) => (process.env[name] ?? "").trim();

/** What to run, from the command line and the environment; a string says what is wrong. */
function readSettings(argv) {
  let command = AGENT_COMMAND;
  if (argv.length > 0) {
    if (argv[0] !== "--" || argv.length < 2) return USAGE;
    command = argv.slice(1);
  }

  const listed = setting("TENDER_AGENTS");
  let agents = DEFAULT_AGENTS;
  if (listed === "none") {
    agents = [];
  } else if (listed !== "") {
    agents = listed
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "");
    if (agents.length === 0 || !agents.every((name) => AGENT_NAME.test(name))) {
      return "TENDER_AGENTS must be agent names separated by commas (analyst,coder,extractor), or none";
    }
    if (new Set(agents).size !== agents.length) {
      return "TENDER_AGENTS names an agent twice, and two processes must never sign with one key";
    }
  }

  const network = setting("TENDER_NETWORK") || DEFAULT_NETWORK;
  if (!NETWORK_NAME.test(network)) return "TENDER_NETWORK must be a network name, such as testnet";

  const flags = setting("TENDER_AGENT_FLAGS")
    .split(/\s+/)
    .filter((flag) => flag !== "");
  const own = (flag) => OWN_FLAGS.some((name) => flag === name || flag.startsWith(`${name}=`));
  if (flags.some(own)) {
    return "TENDER_AGENT_FLAGS may not hold --agent, --solver or --network: this script sets them";
  }

  return { command, agents, network, flags };
}

/** Each line of `stream` to `to`, after `[<name>] `. The last line is printed without its newline too. */
function prefixLines(stream, to, name) {
  createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
    to.write(`[${name}] ${line}\n`);
  });
}

function main() {
  const settings = readSettings(process.argv.slice(2));
  if (typeof settings === "string") {
    complain(settings);
    process.exitCode = 1;
    return;
  }
  const { command, agents, network, flags } = settings;

  /** The agents that have not ended yet, by name. */
  const live = new Map();
  /** The signal the agents were stopped with, once they were. */
  let stopping = null;
  let killTimer;
  let idleTimer;

  /** A signal to the agent's process group: the agent and anything it started. */
  const send = (name, child, signal) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      // The group has gone between the agent's end and its streams' close.
      if (error.code !== "ESRCH") complain(`cannot send ${signal} to ${name} (${error.code})`);
    }
  };

  const finish = () => {
    clearTimeout(killTimer);
    clearInterval(idleTimer);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };

  const stopAll = (signal) => {
    if (stopping !== null) return;
    stopping = signal;
    for (const [name, child] of live) send(name, child, signal);
    killTimer = setTimeout(() => {
      for (const [name, child] of live) {
        complain(`${name} is still running ${KILL_AFTER_MS / 1000} s after ${signal}: SIGKILL`);
        send(name, child, "SIGKILL");
      }
    }, KILL_AFTER_MS);
  };

  function onSignal(signal) {
    // Once: the agents have had it, and a second would end an agent that is still stopping.
    if (stopping !== null) return;
    say(`${signal}: stopping the agents`);
    stopAll(signal);
    if (live.size === 0) finish();
  }
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  if (agents.length === 0) {
    say("TENDER_AGENTS is none: no agent runs, and this waits to be stopped");
    // Holds the process open until a signal comes; finish() clears it.
    idleTimer = setInterval(() => {}, 2 ** 30);
    return;
  }
  if (setting("TENDER_STATE_HOME") === "") {
    process.stderr.write(
      "WARN run-agents: TENDER_STATE_HOME is not set, so each agent keeps its drafts under the " +
        "home directory of the user it runs as: on a host, a redeploy loses them unless a volume " +
        "is mounted there\n",
    );
  }
  say(`starting ${agents.join(", ")}`);

  for (const name of agents) {
    const args = [...command.slice(1), "--agent", name, "--solver", "llm", "--network", network];
    const child = spawn(command[0], [...args, ...flags], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    live.set(name, child);
    prefixLines(child.stdout, process.stdout, name);
    prefixLines(child.stderr, process.stderr, name);

    let ended = false;
    const end = (what) => {
      if (ended) return;
      ended = true;
      live.delete(name);
      if (stopping === null) {
        complain(`${name} ${what}; stopping the others`);
        process.exitCode = 1;
        stopAll("SIGTERM");
      } else {
        say(`${name} ${what}`);
      }
      if (live.size === 0) finish();
    };
    // Its error's code only: the message quotes the command line, flags and all.
    child.once("error", (error) => end(`could not start (${error.code ?? error.name})`));
    // After the agent has ended and its streams have closed, so its last lines are out.
    child.once("close", (code, signal) => {
      end(signal === null ? `ended with code ${code}` : `ended on ${signal}`);
    });
    if (child.pid !== undefined) say(`${name} started, pid ${child.pid}`);
  }
}

main();
