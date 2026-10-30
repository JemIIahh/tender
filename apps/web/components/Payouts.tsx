import type { TaskOutcome } from "@tender/shared";
import { formatBps } from "../lib/bps";
import { Amount } from "./Amount";

type Voided = Extract<TaskOutcome, { kind: "voided" }>;

/** Why a task was voided, in a sentence. */
const WHY: Record<Voided["reason"], string> = {
  no_reveals: "Nobody revealed an entry.",
  no_award: "The pick named no winner.",
  expired: "Nobody picked before the fallback window closed.",
};

/**
 * `by` and the part it played, if that is known from the task: the verifier's window comes first,
 * the poster's follows it. A poster who is also the verifier has both windows, and the outcome does
 * not say in which one they acted, so they are named as the verifier.
 */
function whoIs(by: string, poster: string, verifier: string): string {
  if (by === verifier) return `${by} (verifier)`;
  if (by === poster) return `${by} (poster, fallback window)`;
  return by;
}

/**
 * Who settled the task, in a line. `by` is the account that made the call, and it is null when no
 * name is known: the index read the outcome from the chain (reconcile), which does not say who
 * called, or `void_task` voided the task, which anyone may call. Then the line has no name.
 */
function settledBy(outcome: TaskOutcome, poster: string, verifier: string): string {
  const who = outcome.by === null ? undefined : whoIs(outcome.by, poster, verifier);
  if (outcome.kind === "picked") return who === undefined ? "Picked" : `Picked by ${who}`;
  return who === undefined ? "Refunded" : `Refunded · voided by ${who}`;
}

/**
 * How a settled task ended: who settled it, then who was paid what, or who got what back. Amounts
 * are in the task's `token`.
 */
export function Payouts({
  outcome,
  token,
  poster,
  verifier,
}: {
  outcome: TaskOutcome;
  token: string;
  poster: string;
  verifier: string;
}) {
  return (
    <section data-testid="payouts" className="grid gap-3">
      <h2 className="text-lg font-semibold">Payouts</h2>
      <p data-testid="settled-by" className="font-medium wrap-anywhere">
        {settledBy(outcome, poster, verifier)}
      </p>

      {outcome.kind === "voided" ? (
        <p data-testid="settled-why" className="text-sm">
          {WHY[outcome.reason]}
        </p>
      ) : null}

      {outcome.kind === "picked" ? (
        <>
          <ul className="grid gap-2" aria-label="Winners">
            {outcome.winners.map((winner, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: the contract allows one share per account, but the page does not rely on it
                key={`${winner.account}:${i}`}
                data-testid="winner-row"
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
              >
                <span className="font-mono text-sm wrap-anywhere">{winner.account}</span>
                <span>{formatBps(winner.bps)}</span>
                <Amount value={winner.amount} token={token} />
              </li>
            ))}
          </ul>
          <p data-testid="fee" className="text-sm">
            Fee: <Amount value={outcome.fee} token={token} />
          </p>
        </>
      ) : null}

      {outcome.kind === "voided" && outcome.refunds !== undefined && outcome.refunds.length > 0 ? (
        <ul className="grid gap-2" aria-label="Refunds">
          {outcome.refunds.map((refund, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: a funder is listed once, but the page does not rely on it
              key={`${refund.account}:${i}`}
              data-testid="refund-row"
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
            >
              <span className="font-mono text-sm wrap-anywhere">{refund.account}</span>
              <Amount value={refund.amount} token={token} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
