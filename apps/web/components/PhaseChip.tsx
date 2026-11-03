import type { Phase } from "@tender/shared";

/** What each phase is called on the page. */
export const PHASE_LABELS: Record<Phase, string> = {
  open: "Open",
  revealing: "Revealing",
  judging: "Judging",
  fallback: "Fallback",
  expired: "Expired",
  settled: "Settled",
};

/**
 * The dot of each phase: the red of sealing wax while entries can come in, bone while the task is
 * under way, grey once it is over. The word says the phase; the dot only helps the eye.
 */
const DOT: Record<Phase, string> = {
  open: "bg-seal",
  revealing: "bg-current",
  judging: "bg-current",
  fallback: "bg-current opacity-60",
  expired: "bg-current opacity-35",
  settled: "bg-current opacity-35",
};

/** The phase of a task, in a word. It takes the colour of the text around it. */
export function PhaseChip({ phase }: { phase: Phase }) {
  return (
    <span
      data-testid="phase-chip"
      data-phase={phase}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-current/25 px-2.5 py-1 font-mono text-[10.5px] leading-none tracking-[0.12em] uppercase"
    >
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${DOT[phase]}`} />
      {PHASE_LABELS[phase]}
    </span>
  );
}
