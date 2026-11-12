import { ApiError, ErrorBodySchema, type GasGiftResponse } from "@tender/shared";

// Getting a new email-login account ready. An email or Google login (Privy) makes the person an
// implicit NEAR account, which holds no NEAR and is not on the chain until someone sends it some,
// and so can pay no fee. Right after the login the page reads its balance from the node; below
// `GAS_GIFT_BELOW` it asks Tender's API for a little testnet NEAR (`POST /v1/gas-gift`, with the
// login's access token), and reads the node again until the NEAR has arrived. Anything in the way
// is told in one plain line, with Try again where trying again can help, and always the testnet
// faucet, with the account to copy, as another way.

/** Under this much NEAR, in yoctoNEAR, an account is given NEAR for its fees: 0.05 NEAR. */
export const GAS_GIFT_BELOW = 50_000_000_000_000_000_000_000n;

/** The public testnet faucet, the way on when Tender sends nothing. */
export const TESTNET_FAUCET_URL = "https://near-faucet.io/";

/** How long the page reads the node for a gift that was sent, and how often. */
export const GIFT_WAIT_MS = 60_000;
export const GIFT_POLL_MS = 2_000;

/**
 * Why an account is not ready. From the route's error code (the `error` of its body, not the
 * status alone, since 429 and 503 each carry two meanings):
 *
 * - `gift_off` (503): the gift is switched off. `daily_limit` (429): the day's cap is spent.
 *   `already_given` (409): this login or account had its gift. Tender won't send: the faucet.
 * - `rate_limited` (429): too many tries from this address. `unavailable` (503, with
 *   Retry-After): the route can't send for a moment (the login check, a gift for this login on
 *   its way, or the chain can't say what the account holds). Try again later, or shortly.
 * - `transfer_failed` (502): the send didn't go through, or timed out and may still arrive.
 * - `timeout`: a gift was sent and hasn't reached this page's node in `GIFT_WAIT_MS`.
 * - `failed`: anything else: `bad_request` and `payload_too_large` (a fault of ours), a refused
 *   token, no answer, a node that can't be read, a login with no token.
 */
export type GiftProblem =
  | "gift_off"
  | "daily_limit"
  | "already_given"
  | "rate_limited"
  | "unavailable"
  | "transfer_failed"
  | "timeout"
  | "failed";

/**
 * Not ready: the problem, and the balance the account had when the gift was asked for (null when
 * it could not be read), so that a Try again knows whether NEAR arrived since.
 */
export type Readiness =
  | { status: "ready" }
  | { status: "stuck"; problem: GiftProblem; before: bigint | null };

/** The codes of the route that are a problem of their own; any other is `failed`. */
const CODED: readonly GiftProblem[] = [
  "gift_off",
  "daily_limit",
  "already_given",
  "rate_limited",
  "unavailable",
  "transfer_failed",
];

/** The one line for each problem. */
export const GIFT_PROBLEM_WORDS: Record<GiftProblem, string> = {
  gift_off: "Tender isn't sending NEAR for fees right now.",
  daily_limit: "Tender has sent all the NEAR for fees it sends today.",
  already_given: "Tender has already sent this account NEAR for fees once.",
  rate_limited: "Too many tries from here. Try again in a few minutes.",
  unavailable: "Tender can't send NEAR for fees right now. Try again in a moment.",
  transfer_failed: "Couldn't send yet. Try again in a moment.",
  timeout: "The NEAR for fees hasn't arrived yet.",
  failed: "Tender couldn't send NEAR for fees just now.",
};

/**
 * Whether Try again can help with each problem. Where it can, it is the chooser's first way and the
 * faucet (with the account to copy) the second; where it can't, the faucet is the only way. The
 * faucet is harmless if Tender's NEAR lands later as well.
 */
export const GIFT_RETRY_HELPS: Record<GiftProblem, boolean> = {
  gift_off: false,
  daily_limit: false,
  already_given: false,
  rate_limited: true,
  unavailable: true,
  transfer_failed: true,
  timeout: true,
  failed: true,
};

/** What the readiness check needs: the node, the login's token and the API, and a clock. */
export interface GiftDeps {
  balanceOf(accountId: string): Promise<bigint>;
  /** The login's access token, or null when the login has none (it ended). */
  loginToken(): Promise<string | null>;
  requestGift(loginToken: string, accountId: string): Promise<GasGiftResponse>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** The problem an API error's body names, or `failed` for any other failure. */
export function giftProblemOf(error: unknown): GiftProblem {
  if (!(error instanceof ApiError)) return "failed";
  const body = ErrorBodySchema.safeParse(error.body);
  const code = body.success ? body.data.error : null;
  return CODED.find((problem) => problem === code) ?? "failed";
}

const stuck = (problem: GiftProblem, before: bigint | null): Readiness => ({
  status: "stuck",
  problem,
  before,
});

/**
 * Reads the node until `accountId` holds more than `before`, for at most `waitMs`. A read that
 * fails is tried again on the next round: the node can lag a block behind the one the API sent to.
 */
async function waitForArrival(
  accountId: string,
  before: bigint,
  deps: GiftDeps,
  waitMs: number,
  everyMs: number,
): Promise<Readiness> {
  const until = deps.now() + waitMs;
  for (;;) {
    try {
      if ((await deps.balanceOf(accountId)) > before) return { status: "ready" };
    } catch (error) {
      console.error(error);
    }
    if (deps.now() + everyMs > until) return stuck("timeout", before);
    await deps.sleep(everyMs);
  }
}

/**
 * Makes `accountId` ready to pay fees, if it is not: reads its balance, asks for the gift when it is
 * under `GAS_GIFT_BELOW`, and waits for it to arrive. Never throws: what went wrong is the answer.
 *
 * `retrying`: what the last try came to, for Try again. Its balance is read first in every case;
 * after a gift that was sent (`timeout`) or may have been (`transfer_failed`), NEAR that arrived
 * since is the gift, and the account is ready. After a `timeout` it only waits again (asking again
 * would be `already_given`); after anything else it asks again.
 */
export async function getAccountReady(
  accountId: string,
  deps: GiftDeps,
  options: {
    retrying?: { problem: GiftProblem; before: bigint | null };
    waitMs?: number;
    everyMs?: number;
  } = {},
): Promise<Readiness> {
  const waitMs = options.waitMs ?? GIFT_WAIT_MS;
  const everyMs = options.everyMs ?? GIFT_POLL_MS;
  const last = options.retrying;
  let now: bigint;
  try {
    now = await deps.balanceOf(accountId);
  } catch (error) {
    console.error(error);
    return stuck("failed", last?.before ?? null);
  }
  if (now >= GAS_GIFT_BELOW) return { status: "ready" };
  if (last !== undefined && last.before !== null) {
    const mayHaveSent = last.problem === "timeout" || last.problem === "transfer_failed";
    if (mayHaveSent && now > last.before) return { status: "ready" };
    if (last.problem === "timeout") {
      return waitForArrival(accountId, last.before, deps, waitMs, everyMs);
    }
  }

  let answer: GasGiftResponse;
  try {
    const token = await deps.loginToken();
    if (token === null) return stuck("failed", now);
    answer = await deps.requestGift(token, accountId);
  } catch (error) {
    // The words come from the code; the error itself is for a developer. It names no token: an
    // `ApiError` keeps the body out of its message and its enumerable fields.
    const problem = giftProblemOf(error);
    if (problem === "failed") console.error(error);
    return stuck(problem, now);
  }
  // The API read the account as holding enough: this page's node is a block or two behind it.
  if (answer.status === "not_needed") return { status: "ready" };
  return waitForArrival(accountId, now, deps, waitMs, everyMs);
}
