import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "@tender/shared";
import type { Solver } from "../types";

// The scripted solvers read their answers from the seed tasks (seeds/<slug>/): `solution.txt` is
// the answer that wins, `weak.txt` the one that is meant to lose. They need no key, no network and
// no model, which is what lets the local demo run on a clean machine.

/** Whether `error` is a file system error with this code, such as `ENOENT`. */
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/**
 * The slug of each seed in `seedsDir`, by the hash its task has on chain: `sha256Hex` of the
 * canonical bytes of its `brief.json`, which is what the poster uploads and what `post_task` pins.
 * A folder with no `brief.json` is not a seed, and neither is a file (the folder also holds a
 * README and the seeds' own test).
 *
 * The map is built from the files and nothing else. The solver looks a task up by the hash the
 * chain holds for it (P05-P8), never by hashing the brief the API sent back: that one has been
 * through a schema, which may drop or default a key, and then it would no longer hash to what was
 * posted.
 */
function indexSeeds(seedsDir: string): Map<string, string> {
  const slugs = readdirSync(seedsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const bySlug = new Map<string, string>();
  for (const slug of slugs) {
    let text: string;
    try {
      text = readFileSync(join(seedsDir, slug, "brief.json"), "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    try {
      bySlug.set(sha256Hex(canonicalJson(JSON.parse(text))), slug);
    } catch (error) {
      // A seed that cannot be hashed is a mistake in the repository, and an agent that quietly
      // answers fewer tasks than it should is the worse way to find it.
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`seed ${slug}: brief.json cannot be hashed (${why})`);
    }
  }
  return bySlug;
}

/**
 * A solver that answers a task from the file `file` of its seed's folder, if the task's brief hash
 * is one of the seeds' (see `indexSeeds`), and returns null for any other task, and for a seed
 * that has no such file (not every seed has a weak answer). It reads `seedsDir` when it is made,
 * so a directory that is not there fails now and not on the first task, and it reads the answer
 * again each time it is asked, so the solver holds no copy that a later edit could leave stale.
 *
 * `createOfflineSolver` and `createWeakSolver` are this with their file; nothing else needs it.
 */
export function createSeedSolver(o: {
  name: string;
  seedsDir: string;
  file: "solution.txt" | "weak.txt";
}): Solver {
  const { name, seedsDir, file } = o;
  const bySlug = indexSeeds(seedsDir);

  return {
    name,
    scripted: true,
    async solve(ctx) {
      const slug = bySlug.get(ctx.task.brief_hash);
      if (slug === undefined) return null;
      try {
        // A plain `Uint8Array`, not the `Buffer` the file system hands out.
        return new Uint8Array(await readFile(join(seedsDir, slug, file)));
      } catch (error) {
        if (hasCode(error, "ENOENT")) return null;
        throw error;
      }
    },
  };
}

/**
 * The solver that gets every seed right: it answers a task whose brief is one of `seedsDir`'s
 * with that seed's `solution.txt`, byte for byte, and any other task with null. `scripted`.
 */
export function createOfflineSolver(seedsDir: string): Solver {
  return createSeedSolver({ name: "offline", seedsDir, file: "solution.txt" });
}
