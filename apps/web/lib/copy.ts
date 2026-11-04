import { type AnswerFormat, FORMAT_LABEL, KINDS } from "./briefTerms";

// Words that more than one place says. Each is said one way, here, so that a card and its page,
// or a wizard and the page of the task it made, never word the same thing two ways.

/** The title of a task whose public brief the index has not read. */
export const UNTITLED_TASK = "Untitled task (no public brief yet)";

/** The flag for a task whose poster is also its verifier. */
export const POSTER_JUDGES = "Poster judges their own task";

/** The brief the index holds none of: the page can't show it yet. */
export const BRIEF_UNAVAILABLE = "The brief isn't available yet.";

/** The criteria the index holds none of. */
export const CRITERIA_UNAVAILABLE = "The criteria aren't available yet.";

/** A page that reads the account's balances says so in these words. */
export const READING_BALANCES = "Reading your balances…";

/** What a check kind is called, as the wizard calls it; a kind the wizard does not offer, as it is. */
export function kindLabel(kind: string): string {
  return KINDS.find((candidate) => candidate.kind === kind)?.label ?? kind;
}

/** What an answer format is called, as the wizard calls it; a format it does not offer, as it is. */
export function formatLabel(format: string): string {
  return (FORMAT_LABEL as Record<string, string>)[format] ?? format;
}

export type { AnswerFormat };
