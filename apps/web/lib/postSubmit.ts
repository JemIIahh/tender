import {
  ApiError,
  type BlobUpload,
  type BlobUploadResponse,
  MAX_URI_BYTES,
  type TenderCall,
} from "@tender/shared";
import { api } from "./api";
import { heldToken, tokenForAccount } from "./apiToken";
import { config } from "./config";
import { errorMessage } from "./errors";
import {
  buildDocuments,
  DocumentError,
  fundingOf,
  type PostDocuments,
  type PostForm,
  planPostCalls,
  rewardOf,
} from "./post";
import { describeAmount, readVault, type VaultData } from "./vault";
import type { SendResult } from "./wallet";
import {
  TransactionFailed,
  WalletError,
  WalletNotConnected,
  WalletResultUnreadable,
  WalletSessionEnded,
  walletErrorMessage,
} from "./walletErrors";

// Posting a task, in the order that keeps the money and the held-out checks safe:
//
//   1. the documents are built and the reward is read as an amount, before anything leaves the
//      page (the steps of the wizard hold the rest of the form to what Tender allows, which this
//      does not see);
//   2. a sign-in to the API, if there is no token for the account;
//   3. the brief, the criteria and the held-out checks are uploaded, each to its own place;
//   4. the vault and the storage balance are read afresh, and the calls are planned from what they
//      hold;
//   5. one `signAndSend`: the storage top-up and the deposit that tops the vault up, if either is
//      short, and `post_task`.
//
// If the wallet refuses at 5, what was uploaded stays where it is and the form is as it was: the
// next try uploads the same bytes again, which the API stores once. The token is read from its
// keeping place for each request and never held between them, because the wallet session it
// belongs to can end at any time; a token the API turns away is signed in for again, through the
// wallet, and never cleared from here.

/** Where a post stopped, for the words about it. */
export type FailureStage = "documents" | "signin" | "upload" | "vault" | "wallet";

/** What the post is doing, for a line of progress. */
export type Stage = "signin" | "upload" | "vault" | "wallet";

/**
 * A post that did not happen, in words for the person. `stage` says how far it got: before
 * `wallet`, nothing was sent to the wallet. `cause` is the error underneath, for the console.
 */
export class SubmitFailure extends Error {
  readonly stage: FailureStage;

  constructor(stage: FailureStage, words: string, cause?: unknown) {
    super(words, { cause });
    this.name = "SubmitFailure";
    this.stage = stage;
  }
}

/** The API stored something other than what was sent, or at an address the chain can't use. */
class UploadMismatch extends Error {
  constructor() {
    super("the API's answer to an upload is not what was uploaded");
    this.name = "UploadMismatch";
  }
}

/** What a post needs from the world. The page gives the real ones; a test gives its own. */
export interface SubmitDeps {
  /** The account the wallet is connected as now, or null. Read afresh. */
  account(): string | null;
  /** The API token held for `account` now, or null. Read afresh for each request. */
  token(account: string): string | null;
  /** Signs in to the API with the wallet. The token it stores is read with `token`. */
  signIn(): Promise<unknown>;
  uploadBlob(token: string, blob: BlobUpload): Promise<BlobUploadResponse>;
  uploadHeldout(token: string, commitment: string, bytes: Uint8Array): Promise<void>;
  readVault(account: string): Promise<VaultData>;
  signAndSend(calls: readonly TenderCall[]): Promise<SendResult>;
}

/**
 * The token held for `account`: the one in its keeping place (lib/apiToken.ts), if it is for that
 * account and not out of date. The rule is `useApiToken`'s (`tokenForAccount`), read now and not at
 * a render.
 */
export function liveToken(account: string): string | null {
  return tokenForAccount(heldToken(), account);
}

/** The real ones, but for the wallet's: the page supplies those from `useWallet`. */
export const defaultDeps: Pick<SubmitDeps, "token" | "uploadBlob" | "uploadHeldout" | "readVault"> =
  {
    token: liveToken,
    uploadBlob: (token, blob) => api.uploadBlob(token, blob),
    uploadHeldout: (token, commitment, bytes) => api.uploadHeldout(token, commitment, bytes),
    readVault,
  };

export interface SubmitInput {
  form: PostForm;
  /** The account that is posting: the one connected when Post was pressed. */
  account: string;
  /** The token the reward is paid in, one that Tender takes. */
  tokenId: string;
  /** The Judge's account, for a form that picks the Judge as verifier. */
  judgeAccount: string | null;
}

export type SubmitResult =
  /** The task is on chain: `taskId` is its id, from the `task_created` event. */
  | { kind: "posted"; taskId: string }
  /**
   * The wallet sent the transactions and no `task_created` came back for this task, or it sent them
   * and could not say how they went (no hashes then). It may well be posted; the page does not
   * offer to post it again.
   */
  | { kind: "sent"; txHashes: string[] }
  /**
   * The wallet failed in a way that does not say whether it sent anything: a window that closed, a
   * connection that dropped. The task may be posted. The page keeps Post off until the person has
   * looked, and lets them post anyway.
   */
  | { kind: "unknown" };

/**
 * What the contract's panics mean to a poster. Others are shown by their code. `E_STORAGE` is rare:
 * the page tops the storage balance up in the same batch (`planPostCalls`), so it comes only if
 * the balance ran short between the read and the send, and the next press tops it up again.
 */
const PANIC_WORDS: Record<string, string> = {
  E_PAUSED: "Tender isn't taking new tasks right now.",
  E_TOKEN: "Tender isn't taking this token right now.",
  E_REWARD: "The reward is outside what Tender takes for this token.",
  E_WINDOW: "A window is outside what Tender allows.",
  E_FUNDS: "The reward wasn't in your vault.",
  E_STORAGE: "Your storage with Tender ran short as the task was posted.",
};

/** A wallet the person turned down, or a transaction that failed with no contract code. */
const WALLET_DID_NOT_FINISH =
  "The wallet didn't finish. A deposit may have gone through: check the Wallet page. Your documents are saved; press Post to try again.";

/** What a send was, for the words about it when it failed. */
interface SentPlan {
  calls: readonly TenderCall[];
  account: string;
  tokenId: string;
  reward: bigint;
}

/**
 * Where a deposit stands after the contract turned the post down. The deposit's own transaction
 * ends well even when the contract could not take it, since `ft_on_transfer` never panics and the
 * token hands the tokens back; the contract's panic comes only from the post that follows. So the
 * deposit is not assumed to have gone in: the vault is read afresh and the words say what it holds.
 */
async function depositWords(plan: SentPlan, readNow: SubmitDeps["readVault"]): Promise<string> {
  try {
    const data = await readNow(plan.account);
    const held = data.rows.find((row) => row.token === plan.tokenId)?.vault ?? 0n;
    const holds = describeAmount(held, plan.tokenId);
    return held >= plan.reward
      ? `Your deposit went through: your vault holds ${holds}.`
      : `Your vault holds ${holds} now, and a deposit Tender couldn't take went back to your wallet.`;
  } catch (error) {
    console.error(error);
    return "The deposit may have come back to your wallet: check the Wallet page.";
  }
}

/** Words for a send that failed. */
async function sendWords(
  error: unknown,
  plan: SentPlan,
  readNow: SubmitDeps["readVault"],
): Promise<string> {
  if (error instanceof TransactionFailed && error.code !== null) {
    const why = PANIC_WORDS[error.code] ?? `Tender turned the task down (${error.code}).`;
    // The plan began with a deposit only if it has a token transfer in it.
    const deposited = plan.calls.some((call) => call.methodName === "ft_transfer_call");
    const money = deposited ? await depositWords(plan, readNow) : "Nothing was posted.";
    const again =
      error.code === "E_STORAGE"
        ? "Press Post to try again: the page adds what's missing."
        : deposited
          ? "Press Post to try again."
          : "";
    return [why, money, again].filter((part) => part !== "").join(" ");
  }
  if (error instanceof WalletError || error instanceof TransactionFailed) {
    return WALLET_DID_NOT_FINISH;
  }
  return walletErrorMessage(error);
}

/** The words of what a wallet threw: an error's message, a string, or an object's `message`. */
function thrownWords(thrown: unknown): string {
  if (typeof thrown === "string") return thrown;
  if (typeof thrown === "object" && thrown !== null && "message" in thrown) {
    return typeof thrown.message === "string" ? thrown.message : "";
  }
  return "";
}

/**
 * Wallets word a refusal each their own way ("User rejected", "User cancelled the action",
 * "Transaction rejected by user"), so a refusal is a message that names the user and a refusal.
 */
const USER_REFUSAL = /(?=.*\buser\b)(?=.*(?:reject|declin|den(?:y|ied)|cancel|refus))/is;

/**
 * Whether a send that threw is known to have ended without a post: a wallet that was not connected,
 * a transaction that failed on the network, a person who turned the request down. Any other
 * failure, a wallet window that closed or a connection that dropped included, may have come after
 * the transactions were sent, so what became of the post is not known.
 */
function outcomeKnown(thrown: unknown): boolean {
  return (
    thrown instanceof WalletNotConnected ||
    thrown instanceof TransactionFailed ||
    (thrown instanceof WalletError && USER_REFUSAL.test(thrownWords(thrown.cause)))
  );
}

/** The address a blob is read at has to be a web address the chain can hold. */
function checkUpload(response: BlobUploadResponse, hash: string, expectUri: boolean): void {
  if (response.sha256 !== hash) throw new UploadMismatch();
  if (!expectUri) return;
  const bytes = new TextEncoder().encode(response.uri).length;
  if (bytes < 1 || bytes > MAX_URI_BYTES || !/^https?:\/\//.test(response.uri)) {
    throw new UploadMismatch();
  }
}

/**
 * Posts the task of `input.form`. Resolves with the id of the task, or with what was sent if the
 * task's `task_created` did not come back. Rejects with a `SubmitFailure`: its words are ready for
 * the person, and its `stage` says whether the wallet was reached.
 */
export async function submitPost(
  input: SubmitInput,
  deps: SubmitDeps,
  onStage: (stage: Stage) => void = () => {},
): Promise<SubmitResult> {
  const { form, account, tokenId, judgeAccount } = input;

  async function at<T>(stage: FailureStage, work: () => Promise<T> | T): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      if (cause instanceof SubmitFailure) throw cause;
      throw new SubmitFailure(stage, wordsFor(stage, cause), cause);
    }
  }

  function wordsFor(stage: FailureStage, cause: unknown): string {
    switch (stage) {
      case "documents":
        return cause instanceof DocumentError
          ? cause.message
          : "Check the amount, the windows and the verifier: they can't be used as they are.";
      case "signin":
        return walletErrorMessage(cause);
      case "upload":
        return cause instanceof UploadMismatch
          ? "Tender stored something other than what was sent, so nothing was posted."
          : `${errorMessage(cause)} Nothing was sent to your wallet.`;
      case "vault":
        return `${errorMessage(cause)} Nothing was sent to your wallet.`;
      case "wallet":
        return walletErrorMessage(cause);
    }
  }

  /**
   * Signs in through the wallet and gives the token it stored, read from where it is kept: the
   * string `signIn` resolves with is not used, since the keeping place is what drops a token when
   * the wallet session ends. If it is empty by then, the session has ended.
   */
  async function signedIn(): Promise<string> {
    onStage("signin");
    await at("signin", () => deps.signIn());
    onStage("upload");
    const fresh = deps.token(account);
    if (fresh === null) {
      throw new SubmitFailure("signin", walletErrorMessage(new WalletSessionEnded()));
    }
    return fresh;
  }

  /**
   * One request with the token held now, signing in first if there is none. If the API turns the
   * token away, one more after signing in again; the token is never cleared from here.
   */
  async function authed<T>(request: (token: string) => Promise<T>): Promise<T> {
    try {
      return await request(deps.token(account) ?? (await signedIn()));
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    }
    return request(await signedIn());
  }

  // 1. Everything that can be checked without the network is, before anything is sent: a reward
  // that is no amount stops here, with no sign-in asked of the wallet and nothing uploaded.
  const reward = rewardOf(form, tokenId);
  if (reward === null) {
    throw new SubmitFailure("documents", "The reward can't be used as it is. Check the amount.");
  }
  const docs: PostDocuments = await at("documents", () => buildDocuments(form));
  // The same plan, for an empty vault and no storage top-up, only to see that the form can be made
  // into calls; the real one is made at 4, from what the chain says.
  await at("documents", () =>
    planPostCalls({
      form,
      uris: { brief: `${config.apiUrl}/v1/blobs/${docs.briefHash}` },
      hashes: docs,
      vaultBalance: 0n,
      contractId: config.contractId,
      tokenId,
      judgeAccount,
    }),
  );

  // 2 and 3. Each request reads the token for itself.
  onStage("upload");
  const brief = await at("upload", async () => {
    const stored = await authed((t) =>
      deps.uploadBlob(t, { kind: "brief", contentType: "application/json", bytes: docs.brief }),
    );
    checkUpload(stored, docs.briefHash, true);
    return stored;
  });
  await at("upload", async () => {
    const stored = await authed((t) =>
      deps.uploadBlob(t, {
        kind: "criteria",
        contentType: "application/json",
        bytes: docs.criteria,
      }),
    );
    checkUpload(stored, docs.criteriaHash, false);
  });
  if (docs.heldout !== null && docs.heldoutCommitment !== null) {
    const { heldout, heldoutCommitment } = docs;
    await at("upload", () => authed((t) => deps.uploadHeldout(t, heldoutCommitment, heldout)));
  }

  // 4. What the vault holds now decides whether there is a deposit.
  onStage("vault");
  const vault = await at("vault", () => deps.readVault(account));
  const funding = fundingOf(vault, tokenId, reward);
  if (funding.problem !== null) throw new SubmitFailure("vault", funding.problem);
  const calls = planPostCalls({
    form,
    uris: { brief: brief.uri },
    hashes: docs,
    vaultBalance: funding.inVault,
    // Not null: `fundingOf` has turned an account with no storage balance away.
    storage: vault.storage ?? undefined,
    contractId: config.contractId,
    tokenId,
    judgeAccount,
  });

  // 5. The wallet signs as whoever is connected: a different account from the one the documents
  // were uploaded under would post a task that the Judge can't take the held-out checks for.
  if (deps.account() !== account) {
    throw new SubmitFailure(
      "wallet",
      "The wallet is connected as another account now, so nothing was sent. Switch back, or start again.",
    );
  }
  onStage("wallet");
  let sent: SendResult;
  try {
    sent = await deps.signAndSend(calls);
  } catch (cause) {
    // The wallet sent the transactions and could not say how they went, so the task may well be
    // posted, and a second press would deposit and post it again. It counts as sent, with nothing
    // to show for it: the page keeps Post off and tells the person to look.
    if (cause instanceof WalletResultUnreadable && cause.what === "transaction") {
      return { kind: "sent", txHashes: [] };
    }
    // A failure that does not say whether anything was sent is the same risk, from a wallet that
    // threw and not one that answered: the page keeps Post off, and the person decides.
    if (!outcomeKnown(cause)) {
      console.error(cause);
      return { kind: "unknown" };
    }
    throw new SubmitFailure(
      "wallet",
      await sendWords(cause, { calls, account, tokenId, reward }, deps.readVault),
      cause,
    );
  }

  const created = sent.events.find(
    (event) =>
      event.event === "task_created" &&
      event.data.poster === account &&
      event.data.brief_hash === docs.briefHash &&
      event.data.criteria_hash === docs.criteriaHash,
  );
  return created?.event === "task_created"
    ? { kind: "posted", taskId: created.data.id }
    : { kind: "sent", txHashes: sent.txHashes };
}
