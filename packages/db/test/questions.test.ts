import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addClarification,
  addQuestion,
  answerQuestion,
  type BoardCaps,
  type Db,
  hideQuestion,
  listBoard,
  migrate,
  openDb,
} from "../src/index";

// The question board's queries. Every write is one transaction that holds the row and the event
// that tells the stream about it, so the tests read both. The limits are passed in (this package
// does not know `@tender/shared`), and the tests use the owner's numbers. Runs on PGlite; with
// `TEST_DATABASE_URL` set it runs on a Postgres server as well, as the rest of this package does.

const POSTGRES_URL = process.env.TEST_DATABASE_URL || undefined;

const CAPS: BoardCaps = {
  askerPerTaskPerHour: 5,
  askerPerTask: 20,
  questionsPerTask: 200,
  questionRowsPerTask: 500,
  clarificationsPerTask: 50,
  clarificationsPerHour: 10,
};

const TASK = 7n;
const OTHER_TASK = 8n;
const ALICE = "alice.test.near";
const BOB = "bob.test.near";

interface Fresh {
  db: Db;
  dispose(): Promise<void>;
}

async function pglite(): Promise<Fresh> {
  const db = await openDb("pglite:memory");
  return { db, dispose: () => db.close() };
}

/** A schema of its own on the server at `url`, so that runs never see each other's tables. */
async function postgres(url: string): Promise<Fresh> {
  const schema = `q_${randomBytes(6).toString("hex")}`;
  const admin = await openDb(url);
  await admin.exec(`create schema ${schema}`);
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const db = await openDb(scoped.toString());
  return {
    db,
    async dispose() {
      await db.close();
      await admin.exec(`drop schema ${schema} cascade`);
      await admin.close();
    },
  };
}

const targets = [
  { name: "pglite", fresh: pglite },
  ...(POSTGRES_URL ? [{ name: "postgres", fresh: () => postgres(POSTGRES_URL) }] : []),
];

describe.each(targets)("the question board on $name", (target) => {
  let fresh: Fresh;
  let db: Db;

  beforeAll(async () => {
    fresh = await target.fresh();
    db = fresh.db;
    await migrate(db);
  }, 60_000);

  afterAll(async () => {
    await fresh?.dispose();
  }, 60_000);

  beforeEach(async () => {
    await db.exec("truncate task_questions, events, chain_cursor restart identity");
  });

  const ask = (asker = ALICE, task = TASK, body = "What is a version?") =>
    addQuestion(db, { taskId: task, asker, body }, CAPS);

  /** Moves the rows of `asker` back in time, out of the hour the limit counts. */
  const age = (hours: number, asker = ALICE) =>
    db.query(
      `update task_questions set created_at = created_at - make_interval(hours => $2::int)
        where asker = $1`,
      [asker, hours],
    );

  const events = () =>
    db.query<{
      event: string;
      data: Record<string, unknown>;
      task_id: string;
      receipt_id: string;
      log_index: number;
      height: string;
      block_ts: string;
    }>(
      `select event, data, task_id::text as task_id, receipt_id, log_index, height::text as height,
              block_ts::text as block_ts
         from events order by id`,
    );

  it("a_question_is_stored_with_its_asker_and_its_time", async () => {
    const result = await ask(ALICE, TASK, "What is a version?");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row).toEqual({
      id: "1",
      taskId: "7",
      kind: "question",
      asker: ALICE,
      body: "What is a version?",
      createdAt: expect.any(Date),
      answer: null,
      answeredAt: null,
      hidden: false,
    });
    expect(await listBoard(db, TASK)).toEqual([result.row]);
  });

  it("a_board_is_read_oldest_first_and_one_task_never_shows_another", async () => {
    await ask(ALICE, TASK, "first");
    await ask(ALICE, OTHER_TASK, "elsewhere");
    await addClarification(db, { taskId: TASK, body: "a note" }, CAPS);
    await ask(BOB, TASK, "second");
    const rows = await listBoard(db, TASK);
    expect(rows.map((row) => [row.kind, row.body])).toEqual([
      ["question", "first"],
      ["clarification", "a note"],
      ["question", "second"],
    ]);
    const ids = rows.map((row) => BigInt(row.id));
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : 1)));
    expect(await listBoard(db, 99n)).toEqual([]);
  });

  it("a_write_adds_its_event_in_the_same_transaction_and_the_event_holds_no_text", async () => {
    await db.query("insert into chain_cursor (source, height) values ('sandbox:t', 123)");
    const asked = await ask(ALICE, TASK, "SECRET-QUESTION-TEXT");
    if (!asked.ok) throw new Error("not asked");
    await answerQuestion(db, {
      taskId: TASK,
      questionId: BigInt(asked.row.id),
      body: "SECRET-ANSWER",
    });
    await addClarification(db, { taskId: TASK, body: "SECRET-NOTE" }, CAPS);
    await hideQuestion(db, { taskId: TASK, questionId: BigInt(asked.row.id) });

    const rows = await events();
    expect(rows.map((row) => row.event)).toEqual([
      "question_asked",
      "question_answered",
      "clarification_posted",
      "question_hidden",
    ]);
    expect(rows.map((row) => row.data)).toEqual([
      { task_id: "7", question_id: "1", asker: ALICE },
      { task_id: "7", question_id: "1" },
      { task_id: "7", clarification_id: "2" },
      { task_id: "7", question_id: "1" },
    ]);
    for (const row of rows) {
      expect(row.task_id).toBe("7");
      expect(row.log_index).toBe(0);
      // The index's height when it was written, and the time of the write in nanoseconds.
      expect(row.height).toBe("123");
      expect(BigInt(row.block_ts)).toBeGreaterThan(1_700_000_000_000_000_000n);
    }
    // No NEAR receipt id has a colon in it, so a board event can not collide with a chain event.
    expect(rows.map((row) => row.receipt_id)).toEqual([
      "board:question_asked:1",
      "board:question_answered:1",
      "board:clarification_posted:2",
      "board:question_hidden:1",
    ]);
    // Hidden text must not be replayable from the stream: nothing of the text is in any event.
    expect(JSON.stringify(rows)).not.toMatch(/SECRET/);
  });

  it("an_event_that_cannot_be_written_takes_its_row_with_it", async () => {
    // A leftover event with the receipt id the first question would get.
    await db.query(
      `insert into events (height, block_ts, receipt_id, log_index, event, data, task_id)
       values (1, 1, 'board:question_asked:1', 0, 'question_asked', '{}', 7)`,
    );
    await expect(ask()).rejects.toThrow();
    expect(await listBoard(db, TASK)).toEqual([]);
  });

  it("the_height_is_zero_before_the_index_has_applied_a_block", async () => {
    await ask();
    expect((await events())[0]?.height).toBe("0");
  });

  describe("the limits on one asker", () => {
    it("five_questions_an_hour_on_a_task_and_the_sixth_waits", async () => {
      for (let i = 0; i < 5; i++) expect((await ask()).ok).toBe(true);
      const sixth = await ask();
      expect(sixth.ok).toBe(false);
      if (sixth.ok) return;
      expect(sixth.reason).toBe("asker_hour");
      if (sixth.reason !== "asker_hour") return; // narrows: only this refusal has a wait
      // The oldest of the five leaves the hour in under an hour, and not at once.
      expect(sixth.retryAfterSeconds).toBeGreaterThan(3_590);
      expect(sixth.retryAfterSeconds).toBeLessThanOrEqual(3_600);
      expect(await listBoard(db, TASK)).toHaveLength(5);
      // Another asker, and the same asker on another task, are not held back.
      expect((await ask(BOB)).ok).toBe(true);
      expect((await ask(ALICE, OTHER_TASK)).ok).toBe(true);
    });

    it("the_hour_slides_with_the_oldest_question", async () => {
      for (let i = 0; i < 5; i++) await ask();
      // The two oldest are an hour and a minute old: three are left in the hour.
      await db.query(
        `update task_questions set created_at = now() - interval '61 minutes'
          where id in (select id from task_questions order by id limit 2)`,
      );
      expect((await ask()).ok).toBe(true);
      expect((await ask()).ok).toBe(true);
      const next = await ask();
      expect(next.ok ? "ok" : next.reason).toBe("asker_hour");
    });

    it("twenty_questions_in_all_on_a_task_and_no_more_however_long_ago", async () => {
      for (let round = 0; round < 4; round++) {
        for (let i = 0; i < 5; i++) expect((await ask()).ok).toBe(true);
        await age(2);
      }
      const last = await ask();
      expect(last.ok).toBe(false);
      if (last.ok) return;
      expect(last.reason).toBe("asker_task");
      expect((await ask(ALICE, OTHER_TASK)).ok).toBe(true);
    });

    it("a_hidden_question_still_counts_against_the_asker", async () => {
      for (let i = 0; i < 5; i++) {
        const asked = await ask();
        if (asked.ok) await hideQuestion(db, { taskId: TASK, questionId: BigInt(asked.row.id) });
      }
      const sixth = await ask();
      expect(sixth.ok ? "ok" : sixth.reason).toBe("asker_hour");
    });
  });

  describe("the limits on a task", () => {
    /** Fills the task with `n` questions from as many askers, without going through the limits. */
    async function fill(n: number, hidden = false) {
      await db.query(
        `insert into task_questions (task_id, kind, asker, body, hidden)
         select $1::numeric, 'question', 'filler' || g || '.test.near', 'q', $3
           from generate_series(1, $2::int) as g`,
        [TASK, n, hidden],
      );
    }

    it("two_hundred_questions_and_the_next_finds_the_board_full", async () => {
      await fill(199);
      expect((await ask()).ok).toBe(true);
      const next = await ask(BOB);
      expect(next.ok ? "ok" : next.reason).toBe("board_full");
      // Another task has a board of its own.
      expect((await ask(BOB, OTHER_TASK)).ok).toBe(true);
    });

    it("a_hidden_question_makes_room_for_another", async () => {
      await fill(200);
      await db.query(
        "update task_questions set hidden = true where id = (select min(id) from task_questions)",
      );
      expect((await ask(BOB)).ok).toBe(true);
      const next = await ask(ALICE);
      expect(next.ok ? "ok" : next.reason).toBe("board_full");
    });

    it("hidden_rows_have_a_ceiling_of_their_own", async () => {
      await fill(500, true);
      const next = await ask(BOB);
      expect(next.ok ? "ok" : next.reason).toBe("board_full");
    });

    it("clarifications_are_not_questions_and_do_not_fill_the_board", async () => {
      await fill(199);
      for (let i = 0; i < 10; i++)
        await addClarification(db, { taskId: TASK, body: `n${i}` }, CAPS);
      expect((await ask()).ok).toBe(true);
    });
  });

  describe("clarifications", () => {
    const note = (task = TASK, body = "use UTC") =>
      addClarification(db, { taskId: task, body }, CAPS);

    it("a_clarification_has_no_asker_and_no_answer", async () => {
      const posted = await note();
      expect(posted.ok).toBe(true);
      if (!posted.ok) return;
      expect(posted.row).toMatchObject({
        kind: "clarification",
        asker: null,
        body: "use UTC",
        answer: null,
        hidden: false,
      });
    });

    it("ten_an_hour_and_fifty_in_all_on_a_task", async () => {
      for (let i = 0; i < 10; i++) expect((await note()).ok).toBe(true);
      const eleventh = await note();
      expect(eleventh.ok).toBe(false);
      if (eleventh.ok) return;
      expect(eleventh.reason).toBe("clarification_hour");
      if (eleventh.reason !== "clarification_hour") return; // narrows: only this refusal has a wait
      expect(eleventh.retryAfterSeconds).toBeGreaterThan(3_590);

      for (let round = 0; round < 4; round++) {
        await db.query("update task_questions set created_at = created_at - interval '2 hours'");
        for (let i = 0; i < 10; i++) expect((await note()).ok).toBe(true);
      }
      await db.query("update task_questions set created_at = created_at - interval '2 hours'");
      const last = await note();
      expect(last.ok ? "ok" : last.reason).toBe("clarification_task");
      expect((await note(OTHER_TASK)).ok).toBe(true);
    });
  });

  describe("answering", () => {
    it("an_answer_is_stored_once_with_its_time", async () => {
      const asked = await ask();
      if (!asked.ok) throw new Error("not asked");
      const id = BigInt(asked.row.id);
      const answered = await answerQuestion(db, {
        taskId: TASK,
        questionId: id,
        body: "three parts",
      });
      expect(answered.ok).toBe(true);
      if (!answered.ok) return;
      expect(answered.row).toMatchObject({ answer: "three parts", answeredAt: expect.any(Date) });
      expect((await listBoard(db, TASK))[0]).toEqual(answered.row);

      const again = await answerQuestion(db, { taskId: TASK, questionId: id, body: "two parts" });
      expect(again).toEqual({ ok: false, reason: "already_answered" });
      expect((await listBoard(db, TASK))[0]?.answer).toBe("three parts");
      expect((await events()).filter((row) => row.event === "question_answered")).toHaveLength(1);
    });

    it("only_a_question_of_this_task_can_be_answered", async () => {
      const asked = await ask(ALICE, OTHER_TASK);
      if (!asked.ok) throw new Error("not asked");
      const note = await addClarification(db, { taskId: TASK, body: "a note" }, CAPS);
      if (!note.ok) throw new Error("not posted");
      const missing = { ok: false, reason: "not_found" };
      expect(
        await answerQuestion(db, { taskId: TASK, questionId: BigInt(asked.row.id), body: "x" }),
      ).toEqual(missing);
      expect(
        await answerQuestion(db, { taskId: TASK, questionId: BigInt(note.row.id), body: "x" }),
      ).toEqual(missing);
      expect(await answerQuestion(db, { taskId: TASK, questionId: 999n, body: "x" })).toEqual(
        missing,
      );
      expect(await events()).toHaveLength(2);
    });

    it("a_hidden_question_takes_no_answer", async () => {
      const asked = await ask();
      if (!asked.ok) throw new Error("not asked");
      const id = BigInt(asked.row.id);
      await hideQuestion(db, { taskId: TASK, questionId: id });
      expect(await answerQuestion(db, { taskId: TASK, questionId: id, body: "x" })).toEqual({
        ok: false,
        reason: "hidden",
      });
    });
  });

  describe("hiding", () => {
    it("hiding_marks_the_row_once_and_adds_one_event", async () => {
      const asked = await ask();
      if (!asked.ok) throw new Error("not asked");
      const id = BigInt(asked.row.id);
      const first = await hideQuestion(db, { taskId: TASK, questionId: id });
      expect(first.ok && first.changed).toBe(true);
      const second = await hideQuestion(db, { taskId: TASK, questionId: id });
      expect(second.ok && second.changed).toBe(false);
      expect((await listBoard(db, TASK))[0]?.hidden).toBe(true);
      expect((await events()).filter((row) => row.event === "question_hidden")).toHaveLength(1);
    });

    it("a_clarification_or_another_tasks_question_cannot_be_hidden", async () => {
      const note = await addClarification(db, { taskId: TASK, body: "a note" }, CAPS);
      const other = await ask(ALICE, OTHER_TASK);
      if (!note.ok || !other.ok) throw new Error("not written");
      const missing = { ok: false, reason: "not_found" };
      expect(await hideQuestion(db, { taskId: TASK, questionId: BigInt(note.row.id) })).toEqual(
        missing,
      );
      expect(await hideQuestion(db, { taskId: TASK, questionId: BigInt(other.row.id) })).toEqual(
        missing,
      );
      expect(await hideQuestion(db, { taskId: TASK, questionId: 999n })).toEqual(missing);
    });

    it("an_answered_question_can_be_hidden_and_keeps_its_answer_in_the_row", async () => {
      const asked = await ask();
      if (!asked.ok) throw new Error("not asked");
      const id = BigInt(asked.row.id);
      await answerQuestion(db, { taskId: TASK, questionId: id, body: "three parts" });
      const hidden = await hideQuestion(db, { taskId: TASK, questionId: id });
      expect(hidden.ok && hidden.row).toMatchObject({ hidden: true, answer: "three parts" });
    });
  });

  it("an_id_must_be_a_bigint", async () => {
    await expect(listBoard(db, "7" as unknown as bigint)).rejects.toThrow(TypeError);
    await expect(
      answerQuestion(db, { taskId: TASK, questionId: 1 as unknown as bigint, body: "x" }),
    ).rejects.toThrow(TypeError);
  });
});

// Needs a Postgres server (`TEST_DATABASE_URL`): PGlite has one connection, so two transactions
// never overlap there and there is nothing to wait for. This is the half of the board's promise
// that only a server can show, so it is skipped without one.
describe.skipIf(POSTGRES_URL === undefined)("a write to the board and the indexer's block", () => {
  it("waits_for_a_block_in_flight_so_that_event_ids_appear_in_the_order_they_were_taken", async () => {
    const url = POSTGRES_URL as string;
    const schema = `q_${randomBytes(6).toString("hex")}`;
    const admin = await openDb(url);
    await admin.exec(`create schema ${schema}`);
    const scoped = new URL(url);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    const indexer = await openDb(scoped.toString());
    const api = await openDb(scoped.toString());
    try {
      await migrate(indexer);
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let inserted: () => void = () => {};
      const insertedFirst = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      // A block in flight: an event inserted, the transaction still open.
      const block = indexer.tx(async (tx) => {
        await tx.query(
          `insert into events (height, block_ts, receipt_id, log_index, event, data, task_id)
           values (1, 1, 'block-receipt', 0, 'committed', '{}', 7)`,
        );
        inserted();
        await held;
      });
      await insertedFirst;

      let written = false;
      const write = addQuestion(api, { taskId: TASK, asker: ALICE, body: "q" }, CAPS).then(
        (result) => {
          written = true;
          return result;
        },
      );
      await delay(500);
      expect(written, "the write went ahead of the block").toBe(false);

      release();
      await block;
      expect((await write).ok).toBe(true);
      const ids = await indexer.query<{ id: string; event: string }>(
        "select id::text as id, event from events order by id",
      );
      expect(ids.map((row) => row.event)).toEqual(["committed", "question_asked"]);
    } finally {
      await indexer.close();
      await api.close();
      await admin.exec(`drop schema ${schema} cascade`);
      await admin.close();
    }
  }, 30_000);
});
