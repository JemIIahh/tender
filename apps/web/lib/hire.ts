import {
  ApiError,
  type BlobUpload,
  type BlobUploadResponse,
  depositCall,
  HIRE_TASK_BYTES,
  hireCriteriaHash,
  hireDocuments,
  hireTerms,
  JUDGE_TEAM_ONLY_KINDS,
  MAX_URI_BYTES,
  postTaskCall,
  type Service,
  type ServiceResponse,
  storageDepositCall,
  storageShortfall,
  type TenderCall,
} from "@tender/shared";
import { config } from "./config";
import { errorMessage } from "./errors";
import { fundingOf, VAULT_SLOT_BYTES } from "./post";
import type { StorageBalance, VaultData } from "./vault";
import type { SendResult } from "./wallet";
import {
  TransactionFailed,
  WalletError,
  WalletNotConnected,
  WalletResultUnreadable,
  WalletSessionEnded,
  walletErrorMessage,
} from "./walletErrors";

// Hiring an agent for a service, from its page: the request is written, the brief and the criteria
// are uploaded, and one wallet approval sends the batch that posts the hire, a pinned task that
// invites the agent alone, at the listed price. The documents and the terms are the shared ones
// (`hireDocuments`, `hireTerms` in @tender/shared), the same that `hire_agent` makes, so a hire from
// the page and one from an agent are the same task.
//
// In order:
//   1. the documents and the terms are made, before anything leaves the page;
//   1b. the service is read again from the API: a provider can change its price, its terms or its
//      status after the page loaded it, and a hire is posted only on the terms the API holds now,
//      which are the ones the agent takes (its runner refuses a hire that does not match them);
//   2. a sign-in to the API, if there is no token for the account, and the two uploads;
//   3. the vault and the storage balance are read afresh, and the calls planned from them: a deposit
//      of what the vault lacks, a storage top-up if the hire's task record needs one, and the post.
//      If the fresh read asks for more than the page showed, nothing is sent;
//   4. one `signAndSend`.
//
// A send whose outcome the wallet cannot tell is "unknown": the hire may be posted, and the page
// does not offer to send it again.

/** Where a hire stopped, for the words about it. */
export type HireStage = "documents" | "check" | "signin" | "upload" | "vault" | "wallet";

/**
 * A hire that did not happen, in words for the person. Before `wallet`, nothing was sent. `fresh`
 * is the service as the API holds it now, when the hire stopped because it changed (or null, when it
 * is gone): the page shows it in place of the one it had.
 */
export class HireFailure extends Error {
  readonly stage: HireStage;
  readonly fresh: Service | null | undefined;

  constructor(stage: HireStage, words: string, cause?: unknown, fresh?: Service | null) {
    super(words, { cause });
    this.name = "HireFailure";
    this.stage = stage;
    this.fresh = fresh;
  }
}

/** What a hire says when the service changed after the page loaded it. */
export const SERVICE_CHANGED =
  "The provider changed this service. Check the new terms and press Hire again.";

/**
 * Whether `now` differs from `shown` in anything a hire is made of or depends on: the price, the
 * token, the windows, how the work is checked (the kind, the criteria hash, the Judge), whether it
 * can be hired, and its status.
 */
export function termsChanged(shown: Service, now: Service): boolean {
  const judgeOf = (service: Service) =>
    service.verification.kind === "judge" ? service.verification.judge : null;
  return (
    shown.payment_mode !== now.payment_mode ||
    JSON.stringify(shown.x402) !== JSON.stringify(now.x402) ||
    shown.price !== now.price ||
    shown.token !== now.token ||
    shown.commit_secs !== now.commit_secs ||
    shown.reveal_secs !== now.reveal_secs ||
    shown.pick_secs !== now.pick_secs ||
    shown.verification.kind !== now.verification.kind ||
    hireCriteriaHash(shown) !== hireCriteriaHash(now) ||
    judgeOf(shown) !== judgeOf(now) ||
    shown.available !== now.available ||
    shown.status !== now.status
  );
}

export type HireResult =
  | { kind: "posted"; taskId: string }
  | { kind: "sent"; txHashes: string[] }
  | { kind: "unknown" };

/** What a hire needs from the world. The page gives the real ones; a test gives its own. */
export interface HireDeps {
  account(): string | null;
  token(account: string): string | null;
  signIn(): Promise<unknown>;
  uploadBlob(token: string, blob: BlobUpload): Promise<BlobUploadResponse>;
  /** The service as the API holds it now; null if there is none. */
  getService(id: string): Promise<ServiceResponse | null>;
  readVault(account: string): Promise<VaultData>;
  signAndSend(calls: readonly TenderCall[]): Promise<SendResult>;
}

/** What to show before the approval, and what the send may not exceed. */
export interface HirePlan {
  /** What the vault holds of the token now. */
  inVault: bigint;
  /** What is deposited from the wallet first: nothing if the vault holds the price. */
  toDeposit: bigint;
  /** The NEAR, in yoctoNEAR, added to the storage balance first; 0 if it holds enough. */
  storageTopUp: bigint;
  /** Why the hire can't be made now, in words, or null. */
  problem: string | null;
}

/**
 * The NEAR a `storage_deposit` adds so that `storage` pays for a hire's task record, and for the
 * vault slot of the token when the deposit opens one (`HIRE_TASK_BYTES`, `VAULT_SLOT_BYTES`).
 */
export function hireStorageTopUp(storage: StorageBalance | null, opensSlot: boolean): bigint {
  const bytes = opensSlot ? HIRE_TASK_BYTES + VAULT_SLOT_BYTES : HIRE_TASK_BYTES;
  if (storage === null) return storageShortfall(null, bytes);
  return storageShortfall(
    { total: storage.total.toString(), available: storage.available.toString(), used_bytes: "0" },
    bytes,
  );
}

/** Where the price comes from, given what the account holds. */
export function hirePlan(data: VaultData, service: Pick<Service, "token" | "price">): HirePlan {
  const price = BigInt(service.price);
  const funding = fundingOf(data, service.token, price);
  return {
    inVault: funding.inVault,
    toDeposit: funding.toDeposit,
    storageTopUp: hireStorageTopUp(data.storage, funding.inVault === 0n),
    problem: funding.problem,
  };
}

/**
 * Why `account` cannot hire `service` from this page, in words, or null. The contract refuses a
 * poster that invites itself, and the page can name the Judge only if it was built with its account.
 */
export function hireBlocker(
  service: Pick<Service, "available" | "status" | "agent" | "verification" | "payment_mode">,
  account: string | null,
  judgeAccount: string | null = config.judgeAccount,
): string | null {
  if (service.payment_mode === "x402")
    return "Agents buy this API through Tender's MCP server, with the purchase_service tool. It is not an escrow hire.";
  if (!service.available) {
    if (service.status === "paused") {
      return "The provider has paused this service. It can't be hired now.";
    }
    if (service.verification.kind === "judge" && service.verification.judge === null) {
      return "The Tender Judge checks this service, and the Tender API has no Judge set up, so it can't be hired now.";
    }
    return "The agent of this service can't take work now: it isn't an active agent with a bond.";
  }
  if (account !== null && account === service.agent) {
    return "This service is offered by the account you're signed in as, and an account can't hire itself.";
  }
  if (service.verification.kind === "judge" && judgeAccount === null) {
    return "The Tender Judge checks this service, and this site isn't set up with the Judge's account.";
  }
  return null;
}

/** The note for a Judge-checked service of a kind the Judge takes from the team's posters only. */
export function teamOnlyNote(service: Pick<Service, "verification">): string | null {
  const { verification } = service;
  if (verification.kind !== "judge" || !JUDGE_TEAM_ONLY_KINDS.has(verification.criteria.kind)) {
    return null;
  }
  return "For now the Judge checks this kind of work only for tasks the Tender team posts. Posted by anyone else, the Judge turns the hire away: you can pick the delivery yourself after the pick deadline, or the task voids and the price comes back to you.";
}

/** What the contract's refusals mean to a hirer. Others are shown by their code. */
const PANIC_WORDS: Record<string, string> = {
  E_PAUSED: "Tender isn't taking new tasks right now.",
  E_TOKEN: "Tender isn't taking this token right now.",
  E_REWARD: "The price is outside what Tender takes for this token.",
  E_WINDOW: "A window of this service is outside what Tender allows.",
  E_FUNDS: "The price wasn't in your vault.",
  E_INVITE: "Tender won't let this account invite this agent.",
  E_STORAGE: "Your storage with Tender ran short as the hire was posted.",
};

/** Wallets word a refusal each their own way; a refusal names the user and a refusal. */
const USER_REFUSAL = /(?=.*\buser\b)(?=.*(?:reject|declin|den(?:y|ied)|cancel|refus))/is;

function thrownWords(thrown: unknown): string {
  if (typeof thrown === "string") return thrown;
  if (typeof thrown === "object" && thrown !== null && "message" in thrown) {
    return typeof thrown.message === "string" ? thrown.message : "";
  }
  return "";
}

/** Whether a send that threw is known to have ended without a post. */
function outcomeKnown(thrown: unknown): boolean {
  return (
    thrown instanceof WalletNotConnected ||
    thrown instanceof TransactionFailed ||
    (thrown instanceof WalletError && USER_REFUSAL.test(thrownWords(thrown.cause)))
  );
}

/** The API stored something other than what was sent, or at an address the chain can't use. */
function checkUpload(response: BlobUploadResponse, hash: string, expectUri: boolean): void {
  const words = "Tender stored something other than what was sent, so nothing was hired.";
  if (response.sha256 !== hash) throw new HireFailure("upload", words);
  if (!expectUri) return;
  const bytes = new TextEncoder().encode(response.uri).length;
  if (bytes < 1 || bytes > MAX_URI_BYTES || !/^https?:\/\//.test(response.uri)) {
    throw new HireFailure("upload", words);
  }
}

export interface HireInput {
  /** The service as the page shows it. */
  service: Service;
  request: string;
  /** The account that hires: the one connected when Hire was pressed. */
  account: string;
  judgeAccount: string | null;
  /** What the page showed would be sent. A fresh read that asks for more stops the hire. */
  shown?: { toDeposit: bigint; storageTopUp: bigint };
}

/**
 * Hires `input.service` for `input.request`. Resolves with the new task's id, or with what was sent
 * if its `task_created` did not come back. Rejects with a `HireFailure`, in words for the person.
 */
export async function submitHire(
  input: HireInput,
  deps: HireDeps,
  onStage: (stage: HireStage) => void = () => {},
): Promise<HireResult> {
  const { service, account } = input;

  async function at<T>(stage: HireStage, work: () => Promise<T> | T): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      if (cause instanceof HireFailure) throw cause;
      const words =
        stage === "signin" || stage === "wallet"
          ? walletErrorMessage(cause)
          : `${errorMessage(cause)} Nothing was sent to your wallet.`;
      throw new HireFailure(stage, words, cause);
    }
  }

  // 1. Everything that can be checked without the network.
  if (account === service.agent) {
    throw new HireFailure("documents", "An account can't hire its own agent account.");
  }
  const documents = await at("documents", () => {
    try {
      return hireDocuments(service, input.request);
    } catch (cause) {
      throw new HireFailure(
        "documents",
        "The request can't be sent as it is: plain text, up to 4,000 characters.",
        cause,
      );
    }
  });
  const terms = await at("documents", () => {
    try {
      return hireTerms(service, input.judgeAccount);
    } catch (cause) {
      throw new HireFailure(
        "documents",
        "This site isn't set up with the Tender Judge's account, which checks this service.",
        cause,
      );
    }
  });

  // 1b. The terms the API holds now, before anything is uploaded or signed.
  onStage("check");
  const now = await at("check", () => deps.getService(service.id));
  if (now === null || termsChanged(service, now.service)) {
    throw new HireFailure("check", SERVICE_CHANGED, undefined, now?.service ?? null);
  }

  async function signedIn(): Promise<string> {
    onStage("signin");
    await at("signin", () => deps.signIn());
    onStage("upload");
    const fresh = deps.token(account);
    if (fresh === null) {
      throw new HireFailure("signin", walletErrorMessage(new WalletSessionEnded()));
    }
    return fresh;
  }

  async function authed<T>(request: (token: string) => Promise<T>): Promise<T> {
    try {
      return await request(deps.token(account) ?? (await signedIn()));
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    }
    return request(await signedIn());
  }

  // 2. The two documents.
  onStage("upload");
  const brief = await at("upload", async () => {
    const stored = await authed((t) =>
      deps.uploadBlob(t, {
        kind: "brief",
        contentType: "application/json",
        bytes: documents.briefBytes,
      }),
    );
    checkUpload(stored, documents.briefHash, true);
    return stored;
  });
  await at("upload", async () => {
    const stored = await authed((t) =>
      deps.uploadBlob(t, {
        kind: "criteria",
        contentType: "application/json",
        bytes: documents.criteriaBytes,
      }),
    );
    checkUpload(stored, documents.criteriaHash, false);
  });

  // 3. What the vault and the storage hold now.
  onStage("vault");
  const data = await at("vault", () => deps.readVault(account));
  const plan = hirePlan(data, service);
  if (plan.problem !== null) throw new HireFailure("vault", plan.problem);
  const { shown } = input;
  if (
    shown !== undefined &&
    (plan.toDeposit > shown.toDeposit || plan.storageTopUp > shown.storageTopUp)
  ) {
    throw new HireFailure(
      "vault",
      "Your balances changed. Check the amounts and press Hire again.",
    );
  }
  const contractId = config.contractId;
  const calls: TenderCall[] = [
    ...(plan.storageTopUp > 0n ? [storageDepositCall(contractId, plan.storageTopUp)] : []),
    ...(plan.toDeposit > 0n ? [depositCall(terms.token, contractId, plan.toDeposit)] : []),
    postTaskCall(contractId, {
      token: terms.token,
      reward: terms.reward,
      briefUri: brief.uri,
      briefHash: documents.briefHash,
      criteriaHash: documents.criteriaHash,
      ...(terms.verifier !== undefined && { verifier: terms.verifier }),
      commitSecs: terms.commitSecs,
      revealSecs: terms.revealSecs,
      pickSecs: terms.pickSecs,
      fallbackSecs: terms.fallbackSecs,
      maxEntries: terms.maxEntries,
      maxWinners: terms.maxWinners,
      invited: terms.invited,
    }),
  ];

  // 4. One approval, by the account the documents were uploaded under.
  if (deps.account() !== account) {
    throw new HireFailure("wallet", "The wallet was disconnected or changed, so nothing was sent.");
  }
  onStage("wallet");
  let sent: SendResult;
  try {
    sent = await deps.signAndSend(calls);
  } catch (cause) {
    if (cause instanceof WalletResultUnreadable && cause.what === "transaction") {
      return { kind: "sent", txHashes: [] };
    }
    if (!outcomeKnown(cause)) {
      console.error(cause);
      return { kind: "unknown" };
    }
    if (cause instanceof TransactionFailed && cause.code !== null) {
      const why = PANIC_WORDS[cause.code] ?? `Tender turned the hire down (${cause.code}).`;
      const money =
        plan.toDeposit > 0n
          ? "A deposit may have gone into your vault, or back to your wallet: check the Wallet page."
          : "Nothing was hired.";
      throw new HireFailure("wallet", `${why} ${money}`, cause);
    }
    throw new HireFailure(
      "wallet",
      cause instanceof WalletError || cause instanceof TransactionFailed
        ? "The wallet didn't finish. Nothing was hired; press Hire to try again."
        : walletErrorMessage(cause),
      cause,
    );
  }
  const created = sent.events.find(
    (event) =>
      event.event === "task_created" &&
      event.data.poster === account &&
      event.data.brief_hash === documents.briefHash,
  );
  return created?.event === "task_created"
    ? { kind: "posted", taskId: created.data.id }
    : { kind: "sent", txHashes: sent.txHashes };
}
