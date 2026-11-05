import { HAND_PICK_REASON_MAX, type TaskEntry } from "@tender/shared";
import { TeamBadge } from "../TeamBadge";
import { FIELD } from "../ui";
import { Delivery } from "./Delivery";

/** How a reveal time reads: `29 Oct, 20:54:59 UTC`, the same wherever the page is opened. */
const REVEAL_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

/** When an entry was revealed, if the API says (the block time of its reveal), as a `<time>`. */
function RevealedAt({ ns }: { ns: string | null | undefined }) {
  if (ns === null || ns === undefined) return null;
  const at = new Date(Number(BigInt(ns) / 1_000_000n));
  return (
    <>
      {"Revealed "}
      <time dateTime={at.toISOString()}>{`${REVEAL_TIME.format(at)} UTC`}</time>
      {" · "}
    </>
  );
}

/**
 * One revealed entry in the pick (components/actions/PickPanel.tsx): who entered and when, the box
 * to choose it (a radio when the task pays one winner, a checkbox when it pays several), what it
 * delivered, read through the API and shown as text, and its share and its reason. The panel holds
 * the choice; this row only shows it and says what the person changed.
 */
export function PickEntry({
  entry,
  idBase,
  single,
  on,
  full,
  busy,
  several,
  share,
  reason,
  fieldError,
  onToggle,
  onShare,
  onReason,
}: {
  entry: TaskEntry;
  /** The panel's id, which the row's fields' ids are made from. */
  idBase: string;
  /** The task pays one winner. */
  single: boolean;
  /** The entry is chosen. */
  on: boolean;
  /** As many are chosen as the task pays: this one can't be added. */
  full: boolean;
  busy: boolean;
  /** More than one winner is chosen, so each chosen one has a share. */
  several: boolean;
  share: string;
  reason: string;
  fieldError: string | undefined;
  onToggle: (on: boolean) => void;
  onShare: (share: string) => void;
  onReason: (reason: string) => void;
}) {
  const shareId = `${idBase}-share-${entry.entry_index}`;
  const reasonId = `${idBase}-reason-${entry.entry_index}`;
  // The fields are named by their visible labels, and described by whose entry it is.
  const whoId = `${idBase}-who-${entry.entry_index}`;
  return (
    <li
      data-testid="pick-entry"
      data-chosen={on}
      className={`grid gap-3 rounded-xl border p-4 transition-colors motion-reduce:transition-none ${on ? "border-bone/50 bg-raised" : "border-line bg-ink/40"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <label className="flex min-w-0 cursor-pointer items-start gap-3">
          <input
            type={single ? "radio" : "checkbox"}
            name={single ? `${idBase}-winner` : undefined}
            checked={on}
            disabled={busy || full}
            onChange={(event) => onToggle(event.target.checked)}
            aria-label={`Winner: ${entry.account}`}
            className="mt-1 size-4 shrink-0 accent-[var(--color-seal)]"
          />
          <span className="grid min-w-0 gap-1">
            <span id={whoId}>
              <TeamBadge account={entry.account} isTeam={entry.is_team} />
            </span>
            <span data-testid="pick-entry-when" className="text-[12.5px] text-muted">
              <RevealedAt ns={entry.revealed_at} />
              {`${entry.revealed_at == null ? "Committed" : "committed"} at block ${entry.committed_height}`}
            </span>
          </span>
        </label>
        {on ? (
          <span className="rounded-full border border-seal/60 px-2.5 py-1 font-mono text-[10.5px] tracking-[0.14em] text-bone uppercase">
            Winner
          </span>
        ) : null}
      </div>

      <Delivery account={entry.account} contentHash={entry.content_hash ?? ""} uri={entry.uri} />

      <div className="grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
        {on && several ? (
          <div className="grid content-start gap-1.5">
            <label htmlFor={shareId} className="text-[13px] text-bone">
              Share (%)
            </label>
            <input
              id={shareId}
              inputMode="decimal"
              value={share}
              disabled={busy}
              onChange={(event) => onShare(event.target.value)}
              aria-invalid={fieldError !== undefined}
              aria-describedby={fieldError === undefined ? whoId : `${whoId} ${shareId}-error`}
              className={`${FIELD} tabular-nums`}
            />
            {fieldError === undefined ? null : (
              <p id={`${shareId}-error`} role="alert" className="text-[12.5px] text-seal">
                {fieldError}
              </p>
            )}
          </div>
        ) : null}
        <div className={`grid content-start gap-1.5 ${on && several ? "" : "sm:col-span-2"}`}>
          <label htmlFor={reasonId} className="text-[13px] text-bone">
            Reason (optional, public)
          </label>
          <input
            id={reasonId}
            value={reason}
            maxLength={HAND_PICK_REASON_MAX}
            disabled={busy}
            onChange={(event) => onReason(event.target.value)}
            aria-describedby={whoId}
            className={FIELD}
            placeholder="One line on why, for the scorecard"
          />
        </div>
      </div>
    </li>
  );
}
