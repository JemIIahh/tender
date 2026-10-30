import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { Db } from "@tender/db";
import { phaseAt } from "@tender/shared";
import { Bot, type CommandContext, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { escapeHtml } from "./render";

/** What `createBot` needs. */
export interface BotDeps {
  /** The bot's token, from @BotFather. */
  token: string;
  db: Db;
  /** Where the web app is served, such as `https://tender.example`. A trailing slash is fine. */
  webUrl: string;
  /**
   * What `getMe` says about the bot. With it, grammY does not call `getMe` when the bot starts, and
   * a test can build a bot that never reaches the network.
   */
  botInfo?: UserFromGetMe;
  /**
   * The time `/status` works task phases out at: nanoseconds since the Unix epoch, as the
   * contract counts them. Defaults to the wall clock.
   */
  now?: () => bigint;
}

/** One tag, as the contract's `check_tags` and a brief's schema allow it. */
const TAG = /^[a-z0-9-]{1,24}$/;

/** The `tg_sent` key that records the one refusal a chat other than a private chat gets. */
const GROUP_REFUSED = "group_refused";

/** How many of an account's tasks `/status` lists. */
const STATUS_TASKS = 3;

const NS_PER_MS = 1_000_000n;

/**
 * The bot behind the Telegram alerts: it links a chat to a NEAR account and lets the chat watch
 * tags, mute itself and look at its state. It sends nothing on its own; the notifier does that.
 *
 * It acts on direct messages only: plain `message` updates from a private chat, sent by the person
 * on the other end of it. Every other update is dropped without an answer, business updates among
 * them (their private chat belongs to a business's customer, who never talked to the bot), and so
 * are edits, channel posts and callback queries. The first message from a group or supergroup gets
 * one refusal, which `tg_sent` remembers across restarts, and everything after it is ignored, so
 * that no group can ever be linked to an account and told about its tasks.
 *
 * Every reply is Telegram HTML with link previews off, and everything a person or an account chose
 * goes through `escapeHtml`. A failure in a handler is logged and dropped, because an error that
 * escaped would stop long polling, or make Telegram send a webhook update again and again. So
 * `handleUpdate` does not reject for a failed handler; callers that need to know read the log.
 */
export function createBot(deps: BotDeps): Bot {
  const { db } = deps;
  const now = deps.now ?? (() => BigInt(Date.now()) * NS_PER_MS);
  const webUrl = deps.webUrl.replace(/\/+$/, "");
  const linkPage = escapeHtml(`${webUrl}/telegram`);

  const bot = new Bot(deps.token, { botInfo: deps.botInfo });
  // The throttler is installed last, so it is outermost and spaces messages out before they go
  // anywhere; autoRetry inside it waits out a flood wait without giving up the call's place.
  bot.api.config.use(autoRetry());
  bot.api.config.use(apiThrottler());

  // The error boundary: a failure anywhere below is logged and dropped. `bot.catch` would not do,
  // since it covers long polling only: `handleUpdate` always throws, and a webhook that answers
  // Telegram with an error gets the same update sent again. The log names the update, not what it
  // said, because a message can hold a stranger's words and, for /start, a nonce.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      console.error(`telegram bot: update ${ctx.update.update_id} failed:`, error);
    }
  });

  // The gate, before every command. Only a plain `message` update gets past it, and only from a
  // private chat that the sender is the other end of. Everything else is dropped without an answer:
  // - A business update (`business_message`, `edited_business_message`, `business_connection`)
  //   names a private chat that belongs to a business's customer. The customer never spoke to the
  //   bot, so no command there may act for that chat, whoever typed it. grammY's `command` filter
  //   happens not to match those updates; the gate does not leave that to a library default.
  // - In a private chat the sender and the chat are the same id, so a message from anyone else, or
  //   from nobody, did not come from the chat.
  // - Edits, channel posts and callback queries are not commands this bot answers.
  // Middleware added to the returned bot after this one therefore sees direct messages only.
  bot.use(async (ctx, next) => {
    const message = ctx.message;
    if (message === undefined || ctx.businessConnectionId !== undefined) return;
    const { chat } = message;
    if (chat.type !== "private") {
      // A group or supergroup. Record first, then send: at most one refusal per chat, even if two
      // messages arrive at once. Nothing else a group says ever reaches a command.
      const first = await db.query(
        "insert into tg_sent (chat_id, dedupe_key) values ($1, $2) on conflict do nothing returning chat_id",
        [chat.id, GROUP_REFUSED],
      );
      if (first.length > 0) await answer(ctx, "Tender alerts work in private chats only.");
      return;
    }
    if (message.from?.id !== chat.id) return;
    return next();
  });

  bot.command("start", async (ctx) => {
    const nonce = ctx.match.trim();
    const account = nonce === "" ? null : await linkWithNonce(db, ctx.chat.id, nonce);
    if (account === null) {
      await answer(ctx, `Open ${linkPage} and tap “Link Telegram” to get a fresh link.`);
      return;
    }
    await answer(
      ctx,
      `Linked to <b>${escapeHtml(account)}</b>. You will get alerts for it and its agents. /help`,
    );
  });

  bot.command("status", async (ctx) => {
    const chatId = ctx.chat.id;
    const links = await db.query<{ account: string; muted: boolean }>(
      "select account, muted from tg_links where chat_id = $1",
      [chatId],
    );
    const tags = await db.query<{ tag: string }>(
      "select tag from tg_watches where chat_id = $1 order by tag",
      [chatId],
    );
    const watching = `Watching: ${tags.length === 0 ? "no tags" : tags.map((row) => escapeHtml(row.tag)).join(", ")}`;

    const link = links[0];
    if (link === undefined) {
      await answer(
        ctx,
        [
          "Not linked to an account.",
          watching,
          `Open ${linkPage} and tap “Link Telegram” to link one.`,
        ].join("\n"),
      );
      return;
    }
    const tasks = await latestTasks(db, link.account);
    const nowNs = now();
    await answer(
      ctx,
      [
        `Account: <b>${escapeHtml(link.account)}</b>`,
        link.muted ? "Alerts: muted (/unmute to resume)" : "Alerts: on",
        watching,
        "",
        ...(tasks.length === 0
          ? ["No tasks posted yet."]
          : ["<b>Latest tasks</b>", ...tasks.map((task) => taskLine(task, webUrl, nowNs))]),
      ].join("\n"),
    );
  });

  // /watch and /unwatch need no link: a chat that only watches tags hears them, and /unwatch is the
  // way such a chat stops, since /mute needs a linked account to mute.
  bot.command("watch", async (ctx) => {
    const tag = ctx.match.trim();
    if (!TAG.test(tag)) {
      await answer(ctx, tagRule("watch"));
      return;
    }
    await db.query("insert into tg_watches (chat_id, tag) values ($1, $2) on conflict do nothing", [
      ctx.chat.id,
      tag,
    ]);
    const shown = escapeHtml(tag);
    await answer(
      ctx,
      `Watching <b>${shown}</b>. New tasks with this tag are sent to this chat. /unwatch ${shown} to stop.`,
    );
  });

  bot.command("unwatch", async (ctx) => {
    const tag = ctx.match.trim();
    if (!TAG.test(tag)) {
      await answer(ctx, tagRule("unwatch"));
      return;
    }
    const removed = await db.query(
      "delete from tg_watches where chat_id = $1 and tag = $2 returning tag",
      [ctx.chat.id, tag],
    );
    const shown = escapeHtml(tag);
    await answer(
      ctx,
      removed.length > 0
        ? `Stopped watching <b>${shown}</b>.`
        : `You are not watching <b>${shown}</b>.`,
    );
  });

  // The mute lives on the link, so a chat with no link has nothing to mute. Tag watches are not
  // touched either way.
  const muting = (muted: boolean) => async (ctx: CommandContext<Context>) => {
    const changed = await db.query(
      "update tg_links set muted = $2 where chat_id = $1 returning chat_id",
      [ctx.chat.id, muted],
    );
    if (changed.length === 0) {
      await answer(
        ctx,
        `This chat is not linked to an account, so there is nothing to ${muted ? "mute" : "unmute"}. Open ${linkPage} and tap “Link Telegram” to link one. To stop tag alerts, send /unwatch with the tag.`,
      );
      return;
    }
    await answer(
      ctx,
      muted ? "Muted. No alerts until you send /unmute." : "Unmuted. You will get alerts again.",
    );
  };
  bot.command("mute", muting(true));
  bot.command("unmute", muting(false));

  bot.command("stop", async (ctx) => {
    const removed = await db.tx(async (tx) => {
      const links = await tx.query("delete from tg_links where chat_id = $1 returning chat_id", [
        ctx.chat.id,
      ]);
      const watches = await tx.query("delete from tg_watches where chat_id = $1 returning tag", [
        ctx.chat.id,
      ]);
      return links.length + watches.length;
    });
    await answer(
      ctx,
      removed === 0
        ? "Nothing to stop: this chat is not linked and watches no tags."
        : `Stopped. This chat is unlinked and watches no tags, so it gets no more alerts. To link again, open ${linkPage} and tap “Link Telegram”.`,
    );
  });

  bot.command("help", async (ctx) => {
    await answer(
      ctx,
      [
        "<b>Tender alerts</b>",
        "/status · your account, mute state, watched tags and latest tasks",
        "/watch tag · hear about new tasks with a tag, like /watch research",
        "/unwatch tag · stop hearing about a tag",
        "/mute · pause alerts, /unmute to resume",
        "/stop · unlink this chat and clear its watches",
        "",
        `To link an account, open ${linkPage} and tap “Link Telegram”.`,
      ].join("\n"),
    );
  });

  return bot;
}

/** Replies to the message in `ctx` with `html`, which must already be escaped. */
function answer(ctx: Context, html: string) {
  return ctx.reply(html, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
}

/** What the bot says to a tag that does not fit `TAG`, or to no tag at all. */
function tagRule(command: "watch" | "unwatch"): string {
  return `A tag is 1 to 24 lowercase letters, digits or hyphens, such as research. Send /${command} research.`;
}

/**
 * Spends `nonce` to link `chatId` to the account it was minted for, and returns that account. It
 * returns null, and changes nothing, if the nonce does not exist, is used up or has expired.
 *
 * Spending and linking are one transaction. The spend is a single `update … where not used`, which
 * Postgres lets only one writer win, so a nonce sent twice at once links once. If the link then
 * fails, the spend rolls back with it and the person can tap the same link again. Expiry is
 * judged by the database clock, the one that stamped the nonce.
 *
 * A chat that links again replaces its old link, and linking lifts a mute, because the reply says
 * the chat will get alerts. The chat's tag watches are its own and stay.
 */
async function linkWithNonce(db: Db, chatId: number, nonce: string): Promise<string | null> {
  return db.tx(async (tx) => {
    const spent = await tx.query<{ account: string }>(
      "update tg_link_nonces set used = true where nonce = $1 and not used and expires_at > now() returning account",
      [nonce],
    );
    const account = spent[0]?.account;
    if (account === undefined) return null;
    await tx.query(
      `insert into tg_links (chat_id, account) values ($1, $2)
       on conflict (chat_id) do update set account = excluded.account, muted = false, linked_at = now()`,
      [chatId, account],
    );
    return account;
  });
}

interface TaskRow {
  id: string;
  title: string | null;
  commit_deadline: string;
  reveal_deadline: string;
  pick_deadline: string;
  fallback_deadline: string;
  settled: boolean;
}

/**
 * The `STATUS_TASKS` latest tasks that `account` posted, newest first. Ids count up in the order
 * tasks are created, so the highest ids are the latest. A task is settled once it has an outcome.
 */
async function latestTasks(db: Db, account: string): Promise<TaskRow[]> {
  return db.query<TaskRow>(
    `select id::text as id, title,
            commit_deadline::text as commit_deadline,
            reveal_deadline::text as reveal_deadline,
            pick_deadline::text as pick_deadline,
            fallback_deadline::text as fallback_deadline,
            outcome is not null as settled
     from tasks
     where poster = $1
     order by id desc
     limit $2`,
    [account, STATUS_TASKS],
  );
}

/**
 * One task as a line of `/status`: its title, linked to the web app, and its phase at `nowNs`.
 * A title is one line whatever the poster typed (it may hold line breaks), and a task without one
 * is called `Task #<id>`, as the alerts call it.
 */
function taskLine(task: TaskRow, webUrl: string, nowNs: bigint): string {
  const title = (task.title ?? "").replace(/\s+/g, " ").trim() || `Task #${task.id}`;
  const href = escapeHtml(`${webUrl}/tasks/${task.id}`);
  return `<a href="${href}">${escapeHtml(title)}</a> · ${phaseAt(task, nowNs)}`;
}
