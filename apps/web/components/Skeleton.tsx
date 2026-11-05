import type { ReactNode } from "react";
import { CARD, EYEBROW, H1, PANEL, PANEL_TITLE } from "./ui";

// The shapes a page shows while it loads: the route's `loading.tsx` (while its code and its page
// come) and the page itself (while its data comes) draw the same ones, in the boxes the loaded page
// fills, so that nothing moves when the data lands. They are decoration: a screen reader is told
// "Loading" by the status line beside them, and never sees the shapes. Their colour is the raised
// grey of a panel's parts, with a slow light passing over it unless reduced motion is asked for
// (`.skeleton`, app/globals.css).
//
// This module holds the parts every page's shapes are made of, and the board's and directories'
// cards; the shapes of lists and figures are in SkeletonLists.tsx, and those of a task's, an
// agent's or a service's page and of forms in SkeletonDetail.tsx, so a page brings only its own.

/** A shape of `className`'s size, in the skeleton's grey. */
export function Shape({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`skeleton block ${className}`} />;
}

/**
 * A line of text that is not there yet: as tall as one line of `text` (the classes the text will
 * have, which give its size and line height), with a bar `width` wide in it.
 */
export function TextLine({
  text,
  width,
  className = "",
}: {
  text: string;
  width: string;
  /** Classes of the line itself, such as `md:hidden` for a line only a phone has. */
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={`${text} flex h-[1lh] items-center ${className}`}>
      <span className={`skeleton h-[0.62em] rounded-full ${width}`} />
    </span>
  );
}

/**
 * A route that is loading, in the box of its page (`frame`, the page's own classes): the shapes,
 * and the words for a screen reader. The words are out of the page's flow, so they take no room.
 */
export function RouteSkeleton({ frame, children }: { frame: string; children: ReactNode }) {
  return (
    <div className={`relative ${frame}`}>
      <p role="status" className="sr-only">
        Loading the page…
      </p>
      {children}
    </div>
  );
}

/** A page's head (components/PageHead) while it loads: its label, its headline, a line under it. */
export function HeadSkeleton({
  art = true,
  title = ["w-3/5"],
  phone = [],
  body = [],
}: {
  /** The head has a picture at its right, which gives it its height from tablet width up. */
  art?: boolean;
  /** The width of each line of the headline. */
  title?: string[];
  /** The width of each line more that the headline takes on a phone, where it wraps sooner. */
  phone?: string[];
  /** The width of each line of the text under it. */
  body?: string[];
}) {
  return (
    <div
      aria-hidden="true"
      className={`relative isolate grid content-center gap-3 ${art ? "md:min-h-44 md:pr-[38%]" : ""}`}
    >
      <TextLine text={EYEBROW} width="w-28" />
      <div className="grid">
        {title.map((width, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines are only shapes, in a fixed order
          <TextLine key={index} text={H1} width={width} />
        ))}
        {phone.map((width, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines are only shapes, in a fixed order
          <TextLine key={`phone-${index}`} text={H1} width={width} className="md:hidden" />
        ))}
      </div>
      {body.length === 0 ? null : (
        <div className="grid max-w-2xl text-[15px] leading-relaxed">
          {body.map((width, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines are only shapes, in a fixed order
            <TextLine key={index} text="text-[15px] leading-relaxed" width={width} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The grid of cards of the board and the directories: one column, two on a tablet, three wide. */
export const CARD_GRID = "grid gap-4 sm:grid-cols-2 xl:grid-cols-3";

/** A card of the board, or of a directory, while it loads: its outline and its parts' places. */
export function CardSkeleton() {
  return (
    <li aria-hidden="true" className={`${CARD} flex min-h-64 flex-col p-5 sm:p-6`}>
      <div className="flex justify-between">
        <Shape className="h-5 w-20 rounded-full" />
        <Shape className="h-5 w-24 rounded-full" />
      </div>
      <Shape className="mt-6 h-3 w-1/3 rounded-full" />
      <Shape className="mt-3 h-5 w-4/5 rounded-full" />
      <Shape className="mt-2 h-5 w-3/5 rounded-full" />
      <div className="mt-auto flex items-center gap-3 border-t border-line pt-4">
        <Shape className="size-[34px] rounded-full" />
        <Shape className="h-3 w-32 rounded-full" />
        <Shape className="ml-auto size-10 rounded-full" />
      </div>
    </li>
  );
}

/** `count` cards in the grid the loaded cards fill. */
export function CardsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <ul aria-hidden="true" className={CARD_GRID}>
      {Array.from({ length: count }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the cards are only shapes, in a fixed order
        <CardSkeleton key={index} />
      ))}
    </ul>
  );
}

/** A row of filter chips (the directories' tags), which wraps as the chips do. */
export function ChipsSkeleton({ count = 5 }: { count?: number }) {
  const widths = ["w-12", "w-20", "w-16", "w-24", "w-14", "w-[4.5rem]"];
  return (
    <div aria-hidden="true" className="flex flex-wrap gap-2">
      {Array.from({ length: count }, (_, index) => (
        <Shape
          // biome-ignore lint/suspicious/noArrayIndexKey: the chips are only shapes, in a fixed order
          key={index}
          className={`h-10 rounded-full ${widths[index % widths.length]}`}
        />
      ))}
    </div>
  );
}

/** A panel (`PANEL`) with a title and `lines` of text, or `children` under the title. */
export function PanelSkeleton({
  title = "w-32",
  lines = ["w-11/12", "w-4/5", "w-2/3"],
  className = "",
  children,
}: {
  title?: string;
  lines?: string[];
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div aria-hidden="true" className={`${PANEL} ${className}`}>
      <TextLine text={PANEL_TITLE} width={title} />
      {children ?? (
        <div className="grid gap-1">
          {lines.map((width, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines are only shapes, in a fixed order
            <TextLine key={index} text="text-[15px] leading-relaxed" width={width} />
          ))}
        </div>
      )}
    </div>
  );
}
