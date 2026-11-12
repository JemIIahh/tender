import { PickRefusal } from "@tender/shared";
import { expect, test } from "vitest";
import { contractWords, outcomeUnknown, refusalWords, sendWords } from "../lib/actionWords";
import {
  TransactionFailed,
  WalletError,
  WalletNotConnected,
  WalletResultUnreadable,
} from "../lib/walletErrors";

// The words for an action that did not go through: the contract's code (`TransactionFailed.code`,
// the code the client's `TenderError` carries) by action, the shared checks' refusals, and the
// wallet's own failures.

test("each_action_says_the_contracts_refusals_in_its_own_words", () => {
  expect(contractWords("pick", "E_AUTH")).toBe(
    "Tender refused the pick from this key. A delegate key can spend within its caps but can never pick: sign with another key of this account, such as its full-access key.",
  );
  expect(contractWords("pick", "E_SETTLED")).toBe(
    "This task is settled already: someone picked or refunded it first.",
  );
  expect(contractWords("refund", "E_SETTLED")).toBe(
    "This task is settled already: someone refunded or picked it first.",
  );
  expect(contractWords("refund", "E_PHASE")).toBe("This task can't be refunded yet.");
  expect(contractWords("topUp", "E_STORAGE")).toBe(
    "Your storage with Tender can't hold your funder record. Add storage on the Wallet page.",
  );
  // A code with no words of its own is named.
  expect(contractWords("pick", "E_NEW")).toBe("Tender refused the pick (E_NEW).");
  expect(contractWords("refund", "E_NEW")).toBe("Tender refused the refund (E_NEW).");
  expect(contractWords("topUp", "E_NEW")).toBe("Tender refused the top-up (E_NEW).");
});

test("the_shared_checks_refusals_are_said_as_nothing_published", () => {
  expect(refusalWords(new PickRefusal("NO_TASK", "x"))).toBe(
    "Tender's API doesn't have this task right now. Nothing was published or sent.",
  );
  expect(
    refusalWords(new PickRefusal("INVALID_WINNERS", "a.testnet is named more than once")),
  ).toBe("Nothing was published or sent: a.testnet is named more than once.");
  expect(refusalWords(new PickRefusal("SCORECARD_MISMATCH", "x"))).toBe(
    "The scorecard didn't match this task, so nothing was published or sent.",
  );
});

test("a_failure_that_does_not_tell_whether_it_was_sent_is_unknown", () => {
  expect(outcomeUnknown(new WalletResultUnreadable("transaction"))).toBe(true);
  expect(outcomeUnknown(new WalletError("send", new Error("the window closed")))).toBe(true);
  expect(outcomeUnknown(new WalletError("send", new Error("User rejected the request")))).toBe(
    false,
  );
  expect(outcomeUnknown(new TransactionFailed("TX", "E_PHASE"))).toBe(false);
  expect(outcomeUnknown(new WalletNotConnected())).toBe(false);

  expect(sendWords("refund", new TransactionFailed("TX", "E_PHASE"))).toBe(
    "This task can't be refunded yet.",
  );
  expect(sendWords("refund", new WalletNotConnected())).toBe("Sign in first.");
});
