import { type StorageView, U128StringSchema } from "./views";

/**
 * What one byte of contract state costs, in yoctoNEAR: 10^19, or 0.00001 NEAR. It is NEAR's
 * storage price (`env::storage_byte_cost()`), which the contract bills every byte at, so
 * `available` in a `StorageView` is `total` minus `used_bytes` times this, down to 0.
 */
export const STORAGE_BYTE_COST = 10n ** 19n;

/**
 * The least a first `storage_deposit` may attach, in yoctoNEAR: 10^22, or 0.01 NEAR
 * (`STORAGE_MIN_DEPOSIT` in contract/tender/src/types.rs, and the `min` that
 * `storage_balance_bounds` reports). It buys 1,000 bytes.
 */
export const STORAGE_MIN_DEPOSIT = 10n ** 22n;

/**
 * The most bytes that registering an account can charge it: 133. The first deposit creates the
 * account's record in the contract and bills the account for it: 40 bytes of protocol overhead per
 * record, a 1-byte key prefix, the account id as Borsh writes it (a 4-byte length, then the id),
 * and a 24-byte value (a u128 and a u64). That is 69 bytes plus the length of the id, so 71 for a
 * 2-character id and 133 for a 64-character one, the longest NEAR allows.
 */
export const REGISTRATION_BYTES_MAX = 133n;

/**
 * How many yoctoNEAR an account still has to deposit to have `minBytes` of contract storage free,
 * or 0 if it already has them. A caller checks it before it commits, because an entry that runs
 * out of storage cannot reveal until someone tops the account up, and its reveal window does not
 * wait.
 *
 * `view` is what `storage_balance_of` returned for the account.
 *
 * - `null`: the account has never deposited, so its first deposit has to pay for the record that
 *   registers it as well as for `minBytes`. The answer is the price of both, or
 *   `STORAGE_MIN_DEPOSIT` if that is more. The record's size depends on the account id, which this
 *   does not know, so it allows for the longest id (`REGISTRATION_BYTES_MAX`). Every account then
 *   ends up with at least `minBytes` free, and one with a shorter id has up to 62 bytes (0.00062
 *   NEAR) more, which it can withdraw. Send it in a plain `storage_deposit`: with
 *   `registration_only` the contract credits only `STORAGE_MIN_DEPOSIT` and sends the rest back.
 * - Otherwise: `minBytes` times `STORAGE_BYTE_COST` less `view.available`, but never below 0.
 *
 * An `available` that is not a u128 decimal string throws a `TypeError`.
 */
export function storageShortfall(view: StorageView | null, minBytes = 1024n): bigint {
  if (view === null) {
    const deposit = (minBytes + REGISTRATION_BYTES_MAX) * STORAGE_BYTE_COST;
    // `Math.max` would throw on a bigint.
    if (deposit < STORAGE_MIN_DEPOSIT) return STORAGE_MIN_DEPOSIT;
    return deposit;
  }
  if (!U128StringSchema.safeParse(view.available).success) {
    throw new TypeError(
      `available must be a u128 as a decimal string, got ${JSON.stringify(String(view.available).slice(0, 40))}`,
    );
  }
  const short = minBytes * STORAGE_BYTE_COST - BigInt(view.available);
  if (short < 0n) return 0n;
  return short;
}
