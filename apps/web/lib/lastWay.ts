import type { ConnectWay, WayMemory } from "./privy";

// How this browser last signed in: "email" or "google" (the login), or "wallet:" and a NEAR
// wallet's id from near-connect's list. The way, the login or a wallet, is read from it: a restore
// prefers that way (lib/privy.ts `choiceProvider`), so that a browser where both ways once connected
// comes back as the one used last and not as whichever answers first; and the Connect window marks
// the method's row "Last used".
//
// It is kept in `localStorage`, under one key. It is no secret and says nothing about the account:
// no token, no account id, no address. A wallet's id is checked on the way in and out (a short name
// of letters, digits, dots, dashes and underscores). Two words an earlier build kept, "login" and
// "wallet", still give the way, with no row marked. A browser that won't keep it loses only the
// preference.

export const LAST_WAY_KEY = "tender.connect.way";

/** What is kept: the method of the last sign-in, or only its way. */
export type LastUsed = "email" | "google" | "login" | "wallet" | `wallet:${string}`;

/** A wallet's id, as near-connect's list spells them. */
const WALLET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const WORDS: readonly string[] = ["email", "google", "login", "wallet"];

/** `value` if it is one of the kept forms, or null. */
export function lastUsedOf(value: string | null): LastUsed | null {
  if (value === null) return null;
  if (WORDS.includes(value)) return value as LastUsed;
  if (value.startsWith("wallet:") && WALLET_ID.test(value.slice("wallet:".length))) {
    return value as LastUsed;
  }
  return null;
}

/** The way a kept method belongs to. */
export function wayOf(used: LastUsed | null): ConnectWay | null {
  if (used === null) return null;
  return used === "wallet" || used.startsWith("wallet:") ? "wallet" : "login";
}

/** What a wallet's row stands for, as kept; a wallet with no id is the way alone. */
export function walletUsed(walletId: string | null): LastUsed {
  return walletId === null ? "wallet" : (lastUsedOf(`wallet:${walletId}`) ?? "wallet");
}

export const lastWay: WayMemory = {
  get() {
    try {
      return lastUsedOf(localStorage.getItem(LAST_WAY_KEY));
    } catch {
      return null;
    }
  },
  set(used) {
    const checked = lastUsedOf(used);
    if (checked === null) return;
    try {
      localStorage.setItem(LAST_WAY_KEY, checked);
    } catch {
      // Off or full: the next restore takes the first session it finds, and no row is marked.
    }
  },
};
