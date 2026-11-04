import type { ReactNode } from "react";
import { PanelSkeleton, Shape, TextLine } from "./Skeleton";
import { EYEBROW, FACT_LABEL, H1 } from "./ui";

// The shapes of a task's, an agent's and a service's page, and of a page of forms, while they load
// (components/Skeleton.tsx says what shapes are for).

/** The figures under a task's or an agent's title: a band of cells, `cells` of them. */
export function FactsSkeleton({ cells = 4 }: { cells?: number }) {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-4"
    >
      {Array.from({ length: cells }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: the cells are only shapes, in a fixed order
          key={index}
          className={`grid content-start gap-2 bg-panel p-5 ${index === 0 ? "col-span-2 sm:col-span-1" : ""}`}
        >
          <TextLine text={FACT_LABEL} width="w-16" />
          <TextLine text="text-2xl leading-tight" width="w-20" />
          <TextLine text="text-[13px]" width="w-24" />
        </div>
      ))}
    </div>
  );
}

/** The heading of a task's page, as its loaded page writes it. */
export const TASK_TITLE =
  "text-3xl leading-[1.08] font-semibold tracking-[-0.03em] text-bone wrap-anywhere sm:text-[2.6rem]";

/**
 * A task's page while it loads: its label, its heading (`heading`, the task's number while it
 * loads, or a shape), the figures, the timeline and the brief, where the loaded page has them.
 */
export function TaskSkeleton({ heading }: { heading?: ReactNode }) {
  return (
    <>
      <div className="grid gap-5 pb-3">
        <TextLine text={EYEBROW} width="w-48" />
        {heading ?? <TextLine text={TASK_TITLE} width="w-3/5" />}
        <FactsSkeleton />
      </div>
      <PanelSkeleton title="w-24" className="min-h-64">
        <div aria-hidden="true" className="grid grid-cols-5 gap-2">
          {Array.from({ length: 5 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the windows are only shapes, in a fixed order
            <Shape key={index} className="h-12 rounded-xl" />
          ))}
        </div>
        <Shape className="h-2 w-full rounded-full" />
        <Shape className="h-20 w-full rounded-xl" />
      </PanelSkeleton>
      <PanelSkeleton title="w-16" lines={["w-11/12", "w-4/5", "w-1/2"]} />
    </>
  );
}

/**
 * An agent's page while it loads: its label, its avatar and name (`heading`, the account while it
 * loads, or a shape), the panel of its figures, and its recent entries.
 */
export function AgentSkeleton({ heading }: { heading?: ReactNode }) {
  return (
    <>
      <div className="grid gap-5 pb-3">
        <TextLine text={EYEBROW} width="w-16" />
        <div className="flex min-w-0 items-center gap-4">
          <Shape className="size-14 shrink-0 rounded-full" />
          <div className="grid min-w-0 flex-1 gap-2">
            {heading ?? <TextLine text={H1} width="w-3/5" />}
            <TextLine text="text-base" width="w-40" />
          </div>
        </div>
        <PanelSkeleton title="w-24" lines={[]}>
          <div aria-hidden="true" className="grid grid-cols-3 gap-px overflow-hidden rounded-xl">
            {Array.from({ length: 3 }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the counts are only shapes, in a fixed order
              <Shape key={index} className="h-[4.5rem]" />
            ))}
          </div>
          <TextLine text="text-[15px]" width="w-1/2" />
        </PanelSkeleton>
      </div>
      <PanelSkeleton title="w-36" lines={["w-11/12", "w-4/5", "w-2/3"]} />
    </>
  );
}

/**
 * A service's page while it loads: its label, its title (`heading`, its number while it loads, or a
 * shape), its agent, and its panels beside the hire form.
 */
export function ServiceSkeleton({ heading }: { heading?: ReactNode }) {
  return (
    <>
      <div className="grid gap-4 pb-2">
        <TextLine text={EYEBROW} width="w-44" />
        {heading ?? <TextLine text={H1} width="w-3/5" />}
        <div className="flex items-center gap-4">
          <Shape className="size-10 shrink-0 rounded-full" />
          <TextLine text="text-base" width="w-48" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <div className="grid min-w-0 gap-6">
          <PanelSkeleton title="w-32" />
          <PanelSkeleton title="w-24" lines={["w-3/4", "w-1/2"]} />
        </div>
        <FormsSkeleton panels={1} />
      </div>
    </>
  );
}

/** The panels of a page of forms (posting, the wallet, Telegram, Settings), while it loads. */
export function FormsSkeleton({ panels = 2 }: { panels?: number }) {
  return (
    <>
      {Array.from({ length: panels }, (_, index) => (
        <PanelSkeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: the panels are only shapes, in a fixed order
          key={index}
          title={index === 0 ? "w-40" : "w-28"}
          lines={[]}
        >
          <div className="grid gap-1">
            <TextLine text="text-[15px] leading-relaxed" width="w-11/12" />
            <TextLine text="text-[15px] leading-relaxed" width="w-3/5" />
          </div>
          <Shape className="h-11 w-full rounded-xl" />
          <Shape className="h-11 w-40 rounded-full" />
        </PanelSkeleton>
      ))}
    </>
  );
}
