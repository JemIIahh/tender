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

/** How many of a raw amount's last digits always show, however narrow its line. */
const TAIL_DIGITS = 6;

/**
 * An amount in a token this app has no decimals for (`knowsToken`), as the Live panel, a board card,
 * Metrics and Activity show it: the amount as the contract holds it, and under it a label that says
 * so, "smallest units of" and the token's account, its middle left out when it is long.
 *
 * The number is one run of figures that never wraps. On a line too narrow for all of it, it is cut
 * in the middle, visibly: its first digits as far as they fit, a "…", and always its last six. It
 * is never cut off silently at the line's edge, where the digits that are left would read as
 * another number. The "…" is drawn by CSS (`text-overflow`), and every digit stays in the page and
 * in the tooltip (`title`). The cut is for the eye only: its two parts are hidden from a screen
 * reader, which reads the whole number once, as one text, from a copy it alone is given. That copy
 * can't be selected, and the two parts sit in one line (inline blocks, not flex items, which a copy
 * would part with a line break), so what a person copies is the number once, whole. The whole id
 * is the label's title, and is what a screen reader reads of it.
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
  const cut = value.length > TAIL_DIGITS * 2;
  return (
    <span className="grid min-w-0 gap-0.5">
      <span className="flex min-w-0 font-mono tabular-nums">
        {/* Words and a whole number for a screen reader only, which a copy leaves out. */}
        {label === undefined ? null : <span className="sr-only select-none">{label} </span>}
        {/* A number in two parts could be read as two numbers: the screen reader has it whole. */}
        {cut ? <span className="sr-only select-none">{value}</span> : null}
        <span
          data-testid={amountTestId}
          title={value}
          aria-hidden={cut ? true : undefined}
          className="block max-w-full min-w-0 whitespace-nowrap"
        >
          {cut ? (
            <>
              {/* The head takes what the line has left after the tail's six figures (a figure is
                  1ch in mono), and gives way with a "…". */}
              <span
                data-testid="raw-head"
                className="inline-block max-w-[calc(100%-6ch)] overflow-hidden align-bottom text-ellipsis"
              >
                {value.slice(0, -TAIL_DIGITS)}
              </span>
              <span className="inline-block align-bottom">{value.slice(-TAIL_DIGITS)}</span>
            </>
          ) : (
            value
          )}
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
