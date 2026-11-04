import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the private half of the 30 real seeds is kept. A seed's held-out checks are secret until
 * its task is judged (the scorecard then publishes them), and its `solution.txt` passes those
 * checks by construction, so a copy of it would win the task. Its weak answer is a plausible one
 * that is a few values off the solution, so it gives the solution away nearly as well. None of
 * them is in the repository: `seeds/<slug>/` holds the public half of a seed (`task.json`,
 * `brief.json`, `criteria.json`: the question), and
 *
 *   <private dir>/<slug>/heldout.json     the checks (a seed with `has_heldout` only)
 *   <private dir>/<slug>/solution.txt     a correct answer (every seed)
 *   <private dir>/<slug>/weak.txt         a plausible answer that misses the pass mark (every seed)
 *   <private dir>/<slug>/scenarios.json   spoiled copies of the solution, as edits of its text
 *                                         (a rubric seed only; they quote the solution)
 *   <private dir>/<slug>/known-wrong.json the solution with one rule broken, as a few wrong
 *                                         answers (a regex_cases or tests seed only)
 *
 * The tracked demo set in `scripts/demo-seeds/` and the swarm pack are the demos' own and public
 * in full, and need none of this.
 *
 * The directory is `$TENDER_SEEDS_PRIVATE_DIR` when that is set, else `seeds-private/` in the
 * repository, which git ignores.
 */
export const PRIVATE_DIR_VARIABLE = "TENDER_SEEDS_PRIVATE_DIR";

/** The repository root, found from this file so that it needs nothing else of the scripts. */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The directory the private files are in when nothing says otherwise. */
export const DEFAULT_PRIVATE_DIR = join(ROOT, "seeds-private");

/**
 * The private directory for `env`: its `TENDER_SEEDS_PRIVATE_DIR`, with a leading `~` taken as the
 * home directory (an env file is not read by a shell), else the default. A blank value counts as
 * unset. A relative path is taken from the current directory.
 */
export function privateDirOf(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const set = env[PRIVATE_DIR_VARIABLE]?.trim() ?? "";
  if (set === "") return DEFAULT_PRIVATE_DIR;
  if (set === "~") return homedir();
  return resolve(set.startsWith("~/") ? join(homedir(), set.slice(2)) : set);
}

/** `<privateDir>/<slug>/heldout.json`. */
export const heldoutFileOf = (privateDir: string, slug: string): string =>
  join(privateDir, slug, "heldout.json");

/** `<privateDir>/<slug>/solution.txt`. */
export const solutionFileOf = (privateDir: string, slug: string): string =>
  join(privateDir, slug, "solution.txt");

/** `<privateDir>/<slug>/weak.txt`. */
export const weakFileOf = (privateDir: string, slug: string): string =>
  join(privateDir, slug, "weak.txt");

/** `<privateDir>/<slug>/scenarios.json`. */
export const scenariosFileOf = (privateDir: string, slug: string): string =>
  join(privateDir, slug, "scenarios.json");

/** `<privateDir>/<slug>/known-wrong.json`. */
export const knownWrongFileOf = (privateDir: string, slug: string): string =>
  join(privateDir, slug, "known-wrong.json");

/** `seedsDir/<slug>/criteria.json`, as far as the private files depend on it; null if it is not there. */
function criteriaOf(
  seedsDir: string,
  slug: string,
): { has_heldout?: unknown; kind?: unknown } | null {
  const file = join(seedsDir, slug, "criteria.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** Whether the seed's `criteria.json` says it has a held-out part; false if it has none. */
const hasHeldout = (seedsDir: string, slug: string): boolean =>
  criteriaOf(seedsDir, slug)?.has_heldout === true;

/**
 * The seeds of `seedsDir`, from `slugs`, whose `criteria.json` says `has_heldout` and whose
 * `heldout.json` is not in `privateDir`. This only looks at which files exist; it does not read them.
 */
export function missingHeldouts(seedsDir: string, privateDir: string, slugs: string[]): string[] {
  return slugs.filter(
    (slug) => hasHeldout(seedsDir, slug) && !existsSync(heldoutFileOf(privateDir, slug)),
  );
}

/**
 * The seeds of `seedsDir`, from `slugs`, that lack a private file: the `solution.txt` and the
 * `weak.txt` of any seed with a `criteria.json`, its `heldout.json` when it has a held-out part, its `scenarios.json`
 * when it is a rubric seed, or its `known-wrong.json` when it is a regex_cases or tests seed. Empty
 * when the directory is complete.
 */
export function missingPrivateFiles(
  seedsDir: string,
  privateDir: string,
  slugs: string[],
): string[] {
  const noHeldout = new Set(missingHeldouts(seedsDir, privateDir, slugs));
  return slugs.filter((slug) => {
    const criteria = criteriaOf(seedsDir, slug);
    if (criteria === null) return false;
    return (
      noHeldout.has(slug) ||
      !existsSync(solutionFileOf(privateDir, slug)) ||
      !existsSync(weakFileOf(privateDir, slug)) ||
      (criteria.kind === "rubric" && !existsSync(scenariosFileOf(privateDir, slug))) ||
      ((criteria.kind === "regex_cases" || criteria.kind === "tests") &&
        !existsSync(knownWrongFileOf(privateDir, slug)))
    );
  });
}
