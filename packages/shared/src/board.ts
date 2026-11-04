import { z } from "zod";
import { AccountIdSchema, U64StringSchema } from "./primitives";

// The public question board of a task (owner decision of 2026-11-03).
//
// An entrant asks the poster a question on a task, the poster answers it, and everyone reads
// both, so that all entrants work from the same clarified brief. The poster can also post a
// clarification, an answer with no question. Entries stay sealed: this is no chat between agents.
//
// The board explains the brief and nothing else. The Judge never reads it, and an answer cannot
// change the committed criteria or the held-out checks; `BOARD_NOTE` says so on every read.
//
// Everything on the board is a stranger's words, and so is public. Text is plain text: it is
// stored and returned as text and never interpreted, so a reader shows it as text (escaped, in
// HTML) and a model reads it as data.
//
// Numbers follow R19: a row id is a decimal string, and a time is ISO 8601 in UTC.

/** The most characters one question, answer or clarification may have, counted in code points. */
export const BOARD_TEXT_MAX_CHARS = 1_000;

/**
 * How much the board takes. The first three are the owner's; the rest are the lane's rulings.
 *
 * - `askerPerTaskPerHour`, `askerPerTask`: the questions one account may ask on one task, in any
 *   hour and in all, a hidden question included.
 * - `questionsPerTask`: the questions a task shows at once. A hidden question does not count, so a
 *   poster who hides spam makes room for real questions.
 * - `questionRowsPerTask`: the questions a task keeps at all, hidden ones included. It bounds what
 *   a read returns, as a spammer's hidden rows would not otherwise be bounded.
 * - `clarificationsPerTask`, `clarificationsPerHour`: the poster's own standalone posts.
 */
export const BOARD_LIMITS = Object.freeze({
  askerPerTaskPerHour: 5,
  askerPerTask: 20,
  questionsPerTask: 200,
  questionRowsPerTask: 500,
  clarificationsPerTask: 50,
  clarificationsPerHour: 10,
});

/** The window the per-hour limits count in. */
export const BOARD_HOUR_MS = 60 * 60 * 1000;

/**
 * What every read of the board says, so that a page and an agent are told alike. The Judge scores
 * by the criteria committed on chain; nothing here reaches it.
 */
export const BOARD_NOTE =
  "Questions and answers explain the brief. They do not change the criteria committed on chain, " +
  "the held-out checks or how entries are scored, and the Judge never reads this board. Every " +
  "word on it was written by an account and is public.";

/** What stands where a hidden question's text would be. */
export const BOARD_HIDDEN_LABEL = "hidden by the poster";

/** A UTF-16 surrogate that has no partner: with the `u` flag a pair is one code point, not two. */
const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * Whether `text` holds a character that has no place in plain text, by the UTF-16 unit:
 * - a C0 or C1 control character other than the tab, the line feed and the carriage return, or a
 *   DEL. A NUL is among them: no `text` column holds one, and a route that passed it on would
 *   answer with a 500;
 * - a bidirectional override or isolate (U+202A to U+202E, U+2066 to U+2069), which can make a line
 *   read in another order than it was written.
 * Written as a loop and not as a pattern, so that no invisible character is spelled in the source.
 */
function hasForbiddenChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isC0 = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    const isC1 = code >= 0x7f && code <= 0x9f;
    const isBidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    if (isC0 || isC1 || isBidi) return true;
  }
  return false;
}

/**
 * A format character: Unicode category Cf, which is drawn as nothing in nearly every UI, and the
 * whole tag block U+E0000 to U+E007F, whose unassigned code points (the block has only 98 assigned
 * of 128) are in no category Cf but could be given a meaning later.
 */
const FORMAT_CHAR = /[\p{Cf}\u{E0000}-\u{E007F}]/u;

/**
 * The first format character (category Cf, or in the tag block) of `text` once it is in NFC, as `U+XXXX`, or null.
 * Cf is where everything invisible lives that could hide words from the poster and not from a
 * model: the tag characters U+E0000 to U+E007F (an ASCII text a model can read and a person
 * cannot see), the zero-width characters U+200B to U+200D and U+2060 to U+2064, the byte order
 * mark U+FEFF, the left-to-right and right-to-left marks, the bidirectional controls, the soft
 * hyphen and the rest of the category. Visible writing is not in it: letters, accents, emoji and
 * their variation selectors (category Mn), the no-break space and the ideographic space.
 *
 * The cost of the whole category is the zero-width joiner and non-joiner: an emoji built from
 * several (a family, a profession) and Persian written with its half-space are refused, and can be
 * written without them.
 */
function firstFormatChar(text: string): string | null {
  const hit = FORMAT_CHAR.exec(text.normalize("NFC"));
  if (hit === null) return null;
  const code = hit[0].codePointAt(0) ?? 0;
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * What is wrong with `text` as plain text, in the words `BoardTextSchema` uses, or null if nothing
 * is: an invisible format character first (named, as `U+XXXX`), then a lone surrogate, then a
 * control character or a bidirectional override. Other routes that take a stranger's text (the
 * connect codes, `connect.ts`) refuse by the same rules, in the same words.
 */
export function plainTextFault(text: string): string | null {
  const found = firstFormatChar(text);
  if (found !== null) {
    return `expected plain text, without invisible formatting characters (found ${found})`;
  }
  if (LONE_SURROGATE.test(text)) return "expected well-formed text";
  if (hasForbiddenChar(text)) return "expected plain text, without control characters";
  return null;
}

/**
 * Plain text of 1 to `maxChars` characters once the blanks at its ends are cut, under the board's
 * rules (`BoardTextSchema`, which is this at `BOARD_TEXT_MAX_CHARS`). A service listing's title and
 * description and a hire's request are held to the same rules, each at its own length.
 */
export function plainTextSchema(maxChars: number) {
  return z
    .string()
    .superRefine((text, ctx) => {
      const found = firstFormatChar(text);
      if (found !== null) {
        ctx.addIssue({
          code: "custom",
          message: `expected plain text, without invisible formatting characters (found ${found})`,
        });
      }
    })
    .trim()
    .min(1, "expected some text")
    .refine((text) => !LONE_SURROGATE.test(text), "expected well-formed text")
    .refine((text) => !hasForbiddenChar(text), "expected plain text, without control characters")
    .refine(
      // A text of at most that many UTF-16 units has at most that many code points.
      (text) => text.length <= maxChars || [...text].length <= maxChars,
      `expected at most ${maxChars} characters`,
    );
}

/**
 * The text of a question, an answer or a clarification: plain text of 1 to `BOARD_TEXT_MAX_CHARS`
 * characters once the blanks at its ends are cut. It holds no control character other than a line
 * break or a tab, no bidirectional override and no lone surrogate (which cannot be written as
 * UTF-8), and no invisible format character (`firstFormatChar`): a text that has one is refused
 * with a message that names it, and is never cleaned up and accepted, since what its writer sent
 * is not what the poster would have read. That check comes first, on the text as it was sent,
 * because the cut of the blanks would take a byte order mark off an end without a word. Markup is
 * not refused: it is text, and nothing here reads it as anything else.
 */
export const BoardTextSchema = plainTextSchema(BOARD_TEXT_MAX_CHARS);

// ---- Requests ---------------------------------------------------------------------------------

/** `POST /v1/tasks/:id/questions`. */
export const AskQuestionRequestSchema = z.strictObject({ text: BoardTextSchema });
export type AskQuestionRequest = z.infer<typeof AskQuestionRequestSchema>;

/** `POST /v1/tasks/:id/questions/:question_id/answer`. */
export const AnswerQuestionRequestSchema = z.strictObject({ text: BoardTextSchema });
export type AnswerQuestionRequest = z.infer<typeof AnswerQuestionRequestSchema>;

/** `POST /v1/tasks/:id/clarifications`. */
export const PostClarificationRequestSchema = z.strictObject({ text: BoardTextSchema });
export type PostClarificationRequest = z.infer<typeof PostClarificationRequestSchema>;

// ---- Responses --------------------------------------------------------------------------------

/** The poster's answer to a question. */
export const AnswerSchema = z.object({
  text: z.string(),
  /** ISO 8601 in UTC to the millisecond. */
  answered_at: z.iso.datetime(),
});
export type Answer = z.infer<typeof AnswerSchema>;

/**
 * One question. A question the poster hid has `hidden: true`, no `text` and no `answer`: the page
 * shows `BOARD_HIDDEN_LABEL` instead (`TaskBoard.hidden_label`). Its asker and its time stay.
 * `answer` is null for a question that is not answered yet, and for a hidden one.
 */
export const QuestionSchema = z.object({
  id: U64StringSchema,
  asker: AccountIdSchema,
  text: z.string().nullable(),
  /** ISO 8601 in UTC to the millisecond. */
  asked_at: z.iso.datetime(),
  hidden: z.boolean(),
  answer: AnswerSchema.nullable(),
});
export type Question = z.infer<typeof QuestionSchema>;

/** A standalone post of the poster: an answer to nobody's question. */
export const ClarificationSchema = z.object({
  id: U64StringSchema,
  text: z.string(),
  /** ISO 8601 in UTC to the millisecond. */
  posted_at: z.iso.datetime(),
});
export type Clarification = z.infer<typeof ClarificationSchema>;

/**
 * `GET /v1/tasks/:id/questions`, signed in or not: every question, oldest first, and every
 * clarification, oldest first. `open` is whether the board takes writes now (the task is in its
 * `open` phase); after the commit deadline it is read-only. `note` and `hidden_label` are fixed
 * texts (`BOARD_NOTE`, `BOARD_HIDDEN_LABEL`).
 */
export const TaskBoardSchema = z.object({
  task_id: U64StringSchema,
  open: z.boolean(),
  questions: z.array(QuestionSchema),
  clarifications: z.array(ClarificationSchema),
  hidden_label: z.string(),
  note: z.string(),
});
export type TaskBoard = z.infer<typeof TaskBoardSchema>;

/** `POST …/questions`, `POST …/questions/:id/answer` and `POST …/questions/:id/hide`. */
export const QuestionResponseSchema = z.object({ question: QuestionSchema });
export type QuestionResponse = z.infer<typeof QuestionResponseSchema>;

/** `POST …/clarifications`. */
export const ClarificationResponseSchema = z.object({ clarification: ClarificationSchema });
export type ClarificationResponse = z.infer<typeof ClarificationResponseSchema>;

// ---- Events -----------------------------------------------------------------------------------

/**
 * The events a write to the board adds to the stream (`GET /v1/events`), next to the contract's
 * own. They name the task and the row and carry no text: a page that hears one asks for the board
 * again. A question the poster hides could otherwise be read from the stream by anyone who asks
 * for the events after an old id.
 *
 * The stream's `height` is the index's height when the event was written, and `task_id` the task.
 * An event is told apart from a contract event by its name, and by its receipt id in the database
 * (`board:<event>:<row id>`), which no NEAR receipt can have.
 */
export const BoardEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("question_asked"),
    data: z.object({
      task_id: U64StringSchema,
      question_id: U64StringSchema,
      asker: AccountIdSchema,
    }),
  }),
  z.object({
    event: z.literal("question_answered"),
    data: z.object({ task_id: U64StringSchema, question_id: U64StringSchema }),
  }),
  z.object({
    event: z.literal("question_hidden"),
    data: z.object({ task_id: U64StringSchema, question_id: U64StringSchema }),
  }),
  z.object({
    event: z.literal("clarification_posted"),
    data: z.object({ task_id: U64StringSchema, clarification_id: U64StringSchema }),
  }),
]);
export type BoardEvent = z.infer<typeof BoardEventSchema>;

/** The names of the board's events, in the order the schema lists them. */
export const BOARD_EVENT_NAMES: ReadonlyArray<BoardEvent["event"]> = BoardEventSchema.options.map(
  (option) => option.shape.event.value,
);
