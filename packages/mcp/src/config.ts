import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Signer, TenderClient } from "@tender/client";
import {
  AccountIdSchema,
  canonicalBase,
  NETWORKS,
  type NetworkId,
  type TenderApi,
} from "@tender/shared";
import { KeyPair, type KeyPairString } from "near-api-js";
import { urlCredentials } from "./secrets";
import { DRAFTS_DIR, defaultStateDir, defaultStateRoot } from "./state";
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
  /**
   * Where the Tender API is, as `canonicalBase` writes it: the scheme and the host in lower case, and
   * no trailing slash and no `/v1`. It is also whom the sign-in is signed for.
   */
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
   * The one directory that `commit_result` may read a file from (P04-R1): its real path, looked up
   * once at start-up and never again (P04-R3), of a directory that only the user can write to
   * (P04-R2; see `pinFilesDir`). If the path as it was written had a link in it, this is where the
   * link led. Not set means that no file is read, and a result is given as text.
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
const AN_API_URL =
  "an https URL, or an http URL to localhost, 127.0.0.1 or [::1], without a user name, password, " +
  "query or fragment";

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
 * another address in 127.0.0.0/8 is refused rather than guessed at. They are the three that
 * `ApiClient` takes, and a test holds the two to the same answer.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The API's base URL as the API client reads it: `canonicalBase` of `value`, which is what the
 * client calls and whom its sign-in is signed for, so a value it would refuse is refused here, at
 * start-up, with a message that names the variable. `canonicalBase` refuses a user name or a
 * password, a query, a fragment, a host with a dot at its end and the like; this adds the rule that
 * plain `http:` goes only to this machine. The reason `canonicalBase` gives is not passed on.
 */
function asApiUrl(value: string): string | undefined {
  try {
    const base = canonicalBase(value);
    const { protocol, hostname } = new URL(base);
    if (protocol === "https:") return base;
    return protocol === "http:" && LOOPBACK_HOSTS.has(hostname) ? base : undefined;
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

// The messages about TENDER_FILES_DIR's owner, mode and place name the variable and never a path:
// which directory is at fault is for the user to find.
const FILES_DIR_MISSING = "TENDER_FILES_DIR must be a directory that exists";
const FILES_DIR_HOME =
  "TENDER_FILES_DIR must be a folder of its own for the files you give agents: not your home " +
  "directory, and not a directory that holds it (/, /home, /Users and so on)";
const FILES_DIR_SHARED =
  "TENDER_FILES_DIR must be a directory that only you can write to: it must be owned by you, and " +
  "it and every directory above it, up to your home directory (or up to / when it is not under " +
  "your home), must be owned by you or by root and not writable by a group or by others";

/** Whether `path` is `dir` or lies under it, going by how the two are written. */
function isWithin(dir: string, path: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * Whether `dir`, a real path, is the user's home directory or one that holds it (`/`, `/home`,
 * `/Users`, and so on up from the home). What the server may read can be committed and then
 * published, and a home directory is full of what is not meant for that. The home is looked up here
 * as well; one that is not there (a home that is gone, a test's) counts as it is written. A home
 * that is not an absolute path is not a place, and holds nothing.
 */
function holdsHome(dir: string, home: string): boolean {
  if (!isAbsolute(home)) return false;
  let where: string;
  try {
    where = realpathSync.native(home);
  } catch {
    where = resolve(home);
  }
  return isWithin(dir, where);
}

/** How many links one path may lead through. The kernels give up on a loop at about this many. */
const MAX_LINKS = 32;

/** A path followed to the place it leads to. */
interface Way {
  /** Where the path leads: absolute, with no link, `.` or `..` in it. */
  real: string;
  /** Every name that was looked up on the way, as the path to it. The links followed are among them. */
  entries: string[];
}

/**
 * Where the absolute `path` leads, found the way the kernel finds it: from the root, one name at a
 * time. A link is read where it stands and its target is followed in place (from the root when the
 * target is absolute, else from the directory the link is in), and `..` goes up from the place that
 * the names before it lead to, which is not where they are written to be when one of them is a link.
 * A path that leads nowhere (a name that is not there, a loop, more than `MAX_LINKS` links) gets
 * nothing.
 */
function wayTo(path: string): Way | undefined {
  const entries: string[] = [];
  // The names still to look up, the next one last: the target of a link goes in front of them.
  const names = path.split(sep).reverse();
  let real: string = sep;
  let links = 0;
  for (let name = names.pop(); name !== undefined; name = names.pop()) {
    if (name === "" || name === ".") continue;
    if (name === "..") {
      real = dirname(real);
      continue;
    }
    const entry = join(real, name);
    entries.push(entry);
    let found: Stats;
    try {
      found = lstatSync(entry);
    } catch {
      return undefined;
    }
    if (!found.isSymbolicLink()) {
      real = entry;
      continue;
    }
    links += 1;
    if (links > MAX_LINKS) return undefined;
    let target: string;
    try {
      target = readlinkSync(entry);
    } catch {
      return undefined;
    }
    if (isAbsolute(target)) real = sep;
    names.push(...target.split(sep).reverse());
  }
  return { real, entries };
}

/**
 * What is wrong with the way to a directory, if anything. `paths` lists the directory itself, and
 * then the others to look at: each directory in which a name is looked up on the way to it, and each
 * link on the way. A link is judged as a link, since `lstat` does not follow it: whoever owns it can
 * point it elsewhere, so it must be the user's or root's.
 */
function faultIn(paths: readonly string[], me: number): "missing" | "shared" | undefined {
  for (const [at, path] of paths.entries()) {
    let found: Stats;
    try {
      found = lstatSync(path);
    } catch {
      return at === 0 ? "missing" : "shared";
    }
    const ours = found.uid === me;
    const root = found.uid === 0;
    if (found.isSymbolicLink()) {
      if (!ours && !root) return "shared";
      continue;
    }
    if (!found.isDirectory()) return at === 0 ? "missing" : "shared";
    // The directory itself is the user's. One above it may be root's, who can change anything anyway.
    if (!(ours || (root && at > 0))) return "shared";
    if ((found.mode & 0o022) !== 0) return "shared";
  }
  return undefined;
}

/**
 * The real path of `dir`, if `dir` is a directory that only the user can write to; that real path is
 * what the server keeps, and reads files from (ruling P04-R3). It is looked up here, once. A link in
 * the way that the user wrote can be pointed elsewhere by whoever can write where it is, so the
 * server reads from the place the link led to at start-up and never follows the link again.
 *
 * What it must be (ruling P04-R2). `commit_result` looks a path up and then opens the file, and
 * whoever can write in the directory can swap a name for a link in between, even back and forth
 * between the server's looks. The checks in `readLocalFile` narrow that and cannot close it
 * everywhere, so the directory must be the user's alone: owned by the user, and neither it nor any
 * directory on the way to it writable by a group or by others (`mode & 0o022`, the sticky bit or
 * not). The directories above it may be root's, who can change anything anyway. So a directory under
 * /tmp, which anybody can write in, is refused, and so is one in the user's home that was made with
 * a group-writable mode.
 *
 * The way to it is every directory in which a name is looked up, and `dir` is followed name by name
 * (`wayTo`) to find them. That is not the written path and the real path only: a link leads to a
 * target that is itself a path, and so may lead through another link, and a directory in which that
 * second link is looked up is not on either of the two. Whoever can write there can point the link
 * elsewhere, and the directory with it. So the directories on the way to every link's target are
 * looked at as well, and a link on the way must be the user's or root's.
 *
 * When the directory is under the user's home directory, the way stops there: the names that lead
 * to the home directory, and the directories above it, are not looked at, since where the home
 * directory is on the machine is not for this check to judge. (A name that is looked up beside
 * them, such as the target of a link, is looked at.) When it is not under the home, nothing is
 * left out, up to the root.
 *
 * Last, the real path that the kernel gives for `dir` (`realpath`, as `readLocalFile` asks it of
 * every file) must be the one that was followed. If not, something changed while it was looked at,
 * and the directory is refused.
 *
 * It must also be a folder for the agent's files and not the user's home directory, nor a directory
 * that holds it (`/`, `/home`, `/Users`): what the server may read it can commit, and `reveal_result`
 * then publishes it, and a home directory holds the user's keys and credentials. The real path is
 * what counts, so a link to the home is refused too. This is looked at first, before the owner and
 * the mode, so that `/` is told this and not that it is not the user's.
 *
 * Where the platform has no user ids (Windows) there is no owner to compare, and the way is not
 * looked at; the real path is kept all the same. A directory that is not there is refused: it could
 * be made by anyone later.
 */
function pinFilesDir(dir: string, home: string): string {
  const me = process.getuid?.();
  let followed: string | undefined;
  if (me !== undefined) {
    const way = wayTo(dir);
    if (way === undefined) throw new ConfigError(FILES_DIR_MISSING);
    if (holdsHome(way.real, home)) throw new ConfigError(FILES_DIR_HOME);
    // The top, if the directory is under the home directory: the way to the home is not looked at.
    const homeReal = isAbsolute(home) ? wayTo(home)?.real : undefined;
    const top = homeReal !== undefined && isWithin(homeReal, way.real) ? homeReal : undefined;
    const looked = new Set<string>();
    for (const entry of way.entries) {
      if (top !== undefined && isWithin(entry, top)) continue;
      looked.add(dirname(entry));
      looked.add(entry);
    }
    const fault = faultIn([way.real, ...looked], me);
    if (fault === "missing") throw new ConfigError(FILES_DIR_MISSING);
    if (fault === "shared") throw new ConfigError(FILES_DIR_SHARED);
    followed = way.real;
  }
  let pinned: string;
  let again: string;
  try {
    pinned = realpathSync.native(dir);
    again = followed === undefined ? pinned : realpathSync.native(followed);
  } catch {
    throw new ConfigError(FILES_DIR_MISSING);
  }
  if (again !== pinned) throw new ConfigError(FILES_DIR_SHARED);
  // The place the kernel gives is what is kept: it is judged as well (the only look where there are
  // no user ids to follow the way with).
  if (holdsHome(pinned, home)) throw new ConfigError(FILES_DIR_HOME);
  return pinned;
}

/** The real path of `place`, or the path as it is written when it is not there (yet). */
function placeAt(place: string): string {
  try {
    return realpathSync.native(place);
  } catch {
    return resolve(place);
  }
}

/**
 * What to tell the operator about a `filesDir` that nothing can be read from, if it is one. The
 * write tools read no file from this server's state directory or its drafts folder, from
 * `~/.tender` (the root of the default state directories of every account), or from below a folder
 * named `drafts`, in any letter case (`keptOut`). A files directory inside one of those starts all
 * the same, and then every `file_path` is refused with an answer that does not say why, so one line
 * says it here, once. It is a warning and not a refusal: the server is useful without files, and the
 * user may have set it up on purpose. (The home directory and the directories that hold it never get
 * here: `readConfig` refuses them.)
 *
 * `filesDir` is a real path. The places are looked up here too, as `keptOut` looks them up on each
 * call, and one that is not there yet counts as it is written. The line names the variable and the
 * rule, never a path.
 */
export function filesDirWarning(
  config: Pick<McpConfig, "filesDir" | "stateDir">,
  home: string = homedir(),
): string | undefined {
  const { filesDir, stateDir } = config;
  if (filesDir === undefined) return undefined;
  const inside = (place: string) => isWithin(placeAt(place), filesDir);
  let why: string | undefined;
  if (inside(stateDir) || inside(join(stateDir, DRAFTS_DIR))) {
    why = "is inside this server's state directory";
  } else if (isAbsolute(home) && inside(defaultStateRoot(home))) {
    why = "is inside ~/.tender, where Tender keeps the state of every account";
  } else if (filesDir.split(sep).some((name) => name.toLowerCase() === DRAFTS_DIR)) {
    why = "has a folder named drafts on its path, which is the folder of every state directory";
  }
  if (why === undefined) return undefined;
  return (
    `TENDER_FILES_DIR ${why}, so commit_result would refuse every file_path: nothing can be read ` +
    "from it. Use a folder of its own, outside any state directory and ~/.tender and with no " +
    "folder named drafts on its path"
  );
}

/**
 * The server's settings from `env`, checked.
 *
 * - Required: `TENDER_NETWORK`, `TENDER_CONTRACT`, `TENDER_API_URL`, `TENDER_ACCOUNT` and
 *   `TENDER_PRIVATE_KEY`; and `NEAR_RPC_URL` on the sandbox, which has no RPC of its own. The other
 *   networks use theirs unless `NEAR_RPC_URL` names another. `TENDER_API_URL` is `https:`, or
 *   `http:` to this machine only, since the API is signed in to with a bearer token, and it is
 *   what `canonicalBase` takes (no user name, query or fragment), as the API client reads it.
 * - Optional: `TENDER_STATE_DIR` (default: `defaultStateDir`, under `home`; a leading `~` is
 *   expanded to `home`), `TENDER_FILES_DIR` (an absolute path, `~` expanded likewise, of a
 *   directory that only the user can write to, and that is neither the home nor a directory that
 *   holds it: see `pinFilesDir`, which looks it up once and gives its real path; default: none, and
 *   then `commit_result` takes no file), `TENDER_JUDGE_ACCOUNT` and `TENDER_TOKEN`.
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
    if (configuredFilesDir !== undefined) {
      filesDir = pinFilesDir(absoluteFilesDir(configuredFilesDir, home), home);
    }
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
 * Refuses to go on with an API that serves another deployment than the environment names: the
 * network and the contract in the API's `/health` are compared with `TENDER_NETWORK` and
 * `TENDER_CONTRACT`. Without this, a server pointed at the wrong API commits to tasks that the
 * contract it signs for does not have, and each refusal retires a draft that then blocks its task
 * number once the setting is put right. The refusal names the three variables and not their values;
 * what the API says of itself is a contract (an account id, by the schema) and a network that is
 * shown only if it is one of Tender's.
 *
 * An API that cannot answer is not a mismatch, and does not keep the server from starting: the
 * server's tools answer for the API themselves, and `warn` is told, in one line, that the check
 * did not happen.
 */
export async function checkApiDeployment(
  config: Pick<McpConfig, "network" | "contractId">,
  api: Pick<TenderApi, "health">,
  warn: (line: string) => void,
): Promise<void> {
  let served: Awaited<ReturnType<TenderApi["health"]>>;
  try {
    served = await api.health();
  } catch (error) {
    warn(
      `could not ask the API which network and contract it serves (${describeFailure(error)}), ` +
        "so TENDER_API_URL was not checked against TENDER_NETWORK and TENDER_CONTRACT",
    );
    return;
  }
  if (served.network === config.network && served.contract === config.contractId) return;
  const network = Object.hasOwn(NETWORKS, served.network) ? served.network : "an unknown network";
  throw new ConfigError(
    `TENDER_API_URL is an API for the contract ${served.contract} on ${network}, which is not the ` +
      "deployment that TENDER_CONTRACT and TENDER_NETWORK name: make the three agree",
  );
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
 * What must never be printed or published: the private key, the part of it after the curve's name,
 * which a library may quote on its own, and the credentials in the RPC URL (a password, a key in
 * its query, a token in its path), if it has any: see `urlCredentials`.
 */
export function secretsOf(config: Pick<McpConfig, "signer" | "rpcUrl">): string[] {
  const { privateKey } = config.signer;
  return [
    privateKey,
    privateKey.slice(privateKey.indexOf(":") + 1),
    ...(config.rpcUrl === undefined ? [] : urlCredentials(config.rpcUrl)),
  ];
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
