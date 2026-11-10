import type { PickWinner, splitReward, TaskDetailResponse } from "@tender/shared";
import { formatBps } from "../../lib/bps";
import { describeAmount } from "../../lib/vault";
import { Amount } from "../Amount";
import { FACT_LABEL } from "../ui";

/** What the contract pays out for a choice of winners. */
type Payout = ReturnType<typeof splitReward>;

/**
 * What gets paid for the pick being made (components/actions/PickPanel.tsx): where the shares
 * stand, or what is still wrong with the choice, and once it can be sent, the reward, the fee and
 * each winner's amount as the contract works them out, with any rounding said. "Split equally" puts
 * the shares back when several are chosen.
 */
export function PickPayout({
  task,
  chosen,
  winners,
  problem,
  payout,
  equalNote,
  busy,
  onSplitEqually,
}: {
  task: Pick<TaskDetailResponse["task"], "reward" | "token" | "fee_bps">;
  /** How many entries are chosen. */
  chosen: number;
  winners: readonly PickWinner[];
  /** What is wrong with the choice, or null when it can be sent. */
  problem: string | null;
  /** What it pays, when it can be sent. */
  payout: Payout | null;
  /** What an equal split of the shares leaves over, said in words, if it leaves anything. */
  equalNote: string | null;
  busy: boolean;
  onSplitEqually: () => void;
}) {
  return (
    <div className="grid gap-3 rounded-xl border border-line bg-ink p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className={FACT_LABEL}>What gets paid</h3>
        {chosen > 1 ? (
          <button
            type="button"
            onClick={onSplitEqually}
            disabled={busy}
            className="text-[13px] text-muted underline decoration-muted/40 underline-offset-4 hover:text-bone"
          >
            Split equally
          </button>
        ) : null}
      </div>
      {/* Only where the shares stand is announced as it changes, not every amount. The region is
          always there, so that its first words are announced too; empty, it takes no room. */}
      <p
        aria-live="polite"
        className={payout === null || chosen > 1 ? "text-sm text-muted" : "sr-only"}
      >
        {payout === null ? (
          <span data-testid="pick-problem">{problem}</span>
        ) : chosen > 1 ? (
          "The shares add up to 100%."
        ) : null}
      </p>
      {payout === null ? null : (
        <>
          <p className="text-[13.5px] text-muted">
            {"Reward "}
            <Amount value={task.reward} token={task.token} />
            {` · platform fee ${formatBps(task.fee_bps)}, `}
            <Amount value={payout.fee.toString()} token={task.token} />
            {" · each winner gets their share of the rest."}
          </p>
          <ul className="grid">
            {winners.map((winner, i) => (
              <li
                key={winner.account}
                data-testid="pick-payout"
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-line py-2.5 first:border-t-0 first:pt-0 last:pb-0"
              >
                <span className="min-w-0 font-mono text-[13px] text-bone wrap-anywhere">
                  {winner.account}
                </span>
                <span className="text-muted tabular-nums">{formatBps(winner.bps)}</span>
                <span className="ml-auto text-bone tabular-nums">
                  <Amount value={(payout.amounts[i] ?? 0n).toString()} token={task.token} />
                </span>
              </li>
            ))}
          </ul>
          {equalNote === null ? null : (
            <p data-testid="pick-rounding-shares" className="text-[12.5px] text-muted">
              {equalNote}
            </p>
          )}
          {payout.dust > 0n ? (
            <p data-testid="pick-rounding" className="text-[12.5px] text-muted">
              {`Rounding down leaves ${describeAmount(payout.dust, task.token)}: the contract gives it to ${winners[0]?.account}, the first winner, as shown.`}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
