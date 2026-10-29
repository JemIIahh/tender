import type { Heldout, PublicCriteria } from "@tender/shared";
import type { EntryScore } from "../types";

type ExactCriteria = Extract<PublicCriteria, { kind: "exact" }>;
// `Heldout` is a union, so `Heldout["exact"]` does not compile: pick the member first.
type ExactHeldout = Extract<Heldout, { exact: unknown }>["exact"];

/**
 * What each `normalize` step does. A `Record` over the step names, so a step added to the
 * criteria schema does not compile here until it is written.
 */
const STEPS: Record<ExactCriteria["normalize"][number], (text: string) => string> = {
  trim: (text) => text.trim(),
  // Not `toLocaleLowerCase`: the score must not depend on the machine's locale.
  lowercase: (text) => text.toLowerCase(),
  collapse_ws: (text) => text.replace(/\s+/g, " "),
};

/**
 * Scores an `exact` entry: 100 when its text equals one of the held-out accepted answers, else 0.
 *
 * Both sides go through the criteria's `normalize` steps, in the order listed, before they are
 * compared. The entry must be valid UTF-8. Bad bytes are not repaired into U+FFFD (an accepted
 * answer could be spelled that way); they score 0. A leading byte order mark is dropped, as
 * `TextDecoder` does by default.
 *
 * Pure and total: any bytes give a score, and none of them can make this throw.
 */
export function scoreExact(c: ExactCriteria, h: ExactHeldout, content: Uint8Array): EntryScore {
  const text = decodeUtf8(content);
  if (text === null) return scored(c, 0, ["not valid UTF-8"]);

  const answer = normalize(text, c.normalize);
  if (h.expected.some((accepted) => normalize(accepted, c.normalize) === answer)) {
    return scored(c, 100, []);
  }
  return scored(c, 0, [`expected one of ${h.expected.length} accepted answers`]);
}

function normalize(text: string, steps: ExactCriteria["normalize"]): string {
  return steps.reduce((current, step) => STEPS[step](current), text);
}

/** The text of `content`, or `null` when it is not valid UTF-8. */
function decodeUtf8(content: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function scored(c: ExactCriteria, score: number, reasons: string[]): EntryScore {
  return { score, passed: score >= c.min_score, reasons };
}
