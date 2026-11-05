import type { HeldoutChecks } from "@tender/shared";
import { sha256Hex } from "@tender/shared";

// The rules of the "no answers in the tracked tree" guard (no-answers-in-tree.test.ts), kept apart
// from the test so that they can be tested with invented values on every machine. Nothing here is
// a real answer, and nothing may become one: the exceptions are hashes.
//
// A seed's answer-like content is private (seeds/README.md). Windows of 40 characters find a
// leaked solution; they cannot find a 5-character one ("7,31"), which is the whole answer of a
// seed. This finds those, by looking for each value on its own, with rules that keep the noise
// down. A value counts as found when it appears:
//
//   - as a whole TOKEN, for a value that is one token itself ("8841.37", "2031-05-09"): the letters
//     and digits on either side of it are not part of the same word or number, so 8841.37 is not
//     in 18841.37, 8841.375 or 1,8841.37; or
//   - as a string LITERAL, for any other value ("7,2031-05-09", "7, 31", "carol.test\n"): between
//     matching quotes, as in the source of a test ("..." , '...' or `...`). Such a value is also
//     everywhere unquoted ("7, 31" is two array elements), so only the quoted form counts; or
//   - as TEXT, for a value of 40 characters or more: anywhere in the file, as it stands or as it
//     would be written inside a JSON or JavaScript string. That much text is not a coincidence.
//
// Letter case is ignored, as a normalised answer's is.

/** A value to look for, what it is (for the report) and how it has to appear. */
export interface Candidate {
  readonly what: string;
  readonly value: string;
  readonly how: "token" | "literal" | "text";
}

/** A value shorter than this turns up anywhere ("7", "ok") and is not looked for. */
export const MIN_VALUE_LENGTH = 3;

/** Words that are never an answer on their own, so a seed that has one for a value is not hunted for it. */
const COMMON_WORDS = new Set([
  "true",
  "false",
  "null",
  "none",
  "nil",
  "yes",
  "not",
  "any",
  "all",
  "n/a",
  "na",
  "nan",
  "error",
  "ok",
  "unknown",
  "empty",
]);

/**
 * A case string of a regex_cases or tests seed has to be this long to be looked for alone: those
 * are test vectors, and the short ones ("a.b", "1.5", "127.0.0.1", "constructor") are the edge
 * cases that any test of any such function has. A long one is specific enough to mean something.
 */
export const LONG_CASE_LENGTH = 12;

/**
 * Values that are in a seed's key and also in unrelated code and tests, because they are
 * well-known constants or a coincidence of units (2^128, one yoctoNEAR written out, a pangram, the
 * name of a JavaScript method, 1.25 USDC in base units), by the SHA-256 of the string and what it
 * is. A hash, so that the list cannot give an answer away itself: the string written out here
 * would be found by the guard that reads this file. Whatever is listed is not looked for anywhere,
 * so only a value that has been checked to be generic belongs here: to add one, hash the string
 * with `sha256Hex` from @tender/shared and say what it is. Never an exact answer.
 */
export const GENERIC_HASHES: ReadonlyMap<string, string> = new Map([
  [
    "014fff7625de866081b26a20a4050f0e9a78752d294c0fab7f7a457609912494",
    "one yoctoNEAR as a decimal",
  ],
  ["131eeae646a0119e0f8bb20e8e93998c7567cd10a1700ac1d8721296bdf06874", "0.1 NEAR in yocto"],
  ["2bebd8c50579bb419bfa77966f212469b05d13e43bf0423daa2f9403bf5c26ff", "2^128"],
  ["a1c367c29158357e62a3ff5d3e800fb7698a22396439dbc0a9d4929322afd35d", "2^53 + 1"],
  ["f603d66e473466ac5e35c18822083820cd4564deb3a85ce9da9ad5ba4560efd8", "a JavaScript method name"],
  ["05c6e08f1d9fdafa03147fcb8f82f124c76d2f70e3d989dc8aadb5e7d7450bec", "a pangram"],
  [
    "a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e",
    "a 64-digit hex account of the sequence 0123456789abcdef",
  ],
  ["f0d0684b111b4511f2e151a0065852129b79cf0c3e12b20ed59117e81a3f7fb8", "1.25 USDC in base units"],
]);

/**
 * A line of a solution or a weak answer, or a long value of the key, is looked for as it stands
 * from this many characters (the 40-character rule of the earlier rounds, by line).
 */
export const LONG_LINE_LENGTH = 40;

/** A file that holds this share of a seed's distinct case strings, and at least `CASE_SET_MIN`, has the key's table. */
export const CASE_SET_SHARE = 0.5;
export const CASE_SET_MIN = 8;

/**
 * Files that may hold a seed's case table because they test the same thing in earnest: the file
 * is the project's own test of the function the seed asks for.
 */
export const CASE_SET_FILES: ReadonlyMap<string, readonly string[]> = new Map([
  ["near-to-yocto", ["packages/shared/test/schemas.test.ts"]],
]);

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

/** Whether `value` is one token: letters, digits and the `_ . + -` that join them. */
export function isOneToken(value: string): boolean {
  return /^[A-Za-z0-9_](?:[A-Za-z0-9_.+-]*[A-Za-z0-9_])?$/.test(value);
}

/** The value as it is looked for: text if it is long, else a token if it is one, else a literal. */
export function howToLook(value: string): Candidate["how"] {
  if (value.length >= LONG_LINE_LENGTH) return "text";
  return isOneToken(value) ? "token" : "literal";
}

/** Whether a value is worth looking for at all, by the length and the common-word rules. */
export function worthLookingFor(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= MIN_VALUE_LENGTH && !COMMON_WORDS.has(trimmed.toLowerCase());
}

/**
 * Whether `needle` is in `haystack` as a whole token: the character before it and after it is not a
 * letter, a digit or `_`, nor a `.` or `,` that is itself followed (or preceded) by one, so the
 * decimal point and the thousands comma of a number count as part of it. Both lowercased by the caller.
 */
export function hasToken(haystack: string, needle: string): boolean {
  for (let from = 0; ; ) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    from = at + 1;
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    const glued =
      isWordChar(before) ||
      ((before === "." || before === ",") && isWordChar(haystack[at - 2])) ||
      isWordChar(after) ||
      ((after === "." || after === ",") && isWordChar(haystack[at + needle.length + 1]));
    if (!glued) return true;
  }
}

/** Whether `needle` is in `haystack` between matching quotes: `"..."`, `'...'` or a backtick pair. Lowercased by the caller. */
export function hasLiteral(haystack: string, needle: string): boolean {
  const escaped = JSON.stringify(needle).slice(1, -1).toLowerCase();
  return [`"${escaped}"`, `'${needle}'`, `\`${needle}\``, `'${escaped}'`].some((form) =>
    haystack.includes(form),
  );
}

/** Whether `needle` is in `haystack` anywhere, as it stands or as the inside of a JSON or JavaScript string. Lowercased by the caller. */
export function hasText(haystack: string, needle: string): boolean {
  return haystack.includes(needle) || haystack.includes(JSON.stringify(needle).slice(1, -1));
}

/** Whether the file text (already lowercased) holds the candidate. */
export function occursIn(lowerText: string, candidate: Candidate): boolean {
  const needle = candidate.value.toLowerCase();
  if (candidate.how === "token") return hasToken(lowerText, needle);
  return candidate.how === "text" ? hasText(lowerText, needle) : hasLiteral(lowerText, needle);
}

/** How to show a value in a failure message without printing it: its length and its first two characters. */
export function mask(value: string): string {
  const head = JSON.stringify(value.slice(0, 2)).slice(1, -1);
  return `${value.length} chars, starts "${head}"`;
}

/** The scalars (strings and numbers) of a JSON value. */
export function scalarsIn(value: unknown): (string | number)[] {
  if (typeof value === "string" || typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(scalarsIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(scalarsIn);
  return [];
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];

/** A seed's held-out document: its checks, and its salt where it has one. */
export type SeedHeldout = HeldoutChecks & { salt?: string };

/** What a seed's answer-like files hold, as the private directory has them. */
export interface SeedAnswers {
  /** `heldout.json`; null for a rubric seed. */
  heldout: SeedHeldout | null;
  /** `solution.txt` and `weak.txt`, as text. */
  solution: string;
  weak: string;
  /** The `pattern` or `source` of each entry of `known-wrong.json`; empty for a seed without one. */
  knownWrong: string[];
  /** The seed's public documents (brief and criteria) as one text: the question, which may show its own values. */
  publicText: string;
}

/**
 * Everything about a seed that has to stay out of the tracked tree, as values to look for alone:
 *
 *   exact         each accepted answer, and the same without whitespace
 *   json_schema   each string or number of an assertion, unless the seed's own brief or criteria
 *                 show it (a value that is in the question is not an answer)
 *   regex_cases   each case string of `LONG_CASE_LENGTH` or more, unless generic or in the question
 *   tests         the same, of each input and output
 *   all           the whole text of the solution, the weak answer and each known-wrong answer, and
 *                 each line of 40 or more characters of them
 *   salt          the held-out document's salt, as text: with it, the commitment of a short answer
 *                 can be found by hashing the likely answers
 *
 * Values of one or two characters and the common words are left out (`worthLookingFor`). The
 * second half of the guard, a table of cases in one file, is `caseStrings`.
 */
export function answerCandidates(seed: SeedAnswers): Candidate[] {
  const out: Candidate[] = [];
  const publicLower = seed.publicText.toLowerCase();
  const inQuestion = (value: string): boolean =>
    publicLower.includes(value.toLowerCase()) ||
    publicLower.includes(JSON.stringify(value).slice(1, -1).toLowerCase());
  const add = (what: string, value: string, how: Candidate["how"] = howToLook(value)): void => {
    if (worthLookingFor(value) && !GENERIC_HASHES.has(sha256Hex(value))) {
      out.push({ what, value, how });
    }
  };

  const { heldout } = seed;
  if (heldout !== null && "exact" in heldout) {
    for (const answer of heldout.exact.expected) {
      add("exact answer", answer.trim());
      add("exact answer, without spaces", answer.replace(/\s+/g, ""));
    }
  }
  if (heldout !== null && "json_schema" in heldout) {
    for (const { equals } of heldout.json_schema.assertions) {
      for (const scalar of scalarsIn(equals)) {
        const value = String(scalar);
        if (!inQuestion(value)) add("json_schema value", value);
      }
    }
  }
  for (const value of caseStrings(heldout)) {
    if (value.length < LONG_CASE_LENGTH || inQuestion(value)) continue;
    add("case string", value);
  }
  if (heldout?.salt !== undefined) add("held-out salt", heldout.salt, "text");

  const wholeAndLines = (what: string, text: string): void => {
    const trimmed = text.trim();
    add(`${what} (whole)`, trimmed);
    for (const line of trimmed.split(/\r?\n/)) {
      const part = line.trim();
      if (part.length >= LONG_LINE_LENGTH) add(`${what} (line)`, part);
    }
  };
  wholeAndLines("solution", seed.solution);
  wholeAndLines("weak answer", seed.weak);
  for (const wrong of seed.knownWrong) wholeAndLines("known-wrong answer", wrong);

  // One value can come from more than one place (the same answer in two forms): look for it once.
  const byValue = new Map<string, Candidate>();
  for (const candidate of out) {
    const key = JSON.stringify([candidate.value, candidate.how]);
    if (!byValue.has(key)) byValue.set(key, candidate);
  }
  return [...byValue.values()];
}

/**
 * The distinct strings of a regex_cases or tests key, of `MIN_VALUE_LENGTH` characters or more,
 * for the table rule: a file that holds `CASE_SET_SHARE` of them (and `CASE_SET_MIN`) has copied
 * the table, however generic each case is. Empty for the other kinds.
 */
export function caseStrings(heldout: SeedHeldout | null): string[] {
  if (heldout === null) return [];
  const all: string[] = [];
  if ("regex_cases" in heldout)
    all.push(...heldout.regex_cases.match, ...heldout.regex_cases.no_match);
  if ("tests" in heldout) {
    for (const { input, output } of heldout.tests.cases) {
      for (const scalar of [...scalarsIn(input), ...scalarsIn(output)]) {
        if (typeof scalar === "string") all.push(scalar);
      }
    }
  }
  return unique(all.filter((value) => value.length >= MIN_VALUE_LENGTH));
}

/** Whether `lowerText` (lowercased) holds a table of the seed's cases: the share rule, with strings as literals. */
export function holdsCaseTable(lowerText: string, cases: readonly string[]): boolean {
  if (cases.length < CASE_SET_MIN) return false;
  const found = cases.filter((value) => hasLiteral(lowerText, value.toLowerCase())).length;
  return found >= CASE_SET_MIN && found >= cases.length * CASE_SET_SHARE;
}
