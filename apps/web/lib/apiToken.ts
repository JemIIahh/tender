// The API token's keeping. lib/auth.ts signs in and hands the token in here; the wallet store
// (lib/wallet.ts) says when a wallet session begins and when it ends.
//
// The token is a secret. It lives in this module's memory and in `sessionStorage`, which is the
// tab's and is gone when the tab closes; it is never in `localStorage`, which every later visit
// could read. It is not logged, and no error carries it.
//
// It belongs to the wallet session it was signed in under, and goes when the session does: the
// store calls `sessionEnded` and `sessionBegan` from where it holds the session, so the token is
// dropped by a disconnect, a sign-out from the wallet itself, a sign-out or a new connect in
// another tab (lib/walletTabs.ts) and a switch of account whether or not any page that uses the
// token is on screen. A sign-in carries a ticket for the session it began in, and a token that
// comes back from a sign-in for a session that is over is not kept.

/** Where the token is kept for the tab. */
const STORAGE_KEY = "tender.apiToken";

/** The token and whom it is for. */
export interface StoredToken {
  accountId: string;
  token: string;
  /** When the API stops taking it, in ms since the epoch. */
  expiresAtMs: number;
}

/** The token in memory. Undefined until `sessionStorage` has been asked for it. */
let kept: StoredToken | null | undefined;
const listeners = new Set<() => void>();

/**
 * Counts the changes that end a sign-in's right to keep its token: a wallet session beginning or
 * ending, and the token being cleared. A sign-in notes the count when it starts (`signInTicket`).
 */
let epoch = 0;

function isStoredToken(value: unknown): value is StoredToken {
  if (typeof value !== "object" || value === null) return false;
  const { accountId, token, expiresAtMs } = value as Record<string, unknown>;
  return (
    typeof accountId === "string" &&
    typeof token === "string" &&
    token !== "" &&
    typeof expiresAtMs === "number" &&
    Number.isFinite(expiresAtMs)
  );
}

/** The token the tab kept, if it is still good. `sessionStorage` can throw or be empty. */
function loadToken(): StoredToken | null {
  try {
    const text = sessionStorage.getItem(STORAGE_KEY);
    if (text === null) return null;
    const value: unknown = JSON.parse(text);
    if (isStoredToken(value) && value.expiresAtMs > Date.now()) return value;
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Unreadable or blocked: there is no kept token.
  }
  return null;
}

function keep(next: StoredToken | null): void {
  kept = next;
  try {
    if (next === null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The token stays in memory for this page; a reload asks for a new sign-in.
  }
  for (const listener of [...listeners]) listener();
}

/** The token in hand, from memory or else from the tab, or null. A snapshot for React. */
export function heldToken(): StoredToken | null {
  if (kept === undefined) kept = loadToken();
  return kept;
}

/** What the server renders: no token. */
export const noToken = (): StoredToken | null => null;

/**
 * The token in `stored` if it is for `accountId` and the API has not stopped taking it, else null.
 * The one rule for whose token may be used, for a render (`useApiToken`) and for a request
 * (`liveToken`, which reads `heldToken` each time).
 */
export function tokenForAccount(
  stored: StoredToken | null,
  accountId: string | null,
): string | null {
  return stored !== null && stored.accountId === accountId && stored.expiresAtMs > Date.now()
    ? stored.token
    : null;
}

export function subscribeToken(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forgets the token, in memory and in the tab, and turns away the sign-ins that are under way. */
export function clearApiToken(): void {
  epoch++;
  keep(null);
}

/** What a sign-in takes when it starts, and gives back to `keepToken` when it is done. */
export function signInTicket(): number {
  return epoch;
}

/**
 * Keeps the token of a sign-in, unless the wallet session it began in is over (or the token was
 * cleared meanwhile). False if the token was not kept; the sign-in has to tell its caller.
 */
export function keepToken(stored: StoredToken, ticket: number): boolean {
  if (ticket !== epoch) return false;
  keep(stored);
  return true;
}

/**
 * A wallet session has begun for `accountId`. `continued`: it is the wallet of an earlier visit,
 * which the page took up again (a reload); its token stays if it is for the same account. A session
 * the person began by connecting a wallet is a new one, and signs in again.
 */
export function sessionBegan(accountId: string, continued: boolean): void {
  epoch++;
  const held = heldToken();
  if (held !== null && !(continued && held.accountId === accountId)) keep(null);
}

/**
 * The wallet session is over: a disconnect, a sign-out from the wallet or from another tab, or none
 * to be found.
 */
export function sessionEnded(): void {
  clearApiToken();
}
