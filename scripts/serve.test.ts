import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyPermission } from "@tender/client";
import { LockNotHeldError, type SessionLock } from "@tender/db";
import { KeyPair, type KeyPairString } from "near-api-js";
import { afterEach, expect, test, vi } from "vitest";
import {
  checkJudgeKey,
  checkKeeperKey,
  publicUrlOf,
  readServeConfig,
  redact,
  redactConsole,
  runWhileLocked,
  ServeConfigError,
  type Stoppable,
  serveEnv,
  withLoops,
} from "./serve";

// The parts of `pnpm serve` that need no chain: what it makes of the environment, what it says
// when that is wrong, and how it waits for the indexer lock. `serve.sandbox.test.ts` starts the
// services themselves.

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const KEEPER_KEY = KeyPair.fromRandom("ed25519").toString();
const JUDGE_KEY = KeyPair.fromRandom("ed25519").toString();
/** A token in the shape @BotFather gives one. */
const BOT_TOKEN = "123456789:AAE-serve_test-token-0123456789abcdef";
const WEBHOOK_SECRET = "webhook_secret-for-tests";

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
  JUDGE_ACCOUNT: "judge.tender-dev.testnet",
  JUDGE_PRIVATE_KEY: JUDGE_KEY,
  JUDGE_INTERVAL_MS: "10000",
  LLM_BASE_URL: "https://llm.example/v1",
  LLM_API_KEY: "llm-key-for-tests",
  LLM_MODEL: "judge-model",
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_MODE: "webhook",
  TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
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
    judgeAccount: "judge.tender-dev.testnet",
    judge: {
      accountId: "judge.tender-dev.testnet",
      privateKey: JUDGE_KEY,
      intervalMs: 10_000,
      llm: { baseUrl: "https://llm.example/v1", apiKey: "llm-key-for-tests", model: "judge-model" },
    },
    // The bot links to the first web origin, as the origin it is.
    telegram: {
      token: BOT_TOKEN,
      webUrl: "https://tender.example",
      mode: "webhook",
      webhookSecret: WEBHOOK_SECRET,
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
    JUDGE_PRIVATE_KEY: "",
    TELEGRAM_BOT_TOKEN: "",
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
    judgeAccount: undefined,
    judge: undefined,
    telegram: undefined,
    warnings: [],
  });
  expect(readServeConfig({ ...GOOD, DATABASE_URL: "pglite:.data/index" }).database.kind).toBe(
    "pglite",
  );
  expect(readServeConfig({ ...GOOD, API_PORT: "0" }).apiPort).toBe(0);

  // Off the sandbox, no web origin is allowed, but said; the bot needs one, so it is off here.
  const bare = readServeConfig({ ...GOOD, PUBLIC_WEB_URL: "", TELEGRAM_BOT_TOKEN: "" });
  expect(bare.warnings).toEqual([
    "PUBLIC_WEB_URL is empty, so no web app may call the API from a browser",
  ]);
});

test("read_serve_config_reads_the_judge_and_the_bot_as_they_are_set", () => {
  // JUDGE_ACCOUNT alone: the API knows the Judge's account (P03-R29), and no Judge runs here.
  const apiOnly = readServeConfig({ ...GOOD, JUDGE_PRIVATE_KEY: "" });
  expect(apiOnly.judgeAccount).toBe("judge.tender-dev.testnet");
  expect(apiOnly.judge).toBeUndefined();
  expect(readServeConfig({ ...GOOD, JUDGE_ACCOUNT: "", JUDGE_PRIVATE_KEY: "" }).judgeAccount).toBe(
    undefined,
  );

  // The model goes to the Judge only with all three of its variables, and some of them are a
  // warning; without JUDGE_INTERVAL_MS the Judge takes its own default.
  const partial = readServeConfig({ ...GOOD, LLM_MODEL: "", JUDGE_INTERVAL_MS: "" });
  expect(partial.judge).toMatchObject({ llm: undefined, intervalMs: undefined });
  expect(partial.warnings).toEqual([
    "LLM_BASE_URL, LLM_API_KEY and LLM_MODEL are used only all three together, and some are not " +
      "set, so the Judge runs without a model",
  ]);
  const none = readServeConfig({ ...GOOD, LLM_BASE_URL: "", LLM_API_KEY: "", LLM_MODEL: "" });
  expect(none.judge?.llm).toBeUndefined();
  expect(none.warnings).toEqual([]);

  // Polling is the default, and takes no secret: one that is set is still checked, and kept out.
  for (const mode of ["", "polling"]) {
    const polling = readServeConfig({ ...GOOD, TELEGRAM_MODE: mode, TELEGRAM_WEBHOOK_SECRET: "" });
    expect(polling.telegram, mode).toEqual({
      token: BOT_TOKEN,
      webUrl: "https://tender.example",
      mode: "polling",
    });
  }
  expect(readServeConfig({ ...GOOD, TELEGRAM_MODE: "polling" }).telegram).not.toHaveProperty(
    "webhookSecret",
  );
  // The bot links to the origin of the first entry, as the browser spells it.
  const spelled = readServeConfig({ ...GOOD, PUBLIC_WEB_URL: "HTTPS://Tender.Example:443/" });
  expect(spelled.telegram?.webUrl).toBe("https://tender.example");

  // Without the token the bot is off. The mode and the secret are checked all the same, and the
  // web app may be left out.
  const off = readServeConfig({ ...GOOD, TELEGRAM_BOT_TOKEN: "", TELEGRAM_WEBHOOK_SECRET: "" });
  expect(off.telegram).toBeUndefined();
  expect(problemsOf({ ...GOOD, TELEGRAM_BOT_TOKEN: "", TELEGRAM_MODE: "push" })).toEqual([
    "TELEGRAM_MODE must be polling or webhook",
  ]);

  // A bot that no chat can be linked to is allowed, but said.
  expect(readServeConfig({ ...GOOD, TELEGRAM_BOT_USERNAME: "" }).warnings).toEqual([
    "TELEGRAM_BOT_USERNAME is not set, so no chat can be linked to an account " +
      "(POST /v1/telegram/link answers 503)",
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
    // A password shorter than 8 characters, as the server reads it: decoded.
    ["DATABASE_URL", "postgres://tender:short@db.internal/tender"],
    ["DATABASE_URL", "postgres://tender:%61%62%63%64%65%66%67@db.internal/tender"],
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
    // What `canonicalBase` refuses: a second spelling of a base, or one that is not where the
    // routes are.
    ["PUBLIC_API_URL", "https://api.tender.example./"],
    ["PUBLIC_API_URL", "https://api.tender.example//tender"],
    ["PUBLIC_API_URL", "https://api.tender.example/v1/v1"],
    // Plain http to another host, off the sandbox.
    ["PUBLIC_API_URL", "http://api.tender.example"],
    ["NEAR_RPC_URL", "ws://rpc.example"],
    ["NEARDATA_URL", "neardata"],
    ["TEAM_ACCOUNTS", "judge.tender-dev.testnet, Bad Account"],
    ["TELEGRAM_BOT_USERNAME", "@tender_bot"],
    ["TELEGRAM_BOT_USERNAME", "bot"],
    ["KEEPER_ACCOUNT", undefined],
    ["KEEPER_ACCOUNT", "Not An Account"],
    ["KEEPER_PRIVATE_KEY", "ed25519:not-a-key"],
    ["JUDGE_ACCOUNT", undefined],
    ["JUDGE_ACCOUNT", "Not An Account"],
    ["JUDGE_PRIVATE_KEY", "ed25519:not-a-key"],
    ["JUDGE_INTERVAL_MS", "0"],
    ["JUDGE_INTERVAL_MS", "10s"],
    // A username where the token goes, and a token cut short.
    ["TELEGRAM_BOT_TOKEN", "tender_test_bot"],
    ["TELEGRAM_BOT_TOKEN", "123456789:"],
    ["TELEGRAM_BOT_TOKEN", "123456789:AAE token"],
    ["TELEGRAM_MODE", "push"],
    ["TELEGRAM_MODE", "Webhook"],
    ["TELEGRAM_WEBHOOK_SECRET", undefined],
    ["TELEGRAM_WEBHOOK_SECRET", "a secret"],
    ["TELEGRAM_WEBHOOK_SECRET", "x".repeat(15)],
    ["TELEGRAM_WEBHOOK_SECRET", "x".repeat(257)],
    // The bot's messages link to the web app.
    ["PUBLIC_WEB_URL", undefined],
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
  // Spelled as the API spells it too: on port 80 the port is the default one, and goes.
  expect(publicUrlOf(unset, 80)).toBe("http://127.0.0.1");

  // Set, it is the URL as `canonicalBase` spells it, on any network: less a trailing slash and a
  // final /v1, with the scheme and the host in lower case and no default port. A path is part of
  // it.
  for (const [value, base] of [
    ["https://api.tender.example/", "https://api.tender.example"],
    ["https://tender.example/api", "https://tender.example/api"],
    ["http://localhost:8787", "http://localhost:8787"],
    ["HTTPS://API.Tender.Example:443/v1/", "https://api.tender.example"],
    ["http://127.0.0.1:80/tender/v1", "http://127.0.0.1/tender"],
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

test("public_api_url_is_https_off_the_sandbox_unless_it_is_this_machine", () => {
  // Off the sandbox, plain http to another host would carry sign-in tokens and uploads in the
  // clear, and every client with a key would refuse it: the services do not start with one. The
  // message names the variable, and shows nothing of its value.
  const plain =
    "PUBLIC_API_URL must be https off the sandbox, or plain http only to localhost, 127.0.0.1 " +
    "or [::1]: over plain http to another host, sign-in tokens and uploads go in the clear, and " +
    "no client with a key signs in";
  const sandbox = {
    TENDER_NETWORK: "sandbox",
    TENDER_CONTRACT: "tender.sandbox",
    DATABASE_URL: "pglite:memory",
    NEAR_RPC_URL: "http://127.0.0.1:3030",
  };
  for (const network of ["testnet", "mainnet"]) {
    for (const value of [
      "http://api.tender.example",
      "HTTP://API.Tender.Example:8787/v1",
      "http://192.168.1.10:8787",
      "http://[2001:db8::1]:8787",
      "http://127.0.0.2:8787",
    ]) {
      const what = `${network} ${value}`;
      expect(problemsOf({ ...GOOD, TENDER_NETWORK: network, PUBLIC_API_URL: value }), what).toEqual(
        [plain],
      );
      // On the sandbox, a LAN address or any other host stays allowed.
      expect(problemsOf({ ...sandbox, PUBLIC_API_URL: value }), value).toEqual([]);
    }
    // https anywhere, and plain http to this machine, in each of its three spellings.
    for (const value of [
      "https://api.tender.example",
      "https://192.168.1.10:8443",
      "http://localhost:8787",
      "http://LOCALHOST:8787/",
      "http://127.0.0.1:8787",
      "http://[::1]:8787",
    ]) {
      const what = `${network} ${value}`;
      expect(problemsOf({ ...GOOD, TENDER_NETWORK: network, PUBLIC_API_URL: value }), what).toEqual(
        [],
      );
    }
  }
});

test("no_secret_value_appears_in_any_error", () => {
  // Secrets, and things that may be, in every variable that is checked: each value is wrong, and
  // carries a marker. A private key in the account's variable is the classic mix-up.
  const realKey = KeyPair.fromRandom("ed25519").toString();
  const marked: Record<string, string> = {
    TENDER_NETWORK: "PLANTED-network",
    TENDER_CONTRACT: "PLANTED-contract",
    DATABASE_URL: "mysql://tender:PLANTED-password@db.internal/tender",
    API_PORT: "PLANTED-port",
    INDEXER_POLL_MS: "PLANTED-poll",
    KEEPER_INTERVAL_MS: "PLANTED-interval",
    INDEXER_START_HEIGHT: "PLANTED-height",
    TRUSTED_PROXY_HOPS: "PLANTED-hops",
    PUBLIC_WEB_URL: "https://PLANTED-web.example/path",
    PUBLIC_API_URL: "PLANTED-api",
    NEAR_RPC_URL: "ftp://rpc.example/?apiKey=PLANTED-rpc",
    NEARDATA_URL: "ftp://neardata.example/?apiKey=PLANTED-neardata",
    TEAM_ACCOUNTS: "PLANTED-team",
    TELEGRAM_BOT_USERNAME: "PLANTED bot",
    KEEPER_ACCOUNT: realKey,
    KEEPER_PRIVATE_KEY: "ed25519:PLANTED-key",
    JUDGE_ACCOUNT: realKey,
    JUDGE_PRIVATE_KEY: "ed25519:PLANTED-judge-key",
    JUDGE_INTERVAL_MS: "PLANTED-judge-interval",
    TELEGRAM_BOT_TOKEN: "PLANTED-token",
    TELEGRAM_MODE: "PLANTED-mode",
    TELEGRAM_WEBHOOK_SECRET: "PLANTED webhook",
  };
  let message = "";
  try {
    readServeConfig(marked);
  } catch (error) {
    message = (error as Error).message;
  }
  expect((message.match(/^ {2}- /gm) ?? []).length).toBe(Object.keys(marked).length);
  expect(message).not.toContain("PLANTED");
  expect(message).not.toContain(realKey.slice("ed25519:".length, 20));
  // A real token that only lacks a web app to link to is not shown either.
  const missing = problemsOf({ ...GOOD, PUBLIC_WEB_URL: "", TELEGRAM_MODE: "polling" });
  expect(missing).toHaveLength(1);
  expect(missing.join("\n")).not.toContain(BOT_TOKEN.slice(10));

  // What the command line prints of any other error passes through `redact`, which takes out the
  // value of each secret variable, and the password of a URL.
  const env = {
    KEEPER_PRIVATE_KEY: realKey,
    DATABASE_URL: "postgres://tender:pass%40word@db.internal/tender",
    // A password whose % starts no escape: it is taken out as it is written.
    TEST_DATABASE_URL: "postgres://tester:odd%zzpass@db.internal/test",
    NEAR_RPC_URL: "https://rpc.example/?apiKey=abcdef123",
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TENDER_NETWORK: "testnet",
  };
  const printed = redact(
    `failed with ${realKey} at ${env.NEAR_RPC_URL}; password pass@word, odd%zzpass; network ` +
      `testnet; request to https://api.telegram.org/bot${BOT_TOKEN}/getMe failed`,
    env,
  );
  expect(printed).toBe(
    "failed with <KEEPER_PRIVATE_KEY> at <NEAR_RPC_URL>; password <password of DATABASE_URL>, " +
      "<password of TEST_DATABASE_URL>; network testnet; request to " +
      "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getMe failed",
  );

  // A secret shorter than 8 characters is left where it is, a password among them: it is likely a
  // word of ordinary text as well, and taking it out would garble every line it is in.
  const short = {
    DATABASE_URL: "postgres://tender:tender@db.internal/tender",
    TELEGRAM_WEBHOOK_SECRET: "s3cr3t",
  };
  const line = "serve: keeper on, as keeper.tender-dev.testnet; the webhook takes s3cr3t";
  expect(redact(line, short)).toBe(line);
  expect(redact(`cannot connect to ${short.DATABASE_URL}`, short)).toBe(
    "cannot connect to <DATABASE_URL>",
  );
});

test("a_database_password_or_a_webhook_secret_too_short_to_hide_is_refused", () => {
  // W-R4. A database password, if there is one, has 8 characters or more as the server reads it,
  // decoded: `redact` hides no shorter one. A webhook secret has 16 or more.
  for (const url of [
    "postgres://tender:12345678@db.internal/tender",
    "postgresql://tender:%41%42%43%44%45%46%47%48@db.internal/tender",
    "postgres://tender@db.internal/tender",
    "postgres://db.internal/tender",
  ]) {
    expect(problemsOf({ ...GOOD, DATABASE_URL: url }), url).toEqual([]);
  }
  expect(problemsOf({ ...GOOD, TELEGRAM_WEBHOOK_SECRET: "x".repeat(16) })).toEqual([]);
  const short = problemsOf({
    ...GOOD,
    DATABASE_URL: "postgres://tender:tender@db.internal/tender",
    TELEGRAM_WEBHOOK_SECRET: "fifteen-chars-x",
  });
  expect(short).toEqual([
    "DATABASE_URL must have a password of 8 characters or more, when it has one: a shorter one " +
      "is easy to guess, and the logs do not hide it (it is not shown)",
    "TELEGRAM_WEBHOOK_SECRET must be 16 to 256 letters, digits, underscores and hyphens: the " +
      "characters Telegram takes in a secret token, and enough of them not to be guessed (its " +
      "value is not shown)",
  ]);
  expect(short.join("\n")).not.toContain("fifteen");
});

test("the_command_line_redacts_all_it_prints_errors_and_all", () => {
  // `main` makes the console print through `redact`. It is the text printed that is redacted, so
  // that a secret deep in an error is caught: a grammY HttpError holds the transport's error, whose
  // message quotes the request's URL, and the bot's token with it.
  const printed: Record<"log" | "info" | "warn" | "error", string[]> = {
    log: [],
    info: [],
    warn: [],
    error: [],
  };
  /** What the console does with what it is given: here, keeps the one text it is handed. */
  const keep =
    (into: string[]) =>
    (...args: unknown[]) => {
      into.push(args.map(String).join(" "));
    };
  const target = {
    log: keep(printed.log),
    info: keep(printed.info),
    warn: keep(printed.warn),
    error: keep(printed.error),
  };
  const env = {
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DATABASE_URL: "postgres://tender:pass-word-1@db.internal/tender",
    TENDER_NETWORK: "testnet",
  };
  redactConsole(env, target);

  const transport = new Error(
    `request to https://api.telegram.org/bot${BOT_TOKEN}/sendMessage failed, reason: ` +
      "getaddrinfo ENOTFOUND api.telegram.org",
  );
  const httpError = Object.assign(new Error("Network request for 'sendMessage' failed!"), {
    error: transport,
  });
  target.error("telegram bot: update 7 failed:", httpError);
  target.warn("%s at %s", "cannot connect", env.DATABASE_URL);
  target.log({ database: { url: env.DATABASE_URL }, network: "testnet" });
  target.info("serve: API at http://127.0.0.1:8787 (testnet)");

  expect(printed.error).toHaveLength(1);
  expect(printed.error[0]).toMatch(/^telegram bot: update 7 failed: Error: Network request for/);
  expect(printed.error[0]).toContain(
    "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage",
  );
  expect(printed.warn).toEqual(["cannot connect at <DATABASE_URL>"]);
  expect(printed.log).toHaveLength(1);
  expect(printed.log[0]).toContain("url: '<DATABASE_URL>'");
  expect(printed.info).toEqual(["serve: API at http://127.0.0.1:8787 (testnet)"]);
  for (const text of Object.values(printed).flat()) {
    expect(text).not.toContain(BOT_TOKEN.slice("123456789:".length));
    expect(text).not.toContain("pass-word-1");
  }
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

test("the_keeper_key_check_takes_only_a_function_call_key_for_the_keepers_methods", async () => {
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

  const calling = (receiver_id: string, method_names: string[]): KeyPermission => ({
    FunctionCall: { receiver_id, method_names },
  });

  // The key `scripts/keeper-key.ts` adds, limited to Tender for the keeper's methods: the keeper
  // may start. The chain is asked about the key's public half, on the keeper's account.
  for (const methods of [
    ["void_task", "cleanup"],
    ["cleanup", "void_task"],
  ]) {
    const scoped = answering({ permission: calling(contract, methods) });
    await expect(checkKeeperKey(scoped, keeper, contract)).resolves.toBeUndefined();
    expect(scoped.viewAccessKey).toHaveBeenCalledWith(keeper.accountId, publicKey);
  }

  // Anything else is a refusal that names the variable and the key script, and shows no key. A
  // key that may call any method (none listed), or other ones, is not the keeper's.
  const notTheKeepers =
    /^KEEPER_PRIVATE_KEY is a key of keeper\.tender-dev\.testnet \(KEEPER_ACCOUNT\) that is not a function-call key limited to tender\.tender-dev\.testnet for void_task and cleanup\./;
  const refused: Array<[string, { permission: KeyPermission } | null, RegExp]> = [
    ["no such key", null, /^KEEPER_PRIVATE_KEY is not a key of keeper\.tender-dev\.testnet/],
    ["a full-access key", { permission: "FullAccess" }, /^KEEPER_PRIVATE_KEY is a full-access key/],
    [
      "a key limited to another contract",
      { permission: calling("usdc.testnet", ["void_task", "cleanup"]) },
      notTheKeepers,
    ],
    ["a key for any method", { permission: calling(contract, []) }, notTheKeepers],
    ["a key for void_task alone", { permission: calling(contract, ["void_task"]) }, notTheKeepers],
    [
      "a key for the judge's methods",
      { permission: calling(contract, ["pick", "pick_attested"]) },
      notTheKeepers,
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

test("the_judge_key_check_takes_only_a_function_call_key_for_the_judges_methods", async () => {
  const contract = "tender.tender-dev.testnet";
  const judge = { accountId: "judge.tender-dev.testnet", privateKey: JUDGE_KEY };
  const publicKey = KeyPair.fromString(JUDGE_KEY as KeyPairString)
    .getPublicKey()
    .toString();
  const answering = (answer: { permission: KeyPermission } | null) => ({
    viewAccessKey: vi.fn(async () => answer),
  });
  const calling = (receiver_id: string, method_names: string[]): KeyPermission => ({
    FunctionCall: { receiver_id, method_names },
  });

  // The key `scripts/keeper-key.ts --role judge` adds, whatever the order of its methods.
  for (const methods of [
    ["pick", "pick_attested"],
    ["pick_attested", "pick"],
  ]) {
    const scoped = answering({ permission: calling(contract, methods) });
    await expect(checkJudgeKey(scoped, judge, contract)).resolves.toBeUndefined();
    expect(scoped.viewAccessKey).toHaveBeenCalledWith(judge.accountId, publicKey);
  }

  // Anything else is a refusal that names the variable and the key script with its role, and
  // shows no key. A key that may call any method (none listed) or another one is not the judge's.
  const notTheJudges =
    /^JUDGE_PRIVATE_KEY is a key of judge\.tender-dev\.testnet \(JUDGE_ACCOUNT\) that is not a function-call key limited to tender\.tender-dev\.testnet for pick and pick_attested\./;
  const refused: Array<[string, { permission: KeyPermission } | null, RegExp]> = [
    ["no such key", null, /^JUDGE_PRIVATE_KEY is not a key of judge\.tender-dev\.testnet/],
    ["a full-access key", { permission: "FullAccess" }, /^JUDGE_PRIVATE_KEY is a full-access key/],
    ["a key to another contract", { permission: calling("usdc.testnet", ["pick"]) }, notTheJudges],
    ["a key for any method", { permission: calling(contract, []) }, notTheJudges],
    ["a key for pick alone", { permission: calling(contract, ["pick"]) }, notTheJudges],
    [
      "a key for the keeper's methods",
      { permission: calling(contract, ["void_task", "cleanup"]) },
      notTheJudges,
    ],
    [
      "a key for one method more",
      { permission: calling(contract, ["pick", "pick_attested", "withdraw"]) },
      notTheJudges,
    ],
  ];
  for (const [what, answer, message] of refused) {
    const error = await checkJudgeKey(answering(answer), judge, contract).then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );
    expect(error?.message, what).toMatch(message);
    expect(error?.message, what).toContain("scripts/keeper-key.ts --role judge");
    expect(error?.message, what).not.toContain(JUDGE_KEY.slice("ed25519:".length, 20));
  }
  const fullAccess = await checkJudgeKey(
    answering({ permission: "FullAccess" }),
    judge,
    contract,
  ).then(
    () => "",
    (thrown: unknown) => (thrown as Error).message,
  );
  expect(fullAccess).toContain("the Judge will not hold one");
  expect(fullAccess.replace("Do not delete this key from the account", "")).not.toMatch(/delete/i);

  // A chain that fails is a refusal that names the kind of failure only.
  const down = {
    viewAccessKey: async () => {
      throw new Error("fetch failed for https://rpc.example/?apiKey=SECRET");
    },
  };
  const failed = await checkJudgeKey(down, judge, contract).then(
    () => "",
    (thrown: unknown) => (thrown as Error).message,
  );
  expect(failed).toBe(
    "cannot ask the chain what JUDGE_PRIVATE_KEY may do (Error), and the Judge does not start " +
      "with a key that was not checked",
  );
});

// ---- The work under the lock ------------------------------------------------------------------

test("stopping_the_work_stops_the_indexer_without_waiting_for_the_loops", async () => {
  // On a lost lock, the indexer must not go on writing while the Judge or the keeper finish a call
  // in flight: its stop starts at once, and the work is down only once the loops are too.
  const events: string[] = [];
  let finishIndexing: (() => void) | undefined;
  const indexer: Stoppable = {
    stop: () => {
      events.push("indexer stopping");
      return new Promise<void>((resolve) => {
        finishIndexing = () => {
          events.push("indexer stopped");
          resolve();
        };
      });
    },
  };
  const stopLoops = new AbortController();
  /** A loop that ends a while after its abort, as one with a call in flight does. */
  const loop = (name: string, ms: number) =>
    new Promise<void>((resolve) => {
      stopLoops.signal.addEventListener("abort", () => {
        events.push(`${name} aborted`);
        setTimeout(() => {
          events.push(`${name} stopped`);
          resolve();
        }, ms);
      });
    });
  const work = withLoops(indexer, stopLoops, [loop("judge", 30), loop("keeper", 10)]);

  let down = false;
  const stopping = work.stop().then(() => {
    down = true;
  });
  expect(events).toEqual(["judge aborted", "keeper aborted", "indexer stopping"]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(down).toBe(false);
  finishIndexing?.();
  await stopping;
  expect(events.slice(3)).toEqual(["keeper stopped", "judge stopped", "indexer stopped"]);

  // An indexer that fails to stop fails the stop, once the loops are down, and is never left
  // unhandled in the meantime.
  const broken = new Error("the indexer did not stop");
  const loops = new AbortController();
  let looped = false;
  const slow = new Promise<void>((resolve) => {
    loops.signal.addEventListener("abort", () =>
      setTimeout(() => {
        looped = true;
        resolve();
      }, 20),
    );
  });
  await expect(
    withLoops({ stop: () => Promise.reject(broken) }, loops, [slow]).stop(),
  ).rejects.toBe(broken);
  expect(looped).toBe(true);
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
