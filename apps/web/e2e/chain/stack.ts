import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  ApiClient,
  type LocalChain,
  registerWithBond,
  type Signer,
  startLocalChain,
  TenderClient,
  toTxResult,
} from "@tender/client";
import { canonicalJson, type TenderCall, tokenStorageDepositCall } from "@tender/shared";
import { Account, actions, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { addRoleKey } from "../../../../scripts/keeper-key";
import { seed } from "../../../../scripts/seed";
import { redact, type Services, startServices } from "../../../../scripts/serve";
import { descendantsOf, killNow, listProcesses, type Proc, terminate } from "./processes";
import { RUN_FILE_VARIABLE, type RunInfo, SIGNERS_VARIABLE } from "./run";
import { GiveUp, limited, messageOf, type Poll, sleep, until } from "./waits";

// The stack the chain suite runs the web app against: a local NEAR chain with Tender and a test
// token on it, the services (indexer, API, keeper and Judge) on that chain, the two seed tasks and
// an agent, and `next dev` built for all of that with the dev wallet on. `startStack` brings it up
// (the global setup) and `stopStack` takes it down (the global teardown). Everything is in one
// process but the chain and the web server, which are its children, and all of it lives in a temp
// dir that is new for each run.
//
// The stop is meant to leave nothing running, whatever went wrong:
//
// - `stopStack` runs when the setup failed half way (Playwright runs the teardown then), when the
//   run was interrupted with Ctrl-C (Playwright stops the setup it was in the middle of and runs
//   the teardown), and on SIGTERM and SIGHUP, which Playwright does not handle: the stack handles
//   them itself. It stops what it started in the order that asks the least of the rest: the web
//   server, the services, the chain.
// - What a part could not stop is found in the process table and ended by its own pid: first
//   SIGTERM, then SIGKILL after a short grace. The web server is the child that was spawned, which
//   Node can name, and the tree below it. The chain's node is found by the run's temp dir, which
//   is in its command line, because the node is started with the OS temp dir pointed at the run's
//   (see `startNode`). Only children and grandchildren of this process are ever ended. Where `ps`
//   cannot be run, the stop says so: it does not take the machine for clean.
// - If the process itself ends without a stop (an uncaught error, or `process.exit` by the runner
//   after a second Ctrl-C), a handler on `exit` does the same ending, with no wait.
//
// What no handler can cover is SIGKILL of the runner, and a crash of the machine.

const CHAIN_MS = 300_000;
const STEP_MS = 120_000;
const INDEX_MS = 90_000;
const WEB_START_MS = 240_000;
const WARM_MS = 180_000;
/** How long the services have to stop. The Judge and the keeper finish the call they are in. */
const SERVICES_STOP_MS = 30_000;
/** How long the web server has to exit after a SIGTERM: it saves its compile cache as it goes. */
const WEB_GRACE_MS = 15_000;
/** The same for what the final sweep ends. */
const SWEEP_GRACE_MS = 3_000;
const API_TIMEOUT_MS = 10_000;
const INDEXER_POLL_MS = 200;
const JUDGE_INTERVAL_MS = 1_000;
/**
 * The keeper ticks once when the services start, and not again in a run: it would void a task with
 * nothing revealed within a second of its reveal deadline, and the spec of the task page's Refund
 * (task-actions.chain.ts) has to be the one that voids it. No spec waits on the keeper.
 */
const KEEPER_INTERVAL_MS = 3_600_000;
/** The bot the Telegram links name. No bot runs: there is no token, and no message is sent. */
export const BOT_USERNAME = "tender_test_bot";

/**
 * The tasks the board shows, by slug, in the order the specs list them. They are of the tracked
 * demo set (`scripts/demo-seeds/<slug>/`, demo-only, local chain only), which holds a task's
 * held-out checks beside its brief, so that the suite needs no private directory.
 */
const SEEDS = ["demo-room-code-regex", "demo-dispatch-note-extract"] as const;
/** The agent whose page the specs look at. */
const AGENT_PROFILE = {
  name: "Alice Extractor",
  description: "An agent registered for the browser specs.",
  tags: ["extract", "regex"],
};

const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
/** What the dev wallet's account is given, for its storage and its gas. */
const DEV_NEAR = 5n * NEAR;
/** What the dev wallet's account is minted of the test token: 50 tUSDC. */
const DEV_TOKENS = 50_000_000n;

const WEB_DIR = fileURLToPath(new URL("../../", import.meta.url));
const SEEDS_DIR = fileURLToPath(new URL("../../../../scripts/demo-seeds/", import.meta.url));
const NEXT_BIN = join(WEB_DIR, "node_modules", "next", "dist", "bin", "next");

const say = (line: string) => process.stdout.write(`chain suite: ${line}\n`);

// ---- What the run holds -------------------------------------------------------------------------

/** The web server this run started. */
interface Web {
  /**
   * The server's own process. Node knows it is still the one that was spawned while it has not
   * exited: the system gives its pid to no other process before the parent has seen it go.
   */
  child: ChildProcess;
  /**
   * The processes below it as they were last seen, for when it has gone and left them. They are
   * not children of this process, so each is told from another that gets its pid later by its
   * start time.
   */
  below: Proc[];
  /** Set when it has exited. */
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  logFile: string;
}

interface Stack {
  /** Aborts when the run is being stopped, which ends every wait of the setup. */
  abort: AbortController;
  /** The setup, from `startStack`. Settles once it has made all it is going to make. */
  setup?: Promise<unknown>;
  runDir?: string;
  /** The strings that put a process in the run: its temp dir, spelt as it can be spelt. */
  needles: string[];
  chain?: Promise<LocalChain>;
  chainSettled: boolean;
  services?: Promise<Services>;
  web?: Web;
  stopping?: Promise<void>;
  hooked: boolean;
  /** Takes the handlers on the process off. */
  unhook: Array<() => void>;
}

/**
 * The one record of the run. It is kept on `globalThis`, so that the teardown finds what the setup
 * made even if Playwright were to load this file a second time for it.
 */
const KEY = Symbol.for("tender.chain-suite.stack");

function stack(): Stack {
  const holder = globalThis as unknown as Record<symbol, Stack | undefined>;
  let found = holder[KEY];
  if (found === undefined) {
    found = {
      abort: new AbortController(),
      needles: [],
      chainSettled: false,
      hooked: false,
      unhook: [],
    };
    holder[KEY] = found;
  }
  return found;
}

// ---- Starting ----------------------------------------------------------------------------------

export interface StackOptions {
  /** The port of the web server. */
  webPort: number;
}

/**
 * Brings the stack up and tells the specs about it (see run.ts). Throws, naming what it waited for,
 * if a part does not come up in its time. Call `stopStack` after it, whether it throws or not.
 */
export function startStack(options: StackOptions): Promise<RunInfo> {
  const s = stack();
  const setup = bringUp(s, options);
  s.setup = setup;
  return setup;
}

async function bringUp(s: Stack, { webPort }: StackOptions): Promise<RunInfo> {
  const { signal } = s.abort;
  hook(s);
  const runDir = await makeRunDir(s);
  const setupLog = join(runDir, "setup.log");
  /** Where the lines of the services, the key script and the seed script go. */
  const toLog = (line: string) => {
    try {
      appendFileSync(setupLog, `${line}\n`);
    } catch {
      // The run's dir is gone: the stack is being stopped, and the line is of no use.
    }
  };

  try {
    say("starting the local chain");
    const starting = startNode(runDir);
    s.chain = starting;
    starting.then(
      () => {
        s.chainSettled = true;
      },
      () => {
        s.chainSettled = true;
      },
    );
    const chain = await limited("the local chain to start", CHAIN_MS, starting, signal);
    const { poster, alice, judge, keeper } = chain.accounts;
    // The keys of the poster and of alice, for the specs that post and enter tasks themselves. The
    // workers inherit the environment; the keys go into no file (run.ts).
    process.env[SIGNERS_VARIABLE] = JSON.stringify({ poster, alice });

    say("starting the services");
    const keys = await limited(
      "the keeper's and the Judge's keys",
      STEP_MS,
      mintServiceKeys(chain, join(runDir, "keys")),
      signal,
    );
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
      // The account that posts the seeds is the team's: the API flags it, and its tasks.
      TEAM_ACCOUNTS: poster.accountId,
      // The Telegram link names this bot. No token is set, so no bot runs and nothing is sent.
      TELEGRAM_BOT_USERNAME: BOT_USERNAME,
    };
    // Empty on purpose: a record of a deploy would tell the indexer where to start, and on the
    // sandbox it starts at the chain's final height.
    const deploymentsDir = join(runDir, "deployments");
    await mkdir(deploymentsDir, { recursive: true });
    const startingServices = startServices(env, {
      deploymentsDir,
      log: (line) => toLog(redact(line, env)),
    });
    s.services = startingServices;
    const services = await limited("the services to start", STEP_MS, startingServices, signal);

    const api = new ApiClient({
      baseUrl: services.publicUrl,
      timeoutMs: API_TIMEOUT_MS,
      signal,
    });
    await until(
      "the index to follow the chain",
      INDEX_MS,
      async (): Promise<Poll<true>> => {
        const health = await api.health();
        if (BigInt(health.indexed_height) > 0n && BigInt(health.lag_blocks) < 20n) {
          return { value: true };
        }
        return {
          seen: `indexed height ${health.indexed_height}, ${health.lag_blocks} blocks behind`,
        };
      },
      signal,
    );

    say("posting the seeds and registering an agent");
    const seeds = await limited(
      "the seeds to be posted",
      STEP_MS,
      postSeeds(chain, services.publicUrl, signal, toLog),
      signal,
    );
    await limited(
      "an agent to be registered",
      STEP_MS,
      registerAgent(chain, services.publicUrl, signal),
      signal,
    );
    await until(
      "the API to serve the seeds' briefs and the agent",
      INDEX_MS,
      async (): Promise<Poll<true>> => {
        for (const one of seeds) {
          const detail = await api.getTask(BigInt(one.taskId));
          if (detail === null || detail.brief === null) {
            return { seen: `task ${one.taskId} (${one.slug}) without its brief` };
          }
        }
        const { agents } = await api.listAgents();
        const found = agents.find((agent) => agent.account === alice.accountId);
        if (found?.name !== AGENT_PROFILE.name) {
          return { seen: `the agent ${alice.accountId} listed as ${found?.name ?? "missing"}` };
        }
        return { value: true };
      },
      signal,
    );

    say("setting up the dev wallet's account");
    const dev = await limited("the dev wallet's account", STEP_MS, createDevAccount(chain), signal);

    say(`starting the web server on port ${webPort}`);
    await startWeb(s, {
      port: webPort,
      logFile: join(runDir, "next.log"),
      env: {
        NEXT_PUBLIC_NETWORK: chain.network,
        NEXT_PUBLIC_DEV_WALLET: "1",
        NEXT_PUBLIC_API_URL: services.publicUrl,
        NEXT_PUBLIC_CONTRACT: chain.contractId,
        NEXT_PUBLIC_RPC_URL: chain.rpcUrl,
        NEXT_PUBLIC_JUDGE_ACCOUNT: judge.accountId,
        // The dev wallet's account and key. The key ships in the page, and it is the key of an
        // account of a chain that lives as long as this run: it goes through this environment and
        // into no file.
        NEXT_PUBLIC_DEV_WALLET_ACCOUNT: dev.accountId,
        NEXT_PUBLIC_DEV_WALLET_KEY: dev.privateKey,
      },
      routes: [
        "/",
        "/tasks",
        "/agents",
        "/wallet",
        "/post",
        "/telegram",
        ...seeds.slice(0, 1).map((one) => `/tasks/${one.taskId}`),
        `/agents/${alice.accountId}`,
      ],
    });

    const info: RunInfo = {
      apiUrl: services.publicUrl,
      rpcUrl: chain.rpcUrl,
      contractId: chain.contractId,
      tokenId: chain.tokenId,
      judge: judge.accountId,
      poster: poster.accountId,
      dev: dev.accountId,
      agent: alice.accountId,
      botUsername: BOT_USERNAME,
      seeds,
    };
    const runFile = join(runDir, "run.json");
    await writeFile(runFile, `${JSON.stringify(info, null, 2)}\n`);
    process.env[RUN_FILE_VARIABLE] = runFile;
    say("up");
    return info;
  } catch (error) {
    throw new Error(`${messageOf(error)}${logTails(s)}`, { cause: error });
  }
}

/** The last lines of the run's logs, for the error of a part that did not come up. */
function logTails(s: Stack): string {
  if (s.runDir === undefined) return "";
  let text = "";
  for (const name of ["setup.log", "next.log"]) {
    try {
      const lines = readFileSync(join(s.runDir, name), "utf8").trimEnd().split("\n").slice(-15);
      text += `\n--- ${name}, last lines ---\n${lines.join("\n")}`;
    } catch {
      // No such log, yet.
    }
  }
  return text;
}

/** The run's own dir, which holds every file and directory the run makes, and the chain's node. */
async function makeRunDir(s: Stack): Promise<string> {
  // The real path, so that the dir has one spelling in every command line it appears in.
  const runDir = await mkdtemp(join(await realpath(tmpdir()), "tender-chain-suite-"));
  s.runDir = runDir;
  s.needles = [runDir];
  s.abort.signal.throwIfAborted();
  return runDir;
}

/**
 * Starts the local node with the OS temp dir pointed at `runDir` for as long as that takes.
 * near-sandbox makes the node's home dir, and the lock files of its ports, in the OS temp dir. So
 * they are made inside the run's dir and go with it, and the node's command line holds the run's
 * dir, which is how the final sweep finds a node that nothing else could stop: one whose start
 * failed (near-sandbox leaves it running then), or whose stop was never reached. The cost: the
 * lock files that keep two sandboxes starting at once from taking the same port are no longer
 * shared with the other sandboxes on the machine, so that is left to the system, which gives out
 * free ports at random, and a clash is unlikely.
 */
async function startNode(runDir: string): Promise<LocalChain> {
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = runDir;
  try {
    return await startLocalChain();
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "TMPDIR");
    else process.env.TMPDIR = saved;
  }
}

/**
 * The keeper's and the Judge's keys, as the key script makes them for a chain: function-call keys
 * limited to Tender for the methods of their roles. The script adds them to the accounts and
 * writes them to an env file in `dir`, as it does for the deploy.
 */
async function mintServiceKeys(
  chain: LocalChain,
  dir: string,
): Promise<{ keeper: string; judge: string }> {
  const { keeper, judge } = chain.accounts;
  await mkdir(dir, { recursive: true });
  const file = join(dir, ".env.deploy.sandbox");
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
  if (written.KEEPER_PRIVATE_KEY === undefined || written.JUDGE_PRIVATE_KEY === undefined) {
    throw new Error("the key script did not write KEEPER_PRIVATE_KEY and JUDGE_PRIVATE_KEY");
  }
  return { keeper: written.KEEPER_PRIVATE_KEY, judge: written.JUDGE_PRIVATE_KEY };
}

/** A client that signs as `signer` on `chain`. */
const clientOf = (chain: LocalChain, signer?: Signer) =>
  new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer,
  });

/**
 * Posts the demo tasks as the poster and gives their ids and titles. Their held-out checks are in
 * their folders (`heldoutDir` is the demo set itself), not in the private directory the 30 real
 * seeds use (seeds/README.md), so this needs nothing set up.
 */
async function postSeeds(
  chain: LocalChain,
  apiUrl: string,
  signal: AbortSignal,
  log: (line: string) => void,
): Promise<RunInfo["seeds"]> {
  const { poster, judge } = chain.accounts;
  const posted = await seed({
    client: clientOf(chain, poster),
    api: new ApiClient({ baseUrl: apiUrl, signer: poster, timeoutMs: API_TIMEOUT_MS, signal }),
    network: chain.network,
    poster: poster.accountId,
    judgeAccount: judge.accountId,
    tokenId: chain.tokenId,
    seedsDir: SEEDS_DIR,
    heldoutDir: SEEDS_DIR,
    only: SEEDS,
    log,
  });
  return Promise.all(
    SEEDS.map(async (slug) => {
      const found = posted.find((one) => one.slug === slug);
      if (found === undefined) {
        throw new Error(`the seed ${slug} was not posted: the seed script gave ${posted.length}`);
      }
      const brief = JSON.parse(await readFile(join(SEEDS_DIR, slug, "brief.json"), "utf8")) as {
        title: string;
      };
      return { slug, taskId: `${found.taskId}`, title: brief.title };
    }),
  );
}

/**
 * Registers alice as an agent, with a profile the API holds, so that the directory has one.
 * Registering takes the agent bond out of her vault (contract Task 16b), so the bond goes from her
 * wallet into the vault first, which `registerWithBond` does.
 */
async function registerAgent(chain: LocalChain, apiUrl: string, signal: AbortSignal) {
  const { alice } = chain.accounts;
  const api = new ApiClient({ baseUrl: apiUrl, signer: alice, timeoutMs: API_TIMEOUT_MS, signal });
  const stored = await api.uploadBlob({
    kind: "profile",
    contentType: "application/json",
    bytes: canonicalJson(AGENT_PROFILE),
  });
  await registerWithBond(
    clientOf(chain, alice),
    { uri: stored.uri, hash: stored.sha256, tags: AGENT_PROFILE.tags },
    { approve: () => true },
  );
}

/** The test token's `mint`, which anyone may call for an account the token has registered. */
function mintCall(chain: LocalChain, accountId: string, amount: bigint): TenderCall {
  return {
    receiverId: chain.tokenId,
    methodName: "mint",
    args: { account_id: accountId, amount: `${amount}` },
    gas: 15n * TGAS,
    deposit: 0n,
  };
}

/**
 * The account the dev wallet signs as. Every account of a local chain is set up with Tender already
 * (it has a storage balance), so a spec of the wallet's "Set up account" needs one that is not: a
 * new account under bob's, with NEAR for its storage and gas, registered with the token and given
 * some of it, and nothing at Tender. Its key is returned to go into the web server's environment,
 * and is kept nowhere else.
 *
 * Bob is the parent because no spec signs as him and he is not the team's. The API labels an
 * account as the team's when its provider (its parent, by the registry's `asp_of` rule) is one of
 * `TEAM_ACCOUNTS`, so an account under the poster would carry the team's label, and the dev
 * wallet's posts must not.
 */
async function createDevAccount(chain: LocalChain): Promise<Signer> {
  const { bob } = chain.accounts;
  const parent = new Account(
    bob.accountId,
    new JsonRpcProvider({ url: chain.rpcUrl }),
    bob.privateKey as KeyPairString,
  );
  const key = KeyPair.fromRandom("ed25519");
  const dev: Signer = { accountId: `dev.${bob.accountId}`, privateKey: key.toString() };
  toTxResult(
    await parent.signAndSendTransaction({
      receiverId: dev.accountId,
      actions: [
        actions.createAccount(),
        actions.transfer(DEV_NEAR),
        actions.addFullAccessKey(key.getPublicKey()),
      ],
      waitUntil: "FINAL",
      throwOnFailure: false,
    }),
    chain.contractId,
  );
  const client = clientOf(chain, dev);
  await client.send(tokenStorageDepositCall(chain.tokenId, dev.accountId));
  await client.send(mintCall(chain, dev.accountId, DEV_TOKENS));
  return dev;
}

// ---- The web server -----------------------------------------------------------------------------

/** Whether something listens on `host`:`port`. */
function listening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(2_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Throws if something listens on the port already. The page would load from it, and it would not
 * have the values of this run: whatever answered would pass for the server.
 */
async function assertPortFree(port: number): Promise<void> {
  for (const host of ["127.0.0.1", "::1"]) {
    if (await listening(host, port)) {
      throw new Error(
        `port ${port} is in use (something answers on ${host}): the web server of the chain ` +
          "suite needs it free. Stop what is there, or set WEB_PORT to another port",
      );
    }
  }
}

interface WebOptions {
  port: number;
  logFile: string;
  /** The `NEXT_PUBLIC_*` values, which `next dev` puts into the page's code as it compiles it. */
  env: Record<string, string>;
  /** The routes to ask for once the server is up, so each is compiled before a spec needs it. */
  routes: string[];
}

/**
 * Starts `next dev` on `port` and waits until it answers, and then asks for each of `routes`: the
 * first request of a route compiles it, which takes longer than a spec's wait. The server is a
 * child of this process, and its output goes to `logFile`.
 */
async function startWeb(s: Stack, options: WebOptions): Promise<Web> {
  const { signal } = s.abort;
  const { port, logFile } = options;
  await assertPortFree(port);
  // Nothing is awaited between this look and the start of the server, so a stop that comes later
  // finds the server in `s.web`, and one that came before is seen here.
  signal.throwIfAborted();
  const log = openSync(logFile, "a");
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [NEXT_BIN, "dev", "-p", `${port}`], {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        NODE_ENV: "development",
        NEXT_TELEMETRY_DISABLED: "1",
        ...options.env,
      },
      stdio: ["ignore", log, log],
    });
  } finally {
    closeSync(log);
  }
  const pid = child.pid;
  const web: Web = { child, below: [], logFile };
  s.web = web;
  child.once("exit", (code, exitSignal) => {
    web.exit = { code, signal: exitSignal };
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  if (pid === undefined) {
    await sleep(0);
    throw new Error(`cannot start the web server: ${spawnError?.message ?? "no pid"}`);
  }

  const base = `http://localhost:${port}`;
  const dead = () => {
    if (web.exit === undefined && spawnError === undefined) return;
    const how =
      spawnError?.message ??
      `code ${web.exit?.code ?? "none"}, signal ${web.exit?.signal ?? "none"}`;
    throw new GiveUp(`the web server exited before it answered (${how})`);
  };
  await until(
    `the web server to answer on port ${port}`,
    WEB_START_MS,
    async (): Promise<Poll<true>> => {
      dead();
      const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(30_000) });
      return res.status === 200 ? { value: true } : { seen: `HTTP ${res.status}` };
    },
    signal,
    500,
  );
  // What it has started by now: if it dies and leaves them, this is how they are found.
  noteBelow(web);
  for (const route of options.routes) {
    const res = await limited(
      `the web server to compile ${route}`,
      WARM_MS,
      fetch(`${base}${route}`, { signal: AbortSignal.timeout(WARM_MS) }),
      signal,
    );
    if (res.status !== 200) {
      throw new Error(`the web server answered ${route} with HTTP ${res.status}, not 200`);
    }
    await res.arrayBuffer();
  }
  dead();
  // Compiling the routes can have started more.
  noteBelow(web);
  return web;
}

/**
 * Remembers the processes now below the web server, besides those remembered already. They are not
 * children of this process: if the server dies and leaves them to the system, only what was seen of
 * them, each with the start time that tells it from a later process with its pid, finds them.
 */
function noteBelow(web: Web): void {
  const { pid } = web.child;
  if (pid === undefined) return;
  const known = new Set(web.below.map((one) => `${one.pid}@${one.started}`));
  for (const one of descendantsOf([pid], listProcesses())) {
    if (!known.has(`${one.pid}@${one.started}`)) web.below.push(one);
  }
}

// ---- Stopping ----------------------------------------------------------------------------------

/**
 * The web server, if it is still running, and the processes below it: those now, and those it was
 * seen to have, if they are still there as they were. The server is told by Node, not by a start
 * time: its pid is its own until Node has seen it exit.
 */
function webProcesses(s: Stack, table: readonly Proc[]): Proc[] {
  const { web } = s;
  if (web === undefined) return [];
  const found = new Map<number, Proc>();
  const { pid, exitCode, signalCode } = web.child;
  if (pid !== undefined && exitCode === null && signalCode === null) {
    const server = table.find((row) => row.pid === pid);
    if (server !== undefined) found.set(server.pid, server);
  }
  for (const one of web.below) {
    const row = table.find((r) => r.pid === one.pid && r.started === one.started);
    if (row !== undefined) found.set(row.pid, row);
  }
  for (const one of descendantsOf([...found.keys()], table)) found.set(one.pid, one);
  return [...found.values()];
}

/**
 * Every process of the run that is still running: the web server and what is below it, and any
 * child or grandchild of this process whose command line holds the run's dir (the chain's node),
 * with whatever those have started. Throws where `ps` cannot be run: a stop that cannot see the
 * processes has to say so, and not take it for none.
 */
function runProcesses(s: Stack): Proc[] {
  const table = listProcesses();
  const found = new Map<number, Proc>();
  for (const one of webProcesses(s, table)) found.set(one.pid, one);
  for (const one of descendantsOf([process.pid], table)) {
    if (s.needles.some((needle) => one.command.includes(needle))) found.set(one.pid, one);
  }
  for (const one of descendantsOf([...found.keys()], table)) found.set(one.pid, one);
  return [...found.values()];
}

const describe = (one: Proc) => `${one.pid} (${one.command.slice(0, 120)})`;

/** Ends what is left of the run. Throws, naming it, if a process cannot be ended. */
async function sweep(s: Stack): Promise<void> {
  const left = runProcesses(s);
  if (left.length === 0) return;
  const stuck = await terminate(left, SWEEP_GRACE_MS);
  if (stuck.length > 0) {
    throw new Error(`still running after SIGKILL: ${stuck.map(describe).join("; ")}`);
  }
}

/**
 * Stops everything the setup started, and removes the run's dir. It can be called at any time
 * after `startStack` was called, also while that is still going, and any number of times: every
 * call gives the one stop. It tries every part and then throws all that went wrong, so that a part
 * that cannot be stopped does not keep the next from being tried.
 */
export function stopStack(): Promise<void> {
  const s = stack();
  s.stopping ??= stopAll(s);
  return s.stopping;
}

async function stopAll(s: Stack): Promise<void> {
  // Ends every wait of the setup that is still going. A part that is in the middle of starting is
  // not cancelled, but its start is recorded on the stack, so it is found below.
  s.abort.abort(new Error("the chain suite is being stopped"));
  const problems: string[] = [];
  const attempt = async (what: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      problems.push(`${what}: ${messageOf(error)}`);
    }
  };

  // The setup has stopped waiting by now, so it makes no more.
  await attempt("waiting for the setup to give up", async () => {
    await limited(
      "the setup to give up",
      SERVICES_STOP_MS,
      (s.setup ?? Promise.resolve()).catch(() => undefined),
    );
  });
  await attempt("stopping the web server", async () => {
    const { web } = s;
    if (web === undefined) return;
    let table: Proc[];
    try {
      table = listProcesses();
    } catch (error) {
      // The tree below the server can't be seen. The server itself is ended by its pid.
      web.child.kill("SIGKILL");
      throw error;
    }
    const stuck = await terminate(webProcesses(s, table), WEB_GRACE_MS);
    if (stuck.length > 0) throw new Error(`still running: ${stuck.map(describe).join("; ")}`);
  });
  await attempt("stopping the services", async () => {
    if (s.services === undefined) return;
    // A start that fails made nothing to stop. One that is still going is waited for.
    const services = await limited(
      "the services to finish starting",
      SERVICES_STOP_MS,
      s.services,
    ).catch(() => undefined);
    if (services !== undefined) {
      await limited("the services to stop", SERVICES_STOP_MS, services.stop());
    }
  });
  await attempt("stopping the local chain", async () => {
    if (s.chain === undefined) return;
    if (!s.chainSettled) {
      // The node is still starting: end it by the sweep below, and do not wait for the start,
      // which has nothing left to start.
      await sweep(s);
      return;
    }
    const chain = await s.chain.catch(() => undefined);
    await chain?.stop();
  });
  // What a part could not stop, and a node whose start failed: found by the run's dir.
  await attempt("ending what is left of the run", () => sweep(s));
  await attempt("checking that nothing of the run is left", async () => {
    const left = runProcesses(s);
    if (left.length > 0) throw new Error(`still running: ${left.map(describe).join("; ")}`);
  });
  await attempt("removing the run's dir", async () => {
    if (s.runDir === undefined) return;
    await rm(s.runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  if (problems.length === 0) {
    for (const remove of s.unhook) remove();
    s.unhook = [];
  } else {
    // The handlers stay, to try again at the end of the process.
    const list = problems.map((problem) => `  - ${problem}`).join("\n");
    throw new Error(`the chain suite did not stop cleanly:\n${list}`);
  }
}

// ---- When the process ends ---------------------------------------------------------------------

/**
 * Puts the stack's own handlers on the process, once. On `exit` it ends the run's processes with no
 * wait. On SIGTERM and SIGHUP, which Playwright leaves to their default (the process dies and
 * nothing is stopped), it stops the stack and then exits with the code a signal gives.
 */
function hook(s: Stack): void {
  if (s.hooked) return;
  s.hooked = true;
  const onExit = () => {
    try {
      killNow(runProcesses(s));
    } catch {
      // `ps` cannot be run, and the process is ending: there is nowhere left to say so.
    }
  };
  process.on("exit", onExit);
  s.unhook.push(() => process.off("exit", onExit));
  for (const [name, code] of [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    const onSignal = () => {
      stopStack().then(
        () => process.exit(code),
        (error) => {
          process.stderr.write(`${messageOf(error)}\n`);
          process.exit(code);
        },
      );
    };
    process.on(name, onSignal);
    s.unhook.push(() => process.off(name, onSignal));
  }
}
