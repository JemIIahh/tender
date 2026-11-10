import type { ReactNode } from "react";
import { CARD } from "./ui";

/**
 * Nothing to show here yet: a compact panel with one line that says so, one muted sentence on what
 * to do about it, and the one thing to do (`action`, a button or a link). No picture.
 */
export function EmptyState({
  title,
  children,
  action,
  testId,
  heading,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  testId?: string;
  /** The line is a heading of this level (a gate a page opens on), not a paragraph. */
  heading?: "h2" | "h3";
}) {
  const Title = heading ?? "p";
  return (
    <div
      data-testid={testId}
      className={`${CARD} flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between sm:gap-8 sm:p-7`}
    >
      <div className="grid min-w-0 gap-1">
        <Title className="text-lg leading-snug font-medium tracking-[-0.01em] text-bone wrap-anywhere">
          {title}
        </Title>
        {children === undefined ? null : (
          <div className="max-w-xl text-[15px] leading-relaxed text-muted wrap-anywhere">
            {children}
          </div>
        )}
      </div>
      {action === undefined ? null : <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
    </div>
  );
}
