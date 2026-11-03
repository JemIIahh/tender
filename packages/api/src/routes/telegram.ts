import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { AuthVariables, RequireAuth } from "../auth";
import type { ApiDeps } from "../deps";
import { fail } from "../format";
import { rateLimit, rateLimitsOf } from "../limits";

/** `POST /v1/telegram/link`. `expires_at` is ISO 8601 in UTC to the millisecond. */
export interface TelegramLinkResponse {
  /** Opens the bot in Telegram with the nonce as its `/start` argument. */
  url: string;
  expires_at: string;
}

/**
 * The nonce is 16 random bytes, 128 bits, in base64url: 22 characters, all from the characters
 * Telegram allows in the argument of a deep link (`A-Za-z0-9_-`).
 */
const NONCE_BYTES = 16;

/** A link is for one person, and the nonce in it is a secret until it is spent. */
const NOT_CACHED = { "Cache-Control": "no-store" };

/**
 * `POST /v1/telegram/link` (signed in): a one-time link that connects a Telegram chat to the
 * account. The person opens it, Telegram starts the bot with the nonce, and the bot spends the
 * nonce (`linkWithNonce` in `@tender/telegram`) and links the chat to the account it was made for.
 * Without `deps.telegramBotUsername` there is no bot to link to: the answer is a 503, and nothing
 * is written. It carries no `Retry-After`: that is a setting, and asking again changes nothing.
 *
 * A link is good for 10 minutes. The time is the database's own, not `deps.now`: the bot spends a
 * nonce only while `expires_at > now()`, so the one clock that writes the expiry is the one that
 * reads it, and the `expires_at` that is answered is the stored one. The same transaction deletes
 * the nonces that expired more than an hour ago, so the table does not grow with the calls.
 *
 * An account gets 10 links in 10 minutes unless `deps.rateLimits` says otherwise; past that the
 * answer is a 429 (`rate_limited`) with `Retry-After`, and no nonce is made.
 */
export function telegramRoutes(
  deps: ApiDeps,
  requireAuth: RequireAuth,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  // After sign-in, which is what says whose request it is.
  const perAccount = rateLimit<{ Variables: AuthVariables }>(
    rateLimitsOf(deps.rateLimits).telegramLink,
    (c) => c.var.account,
  );

  app.post("/telegram/link", requireAuth, perAccount, async (c) => {
    const bot = deps.telegramBotUsername;
    if (!bot) return fail(503, "unavailable", "Telegram linking is not set up");

    const nonce = randomBytes(NONCE_BYTES).toString("base64url");
    const expiresAt = await deps.db.tx(async (tx) => {
      await tx.query("delete from tg_link_nonces where expires_at < now() - interval '1 hour'");
      const [row] = await tx.query<{ expires_at: Date }>(
        `insert into tg_link_nonces (nonce, account, expires_at)
         values ($1, $2, now() + interval '10 minutes')
         returning expires_at`,
        [nonce, c.var.account],
      );
      if (!row) throw new Error("the nonce was not stored");
      return row.expires_at;
    });

    const body: TelegramLinkResponse = {
      url: `https://t.me/${bot}?start=${nonce}`,
      expires_at: expiresAt.toISOString(),
    };
    return c.json(body, 200, NOT_CACHED);
  });

  return app;
}
