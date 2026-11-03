import type { Db } from "@tender/db";
import type { Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { expect, test, vi } from "vitest";
import { createBot, WEBHOOK_SECRET, webhookHandler } from "../src/index";

// The webhook's handler, called the way Hono calls it, with a context that holds only what grammY's
// adapter for Hono reads. The bot's Telegram is a transformer that records each call, so nothing
// reaches the network, and `/help` touches no database.

const SECRET = "webhook_secret-for-tests";

const BOT_INFO: UserFromGetMe = {
  id: 7_000_000_002,
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

/** A database that `/help` never reaches. */
const NO_DB = new Proxy({} as Db, {
  get() {
    throw new Error("the database is not used here");
  },
});

/** A bot whose calls to Telegram land in `calls`. */
function recordingBot() {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const bot = createBot({
    token: "123:test",
    db: NO_DB,
    webUrl: "https://tender.example",
    botInfo: BOT_INFO,
  });
  const record: Transformer = (_prev, method, payload) => {
    calls.push({ method, payload: payload as unknown as Record<string, unknown> });
    const result = { message_id: calls.length, date: 0, chat: { id: 0, type: "private" } };
    return Promise.resolve({ ok: true, result } as never);
  };
  bot.api.config.use(record);
  return { bot, calls };
}

/** `/help` in a private chat, as Telegram posts it. */
const HELP_UPDATE: Update = {
  update_id: 1,
  message: {
    message_id: 1,
    date: 1_793_250_000,
    chat: { id: 4242, type: "private", first_name: "Ada" },
    from: { id: 4242, is_bot: false, first_name: "Ada" },
    text: "/help",
    entities: [{ type: "bot_command", offset: 0, length: 5 }],
  },
};

/** A request as the adapter sees it: its secret header, and a body that says when it was read. */
function request(update: Update, secret: string | undefined) {
  let status = 200;
  let bodyRead = false;
  const c = {
    req: {
      json: async <T>() => {
        bodyRead = true;
        return update as T;
      },
      header: (name: string) =>
        name.toLowerCase() === "x-telegram-bot-api-secret-token" ? secret : undefined,
    },
    status: (code: number) => {
      status = code;
    },
    body: (data: string | null) => new Response(data, { status }),
    json: (json: string) =>
      new Response(json, { status, headers: { "content-type": "application/json" } }),
  };
  return { c, bodyRead: () => bodyRead };
}

test("the_webhook_takes_an_update_only_with_the_secret", async () => {
  const { bot, calls } = recordingBot();
  const handle = webhookHandler(bot, SECRET);

  // No secret, and a wrong one, of the same length or not: 401 with an empty body, and the update
  // is not even read.
  for (const secret of [undefined, "", "wrong", `${SECRET.slice(0, -1)}X`, `${SECRET}X`]) {
    const { c, bodyRead } = request(HELP_UPDATE, secret);
    const res = await handle(c as never);
    expect(res.status, String(secret)).toBe(401);
    expect(await res.text(), String(secret)).toBe("");
    expect(bodyRead(), String(secret)).toBe(false);
  }
  expect(calls).toEqual([]);

  // With the secret, the bot handles the update before the answer, a 200 with an empty body, and
  // its reply goes through the Bot API.
  const { c } = request(HELP_UPDATE, SECRET);
  const res = await handle(c as never);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("");
  expect(calls.map(({ method, payload }) => [method, payload.chat_id])).toEqual([
    ["sendMessage", 4242],
  ]);
});

test("the_webhook_takes_only_a_secret_telegram_would_take", () => {
  const { bot } = recordingBot();
  for (const secret of ["", "a secret", "x".repeat(257), "sécret"]) {
    expect(() => webhookHandler(bot, secret), JSON.stringify(secret)).toThrow(
      "the webhook secret must be 1 to 256 letters, digits, _ or -",
    );
  }
  expect(WEBHOOK_SECRET.test("A-z_0-9")).toBe(true);
  expect(WEBHOOK_SECRET.test("x".repeat(256))).toBe(true);
});

test("a_slow_update_is_answered_at_the_limit_and_finished_in_the_background", async () => {
  // grammY gives an update 10 seconds. Past that the handler used to throw, so that Telegram sent the
  // update again, and one that was waiting on a flood wait was then handled twice and replied twice.
  // Now it answers 200 at the limit and the bot goes on with the update.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { bot, calls } = recordingBot();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The reply to Telegram is stuck, as when the API makes the bot wait out a flood wait.
    bot.api.config.use(async (prev, method, payload) => {
      await held;
      return prev(method, payload);
    });
    const handle = webhookHandler(bot, SECRET);
    const { c } = request(HELP_UPDATE, SECRET);

    const answered = handle(c as never);
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await answered;

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(calls).toEqual([]);

    // The update was not dropped: its reply goes out once the wait is over.
    release();
    await vi.waitFor(() => expect(calls.map(({ method }) => method)).toEqual(["sendMessage"]));
  } finally {
    vi.useRealTimers();
  }
});
