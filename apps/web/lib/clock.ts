import { useEffect, useState } from "react";

const NS_PER_MS = 1_000_000n;

/** The wall clock now, in nanoseconds since the Unix epoch, which is how the chain counts time. */
export function nowNs(): bigint {
  return BigInt(Date.now()) * NS_PER_MS;
}

/**
 * The time now in nanoseconds, read again each second, for a page that draws a countdown or flips
 * a phase at its deadline. A nanosecond count is above 2^53, so it is a bigint.
 */
export function useNowNs(): bigint {
  const [now, setNow] = useState(nowNs);
  useEffect(() => {
    const timer = setInterval(() => setNow(nowNs()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
