import { useEffect, useState } from "react";

/**
 * How long a wallet may take before the page offers to stop waiting for it. A wallet that is a
 * mobile app can take a while to be opened and to answer, so this is a minute and not seconds.
 */
export const STOP_WAITING_MS = 60_000;

/**
 * Whether `what` has been waited on for `ms`. `what` is a name for what is being waited on, or null
 * for nothing: a change of name starts the count again, and null ends it.
 */
export function useWaitedLong(what: string | null, ms: number = STOP_WAITING_MS): boolean {
  const [waited, setWaited] = useState<string | null>(null);
  useEffect(() => {
    setWaited(null);
    if (what === null) return;
    const timer = setTimeout(() => setWaited(what), ms);
    return () => clearTimeout(timer);
  }, [what, ms]);
  return what !== null && waited === what;
}
