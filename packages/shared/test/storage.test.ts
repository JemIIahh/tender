import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  STORAGE_BYTE_COST,
  STORAGE_MIN_DEPOSIT,
  type StorageView,
  StorageViewSchema,
  storageShortfall,
} from "../src/index";

const FIXTURES = new URL("./fixtures/", import.meta.url);

/** The real `storage_balance_of` sample, captured from the contract's wasm. */
const real: StorageView = StorageViewSchema.parse(
  JSON.parse(readFileSync(new URL("storage_view.json", FIXTURES), "utf8")),
);

const U128_MAX = 2n ** 128n - 1n;
const NEAR = 10n ** 24n;
/** What 1 KiB costs: 1,024 bytes at 10^19 yoctoNEAR. */
const ONE_KIB = 10_240_000_000_000_000_000_000n;

/** A registered account with `available` yoctoNEAR free and 79 bytes in use (the account record). */
function registered(available: bigint, usedBytes = 79n): StorageView {
  return {
    total: String(available + usedBytes * STORAGE_BYTE_COST),
    available: String(available),
    used_bytes: String(usedBytes),
  };
}

test("storage_constants_match_the_contract", () => {
  expect(STORAGE_BYTE_COST).toBe(10_000_000_000_000_000_000n);
  expect(STORAGE_MIN_DEPOSIT).toBe(10_000_000_000_000_000_000_000n);
  expect(STORAGE_MIN_DEPOSIT).toBe(NEAR / 100n);
  // storage.rs: "0.01 NEAR buys 1,000 bytes".
  expect(STORAGE_MIN_DEPOSIT / STORAGE_BYTE_COST).toBe(1_000n);

  // The real sample was measured by the contract, so it shows the price it bills at:
  // available = total - used_bytes x price.
  const billed = BigInt(real.total) - BigInt(real.used_bytes) * STORAGE_BYTE_COST;
  expect(billed).toBe(BigInt(real.available));
});

test("storage_shortfall_for_an_unregistered_account", () => {
  // 1 KiB costs more than the least first deposit, so it decides.
  expect(storageShortfall(null)).toBe(ONE_KIB);
  expect(storageShortfall(null)).toBeGreaterThan(STORAGE_MIN_DEPOSIT);
  expect(storageShortfall(null, 1_024n)).toBe(ONE_KIB);
  // Wanting up to 1,000 bytes still takes the least first deposit, which buys exactly 1,000.
  expect(storageShortfall(null, 0n)).toBe(STORAGE_MIN_DEPOSIT);
  expect(storageShortfall(null, 100n)).toBe(STORAGE_MIN_DEPOSIT);
  expect(storageShortfall(null, 1_000n)).toBe(STORAGE_MIN_DEPOSIT);
  // One byte more and the price of the bytes decides.
  expect(storageShortfall(null, 1_001n)).toBe(10_010_000_000_000_000_000_000n);
  expect(storageShortfall(null, 10_000n)).toBe(10n ** 23n);
});

test("storage_shortfall_when_there_is_exactly_enough", () => {
  expect(storageShortfall(registered(ONE_KIB))).toBe(0n);
  // The same with the bytes asked for spelt out.
  expect(storageShortfall(registered(ONE_KIB), 1_024n)).toBe(0n);
});

test("storage_shortfall_when_short_by_one_yocto", () => {
  expect(storageShortfall(registered(ONE_KIB - 1n))).toBe(1n);
  // And one yocto to spare is not short.
  expect(storageShortfall(registered(ONE_KIB + 1n))).toBe(0n);
});

test("storage_shortfall_counts_what_is_missing", () => {
  expect(storageShortfall(registered(0n))).toBe(ONE_KIB);
  expect(storageShortfall(registered(1n))).toBe(ONE_KIB - 1n);
  // 1,000 bytes free, 24 short of a KiB.
  expect(storageShortfall(registered(1_000n * STORAGE_BYTE_COST))).toBe(24n * STORAGE_BYTE_COST);
});

test("storage_shortfall_is_zero_for_a_large_available_balance", () => {
  expect(storageShortfall(registered(100n * NEAR))).toBe(0n);
  expect(storageShortfall(registered(U128_MAX))).toBe(0n);
  // Even for far more bytes than anyone stores.
  expect(storageShortfall(registered(U128_MAX), 10n ** 15n)).toBe(0n);
});

test("storage_shortfall_takes_a_custom_minimum", () => {
  const view = registered(5n * 10n ** 22n); // 0.05 NEAR free: 5,000 bytes
  expect(storageShortfall(view, 0n)).toBe(0n);
  expect(storageShortfall(view, 2_048n)).toBe(0n);
  expect(storageShortfall(view, 5_000n)).toBe(0n);
  expect(storageShortfall(view, 5_001n)).toBe(STORAGE_BYTE_COST);
  expect(storageShortfall(view, 6_000n)).toBe(1_000n * STORAGE_BYTE_COST);
  // The default is 1,024 bytes.
  expect(storageShortfall(registered(0n))).toBe(storageShortfall(registered(0n), 1_024n));
});

test("storage_shortfall_with_the_real_sample", () => {
  // The sample has 0.14351 NEAR free: far more than 1 KiB, and 14,351 bytes' worth.
  expect(storageShortfall(real)).toBe(0n);
  expect(storageShortfall(real, 14_351n)).toBe(0n);
  expect(storageShortfall(real, 14_352n)).toBe(STORAGE_BYTE_COST);
  expect(storageShortfall(real, 20_000n)).toBe(56_490_000_000_000_000_000_000n);
  // Derived: the same account after it had withdrawn all it could, so nothing is free.
  const drained: StorageView = {
    ...real,
    total: String(BigInt(real.total) - BigInt(real.available)),
    available: "0",
  };
  expect(storageShortfall(drained)).toBe(ONE_KIB);
});

test("storage_shortfall_rejects_an_available_that_is_not_a_u128_string", () => {
  const arabicIndicThree = String.fromCodePoint(0x0663);
  const bad = ["", " 7", "-1", "1.5", "1e18", "0x10", "007", "abc", arabicIndicThree];
  bad.push((U128_MAX + 1n).toString());
  for (const available of bad) {
    const view: StorageView = { ...real, available };
    expect(() => storageShortfall(view), JSON.stringify(available)).toThrow(
      "available must be a u128 as a decimal string",
    );
  }
});
