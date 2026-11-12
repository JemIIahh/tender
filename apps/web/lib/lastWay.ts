import type { ConnectChoice, WayMemory } from "./privy";

// The way this browser last connected: the email or Google login, or a NEAR wallet. A restore
// prefers it (lib/privy.ts `choiceProvider`), so that a browser where both ways once connected
// comes back as the one used last, and not as whichever answers first.
//
// It is kept in `localStorage`, under one key, as one of two words. It is no secret and says
// nothing about the account: no token, no account id, nothing from a request. A browser that
// won't keep it loses only the preference.

export const LAST_WAY_KEY = "tender.connect.way";

const WAYS: readonly ConnectChoice[] = ["login", "wallet"];

export const lastWay: WayMemory = {
  get() {
    try {
      const kept = localStorage.getItem(LAST_WAY_KEY);
      return WAYS.find((way) => way === kept) ?? null;
    } catch {
      return null;
    }
  },
  set(choice) {
    try {
      localStorage.setItem(LAST_WAY_KEY, choice);
    } catch {
      // Off or full: the next restore takes the first session it finds.
    }
  },
};
