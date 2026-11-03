import { expect, test } from "vitest";
import {
  AnswerQuestionRequestSchema,
  AskQuestionRequestSchema,
  BOARD_EVENT_NAMES,
  BOARD_HIDDEN_LABEL,
  BOARD_LIMITS,
  BOARD_NOTE,
  BOARD_TEXT_MAX_CHARS,
  BoardEventSchema,
  BoardTextSchema,
  ClarificationResponseSchema,
  PostClarificationRequestSchema,
  QuestionResponseSchema,
  TaskBoardSchema,
} from "../src/index";

// The public question board of a task: the limits, the text rule, the shapes of the requests and
// of what the API answers, and the events that tell a page to look again. The routes, the database
// and the tools that use them have their own tests; these hold the rules themselves.

test("the_limits_are_the_ones_the_owner_decided", () => {
  expect(BOARD_TEXT_MAX_CHARS).toBe(1_000);
  expect(BOARD_LIMITS.askerPerTaskPerHour).toBe(5);
  expect(BOARD_LIMITS.askerPerTask).toBe(20);
  expect(BOARD_LIMITS.questionsPerTask).toBe(200);
  // The clarification caps are a ruling of the lane, not the brief's: they only have to exist and
  // be small enough for a poster's own words never to crowd out the questions.
  expect(BOARD_LIMITS.clarificationsPerTask).toBeGreaterThan(0);
  expect(BOARD_LIMITS.clarificationsPerHour).toBeGreaterThan(0);
  expect(BOARD_LIMITS.clarificationsPerTask).toBeLessThanOrEqual(BOARD_LIMITS.questionsPerTask);
  // Hidden questions leave the 200 but not the table: a ceiling on the rows keeps a read bounded.
  expect(BOARD_LIMITS.questionRowsPerTask).toBeGreaterThanOrEqual(BOARD_LIMITS.questionsPerTask);
});

test("the_fixed_note_says_that_the_board_never_changes_the_scoring", () => {
  expect(BOARD_NOTE).toMatch(/Judge/);
  expect(BOARD_NOTE).toMatch(/never reads/i);
  expect(BOARD_NOTE).toMatch(/criteria/i);
  expect(BOARD_HIDDEN_LABEL).toBe("hidden by the poster");
});

test("board_text_is_plain_text_of_at_most_1000_characters", () => {
  const ok = (text: string) => BoardTextSchema.safeParse(text);
  expect(ok("What counts as a version?").success).toBe(true);
  expect(ok("x".repeat(1_000)).success).toBe(true);
  expect(ok("x".repeat(1_001)).success).toBe(false);
  // Characters, not UTF-16 units: 1000 emoji are 2000 units and fit; 1001 do not.
  expect(ok("\u{1F600}".repeat(1_000)).success).toBe(true);
  expect(ok("\u{1F600}".repeat(1_001)).success).toBe(false);
  // The limit is on the text as it is kept: the spaces round it are not part of it.
  expect(ok(` ${"x".repeat(1_000)} `).success).toBe(true);
  expect(BoardTextSchema.parse("  hello \n")).toBe("hello");
});

test("board_text_refuses_what_is_not_plain_text", () => {
  const refused = [
    ["nothing", ""],
    ["only blanks", " \t\n  "],
    ["a NUL, which no text column holds", "a\u0000b"],
    ["a bell", "a\u0007b"],
    ["an escape", "a\u001bb"],
    ["a DEL", "a\u007fb"],
    ["a C1 control", "a\u0085b"],
    ["a lone high surrogate", "a\ud800b"],
    ["a lone low surrogate", "a\udc00b"],
    ["a right-to-left override", `a${String.fromCodePoint(0x202e)}b`],
    ["a bidi isolate", `a${String.fromCodePoint(0x2066)}b`],
  ] as const;
  for (const [what, text] of refused) {
    expect(BoardTextSchema.safeParse(text).success, what).toBe(false);
  }
  // A line break and a tab are part of writing.
  expect(BoardTextSchema.safeParse("line one\nline two\tindented").success).toBe(true);
  expect(BoardTextSchema.safeParse("line one\r\nline two").success).toBe(true);
  // Markup is not refused: it is text, and every reader shows it as text. Code is asked about.
  expect(BoardTextSchema.safeParse("is 1 < 2 and <b>bold</b> a bug?").success).toBe(true);
  expect(BoardTextSchema.safeParse(42).success).toBe(false);
});

test("the_request_bodies_hold_the_text_and_nothing_else", () => {
  for (const schema of [
    AskQuestionRequestSchema,
    AnswerQuestionRequestSchema,
    PostClarificationRequestSchema,
  ]) {
    expect(schema.safeParse({ text: "ok" }).success).toBe(true);
    expect(schema.safeParse({ text: "ok", asker: "alice.near" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ text: "" }).success).toBe(false);
  }
});

const QUESTION = {
  id: "7",
  asker: "alice.test.near",
  text: "Is 1.2 a version?",
  asked_at: "2026-11-03T10:00:00.000Z",
  hidden: false,
  answer: { text: "No: it needs three parts.", answered_at: "2026-11-03T10:05:00.000Z" },
};

test("a_question_is_shown_with_its_text_or_as_hidden_with_none", () => {
  expect(QuestionResponseSchema.parse({ question: QUESTION })).toEqual({ question: QUESTION });
  const hidden = { ...QUESTION, text: null, hidden: true, answer: null };
  expect(QuestionResponseSchema.parse({ question: hidden })).toEqual({ question: hidden });
  // An unanswered question has no answer.
  expect(
    QuestionResponseSchema.safeParse({ question: { ...QUESTION, answer: null } }).success,
  ).toBe(true);
  // The text is a string or null, never missing.
  const { text: _text, ...noText } = QUESTION;
  expect(QuestionResponseSchema.safeParse({ question: noText }).success).toBe(false);
});

test("a_task_board_lists_questions_and_clarifications_and_carries_the_notes", () => {
  const board = {
    task_id: "12",
    open: true,
    questions: [QUESTION],
    clarifications: [{ id: "9", text: "Use UTC.", posted_at: "2026-11-03T10:06:00.000Z" }],
    hidden_label: BOARD_HIDDEN_LABEL,
    note: BOARD_NOTE,
  };
  expect(TaskBoardSchema.parse(board)).toEqual(board);
  // Both fixed notes are part of every read.
  expect(TaskBoardSchema.safeParse({ ...board, note: undefined }).success).toBe(false);
  expect(TaskBoardSchema.safeParse({ ...board, hidden_label: undefined }).success).toBe(false);
  expect(
    ClarificationResponseSchema.parse({
      clarification: { id: "9", text: "Use UTC.", posted_at: "2026-11-03T10:06:00.000Z" },
    }).clarification.id,
  ).toBe("9");
});

test("a_board_event_names_the_task_and_the_row_and_carries_no_text", () => {
  const events: unknown[] = [
    {
      event: "question_asked",
      data: { task_id: "12", question_id: "7", asker: "alice.test.near" },
    },
    { event: "question_answered", data: { task_id: "12", question_id: "7" } },
    { event: "question_hidden", data: { task_id: "12", question_id: "7" } },
    { event: "clarification_posted", data: { task_id: "12", clarification_id: "9" } },
  ];
  for (const event of events) expect(BoardEventSchema.safeParse(event).success).toBe(true);
  expect(BOARD_EVENT_NAMES).toEqual([
    "question_asked",
    "question_answered",
    "question_hidden",
    "clarification_posted",
  ]);
  // A chain event is not a board event, and a board event with a missing id is not one either.
  expect(BoardEventSchema.safeParse({ event: "committed", data: {} }).success).toBe(false);
  expect(
    BoardEventSchema.safeParse({ event: "question_answered", data: { task_id: "12" } }).success,
  ).toBe(false);
  // Hidden text must never be replayable from the stream, so no board event has a field for it.
  const parsed = BoardEventSchema.parse({
    event: "question_asked",
    data: { task_id: "12", question_id: "7", asker: "alice.test.near", text: "leaked" },
  });
  expect(JSON.stringify(parsed)).not.toContain("leaked");
});
