import { type TenderCall, voidTaskCall } from "@tender/shared";
import { outcomeUnknown, sendWords } from "./actionWords";
import { config } from "./config";
import type { SendResult } from "./wallet";

// "Refund the funders" on the task page: `void_task`, which anyone may send once the task's reveal
// window is over with nothing revealed, or its fallback window is over (lib/actions.ts
// `canRefund`). It gives each funder back exactly what it paid in. One wallet approval, and no
// sign-in: nothing goes to the API.

export type RefundResult =
  /** The task is voided: `refunds` is what each funder got back, from the `voided` event. */
  | { kind: "voided"; refunds: Array<{ account: string; amount: string }> }
  /** The wallet sent it and did not say how it went, or failed in a way that does not tell. */
  | { kind: "unknown" };

/** A refund that did not happen, in words for the person. Nothing changed on chain. */
export class RefundFailure extends Error {
  constructor(words: string, cause?: unknown) {
    super(words, { cause });
    this.name = "RefundFailure";
  }
}

export interface RefundDeps {
  /** The account the wallet is connected as now, or null. */
  account(): string | null;
  signAndSend(calls: readonly TenderCall[]): Promise<SendResult>;
}

/** Sends `void_task` for `taskId`, as `account`. */
export async function submitRefund(
  input: { taskId: string; account: string },
  deps: RefundDeps,
): Promise<RefundResult> {
  if (deps.account() !== input.account) {
    throw new RefundFailure("The wallet was disconnected or changed, so nothing was sent.");
  }
  let sent: SendResult;
  try {
    sent = await deps.signAndSend([voidTaskCall(config.contractId, BigInt(input.taskId))]);
  } catch (cause) {
    if (outcomeUnknown(cause)) {
      console.error(cause);
      return { kind: "unknown" };
    }
    throw new RefundFailure(sendWords("refund", cause), cause);
  }
  for (const event of sent.events) {
    if (event.event === "voided" && event.data.task_id === input.taskId) {
      return { kind: "voided", refunds: event.data.refunds };
    }
  }
  return { kind: "unknown" };
}
