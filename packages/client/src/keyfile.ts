import { execFile } from "node:child_process";
import { chmod, mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { AccountIdSchema, implicitAccountOf, NETWORKS, type NetworkId } from "@tender/shared";
import { KeyPair, type KeyPairString } from "near-api-js";

// An agent's key file, as `pnpm agent:init` makes it (scripts/agent.ts) and as the MCP server's
// `connect_to_tender` makes it too: `<name>.json`, mode 0600, in a directory of mode 0700, which
// holds the private key and is the only place that does. Nothing here prints, logs or puts a key in
// an error.
//
// THE KEY-DIRECTORY GUARD. A key must never be where a `git add` can reach, so a directory inside
// the repository is refused unless git says it ignores the key files in it (`.tender/` is ignored,
// which is where they go by default). The repository and the directory are both settled first, so
// that a link, a different spelling of the case on a file system that ignores it, and a name that
// only starts with `..` cannot walk round the check; if git cannot be asked, the answer is no.

/** An agent's name: the key file's name, and the name in its profile. */
export const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** What a delegate key's file is called after the agent's name: `<name>.delegate.json`. */
export const DELEGATE_SUFFIX = ".delegate.json";

/** What a key file holds. `account` is absent until the agent's account is known. */
export interface AgentKeyFile {
  version: 1;
  name: string;
  network: NetworkId;
  account?: string;
  publicKey: string;
  privateKey: string;
}

/**
 * A directory the keys may not be in: inside the repository where git does not ignore them, or one
 * that other users can enter. The command line words it as a fault of its flags.
 */
export class KeyDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyDirError";
  }
}

const isNetwork = (value: string): value is NetworkId => Object.hasOwn(NETWORKS, value);

const run = promisify(execFile);

/**
 * `path` with every symlink followed and the case of every part that exists as the disk spells it
 * (`realpath` does both, on macOS too); a part that does not exist yet stays as it was written.
 */
async function settle(path: string): Promise<string> {
  const missing: string[] = [];
  for (let at = path; ; at = dirname(at)) {
    try {
      return join(await realpath(at), ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "ENOENT" && code !== "ENOTDIR") || dirname(at) === at) throw error;
      missing.push(basename(at));
    }
  }
}

/** Whether the file system of `path` takes `/Users/x` and `/users/X` for one place. */
async function ignoresCase(path: string): Promise<boolean> {
  const swapped = path.replace(/[a-z]/gi, (c) =>
    c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
  );
  if (swapped === path) return false;
  try {
    const [a, b] = await Promise.all([stat(path), stat(swapped)]);
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

/** Whether `inner` is `outer` or below it, by name, in the case-folded spelling if `fold` says so. */
function isUnder(outer: string, inner: string, fold: boolean): boolean {
  const way = fold ? relative(outer.toLowerCase(), inner.toLowerCase()) : relative(outer, inner);
  // A name that merely starts with two dots (`..keys`) is below, and only `..` and `../...` is not.
  return way !== ".." && !way.startsWith("../") && !isAbsolute(way);
}

/** Whether git ignores `file`, which is in the repository. Anything but a plain yes is a no. */
async function gitIgnores(root: string, file: string): Promise<boolean> {
  try {
    await run("git", ["-C", root, "check-ignore", "-q", "--", relative(root, file)], {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * `dir`, the directory the keys are in, with its symlinks followed, once the guard has passed it
 * (see the top of this file): outside `repoRoot`, or inside it where git ignores the key files of
 * `name`. `name` is the agent whose file will be in it, when it is known. Throws `KeyDirError`.
 */
export async function keyDirOf(dir: string, repoRoot: string, name = "agent"): Promise<string> {
  const path = await settle(resolve(dir));
  const root = await settle(repoRoot);
  if (!isUnder(root, path, await ignoresCase(root))) return path;
  // A name that is not an agent's (a flag not checked yet) is probed as "agent": it must not lead out.
  const stem = AGENT_NAME.test(name) ? name : "agent";
  const files = [`${stem}.json`, `${stem}.json.tmp`, `${stem}${DELEGATE_SUFFIX}`].map((file) =>
    join(path, file),
  );
  const ignored = await Promise.all(files.map((file) => gitIgnores(root, file)));
  if (!ignored.every(Boolean)) {
    throw new KeyDirError(
      "a key directory inside the repository must be one that git ignores (.tender/ is), so that " +
        `no key can be committed; git does not say it ignores ${path}`,
    );
  }
  return path;
}

/**
 * Makes `dir` for keys, mode 0700, or checks the one that is there. The mode of a directory is
 * changed only when this has just made it. One that was there already is the user's (`--dir ~` is a
 * mistake that would have changed their home), so it is used as it is if only its owner can enter
 * it, and refused (`KeyDirError`) if others can.
 */
export async function prepareKeyDir(dir: string): Promise<void> {
  const made = await mkdir(dir, { recursive: true, mode: 0o700 });
  if (made !== undefined) {
    await chmod(dir, 0o700);
  } else if (((await stat(dir)).mode & 0o077) !== 0) {
    throw new KeyDirError(
      `${dir} can be entered by other users of this machine; use a directory of your own that ` +
        "only you can enter (mode 700), or one that does not exist yet",
    );
  }
}

/** Where the key file of agent `name` is in `dir`. */
export const agentKeyPath = (dir: string, name: string) => join(dir, `${name}.json`);

/**
 * Writes a key file whole, mode 0600, synced: a crash leaves the old file or the new, not half.
 * Without `replace` it fails with `EEXIST` if the file exists: a key is never replaced that way.
 */
export async function writeKeyFile(path: string, key: object, replace: boolean): Promise<void> {
  const text = `${JSON.stringify(key, null, 2)}\n`;
  if (!replace) {
    // `wx`: fails if the file exists. A key is never replaced by this path.
    const file = await open(path, "wx", 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    return;
  }
  const temporary = `${path}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

/**
 * The key file of `name` in `dir`. Throws, without the key, if it is missing (with the command that
 * makes one), readable by others, not a key file, or if its private key is not the one its public
 * key says.
 */
export async function readAgentKeyFile(dir: string, name: string): Promise<AgentKeyFile> {
  const path = agentKeyPath(dir, name);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no key for agent ${name} at ${path}: run pnpm agent:init --name ${name}`);
    }
    throw error;
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(
      `${path} can be read by other users of this machine: run chmod 600 on it first ` +
        "(and treat the key as exposed if others could have read it)",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${path} is not a key file made by pnpm agent:init`);
  }
  const bad = () => new Error(`${path} is not a key file made by pnpm agent:init`);
  if (typeof parsed !== "object" || parsed === null) throw bad();
  const f = parsed as Record<string, unknown>;
  if (
    f.version !== 1 ||
    typeof f.name !== "string" ||
    typeof f.network !== "string" ||
    !isNetwork(f.network) ||
    typeof f.publicKey !== "string" ||
    typeof f.privateKey !== "string" ||
    (f.account !== undefined && !AccountIdSchema.safeParse(f.account).success)
  ) {
    throw bad();
  }
  let derived: string;
  try {
    derived = KeyPair.fromString(f.privateKey as KeyPairString)
      .getPublicKey()
      .toString();
  } catch {
    throw bad();
  }
  if (derived !== f.publicKey) {
    throw new Error(`the private key in ${path} is not the one its public key names`);
  }
  return {
    version: 1,
    name: f.name,
    network: f.network,
    ...(typeof f.account === "string" && { account: f.account }),
    publicKey: f.publicKey,
    privateKey: f.privateKey,
  };
}

/** Whether the key file of `name` is in `dir`. */
export async function hasAgentKeyFile(dir: string, name: string): Promise<boolean> {
  try {
    await stat(agentKeyPath(dir, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Makes an ed25519 key for agent `name` and writes it to its file in `dir`, which the guard has
 * passed and `prepareKeyDir` has made. Never replaces a file: one that is there already is an error
 * that says so. Returns where it is and its PUBLIC half; the private half is in the file only.
 */
export async function makeAgentKeyFile(options: {
  dir: string;
  name: string;
  network: NetworkId;
  account?: string;
}): Promise<{ path: string; publicKey: string }> {
  const pair = KeyPair.fromRandom("ed25519");
  const publicKey = pair.getPublicKey().toString();
  const path = agentKeyPath(options.dir, options.name);
  try {
    await writeKeyFile(
      path,
      {
        version: 1,
        name: options.name,
        network: options.network,
        ...(options.account !== undefined && { account: options.account }),
        publicKey,
        privateKey: pair.toString(),
      } satisfies AgentKeyFile,
      false,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `agent ${options.name} has a key at ${path} already, and this command never replaces a key: ` +
          "choose another --name, or move that file away if you are sure",
      );
    }
    throw error;
  }
  return { path, publicKey };
}

/** A key file that is there for another network or another account: the caller asks for another name. */
export class KeyInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyInUseError";
  }
}

/**
 * The key that agent `name` connects `account` on `network` with, in `dir` (which the guard has
 * passed): the one its file holds, if the file is for that network and for that account or for
 * none yet, or if `account` is the implicit account of the file's own key (the file is then
 * rewritten to name it); else, if `mayMake`, a new one made now (`prepareKeyDir`, then `makeAgentKeyFile` with the
 * account); else null. A file for another network or another account is a `KeyInUseError`, and is
 * never replaced. `pnpm agent:connect` and the MCP server's `connect_to_tender` both choose the key
 * here, so the two attach the same key for the same name.
 */
export async function agentKeyFor(options: {
  dir: string;
  name: string;
  network: NetworkId;
  account: string;
  mayMake: boolean;
}): Promise<{ publicKey: string; path: string; made: boolean } | null> {
  const { dir, name, network, account } = options;
  const path = agentKeyPath(dir, name);
  if (await hasAgentKeyFile(dir, name)) {
    const file = await readAgentKeyFile(dir, name);
    if (file.network !== network) {
      throw new KeyInUseError(
        `agent ${name} has a key for ${file.network} at ${path}, and this code is for ${network}: ` +
          "choose another name for the agent",
      );
    }
    if (file.account !== undefined && file.account !== account) {
      // The implicit account of the file's own key is always that key's: the owner chose it for
      // the agent ("a separate account"), so the file now says so, for the commands that follow.
      if (account === implicitAccountOf(file.publicKey)) {
        await writeKeyFile(path, { ...file, account }, true);
        return { publicKey: file.publicKey, path, made: false };
      }
      throw new KeyInUseError(
        `the key file of agent ${name} is for ${file.account}, not ${account}: choose another ` +
          "name for the agent",
      );
    }
    return { publicKey: file.publicKey, path, made: false };
  }
  if (!options.mayMake) return null;
  await prepareKeyDir(dir);
  const made = await makeAgentKeyFile({ dir, name, network, account });
  return { ...made, made: true };
}
