import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeldoutSchema } from "@tender/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import { heldoutFilesOf, saltHeldoutFile } from "./salt-heldout";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "salt-heldout-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Writes `document` as `<dir>/<slug>/heldout.json` and gives its path. */
function seed(slug: string, document: unknown): string {
  mkdirSync(join(dir, slug));
  const file = join(dir, slug, "heldout.json");
  writeFileSync(file, `${JSON.stringify(document)}\n`);
  return file;
}

const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8"));

test("a_file_without_a_salt_gets_a_fresh_one_and_keeps_its_checks", () => {
  const checks = { regex_cases: { match: ["a"], no_match: ["b"] } };
  const one = seed("one", checks);
  const two = seed("two", checks);

  expect(saltHeldoutFile(one)).toBe("salted");
  expect(saltHeldoutFile(two)).toBe("salted");

  const salted = read(one);
  expect(HeldoutSchema.parse(salted)).toEqual(salted);
  expect(salted).toEqual({ ...checks, salt: expect.stringMatching(/^[0-9a-f]{64}$/) });
  // Each file draws its own, so the same checks commit to different hashes.
  expect(read(two).salt).not.toBe(salted.salt);
  // Written with two spaces and a newline at the end, and no temporary file is left.
  expect(readFileSync(one, "utf8")).toBe(`${JSON.stringify(salted, null, 2)}\n`);
  expect(readdirSync(join(dir, "one"))).toEqual(["heldout.json"]);
});

test("a_file_with_a_salt_is_left_as_it_is", () => {
  const file = seed("kept", { exact: { expected: ["x"] }, salt: "ab".repeat(32) });
  const before = readFileSync(file, "utf8");
  expect(saltHeldoutFile(file)).toBe("kept");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("a_file_that_is_no_held_out_document_is_refused_without_quoting_it", () => {
  const cases: [string, string, RegExp][] = [
    ["text", "the answer is 42", /is not JSON/],
    ["array", '["the answer is 42"]', /it is not an object/],
    ["wrong shape", '{"exact": {"expected": []}}', /at exact\.expected/],
    ["bad salt", '{"exact": {"expected": ["the answer is 42"]}, "salt": "42"}', /at salt/],
  ];
  for (const [slug, text, message] of cases) {
    mkdirSync(join(dir, slug));
    const file = join(dir, slug, "heldout.json");
    writeFileSync(file, text);
    expect(() => saltHeldoutFile(file), slug).toThrow(message);
    try {
      saltHeldoutFile(file);
    } catch (error) {
      expect((error as Error).message, slug).not.toContain("42");
    }
    // Nothing was written.
    expect(readFileSync(file, "utf8"), slug).toBe(text);
  }
});

test("a_folder_stands_for_the_heldout_file_of_each_of_its_folders", () => {
  const a = seed("a", { exact: { expected: ["x"] } });
  const c = seed("c", { exact: { expected: ["y"] } });
  // A seed with no held-out checks (a rubric) has no file, and a stray file is not a seed.
  mkdirSync(join(dir, "b"));
  writeFileSync(join(dir, "README.md"), "notes");
  const single = join(dir, "single.json");
  writeFileSync(single, "{}");
  expect(heldoutFilesOf([dir])).toEqual([a, c]);
  expect(heldoutFilesOf([single, dir])).toEqual([a, c, single].sort());
});
