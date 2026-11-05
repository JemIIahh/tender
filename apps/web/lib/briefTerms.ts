import type { Brief } from "@tender/shared";
import { formatSpan } from "./phase";

// The parts of a brief that pages other than the post wizard need: the categories, the kinds of
// check and the formats an answer can have, by name, how tags are read, and how long a window is in
// words. They are in a module of their own so that a board card or a service's card that says them
// does not bring the whole wizard (lib/post.ts, which re-exports them) with it.

export type Category = Brief["category"];
export const CATEGORIES: readonly Category[] = [
  "extraction",
  "coding",
  "research",
  "data",
  "writing",
  "other",
];

/** The tags in `text`: lower case, without a leading `#`, each once, in the order written. */
export function parseTags(text: string): string[] {
  const tags = text
    .split(/[\s,]+/)
    .map((tag) => tag.replace(/^#+/, "").toLowerCase())
    .filter((tag) => tag !== "");
  return [...new Set(tags)];
}

const SECOND_NS = 1_000_000_000n;

/** A length of time in a few words: `10m`, `1d`. */
export const spanText = (secs: number): string => formatSpan(BigInt(secs) * SECOND_NS);

/** The ways a task can be checked that the wizard writes. `tests` has no form here. */
export type CheckKind = "exact" | "json_schema" | "regex_cases" | "rubric";

/** What an entry looks like; `code_js` goes with the `tests` kind, which the wizard does not offer. */
export type AnswerFormat = "text" | "json" | "regex_json";

export const FORMAT_LABEL: Record<AnswerFormat, string> = {
  text: "Plain text",
  json: "JSON",
  regex_json: "A regex, as JSON",
};

export interface KindInfo {
  kind: CheckKind;
  label: string;
  blurb: string;
}

export const KINDS: readonly KindInfo[] = [
  {
    kind: "exact",
    label: "Exact answer",
    blurb: "The answer has to equal one of the answers you write.",
  },
  {
    kind: "json_schema",
    label: "JSON shape",
    blurb: "The answer is JSON that fits a schema. The Judge also checks values inside it.",
  },
  {
    kind: "regex_cases",
    label: "Regex cases",
    blurb: "The answer is a regular expression that has to match some strings and not others.",
  },
  {
    kind: "rubric",
    label: "Rubric",
    blurb: "The answer is scored against weighted points.",
  },
];
