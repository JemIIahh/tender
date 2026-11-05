import type { TaskDetailResponse } from "@tender/shared";
import type { RefObject } from "react";
import { Amount } from "../Amount";
import { PRIMARY, SECONDARY } from "../ui";

/**
 * The question "Pick nobody?" (components/actions/PickPanel.tsx), asked before a pick that pays no
 * agent: the whole reward goes back to the funders, each named with what they get back, with no
 * fee, and the scorecard is published with every entry at 0. The panel moves the focus here when it
 * opens (`focusRef`), and holds whether it is open and what is being sent.
 */
export function PickNobody({
  focusRef,
  data,
  account,
  busy,
  busyWords,
  onConfirm,
  onCancel,
}: {
  focusRef: RefObject<HTMLFieldSetElement | null>;
  data: Pick<TaskDetailResponse, "task" | "funders">;
  /** The account that picks. */
  account: string;
  busy: boolean;
  /** What the send is doing, while it runs. */
  busyWords: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { task, funders } = data;
  return (
    <div className="rounded-xl border border-seal/50 bg-raised p-4">
      <fieldset
        ref={focusRef}
        tabIndex={-1}
        data-testid="pick-nobody-confirm"
        className="grid min-w-0 gap-3 outline-none"
      >
        <legend className="mb-3 font-medium text-bone">
          Pick nobody? The agents are not paid.
        </legend>
        <p className="text-[13.5px] text-muted">
          The whole reward, <Amount value={task.reward} token={task.token} />, goes back to the
          funders, with no fee taken. The scorecard is published with every entry at 0.
        </p>
        {funders.length === 0 ? null : (
          <ul className="grid gap-1 text-[13px]">
            {funders.map((funder) => (
              <li key={funder.account} className="flex flex-wrap gap-x-3">
                <span className="font-mono text-bone wrap-anywhere">{funder.account}</span>
                <span className="text-muted tabular-nums">
                  gets back <Amount value={funder.amount} token={task.token} />
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[13px] text-muted">
          {`Entries were revealed, so if ${account} is a registered agent, its public record counts one more empty pick after reveals.`}
        </p>
        <div className="flex flex-wrap gap-3">
          <button type="button" aria-disabled={busy} onClick={onConfirm} className={PRIMARY}>
            {busy && busyWords !== null ? busyWords : "Yes, pick nobody"}
          </button>
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onCancel();
            }}
            className={SECONDARY}
          >
            Cancel
          </button>
        </div>
      </fieldset>
    </div>
  );
}
