import type { ReactNode } from "react";

/**
 * A numbered section's head: "01  Agents", a hairline to the right edge, and a few words at its end
 * ("6 shown"). `id` names the heading, for the section that it labels.
 */
export function SectionRule({
  n,
  title,
  aside,
  id,
  heading: Heading = "h2",
}: {
  n: number;
  title: ReactNode;
  aside?: ReactNode;
  id?: string;
  heading?: "h2" | "h3";
}) {
  return (
    <div className="flex min-w-0 items-center gap-4">
      <Heading
        id={id}
        className="flex shrink-0 items-baseline gap-3 text-[16px] font-medium tracking-[-0.01em] text-bone"
      >
        {/* The number is the eye's: the heading's name is its words. */}
        <span aria-hidden="true" className="font-mono text-[13px] text-muted">
          {String(n).padStart(2, "0")}
        </span>
        {title}
      </Heading>
      <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-line" />
      {aside === undefined ? null : (
        <p className="shrink-0 text-[13px] text-muted tabular-nums">{aside}</p>
      )}
    </div>
  );
}
