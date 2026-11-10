import { PanelSkeleton, Shape, TextLine } from "./Skeleton";
import { CARD, FACT_LABEL } from "./ui";

// The shapes of lists and figures while they load (components/Skeleton.tsx says what shapes are
// for): the board's filters, rows of figures, tables, lists and the activity feed.

/** The board's summary line and its segmented control of phases, side by side. */
export function BoardFiltersSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
      <TextLine text="text-[15px]" width="w-44" />
      <span className="flex h-11 w-72 max-w-full items-center gap-1 rounded-full border border-line bg-panel p-1">
        <Shape className="h-9 w-14 rounded-full" />
      </span>
    </div>
  );
}

/** A stat block (components/account/parts.tsx, `Stat`): its label, its figure and its line. */
function StatSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="grid min-w-0 content-start gap-3 rounded-2xl border border-line bg-panel p-5"
    >
      <TextLine text={FACT_LABEL} width="w-24" />
      <TextLine text="text-xl leading-tight sm:text-2xl" width="w-16" />
      <TextLine text="text-[13px] leading-snug" width="w-3/4" />
    </div>
  );
}

/** A row of `count` stat blocks, laid out as `Stats` lays out its blocks (`columns` wide). */
export function StatsSkeleton({ count, columns }: { count: number; columns: 3 | 4 }) {
  const wide = columns === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3";
  return (
    <div
      aria-hidden="true"
      className={`grid grid-cols-2 gap-3 sm:gap-4 max-lg:[&>*:last-child:nth-child(odd)]:col-span-2 ${wide}`}
    >
      {Array.from({ length: count }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the blocks are only shapes, in a fixed order
        <StatSkeleton key={index} />
      ))}
    </div>
  );
}

/**
 * A panel of rows under a bar of tabs (My tasks, Earnings): the tabs, the columns' labels and
 * `rows` rows.
 */
export function TableSkeleton({ tabs = 3, rows = 3 }: { tabs?: number; rows?: number }) {
  return (
    <div aria-hidden="true" className={`${CARD} grid grid-cols-1 overflow-hidden`}>
      <div className="flex gap-5 border-b border-line px-5 pt-4 sm:gap-7 sm:px-6">
        {Array.from({ length: tabs }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the tabs are only shapes, in a fixed order
          <span key={index} className="flex min-h-11 items-center pb-1">
            <TextLine text="text-[15px]" width={index === 0 ? "w-16" : "w-12"} />
          </span>
        ))}
      </div>
      <div className="hidden gap-6 border-b border-line px-5 py-3 sm:flex sm:px-6">
        {["w-12", "w-14", "w-14", "w-14", "w-14"].map((width, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the labels are only shapes, in a fixed order
          <span key={index} className="flex-1">
            <TextLine text={FACT_LABEL} width={width} />
          </span>
        ))}
      </div>
      <RowsSkeleton rows={rows} />
    </div>
  );
}

/** `rows` rows of a panel's table (My tasks, Earnings), under its tabs. */
export function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="grid grid-cols-1">
      {Array.from({ length: rows }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows are only shapes, in a fixed order
          key={index}
          className="grid gap-2 border-t border-line px-5 py-5 first:border-t-0 sm:flex sm:items-center sm:gap-6 sm:px-6"
        >
          <span className="grid flex-1 gap-1">
            <Shape className="h-4 w-4/5 rounded-full" />
            <Shape className="h-3 w-8 rounded-full" />
          </span>
          <Shape className="h-6 w-20 flex-1 rounded-full sm:max-w-20" />
          <Shape className="h-4 w-24 flex-1 rounded-full sm:max-w-24" />
          <Shape className="hidden h-4 flex-1 rounded-full sm:block sm:max-w-24" />
          <Shape className="hidden h-11 w-16 rounded-full sm:block" />
        </div>
      ))}
    </div>
  );
}

/**
 * A list of accounts in a panel (My agents): `rows` rows, each an avatar, two lines and, from
 * tablet width up, its figures.
 */
export function ListSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <ul aria-hidden="true" className={`${CARD} grid`}>
      {Array.from({ length: rows }, (_, index) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows are only shapes, in a fixed order
          key={index}
          className="flex items-center gap-4 border-t border-line p-6 first:border-t-0"
        >
          <Shape className="size-11 shrink-0 rounded-full" />
          <span className="grid flex-1 gap-2">
            <Shape className="h-4 w-48 max-w-full rounded-full" />
            <Shape className="h-3 w-32 rounded-full" />
          </span>
          <Shape className="hidden h-12 w-56 rounded-full sm:block" />
        </li>
      ))}
    </ul>
  );
}

/** The activity feed while it loads: its filter row and `rows` lines. */
export function FeedSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className={`${CARD} grid grid-cols-1 overflow-hidden`}>
      <div className="flex gap-1 overflow-hidden border-b border-line px-5 py-4 sm:px-6">
        {["w-12", "w-[4.5rem]", "w-16", "w-[4.5rem]", "w-14", "w-24", "w-[4.5rem]"].map(
          (width, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the filters are only shapes, in a fixed order
            <Shape key={index} className={`h-10 shrink-0 rounded-full ${width}`} />
          ),
        )}
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines are only shapes, in a fixed order
          key={index}
          className="flex items-start gap-4 border-t border-line px-5 py-5 first:border-t-0 sm:px-6"
        >
          <Shape className="mt-1.5 size-2 shrink-0 rounded-full" />
          <span className="grid min-w-0 flex-1 gap-2">
            <Shape className="h-4 w-11/12 max-w-xl rounded-full" />
            <Shape className="h-3 w-16 rounded-full sm:hidden" />
          </span>
          <span className="hidden justify-items-end gap-2 sm:grid">
            <Shape className="h-4 w-28 rounded-full" />
            <Shape className="h-3 w-12 rounded-full" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Metrics' figures while they are counted: the two rows of figures, the chart and the top agents. */
export function MetricsSkeleton() {
  return (
    <>
      <StatsSkeleton count={4} columns={4} />
      <StatsSkeleton count={3} columns={3} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <PanelSkeleton title="w-52" lines={[]} className="min-h-80">
          <Shape className="h-40 w-full rounded-xl" />
        </PanelSkeleton>
        <PanelSkeleton
          title="w-28"
          lines={["w-11/12", "w-4/5", "w-11/12", "w-3/4"]}
          className="min-h-80"
        />
      </div>
    </>
  );
}
