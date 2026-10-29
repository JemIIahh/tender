import type { Heldout, PublicCriteria } from "@tender/shared";
import { expect, test } from "vitest";
import { scoreExact } from "../src/index";

type ExactCriteria = Extract<PublicCriteria, { kind: "exact" }>;
// `Heldout` is a union, so `Heldout["exact"]` does not compile: pick the member first.
type ExactHeldout = Extract<Heldout, { exact: unknown }>["exact"];

function criteria(normalize: ExactCriteria["normalize"], minScore = 100): ExactCriteria {
  return {
    version: 1,
    kind: "exact",
    min_score: minScore,
    split: "winner_take_all",
    has_heldout: true,
    normalize,
  };
}

const heldout = (...expected: string[]): ExactHeldout => ({ expected });
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

// Written as code points, so that the characters can be seen in the source.
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);
const NO_BREAK_SPACE = String.fromCodePoint(0x00a0);

test("normalize_trim_lowercase_collapse", () => {
  const all = criteria(["trim", "lowercase", "collapse_ws"]);
  const expected = heldout("Hello World");

  expect(scoreExact(all, expected, bytes("  hello \t\n  WORLD  "))).toEqual({
    score: 100,
    passed: true,
    reasons: [],
  });
  // Both sides are normalized, so an expected answer with stray case and spaces still matches.
  expect(scoreExact(all, heldout("  Hello    WORLD "), bytes("hello world")).score).toBe(100);

  // Only the steps the criteria list run.
  const trimOnly = criteria(["trim"]);
  expect(scoreExact(trimOnly, expected, bytes("\n Hello World \t")).score).toBe(100);
  expect(scoreExact(trimOnly, expected, bytes("hello world")).score).toBe(0);
  expect(scoreExact(trimOnly, expected, bytes("Hello  World")).score).toBe(0);

  const none = criteria([]);
  expect(scoreExact(none, expected, bytes("Hello World")).score).toBe(100);
  expect(scoreExact(none, expected, bytes("Hello World ")).score).toBe(0);

  // `collapse_ws` turns every run of whitespace into one space, but does not trim: a leading
  // space becomes a single space, which is not the same as nothing.
  const collapseOnly = criteria(["collapse_ws"]);
  expect(scoreExact(collapseOnly, heldout("a b"), bytes(`a \t\n${NO_BREAK_SPACE} b`)).score).toBe(
    100,
  );
  expect(scoreExact(collapseOnly, heldout("a b"), bytes(" a b")).score).toBe(0);
});

test("any_of_expected", () => {
  const c = criteria(["trim", "lowercase", "collapse_ws"]);
  const expected = heldout("[redacted]", "[redacted]");

  expect(scoreExact(c, expected, bytes("[redacted]")).score).toBe(100);
  expect(scoreExact(c, expected, bytes("[redacted]")).score).toBe(100);
  expect(scoreExact(c, expected, bytes(" 10,  14\n")).score).toBe(100);
  expect(scoreExact(c, expected, bytes("10 ,14")).score).toBe(0);
});

test("invalid_utf8_scores_zero", () => {
  const c = criteria([]);
  // The accepted answer is U+FFFD, what a decoder that replaces bad bytes would turn them into.
  // Only a decoder that refuses bad bytes can tell the two apart.
  const expected = heldout(REPLACEMENT_CHARACTER);
  const invalid: [string, number[]][] = [
    ["a byte that never occurs in UTF-8", [0xff]],
    ["a truncated sequence", [0xe2, 0x82]],
    ["an overlong encoding", [0xc0, 0xaf]],
    ["an encoded surrogate", [0xed, 0xa0, 0x80]],
    ["a code point above U+10FFFF", [0xf4, 0x90, 0x80, 0x80]],
    ["bad bytes after valid text", [0x34, 0x32, 0xff]],
  ];

  for (const [label, raw] of invalid) {
    expect(scoreExact(c, expected, Uint8Array.from(raw)), label).toEqual({
      score: 0,
      passed: false,
      reasons: ["not valid UTF-8"],
    });
  }
  // U+FFFD itself, encoded properly, is fine.
  expect(scoreExact(c, expected, bytes(REPLACEMENT_CHARACTER)).score).toBe(100);
});

test("mismatch_scores_zero", () => {
  const c = criteria(["trim", "lowercase", "collapse_ws"]);
  const expected = heldout("42", "forty-two");

  expect(scoreExact(c, expected, bytes("43"))).toEqual({
    score: 0,
    passed: false,
    reasons: ["expected one of 2 accepted answers"],
  });
  for (const wrong of ["", "4 2", "42.0", "forty two", "42\u0000"]) {
    expect(scoreExact(c, expected, bytes(wrong)).score, JSON.stringify(wrong)).toBe(0);
  }
});
