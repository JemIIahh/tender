import { errorMessage } from "./errors";

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

/** The wallet signed a sign-in as another account than the one that is connected. */
export class WalletAccountMismatch extends Error {
  constructor() {
    super("the wallet signed as another account than the one that is connected");
    this.name = "WalletAccountMismatch";
  }
}

const WALLET_ACTION_WORDS: Record<WalletError["action"], string> = {
  connect: "Couldn't connect the wallet. Try again.",
  disconnect: "Couldn't disconnect the wallet. Try again.",
  send: "The wallet didn't send that. Check the balances below, then try again.",
  sign: "The wallet didn't sign the message.",
};

/** Plain words for why a wallet or a sign-in step failed. Any other failure is `errorMessage`'s. */
export function walletErrorMessage(error: unknown): string {
  if (error instanceof WalletCannotSign) return WALLET_CANNOT_SIGN_MESSAGE;
  if (error instanceof WalletNotConnected) return "Connect a wallet first.";
  if (error instanceof WalletUnavailable) return "This build has no wallet to connect.";
  if (error instanceof WalletError) return WALLET_ACTION_WORDS[error.action];
  if (error instanceof TransactionFailed) return "The transaction failed on the network.";
  if (error instanceof WalletResultUnreadable) {
    return error.what === "transaction"
      ? "The wallet sent the transaction but didn't say how it went."
      : "The wallet signed, but its answer can't be used.";
  }
  if (error instanceof SignInRefused) {
    return `Tender's sign-in request has the wrong ${error.field}, so nothing was signed.`;
  }
  if (error instanceof WalletAccountMismatch) {
    return "The wallet signed in as a different account than the one connected, so nothing was sent to Tender.";
  }
  return errorMessage(error);
}
