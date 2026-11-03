import {
  addClarification,
  addQuestion,
  answerQuestion,
  type BoardRow,
  hideQuestion,
  listBoard,
} from "@tender/db";
import {
  AnswerQuestionRequestSchema,
  AskQuestionRequestSchema,
  BOARD_HIDDEN_LABEL,
  BOARD_LIMITS,
  BOARD_NOTE,
  type Clarification,
  type ClarificationResponse,
  PostClarificationRequestSchema,
  phaseAt,
  type Question,
  type QuestionResponse,
  type TaskBoard,
  U64StringSchema,
} from "@tender/shared";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import type { AuthVariables, RequireAuth } from "../auth";
import { type ApiDeps, nowNs } from "../deps";
import { badRequest, type ErrorBody, fail, issuesOf, notFound, readJson } from "../format";
import { rateLimit, rateLimitedFor, rateLimitsOf } from "../limits";

// The public question board of a task (owner decision of 2026-11-03; the rules are in
// `@tender/shared`'s `board.ts`, the storage and its limits in `@tender/db`'s `questions.ts`).
//
//   GET  /v1/tasks/:id/questions                        public: every question and clarification
//   POST /v1/tasks/:id/questions                        an entrant asks
//   POST /v1/tasks/:id/questions/:question_id/answer    the poster answers
//   POST /v1/tasks/:id/questions/:question_id/hide      the poster hides a question
//   POST /v1/tasks/:id/clarifications                   the poster posts a clarification
//
// Every write is signed in, and is made only while the task is in its `open` phase, by the time of
// the request: after the commit deadline the board is read-only. A write is checked in this order,
// and the first fault is the answer:
//
//   401  not signed in; 429 over the account's route limit; 413 `payload_too_large` for a body over
//        `MAX_BODY_BYTES`, which is refused as it arrives and never parsed (a request that is not
//        signed in is turned away without being read);
//   404  the task is not one the index holds, or the task's or the question's id is no canonical
//        u64 (or is past the largest row);
//   403  the account may not do this (`not_poster`, `poster_cannot_ask`, `verifier_cannot_ask`,
//        `not_invited`, `not_registered`);
//   409  `not_open`: the task is past its open phase;
//   400  the body is not `{ "text": <plain text of 1 to 1000 characters> }`;
//   then what the database decides, which is the board's own limits (429 `rate_limited` with
//   `Retry-After` for a per-hour count, 429 `question_limit` or `clarification_limit` for a total
//   that does not pass by itself, 409 `board_full`) and what the question allows (404 `not_found`,
//   409 `already_answered`, 409 `hidden`).
//
// The route itself is held to `RateLimits.board` for each account, whatever it writes.
//
// What is written is a stranger's words and is public. It is stored and returned as plain text:
// nothing here reads it as markup or as anything else, and every reader shows it as text. A hidden
// question is returned without its text and without its answer, and keeps its asker and its time.

/** What the routes need of a task row: who may do what, and what `phaseAt` needs. */
interface TaskRow {
  poster: string;
  verifier: string;
  invited: unknown;
  commit_deadline: string;
  reveal_deadline: string;
  pick_deadline: string;
  fallback_deadline: string;
  settled: boolean;
}

/**
 * The most bytes of a request body any write takes (413 `payload_too_large` over it). A valid body
 * is `{"text": ...}` with at most 1000 characters, which is 4 KB of UTF-8 and at most 12 KB for the
 * widest writer, one that spells every character outside the first plane as two `\uXXXX` escapes
 * (12 bytes a character); 16 KiB leaves room for that and for a little spacing, and is far below
 * what a client could make the server read and parse before the text rule was reached.
 */
const MAX_BODY_BYTES = 16_384;

/** The largest id a `bigserial` row has. A larger id is no row's, and Postgres would refuse it. */
const MAX_ROW_ID = 2n ** 63n - 1n;

/** A question as the API shows it. A hidden one has no text and no answer. */
function questionOf(row: BoardRow): Question {
  if (row.asker === null) throw new Error(`question ${row.id} has no asker`);
  return {
    id: row.id,
    asker: row.asker,
    text: row.hidden ? null : row.body,
    asked_at: row.createdAt.toISOString(),
    hidden: row.hidden,
    answer:
      row.hidden || row.answer === null || row.answeredAt === null
        ? null
        : { text: row.answer, answered_at: row.answeredAt.toISOString() },
  };
}

function clarificationOf(row: BoardRow): Clarification {
  return { id: row.id, text: row.body, posted_at: row.createdAt.toISOString() };
}

/** The body of a request, once it fits `schema`: a 400 with the faults otherwise. */
async function bodyOf<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await readJson(c));
  if (!parsed.success)
    return badRequest("the body does not fit its schema", issuesOf(parsed.error));
  return parsed.data;
}

export function questionRoutes(
  deps: ApiDeps,
  requireAuth: RequireAuth,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const perAccount = rateLimit<{ Variables: AuthVariables }>(
    rateLimitsOf(deps.rateLimits).board,
    (c) => c.var.account,
  );

  // Refuses a body over `MAX_BODY_BYTES` as it arrives, by its declared length or, with none, as it
  // is counted. It comes after sign-in and the route limit, so a request that is not signed in is
  // turned away without being read, and before the body is parsed. Every write has it, `hide` too,
  // though that one reads no body: a client has no reason to send one, so one that is huge is refused.
  const tooLarge = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => {
      const body: ErrorBody = {
        error: "payload_too_large",
        message: "the request body is too large",
      };
      return c.json(body, 413);
    },
  });

  /** The task `raw` names, or a 404: an id that is no canonical u64 names none. */
  async function taskOf(raw: string | undefined): Promise<{ id: string; task: TaskRow }> {
    if (raw === undefined || !U64StringSchema.safeParse(raw).success)
      return notFound("no such task");
    const [task] = await deps.db.query<TaskRow>(
      `select poster, verifier, invited,
              commit_deadline::text as commit_deadline,
              reveal_deadline::text as reveal_deadline,
              pick_deadline::text as pick_deadline,
              fallback_deadline::text as fallback_deadline,
              (outcome is not null) as settled
         from tasks
        where id = $1::numeric`,
      [raw],
    );
    if (!task) return notFound("no such task");
    return { id: raw, task };
  }

  const isOpen = (task: TaskRow) => phaseAt(task, nowNs(deps)) === "open";

  /** A 409 unless the task is open now. */
  function requireOpen(task: TaskRow): void {
    const phase = phaseAt(task, nowNs(deps));
    if (phase !== "open") {
      fail(
        409,
        "not_open",
        `the board takes writes only while the task is open, and this one is ${phase}`,
      );
    }
  }

  /** A 403 unless `account` is the task's poster. */
  function requirePoster(task: TaskRow, account: string, what: string): void {
    if (account !== task.poster) fail(403, "not_poster", `only the poster can ${what}`);
  }

  /**
   * A 403 unless `account` may ask on the task. The poster and the verifier never may, whether or
   * not they are invited or registered. On a pinned task (`invited` is not empty) an invited account
   * may; on an open one an active agent may: one that is unregistering or retired has given its
   * bond up (or is on its way to), and the contract no longer lets it enter an open task either.
   */
  async function requireMayAsk(task: TaskRow, account: string): Promise<void> {
    if (account === task.poster) {
      fail(403, "poster_cannot_ask", "the poster answers questions and cannot ask them");
    }
    if (account === task.verifier) {
      fail(403, "verifier_cannot_ask", "the verifier cannot ask questions on its own task");
    }
    const invited = Array.isArray(task.invited) ? task.invited : [];
    if (invited.length > 0) {
      if (!invited.includes(account)) {
        fail(
          403,
          "not_invited",
          "this task is pinned to the accounts it invited; only they can ask",
        );
      }
      return;
    }
    const [agent] = await deps.db.query<{ account: string }>(
      "select account from agents where account = $1 and status = 'active'",
      [account],
    );
    if (agent === undefined) {
      fail(
        403,
        "not_registered",
        "only an active registered agent can ask a question on an open task",
      );
    }
  }

  /** The question id of the route, or a 404: an id past the largest row is no row's. */
  function questionIdOf(raw: string | undefined): bigint {
    if (raw === undefined || !U64StringSchema.safeParse(raw).success) {
      return notFound("no such question");
    }
    const id = BigInt(raw);
    return id > MAX_ROW_ID ? notFound("no such question") : id;
  }

  app.get("/tasks/:id/questions", async (c) => {
    const { id, task } = await taskOf(c.req.param("id"));
    const rows = await listBoard(deps.db, BigInt(id));
    const body: TaskBoard = {
      task_id: id,
      open: isOpen(task),
      questions: rows.filter((row) => row.kind === "question").map(questionOf),
      clarifications: rows.filter((row) => row.kind === "clarification").map(clarificationOf),
      hidden_label: BOARD_HIDDEN_LABEL,
      note: BOARD_NOTE,
    };
    return c.json(body);
  });

  app.post("/tasks/:id/questions", requireAuth, perAccount, tooLarge, async (c) => {
    const { id, task } = await taskOf(c.req.param("id"));
    await requireMayAsk(task, c.var.account);
    requireOpen(task);
    const { text } = await bodyOf(c, AskQuestionRequestSchema);

    const result = await addQuestion(
      deps.db,
      { taskId: BigInt(id), asker: c.var.account, body: text },
      BOARD_LIMITS,
    );
    if (!result.ok) {
      switch (result.reason) {
        case "asker_hour":
          return rateLimitedFor(
            `an account may ask ${BOARD_LIMITS.askerPerTaskPerHour} questions an hour on a task, and you have; try again later`,
            result.retryAfterSeconds,
          );
        case "asker_task":
          return fail(
            429,
            "question_limit",
            `an account may ask ${BOARD_LIMITS.askerPerTask} questions on a task in all, and you have`,
          );
        case "board_full":
          return fail(409, "board_full", "this task's board has all the questions it takes");
      }
    }
    const body: QuestionResponse = { question: questionOf(result.row) };
    return c.json(body);
  });

  app.post(
    "/tasks/:id/questions/:question_id/answer",
    requireAuth,
    perAccount,
    tooLarge,
    async (c) => {
      const { id, task } = await taskOf(c.req.param("id"));
      const questionId = questionIdOf(c.req.param("question_id"));
      requirePoster(task, c.var.account, "answer questions");
      requireOpen(task);
      const { text } = await bodyOf(c, AnswerQuestionRequestSchema);

      const result = await answerQuestion(deps.db, {
        taskId: BigInt(id),
        questionId,
        body: text,
      });
      if (!result.ok) {
        switch (result.reason) {
          case "not_found":
            return notFound("no such question");
          case "hidden":
            return fail(409, "hidden", "the poster hid this question, so it cannot be answered");
          case "already_answered":
            return fail(409, "already_answered", "this question has an answer already");
        }
      }
      const body: QuestionResponse = { question: questionOf(result.row) };
      return c.json(body);
    },
  );

  app.post(
    "/tasks/:id/questions/:question_id/hide",
    requireAuth,
    perAccount,
    tooLarge,
    async (c) => {
      const { id, task } = await taskOf(c.req.param("id"));
      const questionId = questionIdOf(c.req.param("question_id"));
      requirePoster(task, c.var.account, "hide a question");
      requireOpen(task);

      const result = await hideQuestion(deps.db, { taskId: BigInt(id), questionId });
      if (!result.ok) return notFound("no such question");
      const body: QuestionResponse = { question: questionOf(result.row) };
      return c.json(body);
    },
  );

  app.post("/tasks/:id/clarifications", requireAuth, perAccount, tooLarge, async (c) => {
    const { id, task } = await taskOf(c.req.param("id"));
    requirePoster(task, c.var.account, "post a clarification");
    requireOpen(task);
    const { text } = await bodyOf(c, PostClarificationRequestSchema);

    const result = await addClarification(
      deps.db,
      { taskId: BigInt(id), body: text },
      BOARD_LIMITS,
    );
    if (!result.ok) {
      switch (result.reason) {
        case "clarification_hour":
          return rateLimitedFor(
            `a poster may post ${BOARD_LIMITS.clarificationsPerHour} clarifications an hour on a task, and you have; try again later`,
            result.retryAfterSeconds,
          );
        case "clarification_task":
          return fail(
            429,
            "clarification_limit",
            `a task takes ${BOARD_LIMITS.clarificationsPerTask} clarifications in all, and this one has them`,
          );
      }
    }
    const body: ClarificationResponse = { clarification: clarificationOf(result.row) };
    return c.json(body);
  });

  return app;
}
