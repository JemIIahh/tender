import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { REPO_ROOT } from "./env";
import {
  DEFAULT_HELDOUT_DIR,
  HELDOUT_DIR_VARIABLE,
  heldoutDirOf,
  heldoutFileOf,
  missingHeldouts,
  swarmPackHeldoutDirOf,
} from "./heldout-dir";

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
  expect(DEFAULT_HELDOUT_DIR).toBe(join(REPO_ROOT, "seeds-private"));
  expect(heldoutDirOf({})).toBe(DEFAULT_HELDOUT_DIR);
});

test("a_blank_variable_counts_as_unset", () => {
  for (const blank of ["", " ", "\t\n"]) {
    expect(heldoutDirOf({ [HELDOUT_DIR_VARIABLE]: blank })).toBe(DEFAULT_HELDOUT_DIR);
  }
});

test("the_variable_overrides_the_default", () => {
  expect(heldoutDirOf({ [HELDOUT_DIR_VARIABLE]: "/vault/heldout" })).toBe("/vault/heldout");
  expect(heldoutDirOf({ [HELDOUT_DIR_VARIABLE]: "  /vault/heldout  " })).toBe("/vault/heldout");
});

test("a_leading_tilde_is_the_home_directory_and_a_relative_path_is_from_the_current_one", () => {
  // An env file is not read by a shell, so `~` has to be taken here.
  expect(heldoutDirOf({ [HELDOUT_DIR_VARIABLE]: "~/prep/heldout" })).toBe(
    join(homedir(), "prep", "heldout"),
  );
  expect(heldoutDirOf({ [HELDOUT_DIR_VARIABLE]: "~" })).toBe(homedir());
  expect(heldoutDirOf({ [HELDOUT_DIR_VARIABLE]: "../private" })).toBe(resolve("../private"));
  // A tilde that is not the whole first part of the path is part of a name.
  expect(heldoutDirOf({ [HELDOUT_DIR_VARIABLE]: "/vault/~heldout" })).toBe("/vault/~heldout");
});

test("the_process_environment_is_what_it_reads_when_it_is_given_none", () => {
  const before = process.env[HELDOUT_DIR_VARIABLE];
  process.env[HELDOUT_DIR_VARIABLE] = "/from/the/process";
  try {
    expect(heldoutDirOf()).toBe("/from/the/process");
  } finally {
    if (before === undefined) delete process.env[HELDOUT_DIR_VARIABLE];
    else process.env[HELDOUT_DIR_VARIABLE] = before;
  }
});

test("the_files_are_per_slug_and_the_swarm_pack_has_a_part_of_its_own", () => {
  expect(heldoutFileOf("/vault", "ipv4-regex")).toBe("/vault/ipv4-regex/heldout.json");
  expect(swarmPackHeldoutDirOf("/vault")).toBe("/vault/swarm-research-pack");
  expect(swarmPackHeldoutDirOf()).toBe(join(heldoutDirOf(), "swarm-research-pack"));
});

test("missing_heldouts_names_the_seeds_with_a_held_out_part_and_no_file", () => {
  const seeds = tmp();
  const vault = tmp();
  const seed = (slug: string, hasHeldout: boolean | undefined) => {
    mkdirSync(join(seeds, slug));
    if (hasHeldout !== undefined) {
      writeFileSync(
        join(seeds, slug, "criteria.json"),
        JSON.stringify({ has_heldout: hasHeldout }),
      );
    }
  };
  seed("has-and-held", true);
  seed("has-and-missing", true);
  seed("rubric", false);
  seed("no-criteria", undefined);
  mkdirSync(join(vault, "has-and-held"));
  writeFileSync(join(vault, "has-and-held", "heldout.json"), "{}");
  // A file for a seed that has no held-out part is not what is looked for.
  mkdirSync(join(vault, "rubric"));
  writeFileSync(join(vault, "rubric", "heldout.json"), "{}");

  const slugs = ["has-and-held", "has-and-missing", "no-criteria", "rubric"];
  expect(missingHeldouts(seeds, vault, slugs)).toEqual(["has-and-missing"]);
  // A directory that is not there holds none.
  expect(missingHeldouts(seeds, join(vault, "nope"), slugs)).toEqual([
    "has-and-held",
    "has-and-missing",
  ]);
});
