import { inspect } from "node:util";
import { addClarification, addQuestion, answerQuestion, type Db, hideQuestion } from "@tender/db";
import { applyBlock } from "@tender/indexer";
import {
  blockOf,
  eventLine,
  FIXTURE_ACCOUNTS,
  FIXTURE_BRIEF_HASH,
  FIXTURE_OPTIONS,
  fixtureData,
  lifecycleBlocks,
  putFixtureBlobs,
} from "@tender/indexer/testing";
import { BOARD_LIMITS, type NetworkId } from "@tender/shared";
import { type Bot, HttpError, type Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";
import { createBot, type NotifierOptions, notifierTick, startNotifier } from "../src/index";
import { BOARD_DIGEST_WINDOW_MS, BOARD_DIGESTS_PER_TASK, BOARD_ROW_ALERTS } from "../src/notifier";
import { linkChat, openTestDb, seedAgent, seedEntry, seedTask, watchTag } from "./helpers";

// The notifier runs against one migrated database, emptied before each test (a PGlite takes close to
// a second to open). Chain events come through the real indexer, `applyBlock` with the captured logs
// of @tender/indexer/testing, so `events.task_id` and the projections are what production writes.
// Timer cases seed `tasks` rows directly, because a timer reads rows and no event.
//
// Its Telegram API is fake: a transformer installed after `createBot`'s own wraps them (the last one
// installed runs first), answers every call and records it, so nothing reaches the network. The clock
// is injected, in milliseconds since the epoch; a test moves it by passing the time to `tickAt`.

const WEB_URL = "https://tender.example";
const NETWORK: NetworkId = "testnet";
/** The bot's token. It is in the URL of every request, so no log line may quote that URL. */
const TOKEN = "123:test";

const BOT_INFO: UserFromGetMe = {
  id: 7_000_000_001,
  is_bot: true,
  first_name: "Tender",
  username: "tender_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 2026-10-29T00:00:00Z, which is where `seedTask` starts a task's clock too. */
const T0 = Date.parse("2026-10-29T00:00:00Z");

/** A moment, in milliseconds since the epoch, as the contract writes it: nanoseconds, as text. */
function ns(ms: number): string {
  return (BigInt(ms) * 1_000_000n).toString();
}

/** The five times of a task, in milliseconds since the epoch, as `task_created` patches. */
function schedule(createdAt: number, commitDeadline: number, revealDeadline: number) {
  return {
    created_at: ns(createdAt),
    commit_deadline: ns(commitDeadline),
    reveal_deadline: ns(revealDeadline),
    pick_deadline: ns(revealDeadline + HOUR),
    fallback_deadline: ns(revealDeadline + 2 * HOUR),
  };
}

/** A task that opens at T0 and takes entries for an hour: with the clock at T0 + 10 min, it is new. */
const OPEN = schedule(T0, T0 + HOUR, T0 + 2 * HOUR);
/** The same, taking entries for four days: it is still new after a flood wait of a day. */
const OPEN_FOR_DAYS = schedule(T0, T0 + 96 * HOUR, T0 + 97 * HOUR);

const { poster, judge, alice, bob } = FIXTURE_ACCOUNTS;

/** A `task_created` line for task `id`: open to everyone, with the fixture's brief (title, tags). */
function created(id: string, patch: Record<string, unknown> = {}): string {
  return eventLine("task_created", { id, invited: [], brief_hash: FIXTURE_BRIEF_HASH, ...patch });
}

// The fake Telegram.

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}
const calls: ApiCall[] = [];
/** What Telegram answers a chat instead of "sent", by chat id. */
const refusals = new Map<
  string,
  { error_code: number; description: string; parameters?: Record<string, unknown> }
>();
/** What the network does to a call for a chat instead of getting it an answer: it throws this. */
const failures = new Map<string, Error>();
/** How long each send takes. */
let sendDelayMs = 0;
/** While set, the next send waits for it: a send that is stuck. Later sends are not held. */
let gate: Promise<void> | null = null;
/** Runs as each call to Telegram arrives: a test that needs time to pass during a tick sets it. */
let onSend: (() => void) | undefined;
let sending = 0;
let mostSending = 0;
/** When set, every send after this many calls (in all) is answered with a flood wait of an hour. */
let floodAfter: number | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const fakeTelegram: Transformer = async (_prev, method, payload) => {
  const sent = payload as unknown as Record<string, unknown>;
  calls.push({ method, payload: sent });
  onSend?.();
  sending += 1;
  mostSending = Math.max(mostSending, sending);
  const held = gate;
  gate = null;
  try {
    if (sendDelayMs > 0) await sleep(sendDelayMs);
    if (held !== null) await held;
  } finally {
    sending -= 1;
  }
  if (floodAfter !== null && calls.length > floodAfter) {
    return {
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 3600",
      parameters: { retry_after: 3600 },
    } as never;
  }
  const failure = failures.get(String(sent.chat_id));
  if (failure !== undefined) throw failure;
  const refusal = refusals.get(String(sent.chat_id));
  if (refusal !== undefined) return { ok: false, ...refusal } as never;
  // Telegram answers a sendMessage with the message it made.
  const message = { message_id: calls.length, date: 0, chat: { id: sent.chat_id }, text: "" };
  return { ok: true, result: message } as never;
};

/** A bot on the fake Telegram. Another one is a restarted process. */
function newBot(): Bot {
  const made = createBot({ token: TOKEN, db, webUrl: WEB_URL, botInfo: BOT_INFO });
  made.api.config.use(fakeTelegram);
  return made;
}

/** One message the notifier sent: the chat, the bold label that opens it, and the task it links. */
interface Message {
  chat: string;
  label: string;
  task: string;
  text: string;
}

let seen = 0;

/** The messages sent since the last call. */
function drain(): Message[] {
  const fresh = calls.slice(seen);
  seen = calls.length;
  return fresh.map(({ payload }) => {
    const text = String(payload.text);
    return {
      chat: String(payload.chat_id),
      label: /^<b>(.*?)<\/b>/.exec(text)?.[1] ?? text,
      task: /\/tasks\/(\d+)"/.exec(text)?.[1] ?? "?",
      text,
    };
  });
}

/** Who heard what: `"11 New task #7"` is chat 11 hearing the new-task alert for task 7. */
function lines(messages: Message[]): string[] {
  return messages.map((m) => `${m.chat} ${m.label} #${m.task}`);
}

// The world.

let db: Db;
let bot: Bot;
let clock = T0;
const now = () => new Date(clock);
let height = 1000n;
let errors: MockInstance<Console["error"]>;

beforeAll(async () => {
  db = await openTestDb();
  bot = newBot();
}, 60_000);

afterAll(async () => {
  await db.close();
});

const TABLES = [
  "chain_cursor",
  "events",
  "tasks",
  "funders",
  "entries",
  "agents",
  "blobs",
  "working",
  "task_questions",
  "tg_links",
  "tg_link_nonces",
  "tg_watches",
  "tg_sent",
  "tg_board_digests",
  "worker_cursor",
];

beforeEach(async () => {
  await db.exec(`truncate ${TABLES.join(", ")} restart identity`);
  await putFixtureBlobs(db);
  // A new bot for each test: a wait that Telegram asked for is kept against the bot that was told.
  bot = newBot();
  calls.length = 0;
  seen = 0;
  refusals.clear();
  failures.clear();
  sendDelayMs = 0;
  gate = null;
  onSend = undefined;
  sending = 0;
  mostSending = 0;
  floodAfter = null;
  height = 1000n;
  clock = T0 + 10 * MINUTE;
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  try {
    // A test that expects the notifier to log reads the log with `logged()`, which clears it.
    expect(errors).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

/** What the notifier logged to `console.error` since the last call, one string per call. */
function logged(): string[] {
  const out = errors.mock.calls.map((args) =>
    args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "),
  );
  errors.mockClear();
  return out;
}

/** Applies one block of its own, at the next height, in which each of `eventLines` has a receipt. */
function apply(...eventLines: string[]): Promise<number> {
  return applyBlock(db, blockOf(height++, eventLines), FIXTURE_OPTIONS);
}

interface TickOptions {
  /** The database the notifier works on, such as one that fails. */
  database?: Db;
  /** The bot it sends with. */
  bot?: Bot;
}

/** Runs one tick at `at` (ms since the epoch), and returns what it sent. */
async function tickAt(at: number, options: TickOptions = {}): Promise<Message[]> {
  clock = at;
  await notifierTick({
    db: options.database ?? db,
    bot: options.bot ?? bot,
    webUrl: WEB_URL,
    network: NETWORK,
    now,
  });
  return drain();
}

/** Runs one tick at the current time. */
function tick(options: TickOptions = {}): Promise<Message[]> {
  return tickAt(clock, options);
}

/** `database` with every statement for which `fails` says yes rejected, as a dead connection does. */
function failingWhen(database: Db, fails: (sql: string, params?: unknown[]) => boolean): Db {
  return {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
      fails(sql, params)
        ? Promise.reject(new Error("database unavailable"))
        : database.query<T>(sql, params),
    exec: (sql) => database.exec(sql),
    tx: <T>(fn: (tx: Db) => Promise<T>) => database.tx(fn),
    close: () => database.close(),
  };
}

/** The notifier's place in the event stream, as text; undefined before its first tick. */
async function cursor(): Promise<string | undefined> {
  const [row] = await db.query<{ event_id: string }>(
    "select event_id::text as event_id from worker_cursor where name = 'telegram'",
  );
  return row?.event_id;
}

/** The ids of every event stored, lowest first. */
async function eventIds(): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    "select id::text as id from events order by events.id",
  );
  return rows.map((row) => row.id);
}

/** An agent told the API at `startedAt` (ms since the epoch) that it started on a task. */
async function startWorking(taskId: string, account: string, startedAt: number): Promise<void> {
  await db.query(
    "insert into working (task_id, account, started_at) values ($1, $2, $3::timestamptz)",
    [taskId, account, new Date(startedAt).toISOString()],
  );
}

// ---------------------------------------------------------------------------------------------
// Event alerts.

test("event_alerts_sent_once", async () => {
  // Task 1 of the fixtures, from start to finish. Its invitees are alice and bob, so their owners
  // hear about it; the judge is its verifier. Each block is applied, then the notifier ticks.
  await linkChat(db, 11, poster);
  await linkChat(db, 12, alice);
  await linkChat(db, 13, bob);
  await linkChat(db, 14, judge);
  const blocks = lifecycleBlocks(); // 3 registrations, creation, 2 commits, 2 reveals, the pick
  const createdAt = Number(BigInt(String(fixtureData("task_created").created_at)) / 1_000_000n);
  const applyBlocks = async (from: number, to: number) => {
    for (const block of blocks.slice(from, to)) await applyBlock(db, block, FIXTURE_OPTIONS);
  };

  expect(await tickAt(createdAt - MINUTE)).toEqual([]); // the first run, on an empty stream

  await applyBlocks(0, 4);
  const announced = await tickAt(createdAt + 10_000);
  expect(lines(announced)).toEqual(["11 New task #1", "12 New task #1", "13 New task #1"]);
  expect(announced[0]?.text).toContain("<b>New task</b> · Extract invoice totals");
  expect(announced[0]?.text).toContain('<a href="https://tender.example/tasks/1">Open task</a>');

  await applyBlocks(4, 5); // alice commits
  const first = await tickAt(createdAt + 20_000);
  expect(lines(first)).toEqual(["11 Entry received #1"]);
  expect(first[0]?.text).toContain("now has 1 sealed entry");

  await applyBlocks(5, 6); // bob commits
  const second = await tickAt(createdAt + 30_000);
  expect(lines(second)).toEqual(["11 Entry received #1"]);
  expect(second[0]?.text).toContain("now has 2 sealed entries");

  expect(await tickAt(createdAt + 35_000)).toEqual([]); // nothing new, nothing sent

  await applyBlocks(6, 8); // both reveal: not news
  expect(await tickAt(createdAt + 300_000)).toEqual([]);

  await applyBlocks(8, 9); // the judge picks alice and bob
  const paid = await tickAt(createdAt + 310_000);
  expect(lines(paid)).toEqual(["11 Paid #1", "12 Paid #1", "13 Paid #1", "14 Paid #1"]);
  expect(paid[0]?.text).toContain("alice.test.near won");
  expect(paid[0]?.text).toContain("bob.test.near won");

  expect(await tickAt(createdAt + 320_000)).toEqual([]);
  // Every message is one row of tg_sent and the other way round.
  const rows = await db.query<{ n: number }>("select count(*)::int as n from tg_sent");
  expect(rows[0]?.n).toBe(calls.length);
  expect(calls).toHaveLength(9);
});

test("every_message_is_html_with_link_previews_off", async () => {
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("7", OPEN), eventLine("committed", { task_id: "7" }));
  await tick();
  expect(calls).toHaveLength(2);
  for (const { method, payload } of calls) {
    expect(method).toBe("sendMessage");
    expect(payload.parse_mode).toBe("HTML");
    expect(payload.link_preview_options).toEqual({ is_disabled: true });
  }
});

test("new_task_uses_event_id_field", async () => {
  // task_created carries its id as `id`, where every other task event says `task_id`.
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("42", OPEN));
  const rows = await db.query<{ task_id: string; has_task_id: boolean }>(
    "select task_id::text as task_id, data ? 'task_id' as has_task_id from events",
  );
  expect(rows).toEqual([{ task_id: "42", has_task_id: false }]);

  const sent = await tick();
  expect(lines(sent)).toEqual(["11 New task #42"]);
  expect(sent[0]?.text).toContain("https://tender.example/tasks/42");
  const keys = await db.query<{ dedupe_key: string }>("select dedupe_key from tg_sent");
  expect(keys).toEqual([{ dedupe_key: "new_task:42" }]);
});

test("top_ups_and_voids_are_announced", async () => {
  const carol = "carol.test.near";
  await linkChat(db, 11, poster);
  await linkChat(db, 15, carol);
  await watchTag(db, 16, "extraction");
  await tick();

  await apply(created("7", OPEN));
  expect(lines(await tick())).toEqual(["11 New task #7", "16 New task #7"]);

  // carol tops up: the reward is now 1500003, and two accounts fund the task
  await apply(eventLine("task_topped_up", { task_id: "7" }));
  const grew = await tick();
  expect(lines(grew)).toEqual(["11 Pool grew #7", "15 Pool grew #7", "16 Pool grew #7"]);
  expect(grew[0]?.text).toContain("now pays 1500003 token.test.near from 2 backers");

  // bob tops up too: every top-up is news, because each raises the reward
  await apply(eventLine("task_topped_up", { task_id: "7", funder: bob, reward: "1700003" }));
  const again = await tick();
  expect(lines(again)).toEqual(["11 Pool grew #7", "15 Pool grew #7", "16 Pool grew #7"]);
  expect(again[0]?.text).toContain("now pays 1700003 token.test.near from 3 backers");

  // the task is voided: the poster and the funders are refunded; the watcher has no stake
  await apply(eventLine("voided", { task_id: "7" }));
  const voided = await tick();
  expect(lines(voided)).toEqual(["11 Refunded #7", "15 Refunded #7"]);
  expect(voided[0]?.text).toContain("no entry met the criteria");
});

test("top_ups_in_one_tick_are_each_announced_with_the_reward_they_made", async () => {
  // The reward in the alert is the event's. By the time the tick reads the first top-up, the task
  // row already holds the second one's reward, so the row would say 1700003 twice, and the second
  // alert would be dropped as a repeat of the first.
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("7", OPEN));
  await tick();
  await apply(eventLine("task_topped_up", { task_id: "7" }));
  await apply(eventLine("task_topped_up", { task_id: "7", funder: bob, reward: "1700003" }));

  const sent = await tick();
  expect(lines(sent)).toEqual(["11 Pool grew #7", "11 Pool grew #7"]);
  expect(sent[0]?.text).toContain("now pays 1500003 token.test.near");
  expect(sent[1]?.text).toContain("now pays 1700003 token.test.near");
});

test("commits_in_one_tick_make_one_alert_with_the_latest_count", async () => {
  // The count is read at tick time, so two commits that one tick reads are one alert, and the key
  // `entry_committed:7:2` keeps the second from sending it again.
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("7", OPEN));
  await tick();
  await apply(eventLine("committed", { task_id: "7" }));
  await apply(eventLine("committed", { task_id: "7", account: bob }));
  const sent = await tick();
  expect(lines(sent)).toEqual(["11 Entry received #7"]);
  expect(sent[0]?.text).toContain("now has 2 sealed entries");
});

test("a_replaced_commit_is_not_news", async () => {
  // A replacement swaps an entry and leaves the count as it was. Had the first commit been
  // announced, its key would hide the replacement anyway. So the first commit is history here, and
  // only the event's `replaced` flag keeps the replacement from announcing "1 sealed entry".
  await linkChat(db, 11, poster);
  await apply(created("7", OPEN));
  await apply(eventLine("committed", { task_id: "7" }));
  expect(await tick()).toEqual([]); // the first run: both events are history
  expect(await cursor()).toBe("2");

  await apply(eventLine("committed", { task_id: "7", replaced: true }));
  expect(await tick()).toEqual([]);
  expect(await cursor()).toBe("3");

  // The next new entry is news again, with the count it made.
  await apply(eventLine("committed", { task_id: "7", account: bob }));
  const sent = await tick();
  expect(lines(sent)).toEqual(["11 Entry received #7"]);
  expect(sent[0]?.text).toContain("now has 2 sealed entries");
});

test("titles_fall_back_to_the_task_number_and_stay_on_one_line", async () => {
  await linkChat(db, 11, poster);
  await linkChat(db, 12, "agent.near");
  await tick();

  // No brief is stored under this hash, so the indexer leaves the title empty.
  await apply(created("7", { ...OPEN, brief_hash: "0".repeat(64) }));
  expect((await tick())[0]?.text).toContain("<b>New task</b> · Task #7");

  // A title that spans lines is one line in the message.
  await db.query("update tasks set title = $1 where id = 7", ["  Summarise\n\nthe   Q3\treport "]);
  await apply(eventLine("committed", { task_id: "7" }));
  expect((await tick())[0]?.text).toContain("<b>Entry received</b> · Summarise the Q3 report now");

  // A title of blanks is no title.
  await db.query("update tasks set title = '   ' where id = 7");
  await apply(eventLine("committed", { task_id: "7", account: bob }));
  expect((await tick())[0]?.text).toContain("<b>Entry received</b> · Task #7 now has 2");

  // An agent that started a task the index does not hold yet still reaches its owner.
  await startWorking("99", "agent.near", clock - MINUTE);
  const sent = await tick();
  expect(lines(sent)).toEqual(["12 Agent working #99"]);
  expect(sent[0]?.text).toContain("agent.near started “Task #99”");
});

test("what_people_wrote_is_escaped_at_the_send", async () => {
  // renderAlert escapes, and render.test.ts has its cases. This pins that what reaches Telegram is
  // the escaped text, for a task's title and for an agent's name.
  const title = "Fix <b>bold</b> & co";
  const agent = "a<i>&co.near";
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("7", OPEN));
  await db.query("update tasks set title = $1 where id = 7", [title]);

  const announced = await tick();
  expect(announced[0]?.text).toContain("<b>New task</b> · Fix &lt;b&gt;bold&lt;/b&gt; &amp; co");
  expect(announced[0]?.text).not.toContain(title);

  await startWorking("7", agent, clock - MINUTE);
  const working = await tick();
  expect(working[0]?.text).toContain(
    "<b>Agent working</b> · a&lt;i&gt;&amp;co.near started “Fix &lt;b&gt;bold&lt;/b&gt; &amp; co”",
  );
  expect(working[0]?.text).not.toContain(agent);
});

// ---------------------------------------------------------------------------------------------
// The stream: the cursor, its start, its order.

test("first_run_starts_at_the_head", async () => {
  await linkChat(db, 11, poster);
  await linkChat(db, 12, "bot.near");
  // History from before the notifier ever ran: a new task and a commit, which it must not announce...
  await apply(created("7", OPEN));
  await apply(eventLine("committed", { task_id: "7" }));
  // ...a task in its reveal window with an entry that is not revealed, and an agent that started a
  // minute ago, which the timers and the working alerts still report on the first tick.
  await seedTask(db, {
    id: "8",
    poster: "other.near",
    title: "Reveal me",
    created_at: ns(T0),
    commit_deadline: ns(clock - MINUTE),
    reveal_deadline: ns(clock + HOUR),
    commit_count: 1,
  });
  await seedEntry(db, "8", "bot.near");
  await startWorking("7", "agent.near", clock - MINUTE);

  expect(lines(await tick())).toEqual(["11 Agent working #7", "12 Reveal now #8"]);
  const rows = await db.query<{ name: string; event_id: string }>(
    "select name, event_id::text as event_id from worker_cursor",
  );
  expect(rows).toEqual([{ name: "telegram", event_id: "2" }]);

  // From then on, what comes after the head is announced.
  await apply(eventLine("committed", { task_id: "7", account: bob }));
  expect(lines(await tick())).toEqual(["11 Entry received #7"]);
  expect(await cursor()).toBe("3");
});

test("first_run_on_an_empty_stream_starts_at_zero", async () => {
  expect(await cursor()).toBeUndefined();
  expect(await tick()).toEqual([]);
  expect(await cursor()).toBe("0");

  await linkChat(db, 11, poster);
  await apply(created("7", OPEN));
  expect(lines(await tick())).toEqual(["11 New task #7"]);
});

test("late_new_task_skipped", async () => {
  // Entries closed when the clock reached the commit deadline, so nobody can act on the news. The
  // deadlines are 1 ns apart from the clock, which a float cannot tell.
  await linkChat(db, 11, poster);
  await tick();
  const nowNs = BigInt(clock) * 1_000_000n;
  const closing = (commitDeadline: bigint) => ({
    ...OPEN,
    commit_deadline: commitDeadline.toString(),
  });
  await apply(created("7", closing(nowNs + 1n))); // 1 ns left
  await apply(created("8", closing(nowNs))); // closes right now
  await apply(created("9", closing(nowNs - 1n))); // closed 1 ns ago
  expect(lines(await tick())).toEqual(["11 New task #7"]);
  expect(await cursor()).toBe("3");
  const keys = await db.query<{ dedupe_key: string }>("select dedupe_key from tg_sent");
  expect(keys).toEqual([{ dedupe_key: "new_task:7" }]);
});

test("event_ids_with_gaps_are_all_read", async () => {
  // A block applied twice stores nothing the second time, but uses an id: the stream has a hole.
  await linkChat(db, 11, poster);
  await tick();
  const block = blockOf(height++, [created("7", OPEN)]);
  await applyBlock(db, block, FIXTURE_OPTIONS);
  await applyBlock(db, block, FIXTURE_OPTIONS);
  await apply(eventLine("committed", { task_id: "7" }));
  expect(await eventIds()).toEqual(["1", "3"]);

  expect(lines(await tick())).toEqual(["11 New task #7", "11 Entry received #7"]);
  expect(await cursor()).toBe("3");
});

test("events_are_read_in_numeric_id_order", async () => {
  // Ids 9, 10 and 11: as text, "10" and "11" sort before "9".
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("1", OPEN), created("2", OPEN), created("3", OPEN));
  for (let i = 0; i < 5; i++)
    await apply(eventLine("agent_registered", { account: `bot${i}.near` }));
  await tick(); // the head is 8
  await apply(eventLine("voided", { task_id: "1" }));
  await apply(eventLine("voided", { task_id: "2" }));
  await apply(eventLine("voided", { task_id: "3" }));
  expect(await eventIds()).toContain("11");

  expect(lines(await tick())).toEqual(["11 Refunded #1", "11 Refunded #2", "11 Refunded #3"]);
});

test("a_batch_is_two_hundred_events", async () => {
  await linkChat(db, 11, poster);
  await tick();
  // 250 events nobody is told about, then a new task at id 251.
  await db.exec(
    `insert into events (height, block_ts, receipt_id, log_index, event, data)
     select 1, 1, 'filler-' || g, 0, 'deposit', '{}'::jsonb from generate_series(1, 250) g`,
  );
  await apply(created("7", OPEN));

  expect(await tick()).toEqual([]);
  expect(await cursor()).toBe("200"); // the last id it read, though none of the 200 was news
  expect(lines(await tick())).toEqual(["11 New task #7"]);
  expect(await cursor()).toBe("251");
});

// ---------------------------------------------------------------------------------------------
// Restarts, and what a failure does to the stream.

test("restart_sends_nothing_twice", async () => {
  await linkChat(db, 11, poster);
  await tick(); // the first run
  await apply(created("7", OPEN));
  await apply(eventLine("committed", { task_id: "7" }));
  expect(lines(await tick())).toEqual(["11 New task #7", "11 Entry received #7"]);

  // A new process: a new bot, and nothing else is remembered but the database.
  const restarted = newBot();
  expect(await tick({ bot: restarted })).toEqual([]);

  // Even if it lost its place and read every event again, the database knows what was sent.
  await db.exec("update worker_cursor set event_id = 0");
  expect(await tick({ bot: restarted })).toEqual([]);
  expect(await cursor()).toBe("2");

  // And it still sends what is new.
  await apply(eventLine("committed", { task_id: "7", account: bob }));
  expect(lines(await tick({ bot: restarted }))).toEqual(["11 Entry received #7"]);
  expect(calls).toHaveLength(3);
});

/** Three tasks announced to one chat in one batch: three alerts, three keys. */
async function threeNewTasks(): Promise<void> {
  await linkChat(db, 11, poster);
  await tick(); // the first run
  await apply(created("1", OPEN), created("2", OPEN), created("3", OPEN));
}

test("restart_sends_nothing_twice: a crash after two of three sends", async () => {
  await threeNewTasks();
  let claims = 0;
  const dying = failingWhen(db, (sql) => sql.includes("into tg_sent") && ++claims === 3);
  await expect(tick({ database: dying })).rejects.toThrow("database unavailable");
  expect(lines(drain())).toEqual(["11 New task #1", "11 New task #2"]);
  expect(await cursor()).toBe("0"); // the batch was not finished

  // The restart reads the whole batch again, and sends what is left.
  expect(lines(await tick({ bot: newBot() }))).toEqual(["11 New task #3"]);
  expect(await cursor()).toBe("3");
});

test("restart_sends_nothing_twice: a crash after the last send, before the cursor moves", async () => {
  await threeNewTasks();
  const dying = failingWhen(db, (sql) => sql.includes("update worker_cursor"));
  await expect(tick({ database: dying })).rejects.toThrow("database unavailable");
  expect(lines(drain())).toEqual(["11 New task #1", "11 New task #2", "11 New task #3"]);
  expect(await cursor()).toBe("0");

  expect(await tick({ bot: newBot() })).toEqual([]);
  expect(await cursor()).toBe("3");
});

test("the_cursor_never_moves_back", async () => {
  // Two notifiers run at once, as when a deploy overlaps the old process. The slow one read up to
  // id 1 and is stuck sending; the other reads up to id 3 and moves the cursor there. When the slow
  // one finishes its batch, it must not move the cursor back.
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("1", OPEN));
  let release = () => {};
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = tick({ bot: newBot() });
  await until(() => calls.length === 1, "the slow tick to start sending");

  await apply(created("2", OPEN), created("3", OPEN));
  expect(lines(await tick())).toEqual(["11 New task #1", "11 New task #2", "11 New task #3"]);
  expect(await cursor()).toBe("3");

  release();
  await slow;
  expect(await cursor()).toBe("3");
  expect(calls).toHaveLength(3); // task 1 was claimed by the slow tick, so the other did not send it
});

test("blocked_chat_is_unlinked", async () => {
  await linkChat(db, 42, poster);
  await linkChat(db, 43, poster);
  await watchTag(db, 42, "extraction");
  await watchTag(db, 43, "json");
  await watchTag(db, 77, "regex"); // watches tags, never linked
  const blocked = { error_code: 403, description: "Forbidden: bot was blocked by the user" };
  refusals.set("42", blocked);
  refusals.set("77", blocked);
  await tick();

  await apply(created("7", OPEN));
  expect(lines(await tick())).toEqual(["42 New task #7", "43 New task #7", "77 New task #7"]);
  // Each unlink leaves one line, so that "why did this chat go quiet" has an answer.
  const unlinks = logged();
  expect(unlinks).toHaveLength(2);
  expect(unlinks[0]).toContain("chat 42");
  expect(unlinks[0]).toContain("403: Forbidden: bot was blocked by the user");
  expect(unlinks[1]).toContain("chat 77");
  // Chats 42 and 77 lost their links and watches; chat 43 keeps its own.
  const links = await db.query<{ chat_id: string }>("select chat_id::text from tg_links");
  expect(links).toEqual([{ chat_id: "43" }]);
  const watches = await db.query<{ chat_id: string; tag: string }>(
    "select chat_id::text as chat_id, tag from tg_watches",
  );
  expect(watches).toEqual([{ chat_id: "43", tag: "json" }]);

  // The next alert for the poster does not call them, and the notifier did not retry or crash.
  await apply(eventLine("committed", { task_id: "7" }));
  expect(lines(await tick())).toEqual(["43 Entry received #7"]);
  const callsPerChat = (chat: string) =>
    calls.filter((call) => String(call.payload.chat_id) === chat).length;
  expect(callsPerChat("42")).toBe(1);
  expect(callsPerChat("77")).toBe(1);
  expect(callsPerChat("43")).toBe(2);
  expect(logged()).toEqual([]); // nothing more to say about the chats that are gone
});

// ---------------------------------------------------------------------------------------------
// A send that fails. What becomes of the alert depends on what the failure says about the message:
// Telegram answered about it (lost for that chat, the tick goes on); Telegram cannot have taken it
// (given back, the tick ends, the next tick sends it); Telegram may have taken it (lost, the tick
// ends). A tick that ends leaves the event cursor where it was.

/**
 * An error as node-fetch makes one for a request that failed. Its message quotes the URL of the
 * request, which holds the bot's token, and one for a failure of the system has the system's code.
 */
function fetchError(reason: string, code?: string): Error {
  const error = new Error(
    `request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, reason: ${reason}`,
  );
  error.name = "FetchError";
  return code === undefined ? error : Object.assign(error, { code, errno: code, type: "system" });
}

/** What grammY throws for a request that failed on the way: its message names the method only. */
function httpError(cause: Error): HttpError {
  return new HttpError("Network request for 'sendMessage' failed!", cause);
}

/** Runs a tick that must fail, and returns what it failed with. */
async function failedTick(options: TickOptions = {}): Promise<Error> {
  const outcome = await tick(options).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome, "the tick should have failed").toBeInstanceOf(Error);
  return outcome as Error;
}

/** The claims on record, each as "chat alert": the chat, and the key of the alert it was to hear. */
async function claims(): Promise<string[]> {
  const rows = await db.query<{ chat_id: string; dedupe_key: string }>(
    "select chat_id::text as chat_id, dedupe_key from tg_sent order by 1, 2",
  );
  return rows.map((row) => `${row.chat_id} ${row.dedupe_key}`);
}

test("a_refused_message_is_lost_for_that_chat_and_the_tick_goes_on", async () => {
  await linkChat(db, 41, poster);
  await linkChat(db, 42, poster);
  await linkChat(db, 43, poster);
  refusals.set("41", { error_code: 400, description: "Bad Request: chat not found" });
  await tick();

  await apply(created("7", OPEN), eventLine("committed", { task_id: "7" }));
  // The batch goes on past the chat that is refused: both alerts reach all three, once.
  expect(lines(await tick())).toEqual([
    "41 New task #7",
    "42 New task #7",
    "43 New task #7",
    "41 Entry received #7",
    "42 Entry received #7",
    "43 Entry received #7",
  ]);
  // Each alert that chat 41 lost has a line: its kind, its task, and what Telegram said. No chat.
  expect(logged()).toEqual([
    "telegram notifier: alert lost: new_task for task 7 (GrammyError 400: Bad Request: chat not found)",
    "telegram notifier: alert lost: entry_committed for task 7 (GrammyError 400: Bad Request: chat not found)",
  ]);

  // Only a 403 unlinks. The cursor moved on, and a lost alert stays sent: it is not tried again.
  const links = await db.query<{ chat_id: string }>(
    "select chat_id::text from tg_links order by 1",
  );
  expect(links.map((row) => row.chat_id)).toEqual(["41", "42", "43"]);
  expect(await cursor()).toBe("2");
  refusals.clear();
  expect(await tick()).toEqual([]);
  expect(logged()).toEqual([]);
});

test.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"])(
  "a_send_that_never_left_the_machine_is_sent_on_the_next_tick: %s",
  async (code) => {
    await linkChat(db, 11, poster);
    await linkChat(db, 12, poster);
    await tick();
    await apply(created("7", OPEN));
    failures.set("11", httpError(fetchError(`connect ${code}`, code)));

    const error = await failedTick();
    expect(error.name).toBe("TransportFailed");
    expect(error.message).toContain(`HttpError ${code}`);
    expect(error.message).toContain("tried again on the next");
    // The tick ended at the first call: chat 12 was not asked, and the batch is not finished.
    expect(lines(drain())).toEqual(["11 New task #7"]);
    expect(await cursor()).toBe("0");
    // The claim went back with the alert: nothing says it was sent, and nothing was lost.
    expect(await claims()).toEqual([]);
    expect(logged()).toEqual([]);

    // Telegram can be reached again. The alert goes to both chats, once.
    failures.clear();
    expect(lines(await tick())).toEqual(["11 New task #7", "12 New task #7"]);
    expect(await cursor()).toBe("1");
    expect(await tick()).toEqual([]);
    expect(logged()).toEqual([]);
  },
);

/** A 429 as Telegram answers one: it took nothing, and asks for `seconds` of quiet. */
function floodWait(seconds: number) {
  return {
    error_code: 429,
    description: `Too Many Requests: retry after ${seconds}`,
    parameters: { retry_after: seconds },
  };
}

test.each([5, 120, 3600, 86_400])(
  "a_flood_wait_is_sat_out_before_the_bot_is_asked_again_and_then_the_alert_is_sent: %i s",
  async (seconds) => {
    // `createBot` sits out a flood wait of up to a minute, three times. A longer one, or one that is
    // still on after the third try, reaches the notifier as a 429. Telegram took nothing, and it
    // asked for quiet: the bot is not asked again, by any tick, until the wait is over.
    await linkChat(db, 11, poster);
    await linkChat(db, 12, poster);
    await tick();
    await apply(created("7", OPEN_FOR_DAYS));
    refusals.set("11", floodWait(seconds));
    refusals.set("12", floodWait(seconds));
    const failedAt = clock;
    const waitMs = seconds * 1000;

    const error = await failedTick();
    expect(error.name).toBe("TransportFailed");
    expect(error.message).toContain("GrammyError 429");
    expect(error.message).toContain(`nothing is sent for ${seconds} s`);
    expect(error.message).toContain("tried again after that");
    expect(lines(drain())).toEqual(["11 New task #7"]); // and the tick ended there
    expect(await cursor()).toBe("0");
    expect(await claims()).toEqual([]); // given back: the alert is still to be sent
    expect(logged()).toEqual([]);

    // Until the wait is over no tick sends a thing, or fails, or logs: it ends before it starts.
    // Telegram would take the message now, and is not asked.
    refusals.clear();
    expect(await tickAt(failedAt + 1)).toEqual([]);
    expect(await tickAt(failedAt + waitMs / 2)).toEqual([]);
    expect(await tickAt(failedAt + waitMs - 1)).toEqual([]);
    expect(await cursor()).toBe("0");
    expect(await claims()).toEqual([]);

    // At the end of the wait the alert goes to both chats, once, and the cursor moves.
    expect(lines(await tickAt(failedAt + waitMs))).toEqual(["11 New task #7", "12 New task #7"]);
    expect(await cursor()).toBe("1");
    expect(await tick()).toEqual([]);
    expect(logged()).toEqual([]);
  },
);

test("what_happens_during_a_flood_wait_is_sent_when_it_is_over", async () => {
  // The held ticks do nothing, so the cursor stays where it was and the news that came in the
  // meantime is read afterwards: an event alert is not looked at again once the cursor has passed it.
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("7", OPEN_FOR_DAYS));
  refusals.set("11", floodWait(600));
  const failedAt = clock;
  await failedTick();
  expect(drain()).toHaveLength(1);

  await apply(created("8", OPEN_FOR_DAYS), eventLine("committed", { task_id: "7" }));
  expect(await tickAt(failedAt + 5 * MINUTE)).toEqual([]);
  expect(await cursor()).toBe("0");
  expect(calls).toHaveLength(1); // the one try that was told to wait

  refusals.clear();
  expect(lines(await tickAt(failedAt + 10 * MINUTE))).toEqual([
    "11 New task #7",
    "11 New task #8",
    "11 Entry received #7",
  ]);
  expect(await cursor()).toBe("3");
  expect(await tick()).toEqual([]);
});

test("a_flood_wait_is_kept_by_the_bot_and_a_new_one_asks_again", async () => {
  // The wait is kept in memory, against the bot that was told. A restart asks Telegram again: at
  // most one request, which a 429 would answer with the wait again.
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("7", OPEN_FOR_DAYS));
  refusals.set("11", floodWait(3600));
  await failedTick();
  expect(drain()).toHaveLength(1);
  expect(await claims()).toEqual([]);

  refusals.clear();
  expect(await tick()).toEqual([]); // the same bot: held
  expect(lines(await tick({ bot: newBot() }))).toEqual(["11 New task #7"]); // a restart
  expect(await claims()).toEqual(["11 new_task:7"]);
});

test("the_loop_logs_a_flood_wait_once_and_does_not_ask_during_it", async () => {
  await linkChat(db, 11, poster);
  const failedAt = clock;
  await withLoop({}, async () => {
    await firstTickDone();
    refusals.set("11", floodWait(3600));
    await apply(created("7", OPEN_FOR_DAYS));
    await until(() => calls.length === 1, "the alert to be tried");
    await until(() => logged().length > 0, "the flood wait to be logged");
    // The loop ticks every 5 ms: plenty of ticks come and go inside the wait.
    clock = failedAt + 30 * MINUTE;
    await sleep(100);
    expect(calls).toHaveLength(1);
    expect(logged()).toEqual([]); // the held ticks say nothing
    refusals.clear();
    clock = failedAt + HOUR;
    await until(async () => (await cursor()) === "1", "the alert to go out once the wait is over");
  });
  expect(lines(drain())).toEqual(["11 New task #7", "11 New task #7"]);
  expect(await claims()).toEqual(["11 new_task:7"]);
});

test.each([
  { name: "no_retry_after", parameters: undefined },
  { name: "a_retry_after_of_zero", parameters: { retry_after: 0 } },
  { name: "a_negative_retry_after", parameters: { retry_after: -30 } },
  { name: "a_retry_after_that_is_text", parameters: { retry_after: "3600" } },
])("a_429_with_no_usable_wait_is_tried_again_on_the_next_tick: $name", async ({ parameters }) => {
  // Nothing says how long to stay away, so the tick ends as it did before and the next goes on.
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("7", OPEN_FOR_DAYS));
  refusals.set("11", {
    error_code: 429,
    description: "Too Many Requests",
    ...(parameters !== undefined && { parameters }),
  });

  const error = await failedTick();
  expect(error.message).toContain("tried again on the next");
  expect(error.message).not.toContain("nothing is sent for");
  expect(lines(drain())).toEqual(["11 New task #7"]);
  expect(await claims()).toEqual([]);

  refusals.clear();
  expect(lines(await tick())).toEqual(["11 New task #7"]);
});

/** What Telegram answers every send once the bot's token is rotated, or was never right. */
const UNAUTHORIZED = { error_code: 401, description: "Unauthorized" };

test("a_rejected_bot_token_gives_the_claim_back_and_the_alerts_go_out_after_a_restart", async () => {
  await linkChat(db, 11, poster);
  await linkChat(db, 12, poster);
  await tick();
  await apply(created("7", OPEN), created("8", OPEN));
  refusals.set("11", UNAUTHORIZED);
  refusals.set("12", UNAUTHORIZED);

  // The first 401 ends the tick: nothing more is asked of Telegram with a token it does not take.
  const error = await failedTick();
  expect(error.name).toBe("TransportFailed");
  expect(error.message).toContain("Telegram rejected the bot token (401)");
  expect(error.message).toContain("tried again on the next");
  expect(lines(drain())).toEqual(["11 New task #7"]);
  expect(await cursor()).toBe("0");
  // Nothing says the alert was sent, and nothing says it was lost: the claim went back.
  expect(await claims()).toEqual([]);
  expect(logged()).toEqual([]);

  // The same on the next tick: one try, one error, nothing lost.
  expect((await failedTick()).message).toContain("Telegram rejected the bot token (401)");
  expect(lines(drain())).toEqual(["11 New task #7"]);
  expect(await claims()).toEqual([]);

  // The operator fixes the token and restarts: a new bot, on the old database. Everything that
  // waited goes out, once, from the old cursor.
  refusals.clear();
  expect(lines(await tick({ bot: newBot() }))).toEqual([
    "11 New task #7",
    "12 New task #7",
    "11 New task #8",
    "12 New task #8",
  ]);
  expect(await cursor()).toBe("2");
  expect(await tick({ bot: newBot() })).toEqual([]);
  expect(logged()).toEqual([]);
});

test("a_rejected_bot_token_is_logged_once_for_each_tick_and_not_for_each_alert", async () => {
  await linkChat(db, 11, poster);
  await linkChat(db, 12, poster);
  await withLoop({}, async () => {
    await firstTickDone();
    refusals.set("11", UNAUTHORIZED);
    refusals.set("12", UNAUTHORIZED);
    // Three alerts for two chats are waiting: six sends, if each were tried.
    await apply(created("7", OPEN), created("8", OPEN), created("9", OPEN));
    await until(() => calls.length >= 4, "the loop to try the alerts again and again");
  });
  // Every tick made one call and logged one line, and none says an alert was lost.
  const tries = calls.length;
  const logs = logged();
  expect(logs).toHaveLength(tries);
  for (const log of logs) {
    expect(log).toContain("telegram notifier: tick failed:");
    expect(log).toContain("Telegram rejected the bot token (401)");
    expect(log).not.toContain("alert lost");
    expect(log).not.toContain(TOKEN);
  }
  expect(await claims()).toEqual([]);
  expect(await cursor()).toBe("0");
});

/**
 * Failures after which Telegram may have the message: a connection that was made and broke, a
 * request that timed out, a reply that could not be read, a 5xx. None is a failure to connect that
 * the system reports at once (see `a_send_that_never_left_the_machine_is_sent_on_the_next_tick`),
 * and the connect that timed out is not one either: only what is known to come before any byte of
 * the request is given back.
 */
const MAY_HAVE_BEEN_TAKEN = [
  {
    name: "a_timeout",
    fail: () => {
      const timedOut = new Error("Request to 'sendMessage' timed out after 60 seconds");
      failures.set("11", httpError(timedOut));
    },
    why: "HttpError",
  },
  {
    name: "a_connection_that_broke_after_the_request_went_out",
    fail: () => {
      failures.set("11", httpError(fetchError("socket hang up", "ECONNRESET")));
    },
    why: "HttpError ECONNRESET",
  },
  {
    name: "a_connect_that_timed_out",
    fail: () => {
      failures.set("11", httpError(fetchError("connect ETIMEDOUT", "ETIMEDOUT")));
    },
    why: "HttpError ETIMEDOUT",
  },
  {
    name: "a_reply_that_is_no_json",
    fail: () => {
      failures.set("11", httpError(fetchError("invalid json response body")));
    },
    why: "HttpError",
  },
  {
    name: "a_5xx",
    fail: () => {
      refusals.set("11", { error_code: 502, description: "Bad Gateway" });
    },
    why: "GrammyError 502: Bad Gateway",
  },
  {
    name: "an_error_of_no_known_kind",
    fail: () => {
      failures.set("11", new Error("boom"));
    },
    why: "Error",
  },
];

test.each(MAY_HAVE_BEEN_TAKEN)(
  "a_send_that_may_have_gone_through_is_lost_and_never_sent_again: $name",
  async ({ fail, why }) => {
    await linkChat(db, 11, poster);
    await linkChat(db, 12, poster);
    await tick();
    await apply(created("7", OPEN), created("8", OPEN));
    fail();

    const error = await failedTick();
    expect(error.name).toBe("TransportFailed");
    expect(error.message).toContain("may have gone through");
    expect(error.message).toContain("is not sent again");
    expect(lines(drain())).toEqual(["11 New task #7"]); // and the tick ended there
    expect(await cursor()).toBe("0");
    // The claim stays: if Telegram has the message, the chat is not sent it twice.
    expect(await claims()).toEqual(["11 new_task:7"]);
    // One line for the lost alert. It names the kind and the task, and not the chat or the token.
    expect(logged()).toEqual([`telegram notifier: alert lost: new_task for task 7 (${why})`]);

    // Telegram answers again. The next tick goes on from the cursor, and skips what was claimed.
    failures.clear();
    refusals.clear();
    expect(lines(await tick())).toEqual(["12 New task #7", "11 New task #8", "12 New task #8"]);
    expect(await cursor()).toBe("2");
    expect(await tick()).toEqual([]);
    expect(logged()).toEqual([]);
  },
);

test("the_tick_stops_at_the_first_transport_failure", async () => {
  // Three chats hear of two new tasks, and a working signal and a reminder wait behind them, for the
  // same three chats. The network drops at chat 12, on the first alert: nothing more is asked of
  // Telegram in the tick, not chat 13, not the second task, not the other two sources of news.
  await linkChat(db, 11, poster);
  await linkChat(db, 12, poster);
  await linkChat(db, 13, poster);
  await tick();
  await apply(created("7", OPEN), created("8", OPEN));
  await startWorking("7", alice, clock - 5 * MINUTE);
  const soon = clock + 30 * MINUTE; // task 9 takes entries for another half hour, after 5 h
  await seedTask(db, {
    id: "9",
    poster,
    created_at: ns(clock - 5 * HOUR),
    commit_deadline: ns(soon),
    reveal_deadline: ns(soon + HOUR),
    pick_deadline: ns(soon + 2 * HOUR),
    fallback_deadline: ns(soon + 3 * HOUR),
  });
  failures.set("12", httpError(fetchError("connect ECONNREFUSED", "ECONNREFUSED")));

  await failedTick();
  expect(lines(drain())).toEqual(["11 New task #7", "12 New task #7"]);
  expect(await cursor()).toBe("0");
  expect(await claims()).toEqual(["11 new_task:7"]); // chat 11 got its message; chat 12's went back
  expect(logged()).toEqual([]);

  // The next tick is the whole pass again, from the old cursor, minus what chat 11 was sent.
  failures.clear();
  expect(lines(await tick())).toEqual([
    "12 New task #7",
    "13 New task #7",
    "11 New task #8",
    "12 New task #8",
    "13 New task #8",
    "11 Agent working #7",
    "12 Agent working #7",
    "13 Agent working #7",
    "11 1 h left #9",
    "12 1 h left #9",
    "13 1 h left #9",
  ]);
  expect(await cursor()).toBe("2");
  expect(await tick()).toEqual([]);
});

test("a_failure_in_the_working_signals_ends_the_tick_before_the_reminders", async () => {
  await linkChat(db, 11, poster);
  await tick();
  await seedTask(db, { id: "7", poster });
  await startWorking("7", alice, clock - 5 * MINUTE);
  const soon = clock + 30 * MINUTE;
  await seedTask(db, {
    id: "9",
    poster,
    created_at: ns(clock - 5 * HOUR),
    commit_deadline: ns(soon),
    reveal_deadline: ns(soon + HOUR),
    pick_deadline: ns(soon + 2 * HOUR),
    fallback_deadline: ns(soon + 3 * HOUR),
  });
  failures.set("11", httpError(fetchError("getaddrinfo ENOTFOUND api.telegram.org", "ENOTFOUND")));

  await failedTick();
  expect(lines(drain())).toEqual(["11 Agent working #7"]); // the reminder was not tried
  failures.clear();
  expect(lines(await tick())).toEqual(["11 Agent working #7", "11 1 h left #9"]);
});

test("a_claim_that_cannot_be_given_back_loses_the_alert_and_says_so", async () => {
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("7", OPEN));
  failures.set("11", httpError(fetchError("connect ECONNREFUSED", "ECONNREFUSED")));
  const stuck = failingWhen(db, (sql) => sql.includes("delete from tg_sent"));

  const error = await failedTick({ database: stuck });
  expect(error.name).toBe("TransportFailed");
  expect(error.message).not.toContain("tried again");
  expect(logged()).toEqual([
    "telegram notifier: alert lost: new_task for task 7 (HttpError ECONNREFUSED; its claim could not be given back)",
  ]);

  // The claim is what it was: the alert is not sent again.
  expect(lines(drain())).toEqual(["11 New task #7"]);
  failures.clear();
  expect(await claims()).toEqual(["11 new_task:7"]);
  expect(await tick()).toEqual([]);
});

test("the_error_that_ends_a_tick_holds_no_token_and_no_cause", async () => {
  // The loop logs this error whole, and node-fetch's message quotes the URL of the request.
  expect(fetchError("connect ECONNREFUSED", "ECONNREFUSED").message).toContain(TOKEN);
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("7", OPEN));
  for (const code of ["ECONNREFUSED", "ECONNRESET"]) {
    failures.set("11", httpError(fetchError(`connect ${code}`, code)));
    const error = await failedTick();
    expect(error.cause, code).toBeUndefined();
    const shown = `${inspect(error)}\n${logged().join("\n")}`;
    expect(shown, code).not.toContain(TOKEN);
    expect(shown, code).not.toContain("api.telegram.org");
  }
});

test("the_loop_rides_out_an_outage_and_sends_what_waited", async () => {
  await linkChat(db, 11, poster);
  await withLoop({}, async () => {
    await firstTickDone();
    failures.set("11", httpError(fetchError("connect ECONNREFUSED", "ECONNREFUSED")));
    await apply(created("7", OPEN));
    await until(() => calls.length >= 3, "the loop to try the alert again and again");
    failures.clear();
    await until(async () => (await cursor()) === "1", "the alert to go out once Telegram answers");
  });
  // Every try was for the one alert, and the last one got through.
  const tries = lines(drain());
  expect(tries.length).toBeGreaterThanOrEqual(4);
  expect(new Set(tries)).toEqual(new Set(["11 New task #7"]));
  expect(await claims()).toEqual(["11 new_task:7"]);
  const logs = logged();
  expect(logs.length).toBeGreaterThanOrEqual(3);
  for (const log of logs) {
    expect(log).toContain("telegram notifier: tick failed:");
    expect(log).toContain("HttpError ECONNREFUSED");
    expect(log).not.toContain(TOKEN);
  }
});

test("a_render_error_skips_only_that_alert", async () => {
  // A deadline that is no u64 makes `renderAlert` throw. The chain cannot produce one, but the
  // column can hold it, and one such task must not stop the alerts behind it.
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("1", OPEN), created("2", OPEN));
  await db.query("update tasks set commit_deadline = $1 where id = 1", ["99999999999999999999999"]);

  expect(lines(await tick())).toEqual(["11 New task #2"]);
  const logs = logged();
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("new_task for task 1");
  // The cursor passed the poisoned event: the next tick neither retries it nor logs it again.
  expect(await cursor()).toBe("2");
  expect(await tick()).toEqual([]);
  expect(logged()).toEqual([]);
});

test("a_recipient_error_skips_only_that_alert", async () => {
  // `invited` that is no array makes the recipient query fail.
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("1", OPEN), created("2", OPEN));
  await db.query("update tasks set invited = '{}'::jsonb where id = 1");

  expect(lines(await tick())).toEqual(["11 New task #2"]);
  const logs = logged();
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("new_task for task 1");
  expect(await cursor()).toBe("2");
  expect(await tick()).toEqual([]);
  expect(logged()).toEqual([]);
});

test("a_recipient_lookup_that_fails_is_tried_again", async () => {
  // A blip in the database, such as a deadlock victim, is not a row that can never be read. The
  // alert is one the cursor is about to pass for good, so it is worth another try.
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("7", OPEN));
  let lookups = 0;
  const blips = failingWhen(db, (sql) => sql.includes("direct_accounts") && ++lookups <= 2);

  expect(lines(await tick({ database: blips }))).toEqual(["11 New task #7"]);
  expect(lookups).toBe(3); // two failures, then the answer
  expect(await cursor()).toBe("1");
});

test("a_recipient_lookup_that_keeps_failing_is_given_up_on_after_three_tries", async () => {
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("1", OPEN), created("2", OPEN));
  let tries = 0; // at the recipients of task 1, which are never found
  const poisoned = failingWhen(db, (sql, params) => {
    const task1 = sql.includes("direct_accounts") && params?.[0] === "1";
    if (task1) tries += 1;
    return task1;
  });

  expect(lines(await tick({ database: poisoned }))).toEqual(["11 New task #2"]);
  expect(tries).toBe(3);
  const logs = logged();
  expect(logs).toHaveLength(1); // the tries before the last are not news
  expect(logs[0]).toContain("new_task for task 1");
  expect(await cursor()).toBe("2");
});

test("a_deadline_that_is_not_a_number_skips_only_its_alert", async () => {
  // The chain cannot write NaN, but the column can hold it. The database makes the late-task check
  // and does not stumble on it. `renderAlert` refuses the deadline, which is that alert's error.
  await linkChat(db, 11, poster);
  await tick();
  await apply(created("1", OPEN), created("2", OPEN));
  await db.query("update tasks set commit_deadline = 'NaN' where id = 1");

  expect(lines(await tick())).toEqual(["11 New task #2"]);
  const logs = logged();
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("new_task for task 1");
  expect(await cursor()).toBe("2");
});

test("events_that_cannot_make_an_alert_are_logged_and_skipped", async () => {
  await linkChat(db, 11, poster);
  await tick();
  // Rows that the indexer would not write but the table can hold. Each is logged and passed over.
  const insert = (receipt: string, data: unknown, taskId: string | null) =>
    db.query(
      `insert into events (height, block_ts, receipt_id, log_index, event, data, task_id)
       values (1, 1, $1, 0, 'committed', $2::jsonb, $3::numeric)`,
      [receipt, JSON.stringify(data), taskId],
    );
  const committed = fixtureData("committed");
  await insert("not-an-event", { nonsense: true }, "7"); // the data is no `committed`
  await insert("no-task", { ...committed, task_id: "7" }, null); // the column names no task
  await insert("no-row", { ...committed, task_id: "404" }, "404"); // the index has no task 404
  await apply(created("7", OPEN)); // and news behind them

  expect(lines(await tick())).toEqual(["11 New task #7"]);
  const logs = logged();
  expect(logs).toHaveLength(3);
  expect(logs[0]).toMatch(/event 1 \(committed\).*malformed/);
  expect(logs[1]).toMatch(/event 2 \(committed\).*malformed/);
  expect(logs[2]).toMatch(/event 3 \(committed\).*task 404/);
  expect(await cursor()).toBe("4");
  expect(await tick()).toEqual([]); // and they are not met again
  expect(logged()).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// The question board's alerts. The rows are written by the board's own functions, as the API does,
// so that the events are the ones production leaves: they name the task and the row, and no text.

/**
 * Task 7 open for days, and the people who hear of its board: the poster (chat 11), an account that
 * asked (12), one that committed (13), one that said it started (14), a bystander (15) and a chat
 * that watches the task's tag (16).
 */
async function seedBoardWorld(): Promise<void> {
  await seedTask(db, {
    id: "7",
    poster: "poster.near",
    title: "Summarise the Q3 report",
    tags: ["research"],
    ...OPEN_FOR_DAYS,
  });
  await seedEntry(db, "7", "committer.near");
  // Long ago, so that it is no news of its own (the working alerts look at the last 10 minutes).
  await startWorking("7", "worker.near", T0 - 3 * HOUR);
  await linkChat(db, 11, "poster.near");
  await linkChat(db, 12, "asker.near");
  await linkChat(db, 13, "committer.near");
  await linkChat(db, 14, "worker.near");
  await linkChat(db, 15, "bystander.near");
  await linkChat(db, 16, "watcher.near");
  await watchTag(db, 16, "research");
}

/** Asks as `asker.near` on task 7, and gives back the question's id. */
async function askOn7(body: string, asker = "asker.near"): Promise<bigint> {
  const asked = await addQuestion(db, { taskId: 7n, asker, body }, BOARD_LIMITS);
  if (!asked.ok) throw new Error(`the question was refused: ${asked.reason}`);
  return BigInt(asked.row.id);
}

test("the_boards_events_make_alerts_that_name_what_happened_and_never_what_was_written", async () => {
  await seedBoardWorld();
  expect(await tick()).toEqual([]); // the first tick starts at the head, with nothing there

  // Each holds a marker that nothing the notifier writes itself contains.
  const words = [
    "<b>ZZQASK</b> & see spam.example",
    "ZZQANSWER <i>words</i> & more",
    "ZZQNOTE <u>x</u> & y",
  ];

  // A question reaches the poster alone, in a digest that counts it.
  const id = await askOn7(words[0] ?? "");
  const asked = await tick();
  expect(lines(asked)).toEqual(["11 New questions #7"]);
  expect(asked[0]?.text).toContain("Summarise the Q3 report");
  expect(asked[0]?.text).toContain("1 new question waiting for an answer");

  // The answer reaches the asker, the one who committed and the one who started at once, and the
  // tag watcher in a digest that counts it.
  expect((await answerQuestion(db, { taskId: 7n, questionId: id, body: words[1] ?? "" })).ok).toBe(
    true,
  );
  const answered = await tick();
  expect(lines(answered)).toEqual([
    "12 Question answered #7",
    "13 Question answered #7",
    "14 Question answered #7",
    "16 Board update #7",
  ]);
  expect(answered[3]?.text).toContain("1 new answer");

  // A clarification reaches the entrants at once, but for the asker, who has no more reason to hear
  // than the rest. The watcher heard a digest a moment ago, so its next one waits for the window.
  expect((await addClarification(db, { taskId: 7n, body: words[2] ?? "" }, BOARD_LIMITS)).ok).toBe(
    true,
  );
  expect(lines(await tick())).toEqual(["13 Clarification #7", "14 Clarification #7"]);
  const later = await tickAt(clock + BOARD_DIGEST_WINDOW_MS + MINUTE);
  expect(lines(later)).toEqual(["16 Board update #7"]);
  expect(later[0]?.text).toContain("1 new clarification");
  expect(later[0]?.text).not.toContain("answer");

  // A hide is no news: the poster did it.
  expect((await hideQuestion(db, { taskId: 7n, questionId: id })).ok).toBe(true);
  expect(await tick()).toEqual([]);
  expect(logged()).toEqual([]);

  // Not a word of what was written went to Telegram.
  const everything = calls.map((call) => String(call.payload.text)).join("\n");
  for (const word of ["ZZQASK", "spam.example", "ZZQANSWER", "words", "ZZQNOTE"]) {
    expect(everything, word).not.toContain(word);
  }
});

test("each_answer_reaches_the_entrants_at_once_and_questions_and_watchers_get_one_digest", async () => {
  await seedBoardWorld();
  await tick();
  const first = await askOn7("First?");
  const second = await askOn7("Second?", "other.near");
  // Two questions are one message to the poster.
  const asked = await tick();
  expect(lines(asked)).toEqual(["11 New questions #7"]);
  expect(asked[0]?.text).toContain("2 new questions waiting for an answer");
  await answerQuestion(db, { taskId: 7n, questionId: first, body: "One." });
  await answerQuestion(db, { taskId: 7n, questionId: second, body: "Two." });
  // Each answer reaches the entrants (the asker of the second is a stranger to the chats here), and
  // the watcher gets one message for both.
  const answered = await tick();
  expect(lines(answered)).toEqual([
    "12 Question answered #7",
    "13 Question answered #7",
    "14 Question answered #7",
    "13 Question answered #7",
    "14 Question answered #7",
    "16 Board update #7",
  ]);
  expect(answered[5]?.text).toContain("2 new answers");
  await addClarification(db, { taskId: 7n, body: "Note." }, BOARD_LIMITS);
  expect(lines(await tick())).toEqual(["13 Clarification #7", "14 Clarification #7"]);

  // A restart that reads the stream again from the start sends none of it twice.
  await db.query("update worker_cursor set event_id = 0 where name = 'telegram'");
  expect(await tick({ bot: newBot() })).toEqual([]);
  expect(logged()).toEqual([]);
});

test("a_question_the_poster_hid_before_the_notifier_looked_is_not_announced", async () => {
  await seedBoardWorld();
  await tick();
  const spam = await askOn7("buy my tokens");
  const real = await askOn7("What is a version?", "other.near");
  await answerQuestion(db, { taskId: 7n, questionId: spam, body: "no" });
  await hideQuestion(db, { taskId: 7n, questionId: spam });

  // The hidden question's ask and answer are skipped without a word, and left out of the counts:
  // the poster is told of the one question.
  const asked = await tick();
  expect(lines(asked)).toEqual(["11 New questions #7"]);
  expect(asked[0]?.text).toContain("1 new question waiting");
  expect(logged()).toEqual([]);
  await answerQuestion(db, { taskId: 7n, questionId: real, body: "Three parts." });
  const answered = await tick();
  expect(lines(answered)).toEqual([
    "13 Question answered #7",
    "14 Question answered #7",
    "16 Board update #7",
  ]);
  expect(answered[2]?.text).toContain("1 new answer");
});

test("board_events_that_cannot_make_an_alert_are_logged_and_skipped", async () => {
  await seedBoardWorld();
  await tick();
  // Rows that the board would not write but the table can hold. Each is logged and passed over.
  const insert = (receipt: string, event: string, data: unknown, taskId: string | null) =>
    db.query(
      `insert into events (height, block_ts, receipt_id, log_index, event, data, task_id)
       values (1, 1, $1, 0, $2, $3::jsonb, $4::numeric)`,
      [receipt, event, JSON.stringify(data), taskId],
    );
  await insert("board:a", "question_answered", { nonsense: true }, "7"); // the data is no board event
  await insert("board:b", "clarification_posted", { task_id: "7", clarification_id: "9" }, null);
  await insert(
    "board:c",
    "question_asked",
    { task_id: "404", question_id: "1", asker: "a.near" },
    "404",
  );
  await insert("board:d", "question_answered", { task_id: "7", question_id: "999" }, "7");
  // A question id past any row's must not reach the database as a bigint, which would refuse it
  // and stop the tick at this event for good.
  await insert(
    "board:e",
    "question_asked",
    { task_id: "7", question_id: "18446744073709551615", asker: "a.near" },
    "7",
  );
  await askOn7("A real one"); // and news behind them

  expect(lines(await tick())).toEqual(["11 New questions #7"]);
  const logs = logged();
  expect(logs).toHaveLength(5);
  expect(logs[0]).toMatch(/event 1 \(question_answered\).*malformed/);
  expect(logs[1]).toMatch(/event 2 \(clarification_posted\).*malformed/);
  expect(logs[2]).toMatch(/event 3 \(question_asked\).*task 404/);
  expect(logs[3]).toMatch(/event 4 \(question_answered\).*question 999/);
  expect(logs[4]).toMatch(/event 5 \(question_asked\).*question 18446744073709551615/);
  expect(await tick()).toEqual([]); // and they are not met again
  expect(logged()).toEqual([]);
});

// The board's digests. Any registered agent can ask and a poster can answer them all, so the poster
// and the chats that watch a tag hear of the board in one message that counts what is new: at most
// one every BOARD_DIGEST_WINDOW_MS for a chat and a task, and BOARD_DIGESTS_PER_TASK in all.

/** A clarification on task 7 as the board leaves it, with no limit of the board's own in the way. */
async function noteOn7(): Promise<void> {
  const [row] = await db.query<{ id: string }>(
    "insert into task_questions (task_id, kind, body) values (7, 'clarification', 'A note') returning id::text as id",
  );
  await db.query(
    `insert into events (height, block_ts, receipt_id, log_index, event, data, task_id)
     values (1, 1, $1, 0, 'clarification_posted', $2::jsonb, 7)`,
    [
      `board:clarification_posted:${row?.id}`,
      JSON.stringify({ task_id: "7", clarification_id: row?.id }),
    ],
  );
}

/** `n` questions on task 7, each asked by an account of its own and each answered, with their events. */
async function answeredOn7(n: number): Promise<void> {
  await db.query(
    `insert into task_questions (task_id, kind, asker, body, answer, answered_at)
     select 7, 'question', 'bulk' || g || '.near', 'A question', 'An answer', now()
       from generate_series(1, $1::int) g`,
    [n],
  );
  for (const event of ["question_asked", "question_answered"]) {
    await db.query(
      `insert into events (height, block_ts, receipt_id, log_index, event, data, task_id)
       select 1, 1, 'board:' || $1::text || ':' || q.id, 0, $1::text,
              jsonb_build_object('task_id', '7', 'question_id', q.id::text)
                || case when $1::text = 'question_asked' then jsonb_build_object('asker', q.asker)
                        else '{}'::jsonb end,
              7
         from task_questions q where q.task_id = 7 and q.asker like 'bulk%'
          and not exists (select 1 from events e where e.receipt_id = 'board:' || $1::text || ':' || q.id)`,
      [event],
    );
  }
}

test("a_burst_of_board_news_is_one_digest_for_each_chat_and_the_rest_waits_for_the_window", async () => {
  await seedBoardWorld();
  await linkChat(db, 17, "watcher2.near");
  await watchTag(db, 17, "research");
  await tick();
  const start = clock;

  // Twelve accounts ask, the poster answers all twelve and posts three clarifications.
  const ids: bigint[] = [];
  for (let i = 1; i <= 12; i++) ids.push(await askOn7(`Question ${i}?`, `asker${i}.near`));
  for (const id of ids)
    await answerQuestion(db, { taskId: 7n, questionId: id, body: "An answer." });
  for (let i = 0; i < 3; i++)
    await addClarification(db, { taskId: 7n, body: `Note ${i}` }, BOARD_LIMITS);

  const burst = await tick();
  const heard = (chat: string) => burst.filter((message) => message.chat === chat);
  // The poster: one message, which counts the twelve questions.
  expect(heard("11").map((m) => m.label)).toEqual(["New questions"]);
  expect(heard("11")[0]?.text).toContain("12 new questions waiting for an answer");
  // Each watching chat: one message, which counts the answers and the clarifications.
  for (const chat of ["16", "17"]) {
    expect(
      heard(chat).map((m) => m.label),
      chat,
    ).toEqual(["Board update"]);
    expect(heard(chat)[0]?.text, chat).toContain("12 new answers, 3 new clarifications");
  }
  // The entrants hear the first answers and clarifications of the task one by one, and no more.
  for (const chat of ["13", "14"]) {
    expect(heard(chat), chat).toHaveLength(BOARD_ROW_ALERTS);
    expect(new Set(heard(chat).map((m) => m.label))).toEqual(new Set(["Question answered"]));
  }
  // Nobody else heard, and fifteen rows of news cost 23 messages and not 15 times as many.
  expect(burst).toHaveLength(1 + 2 + 2 * BOARD_ROW_ALERTS);

  // More news inside the window is not announced to anyone who heard a digest, however much. A
  // question answered to an account that has a chat still reaches that account, as it always does.
  clock = start + 10 * MINUTE;
  const thirteen = await askOn7("Thirteenth?", "asker13.near");
  await answerQuestion(db, { taskId: 7n, questionId: thirteen, body: "An answer." });
  await noteOn7();
  const mine = await askOn7("Mine?", "asker.near");
  await answerQuestion(db, { taskId: 7n, questionId: mine, body: "An answer." });
  expect(lines(await tick())).toEqual(["12 Question answered #7"]);

  // The window opens 30 minutes after the first digest, to the millisecond, and then the poster
  // and each watching chat get one message that counts only what came after their last.
  expect(await tickAt(start + BOARD_DIGEST_WINDOW_MS - 1)).toEqual([]);
  const next = await tickAt(start + BOARD_DIGEST_WINDOW_MS);
  expect(lines(next)).toEqual(["11 New questions #7", "16 Board update #7", "17 Board update #7"]);
  expect(next[0]?.text).toContain("2 new questions waiting");
  expect(next[1]?.text).toContain("2 new answers, 1 new clarification");

  // And then there is nothing new: not now, not later, and not after a restart.
  expect(await tickAt(start + 2 * BOARD_DIGEST_WINDOW_MS)).toEqual([]);
  await db.query("update worker_cursor set event_id = 0 where name = 'telegram'");
  expect(await tickAt(start + 3 * BOARD_DIGEST_WINDOW_MS, { bot: newBot() })).toEqual([]);
  expect(logged()).toEqual([]);
});

test("a_chat_hears_at_most_so_many_digests_of_a_task_and_the_last_one_says_so", async () => {
  await seedBoardWorld();
  await tick();
  const start = clock;
  const heardBy16: Message[] = [];
  for (let round = 1; round <= BOARD_DIGESTS_PER_TASK + 3; round++) {
    await noteOn7();
    const sent = await tickAt(start + round * (BOARD_DIGEST_WINDOW_MS + MINUTE));
    heardBy16.push(...sent.filter((message) => message.chat === "16"));
  }
  // One digest each time the window had opened, up to the cap, and none after it.
  expect(heardBy16).toHaveLength(BOARD_DIGESTS_PER_TASK);
  expect(new Set(heardBy16.map((m) => m.label))).toEqual(new Set(["Board update"]));
  const saidLast = heardBy16.map((m) => m.text.includes("last board alert"));
  expect(saidLast.filter(Boolean)).toHaveLength(1);
  expect(saidLast.at(-1)).toBe(true);
  const [row] = await db.query<{ digests: number }>(
    "select digests from tg_board_digests where chat_id = 16 and task_id = 7 and audience = 'watchers'",
  );
  expect(row?.digests).toBe(BOARD_DIGESTS_PER_TASK);
  // The cap is for the task and the chat: another task's board is heard again.
  await seedTask(db, { id: "8", poster: "poster.near", tags: ["research"], ...OPEN_FOR_DAYS });
  await db.query(
    "insert into task_questions (task_id, kind, body) values (8, 'clarification', 'Elsewhere')",
  );
  await db.query(
    `insert into events (height, block_ts, receipt_id, log_index, event, data, task_id)
     values (1, 1, 'board:clarification_posted:80', 0, 'clarification_posted',
             '{"task_id":"8","clarification_id":"80"}'::jsonb, 8)`,
  );
  const other = await tickAt(
    start + (BOARD_DIGESTS_PER_TASK + 4) * (BOARD_DIGEST_WINDOW_MS + MINUTE),
  );
  expect(lines(other.filter((m) => m.chat === "16"))).toEqual(["16 Board update #8"]);
  expect(logged()).toEqual([]);
});

test("a_flood_of_board_news_does_not_hold_back_a_time_critical_alert", async () => {
  await seedBoardWorld();
  // Thirty more chats watch the task's tag.
  for (let i = 0; i < 30; i++) {
    await linkChat(db, 100 + i, `watcher${i}.near`);
    await watchTag(db, 100 + i, "research");
  }
  await tick();
  // Task 8 is in the last minutes of its reveal window, and its committer has not revealed.
  await seedTask(db, {
    id: "8",
    poster: "someone.near",
    ...schedule(T0 - HOUR, T0, clock + 5 * MINUTE),
    commit_count: 1,
  });
  await seedEntry(db, "8", "late.near");
  await linkChat(db, 200, "late.near");
  // Sixty questions, all answered: with a message for every answer to every watching chat, that
  // is thousands of sends. Telegram limits the bot long before, and a limited bot sends nothing.
  await answeredOn7(60);
  floodAfter = 120;

  const sent = await tick();
  expect(calls.length).toBeLessThan(120);
  expect(sent.filter((m) => m.chat === "200").map((m) => m.label)).toEqual([
    "Reveal now",
    "Reveal closing",
  ]);
  expect(sent.filter((m) => m.label === "Board update")).toHaveLength(31);
  expect(logged()).toEqual([]);
});

test("a_digest_is_sent_at_most_once_even_when_the_send_fails", async () => {
  await seedBoardWorld();
  await tick();
  await askOn7("A question?");
  // The network is down for chat 11: Telegram cannot have taken the digest, so its claim goes back.
  failures.set("11", httpError(fetchError("connect ECONNREFUSED", "ECONNREFUSED")));
  const error = await failedTick();
  expect(error.name).toBe("TransportFailed");
  expect(lines(drain())).toEqual(["11 New questions #7"]);
  expect(await db.query("select 1 from tg_board_digests where chat_id = 11")).toEqual([]);

  // It is back: the digest is sent once, and a tick after that sends nothing.
  failures.clear();
  expect(lines(await tick())).toEqual(["11 New questions #7"]);
  expect(await tick()).toEqual([]);

  // A message Telegram refuses (it took nothing and will not) is lost for that chat, with a line, and
  // is not tried again; the next news is.
  refusals.set("16", { error_code: 400, description: "Bad Request: chat not found" });
  const id = await askOn7("Another?", "other.near");
  await answerQuestion(db, { taskId: 7n, questionId: id, body: "Yes." });
  await tick();
  expect(logged()).toEqual([
    "telegram notifier: alert lost: board_digest for task 7 (GrammyError 400: Bad Request: chat not found)",
  ]);
  refusals.clear();
  // Chat 16 hears nothing of that answer now. (The poster, whose window has opened, hears of the
  // question that was asked meanwhile.)
  expect(lines(await tickAt(clock + 2 * BOARD_DIGEST_WINDOW_MS))).toEqual(["11 New questions #7"]);
  const again = await askOn7("And another?", "third.near");
  await answerQuestion(db, { taskId: 7n, questionId: again, body: "Also yes." });
  const later = await tickAt(clock + 3 * BOARD_DIGEST_WINDOW_MS);
  expect(lines(later.filter((m) => m.chat === "16"))).toEqual(["16 Board update #7"]);
  expect(later.find((m) => m.chat === "16")?.text).toContain("1 new answer");
});

test("two_notifiers_working_at_once_send_a_digest_once", async () => {
  await seedBoardWorld();
  await tick();
  await askOn7("A question?");
  const options = { db, webUrl: WEB_URL, network: NETWORK, now };
  await Promise.all([
    notifierTick({ ...options, bot: newBot() }),
    notifierTick({ ...options, bot: newBot() }),
  ]);
  expect(lines(drain())).toEqual(["11 New questions #7"]);
  const [row] = await db.query<{ digests: number }>(
    "select digests from tg_board_digests where chat_id = 11",
  );
  expect(row?.digests).toBe(1);
});

/**
 * The poster's chat with a digest row that a second notifier may have written a moment ago, and the
 * first notifier's view of it: it read the row before that, so it finds none and goes on to claim.
 * Only the claim itself can turn the digest away then. Gives back the database that reads so.
 */
async function racedPosterRow(row: {
  agoMs: number;
  digests: number;
  caughtUp?: boolean;
}): Promise<Db> {
  await seedBoardWorld();
  await tick();
  await askOn7("A question?");
  const [head] = await db.query<{ id: string }>("select max(id)::text as id from events");
  await db.query(
    `insert into tg_board_digests (chat_id, task_id, audience, upto_event_id, sent_at, digests)
     values (11, 7, 'poster', $1::bigint, to_timestamp($2::float8 / 1000), $3::int)`,
    [row.caughtUp ? (head?.id ?? "0") : "0", clock - row.agoMs, row.digests],
  );
  return {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
      /select upto_event_id::text as upto/.test(sql)
        ? Promise.resolve([] as T[])
        : db.query<T>(sql, params),
    exec: (sql) => db.exec(sql),
    tx: <T>(fn: (tx: Db) => Promise<T>) => db.tx(fn),
    close: () => db.close(),
  };
}

test("a_digest_the_claim_allows_is_sent_even_when_the_notifier_read_no_row", async () => {
  // The control for the three tests below: only the row the notifier did not see differs.
  const blind = await racedPosterRow({ agoMs: 2 * BOARD_DIGEST_WINDOW_MS, digests: 1 });
  expect(lines(await tick({ database: blind }))).toEqual(["11 New questions #7"]);
  const [row] = await db.query<{ digests: number }>("select digests from tg_board_digests");
  expect(row?.digests).toBe(2);
});

test("the_claim_refuses_a_digest_inside_the_window_that_another_notifier_opened", async () => {
  const blind = await racedPosterRow({ agoMs: MINUTE, digests: 1 });
  expect(await tick({ database: blind })).toEqual([]);
  const [row] = await db.query<{ digests: number }>("select digests from tg_board_digests");
  expect(row?.digests).toBe(1);
});

test("the_claim_refuses_a_digest_past_the_cap_that_another_notifier_filled", async () => {
  const blind = await racedPosterRow({
    agoMs: 2 * BOARD_DIGEST_WINDOW_MS,
    digests: BOARD_DIGESTS_PER_TASK,
  });
  expect(await tick({ database: blind })).toEqual([]);
  const [row] = await db.query<{ digests: number }>("select digests from tg_board_digests");
  expect(row?.digests).toBe(BOARD_DIGESTS_PER_TASK);
});

test("the_claim_refuses_a_digest_of_what_another_notifier_already_told_the_chat", async () => {
  const blind = await racedPosterRow({
    agoMs: 2 * BOARD_DIGEST_WINDOW_MS,
    digests: 1,
    caughtUp: true,
  });
  expect(await tick({ database: blind })).toEqual([]);
  const [row] = await db.query<{ digests: number }>("select digests from tg_board_digests");
  expect(row?.digests).toBe(1);
});

test("news_about_a_hidden_question_makes_no_digest_and_no_claim", async () => {
  await seedBoardWorld();
  await tick();
  const spam = await askOn7("buy my tokens");
  await answerQuestion(db, { taskId: 7n, questionId: spam, body: "no" });
  await hideQuestion(db, { taskId: 7n, questionId: spam });
  expect(await tick()).toEqual([]);
  expect(await db.query("select 1 from tg_board_digests")).toEqual([]);
  expect(logged()).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Working alerts.

test("agent_started_only_recent", async () => {
  const at = T0 + 30 * MINUTE;
  clock = at;
  await seedTask(db, { id: "7", poster: "poster.near", title: "Summarise the Q3 report" });
  await seedAgent(db, "fresh.near", { asp: "owner.near" });
  await linkChat(db, 101, "poster.near");
  await linkChat(db, 104, "owner.near"); // the ASP of fresh.near
  await startWorking("7", "fresh.near", at - 5 * MINUTE);
  await startWorking("7", "edge.near", at - 10 * MINUTE); // ten minutes ago still counts
  await startWorking("7", "stale.near", at - 10 * MINUTE - 1);
  await startWorking("7", "ancient.near", at - 3 * HOUR);

  const who = (messages: Message[]) =>
    messages.map((m) => `${m.chat} ${/· (\S+) started/.exec(m.text)?.[1]}`);
  const first = await tickAt(at);
  expect(who(first)).toEqual(["101 edge.near", "101 fresh.near", "104 fresh.near"]);
  expect(first[0]?.label).toBe("Agent working");
  expect(first[0]?.text).toContain("started “Summarise the Q3 report”");

  expect(await tickAt(at)).toEqual([]); // each is sent once, tick after tick
  await startWorking("7", "late.near", at + MINUTE);
  expect(who(await tickAt(at + MINUTE))).toEqual(["101 late.near"]);
  // fresh.near's row is 6 minutes old by now, edge.near's 11: neither is sent again
  expect(await tickAt(at + MINUTE)).toEqual([]);
});

test("the_poster_hears_of_a_tasks_first_starters_only", async () => {
  // Any account can say it started, so the poster hears of the first five agents to start a task.
  // A later one is announced to the chats of its own owners. A starter's place is counted over all
  // who ever started the task, so it does not improve when the earlier ones fall out of the
  // 10-minute window.
  const at = T0 + 30 * MINUTE;
  clock = at;
  await seedTask(db, { id: "7", poster: "poster.near", title: "Summarise the Q3 report" });
  await seedTask(db, { id: "8", poster: "poster.near", title: "Label the images" });
  await linkChat(db, 101, "poster.near");

  // Task 7: five agents began an hour ago, so they are not news now, and two more begin now.
  for (const n of [1, 2, 3, 4, 5]) await startWorking("7", `old${n}.near`, at - HOUR + n * MINUTE);
  for (const [n, agent] of ["late1.near", "late2.near"].entries()) {
    await startWorking("7", agent, at - 3 * MINUTE + n * 1_000);
    await linkChat(db, 201 + n, agent);
  }
  // Task 8: seven agents begin one after another, each with a chat of its own.
  for (let n = 1; n <= 7; n++) {
    await startWorking("8", `s${n}.near`, at - 8 * MINUTE + n * MINUTE);
    await linkChat(db, 300 + n, `s${n}.near`);
  }

  const heard = lines(await tickAt(at)).sort();

  expect(heard).toEqual(
    [
      // Task 7: its late starters' owners hear, and the poster does not: they came sixth and seventh.
      "201 Agent working #7",
      "202 Agent working #7",
      // Task 8: the poster hears of the first five of seven, and every starter's own chat hears.
      ...[1, 2, 3, 4, 5].map(() => "101 Agent working #8"),
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => `${300 + n} Agent working #8`),
    ].sort(),
  );
  // The seventh and sixth never reach the poster, now or on a later tick.
  expect(await tickAt(at + MINUTE)).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Timer alerts.

/** Task 7: 30 h to enter, an hour to reveal, with an entry by bot.near that is not revealed. */
const D = T0 + 30 * HOUR;
const R = D + HOUR;

async function timedWorld(): Promise<void> {
  await seedTask(db, {
    id: "7",
    poster: "poster.near",
    title: "Summarise the Q3 report",
    created_at: ns(T0),
    commit_deadline: ns(D),
    reveal_deadline: ns(R),
    pick_deadline: ns(R + HOUR),
    fallback_deadline: ns(R + 2 * HOUR),
    commit_count: 1,
  });
  await seedEntry(db, "7", "bot.near");
  await linkChat(db, 101, "poster.near");
  await linkChat(db, 102, "judge.test"); // the verifier seedTask gives every task
  await linkChat(db, 103, "bot.near");
}

test("timer_alerts_fire_at_boundaries", async () => {
  await timedWorld();
  const steps: [when: string, at: number, heard: string[]][] = [
    ["1 ms before the 24 h mark", D - 24 * HOUR - 1, []],
    ["at the 24 h mark", D - 24 * HOUR, ["101 24 h left #7", "103 24 h left #7"]],
    ["a tick later: nothing twice", D - 24 * HOUR + 5_000, []],
    ["1 ms before the 1 h mark", D - HOUR - 1, []],
    ["at the 1 h mark", D - HOUR, ["101 1 h left #7", "103 1 h left #7"]],
    ["1 ms before the commit deadline", D - 1, []],
    ["at the commit deadline", D, ["102 Reveal now #7", "103 Reveal now #7"]],
    ["10 min and 1 ms before the reveal deadline", R - 10 * MINUTE - 1, []],
    ["10 min before the reveal deadline", R - 10 * MINUTE, ["103 Reveal closing #7"]],
    ["1 ms before the reveal deadline", R - 1, []],
    ["at the reveal deadline", R, []],
    ["long after", R + 5 * HOUR, []],
  ];
  for (const [when, at, heard] of steps) {
    expect(lines(await tickAt(at)), when).toEqual(heard);
  }
});

test("timer_alerts_end_with_their_windows", async () => {
  // Seen for the first time at the very end of a window, an alert is not sent: it has no use left.
  await timedWorld();
  const later = 100 * HOUR; // task 8 runs 100 h behind task 7
  await seedTask(db, {
    id: "8",
    poster: "poster.near",
    created_at: ns(T0),
    commit_deadline: ns(D + later),
    reveal_deadline: ns(R + later),
    pick_deadline: ns(R + later + HOUR),
    fallback_deadline: ns(R + later + 2 * HOUR),
    commit_count: 1,
  });
  await seedEntry(db, "8", "bot.near");

  // At task 7's commit deadline the reminders are over, and only the reveal window is open.
  expect(lines(await tickAt(D))).toEqual(["102 Reveal now #7", "103 Reveal now #7"]);
  // At task 8's reveal deadline nothing is open any more.
  expect(await tickAt(R + later)).toEqual([]);
});

test("the_24_h_reminder_is_not_sent_in_the_last_hour", async () => {
  // A notifier that is back from downtime, or sees a task late, must not say "24 h left" with an hour
  // to go: from the 1 h mark the 1 h reminder is the one that is due. Each case starts afresh, as a
  // notifier that has sent nothing yet.
  const cases: [when: string, at: number, heard: string[]][] = [
    ["1 ms before the 1 h mark", D - HOUR - 1, ["101 24 h left #7", "103 24 h left #7"]],
    ["at the 1 h mark", D - HOUR, ["101 1 h left #7", "103 1 h left #7"]],
    ["in the last half hour", D - 30 * MINUTE, ["101 1 h left #7", "103 1 h left #7"]],
    ["1 ms before the commit deadline", D - 1, ["101 1 h left #7", "103 1 h left #7"]],
  ];
  for (const [when, at, heard] of cases) {
    await db.exec(`truncate tasks, entries, tg_links, tg_sent restart identity`);
    await timedWorld();
    expect(lines(await tickAt(at)), when).toEqual(heard);
  }
});

test("reminder_skipped_for_short_windows", async () => {
  // The 24 h reminder needs a commit window longer than 25 h, and the 1 h reminder one longer than
  // 2 h, so that neither goes out right after the task is posted. The notifier ticks when the task
  // is posted, at the 24 h mark and at the 1 h mark.
  const cases: [window: string, ms: number, heard: string[]][] = [
    ["30 min", 30 * MINUTE, []],
    ["2 h", 2 * HOUR, []],
    ["2 h and 1 ms", 2 * HOUR + 1, ["1 h left"]],
    ["25 h", 25 * HOUR, ["1 h left"]],
    ["25 h and 1 ms", 25 * HOUR + 1, ["24 h left", "1 h left"]],
  ];
  for (const [window, ms, heard] of cases) {
    await db.exec(`truncate tasks, entries, tg_links, tg_sent restart identity`);
    const deadline = T0 + ms;
    await seedTask(db, {
      id: "7",
      poster: "poster.near",
      created_at: ns(T0),
      commit_deadline: ns(deadline),
      reveal_deadline: ns(deadline + HOUR),
    });
    await linkChat(db, 101, "poster.near");
    const ticks = [T0, deadline - 24 * HOUR, deadline - HOUR].filter((at) => at >= T0);
    const got: string[] = [];
    for (const at of ticks) got.push(...(await tickAt(at)).map((m) => m.label));
    expect(got, `a commit window of ${window}`).toEqual(heard);
  }
});

test("reveal_closing_waits_for_the_reveal_window", async () => {
  // Reveal windows can be shorter than the 10 min lead (mainnet allows 5 min). Then the lead
  // reaches back into the commit window, where nothing can be revealed yet.
  const deadline = T0 + HOUR;
  await seedTask(db, {
    id: "7",
    poster: "poster.near",
    created_at: ns(T0),
    commit_deadline: ns(deadline),
    reveal_deadline: ns(deadline + 5 * MINUTE),
    commit_count: 1,
  });
  await seedEntry(db, "7", "bot.near");
  await linkChat(db, 103, "bot.near");

  expect(await tickAt(deadline - 3 * MINUTE)).toEqual([]);
  // Once the window opens, it is also within 10 min of closing: both alerts are due.
  expect(lines(await tickAt(deadline))).toEqual(["103 Reveal now #7", "103 Reveal closing #7"]);
});

test("reveal_alerts_need_an_entry_to_reveal", async () => {
  const deadline = T0 + HOUR;
  const task = {
    poster: "poster.near",
    created_at: ns(T0),
    commit_deadline: ns(deadline),
    reveal_deadline: ns(deadline + 5 * MINUTE),
  };
  await seedTask(db, { ...task, id: "7" }); // no entries at all
  await seedTask(db, { ...task, id: "8", commit_count: 1, reveal_count: 1 }); // all revealed
  await seedEntry(db, "8", "bot.near", { revealed: true });
  await linkChat(db, 102, "judge.test");
  await linkChat(db, 103, "bot.near");
  expect(await tickAt(deadline + MINUTE)).toEqual([]);
});

test("deadlines_are_compared_exactly", async () => {
  // Each deadline is 1 ns from the clock or from the clock plus 10 min; a float cannot tell.
  const nowNs = BigInt(clock) * 1_000_000n;
  const tenMinutes = BigInt(10 * MINUTE) * 1_000_000n;
  const hour = BigInt(HOUR) * 1_000_000n;
  const plan: { id: string; commit: bigint; reveal: bigint }[] = [
    { id: "7", commit: nowNs + 1n, reveal: nowNs + hour }, // enters its reveal window in 1 ns
    { id: "8", commit: nowNs, reveal: nowNs + hour }, // enters it now
    { id: "9", commit: nowNs - hour, reveal: nowNs + tenMinutes + 1n }, // 10 min and 1 ns left
    { id: "10", commit: nowNs - hour, reveal: nowNs + tenMinutes }, // 10 min left
    { id: "11", commit: nowNs - hour, reveal: nowNs + 1n }, // 1 ns left
    { id: "12", commit: nowNs - hour, reveal: nowNs }, // over
  ];
  for (const { id, commit, reveal } of plan) {
    await seedTask(db, {
      id,
      poster: "poster.near",
      created_at: ns(T0),
      commit_deadline: commit.toString(),
      reveal_deadline: reveal.toString(),
      commit_count: 1,
    });
    await seedEntry(db, id, "bot.near");
  }
  await linkChat(db, 103, "bot.near");

  expect(lines(await tick())).toEqual([
    // reveal_open: tasks 8, 9, 10 and 11 are in their reveal window
    "103 Reveal now #8",
    "103 Reveal now #9",
    "103 Reveal now #10",
    "103 Reveal now #11",
    // reveal_closing: tasks 10 and 11 are within 10 min of the end of it
    "103 Reveal closing #10",
    "103 Reveal closing #11",
  ]);
});

test("timers_read_the_clock_after_a_slow_event_phase", async () => {
  // Sends behind a backlog can take minutes. The timers run on the time it is when they start, not
  // the time the tick began: reveal_closing is a window of ten minutes.
  const reveal = T0 + 2 * HOUR;
  await seedTask(db, {
    id: "7",
    poster: "poster.near",
    created_at: ns(T0),
    commit_deadline: ns(T0 + HOUR),
    reveal_deadline: ns(reveal),
    commit_count: 1,
  });
  await seedEntry(db, "7", "bot.near");
  await linkChat(db, 103, "bot.near");
  await linkChat(db, 11, poster);
  expect(await tickAt(T0 + 10 * MINUTE)).toEqual([]); // the first run

  await apply(created("8", schedule(T0, T0 + 5 * HOUR, T0 + 6 * HOUR)));
  // The tick begins 11 minutes before the reveal window of task 7 ends, so it is not closing yet.
  // The first send takes six minutes, which leaves five.
  onSend = () => {
    clock = reveal - 5 * MINUTE;
  };
  const sent = await tickAt(reveal - 11 * MINUTE);
  expect(lines(sent)).toEqual(["11 New task #8", "103 Reveal now #7", "103 Reveal closing #7"]);
  expect(sent[2]?.text).toContain("5 min left to reveal");
});

test("each_new_task_is_judged_and_worded_on_the_time_it_is_when_its_turn_comes", async () => {
  // Sends behind a backlog take minutes: here every send takes three. Three tasks close at the same
  // moment, 5 minutes after the tick began. The first is announced with 5 min to go, the second,
  // after one send, with 2, and the third, whose turn comes after two sends, has closed: nobody can
  // enter it any more, so nothing is said. On the time at the start of the tick all three would
  // say "5 min", one of them to a window that was over.
  await linkChat(db, 11, poster);
  expect(await tickAt(T0 + 10 * MINUTE)).toEqual([]); // the first run, on an empty stream
  const closing = schedule(T0, T0 + 15 * MINUTE, T0 + 2 * HOUR);
  await apply(created("7", closing), created("8", closing), created("9", closing));
  onSend = () => {
    clock += 3 * MINUTE;
  };

  const sent = await tickAt(T0 + 10 * MINUTE);

  expect(lines(sent)).toEqual(["11 New task #7", "11 New task #8"]);
  expect(sent[0]?.text).toContain("entries close in 5 min");
  expect(sent[1]?.text).toContain("entries close in 2 min");
  expect(await cursor()).toBe("3");
  const keys = await db.query<{ dedupe_key: string }>(
    "select dedupe_key from tg_sent order by dedupe_key",
  );
  expect(keys).toEqual([{ dedupe_key: "new_task:7" }, { dedupe_key: "new_task:8" }]);
});

// ---------------------------------------------------------------------------------------------
// The loop.

/** Waits for `condition`, polling, and fails with `what` if it does not hold in time. */
async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const giveUp = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > giveUp) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

/** Runs `body` while a notifier loop runs, and stops the loop, and waits for it, after. */
async function withLoop(
  options: Partial<NotifierOptions>,
  body: (stop: () => void, stopped: Promise<void>) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const stopped = startNotifier({
    db,
    bot,
    webUrl: WEB_URL,
    network: NETWORK,
    now,
    intervalMs: 5,
    signal: controller.signal,
    ...options,
  });
  try {
    await body(() => controller.abort(), stopped);
  } finally {
    controller.abort();
    await stopped;
  }
}

const firstTickDone = () => until(async () => (await cursor()) !== undefined, "the first tick");

test("the_loop_ticks_at_once_and_then_every_interval", async () => {
  await linkChat(db, 11, poster);
  await withLoop({}, async () => {
    await firstTickDone();
    await apply(created("7", OPEN));
    await until(() => calls.length === 1, "the first alert");
    await apply(eventLine("committed", { task_id: "7" }));
    await until(() => calls.length === 2, "the second alert");
  });
  expect(lines(drain())).toEqual(["11 New task #7", "11 Entry received #7"]);
});

test("the_loop_waits_five_seconds_by_default", async () => {
  const timers = vi.spyOn(globalThis, "setTimeout");
  await withLoop({ intervalMs: undefined }, async () => {
    await firstTickDone();
    await until(
      () => timers.mock.calls.some(([, ms]) => ms === 5000),
      "the wait for the next tick",
    );
  });
});

test("an_abort_while_the_loop_waits_stops_it_at_once", async () => {
  await withLoop({ intervalMs: 60_000 }, async (stop, stopped) => {
    await firstTickDone();
    await sleep(30); // the first tick is over, and the loop is waiting for the next
    stop();
    const outcome = await Promise.race([
      stopped.then(() => "stopped"),
      sleep(2_000).then(() => "still waiting"),
    ]);
    expect(outcome).toBe("stopped");
  });
});

test("no_tick_runs_after_the_loop_stops", async () => {
  await linkChat(db, 11, poster);
  await withLoop({ intervalMs: 100 }, async (stop, stopped) => {
    await firstTickDone();
    await sleep(30); // the first tick is over, and the loop is waiting for the next
    stop();
    await stopped;
    // The wait was cancelled: a tick that came late would announce this task.
    await apply(created("7", OPEN));
    await sleep(300);
    expect(calls).toHaveLength(0);
  });
});

test("an_abort_during_a_tick_lets_that_tick_finish", async () => {
  await linkChat(db, 11, poster);
  let release = () => {};
  await withLoop({}, async (stop, stopped) => {
    await firstTickDone();
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await apply(created("7", OPEN));
    await until(() => calls.length === 1, "a send in flight");

    stop(); // the send is stuck: the tick cannot end, so the loop cannot either
    const outcome = await Promise.race([
      stopped.then(() => "stopped"),
      sleep(50).then(() => "still in the tick"),
    ]);
    expect(outcome).toBe("still in the tick");
    expect(await cursor()).toBe("0"); // the batch is not done: the cursor has not moved

    release();
    await stopped;
    // The tick went through to its end, and no other one began.
    expect(await cursor()).toBe("1");
    await apply(eventLine("committed", { task_id: "7" }));
    await sleep(50);
    expect(calls).toHaveLength(1);
  });
});

test("ticks_never_overlap", async () => {
  // Each send takes 20 ms and the loop asks for a tick every 1 ms: a tick that started while the
  // last one was still sending would send at the same time.
  await linkChat(db, 11, poster);
  sendDelayMs = 20;
  await withLoop({ intervalMs: 1 }, async () => {
    await firstTickDone();
    await apply(created("1", OPEN), created("2", OPEN), created("3", OPEN));
    await until(() => calls.length === 3, "all three alerts");
    await sleep(60);
  });
  expect(mostSending).toBe(1);
  expect(calls).toHaveLength(3);
});

test("a_failing_tick_is_logged_and_the_next_one_runs", async () => {
  let failures = 2;
  const flaky = failingWhen(db, () => failures-- > 0);
  await withLoop({ db: flaky }, async () => {
    await firstTickDone(); // the first two statements failed, so ticks came and went before this
  });
  const logs = logged();
  expect(logs.length).toBeGreaterThanOrEqual(2);
  expect(logs[0]).toContain("tick failed");
  expect(logs[0]).toContain("database unavailable");
});

test("an_aborted_signal_runs_no_tick", async () => {
  const controller = new AbortController();
  controller.abort();
  await startNotifier({
    db,
    bot,
    webUrl: WEB_URL,
    network: NETWORK,
    now,
    signal: controller.signal,
  });
  expect(await cursor()).toBeUndefined();
});

// ---------------------------------------------------------------------------------------------
// The web URL: checked once, when the notifier starts.

/** The options of a notifier on `webUrl` that stays stopped: its signal is aborted already. */
function stoppedOn(webUrl: string): NotifierOptions {
  const controller = new AbortController();
  controller.abort();
  return { db, bot, webUrl, network: NETWORK, now, signal: controller.signal };
}

test("a_web_url_that_is_not_an_http_url_with_a_host_is_refused", async () => {
  const refused = [
    "",
    "tender.example",
    "//tender.example",
    "/tasks",
    "ftp://tender.example",
    "javascript:alert(1)",
    "tg://resolve?domain=tender_bot", // a link that acts on the reader's account
    "https:tender.example", // the parser accepts it, but joined with /tasks/1 it is no link
    " https://tender.example", // the parser trims the blank, a joined link keeps it
    "https://", // no host
    "https:///",
    "http://:3000",
  ];
  for (const webUrl of refused) {
    expect(() => startNotifier(stoppedOn(webUrl)), webUrl).toThrow(
      /^webUrl must be an http\(s\) URL with a host/,
    );
  }

  // It throws from the call itself, before a tick: nothing here would stop the loop if it ran.
  const live = new AbortController();
  try {
    const bad = { ...stoppedOn("ftp://tender.example"), signal: live.signal };
    expect(() => startNotifier(bad)).toThrow();
    await sleep(50);
    expect(await cursor()).toBeUndefined();
    expect(calls).toHaveLength(0);
  } finally {
    live.abort();
  }

  // What is wanted gets through: a port, a path in front of the task pages, any case of the scheme.
  const accepted = [
    "http://localhost:3000",
    "https://tender.example/app/",
    "HTTPS://Tender.Example",
  ];
  for (const webUrl of accepted) {
    await expect(startNotifier(stoppedOn(webUrl)), webUrl).resolves.toBeUndefined();
  }
});

test("a_web_url_with_a_query_or_fragment_is_refused", () => {
  // Every link is the URL and then `/tasks/<id>`, so `?ref=tg` would swallow the path.
  const refused = [
    "https://tender.example?ref=tg",
    "https://tender.example/?ref=tg",
    "https://tender.example/app?x=1#top",
    "https://tender.example/#top",
    "https://tender.example/?", // an empty query is one too, though the parser's `search` reads ""
    "https://tender.example/#",
  ];
  for (const webUrl of refused) {
    expect(() => startNotifier(stoppedOn(webUrl)), webUrl).toThrow(
      /^webUrl must have no query or fragment/,
    );
  }
});

test("a_web_url_is_escaped_in_the_links_it_makes", async () => {
  // Nothing in the rules keeps `&` or `"` out of a path, and a `"` would end the link's attribute
  // early. Telegram reads the entities back, so the reader gets the URL as it was written.
  await linkChat(db, 11, poster);
  await withLoop({ webUrl: 'https://tender.example:8443/a&b"c/' }, async () => {
    await firstTickDone();
    await apply(created("7", OPEN));
    await until(() => calls.length === 1, "the new-task alert");
  });
  const [sent] = drain();
  expect(sent?.text).toContain(
    '<a href="https://tender.example:8443/a&amp;b&quot;c/tasks/7">Open task</a>',
  );
});

/** The message that `startNotifier` throws for `webUrl`. */
function refusal(webUrl: string): string {
  try {
    startNotifier(stoppedOn(webUrl));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`startNotifier took ${JSON.stringify(webUrl)}`);
}

test("a_web_url_with_whitespace_or_a_login_is_refused", async () => {
  // The URL is joined into every link as text: a blank in it is in every link, and a login in it
  // is shown to everyone who gets a message.
  const blanks = [
    "https://tender.example ",
    "https://tender.example\n",
    "https://tender.example/my app",
    "https://tender.example/a\tb", // the URL parser drops the tab, the link would keep it
  ];
  for (const webUrl of blanks) {
    expect(refusal(webUrl), JSON.stringify(webUrl)).toMatch(/^webUrl must not contain whitespace/);
  }
  const logins = [
    "https://user:secret@tender.example",
    "https://user@tender.example/app/", // no password
    "https://:secret@tender.example", // no username
  ];
  for (const webUrl of logins) {
    expect(refusal(webUrl), webUrl).toMatch(/^webUrl must not contain a username or password/);
  }

  // A message that quotes the URL leaves the password out: it is a secret, and the message goes to
  // the logs. Whichever rule refuses the URL, the password is not in it.
  const withPassword = [
    "https://user:secret@tender.example",
    "https://user:secret@/app", // no host
    "https://user:secret@tender.example/?ref=tg", // a query
    "https://user:secret@tender.example/my app", // a blank
  ];
  for (const webUrl of withPassword) {
    expect(refusal(webUrl), webUrl).not.toContain("secret");
  }

  // An @ in the path is no login.
  await expect(startNotifier(stoppedOn("https://tender.example/@tender"))).resolves.toBeUndefined();
});

test("a_refused_web_url_never_shows_its_query_or_fragment", () => {
  // The message goes to the startup log, and a query or fragment can hold a secret: a token, or the
  // `_vercel_share` of a preview link. A URL is shown only up to its first ? or #.
  const withSecret = [
    "https://tender.example/app?_vercel_share=CANARY", // refused for the query
    "https://tender.example/app#access_token=CANARY", // refused for the fragment
    "tender.example/app?token=CANARY", // refused for the scheme
  ];
  for (const webUrl of withSecret) {
    expect(refusal(webUrl), webUrl).not.toContain("CANARY");
  }

  // What is left shows where the mistake is.
  expect(refusal("https://tender.example/app?_vercel_share=CANARY")).toBe(
    'webUrl must have no query or fragment, got "https://tender.example/app?..."',
  );
  expect(refusal("https://tender.example/app#access_token=CANARY")).toBe(
    'webUrl must have no query or fragment, got "https://tender.example/app#..."',
  );
  expect(refusal("tender.example/app?token=CANARY")).toBe(
    'webUrl must be an http(s) URL with a host, got "tender.example/app?..."',
  );
  // A URL with neither is shown whole.
  expect(refusal("ftp://tender.example/app")).toBe(
    'webUrl must be an http(s) URL with a host, got "ftp://tender.example/app"',
  );
});
