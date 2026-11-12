import { ApiError, type GasGiftResponse } from "@tender/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../lib/api";
import {
  GAS_GIFT_BELOW,
  GIFT_PROBLEM_WAYS,
  GIFT_PROBLEM_WORDS,
  type GiftDeps,
  getAccountReady,
  giftProblemOf,
} from "../lib/gasGift";
import { nearBalanceOf } from "../lib/rpc";

// Getting a new email-login account ready: its balance read from the node, the gift asked of the
// API (`POST /v1/gas-gift`, mocked here: the route is another lane's) with the login's token, and
// the node read again until the NEAR arrives, or a plain reason why it won't.

const ACCOUNT = "ab".repeat(32);
const TOKEN = "login-access-token-for-the-tests";
const GIFT = 100_000_000_000_000_000_000_000n;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A world for the check: the balances the node gives, in order, and what the API answers. */
function deps(
  balances: bigint[],
  gift: (() => Promise<GasGiftResponse>) | null = async () => ({
    status: "sent",
    amount: GIFT.toString(),
    tx_hash: "gifthash",
  }),
) {
  let clock = 0;
  const asked: Array<{ token: string; account: string }> = [];
  const read: string[] = [];
  const world: GiftDeps = {
    balanceOf: async (account) => {
      read.push(account);
      return balances.length > 1 ? (balances.shift() as bigint) : (balances[0] as bigint);
    },
    loginToken: async () => TOKEN,
    requestGift: async (token, account) => {
      asked.push({ token, account });
      if (gift === null) throw new Error("no gift was expected");
      return gift();
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { world, asked, read, elapsed: () => clock };
}

const refusal = (status: number, error: string) =>
  new ApiError(status, { error, message: "a server's words" });

test("an_account_with_enough_near_is_ready_and_nothing_is_asked", async () => {
  const { world, asked } = deps([GAS_GIFT_BELOW], null);
  expect(await getAccountReady(ACCOUNT, world)).toEqual({ status: "ready" });
  expect(asked).toEqual([]);
});

test("a_new_account_is_sent_the_gift_with_the_login_token_and_waits_until_it_arrives", async () => {
  // Nothing at first (the account is not on the chain), then twice the node has not seen it yet.
  const { world, asked, read } = deps([0n, 0n, 0n, GIFT]);
  expect(await getAccountReady(ACCOUNT, world, { everyMs: 1000 })).toEqual({ status: "ready" });
  expect(asked).toEqual([{ token: TOKEN, account: ACCOUNT }]);
  expect(read).toHaveLength(4);
});

test("not_needed_from_the_api_is_ready", async () => {
  const { world } = deps([0n], async () => ({ status: "not_needed", balance: GIFT.toString() }));
  expect(await getAccountReady(ACCOUNT, world)).toEqual({ status: "ready" });
});

test("the_problem_comes_from_the_code_in_the_body_and_not_the_status_alone", async () => {
  // 429 and 503 each carry two meanings; the code tells them apart.
  for (const [status, code] of [
    [503, "gift_off"],
    [503, "unavailable"],
    [429, "daily_limit"],
    [429, "rate_limited"],
    [409, "already_given"],
    [502, "transfer_failed"],
  ] as const) {
    const { world } = deps([0n], async () => {
      throw refusal(status, code);
    });
    expect(await getAccountReady(ACCOUNT, world), code).toEqual({
      status: "stuck",
      problem: code,
      before: 0n,
    });
  }
  // Anything else is a failure, said as one: our own bad request or body, a refused token, a
  // status with no code, no answer at all.
  for (const thrown of [
    refusal(400, "bad_request"),
    refusal(413, "payload_too_large"),
    refusal(401, "unauthorized"),
    new ApiError(503, "Service Unavailable"),
    new TypeError("Failed to fetch"),
  ]) {
    const { world } = deps([0n], async () => {
      throw thrown;
    });
    expect(await getAccountReady(ACCOUNT, world)).toEqual({
      status: "stuck",
      problem: "failed",
      before: 0n,
    });
  }
  expect(giftProblemOf(new ApiError(429, "not json"))).toBe("failed");
});

test("each_problem_offers_try_again_where_it_can_help_and_the_faucet_where_tender_won_t_send", () => {
  expect(GIFT_PROBLEM_WAYS).toEqual({
    gift_off: { retry: false, faucet: true },
    daily_limit: { retry: false, faucet: true },
    already_given: { retry: false, faucet: true },
    rate_limited: { retry: true, faucet: false },
    unavailable: { retry: true, faucet: false },
    transfer_failed: { retry: true, faucet: false },
    timeout: { retry: true, faucet: false },
    failed: { retry: true, faucet: true },
  });
  expect(GIFT_PROBLEM_WORDS.transfer_failed).toMatch(/^Couldn't send yet\./);
});

test("try_again_after_a_failed_transfer_reads_the_balance_first_and_takes_near_that_arrived", async () => {
  // The transfer timed out at the API and landed after all: no second gift is asked for.
  const landed = deps([GIFT / 4n], null);
  expect(
    await getAccountReady(ACCOUNT, landed.world, {
      retrying: { problem: "transfer_failed", before: 0n },
    }),
  ).toEqual({ status: "ready" });
  expect(landed.asked).toEqual([]);

  // Nothing came: the gift is asked for again, and this time it is sent and arrives.
  const again = deps([0n, 0n, GIFT]);
  expect(
    await getAccountReady(ACCOUNT, again.world, {
      retrying: { problem: "transfer_failed", before: 0n },
    }),
  ).toEqual({ status: "ready" });
  expect(again.asked).toEqual([{ token: TOKEN, account: ACCOUNT }]);
});

test("try_again_after_unavailable_or_rate_limited_asks_again", async () => {
  for (const problem of ["unavailable", "rate_limited"] as const) {
    const world = deps([0n, GIFT]);
    expect(
      await getAccountReady(ACCOUNT, world.world, { retrying: { problem, before: 0n } }),
      problem,
    ).toEqual({ status: "ready" });
    expect(world.asked, problem).toHaveLength(1);
  }
});

test("a_gift_that_does_not_arrive_in_time_is_a_timeout_and_try_again_only_waits", async () => {
  const { world, asked, elapsed } = deps([0n]);
  expect(await getAccountReady(ACCOUNT, world, { waitMs: 10_000, everyMs: 2000 })).toEqual({
    status: "stuck",
    problem: "timeout",
    before: 0n,
  });
  expect(elapsed()).toBeLessThanOrEqual(10_000);
  expect(asked).toHaveLength(1);

  // Try again after a timeout reads the node again and does not ask for a second gift: it waits.
  const later = deps([0n, 0n, GIFT], null);
  expect(
    await getAccountReady(ACCOUNT, later.world, { retrying: { problem: "timeout", before: 0n } }),
  ).toEqual({ status: "ready" });
  expect(later.asked).toEqual([]);
  // A gift smaller than the line still counts once it has arrived.
  const small = deps([GIFT / 4n], null);
  expect(
    await getAccountReady(ACCOUNT, small.world, { retrying: { problem: "timeout", before: 0n } }),
  ).toEqual({ status: "ready" });
});

test("a_node_that_cannot_be_read_or_a_login_with_no_token_is_a_failure", async () => {
  const broken = deps([0n], null);
  broken.world.balanceOf = async () => {
    throw new Error("node down");
  };
  expect(await getAccountReady(ACCOUNT, broken.world)).toEqual({
    status: "stuck",
    problem: "failed",
    before: null,
  });

  const loggedOut = deps([0n], null);
  loggedOut.world.loginToken = async () => null;
  expect(await getAccountReady(ACCOUNT, loggedOut.world)).toEqual({
    status: "stuck",
    problem: "failed",
    before: 0n,
  });
  expect(loggedOut.asked).toEqual([]);
});

test("the_gift_request_names_the_account_bears_the_login_token_and_is_checked", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let answer: unknown = { status: "sent", amount: GIFT.toString(), tx_hash: "gifthash" };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer), { status: 200 });
  });

  expect(await api.gasGift(TOKEN, ACCOUNT)).toEqual(answer);
  expect(calls[0]?.url).toBe("http://api.test/v1/gas-gift");
  expect(calls[0]?.init.method).toBe("POST");
  expect(new Headers(calls[0]?.init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
  expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ account_id: ACCOUNT });

  // An answer that is not the shared schema's is refused.
  answer = { status: "sent", amount: "a lot" };
  await expect(api.gasGift(TOKEN, ACCOUNT)).rejects.toBeInstanceOf(ApiError);
  // An account that is no account id is not sent.
  await expect(api.gasGift(TOKEN, "Not An Account")).rejects.toThrow(/not an account id/);
  expect(calls).toHaveLength(2);
});

test("the_balance_is_the_node_s_amount_and_zero_for_an_account_not_on_the_chain", async () => {
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const { params } = JSON.parse(String(init.body)) as { params: { account_id: string } };
    const body =
      params.account_id === ACCOUNT
        ? { jsonrpc: "2.0", id: "x", result: { amount: GIFT.toString(), locked: "0" } }
        : {
            jsonrpc: "2.0",
            id: "x",
            error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, data: "" },
          };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  expect(await nearBalanceOf(ACCOUNT)).toBe(GIFT);
  expect(await nearBalanceOf("cd".repeat(32))).toBe(0n);
});
