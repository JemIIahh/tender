import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Brief, canonicalJson, sha256Hex } from "@tender/shared";
import { afterEach, expect, test } from "vitest";
import {
  missingPrivateFiles,
  privateDirOf,
  solutionFileOf,
  weakFileOf,
} from "../../../scripts/lib/private-dir";
import { createOfflineSolver, createWeakSolver } from "../src/index";
import { BRIEF, contextOf, taskSpec } from "./helpers";

// The scripted solvers answer from seed folders. Most tests build a seeds directory of their own
// in a temp folder, so that each rule is shown on a seed that exists for it; the last one runs
// both solvers over the repository's real seeds, whose solutions and weak answers are not in the
// repository but in the private directory (seeds/README.md), and is skipped where that has none.

const REAL_SEEDS = join(import.meta.dirname, "../../../seeds");

const ALPHA: Brief = { ...BRIEF, title: "Alpha" };
const BETA: Brief = { ...BRIEF, title: "Beta" };
const ALPHA_HASH = sha256Hex(canonicalJson(ALPHA));
const BETA_HASH = sha256Hex(canonicalJson(BETA));

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A seed folder: `brief.json` as text, and whichever answer files the seed has. */
function seed(
  seedsDir: string,
  slug: string,
  files: { "brief.json": string; "solution.txt"?: string; "weak.txt"?: string },
): void {
  mkdirSync(join(seedsDir, slug), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(seedsDir, slug, name), text);
}

/**
 * A seeds directory with two seeds, and the clutter the real one has. `alpha`'s brief is written
 * the way an editor would: keys in a different order, indented, with a final newline, so its hash
 * is the hash of its canonical form and not of its text. `beta` has no weak answer.
 */
function seedsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tender-seeds-"));
  dirs.push(dir);
  const reversed = Object.fromEntries(Object.entries(ALPHA).reverse());
  seed(dir, "alpha", {
    "brief.json": `${JSON.stringify(reversed, null, 2)}\n`,
    "solution.txt": "ALPHA SOLUTION",
    "weak.txt": "ALPHA WEAK",
  });
  seed(dir, "beta", { "brief.json": JSON.stringify(BETA), "solution.txt": "BETA SOLUTION" });
  mkdirSync(join(dir, "notes"));
  writeFileSync(join(dir, "README.md"), "Held-out checks are single-use.\n");
  return dir;
}

const text = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : new TextDecoder().decode(bytes);

/** What the chain holds for a task whose brief hashes to `briefHash`. */
const taskOf = (briefHash: string) => contextOf(taskSpec({ id: 1, briefHash }));

test("offline_answers_a_seed_with_its_solution", async () => {
  const solver = createOfflineSolver(seedsDir());

  expect(text(await solver.solve(taskOf(ALPHA_HASH)))).toBe("ALPHA SOLUTION");
  expect(text(await solver.solve(taskOf(BETA_HASH)))).toBe("BETA SOLUTION");
});

test("offline_returns_null_for_a_brief_it_does_not_know", async () => {
  const dir = seedsDir();
  const solver = createOfflineSolver(dir);

  expect(await solver.solve(taskOf(sha256Hex("some other brief")))).toBeNull();
  // The hash of the brief's text as it sits in the file is not the brief's hash.
  const file = readFileSync(join(dir, "alpha", "brief.json"), "utf8");
  expect(await solver.solve(taskOf(sha256Hex(file)))).toBeNull();
});

test("the_answer_is_the_file_byte_for_byte_in_a_plain_uint8array", async () => {
  const dir = seedsDir();
  const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x0a, 0x00, 0xff]);
  writeFileSync(join(dir, "alpha", "solution.txt"), bytes);

  const answer = await createOfflineSolver(dir).solve(taskOf(ALPHA_HASH));

  expect(answer).toEqual(bytes);
  expect(answer?.constructor).toBe(Uint8Array);
});

test("weak_answers_with_the_weak_file_and_has_none_for_a_seed_without_one", async () => {
  const solver = createWeakSolver(seedsDir());

  expect(text(await solver.solve(taskOf(ALPHA_HASH)))).toBe("ALPHA WEAK");
  // beta has a solution and no weak answer: the weak agent sits that one out.
  expect(await solver.solve(taskOf(BETA_HASH))).toBeNull();
  expect(await solver.solve(taskOf(sha256Hex("some other brief")))).toBeNull();
});

test("both_solvers_are_scripted_and_say_which_they_are", () => {
  const dir = seedsDir();

  expect(createOfflineSolver(dir)).toMatchObject({ name: "offline", scripted: true });
  expect(createWeakSolver(dir)).toMatchObject({ name: "weak", scripted: true });
});

test("keys_on_the_on_chain_brief_hash_and_not_on_the_brief_the_api_sent", async () => {
  const solver = createOfflineSolver(seedsDir());

  // The API's brief has been through a schema, which may drop or default a key, so it can differ
  // from what was posted. The hash the chain holds is what names the task.
  const sent = { ...taskOf(ALPHA_HASH), brief: { ...ALPHA, title: "Alpha, as the API parsed it" } };
  expect(text(await solver.solve(sent))).toBe("ALPHA SOLUTION");

  // And the other way: a brief that is alpha's to the letter, under a hash that is not.
  const forged = { ...taskOf(sha256Hex("not alpha")), brief: ALPHA };
  expect(await solver.solve(forged)).toBeNull();
});

test("the_answer_is_read_again_on_every_call", async () => {
  const dir = seedsDir();
  const solver = createOfflineSolver(dir);
  expect(text(await solver.solve(taskOf(ALPHA_HASH)))).toBe("ALPHA SOLUTION");

  writeFileSync(join(dir, "alpha", "solution.txt"), "ALPHA, CORRECTED");

  expect(text(await solver.solve(taskOf(ALPHA_HASH)))).toBe("ALPHA, CORRECTED");
});

test("a_seed_whose_answer_file_is_gone_has_no_answer", async () => {
  const dir = seedsDir();
  const solver = createOfflineSolver(dir);
  rmSync(join(dir, "alpha", "solution.txt"));

  expect(await solver.solve(taskOf(ALPHA_HASH))).toBeNull();
});

test("a_seeds_directory_that_is_not_there_fails_when_the_solver_is_made", () => {
  const missing = join(tmpdir(), "tender-seeds-that-does-not-exist");

  expect(() => createOfflineSolver(missing)).toThrow(/ENOENT/);
  expect(() => createWeakSolver(missing)).toThrow(/ENOENT/);
});

test("a_brief_that_cannot_be_hashed_fails_when_the_solver_is_made_and_names_the_seed", () => {
  const dir = seedsDir();
  seed(dir, "broken", { "brief.json": "{ not json", "solution.txt": "x" });

  expect(() => createOfflineSolver(dir)).toThrow(/seed broken: brief\.json cannot be hashed/);
});

test("offline_reads_a_solution_from_the_private_directory_first_and_the_seed_folder_next", async () => {
  const dir = seedsDir();
  const vault = mkdtempSync(join(tmpdir(), "tender-private-"));
  dirs.push(vault);
  // The private directory has alpha's solution, not beta's; the seed folders have both.
  mkdirSync(join(vault, "alpha"));
  writeFileSync(join(vault, "alpha", "solution.txt"), "ALPHA, PRIVATE");

  const solver = createOfflineSolver(dir, vault);

  expect(text(await solver.solve(taskOf(ALPHA_HASH)))).toBe("ALPHA, PRIVATE");
  expect(text(await solver.solve(taskOf(BETA_HASH)))).toBe("BETA SOLUTION");
});

test("a_seed_with_a_solution_nowhere_is_not_answered_and_a_missing_private_directory_is_no_error", async () => {
  const dir = seedsDir();
  rmSync(join(dir, "beta", "solution.txt"));
  const absent = join(tmpdir(), "tender-no-such-private-directory");

  const solver = createOfflineSolver(dir, absent);

  expect(text(await solver.solve(taskOf(ALPHA_HASH)))).toBe("ALPHA SOLUTION");
  expect(await solver.solve(taskOf(BETA_HASH))).toBeNull();
});

test("weak_reads_a_weak_answer_from_the_private_directory_first_and_the_seed_folder_next", async () => {
  const dir = seedsDir();
  const vault = mkdtempSync(join(tmpdir(), "tender-private-"));
  dirs.push(vault);
  // The private directory has a weak answer for alpha only; the seed folder has alpha's too, and
  // beta has none anywhere.
  mkdirSync(join(vault, "alpha"));
  writeFileSync(join(vault, "alpha", "weak.txt"), "ALPHA WEAK, PRIVATE");
  const absent = join(tmpdir(), "tender-no-such-private-directory");

  expect(text(await createWeakSolver(dir, vault).solve(taskOf(ALPHA_HASH)))).toBe(
    "ALPHA WEAK, PRIVATE",
  );
  expect(await createWeakSolver(dir, vault).solve(taskOf(BETA_HASH))).toBeNull();
  // With no private directory, and with none named, the folder's own is used.
  expect(text(await createWeakSolver(dir, absent).solve(taskOf(ALPHA_HASH)))).toBe("ALPHA WEAK");
  expect(text(await createWeakSolver(dir).solve(taskOf(ALPHA_HASH)))).toBe("ALPHA WEAK");
});

const REAL_PRIVATE_DIR = privateDirOf();
const REAL_SLUGS = readdirSync(REAL_SEEDS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const realAnswersAreHere = REAL_SLUGS.every(
  (slug) =>
    existsSync(solutionFileOf(REAL_PRIVATE_DIR, slug)) &&
    existsSync(weakFileOf(REAL_PRIVATE_DIR, slug)),
);

test.skipIf(!realAnswersAreHere)("the_real_seeds_are_answered_with_their_own_files", async () => {
  const offline = createOfflineSolver(REAL_SEEDS, REAL_PRIVATE_DIR);
  const weak = createWeakSolver(REAL_SEEDS, REAL_PRIVATE_DIR);
  // The ten P0 seeds are there, so this is not a loop over nothing.
  expect(REAL_SLUGS.length).toBeGreaterThanOrEqual(10);
  expect(missingPrivateFiles(REAL_SEEDS, REAL_PRIVATE_DIR, REAL_SLUGS)).toEqual([]);

  for (const slug of REAL_SLUGS) {
    const brief: unknown = JSON.parse(readFileSync(join(REAL_SEEDS, slug, "brief.json"), "utf8"));
    const ctx = taskOf(sha256Hex(canonicalJson(brief)));

    const solution = readFileSync(solutionFileOf(REAL_PRIVATE_DIR, slug));
    expect(await offline.solve(ctx), `${slug}: solution`).toEqual(new Uint8Array(solution));
    const weakAnswer = readFileSync(weakFileOf(REAL_PRIVATE_DIR, slug));
    expect(await weak.solve(ctx), `${slug}: weak`).toEqual(new Uint8Array(weakAnswer));
  }
});

test("the_real_seeds_have_no_answers_in_their_folders_so_the_scripted_solvers_need_the_private_directory", async () => {
  // Without the private directory a real seed is not answered at all, and nothing says it is: the
  // solvers have no answer, as for a task that is not a seed.
  const absent = join(tmpdir(), "tender-no-such-private-directory");
  const offline = createOfflineSolver(REAL_SEEDS, absent);
  const weak = createWeakSolver(REAL_SEEDS, absent);
  for (const slug of REAL_SLUGS) {
    const brief: unknown = JSON.parse(readFileSync(join(REAL_SEEDS, slug, "brief.json"), "utf8"));
    const ctx = taskOf(sha256Hex(canonicalJson(brief)));
    expect(await offline.solve(ctx), `${slug}: solution found in the repository`).toBeNull();
    expect(await weak.solve(ctx), `${slug}: weak answer found in the repository`).toBeNull();
  }
});
