import { ApiError, ErrorBodySchema, type GasGiftResponse } from "@tender/shared";

// Getting a new email-login account ready. An email or Google login (Privy) makes the person an
// implicit NEAR account, which holds no NEAR and is not on the chain until someone sends it some,
// and so can pay no fee. Right after the login the page reads its balance from the node; below
// `GAS_GIFT_BELOW` it asks Tender's API for a little testnet NEAR (`POST /v1/gas-gift`, with the
// login's access token), and reads the node again until the NEAR has arrived. A refusal, or a gift
// that doesn't arrive in time, is told in one plain line, with the testnet faucet as the way on.

/** Under this much NEAR, in yoctoNEAR, an account is given NEAR for its fees: 0.05 NEAR. */
export const GAS_GIFT_BELOW = 50_000_000_000_000_000_000_000n;

/** The public testnet faucet, the way on when Tender sends nothing. */
export const TESTNET_FAUCET_URL = "https://near-faucet.io/";

/** How long the page reads the node for a gift that was sent, and how often. */
export const GIFT_WAIT_MS = 60_000;
export const GIFT_POLL_MS = 2_000;

/**
 * Why an account is not ready: the API's three refusals, a gift that was sent and has not arrived
 * in time, and anything else that failed (the API or the node did not answer, or answered wrong).
 */
export type GiftProblem = "gift_off" | "daily_limit" | "already_given" | "timeout" | "failed";

export type Readiness = { status: "ready" } | { status: "stuck"; problem: GiftProblem };

const REFUSALS: readonly GiftProblem[] = ["gift_off", "daily_limit", "already_given"];

/** The one line for each problem. */
export const GIFT_PROBLEM_WORDS: Record<GiftProblem, string> = {
  gift_off: "Tender isn't sending NEAR for fees right now.",
  daily_limit: "Tender has sent all the NEAR for fees it sends today.",
  already_given: "Tender has already sent this account NEAR for fees once.",
  timeout: "The NEAR for fees hasn't arrived yet.",
  failed: "Tender couldn't send NEAR for fees just now.",
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

/** The refusal in an API error's body, or `failed` for any other failure. */
export function giftProblemOf(error: unknown): GiftProblem {
  if (!(error instanceof ApiError)) return "failed";
  const body = ErrorBodySchema.safeParse(error.body);
  const code = body.success ? body.data.error : null;
  return REFUSALS.find((refusal) => refusal === code) ?? "failed";
}

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
    if (deps.now() + everyMs > until) return { status: "stuck", problem: "timeout" };
    await deps.sleep(everyMs);
  }
}

/**
 * Makes `accountId` ready to pay fees, if it is not: reads its balance, asks for the gift when it is
 * under `GAS_GIFT_BELOW`, and waits for it to arrive. `waitOnly`: a gift was sent before and has
 * not arrived, so only the wait is done again (asking again would be `already_given`). Never
 * throws: what went wrong is the answer.
 */
export async function getAccountReady(
  accountId: string,
  deps: GiftDeps,
  options: { waitOnly?: boolean; waitMs?: number; everyMs?: number } = {},
): Promise<Readiness> {
  const waitMs = options.waitMs ?? GIFT_WAIT_MS;
  const everyMs = options.everyMs ?? GIFT_POLL_MS;
  let before: bigint;
  try {
    before = await deps.balanceOf(accountId);
  } catch (error) {
    console.error(error);
    return { status: "stuck", problem: "failed" };
  }
  if (before >= GAS_GIFT_BELOW) return { status: "ready" };
  if (options.waitOnly === true) return waitForArrival(accountId, before, deps, waitMs, everyMs);

  let answer: GasGiftResponse;
  try {
    const token = await deps.loginToken();
    if (token === null) return { status: "stuck", problem: "failed" };
    answer = await deps.requestGift(token, accountId);
  } catch (error) {
    // The words come from the refusal's code; the error itself is for a developer. It names no
    // token: an `ApiError` keeps the body out of its message and its enumerable fields.
    const problem = giftProblemOf(error);
    if (problem === "failed") console.error(error);
    return { status: "stuck", problem };
  }
  // The API read the account as holding enough: this page's node is a block or two behind it.
  if (answer.status === "not_needed") return { status: "ready" };
  return waitForArrival(accountId, before, deps, waitMs, everyMs);
}
