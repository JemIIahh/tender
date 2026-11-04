import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import type { NetworkId } from "@tender/shared";

/** The repository root. */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The variable that names another directory for the env files and `deployments/`. */
export const ENV_DIR_VARIABLE = "TENDER_ENV_DIR";

/**
 * The directory that holds `.env`, `.env.deploy.<network>` and `deployments/`: the repository root,
 * unless `TENDER_ENV_DIR` of `processEnv` names another one (a relative name is taken from the
 * working directory; a leading `~` is not expanded, so give an absolute path). A value that is
 * empty or only spaces counts as unset. A run that must not see the files of the repository, such
 * as a test's, points it at a directory of its own.
 *
 * The directory must exist: a missing one throws, naming the variable, instead of reading as a
 * directory with no files (a typo would otherwise show up as a missing key, much later).
 *
 * Every script reads its files from here when it is not told a `dir` of its own, and `pnpm serve`
 * reads the indexer's `deployments/` from here too. `pnpm deploy:testnet` and `scripts/keeper-key.ts`
 * write into it as well, full-access keys among it.
 */
export function envDir(
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const set = (processEnv[ENV_DIR_VARIABLE] ?? "").trim();
  if (set === "") return REPO_ROOT;
  const path = resolve(set);
  let isDirectory = false;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  if (!isDirectory) {
    throw new Error(
      `${ENV_DIR_VARIABLE} names ${path}, which is not an existing directory: create it, and ` +
        "give an absolute path (a leading ~ is not expanded)",
    );
  }
  return path;
}

/**
 * `deployments/` of the directory that `TENDER_ENV_DIR` names, or undefined when it is not set. The
 * indexer has its own default for the repository's `deployments/`, so `pnpm serve` hands it this
 * one only when the variable asks for another.
 */
export function deploymentsDirOverride(
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  return (processEnv[ENV_DIR_VARIABLE] ?? "").trim() === ""
    ? undefined
    : join(envDir(processEnv), "deployments");
}

/**
 * The variables of dotenv text. The trailing spaces and tabs of every line are dropped first:
 * node's `parseEnv` reads `KEY= ` (a blank value and a stray space) as a value that runs on into
 * the next line, so the next line's variable is gone and its text is KEY's value.
 */
export function parseEnvText(text: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parseEnv(text.replace(/[ \t]+$/gm, ""))).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/** The variables of a dotenv file; none if the file does not exist. */
export function readEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return parseEnvText(text);
}

/**
 * The variables of `.env` and `.env.deploy.<network>` in `dir` (default: `envDir()`, the
 * repository root unless `TENDER_ENV_DIR` says another), the network's file winning where both set
 * a key. A file that does not exist counts as empty. The process environment is not consulted for
 * the variables, only for `TENDER_ENV_DIR` when no `dir` is given.
 *
 * Throws if a key in `required` is missing or empty, naming every such key in one error. The error
 * holds no value, so it is safe to print. The result is typed so that each key in `required` is a
 * string, not `string | undefined`.
 */
export function loadEnv<const K extends string = never>(
  network: NetworkId,
  options: { required?: readonly K[]; dir?: string } = {},
): Record<K, string> & Record<string, string> {
  const dir = options.dir ?? envDir();
  const env = {
    ...readEnvFile(join(dir, ".env")),
    ...readEnvFile(join(dir, `.env.deploy.${network}`)),
  };
  const missing = (options.required ?? []).filter((key) => (env[key] ?? "").trim() === "");
  if (missing.length > 0) {
    throw new Error(
      `missing keys for network ${network}: ${missing.join(", ")} ` +
        `(set them in .env or .env.deploy.${network})`,
    );
  }
  return env as Record<K, string> & Record<string, string>;
}
