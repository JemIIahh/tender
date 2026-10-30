import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyPermission } from "@tender/client";
import { LockNotHeldError, type SessionLock } from "@tender/db";
import { KeyPair, type KeyPairString } from "near-api-js";
import { afterEach, expect, test, vi } from "vitest";
import {
  checkKeeperKey,
  publicUrlOf,
  readServeConfig,
  redact,
  runWhileLocked,
  ServeConfigError,
  type Stoppable,
  serveEnv,
} from "./serve";

// The parts of `pnpm serve` that need no chain: what it makes of the environment, what it says
// when that is wrong, and how it waits for the indexer lock. `serve.sandbox.test.ts` starts the
// services themselves.

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const KEEPER_KEY = KeyPair.fromRandom("ed25519").toString();

/** An environment the services start with, on testnet, with every optional variable set. */
const GOOD: Record<string, string> = {
  TENDER_NETWORK: "testnet",
  TENDER_CONTRACT: "tender.tender-dev.testnet",
  DATABASE_URL: "postgres://tender:pass-word@db.internal:5432/tender",
  API_PORT: "8080",
  PUBLIC_API_URL: "https://api.tender.example/",
  PUBLIC_WEB_URL: "https://tender.example, http://localhost:3000/",
  NEAR_RPC_URL: "https://rpc.testnet.fastnear.com",
  NEARDATA_URL: "https://testnet.neardata.xyz",
  INDEXER_POLL_MS: "1000",
  INDEXER_START_HEIGHT: "222000000",
  TEAM_ACCOUNTS: "judge.tender-dev.testnet, poster.tender-dev.testnet",
  TELEGRAM_BOT_USERNAME: "tender_test_bot",
  TRUSTED_PROXY_HOPS: "1",
  KEEPER_ACCOUNT: "keeper.tender-dev.testnet",
  KEEPER_PRIVATE_KEY: KEEPER_KEY,
  KEEPER_INTERVAL_MS: "30000",
};

/** The problems `readServeConfig` names for `env`; none if it accepts it. */
function problemsOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    readServeConfig(env);
    return [];
  } catch (error) {
    if (!(error instanceof ServeConfigError)) throw error;
    return error.problems;
  }
}

test("read_serve_config_accepts_a_good_env", () => {
  expect(readServeConfig(GOOD)).toEqual({
    network: "testnet",
    contractId: "tender.tender-dev.testnet",
    database: { url: GOOD.DATABASE_URL, kind: "postgres" },
    apiPort: 8080,
    publicApiUrl: "https://api.tender.example",
    rpcUrl: "https://rpc.testnet.fastnear.com",
    webOrigins: ["https://tender.example", "http://localhost:3000/"],
    teamAccounts: ["judge.tender-dev.testnet", "poster.tender-dev.testnet"],
    telegramBotUsername: "tender_test_bot",
    trustedProxyHops: 1,
    keeper: {
      accountId: "keeper.tender-dev.testnet",
      privateKey: KEEPER_KEY,
      intervalMs: 30_000,
    },
    warnings: [],
  });

  // The least a sandbox needs. Empty values are unset ones, and the rest take their defaults.
  const sandbox = readServeConfig({
    TENDER_NETWORK: "sandbox",
    TENDER_CONTRACT: "tender.sandbox",
    DATABASE_URL: "pglite:memory",
    NEAR_RPC_URL: "http://127.0.0.1:3030",
    API_PORT: "",
    KEEPER_PRIVATE_KEY: " ",
    PUBLIC_WEB_URL: "",
  });
  expect(sandbox).toMatchObject({
    network: "sandbox",
    database: { url: "pglite:memory", kind: "pglite" },
    apiPort: 8787,
    publicApiUrl: undefined,
    webOrigins: [],
    teamAccounts: [],
    trustedProxyHops: 0,
    keeper: undefined,
    warnings: [],
  });
  expect(readServeConfig({ ...GOOD, DATABASE_URL: "pglite:.data/index" }).database.kind).toBe(
    "pglite",
  );
  expect(readServeConfig({ ...GOOD, API_PORT: "0" }).apiPort).toBe(0);

  // Off the sandbox, no web origin is allowed, but said.
  const bare = readServeConfig({ ...GOOD, PUBLIC_WEB_URL: "" });
  expect(bare.warnings).toEqual([
    "PUBLIC_WEB_URL is empty, so no web app may call the API from a browser",
  ]);
});

test("read_serve_config_names_each_bad_variable", () => {
  // Each bad value alone is one problem, which names its variable.
  const bad: Array<[string, string | undefined]> = [
    ["TENDER_NETWORK", undefined],
    ["TENDER_NETWORK", "localnet"],
    ["TENDER_CONTRACT", undefined],
    ["TENDER_CONTRACT", "Not An Account"],
    ["DATABASE_URL", undefined],
    ["DATABASE_URL", "mysql://db.internal/tender"],
    ["DATABASE_URL", "pglite:"],
    ["API_PORT", "65536"],
    ["API_PORT", "80a"],
    ["API_PORT", "0x50"],
    ["API_PORT", "-1"],
    ["INDEXER_POLL_MS", "0"],
    ["INDEXER_POLL_MS", "1.5"],
    ["INDEXER_POLL_MS", "2147483648"],
    ["KEEPER_INTERVAL_MS", "1e3"],
    ["KEEPER_INTERVAL_MS", "030000"],
    ["INDEXER_START_HEIGHT", "0"],
    ["INDEXER_START_HEIGHT", "18446744073709551616"],
    ["INDEXER_START_HEIGHT", "+5"],
    ["TRUSTED_PROXY_HOPS", "11"],
    ["TRUSTED_PROXY_HOPS", "one"],
    ["PUBLIC_WEB_URL", "tender.example"],
    ["PUBLIC_WEB_URL", "https://tender.example/app"],
    ["PUBLIC_WEB_URL", "https://tender.example, ftp://files.example"],
    ["PUBLIC_API_URL", undefined],
    ["PUBLIC_API_URL", "api.tender.example"],
    ["PUBLIC_API_URL", "https://api.tender.example/?v=1"],
    ["PUBLIC_API_URL", "https://api.tender.example/#top"],
    ["PUBLIC_API_URL", "https://tender:pass@api.tender.example"],
    ["NEAR_RPC_URL", "ws://rpc.example"],
    ["NEARDATA_URL", "neardata"],
    ["TEAM_ACCOUNTS", "judge.tender-dev.testnet, Bad Account"],
    ["TELEGRAM_BOT_USERNAME", "@tender_bot"],
    ["TELEGRAM_BOT_USERNAME", "bot"],
    ["KEEPER_ACCOUNT", undefined],
    ["KEEPER_ACCOUNT", "Not An Account"],
    ["KEEPER_PRIVATE_KEY", "ed25519:not-a-key"],
  ];
  for (const [key, value] of bad) {
    const problems = problemsOf({ ...GOOD, [key]: value });
    const what = `${key}=${value}`;
    expect(problems, what).toHaveLength(1);
    expect(problems[0], what).toMatch(new RegExp(`^${key} `));
  }

  // The sandbox has no RPC URL of its own.
  expect(problemsOf({ ...GOOD, TENDER_NETWORK: "sandbox", NEAR_RPC_URL: undefined })).toEqual([
    "NEAR_RPC_URL must be set on the sandbox: the RPC URL of the local node",
  ]);

  // All the problems of an environment are named at once, in one error.
  const error = (() => {
    try {
      readServeConfig({ TENDER_NETWORK: "localnet", API_PORT: "http", KEEPER_PRIVATE_KEY: "x" });
    } catch (thrown) {
      return thrown;
    }
  })();
  expect(error).toBeInstanceOf(ServeConfigError);
  const { problems, message } = error as ServeConfigError;
  expect(problems.map((problem) => problem.split(" ")[0])).toEqual([
    "TENDER_NETWORK",
    "TENDER_CONTRACT",
    "DATABASE_URL",
    "API_PORT",
    "KEEPER_ACCOUNT",
    "KEEPER_PRIVATE_KEY",
  ]);
  for (const problem of problems) expect(message).toContain(problem);
});

test("public_api_url_is_required_off_the_sandbox_and_is_the_loopback_there_when_unset", () => {
  // Sign-in is bound to the base URL clients call (P03-R28), so off the sandbox it is named, never
  // guessed from the address the server is bound to.
  for (const network of ["testnet", "mainnet"]) {
    expect(problemsOf({ ...GOOD, TENDER_NETWORK: network, PUBLIC_API_URL: "" })).toEqual([
      "PUBLIC_API_URL must be set off the sandbox: the exact base URL clients call the API at, " +
        "which sign-in is bound to",
    ]);
  }

  // On the sandbox it may be unset: the loopback address on the port the server is bound to.
  const sandbox = {
    TENDER_NETWORK: "sandbox",
    TENDER_CONTRACT: "tender.sandbox",
    DATABASE_URL: "pglite:memory",
    NEAR_RPC_URL: "http://127.0.0.1:3030",
  };
  const unset = readServeConfig(sandbox);
  expect(unset.publicApiUrl).toBeUndefined();
  expect(publicUrlOf(unset, 54_321)).toBe("http://127.0.0.1:54321");

  // Set, it is the URL as written, on any network, less a trailing slash; a path is part of it.
  for (const [value, base] of [
    ["https://api.tender.example/", "https://api.tender.example"],
    ["https://tender.example/api", "https://tender.example/api"],
    ["http://localhost:8787", "http://localhost:8787"],
  ]) {
    const config = readServeConfig({ ...GOOD, PUBLIC_API_URL: value });
    expect(publicUrlOf(config, 8787), value).toBe(base);
    expect(publicUrlOf(readServeConfig({ ...sandbox, PUBLIC_API_URL: value }), 1), value).toBe(
      base,
    );
  }

  // A query or a fragment is no part of a base URL, and credentials would go on chain with it.
  for (const value of [
    "https://api.tender.example?",
    "https://api.tender.example/?v=1",
    "https://api.tender.example/#",
    "https://tender:pass@api.tender.example",
    "ws://api.tender.example",
  ]) {
    expect(problemsOf({ ...sandbox, PUBLIC_API_URL: value }), value).toEqual([
      "PUBLIC_API_URL must be an http or https URL with no query, fragment or credentials",
    ]);
  }
});

test("no_secret_value_appears_in_any_error", () => {
  // Secrets, and things that may be, in every variable that is checked: each value is wrong, and
  // carries a marker. A private key in the account's variable is the classic mix-up.
  const realKey = KeyPair.fromRandom("ed25519").toString();
  const marked: Record<string, string> = {
    TENDER_NETWORK: "SECRET-network",
    TENDER_CONTRACT: "SECRET-contract",
    DATABASE_URL: "mysql://tender:SECRET-password@db.internal/tender",
    API_PORT: "SECRET-port",
    INDEXER_POLL_MS: "SECRET-poll",
    KEEPER_INTERVAL_MS: "SECRET-interval",
    INDEXER_START_HEIGHT: "SECRET-height",
    TRUSTED_PROXY_HOPS: "SECRET-hops",
    PUBLIC_WEB_URL: "https://SECRET-web.example/path",
    PUBLIC_API_URL: "SECRET-api",
    NEAR_RPC_URL: "ftp://rpc.example/?apiKey=SECRET-rpc",
    NEARDATA_URL: "ftp://neardata.example/?apiKey=SECRET-neardata",
    TEAM_ACCOUNTS: "SECRET-team",
    TELEGRAM_BOT_USERNAME: "SECRET bot",
    KEEPER_ACCOUNT: realKey,
    KEEPER_PRIVATE_KEY: "ed25519:SECRET-key",
  };
  let message = "";
  try {
    readServeConfig(marked);
  } catch (error) {
    message = (error as Error).message;
  }
  expect((message.match(/^ {2}- /gm) ?? []).length).toBe(Object.keys(marked).length);
  expect(message).not.toContain("SECRET");
  expect(message).not.toContain(realKey.slice("ed25519:".length, 20));

  // What the command line prints of any other error passes through `redact`, which takes out the
  // value of each secret variable, and the password of a URL.
  const env = {
    KEEPER_PRIVATE_KEY: realKey,
    DATABASE_URL: "postgres://tender:pass%40word@db.internal/tender",
    // A password whose % starts no escape: it is taken out as it is written.
    TEST_DATABASE_URL: "postgres://tester:odd%zzpass@db.internal/test",
    NEAR_RPC_URL: "https://rpc.example/?apiKey=abcdef123",
    TENDER_NETWORK: "testnet",
  };
  const printed = redact(
    `failed with ${realKey} at ${env.NEAR_RPC_URL}; password pass@word, odd%zzpass; network testnet`,
    env,
  );
  expect(printed).toBe(
    "failed with <KEEPER_PRIVATE_KEY> at <NEAR_RPC_URL>; password <password of DATABASE_URL>, " +
      "<password of TEST_DATABASE_URL>; network testnet",
  );
});

test("serve_env_lets_a_set_process_variable_win_over_the_files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tender-serve-env-"));
  dirs.push(dir);
  await writeFile(join(dir, ".env"), "TENDER_NETWORK=testnet\nA=from-env\nB=from-env\nC=\n");
  await writeFile(join(dir, ".env.deploy.testnet"), "B=from-testnet\nD=from-testnet\n");
  await writeFile(join(dir, ".env.deploy.mainnet"), "E=from-mainnet\n");

  // The network comes from .env, and its file wins over .env; the process wins over both, but
  // not where it sets a variable to nothing.
  expect(serveEnv({ A: "from-process", D: "", C: "from-process" }, dir)).toEqual({
    TENDER_NETWORK: "testnet",
    A: "from-process",
    B: "from-testnet",
    C: "from-process",
    D: "from-testnet",
  });
  // The process's network wins too, and picks the network's file.
  expect(serveEnv({ TENDER_NETWORK: "mainnet" }, dir)).toEqual({
    TENDER_NETWORK: "mainnet",
    A: "from-env",
    B: "from-env",
    C: "",
    E: "from-mainnet",
  });
  // A network that is none: .env alone, for readServeConfig to refuse.
  expect(serveEnv({ TENDER_NETWORK: "localnet" }, dir)).toMatchObject({
    TENDER_NETWORK: "localnet",
    B: "from-env",
  });
});

// ---- The keeper's key -------------------------------------------------------------------------

test("the_keeper_key_check_takes_only_a_function_call_key_limited_to_tender", async () => {
  const contract = "tender.tender-dev.testnet";
  const keeper = {
    accountId: "keeper.tender-dev.testnet",
    privateKey: KEEPER_KEY,
    intervalMs: undefined,
  };
  const publicKey = KeyPair.fromString(KEEPER_KEY as KeyPairString)
    .getPublicKey()
    .toString();
  const answering = (answer: { permission: KeyPermission } | null) => ({
    viewAccessKey: vi.fn(async () => answer),
  });

  // A function-call key limited to Tender: the keeper may start. The chain is asked about the
  // key's public half, on the keeper's account.
  const scoped = answering({
    permission: { FunctionCall: { receiver_id: contract, method_names: ["void_task", "cleanup"] } },
  });
  await expect(checkKeeperKey(scoped, keeper, contract)).resolves.toBeUndefined();
  expect(scoped.viewAccessKey).toHaveBeenCalledWith(keeper.accountId, publicKey);

  // Anything else is a refusal that names the variable and the key script, and shows no key.
  const refused: Array<[string, { permission: KeyPermission } | null, RegExp]> = [
    ["no such key", null, /^KEEPER_PRIVATE_KEY is not a key of keeper\.tender-dev\.testnet/],
    ["a full-access key", { permission: "FullAccess" }, /^KEEPER_PRIVATE_KEY is a full-access key/],
    [
      "a key limited to another contract",
      { permission: { FunctionCall: { receiver_id: "usdc.testnet", method_names: [] } } },
      /^KEEPER_PRIVATE_KEY is a key of .* that is not a function-call key limited to tender\./,
    ],
  ];
  for (const [what, answer, message] of refused) {
    const error = await checkKeeperKey(answering(answer), keeper, contract).then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );
    expect(error?.message, what).toMatch(message);
    expect(error?.message, what).toContain("scripts/keeper-key.ts");
    expect(error?.message, what).not.toContain(KEEPER_KEY.slice("ed25519:".length, 20));
  }
  // The account's full-access key may be its only one: the advice is never to delete it.
  const fullAccess = await checkKeeperKey(
    answering({ permission: "FullAccess" }),
    keeper,
    contract,
  ).then(
    () => "",
    (thrown: unknown) => (thrown as Error).message,
  );
  const warning = "Do not delete this key from the account";
  expect(fullAccess).toContain(warning);
  expect(fullAccess.replace(warning, "")).not.toMatch(/delete/i);

  // A chain that fails, or does not answer in 15 s, is a refusal too, which names only the kind
  // of the failure: the text of an RPC error can hold a URL with a key in it.
  const down = {
    viewAccessKey: async () => {
      throw new Error("fetch failed for https://rpc.example/?apiKey=SECRET");
    },
  };
  const failed = await checkKeeperKey(down, keeper, contract).then(
    () => "",
    (thrown: unknown) => (thrown as Error).message,
  );
  expect(failed).toMatch(/^cannot ask the chain what KEEPER_PRIVATE_KEY may do \(Error\)/);
  expect(failed).not.toContain("SECRET");
  vi.useFakeTimers();
  try {
    const silent = { viewAccessKey: () => new Promise<never>(() => undefined) };
    const pending = expect(checkKeeperKey(silent, keeper, contract)).rejects.toThrow(
      /\(NoAnswerInTime\)/,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
  } finally {
    vi.useRealTimers();
  }
});

// ---- The indexer lock -------------------------------------------------------------------------

/** A lock that is held until `lose` or `release`. `lose` gives the reason, as the real one does. */
function fakeLock() {
  const lost = new AbortController();
  const release = vi.fn(async () => undefined);
  const lock: SessionLock = { lost: lost.signal, release };
  const lose = (reason: unknown = new Error("Connection terminated unexpectedly")) =>
    lost.abort(reason);
  return { lock, release, lose };
}

/** What `start` is given: it counts the starts and stops of what it starts. */
function counted() {
  const events: string[] = [];
  const start = (): Stoppable => {
    events.push("start");
    return {
      async stop() {
        events.push("stop");
      },
    };
  };
  return { events, start };
}

test("the_indexer_waits_for_the_lock_saying_so_once_and_starts_when_it_is_taken", async () => {
  const holder = fakeLock();
  const tries: Array<() => Promise<SessionLock | null>> = [
    async () => null,
    async () => null,
    async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
        code: "ECONNREFUSED",
      });
    },
    async () => null,
    async () => holder.lock,
  ];
  const tryLock = vi.fn(() => (tries.shift() ?? (async () => null))());
  const { events, start } = counted();
  const lines: string[] = [];

  const indexing = await runWhileLocked({
    tryLock,
    start,
    guards: "the indexer and the keeper",
    log: (line) => lines.push(line),
    retryMs: 5,
  });
  // Another process holds the lock: nothing runs, and that is said, once, before this resolves.
  expect(events).toEqual([]);
  expect(lines).toEqual([
    "indexer: another services process holds the indexer lock; serving the API, and starting " +
      "the indexer and the keeper once the lock is free",
  ]);

  await vi.waitFor(() => expect(events).toEqual(["start"]));
  expect(tryLock).toHaveBeenCalledTimes(5);
  expect(lines.slice(1)).toEqual([
    "WARN indexer: cannot take the indexer lock (Error ECONNREFUSED); trying again in 0.005 s",
    "indexer: took the indexer lock; started the indexer and the keeper",
  ]);

  // Stopping stops the indexer, and only then lets the lock go.
  holder.release.mockImplementation(async () => {
    events.push("release");
  });
  await indexing.stop();
  expect(events).toEqual(["start", "stop", "release"]);
  expect(tryLock).toHaveBeenCalledTimes(5);
});

test("the_indexer_stops_when_the_lock_is_lost_and_waits_for_it_again", async () => {
  const first = fakeLock();
  const second = fakeLock();
  const answers: Array<SessionLock | null> = [first.lock, null, second.lock];
  const tryLock = vi.fn(async () => answers.shift() ?? null);
  const { events, start } = counted();
  const lines: string[] = [];

  const indexing = await runWhileLocked({
    tryLock,
    start,
    log: (line) => lines.push(line),
    retryMs: 5,
  });
  // The lock was free: the indexer runs before this resolves.
  expect(events).toEqual(["start"]);
  expect(lines).toEqual(["indexer: this process holds the indexer lock"]);

  // Its connection fails: the indexer stops, the lock is let go, and the waiting begins again.
  first.lose(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
  await vi.waitFor(() => expect(events).toEqual(["start", "stop", "start"]));
  expect(first.release).toHaveBeenCalledTimes(1);
  expect(lines.slice(1)).toEqual([
    "WARN indexer: lost the indexer lock, as its connection to the database failed " +
      "(Error ECONNRESET); stopped the indexer until it is taken again",
    "indexer: another services process holds the indexer lock; serving the API, and starting " +
      "the indexer once the lock is free",
    "indexer: took the indexer lock; started the indexer",
  ]);

  await indexing.stop();
  expect(events).toEqual(["start", "stop", "start", "stop"]);
  expect(second.release).toHaveBeenCalledTimes(1);
});

test("the_lock_is_let_go_when_the_indexer_fails_to_start", async () => {
  // At startup, a failure to start is the caller's to throw, with the lock let go.
  const free = fakeLock();
  const refused = new Error("no height to start indexing testnet from: set INDEXER_START_HEIGHT");
  await expect(
    runWhileLocked({
      tryLock: async () => free.lock,
      start: () => {
        throw refused;
      },
      log: () => undefined,
    }),
  ).rejects.toBe(refused);
  expect(free.release).toHaveBeenCalledTimes(1);

  // Later, once the lock is taken after a wait, it is logged, and nothing more is tried.
  const later = fakeLock();
  const answers: Array<SessionLock | null> = [null, later.lock];
  const tryLock = vi.fn(async () => answers.shift() ?? null);
  const lines: string[] = [];
  const indexing = await runWhileLocked({
    tryLock,
    start: () => {
      throw refused;
    },
    log: (line) => lines.push(line),
    retryMs: 5,
  });
  await vi.waitFor(() => expect(later.release).toHaveBeenCalledTimes(1));
  expect(lines.at(-1)).toBe(
    `ERROR indexer: cannot start the indexer (${refused.message}); not trying again`,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(tryLock).toHaveBeenCalledTimes(2);
  await indexing.stop();
});

test("a_lock_that_its_session_does_not_hold_points_at_database_url", async () => {
  // Behind a pooler in transaction mode. At startup that is a failure to start.
  const notHeld = new LockNotHeldError();
  await expect(
    runWhileLocked({
      tryLock: async () => {
        throw notHeld;
      },
      start: counted().start,
      log: () => undefined,
    }),
  ).rejects.toBe(notHeld);

  // Later, a check that finds the lock gone stops what runs, and so does each try that finds the
  // same; the lines say why, and what to look at.
  const first = fakeLock();
  const answers: Array<() => Promise<SessionLock | null>> = [
    async () => first.lock,
    async () => {
      throw new LockNotHeldError();
    },
  ];
  const tryLock = vi.fn(() => (answers.shift() ?? (async () => null))());
  const { events, start } = counted();
  const lines: string[] = [];
  const indexing = await runWhileLocked({
    tryLock,
    start,
    log: (line) => lines.push(line),
    retryMs: 5,
  });
  first.lose(new LockNotHeldError());
  await vi.waitFor(() => expect(tryLock.mock.calls.length).toBeGreaterThanOrEqual(3));
  await indexing.stop();
  expect(events).toEqual(["start", "stop"]);
  expect(lines.slice(0, 3)).toEqual([
    "indexer: this process holds the indexer lock",
    `WARN indexer: lost the indexer lock: ${notHeld.message} (DATABASE_URL); stopped the ` +
      "indexer until it is taken again",
    `WARN indexer: cannot take the indexer lock (${notHeld.message} (DATABASE_URL)); trying ` +
      "again in 0.005 s",
  ]);
});

test("stopping_while_waiting_for_the_lock_ends_the_wait", async () => {
  const tryLock = vi.fn(async () => null);
  const { events, start } = counted();
  const indexing = await runWhileLocked({ tryLock, start, log: () => undefined, retryMs: 60_000 });
  const started = Date.now();
  await indexing.stop();
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(events).toEqual([]);
  expect(tryLock).toHaveBeenCalledTimes(1);
});
