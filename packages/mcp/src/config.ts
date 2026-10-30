import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Signer, TenderClient } from "@tender/client";
import { AccountIdSchema, NETWORKS, type NetworkId } from "@tender/shared";
import { KeyPair, type KeyPairString } from "near-api-js";
import { defaultStateDir } from "./state";
import { scrub } from "./tools/format";

// What the bin reads from the environment, and what it does with it. It lives here and not in the
// bin so that a test can hand it an environment without starting a process.
//
// A message about the environment names variables and never quotes their values: a value can be a
// private key, or a URL with a key in it.

/** Why the environment cannot start a server. The message is one line. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface McpConfig {
  network: NetworkId;
  contractId: string;
  /** Where the Tender API is. */
  apiUrl: string;
  /** The chain's RPC, when the environment names one: the sandbox has no default. */
  rpcUrl?: string;
  /** The agent's account, and the key that signs for it. */
  signer: Signer;
  /** The public half of that key, which `detectKeyKind` looks up. */
  publicKey: string;
  /** Where the drafts are kept: an absolute path unless the environment gave a relative one. */
  stateDir: string;
  /**
   * The one directory that `commit_result` may read a file from (P04-R1), an absolute path. Not set
   * means that no file is read, and a result is given as text.
   */
  filesDir?: string;
  judgeAccount?: string;
  /** The token that `TENDER_TOKEN` names, if it does. See `resolveDefaultToken`. */
  token?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** What a variable must be, as the message about a wrong one says it. */
const AN_ACCOUNT = "a NEAR account id";
const A_URL = "an http(s) URL";
const AN_API_URL = "an https URL, or an http URL to localhost, 127.0.0.1 or [::1]";

/**
 * The value of `name` without the space around it, or undefined when it is not set. A variable set
 * to nothing is not set: it is what `FOO=` in an env file or a JSON config gives, and the value an
 * unfilled template has.
 */
function setting(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function asNetwork(value: string): NetworkId | undefined {
  return Object.hasOwn(NETWORKS, value) ? (value as NetworkId) : undefined;
}

function asAccount(value: string): string | undefined {
  return AccountIdSchema.safeParse(value).success ? value : undefined;
}

function asHttpUrl(value: string): string | undefined {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The hosts that plain `http:` may go to: this machine. The API takes a bearer token, so every
 * other host needs `https:`. These are the three forms in which `new URL` leaves a loopback host;
 * another address in 127.0.0.0/8 is refused rather than guessed at.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

function asApiUrl(value: string): string | undefined {
  try {
    const { protocol, hostname } = new URL(value);
    if (protocol === "https:") return value;
    return protocol === "http:" && LOOPBACK_HOSTS.has(hostname) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A private key and its public half. Why a key is refused is not said: it can quote the key. */
function asKey(value: string): { privateKey: string; publicKey: string } | undefined {
  try {
    const pair = KeyPair.fromString(value as KeyPairString);
    return { privateKey: value, publicKey: pair.getPublicKey().toString() };
  } catch {
    return undefined;
  }
}

/**
 * `path` with a leading `~` taken to be `home`: `~` is `home` and `~/x` is `{home}/x`. A config
 * file such as an MCP client's `.mcp.json` can hold `~/...` in `TENDER_STATE_DIR`, but no shell
 * expands it there, and the state store would take it for a directory named `~` under the current
 * directory. `~user` is refused for the same reason, since it would be taken for that. Any other
 * path is returned as it is. `variable` is the name that a refusal gives.
 */
export function expandHome(path: string, home: string, variable = "TENDER_STATE_DIR"): string {
  if (path !== "~" && !path.startsWith("~/")) {
    if (path.startsWith("~")) {
      throw new ConfigError(`${variable} must not start with ~user: only ~ and ~/ are expanded`);
    }
    return path;
  }
  if (!isAbsolute(home)) {
    throw new ConfigError(`${variable} starts with ~, but the home directory is not known`);
  }
  return path === "~" ? home : join(home, path.slice(2));
}

/** `TENDER_FILES_DIR` as an absolute path (a leading `~` is the home directory). */
function absoluteFilesDir(value: string, home: string): string {
  const path = expandHome(value, home, "TENDER_FILES_DIR");
  if (!isAbsolute(path)) throw new ConfigError("TENDER_FILES_DIR must be an absolute path");
  return path;
}

/**
 * The server's settings from `env`, checked.
 *
 * - Required: `TENDER_NETWORK`, `TENDER_CONTRACT`, `TENDER_API_URL`, `TENDER_ACCOUNT` and
 *   `TENDER_PRIVATE_KEY`; and `NEAR_RPC_URL` on the sandbox, which has no RPC of its own. The other
 *   networks use theirs unless `NEAR_RPC_URL` names another. `TENDER_API_URL` is `https:`, or
 *   `http:` to this machine only, since the API is signed in to with a bearer token.
 * - Optional: `TENDER_STATE_DIR` (default: `defaultStateDir`, under `home`; a leading `~` is
 *   expanded to `home`), `TENDER_FILES_DIR` (an absolute path, `~` expanded likewise; default:
 *   none, and then `commit_result` takes no file), `TENDER_JUDGE_ACCOUNT` and `TENDER_TOKEN`.
 *
 * A variable that is set to nothing is not set. Every fault is reported at once, in one line that
 * names the variables: the ones missing, then the ones whose values are wrong.
 */
export function readConfig(env: Env, home: string = homedir()): McpConfig {
  const missing: string[] = [];
  const wrong: string[] = [];

  function read<T>(
    name: string,
    parse: (value: string) => T | undefined,
    expected: string,
    required = true,
  ): T | undefined {
    const value = setting(env, name);
    if (value === undefined) {
      if (required) missing.push(name);
      return undefined;
    }
    const parsed = parse(value);
    if (parsed === undefined) wrong.push(`${name} must be ${expected}`);
    return parsed;
  }

  const network = read("TENDER_NETWORK", asNetwork, `one of ${Object.keys(NETWORKS).join(", ")}`);
  const contractId = read("TENDER_CONTRACT", asAccount, AN_ACCOUNT);
  const apiUrl = read("TENDER_API_URL", asApiUrl, AN_API_URL);
  const accountId = read("TENDER_ACCOUNT", asAccount, AN_ACCOUNT);
  const key = read("TENDER_PRIVATE_KEY", asKey, "an access key, as ed25519:<base58>");
  const rpcUrl = read("NEAR_RPC_URL", asHttpUrl, A_URL, network === "sandbox");
  const judgeAccount = read("TENDER_JUDGE_ACCOUNT", asAccount, AN_ACCOUNT, false);
  const token = read("TENDER_TOKEN", asAccount, AN_ACCOUNT, false);

  // Only once the network and the account are known to be good can the default directory be made.
  let stateDir: string | undefined;
  const configuredDir = setting(env, "TENDER_STATE_DIR");
  try {
    if (configuredDir !== undefined) stateDir = expandHome(configuredDir, home);
    else if (network !== undefined && accountId !== undefined) {
      stateDir = defaultStateDir(network, accountId, home);
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    wrong.push(error.message);
  }

  let filesDir: string | undefined;
  const configuredFilesDir = setting(env, "TENDER_FILES_DIR");
  try {
    if (configuredFilesDir !== undefined) filesDir = absoluteFilesDir(configuredFilesDir, home);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    wrong.push(error.message);
  }

  if (
    missing.length > 0 ||
    wrong.length > 0 ||
    network === undefined ||
    contractId === undefined ||
    apiUrl === undefined ||
    accountId === undefined ||
    key === undefined ||
    stateDir === undefined
  ) {
    const faults = [...wrong];
    if (missing.length > 0) {
      const noun = missing.length === 1 ? "variable" : "variables";
      faults.unshift(`missing environment ${noun}: ${missing.join(", ")}`);
    }
    throw new ConfigError(faults.join("; "));
  }

  return {
    network,
    contractId,
    apiUrl,
    ...(rpcUrl !== undefined && { rpcUrl }),
    signer: { accountId, privateKey: key.privateKey },
    publicKey: key.publicKey,
    stateDir,
    ...(filesDir !== undefined && { filesDir }),
    ...(judgeAccount !== undefined && { judgeAccount }),
    ...(token !== undefined && { token }),
  };
}

/**
 * The token the tools use when a call names none (ruling P04-P12):
 *
 * 1. `TENDER_TOKEN`, if it is set. The contract is not asked.
 * 2. Else the network's USDC, if the contract lists it as enabled.
 * 3. Else the first enabled token the contract lists, which on the sandbox is `usdc.sandbox`.
 *
 * Rejects with a `ConfigError` that names `TENDER_TOKEN` when the contract lists no enabled token.
 */
export async function resolveDefaultToken(
  config: Pick<McpConfig, "network" | "token">,
  client: Pick<TenderClient, "getConfig">,
): Promise<string> {
  if (config.token !== undefined) return config.token;
  const enabled = (await client.getConfig()).tokens.filter((token) => token.enabled);
  const usdc = NETWORKS[config.network].usdc;
  if (usdc !== undefined && enabled.some((token) => token.token === usdc)) return usdc;
  const first = enabled[0];
  if (first === undefined) {
    throw new ConfigError("the contract lists no enabled token: set TENDER_TOKEN");
  }
  return first.token;
}

/**
 * What must never be printed: the private key, and the part of it after the curve's name, which a
 * library may quote on its own.
 */
export function secretsOf(config: Pick<McpConfig, "signer">): string[] {
  const { privateKey } = config.signer;
  return [privateKey, privateKey.slice(privateKey.indexOf(":") + 1)];
}

/**
 * A failure that stopped the server from starting, as the one line the bin prints. Every string in
 * `secrets` is cut out of it, a bearer token and a URL are replaced (`scrub`), and line breaks
 * become spaces, so that what a library puts into its message cannot print a key.
 */
export function describeFailure(error: unknown, secrets: readonly string[] = []): string {
  let text: string;
  if (error instanceof ConfigError) text = error.message;
  else if (error instanceof Error) text = `${error.name}: ${error.message}`;
  else text = String(error);
  return scrub(text, secrets).replace(/\s+/g, " ").trim();
}
