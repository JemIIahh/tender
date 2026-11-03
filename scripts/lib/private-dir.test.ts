import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { REPO_ROOT } from "./env";
import {
  DEFAULT_PRIVATE_DIR,
  heldoutFileOf,
  missingHeldouts,
  missingPrivateFiles,
  PRIVATE_DIR_VARIABLE,
  privateDirOf,
  scenariosFileOf,
  solutionFileOf,
} from "./private-dir";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tender-heldout-dir-"));
  dirs.push(dir);
  return dir;
};

test("the_default_directory_is_seeds_private_of_the_repository", () => {
  expect(DEFAULT_PRIVATE_DIR).toBe(join(REPO_ROOT, "seeds-private"));
  expect(privateDirOf({})).toBe(DEFAULT_PRIVATE_DIR);
});

test("a_blank_variable_counts_as_unset", () => {
  for (const blank of ["", " ", "\t\n"]) {
    expect(privateDirOf({ [PRIVATE_DIR_VARIABLE]: blank })).toBe(DEFAULT_PRIVATE_DIR);
  }
});

test("the_variable_overrides_the_default", () => {
  expect(privateDirOf({ [PRIVATE_DIR_VARIABLE]: "/vault/heldout" })).toBe("/vault/heldout");
  expect(privateDirOf({ [PRIVATE_DIR_VARIABLE]: "  /vault/heldout  " })).toBe("/vault/heldout");
});

test("a_leading_tilde_is_the_home_directory_and_a_relative_path_is_from_the_current_one", () => {
  // An env file is not read by a shell, so `~` has to be taken here.
  expect(privateDirOf({ [PRIVATE_DIR_VARIABLE]: "~/prep/heldout" })).toBe(
    join(homedir(), "prep", "heldout"),
  );
  expect(privateDirOf({ [PRIVATE_DIR_VARIABLE]: "~" })).toBe(homedir());
  expect(privateDirOf({ [PRIVATE_DIR_VARIABLE]: "../private" })).toBe(resolve("../private"));
  // A tilde that is not the whole first part of the path is part of a name.
  expect(privateDirOf({ [PRIVATE_DIR_VARIABLE]: "/vault/~heldout" })).toBe("/vault/~heldout");
});

test("the_process_environment_is_what_it_reads_when_it_is_given_none", () => {
  const before = process.env[PRIVATE_DIR_VARIABLE];
  process.env[PRIVATE_DIR_VARIABLE] = "/from/the/process";
  try {
    expect(privateDirOf()).toBe("/from/the/process");
  } finally {
    if (before === undefined) delete process.env[PRIVATE_DIR_VARIABLE];
    else process.env[PRIVATE_DIR_VARIABLE] = before;
  }
});

test("the_files_are_per_slug", () => {
  expect(heldoutFileOf("/vault", "ipv4-regex")).toBe("/vault/ipv4-regex/heldout.json");
  expect(solutionFileOf("/vault", "ipv4-regex")).toBe("/vault/ipv4-regex/solution.txt");
  expect(scenariosFileOf("/vault", "vendor-pick-memo")).toBe(
    "/vault/vendor-pick-memo/scenarios.json",
  );
});

test("missing_private_files_names_the_seeds_that_lack_a_solution_their_checks_or_their_scenarios", () => {
  const seeds = tmp();
  const vault = tmp();
  const seed = (slug: string, criteria: object | undefined) => {
    mkdirSync(join(seeds, slug));
    if (criteria !== undefined) {
      writeFileSync(join(seeds, slug, "criteria.json"), JSON.stringify(criteria));
    }
  };
  const put = (slug: string, ...names: string[]) => {
    mkdirSync(join(vault, slug), { recursive: true });
    for (const name of names) writeFileSync(join(vault, slug, name), "{}");
  };
  const checked = { kind: "exact", has_heldout: true };
  const rubric = { kind: "rubric", has_heldout: false };
  seed("complete", checked);
  seed("no-checks", checked);
  seed("no-solution", checked);
  seed("rubric-complete", rubric);
  seed("rubric-no-solution", rubric);
  seed("rubric-no-scenarios", rubric);
  seed("no-criteria", undefined);
  put("complete", "heldout.json", "solution.txt");
  put("no-checks", "solution.txt");
  put("no-solution", "heldout.json");
  put("rubric-complete", "solution.txt", "scenarios.json");
  put("rubric-no-scenarios", "solution.txt");
  // A rubric seed's checks are not looked for, a seed that is not a rubric seed has no scenarios
  // to look for, and a folder with no criteria is left to others.

  const slugs = [
    "complete",
    "no-checks",
    "no-criteria",
    "no-solution",
    "rubric-complete",
    "rubric-no-scenarios",
    "rubric-no-solution",
  ];
  expect(missingPrivateFiles(seeds, vault, slugs)).toEqual([
    "no-checks",
    "no-solution",
    "rubric-no-scenarios",
    "rubric-no-solution",
  ]);
  // The held-out checks alone, for what needs them and not the rest: only "no-checks".
  expect(missingHeldouts(seeds, vault, slugs)).toEqual(["no-checks"]);
  // A directory that is not there holds none.
  expect(missingPrivateFiles(seeds, join(vault, "nope"), slugs)).toEqual([
    "complete",
    "no-checks",
    "no-solution",
    "rubric-complete",
    "rubric-no-scenarios",
    "rubric-no-solution",
  ]);
  expect(missingHeldouts(seeds, join(vault, "nope"), slugs)).toEqual([
    "complete",
    "no-checks",
    "no-solution",
  ]);
});
