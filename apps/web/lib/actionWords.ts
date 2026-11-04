import { PickRefusal } from "@tender/shared";
import { outcomeKnown } from "./postSubmit";
import {
  TransactionFailed,
  WalletError,
  WalletResultUnreadable,
  walletErrorMessage,
} from "./walletErrors";

// What a person is told when a pick, a refund or a top-up from the task page does not go through.
// The contract says why in a code (`E_PHASE: ...`), which the wallet's failure carries
// (`TransactionFailed.code`, the same code the client's `TenderError.code` names), and each action
// has its own words for the codes it can meet. A code without words is named as it is.

export type Action = "pick" | "refund" | "topUp";

/** The contract's refusals, in words, by action. */
const CONTRACT_WORDS: Record<Action, Record<string, string>> = {
  pick: {
    E_SETTLED: "This task is settled already: someone picked or refunded it first.",
    E_PHASE:
      "The pick window isn't open for this account now. The verifier picks until the pick deadline, and the poster after it until the fallback deadline.",
    E_AUTH:
      "Tender refused the pick from this key. A delegate key can spend within its caps but can never pick: sign with another key of this account, such as its full-access key.",
    E_WINNERS:
      "Tender refused the winners: each must have revealed an entry, and the shares must add up to 100%.",
    E_URI: "Tender refused the scorecard's address.",
    E_HASH: "Tender refused the scorecard's hash.",
    E_NOT_FOUND: "Tender has no such task.",
  },
  refund: {
    E_SETTLED: "This task is settled already: someone refunded or picked it first.",
    E_PHASE: "This task can't be refunded yet.",
    E_NOT_FOUND: "Tender has no such task.",
  },
  topUp: {
    E_PAUSED: "Tender isn't taking top-ups right now.",
    E_PHASE: "This task stopped taking top-ups: its commit window has closed.",
    E_SETTLED: "This task is settled already.",
    E_LIMIT: "This task has 50 funders, the most it can have.",
    E_TOKEN: "Tender isn't taking this token right now.",
    E_REWARD: "That amount is outside what Tender takes for this token and task.",
    E_AUTH: "Tender refused the top-up from this key.",
    E_FUNDS: "Your vault doesn't hold that much.",
    E_STORAGE:
      "Your storage with Tender can't hold your funder record. Add storage on the Wallet page.",
    E_NOT_FOUND: "Tender has no such task.",
  },
};

/** What an action is called in a sentence. */
const NAMES: Record<Action, string> = { pick: "pick", refund: "refund", topUp: "top-up" };

/** The words for the contract's refusal `code` of `action`. */
export function contractWords(action: Action, code: string): string {
  return CONTRACT_WORDS[action][code] ?? `Tender refused the ${NAMES[action]} (${code}).`;
}

/**
 * The words for a pick that the shared checks refused before anything was published
 * (`PickRefusal` of @tender/shared). The page writes the scorecard itself, so of these only the
 * winners' rules and a missing task can come from what the person or the index did; the rest would
 * be a fault of the page's, and say so plainly.
 */
export function refusalWords(refusal: PickRefusal): string {
  switch (refusal.code) {
    case "NO_TASK":
      return "Tender's API doesn't have this task right now. Nothing was published or sent.";
    case "INVALID_WINNERS":
      return `Nothing was published or sent: ${refusal.message}.`;
    case "SCORECARD_MISMATCH":
      return "The scorecard didn't match this task, so nothing was published or sent.";
  }
}

/**
 * Whether a send that threw may have gone through all the same: the wallet sent it and could not
 * say how it went, or it failed in a way that does not say whether it was sent at all.
 */
export function outcomeUnknown(thrown: unknown): boolean {
  if (thrown instanceof WalletResultUnreadable && thrown.what === "transaction") return true;
  return !outcomeKnown(thrown);
}

/**
 * Words for a send of `action` that failed, and is known to have failed: the contract's refusal
 * by its code, a wallet that was turned down or did not finish, or anything else a wallet can
 * throw. Whatever is said, nothing was sent for good: a refusal changes nothing on chain.
 */
export function sendWords(action: Action, thrown: unknown): string {
  if (thrown instanceof TransactionFailed && thrown.code !== null) {
    return contractWords(action, thrown.code);
  }
  if (thrown instanceof WalletError || thrown instanceof TransactionFailed) {
    return "The wallet didn't finish, and nothing changed on chain. Try again when you're ready.";
  }
  if (thrown instanceof PickRefusal) return refusalWords(thrown);
  return walletErrorMessage(thrown);
}
