import "./lib/node-check";
import { rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { format, parseArgs, parseEnv } from "node:util";
import {
  AGENTS,
  createOfflineSolver,
  createWeakSolver,
  runAgent,
  type Solver,
} from "@tender/agents";
import {
  ApiClient,
  type LocalChain,
  type LocalRole,
  registerLocalAgent,
  type Signer,
  startLocalChain,
  TenderClient,
} from "@tender/client";
import { createStateStore } from "@tender/mcp";
import {
  formatTokenAmount,
  sha256Hex,
  type TaskDetailResponse,
  type TenderApi,
  tokenMeta,
} from "@tender/shared";
import { JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { addRoleKey } from "./keeper-key";
import { REPO_ROOT } from "./lib/env";
import { demoDir, inOwnProcess } from "./lib/own-process";
import { killStartedProcesses } from "./lib/process-tree";
import { type SeedWindows, seed } from "./seed";
import { redact, type Services, startServices } from "./serve";

/**
 * `pnpm demo:local`: the whole loop of Tender on one machine, for a judge who has Node and pnpm and
 * nothing else. It needs no `.env`, no Rust, no Docker, no Postgres, no LLM key and no private
 * directory: its task is `demo-room-code-regex` of the tracked demo set (`scripts/demo-seeds/`,
 * demo-only, with its held-out checks and its answers in the open), not one of the 30 real seeds,
 * whose checks and solutions are kept out of the repository (seeds/README.md). It starts a
 * local chain (nearcore's sandbox node, with Tender and a test token on it) and the services of
 * `pnpm serve` (the API, the indexer, the keeper and the Judge, on an in-memory PGlite), posts the
 * task `demo-room-code-regex`, and lets two scripted agents enter it: alice, whose answer is right,
 * and bob, whose answer is not. The Judge scores both against the task's held-out checks and picks,
 * and the reward is paid out. The command line prints one line for each step, as the API first
 * shows it:
 *
 *   Scripted demo agents run by the Tender team (offline solvers)
 *   <the line under it, which names the agents>
 *   starting a local NEAR node (<whether it downloads>)
 *   CHAIN sandbox nearcore <the version the node reports>
 *   REGISTERED alice, bob bond=<amount> each
 *   POSTED task=<id> reward=<amount>
 *   STARTED alice
 *   STARTED bob
 *   COMMITTED 2
 *   REVEALED 2
 *   JUDGED winner=alice score=100 runner_up=bob score=<n>
 *   PAID alice=<amount> treasury=<fee>
 *   SCORECARD <uri>
 *   SCORECARD FILE .tender/demo/scorecard.json
 *   DEMO OK
 *
 * The lines come from the API and the chain, and not from what the demo itself did: the counts of
 * workers, commits and reveals on the task, and then its outcome and its scorecard, polled until
 * they show. The line before `CHAIN` comes before the node starts, so that a first run, which
 * downloads the node for minutes on a slow link, does not sit there silent. The scorecard's URI
 * works only while the API runs, so its bytes, checked against the hash the chain pins, are also
 * saved to `.tender/demo/scorecard.json` of the repository (git-ignored), which every run replaces.
 * Three of the lines are to be read with care:
 *
 * - `REGISTERED` is the agents' bond (contract Task 16b). Only a registered agent whose bond the
 *   contract holds may enter an open task, so alice and bob each put the bond in their vaults and
 *   register, as `pnpm agent:register` does for an agent of one's own. It is done after the
 *   services are up, so that the index sees the registrations, and the line is printed when the
 *   API lists both as active with the bond: the status and the bond are the API's.
 *
 * - `STARTED` is the agents' own word. An agent tells the API that it works on a task, and the API
 *   counts those calls: nothing on the chain backs the count, and it names no one. So the agents
 *   start one after the other, and `STARTED alice` is printed when the count reaches 1, with only
 *   alice running, and `STARTED bob` when it reaches 2. The count is the API's, and giving it to
 *   an agent is the demo's.
 * - `PAID` is meant in the contract's sense. The pick credits the winner's share to the winner's
 *   balance in Tender's vault, and the fee to the treasury's, in the transaction that logs it. The
 *   tokens go to a wallet only when the account withdraws them, so no wallet has been paid when the
 *   line is printed.
 *
 * It is plain about who the agents are. The first line says so before any of them starts, and the
 * line after it names them: alice and bob are the Tender team's own agents, they answer from files
 * (`solution.txt` and `weak.txt` of the task) and not from a model, and the API lists them as the
 * team's (`TEAM_ACCOUNTS`). That line says too that the poster and the Judge are the team's: the
 * demo runs both.
 *
 * The task's windows are short (`WINDOWS`) and the Judge looks every second, so a run takes about a
 * minute and a half once nearcore's sandbox node is on the machine (`near-sandbox` downloads it the
 * first time, or takes the binary at `NEAR_SANDBOX_BIN_PATH`, which skips the download). It has
 * that node for Linux (x64, arm64) and macOS (arm64) only: on another machine the demo says so
 * before it starts anything, unless `NEAR_SANDBOX_BIN_PATH` names a node. Every wait has a
 * deadline. When a line does not come, the command line says which one was missed, with the last
 * thing the API showed and the last lines of the services and the agents, and exits with 1; it
 * never hangs.
 *
 * It keeps every file it makes in one temp dir that is new for each run: the key file, the
 * services' deployments folder, the agents' drafts and the home dir of the local node. A draft is
 * filed under the network, the account and the task id, and every local chain has the same accounts
 * and starts its tasks at 1. So the agents never use the store's default folder (`~/.tender`): a
 * draft left there by an earlier run would be taken for this run's own, its agent would skip the
 * task, and the demo would fail. Run again, the demo finds nothing of the last run.
 *
 * The demo runs in a child process that a supervisor starts, passes the stop signals to and cleans
 * up after (`scripts/lib/own-process.ts`): under `pnpm demo:local`, tsx's relay of a Ctrl-C could
 * otherwise kill it with SIGKILL, past its stops.
 *
 * `DEMO OK` is the last line, and it comes only after everything the demo started has stopped and
 * its files are gone, and only if the facts the scenario rests on held: the Judge made the pick,
 * alice won with 100, bob scored lower, the reward was paid out whole, and the scorecard is served
 * at the URI the chain records, with the bytes it is pinned to. Whichever way the demo ends (a
 * SIGINT, SIGTERM, SIGHUP or SIGQUIT included, which stderr answers at once, as the stops take some
 * seconds) the agents, the services and the chain are stopped and the temp dir removed. A second
 * signal more than two seconds after the first skips those orderly stops and ends the process at
 * once, but not before the local node and any other process the demo started are killed, each by
 * its process id, and the temp dir, with the node's home in it, is removed: a node must not outlive
 * the demo, with its CPU and its disk. The demo kills and removes only what it started.
 *
 * `pnpm demo:local --keep` runs the same scenario, and then keeps the local chain and the services
 * up until Ctrl-C (or another stop signal), for the local MCP server of docs/TRY-IT.md ("From an
 * agent, on a local chain"). The scripted agents stop. `lead`, an account of the local chain that the scenario does not
 * use and the API does not list as the team's, registers as an agent with the bond, and its key goes
 * to a file of mode 0600 in the temp dir. The poster posts a second demo task, `KEPT_SEED`, open for
 * half an hour, for that agent to enter. The demo prints the environment of the MCP server (the
 * network, the contract, the RPC URL, the API URL, the Judge, the account, a state dir in the temp
 * dir, and a line that reads the key from its file), the open task (`OPEN task=<id> ...`) and waits. A key of a chain that lives only on
 * this machine, and only until the demo stops, is no secret, but it is not printed all the same:
 * the line names its file. The stop is the end the demo waits for: everything stops, the temp dir
 * with the key goes, and `DEMO OK` comes last, with exit code 0. A stop before the scenario is over
 * is an interruption, as without the flag.
 */

// ---- The scenario ------------------------------------------------------------------------------

/**
 * The task the demo posts: a regex task, which the Judge scores by itself, with no model. It is
 * one of the tracked demo set, whose folders hold everything of a task, held-out checks and
 * solution too, so the demo needs no private directory (see `scripts/demo-seeds/README.md`).
 */
const SEED = "demo-room-code-regex";
const SEEDS_DIR = join(REPO_ROOT, "scripts", "demo-seeds");

/** The start of the name of the run's temp dir, in the OS temp dir. */
const DIR_PREFIX = "tender-demo-";

/**
 * The task `--keep` leaves open for the agent of the MCP server: another of the demo set (its answer
 * is in the open, in `scripts/demo-seeds/`), which the Judge scores by itself, with no model. Its
 * windows leave half an hour to connect an agent and commit, and as long to reveal.
 */
const KEPT_SEED = "demo-divisor-counts";
const KEPT_WINDOWS: SeedWindows = {
  commit_secs: 1_800,
  reveal_secs: 1_800,
  pick_secs: 600,
  fallback_secs: 600,
};

/** The first line the demo prints, before any agent starts. */
const BANNER = "Scripted demo agents run by the Tender team (offline solvers)";

/**
 * The windows of the task, in seconds, in place of the seed's own (10 minutes and more). The
 * sandbox takes none shorter than 5. The agents look every half second and a transaction takes two
 * or three, so 30 s lets both enter even on a slow machine, and the reveal window is wide enough
 * for an upload and a transaction. The Judge judges a task as soon as its reveal window is over: it
 * holds back only for another task of the same poster that shares the held-out checks and
 * whose reveals close by the middle of the pick window (P05-R8), and the demo posts one task.
 * Scoring a regex takes it a second or two, and the pick window is wide so that a slow machine,
 * whose scoring worker starts cold, has room to spare before the Judge's stop line (a tenth of
 * the window, from 3 s to 30 s, before the pick deadline). A wide pick window costs the demo no
 * time, since it ends at the pick. The fallback window is the poster's, and the demo never gets
 * there.
 */
const WINDOWS: SeedWindows = {
  commit_secs: 30,
  reveal_secs: 25,
  pick_secs: 60,
  fallback_secs: 20,
};
/** The agents of the team the demo runs, and how many entries the scenario ends with. */
const ENTRANTS = 2;
const TEAM_AGENTS = ["alice", "bob"] as const;
/**
 * The account `--keep` hands to the MCP server: one of the local chain's that the scenario leaves
 * alone and that `TEAM_ACCOUNTS` does not name, with 10 NEAR and 10^12 of the token from the start.
 */
const KEPT_AGENT = "lead" satisfies LocalRole;

/** Where the scorecard's bytes are saved, in the repository's git-ignored `.tender/`. */
export const SCORECARD_FILE = join(REPO_ROOT, ".tender", "demo", "scorecard.json");

/** How often the Judge and the keeper look. The indexer looks at 5 blocks a second. */
const JUDGE_INTERVAL_MS = 1_000;
const KEEPER_INTERVAL_MS = 1_000;
const INDEXER_POLL_MS = 200;
/** How often an agent looks for tasks to enter and reveals that are due. */
const AGENT_POLL_MS = 500;
/** How often the demo asks the API where the task stands. */
const POLL_MS = 250;

// ---- The deadlines -----------------------------------------------------------------------------

/** How long the local chain may take to start: a first run downloads nearcore's sandbox node. */
const CHAIN_MS = 300_000;
/** How long a step that starts or posts something may take. */
const STEP_MS = 90_000;
/** How long one request to the API may take. */
const API_TIMEOUT_MS = 10_000;
/** How long past a task's deadline a line may take to show: the index trails the chain. */
const SLACK_MS = 30_000;
/** How long stopping a part of the demo may take before the demo goes on without it. */
const STOP_MS = 30_000;
/**
 * How many of the last lines of the services and the agents a failure shows. A clean machine that
 * fails the demo has nothing else to go by: the node's home is gone with the temp dir.
 */
const LOG_TAIL = 200;

/**
 * How soon after a signal another counts as the same interruption. One Ctrl-C reaches the demo more
 * than once: the terminal sends SIGINT to every process of the command, tsx's among them, and tsx
 * relays it to the demo as well. A signal after this long is a second Ctrl-C, and ends the demo at
 * once.
 */
const REPEAT_SIGNAL_MS = 2_000;

/**
 * The signals that stop the demo, with the exit code of each: 128 plus the signal's number. SIGHUP
 * is a closed terminal and SIGQUIT is Ctrl-\. Left alone, either would end the process without the
 * stops, and the local node would stay.
 */
const STOP_SIGNALS = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 } as const;
type StopSignal = keyof typeof STOP_SIGNALS;

// ---- What the demo says ------------------------------------------------------------------------

/** One line of the demo's output. What its parts print besides goes to the log. */
export const say = (line: string) => process.stdout.write(`${line}\n`);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A step of the scenario that did not come to pass: a line that did not show in time, or a fact the
 * API shows that the scenario cannot have. Its message is for the person who ran the demo.
 */
export class DemoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoError";
  }
}

/** What aborts the demo when a signal that stops it comes. */
class Interrupted extends Error {
  readonly signalName: StopSignal;

  constructor(signalName: StopSignal) {
    super(`interrupted by ${signalName}`);
    this.name = "Interrupted";
    this.signalName = signalName;
  }
}

// ---- The harness -------------------------------------------------------------------------------

/** What every step of the demo shares: the way out, the log, and the things to stop at the end. */
export interface Harness {
  /** Aborts when the demo is interrupted or something it runs fails; its reason is the error. */
  readonly signal: AbortSignal;
  /** Ends the demo from outside its main flow: a loop that crashed, an error nobody caught. */
  fail(error: unknown): void;
  /** Receives what the services, the agents and the packages print: shown if the demo fails. */
  log(line: string): void;
  /** Registers what to do when the demo is over, however it ends. The last in is the first out. */
  onExit(what: string, step: () => Promise<unknown>): void;
  /**
   * Registers what to do as the process ends, after the orderly steps of `onExit`, or in place of
   * them when a second signal cuts them short. It cannot wait for anything. The last in is the
   * first out.
   */
  onProcessExit(step: () => void): void;
  /**
   * Waits until the demo is stopped, and makes a stop by a signal from now on the end the demo
   * waits for, and no interruption: `--keep`. It resolves however the demo is stopped; one that
   * something it runs failed still fails.
   */
  untilStopped(): Promise<void>;
}

/**
 * `work`, or a `DemoError` after `ms`, or the reason of `signal` once it aborts. The work is not
 * cancelled when the race is lost: what it gives later goes nowhere.
 */
export function limited<T>(
  what: string,
  ms: number,
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DemoError(`${what} took over ${Math.round(ms / 1000)} s`)),
      ms,
    );
    const onAbort = () => reject(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
  });
}

/** What a probe of `until` says: the value, once the API shows it, or what the API shows instead. */
export type Poll<T> = { value: T } | { seen: string };

/** The answer of a probe that has what it waits for. */
export const ready = <T>(value: T): Poll<T> => ({ value });
/** The answer of a probe that has not, and says what it sees instead. */
export const waiting = (seen: string): Poll<never> => ({ seen });

/**
 * Asks `probe` every `POLL_MS` until it has a value, for at most `budgetMs`. A probe that cannot
 * reach the API is asked again; one that throws a `DemoError` ends the wait with it. When the time
 * is out, the error names the milestone that was missed and the last thing the API showed.
 */
export async function until<T>(
  h: Harness,
  milestone: string,
  budgetMs: number,
  probe: () => Promise<Poll<T>>,
): Promise<T> {
  const giveUpAt = Date.now() + budgetMs;
  let last = "nothing yet";
  for (;;) {
    h.signal.throwIfAborted();
    try {
      const polled = await probe();
      if ("value" in polled) return polled.value;
      last = polled.seen;
    } catch (error) {
      h.signal.throwIfAborted();
      if (error instanceof DemoError) throw error;
      last = `the API did not answer: ${messageOf(error).split("\n")[0]}`;
    }
    if (Date.now() >= giveUpAt) {
      throw new DemoError(
        `missed ${milestone}: not shown within ${Math.round(budgetMs / 1000)} s (${last})`,
      );
    }
    // An abort ends the wait here, and the next lap throws its reason.
    await delay(POLL_MS, undefined, { signal: h.signal }).catch(() => undefined);
  }
}

/** The milliseconds since the epoch of a deadline in nanoseconds, as the API writes one. */
const msOf = (ns: string) => Number(BigInt(ns) / 1_000_000n);

/** How long from now a line may take to show, when it is due by `deadlineNs`. */
export const budgetFor = (deadlineNs: string) =>
  Math.max(SLACK_MS, msOf(deadlineNs) - Date.now() + SLACK_MS);

/** `amount` of `token` as a line writes it: `0.95 tUSDC`. */
export function amountOf(amount: string | bigint, token: string): string {
  const { symbol, decimals } = tokenMeta(token, "sandbox");
  return `${formatTokenAmount(amount, decimals)} ${symbol}`;
}

/** The role of the chain's account that `account` is (`alice`), or the account itself. */
export function nameOf(chain: LocalChain, account: string): string {
  const roles = Object.keys(chain.accounts) as LocalRole[];
  return roles.find((role) => chain.accounts[role].accountId === account) ?? account;
}

// ---- The parts ---------------------------------------------------------------------------------

/** The version of nearcore the node says it runs. */
export async function nodeVersion(rpcUrl: string): Promise<string> {
  const status = await new JsonRpcProvider({ url: rpcUrl }).viewNodeStatus();
  return status.version.version;
}

/**
 * The machines near-sandbox has nearcore's sandbox node for, as `process.platform/process.arch`.
 * On any other it throws, once it has to build the URL of the download.
 */
const NODE_HOSTS: readonly string[] = ["linux/x64", "linux/arm64", "darwin/arm64"];

/** What a node of one's own does for the demo, in the words of the failure that points to it. */
const OWN_NODE =
  "NEAR_SANDBOX_BIN_PATH names a sandbox node you already have and skips the download";

/**
 * Throws a `DemoError` in plain words if nearcore's sandbox node is neither at hand nor to be had
 * for this machine, so that nothing is started first. A node of one's own (`NEAR_SANDBOX_BIN_PATH`)
 * or a place to fetch one from (`SANDBOX_ARTIFACT_URL`) is taken as it is: near-sandbox asks what
 * the machine is only to build its own download URL.
 */
export function checkHost(): void {
  if (process.env.NEAR_SANDBOX_BIN_PATH || process.env.SANDBOX_ARTIFACT_URL) return;
  const host = `${process.platform}/${process.arch}`;
  if (NODE_HOSTS.includes(host)) return;
  throw new DemoError(
    "the local chain runs on nearcore's sandbox node, which near-sandbox has only for Linux " +
      `(x64, arm64) and macOS (arm64), and this Node runs on ${host}. Set NEAR_SANDBOX_BIN_PATH ` +
      "to a sandbox node you already have to run the demo here.",
  );
}

/** The first line of `text`, without the full stop that ends it. */
const firstLineOf = (text: string) => (text.split("\n")[0] ?? "").replace(/\.$/, "");

/**
 * What a failed start of the local chain says, on one line: the reason near-sandbox gives, the
 * cause under it (a download that failed says why there), and, unless a node of one's own was
 * named, the way round the download that the first run makes.
 */
function startFailure(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const why = cause === undefined ? "" : ` (${firstLineOf(messageOf(cause))})`;
  const way = process.env.NEAR_SANDBOX_BIN_PATH
    ? ""
    : ` The first run downloads the node: ${OWN_NODE}.`;
  return `the local chain did not start: ${firstLineOf(messageOf(error))}${why}.${way}`;
}

/**
 * Starts the local node with the OS temp dir pointed at `tmp` for as long as that takes.
 * near-sandbox makes the node's home dir, and the lock files of its ports, in the OS temp dir. So
 * they are made inside the demo's own temp dir and go with it, also when the node is beyond being
 * stopped: after a second signal, or when its start failed and left it running. Nothing else may
 * use the OS temp dir while this runs, and a download can make that minutes: what it made there
 * would land in the node's dir and go with it.
 */
async function startNode(tmp: string): Promise<LocalChain> {
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    return await startLocalChain();
  } catch (error) {
    throw new DemoError(startFailure(error));
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "TMPDIR");
    else process.env.TMPDIR = saved;
  }
}

/**
 * The line the demo prints before the node starts. near-sandbox does not say when it downloads the
 * node, so the line says when it does: the first time a node starts in an install, with no
 * `NEAR_SANDBOX_BIN_PATH`. The archive is 29 to 35 MB, by machine, and the node 71.5 MB on disk;
 * a first run on a slow link prints nothing else for minutes.
 */
export function nodeStartLine(env: Record<string, string | undefined> = process.env): string {
  return env.NEAR_SANDBOX_BIN_PATH
    ? "starting a local NEAR node (the one NEAR_SANDBOX_BIN_PATH names)"
    : "starting a local NEAR node (the first run downloads it: about 30 MB, 70 MB on disk; " +
        "later runs skip this)";
}

/**
 * Starts the local chain, and sees to its stop. The node is a child of this process, and the end of
 * the process kills it unless it is known to have been stopped: a second signal skips the orderly
 * stops, and near-sandbox leaves the node running when its start fails.
 */
export async function startChain(h: Harness, tmp: string): Promise<LocalChain> {
  say(nodeStartLine());
  let stopped = false;
  h.onProcessExit(() => {
    // Every process below this one, by id: the node, and what else the demo started. They are listed
    // with `ps`, or from `/proc` on a host without it, and left alone where neither can be read.
    if (!stopped) killStartedProcesses();
  });
  const starting = startNode(tmp);
  // Also a chain that is still starting when the demo ends: it is stopped as soon as it is up.
  h.onExit("stop the chain", async () => {
    const chain = await starting.catch(() => undefined);
    await chain?.stop();
    // A start that failed leaves no chain to stop, and near-sandbox can leave its node running: the
    // end of the process looks for that one.
    stopped = chain !== undefined;
  });
  return limited("starting the local chain", CHAIN_MS, starting, h.signal);
}

/**
 * The keeper's and the Judge's keys, as the key script makes them for a chain: function-call keys
 * limited to Tender for the methods of their roles, which the script adds to the accounts and writes
 * to an env file in `dir`, as it does for the deploy.
 */
async function mintServiceKeys(
  chain: LocalChain,
  dir: string,
): Promise<{ keeper: string; judge: string }> {
  const { keeper, judge } = chain.accounts;
  const file = join(dir, ".env.deploy.sandbox");
  await mkdir(dir, { recursive: true });
  await writeFile(
    file,
    [
      `TENDER_CONTRACT=${chain.contractId}`,
      `KEEPER_ACCOUNT=${keeper.accountId}`,
      `KEEPER_FULL_ACCESS_KEY=${keeper.privateKey}`,
      `JUDGE_ACCOUNT=${judge.accountId}`,
      `JUDGE_FULL_ACCESS_KEY=${judge.privateKey}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const target = { network: chain.network, rpcUrl: chain.rpcUrl, contractId: chain.contractId };
  // One after the other: both write to the one env file.
  await addRoleKey("keeper", target, { dir, log: () => undefined });
  await addRoleKey("judge", target, { dir, log: () => undefined });
  const written = parseEnv(await readFile(file, "utf8"));
  const keys = { keeper: written.KEEPER_PRIVATE_KEY, judge: written.JUDGE_PRIVATE_KEY };
  if (keys.keeper === undefined || keys.judge === undefined) {
    throw new DemoError("the key script did not write KEEPER_PRIVATE_KEY and JUDGE_PRIVATE_KEY");
  }
  return { keeper: keys.keeper, judge: keys.judge };
}

/**
 * Starts the services of `pnpm serve` on the chain, with an in-memory database and a free port, the
 * keeper and the Judge on their scoped keys and no model, and sees to their stop. It resolves once
 * the index follows the chain: the indexer starts at the chain's height of that moment, so the task
 * is posted only after that.
 */
export async function startUp(
  h: Harness,
  chain: LocalChain,
  dir: string,
  team: readonly LocalRole[] = ["poster", "alice", "bob"],
): Promise<{ services: Services; reader: TenderApi }> {
  const keysDir = join(dir, "keys");
  // Empty on purpose: a record of a deploy would tell the indexer where to start, and on the
  // sandbox it starts at the chain's final height.
  const deploymentsDir = join(dir, "deployments");
  await mkdir(deploymentsDir, { recursive: true });
  const keys = await limited(
    "minting the keeper's and the Judge's keys",
    STEP_MS,
    mintServiceKeys(chain, keysDir),
    h.signal,
  );

  const { keeper, judge } = chain.accounts;
  const env: Record<string, string> = {
    TENDER_NETWORK: chain.network,
    TENDER_CONTRACT: chain.contractId,
    NEAR_RPC_URL: chain.rpcUrl,
    DATABASE_URL: "pglite:memory",
    API_PORT: "0",
    INDEXER_POLL_MS: `${INDEXER_POLL_MS}`,
    KEEPER_ACCOUNT: keeper.accountId,
    KEEPER_PRIVATE_KEY: keys.keeper,
    KEEPER_INTERVAL_MS: `${KEEPER_INTERVAL_MS}`,
    JUDGE_ACCOUNT: judge.accountId,
    JUDGE_PRIVATE_KEY: keys.judge,
    JUDGE_INTERVAL_MS: `${JUDGE_INTERVAL_MS}`,
    // The accounts the team runs: the API flags them, and the poster's task, as the team's.
    TEAM_ACCOUNTS: team.map((role) => chain.accounts[role].accountId).join(","),
  };
  const starting = startServices(env, {
    log: (line) => h.log(redact(line, env)),
    deploymentsDir,
  });
  h.onExit("stop the services", async () => {
    const services = await starting.catch(() => undefined);
    await services?.stop();
  });
  const services = await limited("starting the services", STEP_MS, starting, h.signal);

  const reader = new ApiClient({
    baseUrl: services.publicUrl,
    timeoutMs: API_TIMEOUT_MS,
    signal: h.signal,
  });
  await until(h, "the index following the chain", STEP_MS, async () => {
    const health = await reader.health();
    if (BigInt(health.indexed_height) > 0n && BigInt(health.lag_blocks) < 20n) return ready(health);
    return waiting(`indexed height ${health.indexed_height}, ${health.lag_blocks} blocks behind`);
  });
  return { services, reader };
}

/** Posts the demo seed `slug` (`SEED` by default) as the poster, and gives the id of the task. */
async function postSeed(
  h: Harness,
  chain: LocalChain,
  services: Services,
  slug: string = SEED,
  windows: SeedWindows = WINDOWS,
): Promise<bigint> {
  const { poster, judge } = chain.accounts;
  const client = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer: poster,
  });
  const api = new ApiClient({
    baseUrl: services.publicUrl,
    signer: poster,
    timeoutMs: API_TIMEOUT_MS,
    signal: h.signal,
  });
  const seeded = await limited(
    `posting the seed ${slug}`,
    STEP_MS,
    seed({
      client,
      api,
      network: chain.network,
      poster: poster.accountId,
      judgeAccount: judge.accountId,
      tokenId: chain.tokenId,
      seedsDir: SEEDS_DIR,
      // The demo set keeps its held-out checks beside the briefs; nothing is read from outside it.
      heldoutDir: SEEDS_DIR,
      only: [slug],
      windows,
      log: h.log,
    }),
    h.signal,
  );
  const posted = seeded.filter((task) => task.status === "posted");
  const [task] = posted;
  if (task === undefined || posted.length !== 1 || task.slug !== slug) {
    const got = seeded.map((one) => `${one.slug} ${one.status} as task ${one.taskId}`).join(", ");
    throw new DemoError(
      `expected the seed ${slug} to be posted once, but got: ${got || "nothing"}`,
    );
  }
  return task.taskId;
}

/** The task as the API shows it; undefined while the API does not list it. */
export async function readTask(
  api: TenderApi,
  id: bigint,
): Promise<TaskDetailResponse | undefined> {
  const found = await api.getTask(id);
  if (found === null) return undefined;
  // Nothing that follows can come once the Judge has turned the task down, or the task is void.
  const { judge_status: status, judge_reason: reason, outcome } = found.task;
  if (status === "rejected" || status === "failed_closed") {
    throw new DemoError(
      `the Judge turned task ${id} down (${status}${reason ? `: ${reason}` : ""})`,
    );
  }
  if (outcome?.kind === "voided") {
    throw new DemoError(`task ${id} was voided (${outcome.reason}) and not picked`);
  }
  return found;
}

/** One agent of the team: the account it signs as, and the solver that gives its answers. */
interface Agent {
  name: string;
  signer: Signer;
  solver: Solver;
}

/** Starts the agent's loop, which runs until `stop` aborts, and ends the demo if it crashes. */
function launchAgent(
  h: Harness,
  o: { agent: Agent; chain: LocalChain; baseUrl: string; stateDir: string; stop: AbortSignal },
): Promise<void> {
  const { agent, chain } = o;
  const client = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer: agent.signer,
  });
  const api = new ApiClient({
    baseUrl: o.baseUrl,
    signer: agent.signer,
    timeoutMs: API_TIMEOUT_MS,
  });
  return runAgent({
    name: agent.name,
    client,
    api,
    // In this run's temp dir and never the store's default folder: see the top of this file.
    state: createStateStore(join(o.stateDir, agent.name)),
    // The tags of the reference coder agent: the task is a coding task, a regex.
    tags: AGENTS.coder.tags,
    solver: agent.solver,
    pollMs: AGENT_POLL_MS,
    log: h.log,
    signal: o.stop,
  }).catch((error: unknown) => h.fail(error));
}

/** Fetches `url` and gives the bytes it serves. */
export async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!res.ok) throw new DemoError(`${url} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** `path` as a line shows it: from the working directory when it is under it, else whole. */
const shown = (path: string) => {
  const from = relative(process.cwd(), path);
  return from === "" || from.startsWith("..") ? path : from;
};

/** Saves the scorecard's bytes to `SCORECARD_FILE`, and gives the path as the line shows it. */
async function saveScorecard(bytes: Uint8Array): Promise<string> {
  await mkdir(join(SCORECARD_FILE, ".."), { recursive: true, mode: 0o700 });
  await writeFile(SCORECARD_FILE, bytes);
  return shown(SCORECARD_FILE);
}

/** `text` as one word of a POSIX shell: as it is when it is plain, else in single quotes. */
export function shellWord(text: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

/** What `--keep` hands to the MCP server. */
export interface Kept {
  rpcUrl: string;
  apiUrl: string;
  contractId: string;
  judgeAccount: string;
  account: string;
  /** The key file of `account`: `privateKey` in it is the key. */
  keyFile: string;
  stateDir: string;
  /** What the account holds, in words, for the line about it. */
  holds: string;
  /** The open task for the account to enter, with its deadlines as ISO 8601 times. */
  open: { id: string; title: string; commitUntil: string; revealUntil: string; seed: string };
}

/**
 * The lines `--keep` prints: the environment of the local MCP server (docs/MCP.md), word for word as
 * a shell takes it, the command that starts it, and what the account is.
 */
export function keptLines(kept: Kept): string[] {
  const readKey =
    `node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).privateKey' ` +
    shellWord(kept.keyFile);
  return [
    "KEPT the local chain and the services, until Ctrl-C. To try them from an agent, start the MCP " +
      "server (docs/MCP.md) from the repository root, in another terminal:",
    "  export TENDER_NETWORK=sandbox",
    `  export TENDER_CONTRACT=${shellWord(kept.contractId)}`,
    `  export NEAR_RPC_URL=${shellWord(kept.rpcUrl)}`,
    `  export TENDER_API_URL=${shellWord(kept.apiUrl)}`,
    `  export TENDER_JUDGE_ACCOUNT=${shellWord(kept.judgeAccount)}`,
    `  export TENDER_ACCOUNT=${shellWord(kept.account)}`,
    `  export TENDER_STATE_DIR=${shellWord(kept.stateDir)}`,
    `  export TENDER_PRIVATE_KEY="$(${readKey})"`,
    "  pnpm --silent tsx packages/mcp/bin/tender-mcp.ts",
    `OPEN task=${kept.open.id} "${kept.open.title}" commits until ${kept.open.commitUntil}, ` +
      `reveals until ${kept.open.revealUntil}`,
    `${kept.account} is an account of this local chain, registered as an agent with the bond, and ` +
      `holds ${kept.holds}. Its full-access key is in ${kept.keyFile} (a key of this local chain ` +
      `only). Task ${kept.open.id} is open for it, posted by the team's poster for the Judge to ` +
      "score: enter it with commit_result, and reveal_result once its commit window has closed. Its " +
      `answer is in the open, in scripts/demo-seeds/${kept.open.seed} (a demo task). The account ` +
      "can also post tasks of its own, and cannot enter those. Ctrl-C stops the chain and the " +
      "services and removes these files.",
  ];
}

/**
 * `--keep`: the scripted agents stop, `KEPT_AGENT` registers as an agent with the bond, the poster
 * posts `KEPT_SEED` with `KEPT_WINDOWS` for it to enter, its key is written to a file in `dir`, the
 * lines for the MCP server are printed, and the demo waits to be stopped. A failure of the services
 * in the meantime ends it, as a failure.
 */
async function keepUp(
  h: Harness,
  o: {
    chain: LocalChain;
    services: Services;
    reader: TenderApi;
    dir: string;
    agents: () => Promise<void>;
  },
): Promise<void> {
  const { chain, services, reader, dir } = o;
  await limited("stopping the scripted agents", STOP_MS, o.agents(), h.signal);

  const signer = chain.accounts[KEPT_AGENT];
  await limited(
    `registering ${KEPT_AGENT} with a bond`,
    STEP_MS,
    registerLocalAgent(chain, KEPT_AGENT),
    h.signal,
  );
  await until(h, `${KEPT_AGENT} registered`, STEP_MS, async () => {
    const listed = await reader.getAgent(signer.accountId);
    return listed?.agent.status === "active"
      ? ready(listed)
      : waiting(`the API does not list ${KEPT_AGENT} as active yet`);
  });

  // A task for that agent to enter, open long enough to connect it and work; the Judge scores it.
  const openId = await postSeed(h, chain, services, KEPT_SEED, KEPT_WINDOWS);
  const open = await until(h, `task ${openId} open and accepted`, STEP_MS, async () => {
    const found = await readTask(reader, openId);
    return found?.task.judge_status === "accepted"
      ? ready(found.task)
      : waiting(
          `the Judge's status of task ${openId} is ${found?.task.judge_status ?? "none yet"}`,
        );
  });
  const isoOf = (ns: string) => new Date(msOf(ns)).toISOString();

  const keepDir = join(dir, "keep");
  await mkdir(keepDir, { mode: 0o700 });
  const keyFile = join(keepDir, `${KEPT_AGENT}.json`);
  const publicKey = KeyPair.fromString(signer.privateKey as KeyPairString)
    .getPublicKey()
    .toString();
  await writeFile(
    keyFile,
    `${JSON.stringify(
      {
        version: 1,
        name: KEPT_AGENT,
        network: chain.network,
        account: signer.accountId,
        publicKey,
        privateKey: signer.privateKey,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const client = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
  });
  const wallet = await limited(
    `reading what ${KEPT_AGENT} holds`,
    API_TIMEOUT_MS,
    client.ftBalanceOf(chain.tokenId, signer.accountId),
    h.signal,
  );
  for (const line of keptLines({
    rpcUrl: chain.rpcUrl,
    apiUrl: services.publicUrl,
    contractId: chain.contractId,
    judgeAccount: chain.accounts.judge.accountId,
    account: signer.accountId,
    keyFile,
    stateDir: join(dir, "mcp-state"),
    holds: `${amountOf(wallet, chain.tokenId)} in its wallet, and NEAR for gas and storage`,
    open: {
      id: open.id,
      title: open.title ?? KEPT_SEED,
      commitUntil: isoOf(open.commit_deadline),
      revealUntil: isoOf(open.reveal_deadline),
      seed: KEPT_SEED,
    },
  })) {
    say(line);
  }
  void services.failed.then((error) => h.fail(error));
  await h.untilStopped();
}

// ---- The scenario, step by step ----------------------------------------------------------------

/** What `pnpm demo:local` takes on its command line. */
export interface DemoOptions {
  /** Keep the chain and the services up after the scenario, until a stop signal. */
  keep?: boolean;
}

/**
 * The flags of `pnpm demo:local`. Throws, with the usage, on any other. A `--` before them, as in
 * `pnpm demo:local -- --keep`, which pnpm passes on, is no argument.
 */
export function demoOptionsOf(args: readonly string[]): DemoOptions {
  const given = args[0] === "--" ? args.slice(1) : [...args];
  try {
    const { values } = parseArgs({ args: given, options: { keep: { type: "boolean" } } });
    return { keep: values.keep === true };
  } catch (error) {
    throw new DemoError(`${messageOf(error)}\nusage: pnpm demo:local [--keep]`);
  }
}

async function demo(h: Harness, options: DemoOptions = {}): Promise<void> {
  checkHost();
  say(BANNER);
  say(
    "alice and bob are the Tender team's own scripted agents: alice enters the seed's stored " +
      "right answer, bob its stored weak one. No model runs, and neither is an independent " +
      "entrant. The poster and the Judge are the team's too.",
  );

  // The demo's own files (keys, deployments folder, drafts, the node's home) are all in here, new
  // for each run. The path is absolute, so that the removal as the process ends does not depend on
  // where the process is by then.
  // The supervisor makes it, and removes it too if this process is killed past its stops (`demoDir`).
  const dir = await demoDir(DIR_PREFIX);
  h.onExit("remove the temp files", () => rm(dir, { recursive: true, force: true }));
  // Also when the demo is cut short before its steps have run (a second Ctrl-C). A node that was
  // killed a moment ago can still be writing, so the removal tries again.
  h.onProcessExit(() =>
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  const nodeTmp = join(dir, "node");
  await mkdir(nodeTmp);

  const chain = await startChain(h, nodeTmp);
  const version = await limited(
    "asking the node for its version",
    API_TIMEOUT_MS,
    nodeVersion(chain.rpcUrl),
    h.signal,
  );
  say(`CHAIN ${chain.network} nearcore ${version}`);

  const { services, reader } = await startUp(h, chain, dir);

  // The two agents register with a bond before the task is posted: an open task takes no one else.
  await limited(
    "registering alice and bob with a bond",
    STEP_MS,
    Promise.all(TEAM_AGENTS.map((role) => registerLocalAgent(chain, role, AGENTS.coder.tags))),
    h.signal,
  );
  const bonded = await until(h, "REGISTERED", STEP_MS, async () => {
    const listed = await Promise.all(
      TEAM_AGENTS.map((role) => reader.getAgent(chain.accounts[role].accountId)),
    );
    const missing = TEAM_AGENTS.filter((_, i) => listed[i]?.agent.status !== "active");
    const bond = listed[0]?.agent.bond_amount;
    return missing.length > 0 || bond === undefined || bond === null
      ? waiting(`the API does not list ${missing.join(" and ")} as active with a bond yet`)
      : ready(bond);
  });
  say(`REGISTERED ${TEAM_AGENTS.join(", ")} bond=${amountOf(bonded, chain.tokenId)} each`);

  const taskId = await postSeed(h, chain, services);
  const task = await until(h, "POSTED", STEP_MS, async () => {
    const found = await readTask(reader, taskId);
    return found === undefined
      ? waiting(`the API does not list task ${taskId} yet`)
      : ready(found.task);
  });
  say(`POSTED task=${task.id} reward=${amountOf(task.reward, task.token)}`);

  // The agents start one after the other: the API says how many are working on the task and not
  // which, so with one running, a count of 1 is that one's.
  const stopAgents = new AbortController();
  const loops: Promise<void>[] = [];
  const stopTheAgents = async () => {
    stopAgents.abort();
    await Promise.all(loops);
  };
  h.onExit("stop the agents", stopTheAgents);
  const agents: Agent[] = [
    { name: "alice", signer: chain.accounts.alice, solver: createOfflineSolver(SEEDS_DIR) },
    { name: "bob", signer: chain.accounts.bob, solver: createWeakSolver(SEEDS_DIR) },
  ];
  for (const [index, agent] of agents.entries()) {
    loops.push(
      launchAgent(h, {
        agent,
        chain,
        baseUrl: services.publicUrl,
        stateDir: join(dir, "agents"),
        stop: stopAgents.signal,
      }),
    );
    const running = index + 1;
    await until(h, `STARTED ${agent.name}`, budgetFor(task.commit_deadline), async () => {
      const working = (await readTask(reader, taskId))?.task.working_count ?? 0;
      return working >= running
        ? ready(working)
        : waiting(`${working} of ${running} agents working on the task`);
    });
    say(`STARTED ${agent.name}`);
  }

  await until(h, `COMMITTED ${ENTRANTS}`, budgetFor(task.commit_deadline), async () => {
    const found = await readTask(reader, taskId);
    const commits = found?.task.commit_count ?? 0;
    if (found === undefined || commits < ENTRANTS) {
      return waiting(`${commits} of ${ENTRANTS} committed`);
    }
    // The banner says the entrants are the team's own agents, and the API has to say it too.
    const strangers = found.entries.filter((entry) => !entry.is_team);
    if (commits > ENTRANTS || strangers.length > 0) {
      const who = strangers.map((entry) => entry.account).join(", ") || "more than two";
      throw new DemoError(`the task has entrants besides the team's two scripted agents: ${who}`);
    }
    return ready(commits);
  });
  say(`COMMITTED ${ENTRANTS}`);

  await until(h, `REVEALED ${ENTRANTS}`, budgetFor(task.reveal_deadline), async () => {
    const reveals = (await readTask(reader, taskId))?.task.reveal_count ?? 0;
    return reveals >= ENTRANTS ? ready(reveals) : waiting(`${reveals} of ${ENTRANTS} revealed`);
  });
  say(`REVEALED ${ENTRANTS}`);

  const settled = await until(h, "JUDGED", budgetFor(task.pick_deadline), async () => {
    const found = await readTask(reader, taskId);
    if (found === undefined) return waiting(`the API does not list task ${taskId}`);
    const { outcome, phase, judge_status: status } = found.task;
    if (outcome?.kind !== "picked") {
      return waiting(`the task is ${phase}, the Judge's status is ${status ?? "none yet"}`);
    }
    if (found.scorecard === null) return waiting("the task is picked, its scorecard is not shown");
    return ready({ outcome, scorecard: found.scorecard });
  });
  const { outcome, scorecard } = settled;
  // `JUDGED` says the Judge picked. The contract lets the poster pick too, once the pick window is
  // over, and the index has no picker for an outcome it took from the chain's state (`by` is null).
  if (outcome.by !== null && outcome.by !== chain.accounts.judge.accountId) {
    throw new DemoError(`task ${taskId} was picked by ${outcome.by} and not by the Judge`);
  }

  // The scorecard lists its entries as ranked (`rankEntries`: score descending, then the earlier
  // commit, then the account by UTF-16 code units), so its own order is the ranking. Sorting again
  // here, with `localeCompare` for the tie-break, could disagree with it.
  const ranked = scorecard.entries;
  const [winner, ...otherWinners] = outcome.winners;
  const winnerEntry = ranked.find((entry) => entry.account === winner?.account);
  const runnerUp = ranked.find((entry) => entry.account !== winner?.account);
  if (winner === undefined || winnerEntry === undefined || runnerUp === undefined) {
    throw new DemoError("the scorecard does not show a winner and a runner-up");
  }
  const winnerName = nameOf(chain, winner.account);
  const runnerUpName = nameOf(chain, runnerUp.account);
  say(
    `JUDGED winner=${winnerName} score=${winnerEntry.score} ` +
      `runner_up=${runnerUpName} score=${runnerUp.score}`,
  );
  if (winnerName !== "alice" || winnerEntry.score !== 100 || otherWinners.length > 0) {
    throw new DemoError("expected alice to win alone with a score of 100");
  }
  if (runnerUpName !== "bob" || runnerUp.score >= 100) {
    throw new DemoError("expected bob to be the runner-up with a score below 100");
  }

  say(
    `PAID ${winnerName}=${amountOf(winner.amount, task.token)} ` +
      `treasury=${amountOf(outcome.fee, task.token)}`,
  );
  const paid = outcome.winners.reduce((sum, one) => sum + BigInt(one.amount), BigInt(outcome.fee));
  if (paid !== BigInt(task.reward)) {
    throw new DemoError(`the payouts and the fee make ${paid}, and the reward was ${task.reward}`);
  }

  say(`SCORECARD ${outcome.scorecard_uri}`);
  const served = await limited(
    "fetching the scorecard",
    API_TIMEOUT_MS,
    fetchBytes(outcome.scorecard_uri),
    h.signal,
  );
  if (sha256Hex(served) !== outcome.scorecard_hash) {
    throw new DemoError("the scorecard at its URI is not the one the chain pins to its hash");
  }
  // The URI works only while the API runs; the file stays.
  say(`SCORECARD FILE ${await saveScorecard(served)}`);

  if (options.keep === true) {
    await keepUp(h, { chain, services, reader, dir, agents: stopTheAgents });
  }
}

// ---- The command line --------------------------------------------------------------------------

/** The methods of `console` that print, which the demo routes to its log. */
type Printer = Pick<Console, "log" | "info" | "warn" | "error" | "debug">;

/**
 * Makes what `target` prints through its methods go to `sink`: the Judge and the packages print to
 * the console of their own, and the demo's output is its own lines. Gives the way back.
 */
function captureConsole(sink: (line: string) => void, target: Printer = console): () => void {
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const saved = methods.map((method) => [method, target[method]] as const);
  for (const method of methods) target[method] = (...args: unknown[]) => sink(format(...args));
  return () => {
    for (const [method, original] of saved) target[method] = original;
  };
}

/** What a failure says: a `DemoError` by its message, any other error with its stack. */
function reasonOf(error: unknown): string {
  if (error instanceof DemoError) return error.message;
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/** Runs the steps registered with `onExit`, the last one first, each for at most `STOP_MS`. */
async function runExitSteps(
  steps: ReadonlyArray<{ what: string; step: () => Promise<unknown> }>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const { what, step } of [...steps].reverse()) {
    try {
      await limited(`the step to ${what}`, STOP_MS, step());
    } catch (error) {
      problems.push(`could not ${what}: ${messageOf(error)}`);
    }
  }
  return problems;
}

/** Waits until what was written to `stream` has been handed to the system. */
const flush = (stream: NodeJS.WriteStream) =>
  new Promise<void>((resolve) => stream.write("", () => resolve()));

/**
 * What `main` runs: the steps of a scenario, and the words the command line ends in. `pnpm
 * demo:local` is `DEMO_SCRIPT`; the swarm demo (`scripts/swarm-demo.ts`) runs its own scenario
 * through the same `main`, so both start, stop and fail the same way.
 */
export interface DemoScript {
  /** The steps. A `DemoError` is a step that did not come to pass; its message is shown as it is. */
  run(h: Harness): Promise<void>;
  /** The last line, printed only after everything the demo started has stopped. */
  ok: string;
  /** The prefix of each line of a failure: `DEMO FAILED`. */
  failed: string;
  /** The prefix of the lines on stderr about a signal: `demo`. */
  name: string;
}

/** `pnpm demo:local`, with its flags. */
export const demoScript = (options: DemoOptions = {}): DemoScript => ({
  run: (h) => demo(h, options),
  ok: "DEMO OK",
  failed: "DEMO FAILED",
  name: "demo",
});

const DEMO_SCRIPT = demoScript();

/** Runs a scenario and gives the exit code: 0 after its `ok` line, else not. */
export async function main(script: DemoScript = DEMO_SCRIPT): Promise<number> {
  const abort = new AbortController();
  const exits: Array<{ what: string; step: () => Promise<unknown> }> = [];
  const processExits: Array<() => void> = [];
  const tail: string[] = [];
  const record = (line: string) => {
    tail.push(line);
    if (tail.length > LOG_TAIL) tail.shift();
  };
  const restoreConsole = captureConsole(record);
  // Set by `untilStopped`: from then on a stop by a signal is the end the scenario waits for.
  let stopIsTheEnd = false;

  const harness: Harness = {
    signal: abort.signal,
    fail(error) {
      if (!abort.signal.aborted) abort.abort(error);
    },
    log: record,
    onExit(what, step) {
      exits.push({ what, step });
    },
    onProcessExit(step) {
      processExits.push(step);
    },
    untilStopped() {
      stopIsTheEnd = true;
      return new Promise<void>((resolve) => {
        if (abort.signal.aborted) resolve();
        else abort.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
  // What runs as the process ends, however it ends, and all that runs after a second signal. The
  // steps go last in first out, and an error in one does not keep the next from running.
  process.once("exit", () => {
    for (const step of [...processExits].reverse()) {
      try {
        step();
      } catch {
        // The next step still has to run.
      }
    }
  });

  let firstSignalAt: number | undefined;
  const onSignal = (name: StopSignal) => {
    const now = Date.now();
    if (firstSignalAt === undefined) {
      firstSignalAt = now;
      harness.fail(new Interrupted(name));
      // At once: the stops take some seconds, and a terminal that says nothing for that long looks
      // stuck. A SIGINT is a Ctrl-C to the person at the terminal.
      process.stderr.write(
        `${script.name}: ${name}; stopping (${name === "SIGINT" ? "Ctrl-C" : name} again to force)\n`,
      );
    } else if (now - firstSignalAt > REPEAT_SIGNAL_MS) {
      // No orderly stop is waited for. The exit steps above kill the node and remove the temp dir.
      process.stderr.write(`${script.name}: ${name} again; exiting now\n`);
      process.exit(1);
    }
  };
  const onCrash = (error: unknown) => harness.fail(error);
  for (const name of Object.keys(STOP_SIGNALS) as StopSignal[]) {
    process.on(name, () => onSignal(name));
  }
  process.on("unhandledRejection", onCrash);
  process.on("uncaughtException", onCrash);

  let failure: unknown;
  try {
    await script.run(harness);
  } catch (error) {
    failure = error;
  }
  const problems = await runExitSteps(exits);
  restoreConsole();
  // An error nobody caught, or a signal, that came after the last wait still ends the demo here.
  if (failure === undefined && abort.signal.aborted) failure = abort.signal.reason;
  // A scenario that waited to be stopped (`--keep`) ends well on a stop: no interruption.
  if (failure instanceof Interrupted && stopIsTheEnd) failure = undefined;

  if (failure instanceof Interrupted) {
    process.stderr.write(`${script.name}: ${failure.message}; stopped what it started\n`);
    for (const problem of problems) process.stderr.write(`${script.name}: ${problem}\n`);
    return STOP_SIGNALS[failure.signalName];
  }
  if (failure !== undefined || problems.length > 0) {
    const reasons = failure === undefined ? problems : [reasonOf(failure), ...problems];
    const out = reasons.map((reason) => `${script.failed}: ${reason}`);
    if (tail.length > 0) {
      out.push("", "The last lines of the services and the agents:");
      out.push(...tail.map((line) => `  ${line}`));
    }
    process.stderr.write(`${out.join("\n")}\n`);
    return 1;
  }
  say(script.ok);
  return 0;
}

// Only when run as the script, never when a test or another script imports from here. Its parts
// leave handles open (the database's threads, kept-alive sockets), so the process ends itself.
if (import.meta.main) {
  let options: DemoOptions | undefined;
  try {
    options = demoOptionsOf(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`demo: ${messageOf(error)}\n`);
  }
  // The demo runs in a child process; this one passes the stop signals on and cleans up after it
  // (`inOwnProcess`), so that tsx's relay of a Ctrl-C cannot kill it past its stops.
  const relayed =
    options === undefined
      ? 2
      : await inOwnProcess({
          script: fileURLToPath(import.meta.url),
          prefix: DIR_PREFIX,
          name: "demo",
        });
  const code = relayed ?? (await main(demoScript(options)));
  await flush(process.stdout);
  await flush(process.stderr);
  process.exit(code);
}
