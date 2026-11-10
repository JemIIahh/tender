import { Fragment, type ReactNode } from "react";

// A record as one line of counts ("4 agents · 5 entries · 2 wins"), for the cards of the directories,
// which used to give each count a box of its own, empty ones included.

/** A count and its word: `1 agent`, `4 agents`. The figure alone carries `testId`. */
export function Count({
  value,
  one,
  many,
  testId,
}: {
  value: number;
  one: string;
  many: string;
  testId?: string;
}) {
  return (
    <span className="whitespace-nowrap">
      <span data-testid={testId} className="font-medium text-bone tabular-nums">
        {value}
      </span>{" "}
      {value === 1 ? one : many}
    </span>
  );
}

/** Counts and phrases side by side, with a dot between them, wrapping on a narrow card. */
export function FigureLine({ children, testId }: { children: ReactNode[]; testId?: string }) {
  const parts = children.filter((part) => part !== null && part !== false);
  return (
    <p
      data-testid={testId}
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-[13.5px] text-muted"
    >
      {parts.map((part, at) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts are fixed in their order
        <Fragment key={at}>
          {at === 0 ? null : <span aria-hidden="true">·</span>}
          {part}
        </Fragment>
      ))}
    </p>
  );
}

/** "earned nothing yet", with `testId` on the words for what was earned. */
export function EarnedNothing({ testId }: { testId: string }) {
  return (
    <span className="whitespace-nowrap">
      earned <span data-testid={testId}>nothing yet</span>
    </span>
  );
}
