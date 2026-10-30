import { formatTokenAmount, type NetworkId, tokenMeta } from "@tender/shared";
import { config } from "../lib/config";

/**
 * A token amount in whole units with its symbol: `1.25 USDC` for `1250000` of Circle's USDC. A
 * token this app does not know the decimals of (`tokenMeta` never guesses them) shows the amount
 * as it is, in the token's smallest unit, followed by the token's account id.
 *
 * `value` is a u128 as a decimal string, as the API and the contract write one. `network` is the
 * one that knows the token, the configured one unless a caller says otherwise.
 */
export function Amount({
  value,
  token,
  network = config.network,
}: {
  value: string;
  token: string;
  network?: NetworkId;
}) {
  const { symbol, decimals } = tokenMeta(token, network);
  return (
    // An account id has no place to break at, and the largest u128 is 39 digits: both can be
    // wider than a phone.
    <span data-testid="amount" className="wrap-anywhere">
      {formatTokenAmount(value, decimals)}{" "}
      {/* A token that is known has a symbol. One that is not has its account id, set apart so that
          it is not read as more of the number. */}
      {symbol === token ? <span className="font-mono text-sm">{symbol}</span> : symbol}
    </span>
  );
}
