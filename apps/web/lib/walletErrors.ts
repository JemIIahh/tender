import { errorMessage } from "./errors";
import { SendOutcomeUnknown } from "./sendOutcome";

// What can go wrong between this app and a wallet, as errors a page can tell apart. Each one's
// `message` is for a developer's console and quotes nothing a wallet or the API chose; the words
// for a person are in `walletErrorMessage`, which falls back to `errorMessage` (lib/errors.ts) for
// the failures that are not a wallet's.

/**
 * What a person is told where a sign-in to Tender is wanted and their wallet cannot give one: the
 * upload and the Telegram link buttons show it. Browsing and sending transactions still work.
 */
export const WALLET_CANNOT_SIGN_MESSAGE =
  "This wallet can't sign messages. Switch wallet to post tasks or link Telegram.";

/** The connected wallet cannot sign a message (NEP-413), so there is no sign-in to Tender. */
export class WalletCannotSign extends Error {
  constructor() {
    super(WALLET_CANNOT_SIGN_MESSAGE);
    this.name = "WalletCannotSign";
  }
}

/** Something asked a wallet to act while none is connected. */
export class WalletNotConnected extends Error {
  constructor() {
    super("no wallet is connected");
    this.name = "WalletNotConnected";
  }
}

/** This build has no wallet to offer: it targets the sandbox, and its dev wallet is off. */
export class WalletUnavailable extends Error {
  constructor() {
    super(
      "no wallet is available for the sandbox: set NEXT_PUBLIC_DEV_WALLET=1 to use the dev wallet",
    );
    this.name = "WalletUnavailable";
  }
}

/** A wallet threw when it was asked to connect, disconnect, send transactions or sign. */
export class WalletError extends Error {
  readonly action: "connect" | "disconnect" | "send" | "sign";

  /** `cause` is what the wallet threw. */
  constructor(action: WalletError["action"], cause: unknown) {
    super(`the wallet failed to ${action}`, { cause });
    this.name = "WalletError";
    this.action = action;
  }
}

/** A transaction the wallet sent failed on the network. */
export class TransactionFailed extends Error {
  readonly txHash: string;
  /** The contract's error code, such as `E_FUNDS`, if the failure carries one. */
  readonly code: string | null;

  constructor(txHash: string, code: string | null) {
    super(`transaction ${txHash} failed on the network${code === null ? "" : ` (${code})`}`);
    this.name = "TransactionFailed";
    this.txHash = txHash;
    this.code = code;
  }
}

/** A wallet answered with something that is not what it was asked for. */
export class WalletResultUnreadable extends Error {
  readonly what: "transaction" | "signature";

  constructor(what: WalletResultUnreadable["what"]) {
    super(`the wallet's ${what} result is not in a shape this page can read`);
    this.name = "WalletResultUnreadable";
    this.what = what;
  }
}

/**
 * The API's sign-in challenge is not one this page signs. `field` names the part that is wrong and
 * never quotes it: it comes from a server that is not trusted.
 */
export class SignInRefused extends Error {
  readonly field: "message" | "recipient" | "nonce";

  constructor(field: SignInRefused["field"]) {
    super(`refusing to sign the API's sign-in challenge: its ${field} is not the expected one`);
    this.name = "SignInRefused";
    this.field = field;
  }
}

/**
 * The wallet session a sign-in began in is over: the wallet was disconnected, signed itself out or
 * was connected as another account before the sign-in was done. Its token is not kept.
 */
export class WalletSessionEnded extends Error {
  constructor() {
    super("the wallet session ended before the sign-in was done");
    this.name = "WalletSessionEnded";
  }
}

/**
 * A page needed an API session for an account and has none, even after confirming with the
 * account (the session it got is another account's, or ended at once): nothing was sent.
 */
export class NoApiSession extends Error {
  constructor() {
    super("there is no API session for this account");
    this.name = "NoApiSession";
  }
}

/** The wallet signed a sign-in as another account than the one that is connected. */
export class WalletAccountMismatch extends Error {
  constructor() {
    super("the wallet signed as another account than the one that is connected");
    this.name = "WalletAccountMismatch";
  }
}

export { SendOutcomeUnknown };

/**
 * What a person is told when a transaction was signed and sent and its end is not known
 * (`SendOutcomeUnknown`): it may still go through, so they look before they send it again.
 */
export const SEND_MAY_STILL_GO_THROUGH =
  "The transaction may still go through. Check your account's activity before you try again.";

/** Whether `error` is a send whose end is not known, as the wallet threw it or the store wrapped it. */
export function sendOutcomeUnknown(error: unknown): boolean {
  return (
    error instanceof SendOutcomeUnknown ||
    (error instanceof WalletError && error.cause instanceof SendOutcomeUnknown)
  );
}

const WALLET_ACTION_WORDS: Record<WalletError["action"], string> = {
  connect: "Couldn't sign in. Try again.",
  disconnect: "Couldn't disconnect the wallet. Try again.",
  send: "The wallet reported a problem. Check the balances below before you try again.",
  sign: "The wallet didn't sign the message.",
};

/** Plain words for why a wallet or a sign-in step failed. Any other failure is `errorMessage`'s. */
export function walletErrorMessage(error: unknown): string {
  if (error instanceof WalletCannotSign) return WALLET_CANNOT_SIGN_MESSAGE;
  if (error instanceof WalletNotConnected) return "Sign in first.";
  if (error instanceof WalletUnavailable) return "This build has no way to sign in.";
  if (sendOutcomeUnknown(error)) return SEND_MAY_STILL_GO_THROUGH;
  if (error instanceof WalletError) return WALLET_ACTION_WORDS[error.action];
  if (error instanceof TransactionFailed) return "The transaction failed on the network.";
  if (error instanceof WalletResultUnreadable) {
    return error.what === "transaction"
      ? "The wallet sent the transaction but didn't say how it went."
      : "The wallet signed, but its answer can't be used.";
  }
  if (error instanceof SignInRefused) {
    return `Tender's request to confirm with your account has the wrong ${error.field}, so nothing was signed.`;
  }
  if (error instanceof NoApiSession) {
    return "No API session for this account, so nothing was sent. Confirm with your account and try again.";
  }
  if (error instanceof WalletSessionEnded) {
    return "The wallet was disconnected or changed while confirming with your account, so nothing was confirmed. Try again with the account you want to use.";
  }
  if (error instanceof WalletAccountMismatch) {
    return "The wallet signed as a different account than the one you're signed in as, so nothing was sent to Tender.";
  }
  return errorMessage(error);
}
