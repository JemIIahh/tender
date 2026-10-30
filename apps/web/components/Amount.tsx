import { formatTokenAmount, type NetworkId, tokenMeta } from "@tender/shared";
import { config } from "../lib/config";

/** `value` in whole units, or undefined if it is no amount: missing, or not a string of digits. */
function wholeUnits(value: string | null | undefined, decimals: number): string | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    return formatTokenAmount(value, decimals);
  } catch {
    return undefined;
  }
}

/** A value that is no amount, as it was written, or a dash if there is nothing to show. */
function asWritten(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

/**
 * A token amount in whole units with its symbol: `1.25 USDC` for `1250000` of Circle's USDC. A
 * token this app does not know the decimals of (`tokenMeta` never guesses them) shows the amount
 * as it is, in the token's smallest unit, followed by the token's account id.
 *
 * `value` is a u128 as a decimal string, as the API and the contract write one. It never throws:
 * a value that is no amount (a `view` result is unchecked JSON, and a missing balance is null)
 * shows as it was written, or as a dash if there is none, followed by the token's account id, as
 * there is no telling what unit it is in. `network` is the one that knows the token, the configured
 * one unless a caller says otherwise.
 */
export function Amount({
  value,
  token,
  network = config.network,
}: {
  value: string | null | undefined;
  token: string;
  network?: NetworkId;
}) {
  const { symbol, decimals } = tokenMeta(token, network);
  const whole = wholeUnits(value, decimals);
  return (
    // An account id has no place to break at, and the largest u128 is 39 digits: both can be
    // wider than a phone.
    <span data-testid="amount" className="wrap-anywhere">
      {whole ?? asWritten(value)}{" "}
      {/* A known token, with a value that is an amount, gets its symbol. Anything else gets the
          token's account id, set apart so that it is not read as more of the number. */}
      {whole !== undefined && symbol !== token ? (
        symbol
      ) : (
        <span className="font-mono text-sm">{token}</span>
      )}
    </span>
  );
}
