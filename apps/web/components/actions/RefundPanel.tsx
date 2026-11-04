"use client";

import type { TaskDetailResponse } from "@tender/shared";
import { useRef, useState } from "react";
import type { RefundView } from "../../lib/actions";
import { RefundFailure, type RefundResult, submitRefund } from "../../lib/refund";
import type { UseWallet } from "../../lib/wallet";
import { Amount } from "../Amount";
import { Countdown } from "../Countdown";
import { NOTICE, PRIMARY } from "../ui";

type Run =
  | { status: "idle" }
  | { status: "busy" }
  | { status: "failed"; message: string }
  | { status: "done"; result: RefundResult };

/**
 * The keeper is a service the team runs (packages/api/src/keeper.ts): it sends `void_task` for
 * tasks like this one on its own, every 30 seconds or so, whenever it is running. The button is
 * the same call, and anyone may send it.
 */
export const KEEPER_NOTE =
  "Tender's keeper, a service the Tender team runs, sends this refund on its own within a minute or so while it is running. The button is the manual way: anyone can press it.";

/**
 * "Refund the funders": `void_task`, which anyone may send once the reveal window is over with
 * nothing revealed, or the fallback window is over. Before then it says when it opens, as a time
 * left, and on what it waits. It names who gets what back: each funder exactly what it paid in.
 */
export function RefundPanel({
  data,
  view,
  nowNs,
  wallet,
  onSent,
}: {
  data: TaskDetailResponse;
  view: RefundView;
  nowNs: bigint;
  wallet: UseWallet;
  onSent: (result: RefundResult) => void;
}) {
  const { task, funders } = data;
  const [run, setRun] = useState<Run>({ status: "idle" });
  const accountRef = useRef(wallet.accountId);
  accountRef.current = wallet.accountId;
  const open = view.kind === "open";
  const busy = run.status === "busy";

  async function send() {
    if (!open || busy || wallet.accountId === null) return;
    setRun({ status: "busy" });
    try {
      const result = await submitRefund(
        { taskId: task.id, account: wallet.accountId },
        { account: () => accountRef.current, signAndSend: wallet.signAndSend },
      );
      setRun({ status: "done", result });
      onSent(result);
    } catch (error) {
      console.error(error);
      setRun({
        status: "failed",
        message:
          error instanceof RefundFailure
            ? error.message
            : "Something went wrong. Nothing was sent.",
      });
    }
  }

  return (
    <div className="grid gap-4">
      {open ? (
        <p data-testid="refund-open" className="text-[14px] text-bone">
          {task.reveal_count === 0
            ? "Nobody revealed an entry, so anyone can send the reward back to its funders now."
            : "Nobody picked before the fallback deadline, so anyone can send the reward back to its funders now."}
        </p>
      ) : (
        <p data-testid="refund-opens" className="text-[14px] text-muted">
          {"Opens in "}
          <Countdown toNs={view.atNs} nowNs={nowNs} />
          {view.ifNothingRevealed
            ? ", at the reveal deadline, if nobody has revealed an entry by then."
            : ", at the fallback deadline, if nobody has picked by then."}
        </p>
      )}

      {funders.length === 0 ? null : (
        <ul className="grid text-[13.5px]" aria-label="What each funder gets back">
          {funders.map((funder) => (
            <li
              key={funder.account}
              data-testid="refund-funder"
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-line py-2.5 first:border-t-0 first:pt-0 last:pb-0"
            >
              <span className="min-w-0 font-mono text-[13px] text-bone wrap-anywhere">
                {funder.account}
              </span>
              <span className="ml-auto text-bone tabular-nums">
                <Amount value={funder.amount} token={task.token} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {run.status === "done" ? null : (
        <button
          type="button"
          aria-disabled={!open || busy}
          onClick={() => void send()}
          className={PRIMARY}
        >
          {busy ? "Waiting for your wallet to approve…" : "Refund the funders"}
        </button>
      )}
      {run.status === "failed" ? (
        <p role="alert" data-testid="refund-error" className="text-sm text-seal">
          {run.message}
        </p>
      ) : null}
      <p data-testid="keeper-note" className={`${NOTICE} text-[12.5px] text-muted`}>
        {KEEPER_NOTE}
      </p>
    </div>
  );
}
