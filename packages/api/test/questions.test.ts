import { randomBytes } from "node:crypto";
import { addQuestion } from "@tender/db";
import { applyBlock } from "@tender/indexer";
import {
  blockOf,
  eventLine,
  FIXTURE_ACCOUNTS,
  FIXTURE_OPTIONS,
  LIFECYCLE_TASK_ID,
} from "@tender/indexer/testing";
import {
  BOARD_HIDDEN_LABEL,
  BOARD_LIMITS,
  BOARD_NOTE,
  BOARD_TEXT_MAX_CHARS,
  BoardEventSchema,
  ClarificationResponseSchema,
  type Phase,
  QuestionResponseSchema,
  sha256Hex,
  TaskBoardSchema,
  type TenderEvent,
} from "@tender/shared";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { AuthVariables, RequireAuth } from "../src/auth";
import { handleError } from "../src/format";
import { type ApiDeps, createApp, type ErrorBody } from "../src/index";
import { DEFAULT_RATE_LIMITS, rateLimitsOf } from "../src/limits";
import { questionRoutes } from "../src/routes/questions";
import { eventRoutes } from "../src/sse";
import { resetDb, seedLifecycle, TEST_NOW, testDeps } from "./helpers";

// The public question board of a task. The routes are mounted on an app of their own with
// `stubAuth`, which reads the signed-in account from a header, so most tests do not sign in; the
// test that ends `_requires_sign_in` holds `createApp` to refusing a request without a bearer token
// and to accepting one that a real sign-in could have issued. The data is written by the indexer
// from the captured event logs, as in production: task 1 is the lifecycle's, which is settled, and
// the others are open or in a later phase at `TEST_NOW`. Alice, bob and the judge are registered
// agents, as the lifecycle leaves them; the poster and carol are not. The clock is a variable, so a
// test can move it across a deadline. The limits themselves have `db`'s tests; what is held here is
// that each one reaches the caller as the status, the code and the `Retry-After` it should.

const { poster, judge, alice, bob, carol } = FIXTURE_ACCOUNTS;
const SECOND = 1_000_000_000n;

let deps: ApiDeps;
let nowNs = TEST_NOW;
let nextHeight = 100n;

beforeAll(async () => {
  deps = await testDeps({ now: () => nowNs });
});

afterAll(() => deps.db.close());

beforeEach(async () => {
  await resetDb(deps.db);
  nowNs = TEST_NOW;
  // The lifecycle's blocks occupy heights 60 to 90, and a block applied at a height already used
  // would be skipped, so every extra block gets a height of its own above them.
  nextHeight = 100n;
});

/** Applies one block of its own in which each of `lines` has a receipt. */
function apply(...lines: string[]): Promise<number> {
  return applyBlock(deps.db, blockOf(nextHeight++, lines), FIXTURE_OPTIONS);
}

/** A stand-in for sign-in: the account is the `x-test-account` header, and no header is no sign-in. */
const stubAuth: RequireAuth = async (c, next) => {
  const account = c.req.header("x-test-account");
  if (account === undefined) {
    const body: ErrorBody = { error: "unauthorized", message: "sign in first" };
    return c.json(body, 401);
  }
  c.set("account", account);
  await next();
};

/** The board's routes alone, under `/v1`, with the API's error handler. */
function appWith(over: Partial<ApiDeps> = {}): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError(handleError);
  app.route("/v1", questionRoutes({ ...deps, ...over }, stubAuth));
  return app;
}

type Requester = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

interface Reply<T> {
  status: number;
  body: T;
  headers: Headers;
}

interface Send {
  account?: string;
  body?: unknown;
  /** A body sent as it is, for one that is not JSON. */
  raw?: string;
  app?: Requester;
  headers?: Record<string, string>;
}

async function send<T = unknown>(
  method: "GET" | "POST",
  path: string,
  o: Send = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = { ...o.headers };
  if (o.account !== undefined) headers["x-test-account"] = o.account;
  let body: string | undefined;
  if (o.raw !== undefined) body = o.raw;
  else if (o.body !== undefined) body = JSON.stringify(o.body);
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await (o.app ?? appWith()).request(path, { method, headers, body });
  return { status: res.status, body: (await res.json()) as T, headers: res.headers };
}

// ---- The routes, by name ----------------------------------------------------------------------

interface QuestionBody {
  question: {
    id: string;
    asker: string;
    text: string | null;
    asked_at: string;
    hidden: boolean;
    answer: { text: string; answered_at: string } | null;
  };
}

interface ClarificationBody {
  clarification: { id: string; text: string; posted_at: string };
}

const board = (task: string, app?: Requester) =>
  send<unknown>("GET", `/v1/tasks/${task}/questions`, { app });
const ask = (task: string, account: string | undefined, text: unknown, app?: Requester) =>
  send<QuestionBody & ErrorBody>("POST", `/v1/tasks/${task}/questions`, {
    account,
    body: { text },
    app,
  });
const answer = (
  task: string,
  question: string,
  account: string | undefined,
  text: unknown,
  app?: Requester,
) =>
  send<QuestionBody & ErrorBody>("POST", `/v1/tasks/${task}/questions/${question}/answer`, {
    account,
    body: { text },
    app,
  });
const hide = (task: string, question: string, account: string | undefined, app?: Requester) =>
  send<QuestionBody & ErrorBody>("POST", `/v1/tasks/${task}/questions/${question}/hide`, {
    account,
    app,
  });
const clarify = (task: string, account: string | undefined, text: unknown, app?: Requester) =>
  send<ClarificationBody & ErrorBody>("POST", `/v1/tasks/${task}/clarifications`, {
    account,
    body: { text },
    app,
  });

// ---- Data -------------------------------------------------------------------------------------

type TaskCreated = Extract<TenderEvent, { event: "task_created" }>["data"];
type OpenPhase = Exclude<Phase, "settled">;
const PHASE_ORDER: OpenPhase[] = ["open", "revealing", "judging", "fallback", "expired"];

/**
 * Deadlines 60 seconds apart that put a task in `phase` at `TEST_NOW`, 30 seconds from the nearest
 * deadline on either side.
 */
function windowsFor(
  phase: OpenPhase,
): Pick<
  TaskCreated,
  "created_at" | "commit_deadline" | "reveal_deadline" | "pick_deadline" | "fallback_deadline"
> {
  const commit = TEST_NOW + (60n * BigInt(1 - PHASE_ORDER.indexOf(phase)) - 30n) * SECOND;
  return {
    created_at: String(commit - 100n * SECOND),
    commit_deadline: String(commit),
    reveal_deadline: String(commit + 60n * SECOND),
    pick_deadline: String(commit + 120n * SECOND),
    fallback_deadline: String(commit + 180n * SECOND),
  };
}

const taskLine = (id: number, phase: OpenPhase, over: Partial<TaskCreated> = {}) =>
  eventLine("task_created", { id: String(id), ...windowsFor(phase), ...over });

/**
 * The lifecycle's task 1 (settled) and the tasks of every phase at `TEST_NOW`: 2 is open, 3
 * revealing, 4 judging, 5 in the fallback window, 6 expired, 7 open, and 8 open to any registered
 * agent (it names nobody). Tasks 2 to 7 invite alice and bob, as the captured log does; the poster
 * is `poster` and the verifier `judge` on all of them.
 */
async function seedBoard(): Promise<void> {
  await seedLifecycle(deps.db);
  await apply(
    ...PHASE_ORDER.map((phase, i) => taskLine(i + 2, phase)),
    taskLine(7, "open"),
    taskLine(8, "open", { invited: [] }),
  );
}

const registerAgent = (account: string) => apply(eventLine("agent_registered", { account }));

const count = async (table: "task_questions" | "events") => {
  const [row] = await deps.db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return row?.n ?? 0;
};

/** The events the board's writes added, oldest first. */
const boardEvents = () =>
  deps.db.query<{
    id: string;
    event: string;
    data: Record<string, unknown>;
    task_id: string;
    receipt_id: string;
  }>(
    `select id::text as id, event, data, task_id::text as task_id, receipt_id
       from events where receipt_id like 'board:%' order by id`,
  );

/** `n` questions from `asker` that were asked two hours ago, so that none counts for the hour. */
async function backfillOld(task: string, n: number, asker: string): Promise<void> {
  await deps.db.query(
    `insert into task_questions (task_id, kind, asker, body, created_at)
     select $1::numeric, 'question', $2, 'an old question ' || g, now() - interval '2 hours'
       from generate_series(1, $3::int) g`,
    [task, asker, n],
  );
}

/** A token as sign-in would have issued it: stored by its hash, for a full-access key. */
async function tokenFor(account: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await deps.db.query(
    `insert into auth_tokens (token_sha256, account, public_key, key_kind, expires_at)
     values ($1, $2, 'ed25519:test', 'full_access', $3::timestamptz)`,
    [sha256Hex(token), account, new Date(Number(TEST_NOW / 1_000_000n) + 3_600_000).toISOString()],
  );
  return token;
}

// ---- Reading ----------------------------------------------------------------------------------

test("the_board_is_public_and_every_read_carries_the_fixed_notes", async () => {
  await seedBoard();

  // Signed out, on an open task with nothing on it yet.
  const empty = await board("2");
  expect(empty.status).toBe(200);
  expect(empty.body).toEqual({
    task_id: "2",
    open: true,
    questions: [],
    clarifications: [],
    hidden_label: BOARD_HIDDEN_LABEL,
    note: BOARD_NOTE,
  });
  expect(empty.body).toEqual(TaskBoardSchema.parse(empty.body));

  // `open` is whether the board takes writes now, the phase's, and the notes are the same.
  for (const [id, open] of [
    ["3", false],
    ["4", false],
    ["5", false],
    ["6", false],
    [LIFECYCLE_TASK_ID, false],
    ["7", true],
    ["8", true],
  ] as const) {
    const res = await board(id);
    expect(res.status, `task ${id}`).toBe(200);
    const read = TaskBoardSchema.parse(res.body);
    expect(read.open, `task ${id}`).toBe(open);
    expect(read.note, `task ${id}`).toBe(BOARD_NOTE);
    expect(read.hidden_label, `task ${id}`).toBe(BOARD_HIDDEN_LABEL);
  }

  // The note says what the brief requires of it.
  expect(BOARD_NOTE).toMatch(/Judge never reads/);

  // The real app serves it with no sign-in at all.
  const real = await board("2", createApp(deps));
  expect(real.status).toBe(200);
  expect(real.body).toEqual(empty.body);
});

test("an_unknown_task_or_a_bad_id_is_a_404_on_every_route", async () => {
  await seedBoard();
  for (const id of ["99", "abc", "01", "18446744073709551616", "-1"]) {
    const read = await board(id);
    expect(read.status, `GET ${id}`).toBe(404);
    expect((read.body as ErrorBody).error).toBe("not_found");
    expect((await ask(id, alice, "q?")).status, `ask ${id}`).toBe(404);
    expect((await answer(id, "1", poster, "a")).status, `answer ${id}`).toBe(404);
    expect((await hide(id, "1", poster)).status, `hide ${id}`).toBe(404);
    expect((await clarify(id, poster, "c")).status, `clarify ${id}`).toBe(404);
  }
  expect(await count("task_questions")).toBe(0);
});

test("a_read_lists_asker_text_times_and_answer_oldest_first", async () => {
  await seedBoard();
  const first = await ask("2", alice, "What counts as a version?");
  const second = await ask("2", bob, "Is UTC fine?");
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const answered = await answer("2", first.body.question.id, poster, "Three parts.");
  expect(answered.status).toBe(200);
  const posted = await clarify("2", poster, "All times are UTC.");

  const read = TaskBoardSchema.parse((await board("2")).body);
  expect(read.questions.map((q) => [q.asker, q.text, q.hidden, q.answer?.text ?? null])).toEqual([
    [alice, "What counts as a version?", false, "Three parts."],
    [bob, "Is UTC fine?", false, null],
  ]);
  // Times are ISO 8601 in UTC to the millisecond, for a question and for its answer.
  const [one] = read.questions;
  expect(one?.asked_at).toBe(new Date(one?.asked_at ?? "").toISOString());
  expect(one?.answer?.answered_at).toBe(new Date(one?.answer?.answered_at ?? "").toISOString());
  expect(read.clarifications).toEqual([
    {
      id: posted.body.clarification.id,
      text: "All times are UTC.",
      posted_at: posted.body.clarification.posted_at,
    },
  ]);
  // One sequence for both kinds of row, so a page can order them.
  const ids = [first.body.question.id, second.body.question.id, posted.body.clarification.id].map(
    Number,
  );
  expect(ids).toEqual([...ids].sort((a, b) => a - b));
  expect(new Set(ids).size).toBe(3);

  // A task keeps its board to itself.
  expect(TaskBoardSchema.parse((await board("7")).body).questions).toEqual([]);
});

// ---- Who asks ---------------------------------------------------------------------------------

test("on_a_pinned_task_only_an_invited_account_asks", async () => {
  await seedBoard();
  await registerAgent(carol);

  const fromAlice = await ask("2", alice, "What counts as a version?");
  expect(fromAlice.status).toBe(200);
  const stored = QuestionResponseSchema.parse(fromAlice.body);
  expect(stored.question).toEqual({
    id: expect.stringMatching(/^[1-9][0-9]*$/),
    asker: alice,
    text: "What counts as a version?",
    asked_at: expect.stringMatching(/Z$/),
    hidden: false,
    answer: null,
  });
  expect((await ask("2", bob, "Another one?")).status).toBe(200);

  // Carol is a registered agent but is not invited: the task is pinned to alice and bob.
  const refused = await ask("2", carol, "Can I ask too?");
  expect(refused.status).toBe(403);
  expect(refused.body.error).toBe("not_invited");
  expect(await count("task_questions")).toBe(2);
});

test("on_an_open_task_any_registered_agent_asks_and_nobody_else", async () => {
  await seedBoard();

  // Task 8 names nobody. Alice is a registered agent; carol is not.
  expect((await ask("8", alice, "Is the sample enough?")).status).toBe(200);
  const refused = await ask("8", carol, "Can I ask?");
  expect(refused.status).toBe(403);
  expect(refused.body.error).toBe("not_registered");
  expect(await count("task_questions")).toBe(1);

  // Once she has registered, she can.
  await registerAgent(carol);
  expect((await ask("8", carol, "Can I ask now?")).status).toBe(200);
  expect(await count("task_questions")).toBe(2);
});

test("on_an_open_task_only_an_active_agent_asks_not_one_leaving_or_retired", async () => {
  await seedBoard();
  // The bond events were captured for alice.sandbox; each is patched to carol here.
  const as = (event: "agent_bonded" | "agent_unregistering" | "agent_bond_claimed") =>
    apply(eventLine(event, { account: carol }));
  const refusedAs = async (what: string) => {
    const refused = await ask("8", carol, `Can I ask ${what}?`);
    expect(refused.status, what).toBe(403);
    expect(refused.body.error, what).toBe("not_registered");
  };

  // Registered with a bond, she asks.
  await registerAgent(carol);
  await as("agent_bonded");
  expect((await ask("8", carol, "Can I ask with a bond?")).status).toBe(200);

  // Unregistering, the contract no longer lets her enter an open task, and the board follows.
  await as("agent_unregistering");
  await refusedAs("while leaving");

  // Retired, she cannot either.
  await as("agent_bond_claimed");
  await refusedAs("once retired");
  expect(await count("task_questions")).toBe(1);

  // Registering again makes her active again.
  await registerAgent(carol);
  await as("agent_bonded");
  expect((await ask("8", carol, "Can I ask again?")).status).toBe(200);
  expect(await count("task_questions")).toBe(2);
});

test("on_a_pinned_task_an_invited_account_asks_whatever_its_agent_status", async () => {
  await seedBoard();
  // Alice is invited to task 2, and has left: a pinned task's poster chose its entrants, so the
  // contract wants no registration of them, and neither does the board.
  await apply(eventLine("agent_unregistering", { account: alice }));
  await apply(eventLine("agent_bond_claimed", { account: alice }));
  expect((await ask("2", alice, "Still allowed to ask?")).status).toBe(200);
});

test("the_poster_and_the_verifier_cannot_ask_even_as_registered_agents", async () => {
  await seedBoard();
  await registerAgent(poster);

  for (const task of ["8", "2"]) {
    // The poster says so, rather than "not invited", on the pinned task as well.
    const fromPoster = await ask(task, poster, "Asking myself?");
    expect(fromPoster.status, `task ${task}`).toBe(403);
    expect(fromPoster.body.error, `task ${task}`).toBe("poster_cannot_ask");
    // The judge is registered and is the verifier.
    const fromJudge = await ask(task, judge, "Asking as the verifier?");
    expect(fromJudge.status, `task ${task}`).toBe(403);
    expect(fromJudge.body.error, `task ${task}`).toBe("verifier_cannot_ask");
  }
  expect(await count("task_questions")).toBe(0);
});

// ---- Who answers ------------------------------------------------------------------------------

test("only_the_poster_answers_and_only_once", async () => {
  await seedBoard();
  const asked = await ask("2", alice, "What counts as a version?");
  const id = asked.body.question.id;

  // Not the asker, not another invited account, not the verifier.
  for (const account of [alice, bob, judge, carol]) {
    const res = await answer("2", id, account, "My answer");
    expect(res.status, account).toBe(403);
    expect(res.body.error, account).toBe("not_poster");
  }
  expect(await count("events")).toBeGreaterThan(0);
  expect(TaskBoardSchema.parse((await board("2")).body).questions[0]?.answer).toBeNull();

  const given = await answer("2", id, poster, "Three parts.");
  expect(given.status).toBe(200);
  const parsed = QuestionResponseSchema.parse(given.body);
  expect(parsed.question.id).toBe(id);
  expect(parsed.question.asker).toBe(alice);
  expect(parsed.question.text).toBe("What counts as a version?");
  expect(parsed.question.answer?.text).toBe("Three parts.");
  expect(parsed.question.answer?.answered_at).toMatch(/Z$/);

  // A second answer is refused and the first stands.
  const again = await answer("2", id, poster, "Four parts.");
  expect(again.status).toBe(409);
  expect(again.body.error).toBe("already_answered");
  const read = TaskBoardSchema.parse((await board("2")).body);
  expect(read.questions[0]?.answer?.text).toBe("Three parts.");
});

test("an_answer_needs_a_question_of_this_task", async () => {
  await seedBoard();
  const asked = await ask("2", alice, "A question?");
  const elsewhere = await ask("7", alice, "A question on another task?");
  const posted = await clarify("2", poster, "A clarification.");

  const refused: Array<[string, string, string]> = [
    ["a question that does not exist", "999", "2"],
    ["a question id that is no number", "abc", "2"],
    ["a question id past the largest row", "18446744073709551615", "2"],
    ["a question of another task", elsewhere.body.question.id, "2"],
    ["a clarification, which is not a question", posted.body.clarification.id, "2"],
  ];
  for (const [what, id, task] of refused) {
    const res = await answer(task, id, poster, "An answer");
    expect(res.status, what).toBe(404);
    expect(res.body.error, what).toBe("not_found");
  }
  // None of them touched the real question.
  expect(TaskBoardSchema.parse((await board("2")).body).questions[0]?.answer).toBeNull();
  expect(asked.status).toBe(200);
});

// ---- Hiding -----------------------------------------------------------------------------------

test("the_poster_hides_a_question_and_its_text_and_answer_are_withheld", async () => {
  await seedBoard();
  const spam = "buy my tokens at spam.example, definitely not spam";
  const reply = "I will not discuss it";
  const first = await ask("2", alice, spam);
  const second = await ask("2", bob, "A real question?");
  await answer("2", first.body.question.id, poster, reply);

  // Only the poster hides.
  for (const account of [alice, bob, judge]) {
    const res = await hide("2", first.body.question.id, account);
    expect(res.status, account).toBe(403);
    expect(res.body.error, account).toBe("not_poster");
  }
  expect(TaskBoardSchema.parse((await board("2")).body).questions[0]?.hidden).toBe(false);

  const hidden = await hide("2", first.body.question.id, poster);
  expect(hidden.status).toBe(200);
  expect(hidden.body.question).toEqual({
    id: first.body.question.id,
    asker: alice,
    text: null,
    asked_at: first.body.question.asked_at,
    hidden: true,
    answer: null,
  });

  // The read: the asker and the time stay, the text and the answer do not, the label says why, and
  // the words appear nowhere in the body.
  const res = await board("2");
  const read = TaskBoardSchema.parse(res.body);
  expect(read.hidden_label).toBe("hidden by the poster");
  expect(read.questions).toEqual([
    {
      id: first.body.question.id,
      asker: alice,
      text: null,
      asked_at: first.body.question.asked_at,
      hidden: true,
      answer: null,
    },
    { ...second.body.question },
  ]);
  const raw = JSON.stringify(res.body);
  expect(raw).not.toContain("spam.example");
  expect(raw).not.toContain(reply);

  // The question cannot be answered any more, and hiding it again changes nothing.
  const late = await answer("2", first.body.question.id, poster, "Too late");
  expect(late.status).toBe(409);
  expect(late.body.error).toBe("hidden");
  const twice = await hide("2", first.body.question.id, poster);
  expect(twice.status).toBe(200);
  expect(twice.body.question.hidden).toBe(true);

  // An id that is no question of the task, or a clarification, cannot be hidden.
  const posted = await clarify("2", poster, "A clarification.");
  for (const id of ["999", "abc", "18446744073709551615", posted.body.clarification.id]) {
    expect((await hide("2", id, poster)).status, id).toBe(404);
  }
});

// ---- Clarifications ---------------------------------------------------------------------------

test("only_the_poster_posts_a_clarification", async () => {
  await seedBoard();
  await registerAgent(carol);
  for (const account of [alice, bob, judge, carol]) {
    const res = await clarify("2", account, "A rule change?");
    expect(res.status, account).toBe(403);
    expect(res.body.error, account).toBe("not_poster");
  }
  expect(await count("task_questions")).toBe(0);

  const posted = await clarify("2", poster, "  All times are UTC.  ");
  expect(posted.status).toBe(200);
  const parsed = ClarificationResponseSchema.parse(posted.body);
  expect(parsed.clarification.text).toBe("All times are UTC.");
  expect(parsed.clarification.posted_at).toMatch(/Z$/);
  expect(TaskBoardSchema.parse((await board("2")).body).clarifications).toEqual([
    parsed.clarification,
  ]);
});

// ---- When ------------------------------------------------------------------------------------

test("every_write_is_refused_once_the_task_is_past_its_open_phase", async () => {
  await seedBoard();
  // Rows exist on the closed tasks already, as if written while they were open.
  const closed = ["3", "4", "5", "6", LIFECYCLE_TASK_ID];
  for (const task of closed) {
    await addQuestion(
      deps.db,
      { taskId: BigInt(task), asker: alice, body: "Asked earlier" },
      BOARD_LIMITS,
    );
  }
  const eventsBefore = await count("events");
  const rowsBefore = await count("task_questions");
  const phases: Record<string, string> = {
    "3": "revealing",
    "4": "judging",
    "5": "fallback",
    "6": "expired",
    [LIFECYCLE_TASK_ID]: "settled",
  };

  for (const task of closed) {
    const question =
      (
        await deps.db.query<{ id: string }>(
          "select id::text as id from task_questions where task_id = $1::numeric",
          [task],
        )
      )[0]?.id ?? "0";
    const refusals = [
      await ask(task, alice, "A late question?"),
      await answer(task, question, poster, "A late answer"),
      await hide(task, question, poster),
      await clarify(task, poster, "A late clarification"),
    ];
    for (const res of refusals) {
      expect(res.status, `task ${task}`).toBe(409);
      expect(res.body.error, `task ${task}`).toBe("not_open");
      expect(res.body.message, `task ${task}`).toContain(phases[task] ?? "");
    }
  }
  expect(await count("task_questions")).toBe(rowsBefore);
  expect(await count("events")).toBe(eventsBefore);

  // The board stays readable, with what was there, and says it takes no writes.
  const read = TaskBoardSchema.parse((await board("3")).body);
  expect(read.open).toBe(false);
  expect(read.questions.map((q) => q.text)).toEqual(["Asked earlier"]);
});

test("the_board_closes_at_the_commit_deadline_and_not_a_nanosecond_before", async () => {
  await seedBoard();
  const commit = BigInt(windowsFor("open").commit_deadline);

  nowNs = commit - 1n;
  const asked = await ask("2", alice, "Just in time?");
  expect(asked.status).toBe(200);
  expect(TaskBoardSchema.parse((await board("2")).body).open).toBe(true);
  expect((await clarify("2", poster, "Still open")).status).toBe(200);

  nowNs = commit;
  expect(TaskBoardSchema.parse((await board("2")).body).open).toBe(false);
  expect((await ask("2", bob, "Too late?")).status).toBe(409);
  expect((await answer("2", asked.body.question.id, poster, "Too late")).status).toBe(409);
  expect((await hide("2", asked.body.question.id, poster)).status).toBe(409);
  expect((await clarify("2", poster, "Too late")).status).toBe(409);
  nowNs = 2n ** 64n - 1n;
  expect((await ask("2", bob, "Much too late?")).status).toBe(409);

  // The answer to the one that was asked in time was never given: the board is read-only now.
  expect(TaskBoardSchema.parse((await board("2")).body).questions[0]?.answer).toBeNull();
});

test("refusals_come_in_a_fixed_order_task_then_role_then_phase_then_body", async () => {
  await seedBoard();
  // A caller who may not write is told so, whatever the body.
  const notAllowed = await ask("2", carol, "x".repeat(2_000));
  expect(notAllowed.status).toBe(403);
  // A caller who may write is told the task is closed before the body is looked at.
  const closed = await ask("3", alice, "x".repeat(2_000));
  expect(closed.status).toBe(409);
  // Only then is the body.
  const tooLong = await ask("2", alice, "x".repeat(2_000));
  expect(tooLong.status).toBe(400);
});

// ---- Limits -----------------------------------------------------------------------------------

test("an_asker_gets_five_questions_an_hour_on_a_task_then_a_429_with_retry_after", async () => {
  await seedBoard();
  for (let i = 1; i <= BOARD_LIMITS.askerPerTaskPerHour; i++) {
    expect((await ask("2", alice, `Question ${i}`)).status, `question ${i}`).toBe(200);
  }
  const sixth = await ask("2", alice, "One too many");
  expect(sixth.status).toBe(429);
  expect(sixth.body.error).toBe("rate_limited");
  const wait = Number(sixth.headers.get("retry-after"));
  // The hour runs from the first question, which was asked a moment ago.
  expect(Number.isInteger(wait)).toBe(true);
  expect(wait).toBeGreaterThan(3_500);
  expect(wait).toBeLessThanOrEqual(3_600);
  expect(await count("task_questions")).toBe(5);

  // The limit is the asker's and the task's: bob, and alice on another task, are not held to it.
  expect((await ask("2", bob, "From bob")).status).toBe(200);
  expect((await ask("7", alice, "On another task")).status).toBe(200);
});

test("an_asker_gets_twenty_questions_on_a_task_in_all_and_a_429_that_will_not_pass", async () => {
  await seedBoard();
  await backfillOld("2", BOARD_LIMITS.askerPerTask, alice);

  const refused = await ask("2", alice, "The twenty-first");
  expect(refused.status).toBe(429);
  expect(refused.body.error).toBe("question_limit");
  // Waiting does not help, so no `Retry-After` says to come back.
  expect(refused.headers.get("retry-after")).toBeNull();
  expect((await ask("2", bob, "From bob")).status).toBe(200);
  expect((await ask("7", alice, "On another task")).status).toBe(200);
});

test("a_task_shows_two_hundred_questions_at_most_and_hiding_one_makes_room", async () => {
  await seedBoard();
  // Two hundred askers with one old question each; the accounts need not exist.
  await deps.db.query(
    `insert into task_questions (task_id, kind, asker, body, created_at)
     select 2, 'question', 'user' || g || '.test.near', 'a question ' || g,
            now() - interval '2 hours'
       from generate_series(1, $1::int) g`,
    [BOARD_LIMITS.questionsPerTask],
  );

  const full = await ask("2", alice, "Room for one more?");
  expect(full.status).toBe(409);
  expect(full.body.error).toBe("board_full");
  expect(full.headers.get("retry-after")).toBeNull();
  // The same asker is welcome on a task with room.
  expect((await ask("7", alice, "On another task")).status).toBe(200);

  const [first] = await deps.db.query<{ id: string }>(
    "select min(id)::text as id from task_questions where task_id = 2",
  );
  expect((await hide("2", first?.id ?? "0", poster)).status).toBe(200);
  expect((await ask("2", alice, "Room now")).status).toBe(200);
});

test("the_poster_gets_ten_clarifications_an_hour_then_a_429_with_retry_after", async () => {
  await seedBoard();
  for (let i = 1; i <= BOARD_LIMITS.clarificationsPerHour; i++) {
    expect((await clarify("2", poster, `Note ${i}`)).status, `note ${i}`).toBe(200);
  }
  const over = await clarify("2", poster, "One too many");
  expect(over.status).toBe(429);
  expect(over.body.error).toBe("rate_limited");
  const wait = Number(over.headers.get("retry-after"));
  expect(wait).toBeGreaterThan(3_500);
  expect(wait).toBeLessThanOrEqual(3_600);
  // Another task has a limit of its own.
  expect((await clarify("7", poster, "On another task")).status).toBe(200);
});

test("the_poster_gets_fifty_clarifications_a_task_in_all", async () => {
  await seedBoard();
  await deps.db.query(
    `insert into task_questions (task_id, kind, body, created_at)
     select 2, 'clarification', 'an old note ' || g, now() - interval '2 hours'
       from generate_series(1, $1::int) g`,
    [BOARD_LIMITS.clarificationsPerTask],
  );
  const over = await clarify("2", poster, "The fifty-first");
  expect(over.status).toBe(429);
  expect(over.body.error).toBe("clarification_limit");
  expect(over.headers.get("retry-after")).toBeNull();
  expect((await clarify("7", poster, "On another task")).status).toBe(200);
});

test("board_writes_are_limited_per_account_with_a_429_and_retry_after", async () => {
  await seedBoard();
  expect(DEFAULT_RATE_LIMITS.board.limit).toBeGreaterThan(0);
  expect(rateLimitsOf(undefined).board).toEqual(DEFAULT_RATE_LIMITS.board);

  const app = appWith({ rateLimits: { board: { limit: 3, windowMs: 60_000 } } });
  for (let i = 0; i < 3; i++) {
    expect((await clarify("2", poster, `Note ${i}`, app)).status).toBe(200);
  }
  const over = await clarify("2", poster, "A fourth", app);
  expect(over.status).toBe(429);
  expect(over.body.error).toBe("rate_limited");
  const wait = Number(over.headers.get("retry-after"));
  expect(wait).toBeGreaterThanOrEqual(1);
  expect(wait).toBeLessThanOrEqual(60);
  // The refused request wrote nothing, and the limit counts every kind of write of the account.
  expect(await count("task_questions")).toBe(3);
  expect((await hide("2", "1", poster, app)).status).toBe(429);

  // Another account has a count of its own, though every request here has the same address.
  expect((await ask("2", alice, "From alice", app)).status).toBe(200);
  // A read is not counted at all, and a request that is not signed in is refused before any count.
  for (let i = 0; i < 6; i++) expect((await board("2", app)).status).toBe(200);
  expect((await ask("2", undefined, "Anonymous", app)).status).toBe(401);
});

// ---- Text -------------------------------------------------------------------------------------

test("text_must_be_plain_text_of_one_to_a_thousand_characters_on_every_write", async () => {
  await seedBoard();
  const bad: Array<[string, unknown]> = [
    ["nothing", ""],
    ["only blanks", " \t\n "],
    ["1001 characters", "x".repeat(1_001)],
    ["1001 emoji", "\u{1F600}".repeat(1_001)],
    ["a NUL", "a\u0000b"],
    ["an escape", "a\u001bb"],
    ["a right-to-left override", `a${String.fromCodePoint(0x202e)}b`],
    ["a lone surrogate", "a\ud800b"],
    ["a tag character", `Is it case-sensitive?${String.fromCodePoint(0xe0041)}`],
    ["a zero width space", `a${String.fromCodePoint(0x200b)}b`],
    ["only zero width spaces", String.fromCodePoint(0x200b, 0x200b)],
    ["a byte order mark at the end", `hello${String.fromCodePoint(0xfeff)}`],
    ["a left-to-right mark", `a${String.fromCodePoint(0x200e)}b`],
    ["a number", 42],
    ["null", null],
    ["missing", undefined],
  ];
  for (const [what, text] of bad) {
    // The body is looked at before the question is, so the answer's id need not exist.
    const writes = [
      ["ask", await ask("2", alice, text)],
      ["answer", await answer("2", "1", poster, text)],
      ["clarify", await clarify("2", poster, text)],
    ] as const;
    for (const [route, res] of writes) {
      expect(res.status, `${route}: ${what}`).toBe(400);
      expect(res.body.error, `${route}: ${what}`).toBe("bad_request");
    }
  }
  // An invisible character is refused with the character named, and the text is not cleaned up.
  const smuggled = await ask("2", alice, `visible${String.fromCodePoint(0xe0041)}`);
  expect(smuggled.status).toBe(400);
  expect(JSON.stringify(smuggled.body)).toMatch(/invisible.*U\+E0041/);
  expect(await count("task_questions")).toBe(0);
  expect(await count("events")).toBeGreaterThan(0); // the seeded chain events, and no board's
  expect(await boardEvents()).toEqual([]);

  // A body that is no JSON, no object or has another key is a 400 as well.
  const bodies: Array<[string, Send]> = [
    ["not JSON", { account: alice, raw: "{not json" }],
    ["an array", { account: alice, body: ["text"] }],
    ["no body", { account: alice }],
    ["another key", { account: alice, body: { text: "ok", asker: bob } }],
  ];
  for (const [what, over] of bodies) {
    const res = await send<ErrorBody>("POST", "/v1/tasks/2/questions", over);
    expect(res.status, what).toBe(400);
    expect(res.body.error, what).toBe("bad_request");
  }
  expect(await count("task_questions")).toBe(0);
});

test("an_oversized_body_is_a_413_on_every_write_and_nothing_is_stored", async () => {
  await seedBoard();
  const asked = await ask("2", alice, "What counts as a version?");
  expect(asked.status).toBe(200);
  const rows = await count("task_questions");
  const events = await count("events");
  const questionId = asked.body.question.id;

  // A megabyte of text is far over any valid body: the request is refused as it is read, before it
  // is parsed, so the 1000-character rule is not what answers it.
  const huge = JSON.stringify({ text: "x".repeat(1_048_576) });
  const writes: Array<[string, string, string]> = [
    ["ask", "/v1/tasks/2/questions", alice],
    ["answer", `/v1/tasks/2/questions/${questionId}/answer`, poster],
    ["hide", `/v1/tasks/2/questions/${questionId}/hide`, poster],
    ["clarify", "/v1/tasks/2/clarifications", poster],
  ];
  for (const [route, path, account] of writes) {
    const res = await send<ErrorBody>("POST", path, { account, raw: huge });
    expect(res.status, route).toBe(413);
    expect(res.body.error, route).toBe("payload_too_large");
    expect(res.headers.get("content-type"), route).toContain("application/json");
  }

  // A body with no declared length is counted as it arrives, and stopped at the limit.
  const chunk = new TextEncoder().encode("x".repeat(4_096));
  for (const [route, path, account] of writes) {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 64) return controller.close();
        sent++;
        controller.enqueue(chunk);
      },
    });
    const res = await appWith().request(path, {
      method: "POST",
      headers: { "x-test-account": account, "content-type": "application/json" },
      body: stream,
      // @ts-expect-error `duplex` is needed to send a stream and is missing from the DOM types
      duplex: "half",
    });
    expect(res.status, `${route}, streamed`).toBe(413);
    expect(((await res.json()) as ErrorBody).error, `${route}, streamed`).toBe("payload_too_large");
  }

  // Nothing was written, no event either, and the board is as it was.
  expect(await count("task_questions")).toBe(rows);
  expect(await count("events")).toBe(events);
  expect((await boardEvents()).map((e) => e.event)).toEqual(["question_asked"]);

  // The body is not read for a request that is not signed in: it is a 401, not a 413.
  const unsigned = await send<ErrorBody>("POST", "/v1/tasks/2/questions", { raw: huge });
  expect(unsigned.status).toBe(401);
});

test("the_body_limit_leaves_room_for_every_valid_text_even_written_out_in_escapes", async () => {
  await seedBoard();
  // The widest valid body: 1000 characters outside the first plane, each written as the two
  // escapes of its surrogate pair, 12 bytes a character, which is how some JSON writers send them.
  const escaped = `{"text":"${"\\ud83d\\ude00".repeat(BOARD_TEXT_MAX_CHARS)}"}`;
  expect(escaped.length).toBeGreaterThan(12_000);
  const ok = await send<QuestionBody & ErrorBody>("POST", "/v1/tasks/2/questions", {
    account: alice,
    raw: escaped,
  });
  expect(ok.status).toBe(200);
  expect(ok.body.question.text).toBe("\u{1F600}".repeat(BOARD_TEXT_MAX_CHARS));
  // The same text in its plain form is a third of that, and fits just as well.
  const plain = await ask("2", bob, "\u{1F600}".repeat(BOARD_TEXT_MAX_CHARS));
  expect(plain.status).toBe(200);
});

test("text_is_kept_trimmed_and_whole_up_to_a_thousand_characters", async () => {
  await seedBoard();
  const trimmed = await ask("2", alice, "  Is 1.2 a version?\n");
  expect(trimmed.body.question.text).toBe("Is 1.2 a version?");

  const edge = "x".repeat(1_000);
  const emoji = "\u{1F600}".repeat(1_000);
  const lines = "line one\r\nline two\tindented";
  const first = await ask("2", alice, edge);
  const second = await ask("2", alice, emoji);
  const third = await ask("2", alice, lines);
  expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
  const read = TaskBoardSchema.parse((await board("2")).body);
  expect(read.questions.map((q) => q.text)).toEqual(["Is 1.2 a version?", edge, emoji, lines]);
});

test("markup_is_stored_and_returned_as_the_text_it_is", async () => {
  await seedBoard();
  const markup = `<img src=x onerror="alert(1)"> & <script>steal()</script> [link](javascript:x) {{7*7}} \${x}`;
  const asked = await ask("2", alice, markup);
  expect(asked.status).toBe(200);
  await answer("2", asked.body.question.id, poster, "<b>bold</b> &amp;");
  await clarify("2", poster, "<i>note</i>");

  const res = await send<unknown>("GET", "/v1/tasks/2/questions");
  // Served as data, to be shown as text by whoever reads it: JSON, not a page, and not sniffed.
  expect(res.headers.get("content-type")).toContain("application/json");
  const read = TaskBoardSchema.parse(res.body);
  expect(read.questions[0]?.text).toBe(markup);
  expect(read.questions[0]?.answer?.text).toBe("<b>bold</b> &amp;");
  expect(read.clarifications[0]?.text).toBe("<i>note</i>");
});

// ---- Sign-in ----------------------------------------------------------------------------------

test("every_write_requires_sign_in", async () => {
  await seedBoard();
  const asked = await ask("2", alice, "A question?");
  const id = asked.body.question.id;
  // The real app: a header that stands in for sign-in in the tests above is nothing to it.
  const app = createApp(deps);
  const attempts: Array<Record<string, string>> = [
    {},
    { authorization: "Bearer anything" },
    { authorization: `Bearer ${"A".repeat(43)}` },
    { "x-test-account": poster },
  ];
  const routes: Array<[string, unknown]> = [
    ["/v1/tasks/2/questions", { text: "q" }],
    [`/v1/tasks/2/questions/${id}/answer`, { text: "a" }],
    [`/v1/tasks/2/questions/${id}/hide`, undefined],
    ["/v1/tasks/2/clarifications", { text: "c" }],
  ];
  for (const [path, body] of routes) {
    for (const headers of attempts) {
      const res = await send<ErrorBody>("POST", path, { app, body, headers });
      expect(res.status, path).toBe(401);
      expect(res.headers.get("www-authenticate"), path).toBe("Bearer");
    }
  }
  expect(await count("task_questions")).toBe(1);
  expect(TaskBoardSchema.parse((await board("2")).body).questions[0]?.answer).toBeNull();

  // A token that sign-in issued is the account it was issued to: alice asks, the poster answers.
  const asAlice = { authorization: `Bearer ${await tokenFor(alice)}` };
  const asPoster = { authorization: `Bearer ${await tokenFor(poster)}` };
  const second = await send<QuestionBody>("POST", "/v1/tasks/2/questions", {
    app,
    body: { text: "From a real token" },
    headers: asAlice,
  });
  expect(second.status).toBe(200);
  expect(second.body.question.asker).toBe(alice);
  const given = await send<QuestionBody>("POST", `/v1/tasks/2/questions/${id}/answer`, {
    app,
    body: { text: "Yes" },
    headers: asPoster,
  });
  expect(given.status).toBe(200);
  const forbidden = await send<ErrorBody>("POST", "/v1/tasks/2/clarifications", {
    app,
    body: { text: "Not the poster" },
    headers: asAlice,
  });
  expect(forbidden.status).toBe(403);
});

// ---- Events -----------------------------------------------------------------------------------

/** The frames of `/v1/events` after `since`, read until `n` have come. */
async function streamed(
  since: string,
  n: number,
): Promise<{ text: string; frames: Array<{ id: string; event: string; data: string }> }> {
  const app = new Hono();
  app.onError(handleError);
  app.route("/v1", eventRoutes(deps, { pollMs: 10, pingMs: 60_000 }));
  const res = await app.request("/v1/events", { headers: { "Last-Event-ID": since } });
  expect(res.status).toBe(200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5_000;
  while (text.split("\n\n").length - 1 < n && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  const frames = text
    .split("\n\n")
    .filter((part) => part.includes("event:"))
    .map((part) => {
      const field = (name: string) =>
        part
          .split("\n")
          .find((line) => line.startsWith(`${name}:`))
          ?.slice(name.length + 1)
          .trim() ?? "";
      return { id: field("id"), event: field("event"), data: field("data") };
    });
  return { text, frames };
}

test("each_write_adds_an_event_that_names_the_row_and_carries_no_text", async () => {
  await seedBoard();
  const [mark] = await deps.db.query<{ id: string }>(
    "select coalesce(max(id), 0)::text as id from events",
  );
  const since = mark?.id ?? "0";
  const secrets = ["secret question text", "secret answer text", "secret clarification text"];

  const asked = await ask("2", alice, secrets[0]);
  const id = asked.body.question.id;
  expect((await answer("2", id, poster, secrets[1])).status).toBe(200);
  expect((await hide("2", id, poster)).status).toBe(200);
  const posted = await clarify("2", poster, secrets[2]);

  // Writes that are refused or change nothing add no event: a repeat hide, a stranger, a closed
  // task, a bad body, a second answer.
  await hide("2", id, poster);
  await ask("2", carol, "from a stranger");
  await ask("3", alice, "too late");
  await ask("2", alice, "");
  await answer("2", id, poster, "again");

  const events = await boardEvents();
  const cid = posted.body.clarification.id;
  expect(
    events.map(({ event, data, task_id, receipt_id }) => ({ event, data, task_id, receipt_id })),
  ).toEqual([
    {
      event: "question_asked",
      data: { task_id: "2", question_id: id, asker: alice },
      task_id: "2",
      receipt_id: `board:question_asked:${id}`,
    },
    {
      event: "question_answered",
      data: { task_id: "2", question_id: id },
      task_id: "2",
      receipt_id: `board:question_answered:${id}`,
    },
    {
      event: "question_hidden",
      data: { task_id: "2", question_id: id },
      task_id: "2",
      receipt_id: `board:question_hidden:${id}`,
    },
    {
      event: "clarification_posted",
      data: { task_id: "2", clarification_id: cid },
      task_id: "2",
      receipt_id: `board:clarification_posted:${cid}`,
    },
  ]);
  for (const { event, data } of events) {
    expect(BoardEventSchema.safeParse({ event, data }).success, event).toBe(true);
  }
  // They come after the events that were there, in the order of the writes.
  const ids = events.map((e) => Number(e.id));
  expect(ids).toEqual([...ids].sort((a, b) => a - b));
  expect(ids[0]).toBeGreaterThan(Number(since));

  // The stream, which only reads `events`, tells a page: in that order, with the task, and not a
  // word of what was written, so that hiding a question hides it from the stream's replay too.
  const { text, frames } = await streamed(since, 4);
  expect(frames.map((f) => f.event)).toEqual([
    "question_asked",
    "question_answered",
    "question_hidden",
    "clarification_posted",
  ]);
  expect(frames.map((f) => f.id)).toEqual(events.map((e) => e.id));
  for (const frame of frames) {
    const message = JSON.parse(frame.data) as { task_id: string; event: string; height: string };
    expect(message.task_id).toBe("2");
    expect(message.event).toBe(frame.event);
    expect(message.height).toMatch(/^[0-9]+$/);
  }
  for (const secret of secrets) expect(text).not.toContain(secret);
});
