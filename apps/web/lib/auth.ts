import { canonicalBase, SIGN_IN_MESSAGE } from "@tender/shared";
import { useCallback, useSyncExternalStore } from "react";
import { api } from "./api";
import {
  heldToken,
  keepToken,
  noToken,
  type StoredToken,
  signInTicket,
  subscribeToken,
} from "./apiToken";
import { config } from "./config";
import { type SignedMessageResult, type SignMessageInput, useWallet } from "./wallet";
import {
  SignInRefused,
  WalletAccountMismatch,
  WalletCannotSign,
  WalletNotConnected,
  WalletSessionEnded,
} from "./walletErrors";

// Signing in to the Tender API: the API issues a challenge, the wallet signs it (NEP-413) and the
// API trades the signature for a bearer token. The token is what the writes to the API take
// (`api.uploadBlob`, `api.start`, `api.telegramLink`).
//
// What is done with the token is in lib/apiToken.ts: it is kept in memory and in `sessionStorage`
// only, and it is dropped where the wallet session ends (the wallet store), not by the pages that
// use it. This file never logs, and no error it throws carries the token.

export { clearApiToken } from "./apiToken";
export { WALLET_CANNOT_SIGN_MESSAGE, WalletCannotSign } from "./walletErrors";

export interface UseApiToken {
  /** The bearer token for the connected account, or null: sign in first. */
  token: string | null;
  /**
   * Signs in to the API with the connected wallet and gives the token. Throws `WalletNotConnected`
   * with no wallet, `WalletCannotSign` for one that can't sign a message, `SignInRefused` for a
   * challenge it won't sign, `WalletError` for a wallet that refused, `WalletSessionEnded` for a
   * wallet that was disconnected (or changed) before the sign-in was done, and an `ApiError` or a
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

// ---- The hook -----------------------------------------------------------------------------------

/** The sign-in that is running, so that two buttons pressed together ask the wallet once. */
let pending: { accountId: string | null; ticket: number; promise: Promise<string> } | null = null;

function signInOnce(wallet: SignInWallet): Promise<string> {
  // The wallet session this sign-in is for. If it is over when the wallet has signed (a disconnect,
  // another account, a wallet that signed itself out), the token is not kept and is not given.
  const ticket = signInTicket();
  if (pending !== null && pending.accountId === wallet.accountId && pending.ticket === ticket) {
    return pending.promise;
  }
  const promise = signInToTender(wallet)
    .then((stored) => {
      if (!keepToken(stored, ticket)) throw new WalletSessionEnded();
      return stored.token;
    })
    .finally(() => {
      if (pending?.promise === promise) pending = null;
    });
  pending = { accountId: wallet.accountId, ticket, promise };
  return promise;
}

/**
 * The API token of the connected account and the way to get one. A token belongs to the account
 * that signed in, and to the wallet session it signed in under: the wallet store drops it when
 * that session ends, so a wallet connected again, as the same account or another, signs in again.
 */
export function useApiToken(): UseApiToken {
  const { accountId, canSignMessage, signMessage } = useWallet();
  const stored = useSyncExternalStore(subscribeToken, heldToken, noToken);

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
