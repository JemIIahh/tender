import { formatTokenAmount, type NetworkId, tokenMeta } from "@tender/shared";
import { config } from "../lib/config";
import { knowsToken, shortId } from "../lib/tokens";

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
      {whole !== undefined && knowsToken(token, network) ? (
        symbol
      ) : (
        <span className="font-mono text-sm">{token}</span>
      )}
    </span>
  );
}

/**
 * An amount in a token this app has no decimals for (`knowsToken`), as the Live panel and a board
 * card show it: the amount as the contract holds it, and under it a label that says so, "smallest
 * units of" and the token's account, its middle left out when it is long. The number is one
 * unbroken run of figures that never wraps in the middle: on a line too narrow for it, it scrolls
 * sideways on its own line. The whole id is the label's title, and is what a screen reader reads.
 */
export function RawUnits({
  value,
  token,
  amountTestId,
  unitTestId,
  label,
}: {
  value: string;
  token: string;
  amountTestId?: string;
  unitTestId?: string;
  /** Words for a screen reader before the amount, such as "Reward:". */
  label?: string;
}) {
  const short = shortId(token);
  return (
    <span className="grid min-w-0 gap-0.5">
      <span className="flex min-w-0 font-mono tabular-nums">
        {label === undefined ? null : <span className="sr-only">{label} </span>}
        <span
          data-testid={amountTestId}
          className="inline-block max-w-full overflow-x-auto align-bottom whitespace-nowrap"
        >
          {value}
        </span>
      </span>
      <span data-testid={unitTestId} className="text-[11.5px] text-muted">
        smallest units of{" "}
        {short === token ? (
          <span className="font-mono">{token}</span>
        ) : (
          <span title={token} className="font-mono">
            <span aria-hidden="true">{short}</span>
            <span className="sr-only">{token}</span>
          </span>
        )}
      </span>
    </span>
  );
}
