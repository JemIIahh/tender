import { type Bot, webhookCallback } from "grammy";

/**
 * What Telegram takes as a webhook's secret token (`setWebhook`'s `secret_token`): 1 to 256
 * letters, digits, underscores and hyphens.
 */
export const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * The route handler, for a Hono app, that takes the updates Telegram posts to the bot's webhook:
 * grammY's `webhookCallback(bot, "hono", { secretToken, onTimeout: "return" })`, with grammY's
 * defaults for the rest.
 * Setting the webhook with Telegram (`setWebhook`, with this secret) is not done here.
 *
 * Telegram sends the secret with every update, in the `X-Telegram-Bot-Api-Secret-Token` header. A
 * request with another value there, or none, is answered 401 with an empty body, and its body is
 * not read. Any other request is an update, which the bot handles before the answer, a 200 with
 * an empty body: the bot's replies go through the Bot API, not in the answer. An update that
 * takes longer than 10 seconds is answered 200 all the same, and the bot goes on with it in the
 * background. The other choice, to answer with an error, makes Telegram send the update again, and
 * an update that waits on a flood wait (up to a minute, see `createBot`) would then be handled
 * twice and reply twice. The cost is that a process that stops does not wait for such an update
 * past its answer. The first request fetches the bot's own details (`getMe`), unless the bot has
 * them already, before it looks at the secret.
 *
 * The bot must not poll as well: making the handler throws if `bot.start` is running, and makes
 * `bot.start` throw from then on. A secret Telegram would not take is refused here, by throwing:
 * an empty one would admit every request that sends the header empty.
 */
export function webhookHandler(bot: Bot, secretToken: string) {
  if (!WEBHOOK_SECRET.test(secretToken)) {
    throw new Error("the webhook secret must be 1 to 256 letters, digits, _ or -");
  }
  return webhookCallback(bot, "hono", { secretToken, onTimeout: "return" });
}
