// Browser-safe: the web app imports this module as `@tender/client/outcome`, so it loads nothing
// at run time. Its one import is a type.
import type { ReceiptOutcome } from "@tender/shared";

/**
 * The part of a transaction's outcome that `receiptsFromTx` reads. The RPC's `tx` and
 * `EXPERIMENTAL_tx_status` responses have it, as near-api-js and the wallet connectors return
 * them.
 */
export interface TxReceiptsOutcome {
  receipts_outcome: ReadonlyArray<{
    id: string;
    outcome: { executor_id: string; status: unknown; logs: readonly string[] };
  }>;
}

/**
 * Whether a receipt succeeded, by an allowlist (ruling P02-R17). Only the two success shapes of
 * the RPC's `ExecutionStatusView`, an object whose one own key is `SuccessValue` or
 * `SuccessReceiptId` with a string, are a success. Everything else is a failure: `Failure`, the
 * bare string `"Unknown"`, and any shape the RPC is not documented to send.
 */
function statusOf(status: unknown): ReceiptOutcome["status"] {
  if (typeof status !== "object" || status === null || Array.isArray(status)) return "failure";
  const keys = Object.keys(status);
  const [key] = keys;
  const succeeded =
    keys.length === 1 &&
    (key === "SuccessValue" || key === "SuccessReceiptId") &&
    typeof (status as Record<string, unknown>)[key] === "string";
  return succeeded ? "success" : "failure";
}

/**
 * The outcome of each receipt of a transaction, in the order the RPC lists them: its id, the
 * account it ran on, whether it succeeded and what it logged. `extractEvents` takes the result.
 */
export function receiptsFromTx(resp: TxReceiptsOutcome): ReceiptOutcome[] {
  return resp.receipts_outcome.map(({ id, outcome }) => ({
    receiptId: id,
    executorId: outcome.executor_id,
    status: statusOf(outcome.status),
    logs: [...outcome.logs],
  }));
}
