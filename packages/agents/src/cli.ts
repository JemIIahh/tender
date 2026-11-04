import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import {
  ApiClient,
  ApiTimeoutError,
  bondTermsOf,
  KeyPair,
  type KeyPairString,
  keyKindOf,
  type Signer,
  TenderClient,
} from "@tender/client";
import { createStateStore, defaultStateDir } from "@tender/mcp";
import {
  AccountIdSchema,
  ApiError,
  NETWORKS,
  type NetworkId,
  type TenderApi,
} from "@tender/shared";
import { AGENT_NAMES, AGENTS, type AgentConfig, agentVariables, isAgentName } from "./agents";
import { type AgentChain, runAgent } from "./runner";
import { createLlmSolver } from "./solvers/llm";
import { createOfflineSolver } from "./solvers/offline";
import { createWeakSolver } from "./solvers/weak";
import type { Solver } from "./types";

// The command line of the reference agents (`bin/run-agent.ts`): which agent, which solver and which
// network, then the agent runs (`runAgent`) until it is stopped. It lives here and not in the bin so
// that a test can hand it files and a chain without starting a process.
//
//   pnpm exec tsx packages/agents/bin/run-agent.ts --agent analyst --solver llm --network testnet
//
// The model costs credits, so the llm solver asks it at most 30 times an hour. The flag
// `--max-llm-calls-per-hour N` sets another limit (`maxCallsPerHour` of `createLlmSolver`); the
// scripted solvers cost nothing and refuse it.
//
// What it reads. The variables come from `.env` and `.env.deploy.<network>` in the repository root,
// the network's winning, and the process's own variables win over both, so that a host's settings
// override the files (`pnpm serve` reads its environment the same way):
//
//   TENDER_CONTRACT       the Tender contract (the deploy writes it)
//   TENDER_API_URL        where the Tender API is, named as the API's own PUBLIC_API_URL names it. The
//                         agent signs in for exactly that base, so another spelling of the same
//                         server (an address in place of its domain) is refused at the sign-in
//                         that the agent makes when it starts, and the line says so (a warning:
//                         the agent starts all the same). It must be https, or http to localhost,
//                         127.0.0.1 or [::1] (`createApiClient`)
//   NEAR_RPC_URL          the chain's RPC; needed on the sandbox, which has none of its own
//   AGENT_<NAME>_ACCOUNT  the agent's account (the deploy writes it)
//   AGENT_<NAME>_PRIVATE_KEY
//                         the key it signs with: a function-call key limited to Tender, which the
//                         owner adds with `scripts/keeper-key.ts --role agent --agent <name>`. The
//                         deploy writes only `AGENT_<NAME>_FULL_ACCESS_KEY` (ruling P02-R27), and
//                         the agent never uses that one
//   LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
//                         the model, for `--solver llm` and for no other
//
// What it checks. Off the sandbox, before anything starts, the chain is asked what the key may do
// (`checkAgentKey`), and a full-access key, or one that is not limited to Tender, stops the agent
// there. A message about the environment names variables and never shows a value: a value can be a
// private key, or a URL with a key in it.

/** The repository root, where the env files and the seeds are. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** How long the chain has to say what the agent's key may do. */
const KEY_CHECK_DEADLINE_MS = 15_000;

const SOLVERS = ["llm", "offline", "weak"] as const;
type SolverName = (typeof SOLVERS)[number];

const USAGE =
  `usage: pnpm exec tsx packages/agents/bin/run-agent.ts --agent ${AGENT_NAMES.join("|")} ` +
  `--solver ${SOLVERS.join("|")} --network ${Object.keys(NETWORKS).join("|")} ` +
  "[--max-llm-calls-per-hour N]";

/** A failure whose message is the command line's own and safe to print: it holds no value of the environment. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

// ---- The command line -------------------------------------------------------------------------

export interface CliArgs {
  agent: AgentConfig;
  solver: SolverName;
  network: NetworkId;
  /** The llm solver's limit on requests to the model, when the flag sets one. */
  maxLlmCallsPerHour?: number;
}

/**
 * The call limit of a flag: digits, a whole number from 1. Why a value is refused is not said, as
 * it can be anything that was pasted.
 */
function asCallLimit(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 ? limit : undefined;
}

/**
 * The flags, checked. Throws a `CliError` that says what is wrong and shows the usage. It never
 * shows a value of the command line: an unknown name, or a number it cannot read, can be a key that
 * was pasted into the wrong flag, and the usage lists what is known.
 */
export function parseCli(args: readonly string[]): CliArgs {
  let values: {
    agent?: string;
    solver?: string;
    network?: string;
    "max-llm-calls-per-hour"?: string;
  };
  try {
    values = parseArgs({
      args: [...args],
      options: {
        agent: { type: "string" },
        solver: { type: "string" },
        network: { type: "string" },
        "max-llm-calls-per-hour": { type: "string" },
      },
    }).values;
  } catch (error) {
    // Node's message quotes the argument that failed, and that can be a key pasted by mistake.
    throw new CliError(`cannot read the command line (${describe(error)})\n${USAGE}`);
  }
  const { agent, solver, network } = values;
  const missing = [
    agent === undefined && "--agent",
    solver === undefined && "--solver",
    network === undefined && "--network",
  ].filter((flag) => flag !== false);
  if (agent === undefined || solver === undefined || network === undefined) {
    throw new CliError(`missing ${missing.join(", ")}\n${USAGE}`);
  }
  if (!isAgentName(agent)) {
    throw new CliError(`unknown agent: use one of ${AGENT_NAMES.join(", ")}\n${USAGE}`);
  }
  if (!(SOLVERS as readonly string[]).includes(solver)) {
    throw new CliError(`unknown solver: use one of ${SOLVERS.join(", ")}\n${USAGE}`);
  }
  if (!Object.hasOwn(NETWORKS, network)) {
    throw new CliError(`unknown network: use one of ${Object.keys(NETWORKS).join(", ")}\n${USAGE}`);
  }

  const flagged = values["max-llm-calls-per-hour"];
  const maxLlmCallsPerHour = flagged === undefined ? undefined : asCallLimit(flagged);
  if (flagged !== undefined && maxLlmCallsPerHour === undefined) {
    throw new CliError(`--max-llm-calls-per-hour must be a whole number from 1\n${USAGE}`);
  }
  if (flagged !== undefined && solver !== "llm") {
    throw new CliError(`--max-llm-calls-per-hour is for --solver llm only\n${USAGE}`);
  }
  return {
    agent: AGENTS[agent],
    solver: solver as SolverName,
    network: network as NetworkId,
    ...(maxLlmCallsPerHour !== undefined && { maxLlmCallsPerHour }),
  };
}

// ---- The environment --------------------------------------------------------------------------

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The variables of a dotenv file; none if it does not exist. The trailing spaces and tabs of every
 * line go first: node's `parseEnv` reads `KEY= ` (a blank value and a stray space) as a value that
 * runs on into the next line, and the next line's variable is lost.
 */
function readEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return Object.fromEntries(
    Object.entries(parseEnv(text.replace(/[ \t]+$/gm, ""))).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/**
 * What the agent reads: `.env`, then `.env.deploy.<network>` over it, then the variables of the
 * process over both. A variable set to nothing counts as not set (`FOO=` is what an unfilled
 * template has), so it never hides one of a file.
 */
export function readEnv(dir: string, network: NetworkId, processEnv: Env): Record<string, string> {
  const own: Record<string, string> = {};
  for (const [name, value] of Object.entries(processEnv)) {
    if (value !== undefined && value.trim() !== "") own[name] = value;
  }
  return {
    ...readEnvFile(join(dir, ".env")),
    ...readEnvFile(join(dir, `.env.deploy.${network}`)),
    ...own,
  };
}

/** Everything a run needs, from the flags and the environment. */
export interface RunConfig extends CliArgs {
  contractId: string;
  apiUrl: string;
  /** The chain's RPC, when the environment names one: the sandbox has no default. */
  rpcUrl?: string;
  /** The agent's account and its function-call key. */
  signer: Signer;
  /** The public half of that key, which the chain is asked about. */
  publicKey: string;
  /** The model's settings, for `--solver llm`. */
  llm?: { baseUrl: string; apiKey: string; model: string };
}

const AN_ACCOUNT = "a NEAR account id";
const A_URL = "an http(s) URL";

const asAccount = (value: string) => (AccountIdSchema.safeParse(value).success ? value : undefined);
const asText = (value: string) => value;

function asHttpUrl(value: string): string | undefined {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A private key and its public half. It must be an ed25519 key: the API signs the agent in with
 * NEP-413, which is defined for that curve alone. Why a key is refused is not said, as the reason
 * can quote it.
 */
function asKey(value: string): { privateKey: string; publicKey: string } | undefined {
  if (!value.startsWith("ed25519:")) return undefined;
  try {
    const pair = KeyPair.fromString(value as KeyPairString);
    return { privateKey: value, publicKey: pair.getPublicKey().toString() };
  } catch {
    return undefined;
  }
}

/** The command that makes the agent's key, for a message. */
const keyCommand = (network: string, agent: string) =>
  `pnpm exec tsx scripts/keeper-key.ts --network ${network} --role agent --agent ${agent}`;

/**
 * The run's settings from the flags and `env`, checked. Every fault is reported at once, in one
 * message that names the variables: the ones missing, then the ones whose values are wrong. Off the
 * sandbox a missing `AGENT_<NAME>_PRIVATE_KEY` also says how to make one.
 */
export function readRunConfig(args: CliArgs, env: Env): RunConfig {
  const { agent, solver, network } = args;
  const vars = agentVariables(agent.name);
  const missing: string[] = [];
  const wrong: string[] = [];

  function read<T>(
    name: string,
    parse: (value: string) => T | undefined,
    expected: string,
    required = true,
  ): T | undefined {
    const value = env[name]?.trim();
    if (value === undefined || value === "") {
      if (required) missing.push(name);
      return undefined;
    }
    const parsed = parse(value);
    if (parsed === undefined) wrong.push(`${name} must be ${expected}`);
    return parsed;
  }

  const contractId = read("TENDER_CONTRACT", asAccount, AN_ACCOUNT);
  const apiUrl = read("TENDER_API_URL", asHttpUrl, A_URL);
  const accountId = read(vars.account, asAccount, AN_ACCOUNT);
  const key = read(vars.privateKey, asKey, "an ed25519 access key, as ed25519:<base58>");
  const rpcUrl = read("NEAR_RPC_URL", asHttpUrl, A_URL, network === "sandbox");
  // The model's settings are the llm solver's alone: the scripted solvers do not read them, so a
  // value left over in `.env` cannot stop an agent that has no use for it.
  const llm = solver === "llm";
  const baseUrl = llm ? read("LLM_BASE_URL", asHttpUrl, A_URL) : undefined;
  const apiKey = llm ? read("LLM_API_KEY", asText, "a key") : undefined;
  const model = llm ? read("LLM_MODEL", asText, "a model name") : undefined;

  if (
    missing.length > 0 ||
    wrong.length > 0 ||
    contractId === undefined ||
    apiUrl === undefined ||
    accountId === undefined ||
    key === undefined
  ) {
    const faults = [...wrong];
    if (missing.length > 0) {
      const noun = missing.length === 1 ? "variable" : "variables";
      faults.unshift(
        `missing environment ${noun}: ${missing.join(", ")} ` +
          `(set them in .env or .env.deploy.${network})`,
      );
    }
    if (missing.includes(vars.privateKey) && network !== "sandbox") {
      faults.push(
        `${vars.privateKey} is a function-call key limited to Tender. The deploy does not write ` +
          `it, and the agent does not sign with ${vars.fullAccessKey}. Make it with: ` +
          keyCommand(network, agent.name),
      );
    }
    throw new CliError(faults.join("; "));
  }

  return {
    ...args,
    contractId,
    apiUrl,
    ...(rpcUrl !== undefined && { rpcUrl }),
    signer: { accountId, privateKey: key.privateKey },
    publicKey: key.publicKey,
    ...(baseUrl !== undefined &&
      apiKey !== undefined &&
      model !== undefined && { llm: { baseUrl, apiKey, model } }),
  };
}

// ---- The agent's key --------------------------------------------------------------------------

/** What an error code looks like: a letter, then up to 63 letters, digits and underscores. */
const CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The `code` of `value` if it has one that looks like a code. */
function codeIn(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { code } = value as { code?: unknown };
  return typeof code === "string" && CODE.test(code) ? code : undefined;
}

/** What a log line or a message says of an error that is not ours: its name and code, never its message. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = codeIn(error);
  return code === undefined ? error.name : `${error.name} ${code}`;
}

/** `promise`, or a `TimeoutError` after `ms`. The loser of the race is let go. */
function withinDeadline<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`no answer within ${ms} ms`), { name: "TimeoutError" }));
    }, ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** What the key check needs of the chain: one read. */
export type KeyReader = Pick<TenderClient, "viewAccessKey">;

/**
 * Off the sandbox, the agent's key must be a function-call key limited to the Tender contract: a
 * full-access key can do anything with its account, down to deleting it, and a key limited to
 * another receiver cannot call Tender. The chain is asked (`viewAccessKey`), with `deadlineMs`
 * (15 s) to answer, and anything else than a function-call key limited to `contractId` is a
 * failure to start. This is the keeper's check (`checkKeeperKey`) for an agent. The message names
 * the variable and the key's public half, shows no secret, and says how to make the right key.
 */
export async function checkAgentKey(
  chain: KeyReader,
  config: Pick<RunConfig, "agent" | "network" | "contractId" | "signer" | "publicKey">,
  deadlineMs = KEY_CHECK_DEADLINE_MS,
): Promise<void> {
  const { agent, network, contractId, signer, publicKey } = config;
  const vars = agentVariables(agent.name);
  const of = `of ${signer.accountId} (${vars.account})`;
  const make =
    `Remove the ${vars.privateKey} line from the env file and run ` +
    `${keyCommand(network, agent.name)}, which adds a function-call key limited to ` +
    `${contractId} and writes it there.`;

  let found: Awaited<ReturnType<KeyReader["viewAccessKey"]>>;
  try {
    found = await withinDeadline(deadlineMs, chain.viewAccessKey(signer.accountId, publicKey));
  } catch (error) {
    throw new CliError(
      `cannot ask the chain what ${vars.privateKey} may do (${describe(error)}), and the agent ` +
        "does not start with a key that was not checked",
    );
  }
  if (found === null) {
    throw new CliError(
      `${vars.privateKey} holds ${publicKey}, which is not a key ${of}. Run ` +
        `${keyCommand(network, agent.name)}, which adds a function-call key limited to ` +
        `${contractId} and writes it to ${vars.privateKey}.`,
    );
  }
  if (found.permission === "FullAccess") {
    throw new CliError(
      `${vars.privateKey} holds ${publicKey}, a full-access key ${of}, which can do anything ` +
        `with the account, and the agent will not hold one. ${make} Do not delete this key from ` +
        "the account: an account without a full-access key is locked for good.",
    );
  }
  if (keyKindOf(found.permission, contractId) !== "function_call") {
    throw new CliError(
      `${vars.privateKey} holds ${publicKey}, a key ${of} that is not a function-call key ` +
        `limited to ${contractId}. ${make}`,
    );
  }
}

// ---- The registration -------------------------------------------------------------------------

/** What the registration check needs of the chain: the agent, and the config's bond if it must look. */
export type RegistrationReader = Pick<TenderClient, "getAgent" | "getConfig">;

/**
 * The line to warn with when `account` cannot enter an open task, or null when it can (or when the
 * chain does not answer within `deadlineMs`: the agent is not held back for a read). The contract
 * takes an entry to an open task only from an active agent that holds the bond (contract Task 16b,
 * `E_NOT_REGISTERED`), so two kinds of agent are refused at every open task they try: one that is
 * not registered (never, unregistering, or retired), and an active one that registered before the
 * owner set a bond and holds none. It is a warning and not a stop because a task pinned to the
 * agent takes it without: the agent starts all the same. A function-call key cannot register (it
 * attaches no deposit), so the line names the way: `pnpm agent:register`, with the account's
 * full-access key; registering again pays the bond in the second case too.
 *
 * The config is read only for an active agent that shows no bond, to tell whether the owner has set
 * one: while none is set, such an agent is not held back.
 */
export async function registrationWarning(
  chain: RegistrationReader,
  account: string,
  deadlineMs = KEY_CHECK_DEADLINE_MS,
): Promise<string | null> {
  const way =
    "Registering takes a bond and a full-access key, which this agent's key is not: " +
    "run pnpm agent:register for the account.";
  let agent: Awaited<ReturnType<RegistrationReader["getAgent"]>>;
  try {
    agent = await withinDeadline(deadlineMs, chain.getAgent(account));
  } catch {
    return null;
  }
  if (agent?.status === "active") {
    if (agent.bond_token !== null && agent.bond_amount !== null) return null;
    let bond: ReturnType<typeof bondTermsOf>;
    try {
      bond = bondTermsOf(await withinDeadline(deadlineMs, chain.getConfig()));
    } catch {
      return null;
    }
    if (bond === null) return null;
    return (
      `WARN run-agent: ${account} registered before the bond was set and holds none, so the ` +
      "contract refuses it at every open task (E_NOT_REGISTERED); a task pinned to it is not " +
      `affected. ${way}`
    );
  }
  const standing =
    agent === null
      ? "is not registered as an agent"
      : agent.status === "unregistering"
        ? "is unregistering"
        : "has retired";
  return (
    `WARN run-agent: ${account} ${standing}, so the contract refuses it at every open task ` +
    `(E_NOT_REGISTERED); a task pinned to it is not affected. ${way}`
  );
}

// ---- The run ----------------------------------------------------------------------------------

/** The client the agent signs with, and the chain read that checks its key. */
export type CliClient = AgentChain & KeyReader & RegistrationReader;

/**
 * The Tender API client of a run: `ApiClient`, acting as the agent's account with its key. The bin
 * hands it to `main` as `createApi`.
 *
 * The client reads its base once, when it is made, and refuses one it cannot use: plain http to any
 * host but localhost, 127.0.0.1 or [::1] (a signed-in client sends a signature and then a bearer
 * token), or a base with a user name, a query, a fragment, an empty path segment, a repeated `/v1`
 * or a host that ends in a dot. Those are the only things it can refuse (the key was read already,
 * `asKey`), and its sentences name the problem and quote no value, so they are shown as they are,
 * after the variable they are about. Any other error of a run is shown by name and code alone.
 *
 * What the client cannot know when it is made is that the base is the API's own spelling of itself.
 * It finds out at a sign-in, which `main` makes once when the agent starts (`signInAtStart`).
 */
export function createApiClient(config: Pick<RunConfig, "apiUrl" | "signer">): TenderApi {
  try {
    return new ApiClient({ baseUrl: config.apiUrl, signer: config.signer });
  } catch (error) {
    const sentence = error instanceof Error ? error.message : "the API client refused it";
    throw new CliError(`TENDER_API_URL: ${sentence}`);
  }
}

/**
 * Where the real seeds keep their solutions and weak answers (seeds/README.md): `TENDER_SEEDS_PRIVATE_DIR`, with a
 * leading `~` taken as the home directory, else `seeds-private/` in the repository.
 */
export function privateSeedsDirOf(env: Env, root: string = REPO_ROOT): string {
  const set = env.TENDER_SEEDS_PRIVATE_DIR?.trim() ?? "";
  if (set === "") return join(root, "seeds-private");
  if (set === "~") return homedir();
  return resolve(set.startsWith("~/") ? join(homedir(), set.slice(2)) : set);
}

function makeSolver(
  config: RunConfig,
  seedsDir: string,
  privateDir: string,
  log: (line: string) => void,
): Solver {
  switch (config.solver) {
    case "llm": {
      // `readRunConfig` requires the three when the solver is `llm`. The solver's warnings go where
      // the agent's lines do.
      if (config.llm === undefined) throw new CliError("the llm solver needs LLM_* settings");
      return createLlmSolver({ ...config.llm, maxCallsPerHour: config.maxLlmCallsPerHour, log });
    }
    case "offline":
      return createOfflineSolver(seedsDir, privateDir);
    case "weak":
      return createWeakSolver(seedsDir, privateDir);
  }
}

export interface CliOptions {
  /**
   * Where the Tender API client comes from: `createApiClient`, for the bin. It is called once the
   * key has been checked, and may throw a `CliError`. `main` signs the client in (`signIn`) once
   * before the loop starts, and warns if that fails.
   */
  createApi: (config: RunConfig) => TenderApi;
  /** Where `.env` and `.env.deploy.<network>` are. The repository root by default. */
  dir?: string;
  /** The process's variables, which win over the files. Default: `process.env`. */
  env?: Env;
  /** Where the seeds are, for the scripted solvers. Default: the repository's `seeds/`. */
  seedsDir?: string;
  /**
   * Where the real seeds keep their solutions and weak answers, which the scripted solvers read
   * first. Default:
   * `TENDER_SEEDS_PRIVATE_DIR` of the run's environment, else the repository's `seeds-private/`.
   */
  privateDir?: string;
  /** Receives the agent's log lines. Default: `console.log`. */
  out?: (line: string) => void;
  /** Receives what is said about a failure. Default: `console.error`. */
  err?: (text: string) => void;
  /** Builds the agent's client. Default: a `TenderClient` that signs with the agent's key. */
  makeClient?: (config: RunConfig) => CliClient;
  /** The loop to run. Default: `runAgent`. */
  run?: typeof runAgent;
  /** Stops the agent. Default: SIGINT and SIGTERM, for as long as the agent runs. */
  signal?: AbortSignal;
  /** How long the chain has to answer the key check. Default: 15 s. */
  keyCheckMs?: number;
  /** The home directory the drafts are kept under (`~/.tender/...`). Default: the user's. */
  home?: string;
}

function defaultClient(config: RunConfig): CliClient {
  return new TenderClient({
    network: config.network,
    contractId: config.contractId,
    ...(config.rpcUrl !== undefined && { rpcUrl: config.rpcUrl }),
    signer: config.signer,
  });
}

/**
 * A failure as the one thing the command line prints. A `CliError` is its own message, which holds
 * no value; any other error is its name and code, as its message can quote a URL with a key in it.
 * Every string in `secrets` is cut out all the same.
 */
function describeFailure(error: unknown, secrets: readonly string[]): string {
  const text = error instanceof CliError ? error.message : describe(error);
  return `run-agent: ${redacted(text, secrets)}`;
}

/** `text` with every string of `secrets` cut out of it. */
function redacted(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret !== "") result = result.replaceAll(secret, "<redacted>");
  }
  return result;
}

// ---- The first sign-in ------------------------------------------------------------------------

/** How the sentence of `ApiClient` begins when it will not sign a challenge that is not for its base. */
const CHALLENGE_REFUSAL = "refusing to sign the API's sign-in challenge: ";

/**
 * What the log says of a sign-in that failed. The client's own sentences are shown as they are:
 * they name the problem and quote nothing that a server sent or the client was given. They are the
 * status and code of an `ApiError`, the time of an `ApiTimeoutError`, and the refusal to sign a
 * challenge that is not for the base, which is what a base spelt otherwise than the API's own
 * gets. Any other error is its name and its code, or its cause's, since `fetch` puts the socket's
 * there (`ECONNREFUSED`); never its message, which can quote a URL with a key in it.
 */
function signInFailure(error: unknown): string {
  if (error instanceof ApiError || error instanceof ApiTimeoutError) return error.message;
  if (error instanceof Error && error.message.startsWith(CHALLENGE_REFUSAL)) return error.message;
  if (!(error instanceof Error)) return describe(error);
  const code = codeIn(error) ?? codeIn(error.cause);
  return code === undefined ? error.name : `${error.name} ${code}`;
}

/**
 * Signs the agent in once, as it starts, so that a base that is not the API's own spelling of
 * itself shows its sentence now, and not as an error that the loop logs by name alone at its first
 * call that acts. The client times each of its requests out (`timeoutMs`), so this does not wait
 * for ever, and the stop signal ends the wait at once all the same. A sign-in that fails is one
 * line (a warning) and not a stop: an API that is down for a while is no reason for the agent not
 * to start, and its first call that acts signs in again. One that works leaves its token with the
 * client, which the calls then use.
 */
async function signInAtStart(
  api: TenderApi,
  signal: AbortSignal,
  log: (line: string) => void,
  secrets: readonly string[],
): Promise<void> {
  let release = () => {};
  const stopped = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    release = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    await Promise.race([api.signIn(), stopped]);
  } catch (error) {
    // Once the agent is stopped there is no one to tell.
    if (!signal.aborted) {
      log(redacted(`WARN run-agent: sign-in failed at start: ${signInFailure(error)}`, secrets));
    }
  } finally {
    release();
  }
}

/** The streams and the exit that `exitWhenFlushed` ends a process with: the process's own. */
export interface ExitIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  exit: (code: number) => never;
}

/**
 * Ends the process with `code` once everything written to stdout and stderr has gone out. A pipe
 * takes writes asynchronously, and `process.exit` would cut what is still queued, so an empty
 * write is waited for on each stream: writes to a stream complete in order, so its callback comes
 * after the lines before it. The bin calls this after `main` (review M3), since a request that lost
 * a race with the stop can otherwise hold the process open for up to the client's own timeout (30 s).
 * `io` is for tests.
 */
export async function exitWhenFlushed(
  code: number,
  io: ExitIo = { stdout: process.stdout, stderr: process.stderr, exit: process.exit },
): Promise<never> {
  const flushed = (stream: ExitIo["stdout"]) =>
    new Promise<void>((resolve) => {
      stream.write("", () => resolve());
    });
  await Promise.all([flushed(io.stdout), flushed(io.stderr)]);
  return io.exit(code);
}

/**
 * Runs the command line and returns the exit code: 0 after the agent was stopped, 1 for anything
 * that kept it from starting or ended it. The order is the flags, the environment, the agent's
 * key (off the sandbox), the Tender API client, the solver, one sign-in to the API, and then the
 * loop.
 */
export async function main(args: readonly string[], options: CliOptions): Promise<number> {
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  let secrets: string[] = [];
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  if (options.signal === undefined) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  try {
    const parsed = parseCli(args);
    const env = readEnv(options.dir ?? REPO_ROOT, parsed.network, options.env ?? process.env);
    const config = readRunConfig(parsed, env);
    const { privateKey } = config.signer;
    secrets = [privateKey, privateKey.slice(privateKey.indexOf(":") + 1)];
    if (config.llm !== undefined) secrets.push(config.llm.apiKey);

    const client = (options.makeClient ?? defaultClient)(config);
    // The sandbox's accounts have full-access keys, and nothing there is worth the key's loss.
    if (config.network !== "sandbox") {
      await checkAgentKey(client, config, options.keyCheckMs);
    }
    const notice = await registrationWarning(client, config.signer.accountId, options.keyCheckMs);
    if (notice !== null) out(notice);
    const api = options.createApi(config);
    const solver = makeSolver(
      config,
      options.seedsDir ?? join(REPO_ROOT, "seeds"),
      options.privateDir ?? privateSeedsDirOf(env),
      out,
    );
    const state = createStateStore(
      defaultStateDir(config.network, config.signer.accountId, options.home),
    );
    const signal = options.signal ?? stop.signal;
    await signInAtStart(api, signal, out, secrets);

    await (options.run ?? runAgent)({
      name: config.agent.name,
      client,
      api,
      state,
      tags: config.agent.tags,
      // A provider's agent takes the hires of its services: the pinned tasks that invite it.
      hires: true,
      solver,
      log: out,
      signal,
    });
    return 0;
  } catch (error) {
    err(describeFailure(error, secrets));
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
