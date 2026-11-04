import { writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { format, type InspectOptions, inspect } from "node:util";
import {
  type ApiServer,
  createApp,
  type ErrorBody,
  NoAnswerInTime,
  resultUsable,
  startApiServer,
  startKeeper,
  withinDeadline,
} from "@tender/api";
import { keyKindOf, TenderClient } from "@tender/client";
import {
  type Db,
  LockNotHeldError,
  migrate,
  openDb,
  type PgliteLockOptions,
  type SessionLock,
  tryAdvisoryLock,
} from "@tender/db";
import {
  type CheckAgainstChainOptions,
  checkAgainstChain,
  checkCursorSource,
  checkIndexerEnv,
  type DeploymentChain,
  IndexerError,
  startIndexer,
} from "@tender/indexer";
import { startJudge } from "@tender/judge";
import { AccountIdSchema, canonicalBase, NETWORKS, type NetworkId } from "@tender/shared";
import {
  BOT_COMMANDS,
  createBot,
  startNotifier,
  WEBHOOK_SECRET,
  webhookHandler,
} from "@tender/telegram";
import { parseKey } from "./deploy";
import { roleMethods } from "./keeper-key";
import { deploymentsDirOverride, envDir, loadEnv, readEnvFile } from "./lib/env";

/**
 * `pnpm serve`: the one process that runs the services of a deployment against one database.
 *
 *   database   opened from DATABASE_URL and migrated, and checked: it serves one contract deploy,
 *              so one whose chain cursor is for another is refused at the start
 *              (`checkCursorSource`)
 *   API        on API_PORT (default 8787), for the web app, agents and MCP clients, at the base
 *              URL PUBLIC_API_URL, which sign-in is bound to (P03-R28)
 *   indexer    follows the chain into the database; on Postgres only while this process holds
 *              the indexer lock, so that one process at a time writes to the index (P03-R25).
 *              The indexer, the keeper and the Judge start once the database has been checked
 *              against the chain (`checkAgainstChain`): a node that does not answer or is behind
 *              is waited for, with the API serving meanwhile (and `GET /v1/health` saying
 *              `waiting_for_chain: true`, for a monitor), and a database that is another
 *              deploy's is refused: none of the three starts, and the process ends with 1
 *   keeper     voids and cleans up tasks, when KEEPER_PRIVATE_KEY is set, and runs with the
 *              indexer, under the same lock, so that no two processes send the same calls; off the
 *              sandbox its key must be a function-call key limited to Tender for the keeper's
 *              methods, which the chain is asked about first
 *   Judge      judges the tasks that name JUDGE_ACCOUNT as their verifier, when JUDGE_PRIVATE_KEY
 *              is set, under the same lock as the keeper, since two Judges would pick twice; off
 *              the sandbox its key must be a function-call key limited to Tender for the judge's
 *              methods, which the chain is asked about first
 *   Telegram   the bot and the notifier, when TELEGRAM_BOT_TOKEN is set: the bot takes its updates
 *              by long polling (TELEGRAM_MODE=polling, the default), or at POST /telegram/webhook
 *              (webhook), and the notifier sends the alerts
 *
 * The environment is checked before anything starts (`readServeConfig`), and every problem with
 * it is named in one error. On the first SIGTERM or SIGINT the command line stops everything
 * (`Services.stop`) and exits with 0; a second signal exits with 1 at once. A failure to start
 * prints its message, with no secret in it, and exits with 1.
 */

/** The port the API listens on unless `API_PORT` says otherwise. */
const DEFAULT_API_PORT = 8787;
/** The longest wait `setTimeout` keeps, which bounds every interval in milliseconds. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** The most proxies `TRUSTED_PROXY_HOPS` may name. */
const MAX_PROXY_HOPS = 10;
const U64_MAX = 2n ** 64n - 1n;
const NS_PER_MS = 1_000_000n;
/** A Telegram username, as in t.me/<username>. */
const TELEGRAM_USERNAME = /^[A-Za-z0-9_]{5,32}$/;
/** A bot token as @BotFather gives it: the bot's id, a colon, and the secret part. */
const TELEGRAM_TOKEN = /^[0-9]+:[A-Za-z0-9_-]+$/;
/**
 * The shortest webhook secret the services take. Telegram takes one of 1 character; this many keep
 * it out of reach of guessing.
 */
const MIN_WEBHOOK_SECRET_LENGTH = 16;
/**
 * The shortest secret `redact` takes out. A shorter one is likely to be a word of ordinary text as
 * well, as a database password such as `tender` is, and taking it out wherever it is would garble
 * every line it is in, and point at it. So a `DATABASE_URL` password shorter than this is refused.
 */
const MIN_REDACTED_LENGTH = 8;
/**
 * The passwords of a database off the sandbox that are refused besides the user name: the stock
 * password of the Postgres image and the first ones a guesser tries. Compared in lower case.
 */
const COMMON_PASSWORDS: readonly string[] = ["postgres", "password", "tender"];

/**
 * Where Telegram posts the bot's updates in webhook mode. It is not under `/v1`, and so not under
 * its CORS: no browser calls it.
 */
export const TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";
/** The largest body the webhook reads, 1 MiB: an update of Telegram's is a few KiB. */
const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
/**
 * How long `stop` waits for the Telegram side before it goes on without it: a Telegram that does
 * not answer would hold it for good, since the bot's calls are retried until they go through.
 */
export const TELEGRAM_STOP_MS = 5_000;

/**
 * The key of the indexer's session advisory lock, one per database whatever the deployment: it
 * spells "INDEXER", as the migration lock of `@tender/db` spells "TENDER".
 */
export const INDEXER_LOCK_KEY = 0x494e4445584552n;
/** How often a process that waits for the indexer lock tries again. */
const LOCK_RETRY_MS = 5_000;
/** How long the chain has to say what the key of the keeper or the Judge may do, at startup. */
const KEY_CHECK_DEADLINE_MS = 15_000;

// ---- The environment --------------------------------------------------------------------------

/** What the services run with, as `readServeConfig` reads it from the environment. */
export interface ServeConfig {
  network: NetworkId;
  /** The Tender contract's account. */
  contractId: string;
  /** `DATABASE_URL`, and which kind of database it names. */
  database: { url: string; kind: "pglite" | "postgres" };
  /** `API_PORT`: 8787 unless set; 0 picks a free port. */
  apiPort: number;
  /**
   * `PUBLIC_API_URL` as `canonicalBase` spells it, the one spelling that sign-in and the blob URIs
   * use (P03-R28c). Off the sandbox it is always set; on the sandbox, undefined stands for the
   * loopback address on the port the server is bound to (`publicUrlOf`).
   */
  publicApiUrl: string | undefined;
  /** `NEAR_RPC_URL`; off the sandbox, undefined means the network's own. */
  rpcUrl: string | undefined;
  /** `PUBLIC_WEB_URL`, split at its commas. */
  webOrigins: string[];
  /** `TEAM_ACCOUNTS`, split at its commas. */
  teamAccounts: string[];
  telegramBotUsername: string | undefined;
  /** `TRUSTED_PROXY_HOPS`: 0 unless set. */
  trustedProxyHops: number;
  /** The keeper's account, key and interval, when `KEEPER_PRIVATE_KEY` is set. */
  keeper: KeeperConfig | undefined;
  /**
   * `JUDGE_ACCOUNT`, whenever it is set, with the Judge here or not: the API takes a scorecard
   * that carries the Judge's name from this account alone (P03-R29).
   */
  judgeAccount: string | undefined;
  /** The Judge's account, key, interval and model, when `JUDGE_PRIVATE_KEY` is set. */
  judge: JudgeConfig | undefined;
  /** The Telegram bot and the notifier, when `TELEGRAM_BOT_TOKEN` is set. */
  telegram: TelegramConfig | undefined;
  /** What the environment allows but is likely a mistake, one sentence each. */
  warnings: string[];
}

export interface KeeperConfig {
  accountId: string;
  privateKey: string;
  /** `KEEPER_INTERVAL_MS`, or undefined for the keeper's default. */
  intervalMs: number | undefined;
}

export interface JudgeConfig {
  accountId: string;
  privateKey: string;
  /** `JUDGE_INTERVAL_MS`, or undefined for the Judge's default. */
  intervalMs: number | undefined;
  /** `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`, when all three are set (rubric is P1). */
  llm: { baseUrl: string; apiKey: string; model: string } | undefined;
}

/** The bot's token and where its links go, and how it takes its updates (`TELEGRAM_MODE`). */
export type TelegramConfig = {
  /** `TELEGRAM_BOT_TOKEN`, a secret, which nothing prints. */
  token: string;
  /** The origin of the first `PUBLIC_WEB_URL` entry, which the bot's messages link to. */
  webUrl: string;
} & (
  | { mode: "polling" }
  | {
      mode: "webhook";
      /** `TELEGRAM_WEBHOOK_SECRET`: what Telegram sends with each update, a secret too. */
      webhookSecret: string;
    }
);

/**
 * What `readServeConfig` throws: every problem with the environment, one sentence each, naming
 * its variable. None quotes a value.
 */
export class ServeConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`the services cannot start:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ServeConfigError";
    this.problems = problems;
  }
}

/** The value of `key`, trimmed; undefined when it is unset or empty (a blank line of `.env`). */
function setting(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** The entries of a list separated by commas, trimmed, with the empty ones dropped. */
const entriesOf = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

const isAccountId = (value: string) => AccountIdSchema.safeParse(value).success;

/** `value` as a whole number from `min` to `max` in plain decimal digits, or undefined. */
function wholeNumber(value: string, min: number, max: number): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
}

/** Whether `password`, if there is one, is the user name `user` or one of the common passwords. */
function isCommonPassword(password: string, user: string): boolean {
  const word = password.toLowerCase();
  return word !== "" && (word === user.toLowerCase() || COMMON_PASSWORDS.includes(word));
}

function httpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** An http(s) URL that is an origin: no credentials, path, query or fragment. */
function isHttpOrigin(value: string): boolean {
  const url = httpUrl(value);
  return (
    url !== undefined &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === ""
  );
}

/**
 * A base URL the API can be called at: http(s), with no query, fragment or credentials. Sign-in is
 * bound to it, and the blob URIs that go on chain begin with it.
 */
function isApiBase(value: string): boolean {
  const url = httpUrl(value);
  return (
    url !== undefined &&
    url.username === "" &&
    url.password === "" &&
    !value.includes("?") &&
    !value.includes("#")
  );
}

/**
 * The hosts that plain http may go to off the sandbox: this machine, in the three forms in which
 * the URL parser leaves a loopback host, as `ApiClient` takes them.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether `base`, a canonical base, is https, or plain http to this machine. */
function isSecureBase(base: string): boolean {
  const { protocol, hostname } = new URL(base);
  return protocol === "https:" || (protocol === "http:" && LOOPBACK_HOSTS.has(hostname));
}

/** The kind of database `url` names, as `openDb` reads it, or undefined for one it does not take. */
function databaseKind(url: string): "pglite" | "postgres" | undefined {
  if (url === "pglite:memory" || (url.startsWith("pglite:") && url !== "pglite:")) return "pglite";
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return "postgres";
  return undefined;
}

/**
 * Reads and checks the environment of `pnpm serve`, and starts nothing. It throws one
 * `ServeConfigError` that names every variable that is wrong, and quotes no value of any, since
 * some of them are secrets. It checks:
 *
 * - `TENDER_NETWORK` (sandbox, testnet or mainnet), `TENDER_CONTRACT` (an account id) and
 *   `DATABASE_URL` (`pglite:memory`, `pglite:<dir>` or a Postgres URL, whose password, if it has
 *   one, has 8 characters or more, and off the sandbox is neither its user name nor `postgres`,
 *   `password` or `tender`), which must all be set;
 * - `API_PORT`, `INDEXER_POLL_MS`, `KEEPER_INTERVAL_MS`, `JUDGE_INTERVAL_MS`,
 *   `INDEXER_START_HEIGHT` and `TRUSTED_PROXY_HOPS`, which must be whole numbers in plain decimal
 *   digits, each in its range;
 * - `PUBLIC_API_URL`, the exact base URL clients call, which sign-in is bound to: it must be set
 *   off the sandbox, be an http(s) URL with no query, fragment or credentials, and have the one
 *   spelling `canonicalBase` gives it (no empty path segment, no second `/v1`, no dot at the end
 *   of the host). Off the sandbox it must be https, or plain http only to this machine;
 * - `PUBLIC_WEB_URL`, whose entries must be http(s) origins, and `NEAR_RPC_URL` and
 *   `NEARDATA_URL`, which must be http(s) URLs. `NEAR_RPC_URL` must be set on the sandbox, whose
 *   node has no fixed address;
 * - `TEAM_ACCOUNTS`, whose entries must be account ids, and `TELEGRAM_BOT_USERNAME`, which must be
 *   a username as in t.me/<username>;
 * - with `KEEPER_PRIVATE_KEY` set, that it is a private key and `KEEPER_ACCOUNT` an account id;
 * - `JUDGE_ACCOUNT`, which must be an account id when it is set, and must be set with
 *   `JUDGE_PRIVATE_KEY`, which must be a private key;
 * - `TELEGRAM_MODE`, polling or webhook, and `TELEGRAM_WEBHOOK_SECRET`, which must be what
 *   Telegram takes as a secret token, 16 characters or more. With `TELEGRAM_BOT_TOKEN` set, that
 *   it looks like a bot's token, that `PUBLIC_WEB_URL` names the web app the bot links to, and in
 *   webhook mode that the secret is set.
 *
 * An empty value is an unset one. Off the sandbox, an empty `PUBLIC_WEB_URL` is a warning: allowed,
 * but likely a mistake. So are no `FASTNEAR_API_KEY`, without which neardata rate limits the
 * indexer, a bot without `TELEGRAM_BOT_USERNAME`, which no chat can be linked to, and a Judge with
 * some of the `LLM_*` variables but not all three.
 */
export function readServeConfig(env: Record<string, string | undefined>): ServeConfig {
  const problems: string[] = [];
  const warnings: string[] = [];
  const get = (key: string) => setting(env, key);
  /** A whole number setting: its value, or undefined when it is unset or wrong (a problem). */
  const whole = (key: string, min: number, max: number, what: string) => {
    const value = get(key);
    if (value === undefined) return undefined;
    const n = wholeNumber(value, min, max);
    if (n === undefined) problems.push(`${key} must be ${what}`);
    return n;
  };
  const milliseconds = `a whole number of milliseconds from 1 to ${MAX_TIMER_MS}`;

  const networkValue = get("TENDER_NETWORK");
  const network =
    networkValue !== undefined && Object.hasOwn(NETWORKS, networkValue)
      ? (networkValue as NetworkId)
      : undefined;
  if (network === undefined) {
    const unset = networkValue === undefined ? " (it is not set)" : "";
    problems.push(`TENDER_NETWORK must be sandbox, testnet or mainnet${unset}`);
  }
  const offSandbox = network !== undefined && network !== "sandbox";

  const contractId = get("TENDER_CONTRACT");
  if (contractId === undefined || !isAccountId(contractId)) {
    problems.push("TENDER_CONTRACT must be the account id of the Tender contract");
  }

  const databaseUrl = get("DATABASE_URL");
  const kind = databaseUrl === undefined ? undefined : databaseKind(databaseUrl);
  if (kind === undefined) {
    const unset = databaseUrl === undefined ? " (it is not set)" : "";
    problems.push(`DATABASE_URL must be pglite:memory, pglite:<dir> or a postgres:// URL${unset}`);
  } else if (kind === "postgres" && databaseUrl !== undefined) {
    // As the server reads it: decoded. A password `redact` would leave in the logs is refused.
    const url = URL.parse(databaseUrl);
    const password = decoded(url?.password ?? "");
    if (password !== "" && password.length < MIN_REDACTED_LENGTH) {
      problems.push(
        `DATABASE_URL must have a password of ${MIN_REDACTED_LENGTH} characters or more, when ` +
          "it has one: a shorter one is easy to guess, and the logs do not hide it (it is not " +
          "shown)",
      );
    } else if (offSandbox && isCommonPassword(password, decoded(url?.username ?? ""))) {
      // The sandbox keeps CI's own, `postgres`. Elsewhere `redact` would also take the word out of
      // every line it is in, and mark where it was.
      problems.push(
        "DATABASE_URL must have a password that is not its user name, postgres, password or " +
          "tender, off the sandbox: they are the first a guesser tries (it is not shown)",
      );
    }
  }

  const apiPort =
    whole("API_PORT", 0, 65_535, "a whole number from 0 to 65535 (0 picks a free port)") ??
    DEFAULT_API_PORT;
  whole("INDEXER_POLL_MS", 1, MAX_TIMER_MS, milliseconds);
  const keeperIntervalMs = whole("KEEPER_INTERVAL_MS", 1, MAX_TIMER_MS, milliseconds);
  const judgeIntervalMs = whole("JUDGE_INTERVAL_MS", 1, MAX_TIMER_MS, milliseconds);
  const trustedProxyHops =
    whole("TRUSTED_PROXY_HOPS", 0, MAX_PROXY_HOPS, `a whole number from 0 to ${MAX_PROXY_HOPS}`) ??
    0;
  const startHeight = get("INDEXER_START_HEIGHT");
  if (
    startHeight !== undefined &&
    !(
      /^[1-9][0-9]*$/.test(startHeight) &&
      startHeight.length <= U64_MAX.toString().length &&
      BigInt(startHeight) <= U64_MAX
    )
  ) {
    problems.push(
      `INDEXER_START_HEIGHT must be a block height, a whole number from 1 to ${U64_MAX}`,
    );
  }

  const webOrigins = entriesOf(get("PUBLIC_WEB_URL"));
  const notOrigin = webOrigins.findIndex((entry) => !isHttpOrigin(entry));
  if (notOrigin !== -1) {
    problems.push(
      "PUBLIC_WEB_URL must be http or https origins separated by commas, such as " +
        `https://tender.example; entry ${notOrigin + 1} is not one`,
    );
  } else if (webOrigins.length === 0 && offSandbox) {
    warnings.push("PUBLIC_WEB_URL is empty, so no web app may call the API from a browser");
  }

  const publicApiValue = get("PUBLIC_API_URL");
  let publicApiUrl: string | undefined;
  if (publicApiValue === undefined) {
    if (offSandbox) {
      problems.push(
        "PUBLIC_API_URL must be set off the sandbox: the exact base URL clients call the API at, " +
          "which sign-in is bound to",
      );
    }
  } else if (!isApiBase(publicApiValue)) {
    problems.push(
      "PUBLIC_API_URL must be an http or https URL with no query, fragment or credentials",
    );
  } else {
    try {
      publicApiUrl = canonicalBase(publicApiValue);
    } catch {
      // What `canonicalBase` says is its own; this names the variable, and shows nothing of it.
      problems.push(
        "PUBLIC_API_URL must have one spelling as a base URL: no empty path segment (//), no " +
          "second /v1 and no dot at the end of the host",
      );
    }
    // Off the sandbox, the rule an `ApiClient` with a key applies; the sandbox may be reached at
    // any host, over a LAN. A base that `canonicalBase` refused is a problem already.
    if (publicApiUrl !== undefined && offSandbox && !isSecureBase(publicApiUrl)) {
      problems.push(
        "PUBLIC_API_URL must be https off the sandbox, or plain http only to localhost, " +
          "127.0.0.1 or [::1]: over plain http to another host, sign-in tokens and uploads go " +
          "in the clear, and no client with a key signs in",
      );
    }
  }

  const rpcUrl = get("NEAR_RPC_URL");
  if (rpcUrl === undefined) {
    if (network === "sandbox") {
      problems.push("NEAR_RPC_URL must be set on the sandbox: the RPC URL of the local node");
    }
  } else if (httpUrl(rpcUrl) === undefined) {
    problems.push("NEAR_RPC_URL must be an http or https URL");
  }
  const neardataUrl = get("NEARDATA_URL");
  if (neardataUrl !== undefined && httpUrl(neardataUrl) === undefined) {
    problems.push("NEARDATA_URL must be an http or https URL");
  }
  if (offSandbox && get("FASTNEAR_API_KEY") === undefined) {
    warnings.push(
      "FASTNEAR_API_KEY is not set, so the indexer calls neardata without a key, which rate " +
        "limits it (HTTP 429) and can leave the index behind the chain",
    );
  }

  const teamAccounts = entriesOf(get("TEAM_ACCOUNTS"));
  const notAccount = teamAccounts.findIndex((account) => !isAccountId(account));
  if (notAccount !== -1) {
    problems.push(
      `TEAM_ACCOUNTS must be NEAR account ids separated by commas; entry ${notAccount + 1} is not one`,
    );
  }

  const telegramBotUsername = get("TELEGRAM_BOT_USERNAME");
  if (telegramBotUsername !== undefined && !TELEGRAM_USERNAME.test(telegramBotUsername)) {
    problems.push(
      "TELEGRAM_BOT_USERNAME must be the bot's username as in t.me/<username>: 5 to 32 letters, " +
        "digits and underscores",
    );
  }

  let keeper: KeeperConfig | undefined;
  const keeperKey = get("KEEPER_PRIVATE_KEY");
  if (keeperKey !== undefined) {
    const keeperAccount = get("KEEPER_ACCOUNT");
    if (keeperAccount === undefined) {
      problems.push(
        "KEEPER_ACCOUNT must be set when KEEPER_PRIVATE_KEY is: the account it signs as",
      );
    } else if (!isAccountId(keeperAccount)) {
      // A private key that went into the wrong variable is no account id, and is not shown.
      problems.push("KEEPER_ACCOUNT must be a NEAR account id (its value is not shown)");
    }
    try {
      parseKey(keeperKey, "KEEPER_PRIVATE_KEY");
    } catch (error) {
      problems.push((error as Error).message);
    }
    keeper = {
      accountId: keeperAccount ?? "",
      privateKey: keeperKey,
      intervalMs: keeperIntervalMs,
    };
  }

  const judgeAccount = get("JUDGE_ACCOUNT");
  if (judgeAccount !== undefined && !isAccountId(judgeAccount)) {
    problems.push("JUDGE_ACCOUNT must be a NEAR account id (its value is not shown)");
  }
  let judge: JudgeConfig | undefined;
  const judgeKey = get("JUDGE_PRIVATE_KEY");
  if (judgeKey !== undefined) {
    if (judgeAccount === undefined) {
      problems.push("JUDGE_ACCOUNT must be set when JUDGE_PRIVATE_KEY is: the account it signs as");
    }
    try {
      parseKey(judgeKey, "JUDGE_PRIVATE_KEY");
    } catch (error) {
      problems.push((error as Error).message);
    }
    const baseUrl = get("LLM_BASE_URL");
    const apiKey = get("LLM_API_KEY");
    const model = get("LLM_MODEL");
    const llm =
      baseUrl !== undefined && apiKey !== undefined && model !== undefined
        ? { baseUrl, apiKey, model }
        : undefined;
    if (llm === undefined && (baseUrl ?? apiKey ?? model) !== undefined) {
      warnings.push(
        "LLM_BASE_URL, LLM_API_KEY and LLM_MODEL are used only all three together, and some are " +
          "not set, so the Judge runs without a model",
      );
    }
    judge = {
      accountId: judgeAccount ?? "",
      privateKey: judgeKey,
      intervalMs: judgeIntervalMs,
      llm,
    };
  }

  const telegramMode = get("TELEGRAM_MODE");
  if (telegramMode !== undefined && telegramMode !== "polling" && telegramMode !== "webhook") {
    problems.push("TELEGRAM_MODE must be polling or webhook");
  }
  const webhookSecret = get("TELEGRAM_WEBHOOK_SECRET");
  if (
    webhookSecret !== undefined &&
    (webhookSecret.length < MIN_WEBHOOK_SECRET_LENGTH || !WEBHOOK_SECRET.test(webhookSecret))
  ) {
    problems.push(
      `TELEGRAM_WEBHOOK_SECRET must be ${MIN_WEBHOOK_SECRET_LENGTH} to 256 letters, digits, ` +
        "underscores and hyphens: the characters Telegram takes in a secret token, and enough " +
        "of them not to be guessed (its value is not shown)",
    );
  }
  let telegram: TelegramConfig | undefined;
  const botToken = get("TELEGRAM_BOT_TOKEN");
  if (botToken !== undefined) {
    if (!TELEGRAM_TOKEN.test(botToken)) {
      problems.push(
        "TELEGRAM_BOT_TOKEN must be the bot's token from @BotFather, its id and a colon and the " +
          "rest, as in 123456789:AAE... (its value is not shown)",
      );
    }
    const first = webOrigins[0];
    if (first === undefined) {
      problems.push(
        "PUBLIC_WEB_URL must be set when TELEGRAM_BOT_TOKEN is: the bot's messages link to the " +
          "web app, at its first origin",
      );
    }
    if (telegramBotUsername === undefined) {
      warnings.push(
        "TELEGRAM_BOT_USERNAME is not set, so no chat can be linked to an account " +
          "(POST /v1/telegram/link answers 503)",
      );
    }
    // An entry that is no origin is a problem above, and the config is not returned.
    const webUrl = first !== undefined && notOrigin === -1 ? new URL(first).origin : "";
    if (telegramMode !== "webhook") {
      telegram = { token: botToken, webUrl, mode: "polling" };
    } else if (webhookSecret === undefined) {
      problems.push(
        "TELEGRAM_WEBHOOK_SECRET must be set when TELEGRAM_MODE is webhook: Telegram sends it " +
          "with every update, and the bot takes no update without it",
      );
    } else {
      telegram = { token: botToken, webUrl, mode: "webhook", webhookSecret };
    }
  }

  if (
    problems.length > 0 ||
    network === undefined ||
    contractId === undefined ||
    databaseUrl === undefined ||
    kind === undefined
  ) {
    throw new ServeConfigError(problems);
  }
  return {
    network,
    contractId,
    database: { url: databaseUrl, kind },
    apiPort,
    publicApiUrl,
    rpcUrl,
    webOrigins,
    teamAccounts,
    telegramBotUsername,
    trustedProxyHops,
    keeper,
    judgeAccount,
    judge,
    telegram,
    warnings,
  };
}

/**
 * The environment `pnpm serve` runs with: what `loadEnv` reads for the network (`.env` and
 * `.env.deploy.<network>`, the network's file winning), under the process's own variables. A
 * variable the process sets wins over the files, so that a host's settings override them (a
 * container has no env files at all); one it sets to an empty value counts as unset. The network
 * is the process's `TENDER_NETWORK`, or else `.env`'s. When neither names one, only `.env` is
 * read, and `readServeConfig` says what is wrong. The files are in `dir`: the repository root, or
 * the directory the process's `TENDER_ENV_DIR` names, where the indexer finds `deployments/` too.
 */
export function serveEnv(
  processEnv: Record<string, string | undefined> = process.env,
  dir: string = envDir(processEnv),
): Record<string, string> {
  const own: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined && value.trim() !== "") own[key] = value;
  }
  const dotEnv = readEnvFile(join(dir, ".env"));
  const network = (own.TENDER_NETWORK ?? dotEnv.TENDER_NETWORK ?? "").trim();
  const files = Object.hasOwn(NETWORKS, network) ? loadEnv(network as NetworkId, { dir }) : dotEnv;
  return { ...files, ...own };
}

/**
 * The base URL clients call the API at, which sign-in is bound to (P03-R28): `PUBLIC_API_URL`,
 * or on the sandbox, where it may be unset, `http://127.0.0.1:<port>` on the port the server is
 * bound to. Never `0.0.0.0` or `[::]`, which no client can call. Either way it is spelled as
 * `canonicalBase` spells it (P03-R28c), so that the recipient of a sign-in, the blob URIs the API
 * hands out and the ones the Judge reads from the database all begin with the one string.
 */
export function publicUrlOf(config: Pick<ServeConfig, "publicApiUrl">, port: number): string {
  return config.publicApiUrl ?? canonicalBase(`http://127.0.0.1:${port}`);
}

// ---- Helpers ----------------------------------------------------------------------------------

/**
 * What a log line or a startup error says of an error that is not ours: its name, and its code
 * when it has one, never its message, which can quote an RPC URL with a key in it (P03-R16).
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? `${error.name} ${code}` : error.name;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Waits `ms`, or until `signal` aborts. */
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // aborted
  }
}

/** Resolves once `signal` aborts. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * What a line says of why the indexer lock was not taken, or was lost. A `LockNotHeldError` is
 * ours and is said in full, with the variable to look at; anything else as `describe` says it.
 */
function lockTrouble(error: unknown): string {
  return error instanceof LockNotHeldError ? `${error.message} (DATABASE_URL)` : describe(error);
}

// ---- The indexer lock -------------------------------------------------------------------------

/** Something that runs until it is stopped, such as the indexer. */
export interface Stoppable {
  stop(): Promise<void>;
}

export interface WhileLockedOptions {
  /** Tries once to take the lock: the lock, or null while another process holds it. */
  tryLock: () => Promise<SessionLock | null>;
  /** Starts what the lock guards. */
  start: () => Stoppable;
  /** What `start` starts, as the lines name it: "the indexer" unless given. */
  guards?: string;
  log: (line: string) => void;
  /** How long to wait before each new try, in milliseconds. Default 5 s. */
  retryMs?: number;
}

/**
 * Runs `start` only while this process holds the lock, so that one process at a time writes to
 * the index (P03-R25), and keeps it. The first try is made before this resolves, and if it takes
 * the lock, `start` runs before this resolves too: what either throws is thrown here, a failure to
 * start.
 *
 * While another process holds the lock, this one says so once, and tries again every `retryMs`. A
 * try that fails, such as one the database does not answer, is logged and made again. Once the
 * lock is taken, `start` runs; if it throws then, that is logged and nothing more is tried. When
 * the lock is lost, what runs is stopped and the lock let go, the reason is logged, and the
 * waiting begins again.
 *
 * `stop` stops what runs and then lets the lock go, or ends the waiting.
 */
export async function runWhileLocked(opts: WhileLockedOptions): Promise<Stoppable> {
  const { log } = opts;
  const retryMs = opts.retryMs ?? LOCK_RETRY_MS;
  const guards = opts.guards ?? "the indexer";
  const stopping = new AbortController();
  // Whether this wait has said that another process holds the lock: once is enough.
  let said = false;
  const heldElsewhere = () => {
    if (said) return;
    said = true;
    log(
      "indexer: another services process holds the indexer lock; serving the API, " +
        `and starting ${guards} once the lock is free`,
    );
  };

  let lock = await opts.tryLock();
  let running: Stoppable | undefined;
  if (lock === null) {
    heldElsewhere();
  } else {
    try {
      running = opts.start();
    } catch (error) {
      await lock.release();
      throw error;
    }
    log("indexer: this process holds the indexer lock");
  }

  /** The lock, once a try takes it, or null if the waiting is stopped first. */
  const nextLock = async (): Promise<SessionLock | null> => {
    while (!stopping.signal.aborted) {
      await pause(retryMs, stopping.signal);
      if (stopping.signal.aborted) break;
      try {
        const taken = await opts.tryLock();
        if (taken === null) {
          heldElsewhere();
          continue;
        }
        if (!stopping.signal.aborted) return taken;
        await taken.release();
      } catch (error) {
        log(
          `WARN indexer: cannot take the indexer lock (${lockTrouble(error)}); ` +
            `trying again in ${retryMs / 1000} s`,
        );
      }
    }
    return null;
  };

  const supervise = async (): Promise<void> => {
    for (;;) {
      if (lock === null) {
        lock = await nextLock();
        if (lock === null) return;
        said = false;
        try {
          running = opts.start();
        } catch (error) {
          log(`ERROR indexer: cannot start ${guards} (${messageOf(error)}); not trying again`);
          await lock.release();
          return;
        }
        log(`indexer: took the indexer lock; started ${guards}`);
      }
      const held: SessionLock = lock;
      const lost = await Promise.race([
        aborted(stopping.signal).then(() => false),
        aborted(held.lost).then(() => true),
      ]);
      await running?.stop();
      running = undefined;
      await held.release();
      lock = null;
      if (!lost) return;
      const why =
        held.lost.reason instanceof LockNotHeldError
          ? `: ${lockTrouble(held.lost.reason)}`
          : `, as its connection to the database failed (${describe(held.lost.reason)})`;
      log(`WARN indexer: lost the indexer lock${why}; stopped ${guards} until it is taken again`);
    }
  };

  const supervising = supervise().catch((error: unknown) => {
    log(`ERROR indexer: the indexer lock failed (${describe(error)})`);
  });
  return {
    async stop() {
      stopping.abort();
      await supervising;
    },
  };
}

// ---- The keys of the keeper and the Judge -----------------------------------------------------

/** A key a service signs with, and what the key check says of it. */
interface ServiceKey {
  accountId: string;
  privateKey: string;
  /** The service, as a sentence names it: "the keeper". */
  service: string;
  /** The variables of the key and of its account. */
  keyVar: string;
  accountVar: string;
  /** How the key script is run to make the key. */
  script: string;
  /** The methods the key must let its holder call, and no others, as the key script adds it. */
  methods: readonly string[];
}

/** `names` as a sentence lists them: "a, b and c". */
function listed(names: readonly string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Whether `names` is a list of `methods` and no others, in any order. */
function namesExactly(names: unknown, methods: readonly string[]): boolean {
  if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) return false;
  const have = new Set(names);
  return have.size === methods.length && methods.every((method) => have.has(method));
}

/**
 * Off the sandbox, the key a service signs with must be a function-call key limited to the Tender
 * contract and to exactly `key.methods`: a full-access key can do anything with its account, a
 * key limited to another receiver cannot call Tender, and one that lists no methods may call any
 * of Tender's. The chain is asked (`viewAccessKey`), with 15 seconds to answer, and anything else
 * is a failure to start, whose message names the key's variable and the key script, and shows no
 * key.
 */
async function checkServiceKey(
  client: Pick<TenderClient, "viewAccessKey">,
  key: ServiceKey,
  contractId: string,
): Promise<void> {
  const { service, keyVar, script, methods } = key;
  const publicKey = parseKey(key.privateKey, keyVar).getPublicKey().toString();
  const of = `of ${key.accountId} (${key.accountVar})`;
  const limited = `limited to ${contractId} for ${listed(methods)}`;
  const make =
    `Remove the ${keyVar} line from the env file and run ${script}, which adds a function-call ` +
    `key ${limited} and writes it there.`;
  let found: Awaited<ReturnType<TenderClient["viewAccessKey"]>>;
  try {
    found = await withinDeadline(
      KEY_CHECK_DEADLINE_MS,
      client.viewAccessKey(key.accountId, publicKey),
    );
  } catch (error) {
    throw new Error(
      `cannot ask the chain what ${keyVar} may do (${describe(error)}), and ${service} does not ` +
        "start with a key that was not checked",
    );
  }
  if (found === null) {
    throw new Error(
      `${keyVar} is not a key ${of}. Run ${script}, which adds a function-call key ${limited} ` +
        `and writes it to ${keyVar}.`,
    );
  }
  if (found.permission === "FullAccess") {
    throw new Error(
      `${keyVar} is a full-access key ${of}, which can do anything with the account, and ` +
        `${service} will not hold one. ${make} Do not delete this key from the account: an ` +
        "account without a full-access key is locked for good.",
    );
  }
  if (
    keyKindOf(found.permission, contractId) !== "function_call" ||
    !namesExactly(found.permission.FunctionCall.method_names, methods)
  ) {
    throw new Error(`${keyVar} is a key ${of} that is not a function-call key ${limited}. ${make}`);
  }
}

/**
 * The keeper's key, which must be a function-call key limited to Tender for the keeper's methods,
 * `void_task` and `cleanup`, as `scripts/keeper-key.ts` adds it (`checkServiceKey`).
 */
export function checkKeeperKey(
  client: Pick<TenderClient, "viewAccessKey">,
  keeper: Pick<KeeperConfig, "accountId" | "privateKey">,
  contractId: string,
): Promise<void> {
  return checkServiceKey(
    client,
    {
      accountId: keeper.accountId,
      privateKey: keeper.privateKey,
      service: "the keeper",
      keyVar: "KEEPER_PRIVATE_KEY",
      accountVar: "KEEPER_ACCOUNT",
      script: "scripts/keeper-key.ts",
      methods: roleMethods("keeper"),
    },
    contractId,
  );
}

/**
 * The Judge's key, which must be a function-call key limited to Tender for the judge's methods,
 * `pick` and `pick_attested`, as `scripts/keeper-key.ts --role judge` adds it (`checkServiceKey`).
 */
export function checkJudgeKey(
  client: Pick<TenderClient, "viewAccessKey">,
  judge: Pick<JudgeConfig, "accountId" | "privateKey">,
  contractId: string,
): Promise<void> {
  return checkServiceKey(
    client,
    {
      accountId: judge.accountId,
      privateKey: judge.privateKey,
      service: "the Judge",
      keyVar: "JUDGE_PRIVATE_KEY",
      accountVar: "JUDGE_ACCOUNT",
      script: "scripts/keeper-key.ts --role judge",
      methods: roleMethods("judge"),
    },
    contractId,
  );
}

// ---- The services -----------------------------------------------------------------------------

export interface ServeOptions {
  /** Receives every line the services write. Default: `console.log`. */
  log?: (line: string) => void;
  /** Where the deploy's records, `<network>.json`, are. Default: the repository's `deployments/`. */
  deploymentsDir?: string;
  /** How long `stop` lets the requests in flight finish before it cuts them. Default: 2 s. */
  closeGraceMs?: number;
  /**
   * For tests: how the indexer lock is tried, whatever the database. Default: the session lock of
   * a Postgres database (`tryAdvisoryLock`), and no lock for PGlite, whose directory `openDb`
   * locks against a second process (a `PgliteInUseError` at the start).
   */
  tryLock?: () => Promise<SessionLock | null>;
  /**
   * For tests: how the database is checked against the chain before the indexer, the keeper and
   * the Judge start (`checkAgainstChain`): the chain it asks, in place of the services' own
   * client, and its waits.
   */
  deployment?: { chain?: DeploymentChain } & Pick<
    CheckAgainstChainOptions,
    "retryMs" | "longestMs" | "skewBlocks" | "lagLimitBlocks" | "behindWarnMs"
  >;
  /** For tests: the times of the lock on a PGlite directory (`openDb`). */
  pgliteLock?: Pick<PgliteLockOptions, "beatMs" | "staleMs">;
  /**
   * For tests: the Bot API server the Telegram bot calls in place of Telegram's own, with no
   * trailing slash (grammY's `client.apiRoot`).
   */
  telegramApiRoot?: string;
}

export interface Services {
  /** The URL the API is bound to, such as `http://127.0.0.1:8787`. */
  url: string;
  /** The base URL clients call the API at, which sign-in is bound to (see `publicUrlOf`). */
  publicUrl: string;
  /**
   * Resolves, once, with the error that ends the services after `startServices` has returned them,
   * as it would have thrown it had it come sooner: the database was refused by the check against
   * the chain, the indexer, the keeper or the Judge threw as they started, or the PGlite directory
   * lost its lock. Nothing stops by itself: the owner stops the services, and `pnpm serve` does
   * that and ends with 1 (`exitOnFailure`). It never rejects.
   */
  failed: Promise<Error>;
  /**
   * Stops everything and resolves once all of it is down. A check of the database against the
   * chain that is still waiting ends first, so that from then on it starts nothing and refuses
   * nothing. Then, in this order: the API stops taking connections and cuts the ones left after
   * the grace; the Telegram bot stops taking updates and finishes the ones it has, and the notifier
   * its tick, or after 5 s (`TELEGRAM_STOP_MS`) the rest goes on without them, and a WARN says what
   * was left; the Judge, the keeper and the indexer stop (see `withLoops`), and the indexer lock is
   * let go; and the database is closed. Calling it again returns the same promise.
   */
  stop(): Promise<void>;
}

async function openIndex(url: string, pgliteLock: PgliteLockOptions): Promise<Db> {
  const db = await openDb(url, { pgliteLock });
  try {
    await migrate(db);
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  return db;
}

/** The time by the wall clock, in nanoseconds since the Unix epoch, as the contract counts it. */
const wallClockNs = () => BigInt(Date.now()) * NS_PER_MS;

/**
 * The indexer and the loops that run beside it under the indexer lock, the Judge's and the
 * keeper's, as one `Stoppable`. A loop is the promise `startJudge` or `startKeeper` returns, which
 * resolves once the loop has stopped, after the task or the call it has in hand, and never
 * rejects.
 *
 * `stop` aborts `stopLoops` and starts the indexer's stop at once, and then waits for each loop, in
 * the order given, and for the indexer last. When the lock is lost, another process may be
 * indexing already, and this indexer must not go on writing for as long as a call that a loop has
 * in flight takes: a pick or a void waits for its block, and the RPC client retries.
 */
export function withLoops(
  indexer: Stoppable,
  stopLoops: AbortController,
  loops: readonly Promise<void>[],
): Stoppable {
  return {
    async stop() {
      stopLoops.abort();
      // Caught at once, since it may fail while the loops are awaited, and thrown after them.
      const indexing = indexer.stop().then(
        () => undefined,
        (error: unknown) => ({ error }),
      );
      for (const loop of loops) await loop;
      const failed = await indexing;
      if (failed !== undefined) throw failed.error;
    },
  };
}

/** What `startAfterCheck` returns: the work it starts, and when the check has said its first word. */
export interface CheckedStart extends Stoppable {
  /**
   * Resolves once the work has started, or has been refused (`onRefused` has been told), or the
   * check waits on the node for the first time, or `stop` has ended it. Never rejects.
   */
  settled: Promise<void>;
  /**
   * Whether the check is waiting right now: from its first wait, told or not (a node that is
   * behind is told once in `behindWarnMs`), until it has gone through, been refused or been ended.
   * The API says so in `GET /v1/health` (`waiting_for_chain`).
   */
  waiting(): boolean;
}

export interface CheckedStartOptions {
  /**
   * Checks the database against the chain (`checkAgainstChain`): true to go on, false if `signal`
   * aborted first, and what it throws is a refusal. It tells `onWait` of each wait.
   */
  check: (signal: AbortSignal, onWait: (why: string, retryMs: number) => void) => Promise<boolean>;
  /** Starts the work, once the database matches the chain. */
  start: () => Stoppable;
  /** What `start` starts, as the lines name it: "the indexer, the keeper and the Judge". */
  guards: string;
  log: (line: string) => void;
  /**
   * Told, once, why the work will not run: the database was refused, or `start` threw. Nothing is
   * tried again. The error is ours to show: an `IndexerError` as it is, any other failure of the
   * check by its name, and the message of a `start` that threw. Not told once `stop` has been called.
   */
  onRefused: (error: Error) => void;
  /**
   * Aborts when the owner begins to stop everything, which takes a while before it calls `stop`:
   * the API and the bot stop first. From then on the check ends, the work does not start, and a
   * refusal is not told, as for `stop`: a stop is no failure, and nothing should start only to be
   * stopped, a keeper least of all, whose first tick sends calls.
   */
  stopping?: AbortSignal;
}

/**
 * Starts the work, `start`, once `check` has found the database to match the chain, and returns at
 * once: the check can wait for a node that does not answer or is behind, for as long as that takes,
 * and the API serves meanwhile. Each wait is logged as a WARN with its reason. A refusal, or a work
 * that throws as it starts, is told to `onRefused`, and the work does not start: the owner ends the
 * services (`Services.failed`).
 *
 * `stop` ends the wait, and stops the work if it has started. `opts.stopping` ends the wait and
 * keeps the work from starting, and leaves a work that has started to `stop`.
 */
export function startAfterCheck(opts: CheckedStartOptions): CheckedStart {
  const { check, start, guards, log, onRefused } = opts;
  const stopped = new AbortController();
  // Ended by `stop`, or by the owner's word that it has begun to stop.
  const ended =
    opts.stopping === undefined ? stopped.signal : AbortSignal.any([stopped.signal, opts.stopping]);
  let running: Stoppable | undefined;
  let waited = false;
  let waitingNow = false;
  let firstWait: () => void = () => undefined;
  const waitedFirst = new Promise<void>((resolve) => {
    firstWait = resolve;
  });
  const onWait = (why: string, retryMs: number) => {
    waited = true;
    waitingNow = true;
    log(
      `WARN indexer: cannot check the database against the chain yet (${why}); ` +
        `trying again in ${retryMs / 1000} s`,
    );
    firstWait();
  };
  const refuse = (error: Error) => {
    if (!ended.aborted) onRefused(error);
  };
  const checking = (async () => {
    try {
      try {
        if (!(await check(ended, onWait)) || ended.aborted) return;
      } finally {
        // However the check ended, it waits no more: the work starts, or it is refused, or stopped.
        waitingNow = false;
      }
    } catch (error) {
      // A refusal is ours and is said in full; anything else by its name, as a line says of an error.
      refuse(
        error instanceof IndexerError
          ? error
          : new Error(`cannot start ${guards} (${describe(error)})`, { cause: error }),
      );
      return;
    }
    if (waited) log(`indexer: the database matches the chain; starting ${guards}`);
    try {
      running = start();
    } catch (error) {
      refuse(new Error(`cannot start ${guards} (${messageOf(error)})`, { cause: error }));
    }
  })();
  return {
    settled: Promise.race([checking, waitedFirst]),
    waiting: () => waitingNow,
    async stop() {
      stopped.abort();
      await checking;
      await running?.stop();
    },
  };
}

/** The bot `createBot` makes. Its type is grammY's, which stays in `@tender/telegram` (X-14). */
type TelegramBot = ReturnType<typeof createBot>;

/**
 * What a line says of an error from Telegram: its name and code as `describe` gives them, and the
 * Bot API's error code when it has one, such as `GrammyError 401`. Never its text: an error of the
 * transport can quote the request's URL, which holds the bot's token.
 */
function telegramTrouble(error: unknown): string {
  const code = (error as { error_code?: unknown } | null | undefined)?.error_code;
  const said = typeof code === "number" ? `${describe(error)} ${code}` : describe(error);
  if (code === 401) return `${said}: Telegram does not take TELEGRAM_BOT_TOKEN`;
  if (code === 409) {
    return (
      `${said}: another process takes this bot's updates; run one services process per bot, ` +
      "or set TELEGRAM_MODE=webhook"
    );
  }
  return said;
}

/** The Telegram side of the services, as `runTelegram` runs it. */
interface TelegramRun extends Stoppable {
  /** What `stop` waits for still, as a line names it: nothing before `stop`, or once it is done. */
  pending(): string[];
  /**
   * Whether the bot's start has failed for good, as the ERROR line says: its details were refused,
   * such as for a token that Telegram does not take, and nothing tries again.
   */
  startFailed(): boolean;
}

/**
 * Runs the Telegram side of the services with `bot`: the notifier, the bot's menu of commands
 * (`setMyCommands`, once, for private chats only, so that groups do not get the menu), the bot's
 * own details (`getMe`) and, in polling mode, the long polling.
 * What talks to Telegram runs in the background, so that a Telegram that does not answer holds
 * nothing else up, and what fails is logged by name and code only: a failure of the menu is a
 * WARN, one of the bot an ERROR. In webhook mode the updates come to the handler that
 * `startServices` mounts, and `webhooks` holds the ones it is handling.
 *
 * `stop` ends it all, and resolves once nothing of it runs: the long polling and the updates it is
 * handling, the updates the webhook is handling, the notifier's tick, and the calls to Telegram
 * made here. In polling mode `bot.stop` also tells Telegram which updates were handled, so that it
 * does not send them again at the next start; a failure of that is a WARN. A call that Telegram
 * does not answer is retried until it goes through, which can hold `stop` for good: `pending` says
 * what it still waits for.
 */
function runTelegram(
  bot: TelegramBot,
  telegram: TelegramConfig,
  opts: {
    db: Db;
    network: NetworkId;
    log: (line: string) => void;
    webhooks: ReadonlySet<Promise<unknown>>;
  },
): TelegramRun {
  const { log } = opts;
  const stopping = new AbortController();
  const { signal } = stopping;
  // grammY's types for Node name the signal of the `abort-controller` package it bundles. It
  // takes the runtime's own, which has the `aborted` and the `addEventListener` it uses.
  const grammySignal = signal as unknown as NonNullable<Parameters<TelegramBot["init"]>[0]>;
  // A call that fails once the services are stopping fails because they are: that is not said.
  const unlessStopping = (line: string) => {
    if (!signal.aborted) log(line);
  };

  // First, as the one step that can throw: it refuses a web URL that it cannot link to.
  const notifying = startNotifier({
    db: opts.db,
    bot,
    webUrl: telegram.webUrl,
    network: opts.network,
    signal,
  });
  const commands = bot.api
    .setMyCommands([...BOT_COMMANDS], { scope: { type: "all_private_chats" } }, grammySignal)
    .then(
      () => undefined,
      (error: unknown) =>
        unlessStopping(
          `WARN telegram: cannot set the bot's menu of commands (${telegramTrouble(error)}); the ` +
            "commands work without it",
        ),
    );
  let startFailed = false;
  const running = (async () => {
    // `bot.start` would fetch the details itself, but with no signal to end its retries.
    try {
      await bot.init(grammySignal);
    } catch (error) {
      // A failure that comes with the stop is the stop, not the bot's.
      startFailed = !signal.aborted;
      unlessStopping(`ERROR telegram: the bot cannot start (${telegramTrouble(error)})`);
      return;
    }
    if (telegram.mode === "webhook" || signal.aborted) return;
    try {
      await bot.start({ allowed_updates: ["message"], drop_pending_updates: false });
    } catch (error) {
      unlessStopping(`ERROR telegram: the bot stopped taking updates (${telegramTrouble(error)})`);
    }
  })();
  const takes =
    telegram.mode === "polling" ? "by long polling" : `at POST ${TELEGRAM_WEBHOOK_PATH}`;
  log(`serve: Telegram bot on, taking updates ${takes}, and the notifier`);

  /** What `stop` waits for, and whether each is done. */
  const waits: Array<{ what: string; done: boolean }> = [];
  const waitFor = (what: string, promise: Promise<unknown>) => {
    const wait = { what, done: false };
    waits.push(wait);
    const done = () => {
      wait.done = true;
    };
    return promise.then(done, done);
  };
  return {
    async stop() {
      stopping.abort();
      // In polling mode, this ends the long polling and tells Telegram which updates were handled.
      const confirming = bot.stop().catch((error: unknown) => {
        log(
          `WARN telegram: cannot tell Telegram which updates were handled ` +
            `(${telegramTrouble(error)}); it may send them again at the next start`,
        );
      });
      await Promise.all([
        waitFor("the call that tells Telegram which updates were handled", confirming),
        waitFor("the bot's start and its long polling, with the updates in hand", running),
        waitFor("the updates posted to the webhook", Promise.allSettled(opts.webhooks)),
        waitFor("the notifier's tick", notifying),
        waitFor("the call that sets the bot's menu", commands),
      ]);
    },
    pending: () => waits.filter((wait) => !wait.done).map((wait) => wait.what),
    startFailed: () => startFailed,
  };
}

/**
 * Starts the services of `env` (see the top of this file), and resolves once they run: the API
 * listens, the indexer, with the keeper and the Judge if they are to run, runs or waits for the
 * indexer lock, and the Telegram bot and the notifier run if they are to. The environment is
 * checked first (`readServeConfig`, and what the indexer needs, `checkIndexerEnv`), and off the
 * sandbox the keys of the keeper and the Judge too, before anything starts. What fails to start is
 * thrown, after what had started is stopped.
 *
 * Under the lock, the indexer and the loops beside it start once the database has been checked
 * against the chain (`startAfterCheck`), which waits for a node that cannot be asked, or is behind.
 * This resolves when that check has gone through, or has waited for the first time (a WARN line):
 * the API serves in each case. A refusal that comes by then is thrown, like any refusal to start;
 * one that comes later, like the loss of the PGlite lock, ends `Services.failed`.
 */
export async function startServices(
  env: Record<string, string | undefined>,
  options: ServeOptions = {},
): Promise<Services> {
  const log = options.log ?? console.log;
  const config = readServeConfig(env);
  for (const warning of config.warnings) log(`WARN serve: ${warning}`);
  // The indexer starts only after the database has been checked against the chain, which can
  // wait: what it needs of the environment is checked now, so that a start that cannot work fails.
  checkIndexerEnv(env, { deploymentsDir: options.deploymentsDir });
  const { network, contractId, rpcUrl } = config;
  // One client reads the chain for the API and the indexer.
  const client = new TenderClient({ network, contractId, rpcUrl });

  if (network !== "sandbox") {
    if (config.keeper !== undefined) await checkKeeperKey(client, config.keeper, contractId);
    if (config.judge !== undefined) await checkJudgeKey(client, config.judge, contractId);
  }
  /** A client that signs as the account of `key`, with it. */
  const signingAs = (key: { accountId: string; privateKey: string }) =>
    new TenderClient({
      network,
      contractId,
      rpcUrl,
      signer: { accountId: key.accountId, privateKey: key.privateKey },
    });
  const keeper =
    config.keeper === undefined
      ? undefined
      : { config: config.keeper, client: signingAs(config.keeper) };
  const judge =
    config.judge === undefined
      ? undefined
      : { config: config.judge, client: signingAs(config.judge) };

  // What ends the services after they are up (`Services.failed`). Before that it is thrown.
  const ending: { error?: Error; up: boolean } = { up: false };
  let report: (error: Error) => void = () => undefined;
  const failed = new Promise<Error>((resolve) => {
    report = resolve;
  });
  const fail = (error: Error) => {
    if (ending.error !== undefined) return;
    ending.error = error;
    if (ending.up) report(error);
  };
  const failure = () => ending.error;
  /** Aborts as `stopAll` begins, ahead of the slow steps in it: see `CheckedStartOptions.stopping`. */
  const stopBegun = new AbortController();

  const db = await openIndex(config.database.url, { ...options.pgliteLock, onLost: fail });
  let api: ApiServer | undefined;
  /** The Telegram bot and the notifier. */
  let telegram: TelegramRun | undefined;
  /** The indexer, the keeper and the Judge, with the lock they run under, if any. */
  let work: Stoppable | undefined;
  /** The latest check of the database against the chain, which `GET /v1/health` reports on. */
  let latestCheck: CheckedStart | undefined;

  /** Stops what has started, in order, going on past a failure, and throws the first one. */
  const stopAll = async (): Promise<void> => {
    // First of all: a check of the database against the chain that is still waiting must not go on
    // to start the indexer, the keeper and the Judge while the API and the bot stop, which takes
    // seconds, nor refuse the database in that time, which would make this stop a failure.
    stopBegun.abort();
    const failures: unknown[] = [];
    const step = async (work: () => Promise<void> | undefined) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    await step(() => api?.close());
    await step(async () => {
      const run = telegram;
      if (run === undefined) return;
      try {
        await withinDeadline(TELEGRAM_STOP_MS, run.stop());
      } catch (error) {
        if (!(error instanceof NoAnswerInTime)) throw error;
        const left = run.pending();
        log(
          `WARN telegram: not stopped within ${TELEGRAM_STOP_MS / 1000} s, as Telegram does not ` +
            `answer; going on without ${left.length > 0 ? listed(left) : "it"}`,
        );
      }
    });
    // The Judge, the keeper and the indexer, then the lock.
    await step(() => work?.stop());
    await step(() => db.close());
    if (failures.length > 0) throw failures[0];
  };

  let publicUrl = "";
  try {
    // A database serves one contract deploy: one whose chain cursor is for another is refused
    // before anything serves from it. The half that needs the chain waits for the work to start.
    await checkCursorSource(db, { network, contractId });
    // The bot is made before the API, whose app takes its webhook. It calls Telegram only once
    // `runTelegram` runs it: the webhook takes no update before then (see below).
    const { telegram: telegramConfig } = config;
    const bot =
      telegramConfig === undefined
        ? undefined
        : createBot({
            token: telegramConfig.token,
            db,
            webUrl: telegramConfig.webUrl,
            now: wallClockNs,
            apiRoot: options.telegramApiRoot,
          });
    const webhook =
      bot !== undefined && telegramConfig?.mode === "webhook"
        ? webhookHandler(bot, telegramConfig.webhookSecret)
        : undefined;
    /** The updates the webhook is handling, which `stop` waits for. */
    const webhooks = new Set<Promise<unknown>>();

    api = await startApiServer(
      (url) => {
        publicUrl = publicUrlOf(config, Number(new URL(url).port));
        const app = createApp({
          db,
          client,
          network,
          contractId,
          publicUrl,
          teamAccounts: config.teamAccounts,
          judgeAccount: config.judgeAccount,
          webOrigins: config.webOrigins,
          telegramBotUsername: config.telegramBotUsername,
          trustedProxyHops: config.trustedProxyHops,
          // True while the indexer, the keeper and the Judge wait for a node that cannot be asked
          // or is behind the index: `lag_blocks` cannot show that, so health says it.
          waitingForChain: () => latestCheck?.waiting() === true,
        });
        if (bot !== undefined && webhook !== undefined) {
          app.post(TELEGRAM_WEBHOOK_PATH, async (c) => {
            // Until the bot has its own details, which `runTelegram` asks for with the stop signal,
            // grammY's handler would ask Telegram for them itself, with no signal, and before it
            // looks at the secret. So no update is taken till then: Telegram sends it again later.
            // Once `runTelegram` has logged its ERROR, the bot will not have them: it is not
            // starting, and the answer says so.
            if (!bot.isInited()) {
              const message =
                telegram?.startFailed() === true
                  ? "the bot is not available"
                  : "the bot is starting";
              const body: ErrorBody = { error: "unavailable", message };
              return Response.json(body, { status: 503 });
            }
            // Telegram says how long an update is, and an update is small: a body that does not say
            // its length, or is over 1 MiB, is not read.
            const length = c.req.header("content-length");
            if (
              length === undefined ||
              !/^[0-9]+$/.test(length) ||
              Number(length) > MAX_WEBHOOK_BODY_BYTES
            ) {
              const body: ErrorBody = {
                error: "payload_too_large",
                message: "the request body must say its length, and be 1 MiB at most",
              };
              return Response.json(body, { status: 413 });
            }
            const handling = webhook(c);
            webhooks.add(handling);
            const done = () => webhooks.delete(handling);
            handling.then(done, done);
            return handling;
          });
        }
        return app;
      },
      { port: config.apiPort, closeGraceMs: options.closeGraceMs },
    );
    log(`serve: API at ${api.url}, called at ${publicUrl} (${network}, ${contractId})`);

    // The indexer, the keeper and the Judge start and stop together, so that the keeper and the
    // Judge run only where the index is written: two keepers would send the same calls, and pay
    // for the ones that lose, and two Judges would pick twice. At the stop, as when the lock is
    // lost, each takes no further task or call once the one in hand is done (`withLoops`).
    const startLoops = (): Stoppable => {
      const indexer = startIndexer(env, {
        db,
        client,
        log,
        deploymentsDir: options.deploymentsDir,
      });
      if (keeper === undefined && judge === undefined) return indexer;
      const stopLoops = new AbortController();
      const loops: Promise<void>[] = [];
      try {
        if (judge !== undefined) {
          loops.push(
            startJudge({
              db,
              client: judge.client,
              judgeAccount: judge.config.accountId,
              teamAccounts: config.teamAccounts,
              publicUrl,
              // Whether an entrant may use the bytes we store as its result: the API's own rule,
              // at the Judge's clock, which it gives in nanoseconds (P03-R23).
              resultUploaded: (sha256, taskId, account, nowNs) =>
                resultUsable(db, sha256, taskId, account, nowNs),
              llm: judge.config.llm,
              intervalMs: judge.config.intervalMs,
              signal: stopLoops.signal,
            }),
          );
          log(`serve: Judge on, as ${judge.config.accountId}`);
        }
        if (keeper !== undefined) {
          loops.push(
            startKeeper({
              db,
              client: keeper.client,
              intervalMs: keeper.config.intervalMs,
              signal: stopLoops.signal,
              log,
            }),
          );
          log(`serve: keeper on, as ${keeper.config.accountId}`);
        }
      } catch (error) {
        stopLoops.abort();
        void indexer.stop();
        throw error;
      }
      return withLoops(indexer, stopLoops, loops);
    };
    if (keeper === undefined) log("serve: keeper off (KEEPER_PRIVATE_KEY is not set)");
    if (judge === undefined) log("serve: Judge off (JUDGE_PRIVATE_KEY is not set)");
    // The one line the lock writes, a server that refuses its session's idle timeout, is said once
    // and not at each try of a process that waits for the lock.
    let refusalSaid = false;
    const lockLog = (line: string) => {
      if (refusalSaid) return;
      refusalSaid = true;
      log(line);
    };
    // PGlite is one process's own database, so it needs no lock.
    const tryLock =
      options.tryLock ??
      (config.database.kind === "postgres"
        ? () => tryAdvisoryLock(config.database.url, INDEXER_LOCK_KEY, { log: lockLog })
        : undefined);
    const guards = listed([
      "the indexer",
      ...(keeper === undefined ? [] : ["the keeper"]),
      ...(judge === undefined ? [] : ["the Judge"]),
    ]);
    // What runs under the lock starts once the database has been checked against the chain: the
    // node is asked, and waited for if it does not answer or is behind, while the API serves.
    const first: { checked?: CheckedStart } = {};
    const startWork = (): Stoppable => {
      const { chain = client, ...timing } = options.deployment ?? {};
      const checked = startAfterCheck({
        check: (signal, onWait) => checkAgainstChain(db, chain, { ...timing, signal, onWait }),
        start: startLoops,
        guards,
        log,
        onRefused: fail,
        stopping: stopBegun.signal,
      });
      first.checked ??= checked;
      latestCheck = checked;
      return checked;
    };
    work =
      tryLock === undefined
        ? startWork()
        : await runWhileLocked({ tryLock, start: startWork, guards, log });
    // The first check has said its first word by now: the work runs, the node is waited for, or
    // the database is refused, which is a refusal to start. A process that waits for the lock has none.
    await first.checked?.settled;
    const refused = failure();
    if (refused !== undefined) throw refused;

    if (bot === undefined || telegramConfig === undefined) {
      log("serve: Telegram off (TELEGRAM_BOT_TOKEN is not set)");
    } else {
      telegram = runTelegram(bot, telegramConfig, { db, network, log, webhooks });
    }
    // Anything that ended the services while they started is a failure to start, and nothing
    // awaits between this and the services being up.
    const early = failure();
    if (early !== undefined) throw early;
    ending.up = true;
  } catch (error) {
    await stopAll().catch(() => undefined);
    throw error;
  }

  let stopped: Promise<void> | undefined;
  return {
    url: api.url,
    publicUrl,
    failed,
    stop() {
      stopped ??= stopAll().then(() => log("serve: stopped"));
      return stopped;
    },
  };
}

// ---- The command line -------------------------------------------------------------------------

/** Variables whose values are secrets, or can hold one: a URL with a key or a password in it. */
const SECRET =
  /(?:KEY|SECRET|TOKEN|JWT|PASSWORD)$|^(?:TEST_)?DATABASE_URL$|^NEAR(?:DATA|_RPC(?:_FALLBACK)?)_URL$/;

/**
 * `text` with the value of each secret variable of `env` in it replaced by the variable's name,
 * and the password of each such URL too, as it is written and decoded; a value or a spelling of a
 * password shorter than 8 characters is left as it is. What the command line prints passes
 * through it: the errors of the services name no secret, and this is so that no other error does
 * either.
 */
export function redact(text: string, env: Record<string, string | undefined>): string {
  let out = text;
  for (const [key, raw] of Object.entries(env)) {
    const value = raw?.trim();
    if (value === undefined || value.length < MIN_REDACTED_LENGTH || !SECRET.test(key)) continue;
    out = out.replaceAll(value, `<${key}>`);
    const password = URL.parse(value)?.password;
    if (password === undefined) continue;
    for (const spelling of [password, decoded(password)]) {
      if (spelling.length >= MIN_REDACTED_LENGTH) {
        out = out.replaceAll(spelling, `<password of ${key}>`);
      }
    }
  }
  return out;
}

/** `text` with its percent escapes decoded, or as it is if one of them is not an escape. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The methods of `console` that print, which `redactConsole` wraps. */
type Printer = Pick<Console, "log" | "info" | "warn" | "error" | "debug" | "dir" | "dirxml">;

/**
 * Makes what `target` prints pass through `redact`: the services' own lines, and what the packages
 * print, whole errors among them. The text redacted is the text printed, `util.format` of all the
 * arguments, so that a secret deep inside an error is caught too: a grammY `HttpError` holds the
 * transport's error, whose message can quote the URL of the request, which holds the bot's token.
 *
 * `log`, `info`, `warn` and `error` are wrapped, and so are `debug`, `dirxml` and `dir`, which
 * Node's console writes to the stream by itself, not through `log`. `trace`, `assert`, `table`,
 * `group` and `count` print through those four, and so are covered. What bypasses the console
 * altogether is not: the `debug` package (set by `DEBUG`) writes to stderr itself.
 */
export function redactConsole(
  env: Record<string, string | undefined>,
  target: Printer = console,
): void {
  for (const method of ["log", "info", "warn", "error", "debug", "dirxml"] as const) {
    const print = target[method].bind(target);
    target[method] = (...args: unknown[]) => print(redact(format(...args), env));
  }
  // `dir` shows one value as `inspect` does, with the same options. Its text goes out through the
  // `log` that is wrapped by now, which prints a lone string as it is.
  target.dir = (value: unknown, options?: InspectOptions) =>
    target.log(inspect(value, { customInspect: false, ...options }));
}

/** What `exitOnCrash` hangs its handlers on: the process, or a stand-in in a test. */
interface CrashTarget {
  on(
    event: "uncaughtException" | "unhandledRejection",
    listener: (error: unknown) => void,
  ): unknown;
  exit(code: number): unknown;
}

/** How long a crash waits for a stderr that is full, in milliseconds. */
const STDERR_WAIT_MS = 2_000;

/**
 * Writes `text` to stderr (file descriptor 2) before it returns, whatever is queued behind it. A
 * stream's write is asynchronous, and `process.exit` right after it can cut the line short when the
 * pipe is full. A pipe that is full says EAGAIN to a descriptor that Node has made non-blocking,
 * and is waited for, for up to `STDERR_WAIT_MS`. Any other failure, such as a closed pipe, is given
 * up on: the process is ending.
 */
function writeStderrSync(text: string): void {
  const bytes = Buffer.from(text);
  const giveUpAt = Date.now() + STDERR_WAIT_MS;
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(2, bytes, written);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN" || Date.now() >= giveUpAt) return;
      // A sleep that blocks, 5 ms: the reader of the pipe is another process.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

/**
 * The line a crash prints: `what` and the error as `console.error` would format them, redacted by
 * `env`; or, when the error cannot be formatted (a hostile `inspect`, say), a fixed line.
 */
function crashLine(what: string, error: unknown, env: Record<string, string | undefined>): string {
  try {
    return redact(format(`serve: ${what}:`, error), env);
  } catch {
    return `serve: ${what} (it cannot be shown)`;
  }
}

/**
 * Makes an uncaught exception and an unhandled rejection print a line, redacted by `env`, to
 * stderr with `write`, `writeStderrSync` unless given, and end the process with 1, as Node does by
 * itself. Node prints them on its own otherwise, outside the redaction and with the whole error,
 * whose message can quote a URL that holds a key. The line is written before the process exits and
 * not through a stream, whose write the exit would cut short when the pipe is full.
 */
export function exitOnCrash(
  env: Record<string, string | undefined>,
  proc: CrashTarget = process,
  write: (text: string) => void = writeStderrSync,
): void {
  const crash = (what: string) => (error: unknown) => {
    try {
      write(`${crashLine(what, error, env)}\n`);
    } finally {
      proc.exit(1);
    }
  };
  proc.on("uncaughtException", crash("uncaught exception"));
  proc.on("unhandledRejection", crash("unhandled rejection"));
}

/** How long a failure lets the services stop before the process ends all the same, in milliseconds. */
const FAILURE_STOP_MS = 10_000;

/**
 * Ends the process with 1 when the services cannot go on (`Services.failed`), as a refusal to start
 * does: it says why with `print` (`console.error` unless given), stops the services, and exits
 * through `proc`. The stop gets `stopMs` (10 s unless given); a stop that fails or takes longer is
 * said, and the process ends all the same. Resolves once `proc.exit` has been called, which a real
 * process does not return from.
 */
export async function exitOnFailure(
  services: Pick<Services, "failed" | "stop">,
  proc: { exit(code: number): unknown },
  options: { print?: (line: string) => void; stopMs?: number } = {},
): Promise<void> {
  const print = options.print ?? ((line: string) => console.error(line));
  const stopMs = options.stopMs ?? FAILURE_STOP_MS;
  /** A line that cannot be printed, as with a closed stderr, does not keep the process alive. */
  const say = (line: string) => {
    try {
      print(line);
    } catch {
      // the process ends all the same
    }
  };
  const error = await services.failed;
  say(`serve: ${messageOf(error)}`);
  try {
    await withinDeadline(stopMs, services.stop());
  } catch (stopError) {
    say(
      stopError instanceof NoAnswerInTime
        ? `serve: not stopped within ${stopMs / 1000} s; exiting`
        : `serve: stopping failed: ${messageOf(stopError)}`,
    );
  } finally {
    proc.exit(1);
  }
}

async function main(): Promise<void> {
  let env: Record<string, string> = {};
  let services: Services | undefined;
  let stopping = false;
  // Whether the services have failed since they started: the process then ends with 1, however
  // it is stopped.
  let failing = false;

  const stopAndExit = async (running: Services) => {
    try {
      await running.stop();
    } catch (error) {
      console.error(`serve: stopping failed: ${messageOf(error)}`);
      process.exit(1);
    }
    process.exit(failing ? 1 : 0);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) {
      console.error(`serve: ${signal} again; exiting now`);
      process.exit(1);
    }
    stopping = true;
    console.log(`serve: ${signal}; stopping`);
    // While the services are starting there is nothing to stop yet: they stop once started.
    if (services !== undefined) void stopAndExit(services);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
    env = serveEnv();
    // From here on, all the process prints passes through `redact`: the services' lines, the
    // errors below, what the packages print to the console of their own, and a crash.
    redactConsole(env);
    exitOnCrash(env);
    services = await startServices(env, { deploymentsDir: deploymentsDirOverride() });
  } catch (error) {
    console.error(`serve: ${messageOf(error)}`);
    process.exit(1);
  }
  void services.failed.then(() => {
    failing = true;
  });
  void exitOnFailure(services, process);
  if (stopping) await stopAndExit(services);
}

// Only when run as the script, never when a test or another script imports from here.
if (import.meta.main) await main();
