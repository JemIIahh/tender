import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the held-out checks of the seeds are kept. A seed's checks are secret until its task is
 * judged (the scorecard then publishes them), so they are not in the repository: `seeds/<slug>/`
 * holds the public half of a seed, and `<private dir>/<slug>/heldout.json` the checks. The swarm
 * pack's are in the same directory under `swarm-research-pack/`: `parent/heldout.json` and
 * `children/<slug>/heldout.json`.
 *
 * The directory is `$TENDER_SEEDS_PRIVATE_DIR` when that is set, else `seeds-private/` in the
 * repository, which git ignores.
 */
export const HELDOUT_DIR_VARIABLE = "TENDER_SEEDS_PRIVATE_DIR";

/** The repository root, found from this file so that it needs nothing else of the scripts. */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The directory the checks are in when nothing says otherwise. */
export const DEFAULT_HELDOUT_DIR = join(ROOT, "seeds-private");

/**
 * The directory of the held-out checks for `env`: its `TENDER_SEEDS_PRIVATE_DIR`, with a leading
 * `~` taken as the home directory (an env file is not read by a shell), else the default. A blank
 * value counts as unset. A relative path is taken from the current directory.
 */
export function heldoutDirOf(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const set = env[HELDOUT_DIR_VARIABLE]?.trim() ?? "";
  if (set === "") return DEFAULT_HELDOUT_DIR;
  if (set === "~") return homedir();
  return resolve(set.startsWith("~/") ? join(homedir(), set.slice(2)) : set);
}

/** The swarm pack's part of the directory: `parent/` and `children/` of the pack are under it. */
export const swarmPackHeldoutDirOf = (heldoutDir: string = heldoutDirOf()): string =>
  join(heldoutDir, "swarm-research-pack");

/** `<heldoutDir>/<slug>/heldout.json`. */
export const heldoutFileOf = (heldoutDir: string, slug: string): string =>
  join(heldoutDir, slug, "heldout.json");

/**
 * The seeds of `seedsDir` that have a held-out part (their `criteria.json` says `has_heldout`) and
 * whose `heldout.json` is not in `heldoutDir`, by slug. Empty when the directory is complete. This
 * only looks at which files exist: it does not read the checks.
 */
export function missingHeldouts(seedsDir: string, heldoutDir: string, slugs: string[]): string[] {
  return slugs.filter((slug) => {
    const criteria = join(seedsDir, slug, "criteria.json");
    if (!existsSync(criteria)) return false;
    const { has_heldout: has } = JSON.parse(readFileSync(criteria, "utf8")) as {
      has_heldout?: unknown;
    };
    return has === true && !existsSync(heldoutFileOf(heldoutDir, slug));
  });
}
