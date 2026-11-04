import { type NetworkId, tokenMeta } from "@tender/shared";
import { config } from "./config";

// The one rule for whether the app can show a token's amounts as figures. `tokenMeta` knows the
// decimals of a few tokens (USDC, wNEAR, the test token) and never guesses any other's: it gives
// such a token its own account id as the symbol. So a token is known when its symbol is not its id.

/** Whether this app knows `token`'s decimals on `network` (the configured one unless said). */
export function knowsToken(token: string, network: NetworkId = config.network): boolean {
  return tokenMeta(token, network).symbol !== token;
}

/** A long id with its middle left out, `5f3a9c0e…5f3a9c0e`; one of 20 characters or fewer as it is. */
export function shortId(id: string): string {
  return id.length <= 20 ? id : `${id.slice(0, 8)}…${id.slice(-8)}`;
}

/** `amounts` with the tokens the app knows first, each group in the order it came. */
export function knownFirst<T>(amounts: readonly T[], tokenOf: (row: T) => string): T[] {
  return [...amounts].sort(
    (a, b) => Number(knowsToken(tokenOf(b))) - Number(knowsToken(tokenOf(a))),
  );
}
