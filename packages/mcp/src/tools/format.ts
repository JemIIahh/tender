import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, formatTokenAmount, type NetworkId, tokenMeta } from "@tender/shared";

// How the tools show things to an agent. Every result is JSON text, and a value that a person
// reads is shown twice: as the chain counts it, and in words.

/** yoctoNEAR in one NEAR: storage balances count in these. */
const NEAR_DECIMALS = 24;

/**
 * An amount of `token`, raw and then readable: `1000000 (1.00 USDC)`. A token the shared table does
 * not know has its account id for a symbol and no decimals, so its amount shows as what it is:
 * `500 (500 weird.near)`. The decimals of a token are not guessed.
 */
export function amountText(amount: bigint | string, token: string, network: NetworkId): string {
  const { symbol, decimals } = tokenMeta(token, network);
  return `${amount} (${formatTokenAmount(amount, decimals)} ${symbol})`;
}

/** An amount of yoctoNEAR, the same way: `10000000000000000000000 (0.01 NEAR)`. */
export function nearText(yocto: bigint | string): string {
  return `${yocto} (${formatTokenAmount(yocto, NEAR_DECIMALS)} NEAR)`;
}

/**
 * A time the contract counts in nanoseconds since the epoch (a u64 as a decimal string), as ISO 8601
 * in UTC to the millisecond: `2026-11-04T10:00:00.000Z`. The extra digits are cut, not rounded, so
 * a deadline never reads later than it is.
 */
export function isoOfNs(ns: string): string {
  return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
}

/** A tool result that is `value` as JSON text. */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** A tool result that is plain text, for an answer that is a sentence and not data. */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * `text` with every http(s) URL replaced by `<url>`. near-api-js puts the RPC URL it was given into
 * its error messages, and an RPC URL can carry an API key, so no error text leaves the server with
 * one in it.
 */
export function scrubUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/\S+/gi, "<url>");
}

/**
 * A failed tool as the agent sees it: `isError` and the text `{code}: {message}`. An API answer
 * that is not a success has the code `API_ERROR`; any other failure has the code `ERROR`. The
 * message has no URL in it (`scrubUrls`).
 */
export function errorResult(error: unknown): CallToolResult {
  const message = scrubUrls(error instanceof Error ? error.message : String(error));
  const code = error instanceof ApiError ? "API_ERROR" : "ERROR";
  return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] };
}
