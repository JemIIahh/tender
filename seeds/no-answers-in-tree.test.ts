import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Heldout, HeldoutSchema, sha256Hex } from "@tender/shared";
import { describe, expect, test } from "vitest";
import {
  heldoutFileOf,
  knownWrongFileOf,
  missingPrivateFiles,
  PRIVATE_DIR_VARIABLE,
  privateDirOf,
  solutionFileOf,
  weakFileOf,
} from "../scripts/lib/private-dir";
import {
  answerCandidates,
  CASE_SET_FILES,
  caseStrings,
  GENERIC_HASHES,
  hasLiteral,
  hasText,
  hasToken,
  holdsCaseTable,
  mask,
  occursIn,
  worthLookingFor,
} from "./answer-scan";

// The guard against a real seed's answer sitting in the tracked tree. The private half of a seed
// (seeds/README.md) is kept out of git, and the scans of the earlier rounds look for 40 characters
// of it. A short answer is not 40 characters (a pair of counts is the whole answer of a seed), and was once
// in a judge test as the example of an exact match. So every answer-like value of every real seed
// is looked for on its own, in every file git tracks and every one it has not yet been told about
// (`git ls-files --cached --others`, so that a leak is found before it is committed), by the rules
// in answer-scan.ts:
// as a whole token or a string literal, any length from 3, with the common words left out.
//
// What counts as an answer: the accepted strings of an exact key (and the same without spaces),
// the values a json_schema key compares unless the seed's own brief or criteria already show them,
// the long case strings of a regex_cases or tests key, a table of those cases copied into one file,
// and the whole text and the long lines of a solution, a weak answer and a known-wrong answer.
//
// The scan needs the private directory, so it runs only where that is (a maintainer's machine); in
// a clean checkout and in CI the per-seed tests are skipped with one note, as in seeds.test.ts.
// The rules themselves are tested first with invented values, and run everywhere.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SEEDS_DIR = import.meta.dirname;
const SLUGS = readdirSync(SEEDS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const PRIVATE_DIR = privateDirOf();
const MISSING = new Set(missingPrivateFiles(SEEDS_DIR, PRIVATE_DIR, SLUGS));
if (MISSING.size > 0) {
  console.warn(
    `no-answers-in-tree: private files not found in ${PRIVATE_DIR}; set ${PRIVATE_DIR_VARIABLE}. ` +
      `The scan for the answers of ${MISSING.size} seeds is skipped.`,
  );
}

describe("the rules of the scan", () => {
  // Every value here is invented; none is, or may become, a real seed's answer.
  test("a_token_is_not_found_inside_a_longer_word_or_number", () => {
    const found = (text: string) => hasToken(text, "8841.37");
    expect(found("total = 8841.37;")).toBe(true);
    expect(found("[8841.37, 2]")).toBe(true);
    expect(found("costs 8841.37.")).toBe(true);
    expect(found("18841.37")).toBe(false);
    expect(found("8841.375")).toBe(false);
    expect(found("8841.37e5")).toBe(false);
    expect(found("v8841.37")).toBe(false);
    expect(found("1,8841.37")).toBe(false);
    expect(found("8841.37,5")).toBe(false);
    expect(found("x_8841.37")).toBe(false);
  });

  test("a_composite_value_counts_only_between_quotes", () => {
    const found = (text: string, value = "7,31") => hasLiteral(text, value);
    expect(found('bytes("7,31")')).toBe(true);
    expect(found("const a = '7,31'")).toBe(true);
    expect(found("const a = `7,31`")).toBe(true);
    expect(found('{"expected":["7,31"]}')).toBe(true);
    expect(found("[7,31]")).toBe(false);
    expect(found('"17,31"')).toBe(false);
    expect(found('"7,31, 4"')).toBe(false);
    expect(found('["7, 31"]', "7, 31")).toBe(true);
    expect(found("[7, 31]", "7, 31")).toBe(false);
    // An escape in the value is looked for as the source of a string spells it.
    expect(found('"a\\nb"', "a\nb")).toBe(true);
  });

  test("long_text_counts_anywhere_as_it_stands_or_escaped", () => {
    const line = 'she said "the quarterly figure was restated twice" in the memo';
    expect(hasText(`before ${line} after`, line)).toBe(true);
    expect(hasText(`const s = "${JSON.stringify(line).slice(1, -1)}";`, line)).toBe(true);
    expect(hasText("the quarterly figure was restated", line)).toBe(false);
  });

  test("letter_case_is_ignored", () => {
    const candidate = { what: "x", value: "Mk-4471-Qz", how: "token" as const };
    expect(occursIn('id = "mk-4471-qz";'.toLowerCase(), candidate)).toBe(true);
    expect(occursIn("mk-4471-qzz", candidate)).toBe(false);
  });

  test("short_values_and_common_words_are_not_looked_for", () => {
    for (const value of ["", "7", "ab", " 12 ", "true", "False", "null", "none", "n/a", "NaN"]) {
      expect(worthLookingFor(value), JSON.stringify(value)).toBe(false);
    }
    for (const value of ["abc", "123", "6,5", "Zorg"]) {
      expect(worthLookingFor(value), value).toBe(true);
    }
  });

  test("a_seeds_answers_are_collected_by_kind", () => {
    const seed = (heldout: Heldout | null, publicText = "") => ({
      heldout,
      solution: "short solution",
      weak: "short weak one",
      knownWrong: [],
      publicText,
    });
    const values = (heldout: Heldout | null, publicText?: string) =>
      answerCandidates(seed(heldout, publicText)).map((c) => c.value);

    // exact: each answer, and the same without spaces; looked for as a literal when it is composite.
    const exact = answerCandidates(seed({ exact: { expected: ["4, 19"] } }));
    expect(exact.filter((c) => c.what.startsWith("exact")).map((c) => [c.value, c.how])).toEqual([
      ["4, 19", "literal"],
      ["4,19", "literal"],
    ]);

    // json_schema: a value the question shows is not an answer; one it does not show is.
    const json: Heldout = {
      json_schema: {
        assertions: [
          { path: "$.a", equals: "Quartz Ltd" },
          { path: "$.b", equals: 91.5 },
          { path: "$.c", equals: { name: "Mica", n: 7 } },
        ],
      },
    };
    const derived = values(json, 'the brief names "Quartz Ltd" and 7');
    expect(derived).toContain("91.5");
    expect(derived).toContain("Mica");
    expect(derived).not.toContain("Quartz Ltd");
    expect(derived).not.toContain("7");

    // regex_cases and tests: a short case string is a generic edge case; a long one is looked for;
    // a generic constant on the hash list is not.
    const generic = "340282366920938463463374607431768211456";
    expect(GENERIC_HASHES.has(sha256Hex(generic))).toBe(true);
    const cases: Heldout = {
      regex_cases: { match: ["a.b", "kestrel-feather-0042"], no_match: [generic] },
    };
    const caseValues = answerCandidates(seed(cases))
      .filter((c) => c.what === "case string")
      .map((c) => c.value);
    expect(caseValues).toEqual(["kestrel-feather-0042"]);
  });

  test("a_copied_table_of_cases_is_found_however_generic_each_case_is", () => {
    const cases = ["aa.bb", "cc.dd", "ee.ff", "gg.hh", "ii.jj", "kk.ll", "mm.nn", "oo.pp"];
    const heldout: Heldout = {
      regex_cases: { match: cases.slice(0, 4), no_match: cases.slice(4) },
    };
    expect(caseStrings(heldout)).toEqual(cases);
    const quoted = (list: string[]) => list.map((c) => `"${c}"`).join(", ");
    expect(holdsCaseTable(quoted(cases), cases)).toBe(true);
    expect(holdsCaseTable(quoted(cases.slice(0, 7)), cases)).toBe(false);
    // Fewer than eight cases are never a table, whatever the share.
    expect(holdsCaseTable(quoted(cases.slice(0, 5)), cases.slice(0, 5))).toBe(false);
  });

  test("a_failure_message_does_not_print_the_value", () => {
    const shown = mask("hunter2-and-more");
    expect(shown).toContain("16 chars");
    expect(shown).not.toContain("hunter2");
  });
});

/** The text of every tracked file, lowercased, by path; null where there is no git checkout. */
let trackedCache: Map<string, string> | null | undefined;
function trackedTexts(): Map<string, string> | null {
  if (trackedCache !== undefined) return trackedCache;
  let listing: string;
  try {
    listing = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    trackedCache = null;
    return null;
  }
  const texts = new Map<string, string>();
  for (const path of listing.split("\0")) {
    // The private directory is never tracked; a lockfile is hashes and versions, not prose.
    if (
      path === "" ||
      path.startsWith("seeds-private/") ||
      /(?:^|\/)(?:pnpm-lock\.yaml|Cargo\.lock)$/.test(path)
    ) {
      continue;
    }
    try {
      const file = join(ROOT, path);
      if (statSync(file).size > 3_000_000) continue;
      const text = readFileSync(file, "utf8");
      if (!text.includes("\0")) texts.set(path, text.toLowerCase());
    } catch {
      // Listed but not on disk (a deleted file not yet committed): nothing to scan.
    }
  }
  trackedCache = texts;
  return texts;
}

/** The text of a seed's public files, which are the question and may show their own values. */
const publicTextOf = (slug: string): string =>
  ["task.json", "brief.json", "criteria.json"]
    .map((name) => join(SEEDS_DIR, slug, name))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

describe("no answer of a real seed is in the tracked tree", () => {
  for (const slug of SLUGS) {
    test(slug, ({ skip }) => {
      if (MISSING.has(slug)) skip(`private files for ${slug} not found in ${PRIVATE_DIR}`);
      const files = trackedTexts();
      if (files === null) return skip("not a git checkout, so there is no list of tracked files");

      const heldoutFile = heldoutFileOf(PRIVATE_DIR, slug);
      const heldout = existsSync(heldoutFile)
        ? HeldoutSchema.parse(JSON.parse(readFileSync(heldoutFile, "utf8")))
        : null;
      const knownWrongFile = knownWrongFileOf(PRIVATE_DIR, slug);
      const knownWrong = existsSync(knownWrongFile)
        ? (
            JSON.parse(readFileSync(knownWrongFile, "utf8")) as {
              pattern?: string;
              source?: string;
            }[]
          )
            .map((entry) => entry.pattern ?? entry.source)
            .filter((text): text is string => typeof text === "string")
        : [];
      const candidates = answerCandidates({
        heldout,
        solution: readFileSync(solutionFileOf(PRIVATE_DIR, slug), "utf8"),
        weak: readFileSync(weakFileOf(PRIVATE_DIR, slug), "utf8"),
        knownWrong,
        publicText: publicTextOf(slug),
      });
      const cases = caseStrings(heldout);
      const tableAllowed = new Set(CASE_SET_FILES.get(slug) ?? []);

      // What is reported names the file, the kind of value and its length, never the value.
      const found: string[] = [];
      for (const [path, text] of files) {
        for (const candidate of candidates) {
          if (occursIn(text, candidate)) {
            found.push(`${path}: ${candidate.what}, ${candidate.how}, ${mask(candidate.value)}`);
          }
        }
        if (!tableAllowed.has(path) && holdsCaseTable(text, cases)) {
          found.push(`${path}: a table of the seed's cases`);
        }
      }
      expect(found, `answers of ${slug} in tracked files`).toEqual([]);
    });
  }
});
