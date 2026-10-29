import type { Db } from "@tender/db";
import type { ApiCallFn, Bot, Transformer } from "grammy";
import type { Chat, Update, UserFromGetMe } from "grammy/types";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { type Alert, createBot, resolveRecipients } from "../src/index";
import { linkChat, openTestDb, seedLinkNonce, seedTask, watchTag } from "./helpers";

// The bot runs against one migrated database, opened once because a PGlite takes close to a second
// to open. Its Telegram API is fake: a transformer installed after `createBot`'s own wraps them (the
// last one installed runs first), answers every call and records it, so nothing reaches the network.
// A test that adds rows uses chats, accounts, nonces and task ids of its own.

const TOKEN = "123:test";
const WEB_URL = "https://tender.example";
const LINK_PAGE = `${WEB_URL}/telegram`;

/** The bot's clock: 2026-10-29T05:00:00Z, in nanoseconds. */
const NOW_NS = 1_793_250_000_000_000_000n;
const HOUR_NS = 3_600_000_000_000n;

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

// What the bot says. These are the brief's words where the brief gives them, and ours elsewhere.
const FRESH_LINK = `Open ${LINK_PAGE} and tap “Link Telegram” to get a fresh link.`;
const PRIVATE_ONLY = "Tender alerts work in private chats only.";
const TAG_RULE = "A tag is 1 to 24 lowercase letters, digits or hyphens, such as research.";
const WATCH_USAGE = `${TAG_RULE} Send /watch research.`;
const UNWATCH_USAGE = `${TAG_RULE} Send /unwatch research.`;
const MUTED = "Muted. No alerts until you send /unmute.";
const UNMUTED = "Unmuted. You will get alerts again.";
const STOPPED = `Stopped. This chat is unlinked and watches no tags, so it gets no more alerts. To link again, open ${LINK_PAGE} and tap “Link Telegram”.`;
const NOTHING_TO_STOP = "Nothing to stop: this chat is not linked and watches no tags.";
const HELP = [
  "<b>Tender alerts</b>",
  "/status · your account, mute state, watched tags and latest tasks",
  "/watch tag · hear about new tasks with a tag, like /watch research",
  "/unwatch tag · stop hearing about a tag",
  "/mute · pause alerts, /unmute to resume",
  "/stop · unlink this chat and clear its watches",
  "",
  `To link an account, open ${LINK_PAGE} and tap “Link Telegram”.`,
].join("\n");

function linked(account: string): string {
  return `Linked to <b>${account}</b>. You will get alerts for it and its agents. /help`;
}

function notLinked(verb: "mute" | "unmute"): string {
  return `This chat is not linked to an account, so there is nothing to ${verb}. Open ${LINK_PAGE} and tap “Link Telegram” to link one. To stop tag alerts, send /unwatch with the tag.`;
}

// The fake Telegram.

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}
const calls: ApiCall[] = [];

const fakeTelegram: Transformer = (_prev, method, payload) => {
  const sent = payload as unknown as Record<string, unknown>;
  calls.push({ method, payload: sent });
  // Telegram answers a sendMessage with the message it made.
  const message = { message_id: calls.length, date: 0, chat: { id: sent.chat_id }, text: "" };
  return Promise.resolve({ ok: true, result: message } as never);
};

function botOn(database: Db, options: { webUrl?: string; now?: (() => bigint) | null } = {}): Bot {
  const { webUrl = WEB_URL, now = () => NOW_NS } = options;
  const made = createBot({
    token: TOKEN,
    db: database,
    webUrl,
    botInfo: BOT_INFO,
    ...(now === null ? {} : { now }),
  });
  made.api.config.use(fakeTelegram);
  return made;
}

let db: Db;
let bot: Bot;

beforeAll(async () => {
  db = await openTestDb();
  bot = botOn(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

// Fake updates, the way Telegram's servers shape them.

let updateCounter = 0;

function privateChat(id: number): Chat {
  return { id, type: "private", first_name: "Ada" };
}

function groupChat(id: number, type: "group" | "supergroup" | "channel"): Chat {
  return { id, type, title: "Agents" } as Chat;
}

/** The text of a message and the `bot_command` entity Telegram adds when it starts with a command. */
function textOf(text: string) {
  const command = /^\/\S+/.exec(text)?.[0];
  const entities =
    command === undefined
      ? {}
      : { entities: [{ type: "bot_command", offset: 0, length: command.length }] };
  return { text, ...entities };
}

function messageIn(chat: Chat, text: string): Update {
  updateCounter += 1;
  const from = { id: chat.type === "private" ? chat.id : 42, is_bot: false, first_name: "Ada" };
  return {
    update_id: updateCounter,
    message: { message_id: updateCounter, date: 1_793_250_000, chat, from, ...textOf(text) },
  } as Update;
}

function channelPostIn(chat: Chat, text: string): Update {
  updateCounter += 1;
  return {
    update_id: updateCounter,
    channel_post: { message_id: updateCounter, date: 1_793_250_000, chat, ...textOf(text) },
  } as Update;
}

/**
 * Fails unless `html` is something Telegram's HTML parse mode takes: only `<b>`, `<code>` and
 * `<a href="…">` tags, closed in order, and `&` only as one of the four entities `escapeHtml`
 * writes. The API is fake here, so a stray `<tag>` in a reply would otherwise show up only on the
 * real one.
 */
function assertTelegramHtml(html: string): void {
  const open: string[] = [];
  const text = html.replace(/<(\/?)(b|code|a)( href="[^"<>]*")?>/g, (_tag, closing, name) => {
    if (closing === "") open.push(name);
    else expect(open.pop(), `closing tag in: ${html}`).toBe(name);
    return "";
  });
  expect(open, `unclosed tag in: ${html}`).toEqual([]);
  expect(text, `stray < or > in: ${html}`).not.toMatch(/[<>]/);
  expect(text, `bare & in: ${html}`).not.toMatch(/&(?!(?:amp|lt|gt|quot);)/);
}

function chatOf(update: Update): number {
  const chat = (update.message ?? update.channel_post)?.chat;
  if (chat === undefined) throw new Error("this helper only builds messages and channel posts");
  return chat.id;
}

/**
 * Feeds `update` to the bot and returns what the bot sent to that chat meanwhile, as HTML. Every
 * call must be a `sendMessage` in HTML mode with link previews off, and its text valid HTML.
 */
async function deliver(update: Update, via: Bot = bot): Promise<string[]> {
  const before = calls.length;
  await via.handleUpdate(update);
  const chat = chatOf(update);
  const made = calls.slice(before);
  for (const call of made) {
    expect(call.method).toBe("sendMessage");
    expect(call.payload.parse_mode).toBe("HTML");
    expect(call.payload.link_preview_options).toEqual({ is_disabled: true });
    assertTelegramHtml(String(call.payload.text));
  }
  return made
    .filter((call) => call.payload.chat_id === chat)
    .map((call) => String(call.payload.text));
}

/** What the bot answers to `text` in the private chat `chat`; it must answer exactly once. */
async function say(chat: number, text: string, via: Bot = bot): Promise<string> {
  const replies = await deliver(messageIn(privateChat(chat), text), via);
  expect(replies, `replies to ${text}`).toHaveLength(1);
  return replies[0] ?? "";
}

// The database, as the tests look at it.

let lastChat = 1000;
/** A chat id nobody else in this file has used. */
function newChat(): number {
  lastChat += 1;
  return lastChat;
}

async function linkOf(chat: number): Promise<{ account: string; muted: boolean } | null> {
  const rows = await db.query<{ account: string; muted: boolean }>(
    "select account, muted from tg_links where chat_id = $1",
    [chat],
  );
  return rows[0] ?? null;
}

async function tagsOf(chat: number): Promise<string[]> {
  const rows = await db.query<{ tag: string }>(
    "select tag from tg_watches where chat_id = $1 order by tag",
    [chat],
  );
  return rows.map((row) => row.tag);
}

async function sentKeys(chat: number): Promise<string[]> {
  const rows = await db.query<{ dedupe_key: string }>(
    "select dedupe_key from tg_sent where chat_id = $1 order by dedupe_key",
    [chat],
  );
  return rows.map((row) => row.dedupe_key);
}

async function nonceUsed(nonce: string): Promise<boolean> {
  const rows = await db.query<{ used: boolean }>(
    "select used from tg_link_nonces where nonce = $1",
    [nonce],
  );
  expect(rows, `nonce ${nonce} exists`).toHaveLength(1);
  return rows[0]?.used ?? false;
}

// Linking.

test("start_with_valid_nonce_links", async () => {
  const chat = newChat();
  await seedLinkNonce(db, "nonce-valid", "acme.near");

  expect(await say(chat, "/start nonce-valid")).toBe(linked("acme.near"));

  expect(await linkOf(chat)).toEqual({ account: "acme.near", muted: false });
  expect(await nonceUsed("nonce-valid")).toBe(true);

  // Telegram trims what it sends, but a nonce with spaces around it is still the nonce.
  const other = newChat();
  await seedLinkNonce(db, "nonce-padded", "padded.near");
  expect(await say(other, "/start   nonce-padded  ")).toBe(linked("padded.near"));
  expect(await linkOf(other)).toEqual({ account: "padded.near", muted: false });
});

test("start_with_used_or_expired_nonce_rejected", async () => {
  await seedLinkNonce(db, "nonce-used", "used.near", { used: true });
  await seedLinkNonce(db, "nonce-expired", "expired.near", { expiresInMs: -60_000 });
  await seedLinkNonce(db, "nonce-just-expired", "just-expired.near", { expiresInMs: -1_000 });

  // Missing (no payload at all), unknown, used and expired nonces all get the same answer, so the
  // reply does not tell a guesser which of them it hit.
  for (const text of [
    "/start",
    "/start    ",
    "/start never-minted",
    "/start nonce-used",
    "/start nonce-expired",
    "/start nonce-just-expired",
    "/start NONCE-USED",
    "/start nonce-used extra words",
  ]) {
    const chat = newChat();
    expect(await say(chat, text), text).toBe(FRESH_LINK);
    expect(await linkOf(chat), text).toBeNull();
  }

  // A rejected nonce stays as it was: the used one used, the expired one never spent.
  expect(await nonceUsed("nonce-used")).toBe(true);
  expect(await nonceUsed("nonce-expired")).toBe(false);

  // A nonce that worked once is used up: the next chat to send it gets the refusal.
  await seedLinkNonce(db, "nonce-once", "once.near");
  const first = newChat();
  const replay = newChat();
  expect(await say(first, "/start nonce-once")).toBe(linked("once.near"));
  expect(await say(replay, "/start nonce-once")).toBe(FRESH_LINK);
  expect(await linkOf(replay)).toBeNull();
  // Not even the chat that spent it can use it again: that would be a second link.
  await db.query("delete from tg_links where chat_id = $1", [first]);
  expect(await say(first, "/start nonce-once")).toBe(FRESH_LINK);
  expect(await linkOf(first)).toBeNull();
});

test("a_nonce_sent_twice_at_once_links_one_chat", async () => {
  await seedLinkNonce(db, "nonce-race", "racer.near");
  const a = newChat();
  const b = newChat();

  const [toA, toB] = await Promise.all([
    deliver(messageIn(privateChat(a), "/start nonce-race")),
    deliver(messageIn(privateChat(b), "/start nonce-race")),
  ]);

  expect([...toA, ...toB].sort()).toEqual([FRESH_LINK, linked("racer.near")].sort());
  const links = [await linkOf(a), await linkOf(b)].filter((link) => link !== null);
  expect(links).toEqual([{ account: "racer.near", muted: false }]);
});

test("start_relinks_a_chat_to_the_new_account", async () => {
  const chat = newChat();
  await linkChat(db, chat, "old.near", { muted: true });
  await watchTag(db, chat, "research");
  await seedLinkNonce(db, "nonce-relink", "new.near");

  expect(await say(chat, "/start nonce-relink")).toBe(linked("new.near"));

  // The old link is replaced, not added to. Linking says "you will get alerts", so it also lifts a
  // mute; the chat's tag watches belong to the chat and stay.
  expect(await linkOf(chat)).toEqual({ account: "new.near", muted: false });
  expect(await tagsOf(chat)).toEqual(["research"]);
  const rows = await db.query("select 1 from tg_links where chat_id = $1", [chat]);
  expect(rows).toHaveLength(1);
});

/** `real`, except that every statement on a transaction handle that touches `tg_links` fails. */
function failingLinkWrites(real: Db): Db {
  const wrap = (inner: Db): Db => ({
    query: <T>(sql: string, params?: unknown[]) =>
      /\btg_links\b/.test(sql)
        ? Promise.reject<T[]>(new Error("disk full"))
        : inner.query<T>(sql, params),
    exec: (sql) => inner.exec(sql),
    tx: (fn) => inner.tx((handle) => fn(wrap(handle))),
    close: () => inner.close(),
  });
  return wrap(real);
}

test("a_failed_link_does_not_burn_the_nonce", async () => {
  const chat = newChat();
  await seedLinkNonce(db, "nonce-rollback", "rollback.near");
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const broken = botOn(failingLinkWrites(db));
    // The write fails after the nonce was marked used. Both happen in one transaction, so the
    // mark goes with it: the person can tap the link again. The bot logs the failure and goes on.
    expect(await deliver(messageIn(privateChat(chat), "/start nonce-rollback"), broken)).toEqual(
      [],
    );
    expect(errors).toHaveBeenCalledOnce();
  } finally {
    errors.mockRestore();
  }
  expect(await nonceUsed("nonce-rollback")).toBe(false);
  expect(await linkOf(chat)).toBeNull();

  expect(await say(chat, "/start nonce-rollback")).toBe(linked("rollback.near"));
});

// Private chats only.

test("group_chat_refused_once", async () => {
  const group = groupChat(-1_001_000_000_001, "supergroup");
  expect(await sentKeys(group.id)).toEqual([]);

  // Whatever is said first gets the one refusal ...
  expect(await deliver(messageIn(group, "/help"))).toEqual([PRIVATE_ONLY]);
  expect(await sentKeys(group.id)).toEqual(["group_refused"]);

  // ... and after that the chat is ignored, commands included.
  for (const text of ["/help", "/start nonce-x", "/watch research", "/status", "/stop", "hello"]) {
    expect(await deliver(messageIn(group, text)), text).toEqual([]);
  }
  expect(await sentKeys(group.id)).toEqual(["group_refused"]);

  // A restarted bot has the memory in the database, so it stays quiet too.
  expect(await deliver(messageIn(group, "/help"), botOn(db))).toEqual([]);

  // Two messages that arrive together in a new group still get one refusal between them. (Count
  // what the bot sent to the chat: both deliveries would report the same single message.)
  const busy = groupChat(-1_001_000_000_004, "supergroup");
  await Promise.all([
    bot.handleUpdate(messageIn(busy, "/help")),
    bot.handleUpdate(messageIn(busy, "/status")),
  ]);
  const toBusy = calls.filter((call) => call.payload.chat_id === busy.id);
  expect(toBusy.map((call) => call.payload.text)).toEqual([PRIVATE_ONLY]);

  // Every other kind of chat gets its own single refusal.
  const plain = groupChat(-4_001, "group");
  expect(await deliver(messageIn(plain, "/help"))).toEqual([PRIVATE_ONLY]);
  expect(await deliver(messageIn(plain, "/help"))).toEqual([]);
  const channel = groupChat(-1_001_000_000_002, "channel");
  expect(await deliver(channelPostIn(channel, "/help"))).toEqual([PRIVATE_ONLY]);
  expect(await deliver(channelPostIn(channel, "/help"))).toEqual([]);
  expect(await sentKeys(plain.id)).toEqual(["group_refused"]);
  expect(await sentKeys(channel.id)).toEqual(["group_refused"]);

  // Nothing a group said did anything: no link, no watch.
  for (const chat of [group.id, plain.id, channel.id]) {
    expect(await linkOf(chat)).toBeNull();
    expect(await tagsOf(chat)).toEqual([]);
  }
});

test("a_group_cannot_link_or_spend_a_nonce", async () => {
  await seedLinkNonce(db, "nonce-for-group", "group-target.near");
  const group = groupChat(-1_001_000_000_003, "supergroup");

  expect(await deliver(messageIn(group, "/start nonce-for-group"))).toEqual([PRIVATE_ONLY]);

  expect(await linkOf(group.id)).toBeNull();
  expect(await nonceUsed("nonce-for-group")).toBe(false);
  // The person it was minted for can still use it in their private chat.
  const chat = newChat();
  expect(await say(chat, "/start nonce-for-group")).toBe(linked("group-target.near"));
});

// Tags.

test("watch_validates_tag", async () => {
  const chat = newChat();
  const good = ["research", "a", "0", "web3", "a-b-c", "x".repeat(24)];
  const bad = [
    "",
    "Research",
    "has space",
    "under_score",
    "tag!",
    "x".repeat(25),
    "ünï",
    "a/b",
    "<b>",
    "research summary",
    "a\tb",
    "tag.",
  ];

  for (const tag of good) {
    expect(await say(chat, `/watch ${tag}`), tag).toBe(
      `Watching <b>${tag}</b>. New tasks with this tag are sent to this chat. /unwatch ${tag} to stop.`,
    );
  }
  for (const tag of bad) {
    expect(await say(chat, `/watch ${tag}`), JSON.stringify(tag)).toBe(WATCH_USAGE);
  }

  // Only the good tags were stored; this chat is not linked, and it still hears them.
  expect(await tagsOf(chat)).toEqual([...good].sort());
  expect(await linkOf(chat)).toBeNull();

  // Watching a tag twice is the same as once.
  await say(chat, "/watch research");
  expect(await tagsOf(chat)).toEqual([...good].sort());
});

test("unwatch_removes_only_that_tag", async () => {
  const chat = newChat();
  const other = newChat();
  await watchTag(db, chat, "alpha");
  await watchTag(db, chat, "beta");
  await watchTag(db, other, "alpha");

  expect(await say(chat, "/unwatch alpha")).toBe("Stopped watching <b>alpha</b>.");
  expect(await tagsOf(chat)).toEqual(["beta"]);
  expect(await tagsOf(other)).toEqual(["alpha"]);

  expect(await say(chat, "/unwatch alpha")).toBe("You are not watching <b>alpha</b>.");
  for (const text of [
    "/unwatch",
    "/unwatch Beta",
    "/unwatch beta alpha",
    `/unwatch ${"x".repeat(25)}`,
  ]) {
    expect(await say(chat, text), text).toBe(UNWATCH_USAGE);
  }
  expect(await tagsOf(chat)).toEqual(["beta"]);

  // The chat never linked an account; /unwatch is how it stops hearing its tags.
  expect(await linkOf(chat)).toBeNull();
  expect(await say(chat, "/unwatch beta")).toBe("Stopped watching <b>beta</b>.");
  expect(await tagsOf(chat)).toEqual([]);
});

// Mute and stop.

test("mute_and_unmute_change_only_this_chat", async () => {
  const chat = newChat();
  const other = newChat();
  const mutedOther = newChat();
  await linkChat(db, chat, "mute-a.near");
  await linkChat(db, other, "mute-b.near");
  await linkChat(db, mutedOther, "mute-c.near", { muted: true });

  expect(await say(chat, "/mute")).toBe(MUTED);
  expect(await linkOf(chat)).toEqual({ account: "mute-a.near", muted: true });
  expect(await say(chat, "/mute")).toBe(MUTED);
  expect(await linkOf(chat)).toEqual({ account: "mute-a.near", muted: true });

  expect(await say(chat, "/unmute")).toBe(UNMUTED);
  expect(await linkOf(chat)).toEqual({ account: "mute-a.near", muted: false });
  expect(await say(chat, "/unmute")).toBe(UNMUTED);
  expect(await linkOf(chat)).toEqual({ account: "mute-a.near", muted: false });

  // Nobody else's mute moved, either way.
  expect(await linkOf(other)).toEqual({ account: "mute-b.near", muted: false });
  expect(await linkOf(mutedOther)).toEqual({ account: "mute-c.near", muted: true });
});

test("mute_and_unmute_without_a_link_say_how_to_link", async () => {
  const chat = newChat();
  await watchTag(db, chat, "alpha");

  expect(await say(chat, "/mute")).toBe(notLinked("mute"));
  expect(await say(chat, "/unmute")).toBe(notLinked("unmute"));

  // Nothing was created by asking, and the watch is still there.
  expect(await linkOf(chat)).toBeNull();
  expect(await tagsOf(chat)).toEqual(["alpha"]);
});

test("stop_unlinks_and_clears_watches", async () => {
  const chat = newChat();
  const bystander = newChat();
  await linkChat(db, chat, "stop-a.near");
  await watchTag(db, chat, "alpha");
  await watchTag(db, chat, "beta");
  await linkChat(db, bystander, "stop-b.near");
  await watchTag(db, bystander, "alpha");

  expect(await say(chat, "/stop")).toBe(STOPPED);

  expect(await linkOf(chat)).toBeNull();
  expect(await tagsOf(chat)).toEqual([]);
  expect(await linkOf(bystander)).toEqual({ account: "stop-b.near", muted: false });
  expect(await tagsOf(bystander)).toEqual(["alpha"]);

  // Stopping again has nothing left to stop.
  expect(await say(chat, "/stop")).toBe(NOTHING_TO_STOP);

  // A chat that never linked, only watched, is cleared too.
  const watcher = newChat();
  await watchTag(db, watcher, "gamma");
  expect(await say(watcher, "/stop")).toBe(STOPPED);
  expect(await tagsOf(watcher)).toEqual([]);

  // A stopped chat can link again with a new nonce.
  await seedLinkNonce(db, "nonce-after-stop", "stop-a.near");
  expect(await say(chat, "/start nonce-after-stop")).toBe(linked("stop-a.near"));
  expect(await linkOf(chat)).toEqual({ account: "stop-a.near", muted: false });
});

// Status.

const WINDOWS = {
  // The commit, reveal, pick and fallback deadlines, in hours from `NOW_NS`, that put a task in
  // each phase at that time.
  open: [1n, 2n, 3n, 4n],
  revealing: [-1n, 1n, 2n, 3n],
  judging: [-2n, -1n, 1n, 2n],
  fallback: [-3n, -2n, -1n, 1n],
  expired: [-4n, -3n, -2n, -1n],
} as const;

async function seedTaskIn(
  phase: keyof typeof WINDOWS | "settled",
  id: string,
  poster: string,
  title: string | null,
): Promise<void> {
  const [commit, reveal, pick, fallback] = WINDOWS[phase === "settled" ? "expired" : phase];
  const at = (hours: bigint) => (NOW_NS + hours * HOUR_NS).toString();
  await seedTask(db, {
    id,
    poster,
    title,
    commit_deadline: at(commit),
    reveal_deadline: at(reveal),
    pick_deadline: at(pick),
    fallback_deadline: at(fallback),
    // A settled task has an outcome, and then the deadlines no longer matter. These are still in
    // the "expired" window, so only the outcome can make this row read "settled".
    outcome: phase === "settled" ? { kind: "picked" } : null,
  });
}

function taskLine(id: string, title: string, phase: string): string {
  return `<a href="${WEB_URL}/tasks/${id}">${title}</a> · ${phase}`;
}

test("status_lists_latest_tasks", async () => {
  const chat = newChat();
  const account = "status-poster.near";
  await linkChat(db, chat, account);
  await watchTag(db, chat, "beta");
  await watchTag(db, chat, "alpha");
  // Five tasks, inserted out of order. The three with the highest ids are the latest, newest first.
  await seedTaskIn("open", "303", account, null);
  await seedTaskIn("settled", "305", account, "Multi\n  line\ttitle");
  await seedTaskIn("expired", "301", account, "Oldest");
  await seedTaskIn("revealing", "304", account, 'Needs <b>care</b> & "quotes"');
  await seedTaskIn("judging", "302", account, "Second oldest");
  // Someone else's later task is not this account's.
  await seedTaskIn("open", "399", "somebody-else.near", "Not mine");

  expect(await say(chat, "/status")).toBe(
    [
      `Account: <b>${account}</b>`,
      "Alerts: on",
      "Watching: alpha, beta",
      "",
      "<b>Latest tasks</b>",
      taskLine("305", "Multi line title", "settled"),
      taskLine("304", "Needs &lt;b&gt;care&lt;/b&gt; &amp; &quot;quotes&quot;", "revealing"),
      taskLine("303", "Task #303", "open"),
    ].join("\n"),
  );

  // The other phases read right too.
  const phases = newChat();
  await linkChat(db, phases, "phases.near");
  await seedTaskIn("fallback", "313", "phases.near", "Fallback");
  await seedTaskIn("judging", "312", "phases.near", "Judging");
  await seedTaskIn("expired", "311", "phases.near", "Expired");
  const reply = await say(phases, "/status");
  expect(reply).toContain(taskLine("313", "Fallback", "fallback"));
  expect(reply).toContain(taskLine("312", "Judging", "judging"));
  expect(reply).toContain(taskLine("311", "Expired", "expired"));
});

test("status_shows_mute_and_an_account_without_tasks", async () => {
  const chat = newChat();
  await linkChat(db, chat, "quiet.near", { muted: true });

  expect(await say(chat, "/status")).toBe(
    [
      "Account: <b>quiet.near</b>",
      "Alerts: muted (/unmute to resume)",
      "Watching: no tags",
      "",
      "No tasks posted yet.",
    ].join("\n"),
  );
});

test("status_of_an_unlinked_chat_shows_its_watches_and_how_to_link", async () => {
  const chat = newChat();
  await watchTag(db, chat, "gamma");

  expect(await say(chat, "/status")).toBe(
    [
      "Not linked to an account.",
      "Watching: gamma",
      `Open ${LINK_PAGE} and tap “Link Telegram” to link one.`,
    ].join("\n"),
  );

  const empty = newChat();
  expect(await say(empty, "/status")).toBe(
    [
      "Not linked to an account.",
      "Watching: no tags",
      `Open ${LINK_PAGE} and tap “Link Telegram” to link one.`,
    ].join("\n"),
  );
});

test("status_reads_phases_at_the_wall_clock_by_default", async () => {
  const chat = newChat();
  await linkChat(db, chat, "clock.near");
  const year = (y: number) => (BigInt(Date.UTC(y, 0, 1)) * 1_000_000n).toString();
  await seedTask(db, {
    id: "321",
    poster: "clock.near",
    title: "Long ago",
    commit_deadline: year(2001),
    reveal_deadline: year(2002),
    pick_deadline: year(2003),
    fallback_deadline: year(2004),
  });
  await seedTask(db, {
    id: "322",
    poster: "clock.near",
    title: "Far ahead",
    commit_deadline: year(2100),
    reveal_deadline: year(2101),
    pick_deadline: year(2102),
    fallback_deadline: year(2103),
  });

  const reply = await say(chat, "/status", botOn(db, { now: null }));

  expect(reply).toContain(taskLine("322", "Far ahead", "open"));
  expect(reply).toContain(taskLine("321", "Long ago", "expired"));
});

// Help, escaping and the wiring.

test("help_lists_the_commands", async () => {
  expect(await say(newChat(), "/help")).toBe(HELP);
});

test("replies_escape_what_people_wrote", async () => {
  const chat = newChat();
  const account = `evil<i>&"co`;
  const escaped = "evil&lt;i&gt;&amp;&quot;co";
  await seedLinkNonce(db, "nonce-evil", account);

  expect(await say(chat, "/start nonce-evil")).toBe(linked(escaped));

  // A watch row can hold anything if some other writer put it there; /status shows it as typed.
  await watchTag(db, chat, "<u>x");
  const status = await say(chat, "/status");
  expect(status).toContain(`Account: <b>${escaped}</b>`);
  expect(status).toContain("Watching: &lt;u&gt;x");
});

test("a_trailing_slash_on_the_web_url_makes_no_double_slash", async () => {
  const chat = newChat();
  const slashed = botOn(db, { webUrl: `${WEB_URL}//` });

  expect(await say(chat, "/start", slashed)).toBe(FRESH_LINK);
  expect(await say(chat, "/help", slashed)).toBe(HELP);
});

test("commands_decide_who_hears_alerts", async () => {
  // The bot writes the rows the notifier reads. A task with a tag of its own, one chat that only
  // watches the tag and one linked to the poster, then every command that should change who hears.
  const poster = "hears-poster.near";
  const tag = "zz-hears";
  await seedTask(db, { id: "9017", poster, title: "Hear me", tags: [tag] });
  const alert: Alert = {
    kind: "new_task",
    taskId: "9017",
    title: "Hear me",
    reward: "5000000",
    token: "usdc.test",
    tags: [tag],
    commitDeadline: "1793235600000000000",
  };
  const watcher = newChat();
  const owner = newChat();
  const hears = async () => {
    const ids = await resolveRecipients(db, alert);
    return [watcher, owner].filter((chat) => ids.includes(String(chat)));
  };
  expect(await hears()).toEqual([]);

  await say(watcher, `/watch ${tag}`);
  await seedLinkNonce(db, "nonce-hears", poster);
  await say(owner, "/start nonce-hears");
  expect(await hears()).toEqual([watcher, owner]);

  await say(owner, "/mute");
  expect(await hears()).toEqual([watcher]);
  await say(owner, "/unmute");
  expect(await hears()).toEqual([watcher, owner]);

  await say(watcher, `/unwatch ${tag}`);
  expect(await hears()).toEqual([owner]);

  await say(owner, "/stop");
  expect(await hears()).toEqual([]);
});

test("uses_auto_retry_and_the_throttler", async () => {
  const fresh = createBot({ token: TOKEN, db, webUrl: WEB_URL, botInfo: BOT_INFO });
  // The chain as grammY builds it: each transformer wraps the one installed before it.
  const starts: number[] = [];
  const network: ApiCallFn = async () => {
    starts.push(Date.now());
    // The first answer is a flood wait that asks for no wait. autoRetry sends the call again.
    const floodWait = {
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 0",
      parameters: { retry_after: 0 },
    };
    return (starts.length === 1 ? floodWait : { ok: true, result: true }) as never;
  };
  const chain = fresh.api.config
    .installedTransformers()
    .reduce<ApiCallFn>(
      (prev, transformer) => (method, payload, signal) =>
        transformer(prev, method, payload, signal),
      network,
    );

  expect(await chain("sendMessage", { chat_id: 7, text: "one" })).toEqual({
    ok: true,
    result: true,
  });
  expect(starts).toHaveLength(2);

  // The throttler lets a chat have one message a second.
  await chain("sendMessage", { chat_id: 7, text: "two" });
  expect(starts).toHaveLength(3);
  expect((starts[2] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(900);
}, 15_000);

test("a_failing_update_is_logged_not_thrown", async () => {
  const down = () => Promise.reject(new Error("database is down"));
  const brokenDb: Db = { query: down, exec: down, tx: down, close: () => Promise.resolve() };
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    // If this threw, long polling would stop and a webhook would be asked again and again.
    const replies = await deliver(messageIn(privateChat(newChat()), "/status"), botOn(brokenDb));
    expect(replies).toEqual([]);
    expect(errors).toHaveBeenCalledOnce();
  } finally {
    errors.mockRestore();
  }
});
