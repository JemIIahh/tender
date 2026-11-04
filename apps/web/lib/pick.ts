import {
  ApiError,
  type BlobUpload,
  type BlobUploadResponse,
  checkPickOnTask,
  checkPickScorecard,
  checkPickShares,
  handPickedScorecard,
  MAX_URI_BYTES,
  PickRefusal,
  type PickWinner,
  pickCall,
  type Scorecard,
  scorecardUpload,
  type TaskDetailResponse,
  type TenderCall,
} from "@tender/shared";
import { pickView } from "./actions";
import { outcomeUnknown, refusalWords, sendWords } from "./actionWords";
import { config } from "./config";
import { errorMessage } from "./errors";
import type { SendResult } from "./wallet";
import { WalletSessionEnded, walletErrorMessage } from "./walletErrors";

// A pick from the task page, made by a person: the verifier in its window, or the poster in the
// fallback window after it. It is the MCP tool `pick_winners` with a person in place of an agent:
// the scorecard is written from the person's choice (`handPickedScorecard`), checked by the same
// rules (`checkPickScorecard`, `checkPickShares`, `checkPickOnTask`), uploaded as the same bytes
// (`scorecardUpload`) and picked with by one wallet approval. All of these are @tender/shared's.
//
// In order:
//   1. the task is read again from the API: the pick rests on the entries and hashes it lists now,
//      and the window is looked at again;
//   2. the scorecard is written and every check is made, before anything leaves the page;
//   3. a sign-in to the API if there is no token for the account, and the scorecard's upload. The
//      API holds a scorecard to the account that uploads it, which is the one that picks;
//   4. one `signAndSend` of `pick`.
//
// From 3 on the scorecard is public. A pick that fails after it leaves the scorecard where it is,
// and pays nobody: the words say so.

export type PickStage = "check" | "signin" | "upload" | "wallet";

/** A pick that did not happen, in words for the person. `published`: the scorecard went up. */
export class PickFailure extends Error {
  readonly stage: PickStage;
  readonly published: boolean;

  constructor(stage: PickStage, words: string, published: boolean, cause?: unknown) {
    super(words, { cause });
    this.name = "PickFailure";
    this.stage = stage;
    this.published = published;
  }
}

export type PickResult =
  /** The pick landed: the task is `picked`, or `voided` by a pick of nobody. */
  | { kind: "picked" | "voided"; txHash: string | null; scorecardHash: string }
  /** The wallet sent it and did not say how it went, or failed in a way that does not tell. */
  | { kind: "unknown"; scorecardHash: string };

export interface PickDeps {
  /** The account the wallet is connected as now, or null. Read afresh. */
  account(): string | null;
  /** The API token held for `account` now, or null. Read afresh for each request. */
  token(account: string): string | null;
  signIn(): Promise<unknown>;
  getTask(id: string): Promise<TaskDetailResponse | null>;
  uploadBlob(token: string, blob: BlobUpload): Promise<BlobUploadResponse>;
  signAndSend(calls: readonly TenderCall[]): Promise<SendResult>;
  /** The time now, in nanoseconds, for the window. */
  nowNs(): bigint;
}

export interface PickInput {
  taskId: string;
  /** The account that picks: the one connected when Pick was pressed. */
  account: string;
  judgeAccount: string | null;
  /** The winners, in the order the dust goes: the first gets it. Empty picks nobody. */
  winners: readonly PickWinner[];
  /** The reason given for an entry, by account. */
  reasons: Readonly<Record<string, string>>;
  /**
   * When the scorecard is written. A try again of the same pick keeps the time of the first, so
   * that the same scorecard goes up and not a second one.
   */
  writtenAt: Date;
}

/** The scorecard of `input` on `detail`, or a `PickFailure` that says why it cannot be written. */
export function scorecardOf(input: PickInput, detail: TaskDetailResponse): Scorecard {
  const { criteria, task } = detail;
  if (criteria === null) {
    throw new PickFailure(
      "check",
      "Tender's API doesn't serve this task's criteria, so the page can't write its scorecard. Nothing was published or sent.",
      false,
    );
  }
  try {
    return handPickedScorecard({
      taskId: task.id,
      picker: input.account,
      kind: criteria.kind,
      minScore: criteria.min_score,
      criteriaHash: task.criteria_hash,
      heldoutCommitment: task.heldout_commitment,
      entries: detail.entries,
      winners: input.winners,
      reasons: input.reasons,
      now: input.writtenAt,
    });
  } catch (cause) {
    throw new PickFailure(
      "check",
      cause instanceof RangeError
        ? "A reason is at most 200 characters."
        : "The page couldn't write the scorecard. Nothing was published or sent.",
      false,
      cause,
    );
  }
}

/** The address a scorecard is served at has to be one the chain takes, and a web address. */
function usableUri(uri: string): boolean {
  const bytes = new TextEncoder().encode(uri).length;
  return bytes >= 1 && bytes <= MAX_URI_BYTES && /^https?:\/\//.test(uri);
}

/**
 * Picks `input.winners` on task `input.taskId`. Resolves with how the task was settled, or with
 * "unknown" if the wallet could not say. Rejects with a `PickFailure`, in words for the person.
 */
export async function submitPick(
  input: PickInput,
  deps: PickDeps,
  onStage: (stage: PickStage) => void = () => {},
): Promise<PickResult> {
  const { taskId, account, winners } = input;

  // 1. The task as the API lists it now.
  onStage("check");
  let detail: TaskDetailResponse | null;
  try {
    detail = await deps.getTask(taskId);
  } catch (cause) {
    throw new PickFailure(
      "check",
      `${errorMessage(cause)} Nothing was published or sent.`,
      false,
      cause,
    );
  }

  // 2. The scorecard, and every check, before anything leaves the page.
  let card: Scorecard;
  try {
    if (detail === null) throw new PickRefusal("NO_TASK", `the API has no task ${taskId}`);
    const view = pickView(detail.task, account, input.judgeAccount, deps.nowNs());
    if (view?.kind !== "pick") {
      throw new PickFailure(
        "check",
        "The pick window isn't open for this account now. Nothing was published or sent.",
        false,
      );
    }
    card = scorecardOf(input, detail);
    checkPickScorecard(card, {
      taskId,
      picker: account,
      judgeAccount: input.judgeAccount,
      winners,
    });
    checkPickShares(winners);
    checkPickOnTask(detail, { taskId, winners, card });
  } catch (cause) {
    if (cause instanceof PickFailure) throw cause;
    if (cause instanceof PickRefusal) {
      throw new PickFailure("check", refusalWords(cause), false, cause);
    }
    throw cause;
  }
  const upload = scorecardUpload(card);

  // 3. The upload, with the token held now, or one a sign-in gives; once more after a 401.
  async function signedIn(): Promise<string> {
    onStage("signin");
    try {
      await deps.signIn();
    } catch (cause) {
      throw new PickFailure("signin", walletErrorMessage(cause), false, cause);
    }
    onStage("upload");
    const fresh = deps.token(account);
    if (fresh === null) {
      throw new PickFailure("signin", walletErrorMessage(new WalletSessionEnded()), false);
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
  onStage("upload");
  let stored: BlobUploadResponse;
  try {
    stored = await authed((token) => deps.uploadBlob(token, upload));
  } catch (cause) {
    if (cause instanceof PickFailure) throw cause;
    throw new PickFailure(
      "upload",
      `${errorMessage(cause)} Nothing was published or sent.`,
      false,
      cause,
    );
  }
  if (stored.sha256 !== upload.hash || !usableUri(stored.uri)) {
    throw new PickFailure(
      "upload",
      "Tender stored something other than the scorecard, so nothing was sent.",
      false,
    );
  }

  // 4. One approval, by the account the scorecard names.
  if (deps.account() !== account) {
    throw new PickFailure(
      "wallet",
      "The wallet was disconnected or changed, so nothing was sent. The scorecard is published; this pick paid nobody.",
      true,
    );
  }
  onStage("wallet");
  let sent: SendResult;
  try {
    sent = await deps.signAndSend([
      pickCall(config.contractId, BigInt(taskId), winners, upload.hash, stored.uri),
    ]);
  } catch (cause) {
    if (outcomeUnknown(cause)) {
      console.error(cause);
      return { kind: "unknown", scorecardHash: upload.hash };
    }
    throw new PickFailure(
      "wallet",
      `${sendWords("pick", cause)} The scorecard is published; this pick paid nobody.`,
      true,
      cause,
    );
  }
  const settled = sent.events.find(
    (event) =>
      (event.event === "picked" || event.event === "voided") && event.data.task_id === taskId,
  );
  if (settled === undefined) return { kind: "unknown", scorecardHash: upload.hash };
  return {
    kind: settled.event === "voided" ? "voided" : "picked",
    txHash: sent.txHashes[0] ?? null,
    scorecardHash: upload.hash,
  };
}
