import { AuthError } from "@tender/client";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { createChallenge, refusal, signIn } from "../auth";
import type { ApiDeps } from "../deps";
import { badRequest, type ErrorBody, issuesOf, readJson } from "../format";

/**
 * The most a sign-in may weigh. A real one is about 400 bytes; this is not an upload route, and
 * nobody has signed in yet, so a larger body is refused before it is read.
 */
const MAX_BODY_BYTES = 4096;

/** A token is a secret, and a challenge is for one caller: no cache keeps either. */
const NOT_CACHED = { "Cache-Control": "no-store" };

/**
 * `POST /v1/auth/verify`. The fields are only required to be strings: what is wrong with a key, a
 * signature or a nonce is `verifyNep413`'s to say, and it says it with a code to branch on.
 */
const VerifySchema = z.strictObject({
  account_id: z.string(),
  public_key: z.string(),
  signature: z.string(),
  nonce: z.string(),
  message: z.string(),
  recipient: z.string(),
});

/**
 * NEP-413 sign-in, which needs no account to ask for.
 *
 * - `POST /v1/auth/challenge`: a single-use nonce to sign, good for 5 minutes.
 * - `POST /v1/auth/verify`: the signed challenge, for a bearer token that lasts 12 hours. A
 *   sign-in that is refused gets a 401 with a code (`bad_nonce`, `wrong_recipient`,
 *   `bad_signature`, `key_not_found` or `key_not_allowed`) and a fixed text.
 *
 * The routes that need an account are behind `requireAuth`, which the caller mounts them with.
 */
export function authRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.post("/auth/challenge", async (c) => c.json(await createChallenge(deps), 200, NOT_CACHED));

  app.post(
    "/auth/verify",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => {
        const body: ErrorBody = {
          error: "payload_too_large",
          message: "the request body is too large",
        };
        return c.json(body, 413);
      },
    }),
    async (c) => {
      const parsed = VerifySchema.safeParse(await readJson(c));
      if (!parsed.success) {
        return badRequest("the request body does not fit its schema", issuesOf(parsed.error));
      }
      try {
        return c.json(await signIn(deps, parsed.data), 200, NOT_CACHED);
      } catch (error) {
        // Only a refusal is the caller's. Whatever else went wrong goes to `app.onError`.
        if (error instanceof AuthError) return refusal(c, error.code);
        throw error;
      }
    },
  );

  return app;
}
