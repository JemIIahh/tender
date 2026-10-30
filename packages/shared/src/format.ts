import { NETWORKS, type NetworkId, USDC_DECIMALS } from "./constants";

/** NEP-148 keeps a token's decimals in a u8. */
const MAX_DECIMALS = 255;
/** Digits formatted amounts show after the point at least, when the token has that many. */
const MIN_FRACTION_DIGITS = 2;
/** wNEAR counts yoctoNEAR, as NEAR itself does. */
const WNEAR_DECIMALS = 24;
/** Where the wrapped NEAR token lives. The sandbox has none. */
const WRAPPED_NEAR: Partial<Record<NetworkId, string>> = {
  mainnet: "wrap.near",
  testnet: "wrap.testnet",
};

function checkDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(
      `decimals must be a whole number from 0 to ${MAX_DECIMALS}, got ${decimals}`,
    );
  }
}

/**
 * `amount`, a count of a token's smallest unit, as a decimal number for people to read. It shows at
 * least 2 and at most `decimals` digits after the point, and trims trailing zeros down to 2:
 * `1_250_000n, 6` is `"1.25"`, `1_000_000n, 6` is `"1.00"` and `1n, 6` is `"0.000001"`. A token
 * with fewer than 2 decimals shows all of them, and one with none shows no point.
 *
 * A string `amount` is a decimal string such as the views carry, digits only. Throws a
 * `RangeError` on a negative amount or on `decimals` that is not a whole number from 0 to 255, and
 * a `SyntaxError` on a string that is not digits.
 */
export function formatTokenAmount(amount: bigint | string, decimals: number): string {
  checkDecimals(decimals);
  if (typeof amount === "string" && !/^[0-9]+$/.test(amount)) {
    throw new SyntaxError(`amount must be a string of digits, got ${JSON.stringify(amount)}`);
  }
  const units = BigInt(amount);
  if (units < 0n) throw new RangeError(`amount must not be negative, got ${units}`);
  if (decimals === 0) return units.toString();

  const scale = 10n ** BigInt(decimals);
  const fraction = (units % scale).toString().padStart(decimals, "0");
  const keep = Math.min(MIN_FRACTION_DIGITS, decimals);
  let end = fraction.length;
  while (end > keep && fraction[end - 1] === "0") end--;
  return `${units / scale}.${fraction.slice(0, end)}`;
}

/**
 * The count of smallest units that `text` writes: digits, then optionally a point and more digits.
 * `parseTokenAmount("1.25", 6)` is `1_250_000n`. Throws on anything else: a sign, an exponent, a
 * separator, spaces, a bare point (`"1."`, `".5"`) or other text. A negative number gets a
 * `RangeError`, text with more digits after the point than `decimals` a `RangeError` too (even if
 * the extra digits are zeros), and text that is no number a `SyntaxError`. `decimals` must be a
 * whole number from 0 to 255, or it is a `RangeError` as well.
 */
export function parseTokenAmount(text: string, decimals: number): bigint {
  checkDecimals(decimals);
  const parts = /^([0-9]+)(?:\.([0-9]+))?$/.exec(text);
  if (!parts) {
    if (/^-[0-9]/.test(text)) throw new RangeError(`amount must not be negative, got "${text}"`);
    throw new SyntaxError(`not a token amount: ${JSON.stringify(text)}`);
  }
  const whole = parts[1] ?? "";
  const fraction = parts[2] ?? "";
  if (fraction.length > decimals) {
    throw new RangeError(
      `"${text}" has ${fraction.length} fraction digits, but the token has ${decimals} decimals`,
    );
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

export interface TokenMeta {
  /** What to call the token. For a token this file does not know, its account id. */
  symbol: string;
  /** One whole token is `10 ** decimals` of the smallest unit the contract counts in. */
  decimals: number;
}

/**
 * The symbol and decimals of the token at `tokenId` on `network`:
 *
 * - Circle's USDC on its own network: `USDC`, 6.
 * - Wrapped NEAR on its own network (`wrap.near`, `wrap.testnet`): `wNEAR`, 24.
 * - The test token: `usdc.sandbox` on the sandbox, and any `tusdc.*` account on a network other
 *   than mainnet: `tUSDC`, 6. On mainnet no account is taken for a test token, because anyone can
 *   register a `tusdc.*` name there and its decimals are anyone's to choose.
 * - Any other token, or a test token on the wrong network: the account id as the symbol and 0
 *   decimals, so amounts show as raw units. The decimals of a token are not guessed.
 */
export function tokenMeta(tokenId: string, network: NetworkId): TokenMeta {
  if (tokenId === NETWORKS[network].usdc) return { symbol: "USDC", decimals: USDC_DECIMALS };
  if (tokenId === WRAPPED_NEAR[network]) return { symbol: "wNEAR", decimals: WNEAR_DECIMALS };
  const isTestToken =
    (network === "sandbox" && tokenId === "usdc.sandbox") ||
    (network !== "mainnet" && tokenId.startsWith("tusdc."));
  if (isTestToken) return { symbol: "tUSDC", decimals: USDC_DECIMALS };
  return { symbol: tokenId, decimals: 0 };
}
