import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type ApiServer,
  createApp,
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
  type SessionLock,
  tryAdvisoryLock,
} from "@tender/db";
import { startIndexer } from "@tender/indexer";
import { AccountIdSchema, NETWORKS, type NetworkId } from "@tender/shared";
import { parseKey } from "./deploy";
import { loadEnv, REPO_ROOT, readEnvFile } from "./lib/env";

/**
 * `pnpm serve`: the one process that runs the services of a deployment against one database.
 *
 *   database   opened from DATABASE_URL and migrated
 *   API        on API_PORT (default 8787), for the web app, agents and MCP clients, at the base
 *              URL PUBLIC_API_URL, which sign-in is bound to (P03-R28)
 *   indexer    follows the chain into the database; on Postgres only while this process holds
 *              the indexer lock, so that one process at a time writes to the index (P03-R25)
 *   keeper     voids and cleans up tasks, when KEEPER_PRIVATE_KEY is set, and runs with the
 *              indexer, under the same lock, so that no two processes send the same calls; off the
 *              sandbox its key must be a function-call key limited to Tender, which the chain is
 *              asked about first
 *
 * Plans 04 and 05 add the Telegram notifier and bot, and the Judge, each when its variables are
 * set (see the places marked "task W" below).
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
/** A Telegram username, as in t.me/<username>. */
const TELEGRAM_USERNAME = /^[A-Za-z0-9_]{5,32}$/;

/**
 * The key of the indexer's session advisory lock, one per database whatever the deployment: it
 * spells "INDEXER", as the migration lock of `@tender/db` spells "TENDER".
 */
export const INDEXER_LOCK_KEY = 0x494e4445584552n;
/** How often a process that waits for the indexer lock tries again. */
const LOCK_RETRY_MS = 5_000;
/** How long the chain has to say what the keeper's key may do, at startup. */
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
   * `PUBLIC_API_URL` with no trailing slash. Off the sandbox it is always set; on the sandbox,
   * undefined stands for the loopback address on the port the server is bound to (`publicUrlOf`).
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
  /** What the environment allows but is likely a mistake, one sentence each. */
  warnings: string[];
}

export interface KeeperConfig {
  accountId: string;
  privateKey: string;
  /** `KEEPER_INTERVAL_MS`, or undefined for the keeper's default. */
  intervalMs: number | undefined;
}

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
 *   `DATABASE_URL` (`pglite:memory`, `pglite:<dir>` or a Postgres URL), which must all be set;
 * - `API_PORT`, `INDEXER_POLL_MS`, `KEEPER_INTERVAL_MS`, `INDEXER_START_HEIGHT` and
 *   `TRUSTED_PROXY_HOPS`, which must be whole numbers in plain decimal digits, each in its range;
 * - `PUBLIC_API_URL`, the exact base URL clients call, which sign-in is bound to: it must be set
 *   off the sandbox, and be an http(s) URL with no query, fragment or credentials;
 * - `PUBLIC_WEB_URL`, whose entries must be http(s) origins, and `NEAR_RPC_URL` and
 *   `NEARDATA_URL`, which must be http(s) URLs. `NEAR_RPC_URL` must be set on the sandbox, whose
 *   node has no fixed address;
 * - `TEAM_ACCOUNTS`, whose entries must be account ids, and `TELEGRAM_BOT_USERNAME`, which must be
 *   a username as in t.me/<username>;
 * - with `KEEPER_PRIVATE_KEY` set, that it is a private key and `KEEPER_ACCOUNT` an account id.
 *
 * An empty value is an unset one. Off the sandbox, an empty `PUBLIC_WEB_URL` is a warning: allowed,
 * but likely a mistake.
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
  }

  const apiPort =
    whole("API_PORT", 0, 65_535, "a whole number from 0 to 65535 (0 picks a free port)") ??
    DEFAULT_API_PORT;
  whole("INDEXER_POLL_MS", 1, MAX_TIMER_MS, milliseconds);
  const keeperIntervalMs = whole("KEEPER_INTERVAL_MS", 1, MAX_TIMER_MS, milliseconds);
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

  const publicApiUrl = get("PUBLIC_API_URL");
  if (publicApiUrl === undefined) {
    if (offSandbox) {
      problems.push(
        "PUBLIC_API_URL must be set off the sandbox: the exact base URL clients call the API at, " +
          "which sign-in is bound to",
      );
    }
  } else if (!isApiBase(publicApiUrl)) {
    problems.push(
      "PUBLIC_API_URL must be an http or https URL with no query, fragment or credentials",
    );
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
    publicApiUrl: publicApiUrl?.replace(/\/+$/, ""),
    rpcUrl,
    webOrigins,
    teamAccounts,
    telegramBotUsername,
    trustedProxyHops,
    keeper,
    warnings,
  };
}

/**
 * The environment `pnpm serve` runs with: what `loadEnv` reads for the network (`.env` and
 * `.env.deploy.<network>`, the network's file winning), under the process's own variables. A
 * variable the process sets wins over the files, so that a host's settings override them (a
 * container has no env files at all); one it sets to an empty value counts as unset. The network
 * is the process's `TENDER_NETWORK`, or else `.env`'s. When neither names one, only `.env` is
 * read, and `readServeConfig` says what is wrong.
 */
export function serveEnv(
  processEnv: Record<string, string | undefined> = process.env,
  dir: string = REPO_ROOT,
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
 * bound to. Never `0.0.0.0` or `[::]`, which no client can call.
 */
export function publicUrlOf(config: Pick<ServeConfig, "publicApiUrl">, port: number): string {
  return config.publicApiUrl ?? `http://127.0.0.1:${port}`;
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

// ---- The keeper's key -------------------------------------------------------------------------

/**
 * Off the sandbox, the keeper's key must be a function-call key limited to the Tender contract: a
 * full-access key can do anything with its account, and a key limited to another receiver cannot
 * call Tender. The chain is asked (`viewAccessKey`), with 15 seconds to answer, and anything else
 * is a failure to start, whose message names `KEEPER_PRIVATE_KEY` and shows no key.
 */
export async function checkKeeperKey(
  client: Pick<TenderClient, "viewAccessKey">,
  keeper: KeeperConfig,
  contractId: string,
): Promise<void> {
  const publicKey = parseKey(keeper.privateKey, "KEEPER_PRIVATE_KEY").getPublicKey().toString();
  const of = `of ${keeper.accountId} (KEEPER_ACCOUNT)`;
  const make =
    "Remove the KEEPER_PRIVATE_KEY line from the env file and run scripts/keeper-key.ts, which " +
    `adds a function-call key limited to ${contractId} and writes it there.`;
  let found: Awaited<ReturnType<TenderClient["viewAccessKey"]>>;
  try {
    found = await withinDeadline(
      KEY_CHECK_DEADLINE_MS,
      client.viewAccessKey(keeper.accountId, publicKey),
    );
  } catch (error) {
    throw new Error(
      `cannot ask the chain what KEEPER_PRIVATE_KEY may do (${describe(error)}), and the keeper ` +
        "does not start with a key that was not checked",
    );
  }
  if (found === null) {
    throw new Error(
      `KEEPER_PRIVATE_KEY is not a key ${of}. Run scripts/keeper-key.ts, which adds a ` +
        `function-call key limited to ${contractId} and writes it to KEEPER_PRIVATE_KEY.`,
    );
  }
  if (found.permission === "FullAccess") {
    throw new Error(
      `KEEPER_PRIVATE_KEY is a full-access key ${of}, which can do anything with the account, ` +
        `and the keeper will not hold one. ${make} Do not delete this key from the account: ` +
        "an account without a full-access key is locked for good.",
    );
  }
  if (keyKindOf(found.permission, contractId) !== "function_call") {
    throw new Error(
      `KEEPER_PRIVATE_KEY is a key ${of} that is not a function-call key limited to ` +
        `${contractId}. ${make}`,
    );
  }
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
   * a Postgres database (`tryAdvisoryLock`), and no lock for PGlite, which one process alone opens.
   */
  tryLock?: () => Promise<SessionLock | null>;
}

export interface Services {
  /** The URL the API is bound to, such as `http://127.0.0.1:8787`. */
  url: string;
  /** The base URL clients call the API at, which sign-in is bound to (see `publicUrlOf`). */
  publicUrl: string;
  /**
   * Stops everything and resolves once all of it is down: the API stops taking connections and
   * cuts the ones left after the grace, then the keeper stops, then the indexer, the indexer lock
   * is let go, and the database is closed. Calling it again returns the same promise.
   */
  stop(): Promise<void>;
}

async function openIndex(url: string): Promise<Db> {
  const db = await openDb(url);
  try {
    await migrate(db);
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  return db;
}

/**
 * Starts the services of `env` (see the top of this file), and resolves once they run: the API
 * listens, and the indexer, with the keeper if it is to run, runs or waits for the indexer lock.
 * The environment is checked first (`readServeConfig`), and off the sandbox the keeper's key too,
 * before anything starts. What fails to start is thrown, after what had started is stopped.
 */
export async function startServices(
  env: Record<string, string | undefined>,
  options: ServeOptions = {},
): Promise<Services> {
  const log = options.log ?? console.log;
  const config = readServeConfig(env);
  for (const warning of config.warnings) log(`WARN serve: ${warning}`);
  const { network, contractId, rpcUrl } = config;
  // One client reads the chain for the API and the indexer.
  const client = new TenderClient({ network, contractId, rpcUrl });

  if (config.keeper !== undefined && network !== "sandbox") {
    await checkKeeperKey(client, config.keeper, contractId);
  }
  const keeper =
    config.keeper === undefined
      ? undefined
      : {
          config: config.keeper,
          client: new TenderClient({
            network,
            contractId,
            rpcUrl,
            signer: { accountId: config.keeper.accountId, privateKey: config.keeper.privateKey },
          }),
        };

  const db = await openIndex(config.database.url);
  let api: ApiServer | undefined;
  /** The indexer and the keeper, with the lock they run under, if any. */
  let work: Stoppable | undefined;

  /** Stops what has started, in order, going on past a failure, and throws the first one. */
  const stopAll = async (): Promise<void> => {
    const failures: unknown[] = [];
    const step = async (work: () => Promise<void> | undefined) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    await step(() => api?.close());
    // Task W: stop the Telegram bot and notifier, and the Judge, here.
    // The keeper, then the indexer, then the lock.
    await step(() => work?.stop());
    await step(() => db.close());
    if (failures.length > 0) throw failures[0];
  };

  let publicUrl = "";
  try {
    api = await startApiServer(
      (url) => {
        publicUrl = publicUrlOf(config, Number(new URL(url).port));
        // Task W: mount the Telegram webhook on this app, before it is returned.
        return createApp({
          db,
          client,
          network,
          contractId,
          publicUrl,
          teamAccounts: config.teamAccounts,
          webOrigins: config.webOrigins,
          telegramBotUsername: config.telegramBotUsername,
          trustedProxyHops: config.trustedProxyHops,
        });
      },
      { port: config.apiPort, closeGraceMs: options.closeGraceMs },
    );
    log(`serve: API at ${api.url}, called at ${publicUrl} (${network}, ${contractId})`);

    // The indexer and the keeper start and stop together, so that the keeper runs only where
    // the index is written: two keepers would send the same calls, and pay for the ones that lose.
    const startWork = (): Stoppable => {
      const indexer = startIndexer(env, {
        db,
        client,
        log,
        deploymentsDir: options.deploymentsDir,
      });
      if (keeper === undefined) return indexer;
      const stopKeeper = new AbortController();
      let keeping: Promise<void>;
      try {
        keeping = startKeeper({
          db,
          client: keeper.client,
          intervalMs: keeper.config.intervalMs,
          signal: stopKeeper.signal,
          log,
        });
      } catch (error) {
        void indexer.stop();
        throw error;
      }
      log(`serve: keeper on, as ${keeper.config.accountId}`);
      return {
        async stop() {
          stopKeeper.abort();
          await keeping;
          await indexer.stop();
        },
      };
    };
    if (keeper === undefined) log("serve: keeper off (KEEPER_PRIVATE_KEY is not set)");
    // PGlite is one process's own database, so it needs no lock.
    const tryLock =
      options.tryLock ??
      (config.database.kind === "postgres"
        ? () => tryAdvisoryLock(config.database.url, INDEXER_LOCK_KEY)
        : undefined);
    work =
      tryLock === undefined
        ? startWork()
        : await runWhileLocked({
            tryLock,
            start: startWork,
            guards: keeper === undefined ? "the indexer" : "the indexer and the keeper",
            log,
          });
    // Task W: start the Telegram notifier and bot, and the Judge, here, each when its
    // variables are set.
  } catch (error) {
    await stopAll().catch(() => undefined);
    throw error;
  }

  let stopped: Promise<void> | undefined;
  return {
    url: api.url,
    publicUrl,
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
 * and the password of each such URL too. What the command line prints passes through it: the
 * errors of the services name no secret, and this is so that no other error does either.
 */
export function redact(text: string, env: Record<string, string | undefined>): string {
  let out = text;
  for (const [key, raw] of Object.entries(env)) {
    const value = raw?.trim();
    if (value === undefined || value.length < 4 || !SECRET.test(key)) continue;
    out = out.replaceAll(value, `<${key}>`);
    const password = URL.parse(value)?.password;
    if (password === undefined || password.length < 4) continue;
    for (const spelling of [password, decoded(password)]) {
      out = out.replaceAll(spelling, `<password of ${key}>`);
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

async function main(): Promise<void> {
  let env: Record<string, string> = {};
  let services: Services | undefined;
  let stopping = false;

  const stopAndExit = async (running: Services) => {
    try {
      await running.stop();
    } catch (error) {
      console.error(`serve: stopping failed: ${redact(messageOf(error), env)}`);
      process.exit(1);
    }
    process.exit(0);
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
    // Every line the services write passes through `redact` too, as what is printed of an error.
    services = await startServices(env, { log: (line) => console.log(redact(line, env)) });
  } catch (error) {
    console.error(`serve: ${redact(messageOf(error), env)}`);
    process.exit(1);
  }
  if (stopping) await stopAndExit(services);
}

// Only when run as the script, never when a test or another script imports from here.
if (import.meta.main) await main();
