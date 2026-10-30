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

/** The phase of a task, in a word. */
export function PhaseChip({ phase }: { phase: Phase }) {
  return (
    <span
      data-testid="phase-chip"
      data-phase={phase}
      className="rounded border border-neutral-900 px-1.5 py-0.5 text-xs font-medium"
    >
      {PHASE_LABELS[phase]}
    </span>
  );
}
