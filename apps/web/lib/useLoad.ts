import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./errors";

/** A read a page shows: not asked for yet, on its way, failed (and being tried again), or in. */
export type Loaded<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string; retrying: boolean }
  | { status: "ready"; data: T };

/**
 * A read for `key`, made when the key is set and made again when it changes; nothing while it is
 * null. Only the latest request counts: an answer to an earlier one is dropped (strict mode starts
 * two, a retry can overlap a slow one, and another key is another page), and `wanted()` turns false
 * for it, so that a read of many pages can stop asking. `read` resolves to null when it stopped.
 *
 * A retry leaves the error where it is, marked `retrying`, so that the person who pressed its
 * button keeps their focus. The person gets words (`errorMessage`); the original goes to the
 * console, where a developer looks.
 */
export function useLoad<T>(
  key: string | null,
  read: (key: string, wanted: () => boolean) => Promise<T | null>,
): [Loaded<T>, () => void] {
  const [state, setState] = useState<Loaded<T>>({ status: "idle" });
  const latest = useRef(0);
  // The read of the render that asks: a page passes a new function each time, and the latest wins.
  const reader = useRef(read);
  reader.current = read;

  const load = useCallback(() => {
    const request = ++latest.current;
    if (key === null) {
      setState({ status: "idle" });
      return;
    }
    const wanted = () => request === latest.current;
    setState((was) =>
      was.status === "error" ? { ...was, retrying: true } : { status: "loading" },
    );
    reader.current(key, wanted).then(
      (data) => {
        if (wanted() && data !== null) setState({ status: "ready", data });
      },
      (error) => {
        if (!wanted()) return;
        console.error(error);
        setState({ status: "error", message: errorMessage(error), retrying: false });
      },
    );
  }, [key]);

  useEffect(() => {
    load();
    // The page is going, or the key changes: the read under way is not wanted.
    return () => {
      latest.current++;
    };
  }, [load]);

  return [state, load];
}
