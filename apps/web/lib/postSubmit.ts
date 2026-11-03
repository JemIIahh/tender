import {
  ApiError,
  type BlobUpload,
  type BlobUploadResponse,
  MAX_URI_BYTES,
  type TenderCall,
} from "@tender/shared";
import { api } from "./api";
import { heldToken } from "./apiToken";
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
import { readVault, type VaultData } from "./vault";
import type { SendResult } from "./wallet";
import {
  TransactionFailed,
  WalletError,
  WalletResultUnreadable,
  WalletSessionEnded,
  walletErrorMessage,
} from "./walletErrors";

// Posting a task, in the order that keeps the money and the held-out checks safe:
//
//   1. the documents are built and every number is checked, before anything leaves the page;
//   2. a sign-in to the API, if there is no token for the account;
//   3. the brief, the criteria and the held-out checks are uploaded, each to its own place;
//   4. the vault is read afresh, and the calls are planned from what it holds;
//   5. one `signAndSend`: the deposit that tops the vault up, if it is short, and `post_task`.
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
 * account and not out of date. The same rule as `useApiToken`, read now and not at a render.
 */
export function liveToken(account: string): string | null {
  const held = heldToken();
  return held !== null && held.accountId === account && held.expiresAtMs > Date.now()
    ? held.token
    : null;
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
   * The wallet sent the transactions and no `task_created` came back for this task. It may well be
   * posted; the page does not offer to post it again.
   */
  | { kind: "sent"; txHashes: string[] };

/** What the contract's panics mean to a poster. Others are shown by their code. */
const PANIC_WORDS: Record<string, string> = {
  E_PAUSED: "Tender isn't taking new tasks right now.",
  E_TOKEN: "Tender isn't taking this token right now.",
  E_REWARD: "The reward is outside what Tender takes for this token.",
  E_WINDOW: "A window is outside what Tender allows.",
  E_FUNDS: "Your vault doesn't hold the reward.",
  E_STORAGE: "Your storage with Tender can't hold this task. Add storage on the Wallet page.",
};

/** Words for a send that failed. `deposited`: the plan began with a deposit. */
function sendWords(error: unknown, deposited: boolean): string {
  if (error instanceof TransactionFailed && error.code !== null) {
    // The contract's own panic comes from `post_task`, which runs after the deposit.
    const why = PANIC_WORDS[error.code] ?? `Tender turned the task down (${error.code}).`;
    return deposited
      ? `${why} Your deposit went through, so the funds are in your vault. Fix this and press Post again.`
      : `${why} Nothing was posted.`;
  }
  if (error instanceof WalletError || error instanceof TransactionFailed) {
    return "The wallet didn't finish. Nothing may have been posted: check your vault on the Wallet page, because a deposit may have gone through. Your documents are saved with Tender, so you can press Post again.";
  }
  if (error instanceof WalletResultUnreadable) {
    return "The wallet sent the transaction but didn't say how it went. Look for your task on the Tasks page before you post it again.";
  }
  return walletErrorMessage(error);
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
  const sent = await at("wallet", async () => {
    try {
      return await deps.signAndSend(calls);
    } catch (cause) {
      throw new SubmitFailure("wallet", sendWords(cause, calls.length > 1), cause);
    }
  });

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
