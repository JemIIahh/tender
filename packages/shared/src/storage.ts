import { type StorageView, U128StringSchema } from "./views";

/**
 * What one byte of contract state costs, in yoctoNEAR: 10^19, or 0.00001 NEAR. It is NEAR's
 * storage price (`env::storage_byte_cost()`), which the contract bills every byte at, so
 * `available` in a `StorageView` is `total` minus `used_bytes` times this, down to 0.
 */
export const STORAGE_BYTE_COST = 10n ** 19n;

/**
 * The least a first `storage_deposit` may attach, in yoctoNEAR: 10^22, or 0.01 NEAR
 * (`STORAGE_MIN_DEPOSIT` in contract/tender/src/types.rs). It buys 1,000 bytes.
 */
export const STORAGE_MIN_DEPOSIT = 10n ** 22n;

/**
 * How many yoctoNEAR an account still has to deposit to have `minBytes` of contract storage free,
 * or 0 if it already has them. A caller checks it before it commits, because an entry that runs
 * out of storage cannot reveal until someone tops the account up, and its reveal window does not
 * wait.
 *
 * `view` is what `storage_balance_of` returned for the account.
 *
 * - `null`: the account has never deposited. Its first deposit must be at least
 *   `STORAGE_MIN_DEPOSIT`, so the answer is that or the price of `minBytes`, whichever is more.
 *   The record that registers the account takes its own bytes out of the deposit (about 70 to 135
 *   of them, set by the length of the account id), so the account ends up with a little less than
 *   `minBytes` free; the next check then asks for the difference.
 * - Otherwise: `minBytes` times `STORAGE_BYTE_COST` less `view.available`, but never below 0.
 *
 * An `available` that is not a u128 decimal string throws a `TypeError`.
 */
export function storageShortfall(view: StorageView | null, minBytes = 1024n): bigint {
  const needed = minBytes * STORAGE_BYTE_COST;
  if (view === null) {
    // `Math.max` would throw on a bigint.
    if (needed < STORAGE_MIN_DEPOSIT) return STORAGE_MIN_DEPOSIT;
    return needed;
  }
  if (!U128StringSchema.safeParse(view.available).success) {
    throw new TypeError(
      `available must be a u128 as a decimal string, got ${JSON.stringify(String(view.available).slice(0, 40))}`,
    );
  }
  const short = needed - BigInt(view.available);
  if (short < 0n) return 0n;
  return short;
}
