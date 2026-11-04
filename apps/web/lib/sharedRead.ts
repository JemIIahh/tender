// One read that several parts of a tab show, made once for all of them. The landing's ticker and the
// top bar's Live pill show the same three figures (lib/live.ts): each used to read them for itself,
// and a move from the landing into the app read them again at once. Through a shared read the tab
// makes one request at a time, gives a part that comes later what was read less than `everyMs` ago,
// and reads again every `everyMs` while anything shows it and the tab is in view.

export interface SharedRead<T> {
  /**
   * Hands `listener` the latest value, and every value after it, until the returned function is
   * called. A value read less than `everyMs` ago is handed over at once; otherwise it comes when a
   * read (the one under way, or a new one) is back.
   */
  subscribe(listener: (value: T) => void): () => void;
  /** Forgets the value, the read under way and every listener (a test starts each case clean). */
  clear(): void;
}

/**
 * A shared read of `read`, which never throws (a read that can fail says so in its value). It runs
 * only while something listens: it is read again `everyMs` after the last read began, if the tab is
 * in view then, and otherwise `everyMs` later; and the last value is kept for whoever comes next.
 */
export function sharedRead<T>(read: () => Promise<T>, everyMs: number): SharedRead<T> {
  const listeners = new Set<(value: T) => void>();
  let kept: { value: T; at: number } | null = null;
  let under: { promise: Promise<T>; at: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A read from before `clear` is not handed to anyone after it.
  let era = 0;

  function schedule(from: number): void {
    clearTimeout(timer);
    timer = setTimeout(tick, Math.max(0, from + everyMs - Date.now()));
  }

  function tick(): void {
    timer = undefined;
    if (listeners.size === 0) return;
    if (document.visibilityState === "visible") refresh();
    else schedule(Date.now());
  }

  function refresh(): void {
    if (under !== null) return;
    const at = Date.now();
    const mine = era;
    const promise = read();
    under = { promise, at };
    void promise.then((value) => {
      if (mine !== era) return;
      under = null;
      kept = { value, at };
      for (const listener of [...listeners]) listener(value);
      if (listeners.size > 0) schedule(at);
    });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      const fresh = kept !== null && Date.now() - kept.at < everyMs;
      if (kept !== null && fresh) {
        listener(kept.value);
        if (timer === undefined && under === null) schedule(kept.at);
      } else {
        refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
    },
    clear() {
      era += 1;
      listeners.clear();
      kept = null;
      under = null;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
