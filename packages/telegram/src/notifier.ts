import type { Db } from "@tender/db";
import { type NetworkId, TenderEventSchema } from "@tender/shared";
import { type Bot, GrammyError } from "grammy";
import { type Alert, dedupeKey } from "./alerts";
import { resolveRecipients } from "./recipients";
import { type RenderContext, renderAlert } from "./render";

/**
 * The Telegram notifier. `notifierTick` is one pass over three sources of news, in this order:
 *
 * - The event stream: `events` rows after the notifier's place in it, `worker_cursor['telegram']`,
 *   at most `BATCH_SIZE` of them, oldest first. A `task_created` makes `new_task`, a `committed`
 *   that is not a replacement `entry_committed`, a `task_topped_up` `pool_grew`, a `picked`
 *   `winner_paid` and a `voided` `task_voided`. The cursor moves to the last event read once the
 *   batch is done, whether its alerts were sent or not.
 * - The `working` rows of agents that said, in the last 10 minutes, that they started a task:
 *   `agent_started`.
 * - The clock, for what no event announces: `reveal_open`, `reveal_closing` and the two
 *   `deadline_reminder`s. Every tick looks at every task and relies on the dedupe below.
 *
 * An alert goes to each chat that `resolveRecipients` names, at most once per chat. The chat's row
 * in `tg_sent` is claimed before the message is sent and a failed send keeps it, so a restart, or
 * two notifiers at once, can lose a message but never send one twice. The claim, not the cursor,
 * is what makes the notifier safe to restart: a tick that dies halfway is run again from the old
 * cursor, and the alerts it already sent are skipped.
 *
 * What goes wrong, and what the notifier does about it:
 * - A `webUrl` that task links cannot be made from is refused by `startNotifier` before any tick.
 * - An alert that cannot be rendered or addressed (see `deliver`) is logged and dropped, and the
 *   tick goes on.
 * - A send that fails is logged and not retried; the bot's `autoRetry` has already waited out a
 *   flood wait. A 403 means the chat blocked the bot, or the bot was kicked: the chat is unlinked.
 * - A database error stops the tick, which the loop logs. The next tick starts from the old cursor.
 *
 * Times are the contract's: nanoseconds since the Unix epoch. They are bigints here and numeric in
 * SQL, and are never floats, which cannot tell nanoseconds apart at this size.
 */

/** What `notifierTick` needs. */
export interface NotifierTickOptions {
  db: Db;
  /** The bot to send with. Only its `api` is used. */
  bot: Bot;
  /**
   * Where the web app is served, such as `https://tender.example`. Alerts link to its task pages.
   * `startNotifier` checks it once; `notifierTick` takes it as given.
   */
  webUrl: string;
  /** The network the tasks live on. The symbol and decimals of a token depend on it. */
  network: NetworkId;
  /** The clock. Defaults to the wall clock. */
  now?: () => Date;
}

/** What `startNotifier` needs. */
export interface NotifierOptions extends NotifierTickOptions {
  /** How long to wait after a tick before the next one starts. Defaults to 5 seconds. */
  intervalMs?: number;
  /** Stops the notifier. The tick in flight, if any, finishes first. */
  signal: AbortSignal;
}

/** The `worker_cursor` row that holds the notifier's place in the event stream. */
const CURSOR = "telegram";
/** How many events one tick reads. */
const BATCH_SIZE = 200;
const DEFAULT_INTERVAL_MS = 5_000;

const NS_PER_MS = 1_000_000n;
const NS_PER_MINUTE = 60_000n * NS_PER_MS;
const NS_PER_HOUR = 60n * NS_PER_MINUTE;

/** A `working` row older than this is not news. */
const WORKING_WINDOW_MS = 10 * 60_000;
/** The reveal window counts as closing this long before it ends. */
const REVEAL_CLOSING_NS = 10n * NS_PER_MINUTE;
/** How long before the commit deadline each reminder goes out, in hours. */
const REMINDER_HOURS = [24, 1] as const;

/** Every message is Telegram HTML, and none unfurls the links in it. */
const SEND_OPTIONS = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;

/** The events that make an alert. The rest of the stream (deposits, reveals, …) is not news. */
const ALERTING = new Set(["task_created", "committed", "task_topped_up", "picked", "voided"]);

/** What one tick works with. */
interface Tick {
  db: Db;
  bot: Bot;
  render: RenderContext;
  /** The tick's time, `render.now`, in nanoseconds. */
  nowNs: bigint;
}

/**
 * One pass over the events, the working signals and the clock, run with the time that
 * `opts.now` gives at the start. See the top of this file for what it does.
 */
export async function notifierTick(opts: NotifierTickOptions): Promise<void> {
  const now = (opts.now ?? (() => new Date()))();
  const tick: Tick = {
    db: opts.db,
    bot: opts.bot,
    render: { webUrl: opts.webUrl, network: opts.network, now },
    nowNs: BigInt(now.getTime()) * NS_PER_MS,
  };
  await eventAlerts(tick);
  await workingAlerts(tick);
  await timerAlerts(tick);
}

/**
 * Runs `notifierTick` now, and again `intervalMs` after each tick ends, until `signal` aborts. The
 * wait starts when a tick ends, so ticks never overlap, however slow a send is. A tick that throws
 * is logged and the loop goes on.
 *
 * An abort during the wait ends the loop at once. An abort during a tick lets the tick finish
 * first, so that a message already claimed is sent and the cursor moves. A signal that is aborted
 * already runs no tick. The returned promise resolves once the loop has stopped, and never rejects.
 *
 * `webUrl` is checked first, once (see `checkWebUrl`), and a bad one makes this call throw before
 * anything runs: a server that is set up wrong should fail when it starts, not send broken links.
 */
export function startNotifier(opts: NotifierOptions): Promise<void> {
  checkWebUrl(opts.webUrl);
  const { intervalMs = DEFAULT_INTERVAL_MS, signal } = opts;
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ticking = false;

    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const run = async () => {
      ticking = true;
      try {
        await notifierTick(opts);
      } catch (error) {
        console.error("telegram notifier: tick failed:", error);
      }
      ticking = false;
      if (signal.aborted) finish();
      else timer = setTimeout(run, intervalMs);
    };

    if (signal.aborted) {
      finish();
      return;
    }
    // `once` removes the listener when it fires. An abort during a tick is seen after the tick.
    signal.addEventListener(
      "abort",
      () => {
        if (!ticking) finish();
      },
      { once: true },
    );
    void run();
  });
}

/**
 * Throws unless `webUrl` is an http(s) URL with a host and no query or fragment. Every link in a
 * message is `webUrl` and then `/tasks/<id>`, joined as text: a query or fragment would swallow
 * that path, and another scheme, such as `tg://`, which acts on the reader's account, would make
 * every link an action.
 */
function checkWebUrl(webUrl: string): void {
  // The text is what links are made of, so the text must start `http://` or `https://`. The URL
  // parser also takes `https:host` and leading blanks, which a joined link would carry along. For
  // these two schemes it fails on a missing host, so a URL that parses has one.
  if (!/^https?:\/\//i.test(webUrl) || URL.parse(webUrl) === null) {
    throw new Error(`webUrl must be an http(s) URL with a host, got ${JSON.stringify(webUrl)}`);
  }
  // A `?` or `#` starts a query or a fragment. The parser's `search` and `hash` read "" for an empty
  // one, so it is the text that is checked.
  if (/[?#]/.test(webUrl)) {
    throw new Error(`webUrl must have no query or fragment, got ${JSON.stringify(webUrl)}`);
  }
}

// The event stream.

interface EventRow {
  id: string;
  event: string;
  data: unknown;
  task_id: string | null;
}

async function eventAlerts(tick: Tick): Promise<void> {
  const { db } = tick;
  const after = await cursorOrHead(db);
  // `order by e.id`: the output column `id` is text, which would sort "10" before "9".
  const events = await db.query<EventRow>(
    `select e.id::text as id, e.event, e.data, e.task_id::text as task_id
     from events e
     where e.id > $1::bigint
     order by e.id
     limit $2`,
    [after, BATCH_SIZE],
  );
  for (const row of events) {
    const alert = await alertOf(tick, row);
    if (alert !== null) await deliver(tick, alert);
  }
  // Ids have gaps (a rolled-back or repeated insert uses one up), so the cursor is the last id read,
  // never a count. `greatest` keeps a second notifier from moving it back.
  const last = events.at(-1);
  if (last !== undefined) {
    await db.query(
      "update worker_cursor set event_id = greatest(event_id, $2::bigint) where name = $1",
      [CURSOR, last.id],
    );
  }
}

/**
 * The id of the last event the notifier has dealt with, as text. On its first run it has none, and
 * starts at the newest event (0 if there are none): what happened before the notifier existed is
 * history, and a first tick that announced all of it would flood every chat.
 */
async function cursorOrHead(db: Db): Promise<string> {
  await db.query(
    `insert into worker_cursor (name, event_id)
     select $1::text, coalesce(max(id), 0) from events
     on conflict (name) do nothing`,
    [CURSOR],
  );
  const [row] = await db.query<{ event_id: string }>(
    "select event_id::text as event_id from worker_cursor where name = $1",
    [CURSOR],
  );
  if (row === undefined) throw new Error("worker_cursor has no row for the Telegram notifier");
  return row.event_id;
}

/** The columns of `tasks` that alerts are made of. */
interface TaskRow {
  title: string | null;
  token: string;
  reward: string;
  /** The indexer writes an array of strings. */
  tags: string[];
  commit_deadline: string;
  commit_count: number;
}

/**
 * The alert that `row` makes, or null if it makes none. That is so for an event of another kind,
 * for a `committed` that replaces an entry, for a `new_task` whose commit window is over (nobody
 * can enter any more), and for a task the index does not hold, which `resolveRecipients` could not
 * address anyway.
 *
 * The task's id is `events.task_id`, which the indexer fills from `data.task_id`, or from `data.id`
 * for `task_created`, the one event that calls its id `id`. The count in `entry_committed` is the
 * task's `commit_count` as it is now. So several commits that one tick reads make one alert with
 * the latest count, and a rebuilt alert gets the key it had before.
 */
async function alertOf(tick: Tick, row: EventRow): Promise<Alert | null> {
  if (!ALERTING.has(row.event)) return null;
  const parsed = TenderEventSchema.safeParse({ event: row.event, data: row.data });
  const taskId = row.task_id;
  if (!parsed.success || taskId === null) {
    console.error(`telegram notifier: skipped event ${row.id} (${row.event}): it is malformed`);
    return null;
  }
  const [task] = await tick.db.query<TaskRow>(
    `select title, token, reward::text as reward, tags,
            commit_deadline::text as commit_deadline, commit_count
     from tasks where id = $1::numeric`,
    [taskId],
  );
  if (task === undefined) return null;

  const event = parsed.data;
  const title = titleOf(task.title, taskId);
  switch (event.event) {
    case "task_created":
      if (tick.nowNs >= BigInt(task.commit_deadline)) return null;
      return {
        kind: "new_task",
        taskId,
        title,
        reward: task.reward,
        token: task.token,
        tags: task.tags,
        commitDeadline: task.commit_deadline,
      };
    case "committed":
      if (event.data.replaced) return null;
      return { kind: "entry_committed", taskId, title, count: task.commit_count };
    case "task_topped_up":
      return {
        kind: "pool_grew",
        taskId,
        title,
        token: task.token,
        reward: event.data.reward,
        funders: await funderCount(tick.db, taskId),
      };
    case "picked":
      return {
        kind: "winner_paid",
        taskId,
        title,
        token: task.token,
        winners: event.data.winners.map(({ account, amount }) => ({ account, amount })),
        scorecardUri: event.data.scorecard_uri,
      };
    case "voided":
      return { kind: "task_voided", taskId, title, reason: event.data.reason };
    default:
      return null;
  }
}

async function funderCount(db: Db, taskId: string): Promise<number> {
  const [row] = await db.query<{ n: number }>(
    "select count(*)::int as n from funders where task_id = $1::numeric",
    [taskId],
  );
  return row?.n ?? 0;
}

// The working signals.

async function workingAlerts(tick: Tick): Promise<void> {
  const since = new Date(tick.render.now.getTime() - WORKING_WINDOW_MS);
  // A signal for a task the index does not hold yet still reaches the agent's owner, so the join
  // is a left one. `order by w.task_id` is the numeric column: `task_id` alone is the text output.
  const started = await tick.db.query<{ task_id: string; account: string; title: string | null }>(
    `select w.task_id::text as task_id, w.account, t.title
     from working w left join tasks t on t.id = w.task_id
     where w.started_at >= $1::timestamptz
     order by w.started_at, w.task_id, w.account`,
    [since.toISOString()],
  );
  for (const row of started) {
    const title = titleOf(row.title, row.task_id);
    await deliver(tick, { kind: "agent_started", taskId: row.task_id, title, agent: row.account });
  }
}

// The clock.

interface RevealRow {
  id: string;
  title: string | null;
  reveal_deadline: string;
}

interface DueRow {
  id: string;
  title: string | null;
}

/**
 * Tasks in their reveal window with an entry not yet revealed. `$1` is now, in nanoseconds. A
 * task's phase runs from one deadline up to, and not including, the next, as `phaseAt` has it.
 */
const REVEAL_OPEN = `
  select t.id::text as id, t.title, t.reveal_deadline::text as reveal_deadline
  from tasks t
  where t.commit_deadline <= $1::numeric and $1::numeric < t.reveal_deadline
    and t.reveal_count < t.commit_count
  order by t.id`;

/**
 * The same, within `REVEAL_CLOSING_NS` of the end of the window; `$2` is now plus that. A reveal
 * window can be shorter than the lead (the shortest on mainnet is 5 minutes), so the window must
 * also be open: `commit_deadline <= now`.
 */
const REVEAL_CLOSING = `
  select t.id::text as id, t.title, t.reveal_deadline::text as reveal_deadline
  from tasks t
  where t.commit_deadline <= $1::numeric
    and t.reveal_deadline <= $2::numeric and $1::numeric < t.reveal_deadline
    and t.reveal_count < t.commit_count
  order by t.id`;

/**
 * Tasks whose commit window still has `H` hours or less to run, and that were open for longer than
 * `H + 1` hours when posted, so that the reminder does not follow the announcement within the hour.
 * `$1` is now, `$2` is now plus `H` hours and `$3` is `H + 1` hours, all in nanoseconds. A reminder
 * is for an open window: after the deadline there is nothing to be reminded of.
 */
const DEADLINE_REMINDER = `
  select t.id::text as id, t.title
  from tasks t
  where $1::numeric < t.commit_deadline and t.commit_deadline <= $2::numeric
    and t.commit_deadline - t.created_at > $3::numeric
  order by t.id`;

async function timerAlerts(tick: Tick): Promise<void> {
  const { db, nowNs } = tick;
  const opening = await db.query<RevealRow>(REVEAL_OPEN, [nowNs]);
  for (const task of opening) {
    const title = titleOf(task.title, task.id);
    await deliver(tick, {
      kind: "reveal_open",
      taskId: task.id,
      title,
      revealDeadline: task.reveal_deadline,
    });
  }
  const closing = await db.query<RevealRow>(REVEAL_CLOSING, [nowNs, nowNs + REVEAL_CLOSING_NS]);
  for (const task of closing) {
    const title = titleOf(task.title, task.id);
    await deliver(tick, {
      kind: "reveal_closing",
      taskId: task.id,
      title,
      revealDeadline: task.reveal_deadline,
    });
  }
  for (const hoursLeft of REMINDER_HOURS) {
    const lead = BigInt(hoursLeft) * NS_PER_HOUR;
    const due = await db.query<DueRow>(DEADLINE_REMINDER, [
      nowNs,
      nowNs + lead,
      lead + NS_PER_HOUR,
    ]);
    for (const task of due) {
      const title = titleOf(task.title, task.id);
      await deliver(tick, { kind: "deadline_reminder", taskId: task.id, title, hoursLeft });
    }
  }
}

// Sending.

/**
 * A task's name in a message: its title on one line (a title may hold line breaks), or `Task #<id>`
 * if it has none.
 */
function titleOf(title: string | null, taskId: string): string {
  const oneLine = (title ?? "").replace(/\s+/g, " ").trim();
  return oneLine === "" ? `Task #${taskId}` : oneLine;
}

/**
 * Sends `alert` to each chat that should hear it and has not. An alert that cannot be rendered
 * (`renderAlert` throws on an amount or a deadline that is not a number) or addressed
 * (`resolveRecipients` throws on a row the database cannot read) is logged and skipped, so that
 * one task with bad data cannot stall the alerts behind it, or the cursor.
 */
async function deliver(tick: Tick, alert: Alert): Promise<void> {
  let text: string;
  let chats: string[];
  try {
    text = renderAlert(alert, tick.render);
    chats = await resolveRecipients(tick.db, alert);
  } catch (error) {
    console.error(`telegram notifier: skipped ${alert.kind} for task ${alert.taskId}:`, error);
    return;
  }
  const key = dedupeKey(alert);
  for (const chat of chats) await sendOnce(tick, chat, key, text);
}

/**
 * Sends `text` to `chat`, if `key` was not claimed for the chat before. The claim is made first and
 * a failed send keeps it, so a chat hears an alert at most once.
 *
 * Telegram answers 403 when the user blocked the bot or the bot was kicked from a group. The chat
 * cannot be reached, so its link and its tag watches go, and the next alert does not try it. Any
 * other failure is logged, and the tick goes on with the next chat.
 */
async function sendOnce(tick: Tick, chat: string, key: string, text: string): Promise<void> {
  const claimed = await tick.db.query(
    "insert into tg_sent (chat_id, dedupe_key) values ($1, $2) on conflict do nothing returning 1",
    [chat, key],
  );
  if (claimed.length === 0) return;
  try {
    await tick.bot.api.sendMessage(chat, text, SEND_OPTIONS);
  } catch (error) {
    if (error instanceof GrammyError && error.error_code === 403) {
      await tick.db.tx(async (tx) => {
        await tx.query("delete from tg_links where chat_id = $1", [chat]);
        await tx.query("delete from tg_watches where chat_id = $1", [chat]);
      });
      return;
    }
    // The message only: a GrammyError also carries the payload, which holds the text sent.
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`telegram notifier: could not send ${key} to chat ${chat}: ${reason}`);
  }
}
