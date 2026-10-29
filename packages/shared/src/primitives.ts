import { z } from "zod";

// The field types the contract writes into its JSON, shared by the view, event and document
// schemas so that each is defined once:
//
// - A u64 or u128 (ids, nanosecond timestamps, block heights, byte counts, amounts) is a decimal
//   string, because a JSON number loses digits above 2^53.
// - A u8, u16 or u32 (basis points, counts, windows in seconds, indexes, the version) is a JSON
//   integer.
// - An account id is a NEAR account id, and a hash is a SHA-256 as 64 lowercase hex characters.

const U64_MAX = 2n ** 64n - 1n;
const U128_MAX = 2n ** 128n - 1n;
/** What `U64` and `U128` write: ASCII digits, no sign, no leading zero. */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
/** NEAR's account id pattern. It is checked on short strings only, see `AccountIdSchema`. */
const ACCOUNT_ID = /^(?:(?:[a-z\d]+[-_])*[a-z\d]+\.)*(?:[a-z\d]+[-_])*[a-z\d]+$/;
const ACCOUNT_ID_MIN_LENGTH = 2;
const ACCOUNT_ID_MAX_LENGTH = 64;

/**
 * A decimal string for a number up to `max`. The length is checked first so that nothing parses a
 * huge string, and the whole check is one function because a throw inside a second check would
 * escape `safeParse`.
 */
function decimalString(max: bigint, type: string) {
  const maxLength = max.toString().length;
  return z
    .string()
    .refine(
      (s) => s.length <= maxLength && CANONICAL_DECIMAL.test(s) && BigInt(s) <= max,
      `expected a ${type} as a decimal string`,
    );
}

/** A u64 as the contract's `U64` writes it: a decimal string from "0" to "18446744073709551615". */
export const U64StringSchema = decimalString(U64_MAX, "u64");
/** A u128 as the contract's `U128` writes it, up to "340282366920938463463374607431768211455". */
export const U128StringSchema = decimalString(U128_MAX, "u128");

const uint = (max: number) => z.int().min(0).max(max);
/** A u8: a JSON integer from 0 to 255. */
export const U8Schema = uint(255);
/** A u16: a JSON integer from 0 to 65_535. */
export const U16Schema = uint(65_535);
/** A u32: a JSON integer from 0 to 4_294_967_295. */
export const U32Schema = uint(4_294_967_295);

/** A NEAR account id: 2 to 64 characters, lowercase alphanumerics joined by `.`, `-` or `_`. */
export const AccountIdSchema = z
  .string()
  .refine(
    (s) =>
      s.length >= ACCOUNT_ID_MIN_LENGTH && s.length <= ACCOUNT_ID_MAX_LENGTH && ACCOUNT_ID.test(s),
    "expected a NEAR account id",
  );

/** A SHA-256 as the contract writes one: 64 lowercase hex characters. */
export const HashHexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex characters");
