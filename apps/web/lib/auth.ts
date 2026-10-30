import { canonicalBase, SIGN_IN_MESSAGE } from "@tender/shared";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import { config } from "./config";
import { type SignedMessageResult, type SignMessageInput, useWallet } from "./wallet";
import {
  SignInRefused,
  WalletAccountMismatch,
  WalletCannotSign,
  WalletNotConnected,
} from "./walletErrors";

// Signing in to the Tender API: the API issues a challenge, the wallet signs it (NEP-413) and the
// API trades the signature for a bearer token. The token is what the writes to the API take
// (`api.uploadBlob`, `api.start`, `api.telegramLink`).
//
// The token is a secret. It lives in this module's memory and in `sessionStorage`, which is the
// tab's and is gone when the tab closes; it is never in `localStorage`, which every later visit
// could read. It is not logged, and no error carries it.

export { WALLET_CANNOT_SIGN_MESSAGE, WalletCannotSign } from "./walletErrors";

/** Where the token is kept for the tab. */
const STORAGE_KEY = "tender.apiToken";

/** The token and whom it is for. */
interface StoredToken {
  accountId: string;
  token: string;
  /** When the API stops taking it, in ms since the epoch. */
  expiresAtMs: number;
}

export interface UseApiToken {
  /** The bearer token for the connected account, or null: sign in first. */
  token: string | null;
  /**
   * Signs in to the API with the connected wallet and gives the token. Throws `WalletNotConnected`
   * with no wallet, `WalletCannotSign` for one that can't sign a message, `SignInRefused` for a
   * challenge it won't sign, `WalletError` for a wallet that refused, and an `ApiError` or a
   * `TimeoutError` for the API.
   */
  signIn(): Promise<string>;
}

/** What `signInToTender` needs of the wallet. */
export interface SignInWallet {
  accountId: string | null;
  canSignMessage: boolean;
  signMessage(input: SignMessageInput): Promise<SignedMessageResult>;
}

/**
 * The 32 bytes a nonce spells, or null if `nonce` is not exactly the base64 of 32 bytes: 43
 * characters, one `=`, and the last character with no stray bits (it reads back as written).
 */
function decodeNonce(nonce: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(nonce)) return null;
  let binary: string;
  try {
    binary = atob(nonce);
  } catch {
    return null;
  }
  if (binary.length !== 32 || btoa(binary) !== nonce) return null;
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * One sign-in: a challenge, the wallet's signature of it, and the token the API gives for that.
 *
 * The wallet signs only a challenge that is what this page expects: the message of
 * `SIGN_IN_MESSAGE`, this API's own address as the recipient, and a 32-byte nonce. The API is not
 * trusted to choose them, because the signature is good for whatever the challenge says: a server
 * that could pick them could have the wallet sign a message meant for another service. When a
 * field is not the expected one, nothing is signed and `SignInRefused` names the field, and not
 * what it held.
 */
export async function signInToTender(wallet: SignInWallet): Promise<StoredToken> {
  const { accountId } = wallet;
  if (accountId === null) throw new WalletNotConnected();
  if (!wallet.canSignMessage) throw new WalletCannotSign();

  const challenge = await api.authChallenge();
  if (challenge.message !== SIGN_IN_MESSAGE) throw new SignInRefused("message");
  if (challenge.recipient !== canonicalBase(config.apiUrl)) throw new SignInRefused("recipient");
  const nonce = decodeNonce(challenge.nonce);
  if (nonce === null) throw new SignInRefused("nonce");

  const signed = await wallet.signMessage({
    message: challenge.message,
    recipient: challenge.recipient,
    nonce,
  });
  // The API would check the signature against this account all the same; a wallet that signed as
  // another account than the one shown is better stopped here.
  if (signed.accountId !== accountId) throw new WalletAccountMismatch();

  const verified = await api.authVerify({
    accountId: signed.accountId,
    publicKey: signed.publicKey,
    signature: signed.signature,
    nonce: challenge.nonce,
    message: challenge.message,
    recipient: challenge.recipient,
  });
  return {
    accountId: signed.accountId,
    token: verified.token,
    expiresAtMs: Date.parse(verified.expires_at),
  };
}

// ---- The token's keeping -----------------------------------------------------------------------

/** The token in memory. Undefined until `sessionStorage` has been asked for it. */
let kept: StoredToken | null | undefined;
const listeners = new Set<() => void>();

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

/** Forgets the token, in memory and in the tab. The wallet stays connected. */
export function clearApiToken(): void {
  keep(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): StoredToken | null {
  if (kept === undefined) kept = loadToken();
  return kept;
}

const getServerSnapshot = (): StoredToken | null => null;

/** The sign-in that is running, so that two buttons pressed together ask the wallet once. */
let pending: { accountId: string | null; promise: Promise<string> } | null = null;

function signInOnce(wallet: SignInWallet): Promise<string> {
  if (pending !== null && pending.accountId === wallet.accountId) return pending.promise;
  const promise = signInToTender(wallet)
    .then((stored) => {
      keep(stored);
      return stored.token;
    })
    .finally(() => {
      if (pending?.promise === promise) pending = null;
    });
  pending = { accountId: wallet.accountId, promise };
  return promise;
}

/**
 * The API token of the connected account and the way to get one. A token belongs to the account
 * that signed in: it is not given for another, and it is dropped when the wallet is disconnected or
 * connected as another account.
 */
export function useApiToken(): UseApiToken {
  const { ready, accountId, canSignMessage, signMessage } = useWallet();
  const stored = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (ready && stored !== null && stored.accountId !== accountId) clearApiToken();
  }, [ready, accountId, stored]);

  const signIn = useCallback(
    () => signInOnce({ accountId, canSignMessage, signMessage }),
    [accountId, canSignMessage, signMessage],
  );

  const token =
    stored !== null && stored.accountId === accountId && stored.expiresAtMs > Date.now()
      ? stored.token
      : null;
  return { token, signIn };
}
