import { PICK_BPS_WHOLE, splitReward } from "@tender/shared";
import { expect, test } from "vitest";
import { equalShares, equalSplitNote, readShare, shareText, shareTotal } from "../lib/shares";

// The winners' shares as the pick form takes them: in percent to two places, always 10,000 basis
// points in all, and any rounding said, never hidden.

test("equal_shares_always_add_up_to_10000_and_put_the_odd_points_first", () => {
  expect(equalShares(1)).toEqual([10_000]);
  expect(equalShares(2)).toEqual([5_000, 5_000]);
  expect(equalShares(3)).toEqual([3_334, 3_333, 3_333]);
  expect(equalShares(4)).toEqual([2_500, 2_500, 2_500, 2_500]);
  expect(equalShares(5)).toEqual([2_000, 2_000, 2_000, 2_000, 2_000]);
  for (let count = 1; count <= 7; count++) {
    const shares = equalShares(count);
    expect(shares).toHaveLength(count);
    expect(shares.reduce((sum, bps) => sum + bps, 0)).toBe(PICK_BPS_WHOLE);
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
  }
  expect(equalShares(0)).toEqual([]);
});

test("an_equal_split_that_does_not_come_out_even_says_so", () => {
  expect(equalSplitNote(1)).toBeNull();
  expect(equalSplitNote(2)).toBeNull();
  expect(equalSplitNote(3)).toBe(
    "100% doesn't split evenly 3 ways, so the first winner gets 0.01% more.",
  );
  expect(equalSplitNote(6)).toBe(
    "100% doesn't split evenly 6 ways, so the first 4 winners get 0.01% more.",
  );
});

test("a_share_is_read_in_percent_to_two_decimal_places", () => {
  expect(readShare("50")).toEqual({ ok: true, bps: 5_000 });
  expect(readShare("33.34")).toEqual({ ok: true, bps: 3_334 });
  expect(readShare(" 33.3 % ")).toEqual({ ok: true, bps: 3_330 });
  expect(readShare("0.01")).toEqual({ ok: true, bps: 1 });
  expect(readShare("100")).toEqual({ ok: true, bps: 10_000 });
  expect(readShare("100.00")).toEqual({ ok: true, bps: 10_000 });
  expect(readShare("7.")).toEqual({ ok: true, bps: 700 });
  for (const [text, message] of [
    ["", "Enter a share."],
    ["0", "A share must be more than 0%."],
    ["0.00", "A share must be more than 0%."],
    ["100.01", "A share can't be more than 100%."],
    ["33.333", "Use at most two decimal places."],
    ["-5", "Use a number, like 50 or 33.34."],
    ["abc", "Use a number, like 50 or 33.34."],
    ["1e2", "Use a number, like 50 or 33.34."],
  ] as const) {
    expect(readShare(text), text).toEqual({ ok: false, message });
  }
  // What the field shows is what it reads back.
  for (const bps of [1, 700, 3_333, 3_334, 5_000, 10_000]) {
    expect(readShare(shareText(bps))).toEqual({ ok: true, bps });
  }
});

test("shares_that_do_not_add_up_to_100_percent_say_what_is_missing_or_over", () => {
  expect(shareTotal([6_000, 4_000])).toEqual({ total: 10_000, ok: true, message: null });
  expect(shareTotal([5_000, 4_999])).toEqual({
    total: 9_999,
    ok: false,
    message: "The shares add up to 99.99%: 0.01% is left to give.",
  });
  expect(shareTotal([6_000, 5_000])).toEqual({
    total: 11_000,
    ok: false,
    message: "The shares add up to 110%: 10% too much.",
  });
});

test("the_payout_of_an_equal_split_shows_its_rounding_as_the_contract_pays_it", () => {
  // 1.000003 tUSDC at 5%: three equal shares of what is left do not come out even, and the contract
  // gives the units it rounded away to the first winner.
  const { fee, amounts, dust } = splitReward(1_000_003n, 500, equalShares(3));
  expect(fee).toBe(50_000n);
  // 950_003 at 33.34% is 316_731.0002 and at 33.33% 316_635.9999: 2 units short, to the first.
  expect(amounts).toEqual([316_733n, 316_635n, 316_635n]);
  expect(dust).toBe(2n);
  expect(fee + amounts.reduce((sum, amount) => sum + amount, 0n)).toBe(1_000_003n);
});
