// The rules a `rubric` task is held to: one copy, for the Judge, which grades by them and turns a
// task away at intake for breaking one, and for whoever posts a rubric task, so that a poster can
// be told of a problem before the reward goes in. A model has to echo every criterion back in its
// reply, and the Judge publishes the criteria as the rubric wrote them, so a criterion must be one
// the model can write back as it is, and tell from every other.

/** The most criteria a rubric may have, so that the reply that scores them all fits its tokens. */
export const RUBRIC_MAX_CRITERIA = 20;
/** The most characters, counted in code points, a criterion may have: the model echoes it. */
export const RUBRIC_MAX_CRITERION_CHARS = 200;
/**
 * The most entries the Judge grades for a rubric task: the first ones in commit order, by the
 * block of the entry's commit and then by account (P05-R21). An entry after them is not scored
 * and cannot win. The model's calls are paid for, and this bounds what a task can cost. An
 * invite-only rubric task takes no more entries than this at all (`rubricEntriesProblem`).
 */
export const RUBRIC_MAX_ENTRIES = 50;
/**
 * The lowest pass mark a rubric task may have (P05-R20). An entry the Judge disqualifies scores 0,
 * and with a pass mark of 0 a 0 would pass.
 */
export const RUBRIC_MIN_SCORE = 1;

/**
 * Every character that is an angle bracket or folds to one under Unicode normalisation: `<` and
 * `>`, the fullwidth ＜ ＞ and small ﹤ ﹥ forms (NFKC), and ≮ ≯, which NFD splits into a bracket and
 * a combining mark. The invisible tag forms U+E003C and U+E003E fold to nothing, but some models
 * read them as `<` and `>`, so they are here too. A criterion may hold none of them, and the Judge
 * shows the grader every one of them in an entry or a brief as ‹ or ›. Not global, so that `test`
 * keeps nothing from one call to the next.
 */
export const ANGLE_BRACKET =
  /[<>\u{FF1C}\u{FF1E}\u{FE64}\u{FE65}\u{226E}\u{226F}\u{E003C}\u{E003E}]/u;

/** The characters of `ANGLE_BRACKET` that open: `<` and those that fold to it. The rest close. */
export const OPENING_ANGLE_BRACKETS: ReadonlySet<string> = new Set([
  "<",
  "\u{FF1C}",
  "\u{FE64}",
  "\u{226E}",
  "\u{E003C}",
]);

/** Whether `text` holds an angle bracket, or a character that folds to one (`ANGLE_BRACKET`). */
export function hasAngleBracket(text: string): boolean {
  return ANGLE_BRACKET.test(text);
}

/** `ANGLE_BRACKET`, global, so that `replace` takes every one. */
const EVERY_ANGLE_BRACKET = new RegExp(ANGLE_BRACKET.source, "gu");
const OPENING = "\u{2039}";
const CLOSING = "\u{203A}";

/**
 * `text` with every angle bracket replaced (`ANGLE_BRACKET`): `<` and the characters that fold to
 * it become ‹, and `>` and those that fold to it become ›. Nothing is left that is, or can
 * normalise to, a `<` or `>`, so no text that went through this can write a tag (`</entry>`, spelt
 * any way), a chat-template control token (`<|im_end|>`, `<｜…｜>`, `<<SYS>>`) or a comment,
 * whatever the server reads. The rest of the text is not touched.
 *
 * It is what the Judge does to an entry and a brief before a model grades them, and what every
 * reader of a stranger's words does before a model reads them next to its own: the question board's
 * text in an agent's prompt goes through it too.
 */
export function defangBrackets(text: string): string {
  return text.replace(EVERY_ANGLE_BRACKET, (bracket) =>
    OPENING_ANGLE_BRACKETS.has(bracket) ? OPENING : CLOSING,
  );
}

/**
 * What a criterion is known by: the text in NFKC, spaces collapsed to one and trimmed, in lower
 * case. Two criteria with the same key read the same to the model, which has to tell them apart,
 * and a criterion in a reply finds its place in the rubric by its key. A key of "" is a blank
 * criterion.
 */
export function criterionKey(criterion: string): string {
  return criterion.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * Which rule a rubric task breaks. Each caller words them its own way.
 *
 * - `too_many_criteria`: more than `RUBRIC_MAX_CRITERIA` criteria.
 * - `criterion_blank`: a criterion with nothing but space in it.
 * - `criterion_too_long`: a criterion of more than `RUBRIC_MAX_CRITERION_CHARS` code points.
 * - `criterion_bracket`: a criterion with an angle bracket in it (`ANGLE_BRACKET`).
 * - `criteria_collide`: two criteria with the same key (`criterionKey`).
 * - `min_score`: a pass mark below `RUBRIC_MIN_SCORE`.
 * - `entries`: entry terms that are neither an open task's nor an invite-only one's.
 */
export type RubricProblem =
  | "too_many_criteria"
  | "criterion_blank"
  | "criterion_too_long"
  | "criterion_bracket"
  | "criteria_collide"
  | "min_score"
  | "entries";

/**
 * The first rule that the criteria of a rubric task break, or `null`: the count of criteria, then
 * each criterion in turn (blank, too long, a bracket, the same key as one before it), then the pass
 * mark.
 */
export function rubricCriteriaProblem(c: {
  min_score: number;
  rubric: readonly { criterion: string }[];
}): RubricProblem | null {
  if (c.rubric.length > RUBRIC_MAX_CRITERIA) return "too_many_criteria";
  const keys = new Set<string>();
  for (const { criterion } of c.rubric) {
    const key = criterionKey(criterion);
    if (key === "") return "criterion_blank";
    if (Array.from(criterion).length > RUBRIC_MAX_CRITERION_CHARS) return "criterion_too_long";
    if (hasAngleBracket(criterion)) return "criterion_bracket";
    if (keys.has(key)) return "criteria_collide";
    keys.add(key);
  }
  return c.min_score < RUBRIC_MIN_SCORE ? "min_score" : null;
}

/**
 * Whether the entry terms of a rubric task break the rules (`entries`), or `null`. A task is open
 * (no invited list) with `max_entries` 0, which is the only cap the contract allows an open task
 * (C24), or invite-only with `max_entries` from 1 to `RUBRIC_MAX_ENTRIES`. The Judge grades the
 * first `RUBRIC_MAX_ENTRIES` entries of an open task (P05-R21).
 */
export function rubricEntriesProblem(task: {
  max_entries: number;
  invited: readonly string[];
}): RubricProblem | null {
  if (task.invited.length === 0) return task.max_entries === 0 ? null : "entries";
  return task.max_entries >= 1 && task.max_entries <= RUBRIC_MAX_ENTRIES ? null : "entries";
}
