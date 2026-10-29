import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  REGISTRATION_BYTES_MAX,
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
/** The longest NEAR account id: 64 characters. */
const LONGEST_ID = "a".repeat(64);
/** Byte counts to ask for, either side of where the price of the bytes passes the minimum deposit. */
const WANTED = [0n, 1n, 100n, 866n, 867n, 868n, 1_000n, 1_024n, 5_000n, 1_000_000n];

/** A registered account with `available` yoctoNEAR free and 79 bytes in use (the account record). */
function registered(available: bigint, usedBytes = 79n): StorageView {
  return {
    total: String(available + usedBytes * STORAGE_BYTE_COST),
    available: String(available),
    used_bytes: String(usedBytes),
  };
}

/**
 * The bytes the contract charges an account for the record that registers it, from the record's
 * layout in storage.rs: 40 of protocol overhead, the key (a 1-byte prefix, then the id as Borsh
 * writes it, a 4-byte length and the id) and the 24-byte value (a u128 and a u64). The contract's
 * own tests measure it, at 79 bytes for `alice.test` and at 77 for `bob.test`.
 */
function registrationBytes(accountId: string): bigint {
  return 40n + (1n + 4n + BigInt(accountId.length)) + 24n;
}

/**
 * The storage view of `accountId` right after a first deposit of `deposit` and nothing else: the
 * record that registers it is charged to the account, and `available` is what is left of the
 * deposit. Worked out from the contract's formula, with no chain.
 */
function justRegistered(deposit: bigint, accountId: string): StorageView {
  const used = registrationBytes(accountId);
  // The contract refuses a first deposit below the minimum, or one that cannot pay for its record.
  expect(deposit).toBeGreaterThanOrEqual(STORAGE_MIN_DEPOSIT);
  expect(deposit).toBeGreaterThanOrEqual(used * STORAGE_BYTE_COST);
  return {
    total: String(deposit),
    available: String(deposit - used * STORAGE_BYTE_COST),
    used_bytes: String(used),
  };
}

test("storage_constants_match_the_contract", () => {
  expect(STORAGE_BYTE_COST).toBe(10_000_000_000_000_000_000n);
  // Also the `min` of `storage_balance_bounds`, which the sandbox tests check on a real node.
  expect(STORAGE_MIN_DEPOSIT).toBe(10_000_000_000_000_000_000_000n);
  expect(STORAGE_MIN_DEPOSIT).toBe(NEAR / 100n);
  // storage.rs: "0.01 NEAR buys 1,000 bytes".
  expect(STORAGE_MIN_DEPOSIT / STORAGE_BYTE_COST).toBe(1_000n);

  // The real sample was measured by the contract, so it shows the price it bills at:
  // available = total - used_bytes x price.
  const billed = BigInt(real.total) - BigInt(real.used_bytes) * STORAGE_BYTE_COST;
  expect(billed).toBe(BigInt(real.available));

  // The registration record is 69 bytes plus the id. The two sizes the contract's tests measure,
  // and the worst case, an id of the longest length.
  expect(registrationBytes("alice.test")).toBe(79n);
  expect(registrationBytes("bob.test")).toBe(77n);
  expect(registrationBytes("ab")).toBe(71n);
  expect(REGISTRATION_BYTES_MAX).toBe(registrationBytes(LONGEST_ID));
  expect(REGISTRATION_BYTES_MAX).toBe(133n);
});

test("storage_shortfall_unregistered_pays_for_the_record_and_the_bytes", () => {
  // The default 1 KiB plus the worst-case record: 1,024 + 133 = 1,157 bytes.
  expect(storageShortfall(null)).toBe(11_570_000_000_000_000_000_000n);
  expect(storageShortfall(null, 1_024n)).toBe(storageShortfall(null));
  // Asking for little still takes the least first deposit, which buys 1,000 bytes. It stays the
  // larger up to 867 bytes, because 867 + 133 is exactly 1,000.
  expect(storageShortfall(null, 0n)).toBe(STORAGE_MIN_DEPOSIT);
  expect(storageShortfall(null, 100n)).toBe(STORAGE_MIN_DEPOSIT);
  expect(storageShortfall(null, 867n)).toBe(STORAGE_MIN_DEPOSIT);
  // From 868 bytes the price of the bytes and the record decides.
  expect(storageShortfall(null, 868n)).toBe(10_010_000_000_000_000_000_000n);
  expect(storageShortfall(null, 10_000n)).toBe(101_330_000_000_000_000_000_000n);
});

test("storage_shortfall_unregistered_leaves_min_bytes_free_for_a_64_char_id", () => {
  // The worst case: the longest id has the biggest record. After the shortfall is deposited the
  // account has `minBytes` free, so asking again finds nothing more to deposit.
  for (const minBytes of WANTED) {
    const after = justRegistered(storageShortfall(null, minBytes), LONGEST_ID);
    const label = `${minBytes} bytes`;
    expect(storageShortfall(after, minBytes), label).toBe(0n);
    expect(BigInt(after.available), label).toBeGreaterThanOrEqual(minBytes * STORAGE_BYTE_COST);
    // Once the price decides and not the minimum deposit, the allowance is exact for this id: not
    // a yocto to spare, so it does not over-deposit more than the worst case needs.
    if (minBytes >= 867n) {
      expect(BigInt(after.available), label).toBe(minBytes * STORAGE_BYTE_COST);
    }
  }

  // A deposit of the minimum alone, which is what `registration_only` credits, leaves this id 867
  // bytes free: short of the default 1 KiB, so that deposit would not do.
  const minimal = justRegistered(STORAGE_MIN_DEPOSIT, LONGEST_ID);
  expect(minimal.available).toBe(String(867n * STORAGE_BYTE_COST));
  expect(storageShortfall(minimal)).toBe(157n * STORAGE_BYTE_COST);
});

test("storage_shortfall_unregistered_leaves_min_bytes_free_for_a_short_id", () => {
  // Every id shorter than the longest, from 2 characters up: its record is smaller, so the
  // account has at least `minBytes` free, and the answer never leaves it short.
  for (let length = 2; length < 64; length++) {
    const accountId = "a".repeat(length);
    for (const minBytes of WANTED) {
      const after = justRegistered(storageShortfall(null, minBytes), accountId);
      const label = `${length} characters, ${minBytes} bytes`;
      expect(storageShortfall(after, minBytes), label).toBe(0n);
      expect(BigInt(after.available), label).toBeGreaterThanOrEqual(minBytes * STORAGE_BYTE_COST);
    }
  }

  // What it costs a short id: with the price deciding, the spare is the difference between its
  // record and the worst case. The shortest id has 62 bytes (0.00062 NEAR) more than it asked for,
  // and `alice.test`, which the contract's tests measure at 79 bytes, has 54.
  const spare = (accountId: string) => {
    const after = justRegistered(storageShortfall(null), accountId);
    return BigInt(after.available) - 1_024n * STORAGE_BYTE_COST;
  };
  expect(spare("ab")).toBe(62n * STORAGE_BYTE_COST);
  expect(spare("ab")).toBe(620_000_000_000_000_000_000n);
  expect(spare("alice.test")).toBe(54n * STORAGE_BYTE_COST);
  expect(spare(LONGEST_ID)).toBe(0n);
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
