import { formatDuration, isoDuration } from "../lib/phase";

/**
 * The time from `nowNs` to `toNs`, as a clock reads it, and `0s` once it has passed. It draws what
 * it is given: whoever owns the clock moves `nowNs` on, so a test can set any moment. A `timer`
 * is not announced as it changes, which suits a number that changes every second.
 */
export function Countdown({ toNs, nowNs }: { toNs: bigint; nowNs: bigint }) {
  const left = toNs > nowNs ? toNs - nowNs : 0n;
  return (
    <time role="timer" dateTime={isoDuration(left)} className="tabular-nums">
      {formatDuration(left)}
    </time>
  );
}
