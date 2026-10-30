import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import type { NetworkId } from "@tender/shared";

/** The repository root, where the env files and `deployments/` live. */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

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
 * The variables of `.env` and `.env.deploy.<network>` in the repository root (or `dir`), the
 * network's file winning where both set a key. A file that does not exist counts as empty, and the
 * process environment is not consulted.
 *
 * Throws if a key in `required` is missing or empty, naming every such key in one error. The error
 * holds no value, so it is safe to print. The result is typed so that each key in `required` is a
 * string, not `string | undefined`.
 */
export function loadEnv<const K extends string = never>(
  network: NetworkId,
  options: { required?: readonly K[]; dir?: string } = {},
): Record<K, string> & Record<string, string> {
  const dir = options.dir ?? REPO_ROOT;
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
