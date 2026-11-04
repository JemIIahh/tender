import type { ReactNode } from "react";
import { FACT_LABEL } from "../ui";

// A numbered step of "Add an agent": its number, its title, why it is done this way, and what to
// do. The connect flow (ConnectAgent.tsx) and the steps by hand (AddAgentView.tsx) are both made of
// them.

/**
 * How a step looks once it is open, and before. A step that is not open yet has a dashed edge on
 * the ink and a muted title, and is never faded: faded, its muted words would fall below 4.5:1
 * (WCAG 1.4.3). test/contrast.test.ts holds both looks to that.
 */
export const STEP_LOOK = {
  open: {
    card: "rounded-2xl border border-line bg-panel",
    title: "text-bone",
    why: "text-muted",
  },
  unopened: {
    card: "rounded-2xl border border-dashed border-line bg-ink",
    title: "text-muted",
    why: "text-muted",
  },
} as const;

/** A numbered step: its number, its title, why it is done this way, and what to do. */
export function Step({
  n,
  title,
  why,
  done,
  open,
  testId,
  children,
}: {
  n: number;
  title: string;
  why: string;
  done: boolean;
  open: boolean;
  /** `step-<n>` unless given: the page has two sets of steps. */
  testId?: string;
  children: ReactNode;
}) {
  return (
    <li
      data-testid={testId ?? `step-${n}`}
      data-done={done}
      data-open={open}
      className={`${open ? STEP_LOOK.open.card : STEP_LOOK.unopened.card} grid gap-5 p-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-6 sm:p-7`}
    >
      <span
        aria-hidden="true"
        className={`hidden size-10 place-items-center rounded-full font-mono text-sm sm:grid ${
          done
            ? "bg-bone text-ink"
            : open
              ? "border border-bone text-bone"
              : "border border-dashed border-dim text-muted"
        }`}
      >
        {done ? (
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          n
        )}
      </span>
      <div className="grid min-w-0 gap-4">
        <div className="grid gap-1.5">
          <p className={`${FACT_LABEL} flex items-center gap-2`}>
            {/* On a phone the number's circle is a dot beside these words: red once done. */}
            <span
              aria-hidden="true"
              className={`size-1.5 rounded-full sm:hidden ${done ? "bg-seal" : "bg-dim"}`}
            />
            Step {n}
            {done ? " · done" : ""}
          </p>
          <h2
            className={`text-xl leading-snug font-semibold tracking-tight sm:text-2xl ${open ? STEP_LOOK.open.title : STEP_LOOK.unopened.title}`}
          >
            {title}
          </h2>
          <p
            className={`text-[15px] leading-relaxed ${open ? STEP_LOOK.open.why : STEP_LOOK.unopened.why}`}
          >
            <span className={open ? "text-bone" : undefined}>Why: </span>
            {why}
          </p>
        </div>
        {children}
      </div>
    </li>
  );
}
