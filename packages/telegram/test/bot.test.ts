import type { Db } from "@tender/db";
import type { ApiCallFn, Bot, Transformer } from "grammy";
import type { Chat, Update, UserFromGetMe } from "grammy/types";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { type Alert, createBot, resolveRecipients } from "../src/index";
import {
  linkChat,
  openTestDb,
  seedAgent,
  seedEntry,
  seedLinkNonce,
  seedTask,
  watchTag,
} from "./helpers";

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

/** How many tags one chat can watch (P04-R7). */
const WATCH_LIMIT = 20;

function watching(tag: string): string {
  return `Watching <b>${tag}</b>. New tasks with this tag are sent to this chat. /unwatch ${tag} to stop.`;
}

function watchFull(tag: string): string {
  return `Not watching <b>${tag}</b>: this chat already watches ${WATCH_LIMIT} tags, the most one chat can. Send /unwatch with a tag you no longer need, then /watch ${tag} again.`;
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

/** The kinds of update that hold a message. */
type MessageUpdate =
  | "message"
  | "edited_message"
  | "channel_post"
  | "edited_channel_post"
  | "business_message"
  | "edited_business_message";

/**
 * An update of `kind` that holds `text` in `chat`. The sender is the person on the other end of a
 * private chat, and somebody else in a group, unless `from` says who (`null` for nobody). A
 * business update names the business connection it came through, a channel post has no sender, and
 * `extra` adds fields to the message.
 */
function updateOf(
  kind: MessageUpdate,
  chat: Chat,
  text: string,
  {
    from = chat.type === "private" ? chat.id : 42,
    extra = {},
  }: { from?: number | null; extra?: object } = {},
): Update {
  updateCounter += 1;
  const sender =
    from === null || kind.endsWith("channel_post")
      ? {}
      : { from: { id: from, is_bot: false, first_name: "Ada" } };
  const message = {
    message_id: updateCounter,
    date: 1_793_250_000,
    chat,
    ...sender,
    ...(kind.includes("business") ? { business_connection_id: "bc-1" } : {}),
    ...(kind.startsWith("edited") ? { edit_date: 1_793_250_100 } : {}),
    ...textOf(text),
    ...extra,
  };
  return { update_id: updateCounter, [kind]: message } as Update;
}

function messageIn(chat: Chat, text: string): Update {
  return updateOf("message", chat, text);
}

function channelPostIn(chat: Chat, text: string): Update {
  return updateOf("channel_post", chat, text);
}

/** The update Telegram sends when `chat` removes the bot. */
function kickedFrom(chat: Chat): Update {
  updateCounter += 1;
  return {
    update_id: updateCounter,
    my_chat_member: {
      chat,
      from: { id: 42, is_bot: false, first_name: "Ada" },
      date: 1_793_250_200,
      old_chat_member: { status: "member", user: BOT_INFO },
      new_chat_member: { status: "kicked", user: BOT_INFO, until_date: 0 },
    },
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
  const message =
    update.message ??
    update.edited_message ??
    update.channel_post ??
    update.business_message ??
    update.edited_business_message;
  if (message === undefined) throw new Error("this update holds no message");
  return message.chat.id;
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

/** Feeds `update` to the bot and fails if the bot sends anything at all because of it. */
async function expectIgnored(update: Update, via: Bot = bot): Promise<void> {
  const before = calls.length;
  await via.handleUpdate(update);
  expect(calls.slice(before), `what the bot sent for ${JSON.stringify(update)}`).toEqual([]);
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

  // A plain group, the other kind of group, gets its own single refusal.
  const plain = groupChat(-4_001, "group");
  expect(await deliver(messageIn(plain, "/help"))).toEqual([PRIVATE_ONLY]);
  expect(await deliver(messageIn(plain, "/help"))).toEqual([]);
  expect(await sentKeys(plain.id)).toEqual(["group_refused"]);

  // Nothing a group said did anything: no link, no watch.
  for (const chat of [group.id, plain.id]) {
    expect(await linkOf(chat)).toBeNull();
    expect(await tagsOf(chat)).toEqual([]);
  }
});

test("a_group_update_that_is_not_a_message_gets_no_refusal", async () => {
  // Only a new message can be answered. Edits, and the bot being removed from the group (where a
  // reply would only fail), are ignored and do not use up the group's one refusal.
  const group = groupChat(-1_001_000_000_005, "supergroup");

  await expectIgnored(updateOf("edited_message", group, "/help"));
  await expectIgnored(kickedFrom(group));

  expect(calls.filter((call) => call.payload.chat_id === group.id)).toEqual([]);
  expect(await sentKeys(group.id)).toEqual([]);
  // The first real message after them still gets the refusal.
  expect(await deliver(messageIn(group, "/help"))).toEqual([PRIVATE_ONLY]);
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

// Only a direct message acts. A private chat that turns up in any other kind of update, or in a
// message whose sender is not the person in that chat, is not a conversation with the bot, so
// nothing said there changes anything or gets an answer.

test("a_channel_post_is_ignored", async () => {
  const channel = groupChat(-1_001_000_000_002, "channel");

  for (const text of ["/help", "/start nonce-x", "/watch research", "/stop", "hello"]) {
    await expectIgnored(channelPostIn(channel, text));
  }

  // Not even a refusal: a channel is not a chat anyone can link.
  expect(await sentKeys(channel.id)).toEqual([]);
  expect(await linkOf(channel.id)).toBeNull();
  expect(await tagsOf(channel.id)).toEqual([]);
});

test("business_messages_change_nothing", async () => {
  // A business account that has connected the bot writes in its customers' private chats, and those
  // updates name the customer's chat. The customer never spoke to the bot, so no command in such an
  // update may act for that chat, whoever typed it.
  const business = 424_242;
  const customer = newChat();
  const stranger = newChat();
  await linkChat(db, customer, "customer.near");
  await watchTag(db, customer, "alpha");
  await seedLinkNonce(db, "nonce-business", "business-target.near");
  const inCustomerChat = privateChat(customer);
  const inStrangerChat = privateChat(stranger);

  for (const update of [
    updateOf("business_message", inCustomerChat, "/stop", { from: business }),
    updateOf("business_message", inCustomerChat, "/stop", { from: customer }),
    updateOf("business_message", inCustomerChat, "/mute", { from: business }),
    updateOf("business_message", inCustomerChat, "/watch beta", { from: customer }),
    updateOf("business_message", inStrangerChat, "/start nonce-business", { from: business }),
    updateOf("business_message", inStrangerChat, "/start nonce-business", { from: stranger }),
    updateOf("edited_business_message", inCustomerChat, "/stop", { from: business }),
    updateOf("edited_business_message", inStrangerChat, "/start nonce-business", {
      from: business,
    }),
  ]) {
    await expectIgnored(update);
  }

  expect(await linkOf(customer)).toEqual({ account: "customer.near", muted: false });
  expect(await tagsOf(customer)).toEqual(["alpha"]);
  expect(await linkOf(stranger)).toBeNull();
  expect(await nonceUsed("nonce-business")).toBe(false);
});

test("a_message_that_names_a_business_connection_is_ignored", async () => {
  // Telegram sends business messages as `business_message`, never as `message`. If one came as a
  // message anyway, the connection it names would still make it a chat the bot is not in.
  const chat = newChat();
  await linkChat(db, chat, "connected.near");
  await seedLinkNonce(db, "nonce-connected", "connected-target.near");
  const other = newChat();
  const named = { extra: { business_connection_id: "bc-1" } };

  await expectIgnored(updateOf("message", privateChat(chat), "/stop", named));
  await expectIgnored(updateOf("message", privateChat(other), "/start nonce-connected", named));

  expect(await linkOf(chat)).toEqual({ account: "connected.near", muted: false });
  expect(await linkOf(other)).toBeNull();
  expect(await nonceUsed("nonce-connected")).toBe(false);
});

test("an_edited_command_is_ignored", async () => {
  const chat = newChat();
  await linkChat(db, chat, "edit.near");
  await watchTag(db, chat, "alpha");

  for (const text of ["/stop", "/mute", "/unwatch alpha", "/help"]) {
    await expectIgnored(updateOf("edited_message", privateChat(chat), text));
  }

  expect(await linkOf(chat)).toEqual({ account: "edit.near", muted: false });
  expect(await tagsOf(chat)).toEqual(["alpha"]);
});

test("a_private_message_not_from_the_chat_is_ignored", async () => {
  // In a private chat the sender is the person on the other end of it, so their ids are the same.
  // A message in the chat from somebody else, or from nobody, did not come from the chat.
  const chat = newChat();
  const elsewhere = newChat();
  await linkChat(db, chat, "mismatch.near");
  await seedLinkNonce(db, "nonce-mismatch", "mismatch-target.near");

  for (const text of ["/stop", "/mute", "/watch alpha", "/status", "/help"]) {
    await expectIgnored(updateOf("message", privateChat(chat), text, { from: chat + 7 }));
    await expectIgnored(updateOf("message", privateChat(chat), text, { from: null }));
  }
  const start = "/start nonce-mismatch";
  await expectIgnored(updateOf("message", privateChat(elsewhere), start, { from: elsewhere + 7 }));
  await expectIgnored(updateOf("message", privateChat(elsewhere), start, { from: null }));

  expect(await linkOf(chat)).toEqual({ account: "mismatch.near", muted: false });
  expect(await tagsOf(chat)).toEqual([]);
  expect(await linkOf(elsewhere)).toBeNull();
  expect(await nonceUsed("nonce-mismatch")).toBe(false);
  // The same chat, with the sender it should have, is served.
  expect(await say(chat, "/mute")).toBe(MUTED);
});

test("only_a_direct_private_message_gets_past_the_gate", async () => {
  // grammY's `command` filter happens not to match business or edited updates, so the tests above
  // would pass with no gate at all, and would go on passing if the gate let those updates through.
  // This one watches the gate itself: a tripwire behind the gate and the commands hears every
  // update that was neither refused nor taken by a command. Only the one direct message may.
  const fresh = botOn(db);
  const reached: number[] = [];
  fresh.use((ctx) => {
    reached.push(ctx.update.update_id);
  });
  const chat = privateChat(newChat());
  const person = { id: chat.id, is_bot: false, first_name: "Ada" };
  const direct = messageIn(chat, "just saying hello");
  const group = groupChat(-1_001_000_000_006, "supergroup");
  const channel = groupChat(-1_001_000_000_007, "channel");

  const others: Update[] = [
    updateOf("message", chat, "hello", { from: chat.id + 7 }),
    updateOf("message", chat, "hello", { from: null }),
    updateOf("message", chat, "hello", { extra: { business_connection_id: "bc-1" } }),
    updateOf("edited_message", chat, "hello"),
    updateOf("business_message", chat, "hello", { from: 424_242 }),
    updateOf("edited_business_message", chat, "hello", { from: 424_242 }),
    updateOf("message", group, "hello"),
    updateOf("edited_message", group, "hello"),
    updateOf("channel_post", channel, "hello"),
    updateOf("edited_channel_post", channel, "hello"),
    kickedFrom(chat),
    kickedFrom(group),
    {
      update_id: ++updateCounter,
      callback_query: {
        id: "cb-1",
        from: person,
        chat_instance: "ci-1",
        data: "stop",
        message: messageIn(chat, "hello").message,
      },
    } as Update,
    {
      update_id: ++updateCounter,
      business_connection: {
        id: "bc-1",
        user: { id: 424_242, is_bot: false, first_name: "Biz" },
        user_chat_id: 424_242,
        date: 1_793_250_000,
        is_enabled: true,
      },
    } as Update,
  ];

  for (const update of [direct, ...others]) await fresh.handleUpdate(update);

  expect(reached).toEqual([direct.update_id]);
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

test("a_chat_watches_at_most_twenty_tags", async () => {
  const chat = newChat();
  const bystander = newChat();
  const tags = Array.from(
    { length: WATCH_LIMIT },
    (_, i) => `limit-${String(i + 1).padStart(2, "0")}`,
  );
  await watchTag(db, bystander, "limit-01");

  for (const tag of tags) expect(await say(chat, `/watch ${tag}`), tag).toBe(watching(tag));
  expect(await tagsOf(chat)).toEqual(tags);

  // The 21st is refused, with the number and the way out, and the chat's tags stay as they were.
  expect(await say(chat, "/watch limit-21")).toBe(watchFull("limit-21"));
  expect(await say(chat, "/watch limit-21")).toBe(watchFull("limit-21"));
  expect(await tagsOf(chat)).toEqual(tags);

  // A tag the chat already watches is not a new one, so a full chat can still say it.
  expect(await say(chat, "/watch limit-07")).toBe(watching("limit-07"));
  expect(await tagsOf(chat)).toEqual(tags);

  // Something that is not a tag hears the tag rule, full or not.
  expect(await say(chat, "/watch Limit-22")).toBe(WATCH_USAGE);

  // The cap is the chat's own: another chat, with a tag of the same name, is nowhere near it.
  expect(await say(bystander, "/watch limit-21")).toBe(watching("limit-21"));
  expect(await tagsOf(bystander)).toEqual(["limit-01", "limit-21"]);

  // Room made with /unwatch is room, and once it is used the chat is full again.
  expect(await say(chat, "/unwatch limit-01")).toBe("Stopped watching <b>limit-01</b>.");
  expect(await say(chat, "/watch limit-21")).toBe(watching("limit-21"));
  expect(await say(chat, "/watch limit-22")).toBe(watchFull("limit-22"));
  expect(await tagsOf(chat)).toEqual([...tags.slice(1), "limit-21"]);

  // /stop clears the watches, and with them the cap.
  await say(chat, "/stop");
  expect(await say(chat, "/watch limit-22")).toBe(watching("limit-22"));
});

test("watches_sent_at_once_cannot_pass_the_cap", async () => {
  // One tag short of full, then five new tags at once: one fits, the other four do not.
  const chat = newChat();
  for (let i = 1; i < WATCH_LIMIT; i++) await watchTag(db, chat, `burst-${i}`);
  const before = calls.length;

  await Promise.all(
    ["a", "b", "c", "d", "e"].map((name) =>
      bot.handleUpdate(messageIn(privateChat(chat), `/watch burst-new-${name}`)),
    ),
  );

  const replies = calls
    .slice(before)
    .filter((call) => call.payload.chat_id === chat)
    .map((call) => String(call.payload.text));
  expect(replies).toHaveLength(5);
  expect(replies.filter((text) => text.startsWith("Watching "))).toHaveLength(1);
  expect(replies.filter((text) => text.startsWith("Not watching "))).toHaveLength(4);
  expect(await tagsOf(chat)).toHaveLength(WATCH_LIMIT);
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

/** What /status says to a chat linked to `account`, alerts on and no tags watched, with `tasks`. */
function statusOf(account: string, tasks: string[]): string {
  return [
    `Account: <b>${account}</b>`,
    "Alerts: on",
    "Watching: no tags",
    "",
    "<b>Latest tasks</b>",
    ...tasks,
  ].join("\n");
}

test("status_puts_task_numbers_in_numeric_order", async () => {
  // The latest three of 9, 10, 11, 100 and 101 are the three largest numbers. As text, "9" sorts
  // after "101", and the query would hand back 9, 101, 100.
  const chat = newChat();
  const account = "digits.near";
  await linkChat(db, chat, account);
  for (const id of ["9", "10", "11", "100", "101"]) {
    await seedTaskIn("open", id, account, `Task ${id}`);
  }

  expect(await say(chat, "/status")).toBe(
    statusOf(account, [
      taskLine("101", "Task 101", "open"),
      taskLine("100", "Task 100", "open"),
      taskLine("11", "Task 11", "open"),
    ]),
  );
});

test("status_lists_the_tasks_an_account_entered", async () => {
  // A plain entrant, which posted nothing: its latest tasks are the ones it entered, whoever posted them.
  const account = "entrant.near";
  const chat = newChat();
  await linkChat(db, chat, account);
  await seedTaskIn("expired", "401", "poster-a.near", "Fourth, so left out");
  await seedTaskIn("fallback", "402", "poster-a.near", "Third");
  await seedTaskIn("open", "403", "poster-b.near", "Entered by someone else");
  await seedTaskIn("settled", "404", "poster-b.near", null);
  await seedTaskIn("revealing", "405", "poster-a.near", "Entered by several");
  await seedTaskIn("open", "406", "poster-c.near", "Nobody entered");
  for (const id of ["401", "402", "404", "405"]) await seedEntry(db, id, account);
  await seedEntry(db, "403", "someone-else.near");
  await seedEntry(db, "405", "someone-else.near");

  expect(await say(chat, "/status")).toBe(
    statusOf(account, [
      taskLine("405", "Entered by several", "revealing"),
      taskLine("404", "Task #404", "settled"),
      taskLine("402", "Third", "fallback"),
    ]),
  );
});

test("status_lists_the_tasks_the_agents_of_an_asp_entered", async () => {
  // acme.near is an ASP: bot-one and bot-two are its agents, and bot.rival.near is another's.
  // loose.acme.near has the name but no agents row, so it is nobody's agent.
  const asp = "acme.near";
  await seedAgent(db, "bot-one.acme.near", { asp });
  await seedAgent(db, "bot-two.acme.near", { asp });
  await seedAgent(db, "bot.rival.near", { asp: "rival.near" });
  await seedTaskIn("open", "509", "poster-x.near", "Entered by a rival's agent");
  await seedTaskIn("open", "508", "poster-x.near", "Entered by a stranger");
  await seedTaskIn("judging", "507", "poster-x.near", "Entered by both agents");
  await seedTaskIn("open", "506", "poster-y.near", "Entered by the ASP itself");
  await seedTaskIn("settled", "505", asp, "Posted by the ASP");
  await seedTaskIn("fallback", "504", "poster-x.near", "Entered by bot-two, fourth");
  await seedTaskIn("revealing", "503", "poster-x.near", "Entered by bot-one");
  await seedEntry(db, "509", "bot.rival.near");
  await seedEntry(db, "508", "loose.acme.near");
  await seedEntry(db, "507", "bot-one.acme.near");
  await seedEntry(db, "507", "bot-two.acme.near");
  await seedEntry(db, "506", asp);
  await seedEntry(db, "504", "bot-two.acme.near");
  await seedEntry(db, "503", "bot-one.acme.near");

  // The ASP's chat sees the three rules at once: what its agents entered (507, once although both
  // agents did), what it entered (506) and what it posted (505). The fourth is cut off, and the
  // rival's agent and the stranger are not its business even though they are newer.
  const owner = newChat();
  await linkChat(db, owner, asp);
  expect(await say(owner, "/status")).toBe(
    statusOf(asp, [
      taskLine("507", "Entered by both agents", "judging"),
      taskLine("506", "Entered by the ASP itself", "open"),
      taskLine("505", "Posted by the ASP", "settled"),
    ]),
  );

  // It runs one way. An agent's chat sees what that agent entered, and nothing of its sibling's
  // (504) or its ASP's (506, 505).
  const agent = newChat();
  await linkChat(db, agent, "bot-one.acme.near");
  expect(await say(agent, "/status")).toBe(
    statusOf("bot-one.acme.near", [
      taskLine("507", "Entered by both agents", "judging"),
      taskLine("503", "Entered by bot-one", "revealing"),
    ]),
  );
});

test("a_full_status_fits_in_one_telegram_message", async () => {
  // The most /status can say: a 64-character account, the 20 tags a chat can watch at 24 characters
  // each, and three tasks with 20-digit numbers and 120-character titles of nothing but quotes,
  // which escape to six characters apiece. Telegram takes 4096 characters, counted after the HTML is
  // parsed, so the length of the HTML itself is a limit it cannot pass.
  const account = "a".repeat(64);
  const chat = newChat();
  await linkChat(db, chat, account, { muted: true });
  for (let i = 0; i < WATCH_LIMIT; i++) {
    await watchTag(db, chat, `${"t".repeat(22)}${String(i).padStart(2, "0")}`);
  }
  for (const id of ["18446744073709551613", "18446744073709551614", "18446744073709551615"]) {
    await seedTaskIn("revealing", id, account, '"'.repeat(120));
  }

  const reply = await say(chat, "/status");

  expect(reply.match(/<a /g)).toHaveLength(3);
  expect(reply.length).toBeLessThan(4096);
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
      "No tasks yet.",
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
