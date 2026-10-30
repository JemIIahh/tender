import type { Db } from "@tender/db";
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
import type { NetworkId } from "@tender/shared";
import type { Bot, Transformer } from "grammy";
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
const refusals = new Map<string, { error_code: number; description: string }>();
/** The chats the network drops: a call to one throws instead of getting an answer. */
const unreachable = new Set<string>();
/** How long each send takes. */
let sendDelayMs = 0;
/** While set, the next send waits for it: a send that is stuck. Later sends are not held. */
let gate: Promise<void> | null = null;
/** Runs as each call to Telegram arrives: a test that needs time to pass during a tick sets it. */
let onSend: (() => void) | undefined;
let sending = 0;
let mostSending = 0;

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
  if (unreachable.has(String(sent.chat_id))) throw new Error("socket hang up");
  const refusal = refusals.get(String(sent.chat_id));
  if (refusal !== undefined) return { ok: false, ...refusal } as never;
  // Telegram answers a sendMessage with the message it made.
  const message = { message_id: calls.length, date: 0, chat: { id: sent.chat_id }, text: "" };
  return { ok: true, result: message } as never;
};

/** A bot on the fake Telegram. Another one is a restarted process. */
function newBot(): Bot {
  const made = createBot({ token: "123:test", db, webUrl: WEB_URL, botInfo: BOT_INFO });
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
  "tg_links",
  "tg_link_nonces",
  "tg_watches",
  "tg_sent",
  "worker_cursor",
];

beforeEach(async () => {
  await db.exec(`truncate ${TABLES.join(", ")} restart identity`);
  await putFixtureBlobs(db);
  calls.length = 0;
  seen = 0;
  refusals.clear();
  unreachable.clear();
  sendDelayMs = 0;
  gate = null;
  onSend = undefined;
  sending = 0;
  mostSending = 0;
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

test("other_send_errors_are_logged_and_not_retried", async () => {
  await linkChat(db, 41, poster);
  await linkChat(db, 42, poster);
  await linkChat(db, 43, poster);
  await linkChat(db, 44, poster);
  refusals.set("41", { error_code: 400, description: "Bad Request: chat not found" });
  refusals.set("42", { error_code: 429, description: "Too Many Requests: retry after 3" });
  unreachable.add("44");
  await tick();

  await apply(created("7", OPEN), eventLine("committed", { task_id: "7" }));
  // The batch goes on past the chats that fail: both alerts reach all four, once.
  expect(lines(await tick())).toEqual([
    "41 New task #7",
    "42 New task #7",
    "43 New task #7",
    "44 New task #7",
    "41 Entry received #7",
    "42 Entry received #7",
    "43 Entry received #7",
    "44 Entry received #7",
  ]);
  const logs = logged();
  expect(logs).toHaveLength(6);
  for (const chat of ["41", "42", "44"]) {
    expect(logs.filter((log) => log.includes(`chat ${chat}`))).toHaveLength(2);
  }
  expect(logs.some((log) => log.includes("chat 43"))).toBe(false);
  expect(logs[0]).toContain("400");
  expect(logs[2]).toContain("socket hang up");

  // Only a 403 unlinks. The cursor moved on, and a failed send stays sent: it is not tried again.
  const links = await db.query<{ chat_id: string }>(
    "select chat_id::text from tg_links order by 1",
  );
  expect(links.map((row) => row.chat_id)).toEqual(["41", "42", "43", "44"]);
  expect(await cursor()).toBe("2");
  refusals.clear();
  unreachable.clear();
  expect(await tick()).toEqual([]);
  expect(logged()).toEqual([]);
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
