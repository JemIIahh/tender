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
//
// And, for this tab only (`sessionStorage`), the page a Google sign-in started on. Google sends the
// person back to one fixed address, the site's root (`oauthRedirectUrl`), which
// the owner lists in Privy's dashboard; the landing there sends them on to the page they started
// on, with Privy's parameters, where the login ends (`returnAddress`).

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

// ---- The page a Google sign-in started on --------------------------------------------------------

/**
 * The one address Google sends the person back to, on the site at `origin`: the origin itself,
 * which opens the root. Privy's dashboard lists exactly this address for each origin
 * (docs/RUNBOOK.md), so a sign-in can't be sent back anywhere else; Privy's docs say a listed
 * address with a trailing slash or a query is refused, so it has neither. lib/privyKit.tsx gives it
 * to Privy as `customOAuthRedirectUrl`.
 */
export function oauthRedirectUrl(origin: string): string {
  return origin;
}

/** The tab's key for the page a Google sign-in started on. */
export const RETURN_PAGE_KEY = "tender.connect.return";

/** Privy's parameters on the address a Google sign-in comes back to. */
export const OAUTH_PARAMS = [
  "privy_oauth_code",
  "privy_oauth_state",
  "privy_oauth_provider",
] as const;

/** Where a page on this site is not: another origin, a protocol-relative address, or a backslash. */
const ELSEWHERE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/\\|\\)/i;

/** The made-up origin a kept page is read against: what resolves elsewhere is not this site. */
const HERE = "https://tender.invalid";

/**
 * `page` if it is a path on this site ("/tasks/2?x=1#pick"), with no Privy parameters, or null.
 * It is checked as given and as the browser would read it: a path that only becomes another origin
 * once its dot segments are resolved ("/a/..//evil.com") is not one.
 */
function pageOf(page: string | null): string | null {
  if (page === null || !page.startsWith("/") || ELSEWHERE.test(page) || page.length > 2048) {
    return null;
  }
  if ([...page].some((char) => char.charCodeAt(0) <= 0x20 || char === "\u007f")) return null;
  const url = new URL(page, HERE);
  if (url.origin !== HERE) return null;
  for (const name of OAUTH_PARAMS) url.searchParams.delete(name);
  const kept = `${url.pathname}${url.search}${url.hash}`;
  if (!kept.startsWith("/") || ELSEWHERE.test(kept) || new URL(kept, HERE).origin !== HERE) {
    return null;
  }
  return kept;
}

/** Keeps `page` (its path, query and anchor) as the one a Google sign-in started on, in this tab. */
export function keepReturnPage(page: string): void {
  const checked = pageOf(page);
  if (checked === null) return;
  try {
    sessionStorage.setItem(RETURN_PAGE_KEY, checked);
  } catch {
    // Off or full: the return goes on to the wallet page instead.
  }
}

/** The page kept, once (it is forgotten as it is read), or null. */
export function takeReturnPage(): string | null {
  try {
    const kept = sessionStorage.getItem(RETURN_PAGE_KEY);
    sessionStorage.removeItem(RETURN_PAGE_KEY);
    return pageOf(kept);
  } catch {
    return null;
  }
}

/** Where a return with no page kept goes on to: the page that shows the account. */
export const RETURN_FALLBACK = "/wallet";

/**
 * Where a Google sign-in that came back to `search` (the root's `location.search`) goes on to: the
 * page `kept`, or the wallet page, with Privy's three parameters and the page's own anchor, so that
 * the login ends there; or null when `search` holds none of them.
 */
export function returnAddress(search: string, kept: string | null): string | null {
  const params = new URLSearchParams(search);
  if (OAUTH_PARAMS.some((name) => params.get(name) === null)) return null;
  const url = new URL(pageOf(kept) ?? RETURN_FALLBACK, HERE);
  for (const name of OAUTH_PARAMS) url.searchParams.set(name, params.get(name) as string);
  // The page's own anchor comes back with it, after the query ("/tasks/2?…#pick").
  return `${url.pathname}${url.search}${url.hash}`;
}
