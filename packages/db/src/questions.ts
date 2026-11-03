import type { Db } from "./adapters";

// The queries of a task's public question board (migration 0004). A board holds questions, each
// with the account that asked it and, once the poster answers, the answer; and clarifications, the
// poster's own posts. See `@tender/shared` (`board.ts`) for the rules, which the API enforces: who
// may write, when, and what text. What lives here is what only the database can decide, because it
// has to be decided at the moment of the insert: the limits on how much a board takes.
//
// Every write is one transaction that writes the row and the event that tells the stream of it
// (`GET /v1/events`, and the Telegram notifier, which read the `events` table). The event names
// the task and the row and carries no text: a question that the poster hides could otherwise be
// read from the stream by anyone who asks for the events after an old id.
//
// THE EVENTS TABLE HAS ONE WRITER IN ORDER. The stream reads `events` in id order and relies on the
// indexer being the only writer, which makes a block's events appear in the order of their ids. A
// write here is a second writer, and it would break that: it could take an id and commit while the
// indexer holds a lower one in an open transaction, and a stream that read the higher id would
// never see the lower. So each write takes a lock that conflicts with an insert into `events`
// (SHARE ROW EXCLUSIVE conflicts with the ROW EXCLUSIVE that an insert takes), waits for the
// indexer's block to commit, and holds the indexer off until it commits itself. Ids then become
// visible in the order they were taken, as before. The lock does not stop reads. It also serializes
// the writes of the board, which is what makes a count and the insert after it one step.

/** One row of a board: a question, or a clarification (`kind`). */
export interface BoardRow {
  /** The row's id, decimal text: one sequence for questions and clarifications. */
  id: string;
  /** The task, decimal text. */
  taskId: string;
  kind: "question" | "clarification";
  /** The account that asked; null for a clarification. */
  asker: string | null;
  /** The question's text, or the clarification's. */
  body: string;
  createdAt: Date;
  /** The poster's answer; null until given, and always null for a clarification. */
  answer: string | null;
  answeredAt: Date | null;
  /** Whether the poster hid the question. The text stays in the row; the API withholds it. */
  hidden: boolean;
}

/**
 * How much a board takes (`BOARD_LIMITS` in `@tender/shared`, which this package does not import).
 * The first four count questions, the last two clarifications; "an hour" is the hour before the
 * write, by the database's clock.
 */
export interface BoardCaps {
  /** Questions one asker may ask on one task in any hour. */
  askerPerTaskPerHour: number;
  /** Questions one asker may ask on one task in all, hidden ones included. */
  askerPerTask: number;
  /** Questions a task shows at once: a hidden one does not count. */
  questionsPerTask: number;
  /** Questions a task keeps at all, hidden ones included. */
  questionRowsPerTask: number;
  /** Clarifications a task keeps. */
  clarificationsPerTask: number;
  /** Clarifications a task takes in any hour. */
  clarificationsPerHour: number;
}

/**
 * A write that was not made, and why. The reasons that pass in a while (`asker_hour`,
 * `clarification_hour`) say how long: `retryAfterSeconds`, whole seconds from 1. The others do not
 * pass by themselves.
 */
export type Refused<Permanent extends string, Hourly extends string> =
  | { ok: false; reason: Permanent }
  | { ok: false; reason: Hourly; retryAfterSeconds: number };

export type AddQuestionResult =
  | { ok: true; row: BoardRow }
  | Refused<"asker_task" | "board_full", "asker_hour">;
export type AddClarificationResult =
  | { ok: true; row: BoardRow }
  | Refused<"clarification_task", "clarification_hour">;
export type AnswerResult =
  | { ok: true; row: BoardRow }
  | { ok: false; reason: "not_found" | "already_answered" | "hidden" };
export type HideResult =
  | { ok: true; row: BoardRow; changed: boolean }
  | { ok: false; reason: "not_found" };

interface RowOut {
  id: string;
  task_id: string;
  kind: "question" | "clarification";
  asker: string | null;
  body: string;
  created_at: Date;
  answer: string | null;
  answered_at: Date | null;
  hidden: boolean;
}

/** The columns of a row, in the names `RowOut` has. */
const COLUMNS = `id::text as id, task_id::text as task_id, kind, asker, body, created_at, answer,
  answered_at, hidden`;

function rowOf(row: RowOut): BoardRow {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    asker: row.asker,
    body: row.body,
    createdAt: row.created_at,
    answer: row.answer,
    answeredAt: row.answered_at,
    hidden: row.hidden,
  };
}

/** `value`, if it is a bigint, and a `TypeError` for anything else: a number past 2^53 loses digits. */
function checked(what: string, value: bigint): bigint {
  if (typeof value !== "bigint") throw new TypeError(`${what} must be a bigint`);
  return value;
}

/**
 * Every row of the task's board, oldest first (questions and clarifications together, by id). A
 * hidden question's text is in the row: withholding it is the API's, not the query's.
 */
export async function listBoard(db: Db, taskId: bigint): Promise<BoardRow[]> {
  const rows = await db.query<RowOut>(
    `select ${COLUMNS} from task_questions where task_id = $1::numeric order by id`,
    [checked("a task id", taskId)],
  );
  return rows.map(rowOf);
}

/**
 * Starts a write: takes the lock that keeps the indexer's transactions and this one apart (see the
 * head of this file). Taken first, before anything is read, and held until the transaction ends.
 */
async function lockEvents(tx: Db): Promise<void> {
  await tx.query("lock table events in share row exclusive mode");
}

/**
 * Adds the event of a write to `events`: `data` is what the stream shows. `height` is the index's
 * height now (0 before the first block), so that the reconcile pass, which reads a run of recent
 * heights as not settled yet, treats it as recent; `block_ts` is the database's time, in
 * nanoseconds as a block's is. The receipt id `board:<event>:<row id>` is unique per write and no
 * NEAR receipt id has a colon.
 */
async function emit(
  tx: Db,
  event: string,
  taskId: string,
  rowId: string,
  data: Record<string, string>,
): Promise<void> {
  await tx.query(
    `insert into events (height, block_ts, receipt_id, log_index, event, data, task_id)
     select coalesce((select max(height) from chain_cursor), 0),
            floor(extract(epoch from clock_timestamp()) * 1000000000)::numeric(40,0),
            $1, 0, $2, $3::jsonb, $4::numeric`,
    [`board:${event}:${rowId}`, event, JSON.stringify(data), taskId],
  );
}

/**
 * Seconds until the oldest of the `cap` most recent rows leaves the hour, i.e. until one more row
 * may be written, whole and at least 1. `filter` selects the rows that count (`$1` is the task and
 * `$2` the asker, where it names one). Null when fewer than `cap` rows are in the hour.
 */
async function waitForHour(
  tx: Db,
  filter: string,
  params: unknown[],
  cap: number,
): Promise<number | null> {
  const [row] = await tx.query<{ wait: number }>(
    `select extract(epoch from (created_at + interval '1 hour' - now()))::float8 as wait
       from task_questions
      where ${filter} and created_at > now() - interval '1 hour'
      order by created_at desc
      offset $${params.length + 1}::int limit 1`,
    [...params, cap - 1],
  );
  return row === undefined ? null : Math.max(1, Math.ceil(row.wait));
}

/**
 * Asks a question, if the board takes it: `asker` has asked fewer than `caps.askerPerTask` on the
 * task and fewer than `caps.askerPerTaskPerHour` in the last hour, and the task shows fewer than
 * `caps.questionsPerTask` questions and keeps fewer than `caps.questionRowsPerTask`. Hidden
 * questions count against the asker, whatever the poster did to them, and do not count against the
 * 200 a task shows. Whether `asker` may ask at all is the API's to decide first.
 *
 * Refused for the first limit that is reached, in this order: `asker_task`, `board_full`,
 * `asker_hour`. Nothing is written then, and no event.
 */
export async function addQuestion(
  db: Db,
  q: { taskId: bigint; asker: string; body: string },
  caps: BoardCaps,
): Promise<AddQuestionResult> {
  const taskId = checked("a task id", q.taskId);
  return db.tx<AddQuestionResult>(async (tx) => {
    await lockEvents(tx);
    const [count] = await tx.query<{ mine: number; visible: number; total: number }>(
      `select count(*) filter (where asker = $2)::int as mine,
              count(*) filter (where not hidden)::int as visible,
              count(*)::int as total
         from task_questions where task_id = $1::numeric and kind = 'question'`,
      [taskId, q.asker],
    );
    const { mine = 0, visible = 0, total = 0 } = count ?? {};
    if (mine >= caps.askerPerTask) return { ok: false, reason: "asker_task" };
    if (visible >= caps.questionsPerTask || total >= caps.questionRowsPerTask) {
      return { ok: false, reason: "board_full" };
    }
    if (mine >= caps.askerPerTaskPerHour) {
      const wait = await waitForHour(
        tx,
        "task_id = $1::numeric and kind = 'question' and asker = $2",
        [taskId, q.asker],
        caps.askerPerTaskPerHour,
      );
      if (wait !== null) return { ok: false, reason: "asker_hour", retryAfterSeconds: wait };
    }
    const [stored] = await tx.query<RowOut>(
      `insert into task_questions (task_id, kind, asker, body)
       values ($1::numeric, 'question', $2, $3)
       returning ${COLUMNS}`,
      [taskId, q.asker, q.body],
    );
    if (stored === undefined) throw new Error("the question was not stored");
    const row = rowOf(stored);
    await emit(tx, "question_asked", row.taskId, row.id, {
      task_id: row.taskId,
      question_id: row.id,
      asker: q.asker,
    });
    return { ok: true, row };
  });
}

/**
 * Posts a clarification, if the task keeps fewer than `caps.clarificationsPerTask` and took fewer
 * than `caps.clarificationsPerHour` in the last hour. Refused for the first limit reached, in this
 * order: `clarification_task`, `clarification_hour`. Whether the account is the poster is the API's.
 */
export async function addClarification(
  db: Db,
  c: { taskId: bigint; body: string },
  caps: BoardCaps,
): Promise<AddClarificationResult> {
  const taskId = checked("a task id", c.taskId);
  return db.tx<AddClarificationResult>(async (tx) => {
    await lockEvents(tx);
    const [count] = await tx.query<{ total: number }>(
      `select count(*)::int as total from task_questions
        where task_id = $1::numeric and kind = 'clarification'`,
      [taskId],
    );
    if ((count?.total ?? 0) >= caps.clarificationsPerTask) {
      return { ok: false, reason: "clarification_task" };
    }
    if ((count?.total ?? 0) >= caps.clarificationsPerHour) {
      const wait = await waitForHour(
        tx,
        "task_id = $1::numeric and kind = 'clarification'",
        [taskId],
        caps.clarificationsPerHour,
      );
      if (wait !== null)
        return { ok: false, reason: "clarification_hour", retryAfterSeconds: wait };
    }
    const [stored] = await tx.query<RowOut>(
      `insert into task_questions (task_id, kind, body)
       values ($1::numeric, 'clarification', $2)
       returning ${COLUMNS}`,
      [taskId, c.body],
    );
    if (stored === undefined) throw new Error("the clarification was not stored");
    const row = rowOf(stored);
    await emit(tx, "clarification_posted", row.taskId, row.id, {
      task_id: row.taskId,
      clarification_id: row.id,
    });
    return { ok: true, row };
  });
}

/** The question `questionId` of the task, locked for the write that follows; null if there is none. */
async function questionOf(tx: Db, taskId: bigint, questionId: bigint): Promise<BoardRow | null> {
  const [row] = await tx.query<RowOut>(
    `select ${COLUMNS} from task_questions
      where id = $1::bigint and task_id = $2::numeric and kind = 'question'
      for update`,
    [checked("a question id", questionId), checked("a task id", taskId)],
  );
  return row === undefined ? null : rowOf(row);
}

/**
 * Stores the poster's answer to a question, once. `not_found` for an id that is no question of the
 * task (a clarification included), `hidden` for a question the poster hid, and `already_answered`
 * for one with an answer. Nothing is written then, and no event.
 */
export async function answerQuestion(
  db: Db,
  a: { taskId: bigint; questionId: bigint; body: string },
): Promise<AnswerResult> {
  return db.tx<AnswerResult>(async (tx) => {
    await lockEvents(tx);
    const question = await questionOf(tx, a.taskId, a.questionId);
    if (question === null) return { ok: false, reason: "not_found" };
    if (question.hidden) return { ok: false, reason: "hidden" };
    if (question.answer !== null) return { ok: false, reason: "already_answered" };
    const [stored] = await tx.query<RowOut>(
      `update task_questions set answer = $2, answered_at = now()
        where id = $1::bigint returning ${COLUMNS}`,
      [question.id, a.body],
    );
    if (stored === undefined) throw new Error("the answer was not stored");
    const row = rowOf(stored);
    await emit(tx, "question_answered", row.taskId, row.id, {
      task_id: row.taskId,
      question_id: row.id,
    });
    return { ok: true, row };
  });
}

/**
 * Hides a question. The row keeps its text and its answer; the API withholds both. Hiding a hidden
 * question changes nothing (`changed` is false) and adds no event. `not_found` for an id that is no
 * question of the task.
 */
export async function hideQuestion(
  db: Db,
  h: { taskId: bigint; questionId: bigint },
): Promise<HideResult> {
  return db.tx<HideResult>(async (tx) => {
    await lockEvents(tx);
    const question = await questionOf(tx, h.taskId, h.questionId);
    if (question === null) return { ok: false, reason: "not_found" };
    if (question.hidden) return { ok: true, row: question, changed: false };
    const [stored] = await tx.query<RowOut>(
      `update task_questions set hidden = true where id = $1::bigint returning ${COLUMNS}`,
      [question.id],
    );
    if (stored === undefined) throw new Error("the question was not hidden");
    const row = rowOf(stored);
    await emit(tx, "question_hidden", row.taskId, row.id, {
      task_id: row.taskId,
      question_id: row.id,
    });
    return { ok: true, row, changed: true };
  });
}
