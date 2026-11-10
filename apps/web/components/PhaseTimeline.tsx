"use client";

import type { Phase } from "@tender/shared";
import { type ReactNode, useId, useState } from "react";
import {
  formatDuration,
  formatSpan,
  nsAtScrub,
  type PhasedTask,
  phaseByClock,
  phaseOfTask,
  RULES,
  SCRUB_MAX,
  type Segment,
  scrubOf,
  segments,
  WINDOW_LABELS,
  type WindowPhase,
} from "../lib/phase";
import { Countdown } from "./Countdown";
import { EYEBROW, PANEL, PANEL_TITLE, SECONDARY } from "./ui";

/** What each window is called in a sentence. */
const WINDOW_NAMES: Record<Phase, string> = {
  open: "commit window",
  revealing: "reveal window",
  judging: "judging window",
  fallback: "fallback window",
  expired: "time after the fallback window",
  settled: "settled",
};

/** The zones of the timeline: the four windows, then what follows them. */
type Zone = WindowPhase | "expired";
const ZONE_ORDER: readonly Zone[] = ["open", "revealing", "judging", "fallback", "expired"];

/** What the live clock says about `live`, with the time left in the window that is open. */
function liveStatus(live: Phase, window: Segment | undefined, nowNs: bigint): ReactNode {
  const closes = (what: string) => (
    <>
      {what} closes in {window ? <Countdown toNs={window.endNs} nowNs={nowNs} /> : null}
    </>
  );
  switch (live) {
    case "open":
      return closes("Answer window (commit)");
    case "revealing":
      return closes("Opening window (reveal)");
    case "judging":
      return closes("Pick window");
    case "fallback":
      return closes("Poster's fallback window");
    case "expired":
      return "The fallback window has closed.";
    case "settled":
      return "Settled.";
  }
}

/**
 * The life of a task in four windows, commit, reveal, judge and fallback, with the one that is open
 * marked and the time left in it counting down, then a what-if scrubber under them: drag it, or
 * move it with the keyboard, to a moment in the task's life and read which rule holds then.
 * Previewing changes nothing but this component's own view; `onScrub` hears the moment (null once
 * the person goes back to now) for a page that wants to draw on it too.
 *
 * The scrubber follows the clock until it is touched. After that its position is the person's,
 * and stays so until they go back to now.
 */
export function PhaseTimeline({
  task,
  nowNs,
  onScrub,
}: {
  task: PhasedTask;
  nowNs: bigint;
  onScrub?: (previewNs: bigint | null) => void;
}) {
  const sliderId = useId();
  const [scrub, setScrub] = useState<number | null>(null);

  const windows = segments(task);
  const live = phaseOfTask(task, nowNs);
  const previewNs = scrub === null ? null : nsAtScrub(task, scrub);
  // The phase whose rule is on show: the live one, or the one the scrubber is in.
  const shown: Phase = previewNs === null ? live : phaseByClock(task, previewNs);
  const rule = RULES[shown];
  const position = scrub ?? scrubOf(task, nowNs);
  const created = windows[0]?.startNs ?? 0n;
  const openWindow = windows.find((w) => w.phase === live);

  const move = (to: number | null) => {
    setScrub(to);
    onScrub?.(to === null ? null : nsAtScrub(task, to));
  };

  const elapsed = (ns: bigint) => `${formatDuration(ns - created)} after posting`;
  // Following the clock, the thumb moves by itself and its text must not change every second, or a
  // screen reader says it each time: the elapsed time is only in the text of a preview, which
  // changes when the person moves the slider.
  const valueText =
    previewNs === null
      ? `Now, ${WINDOW_NAMES[shown]}: ${rule.headline}`
      : `Preview, ${WINDOW_NAMES[shown]}, ${elapsed(previewNs)}: ${rule.headline}`;

  return (
    <section aria-labelledby={`${sliderId}-title`} data-testid="phase-timeline" className={PANEL}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={`${sliderId}-title`} className={PANEL_TITLE}>
          Timeline
        </h2>
        <p data-testid="live-status" className="text-sm text-muted">
          {liveStatus(live, openWindow, nowNs)}
        </p>
      </div>

      <ol className="grid grid-cols-5 gap-1 text-center sm:gap-1.5">
        {ZONE_ORDER.map((zone) => {
          const window = windows.find((w) => w.phase === zone);
          const state = [
            live === zone ? "live" : "",
            previewNs !== null && shown === zone ? "preview" : "",
          ]
            .filter((token) => token !== "")
            .join(" ");
          return (
            <li
              key={zone}
              data-testid="timeline-segment"
              data-phase={zone}
              data-state={state === "" ? "none" : state}
              aria-current={live === zone ? "step" : undefined}
              className="min-w-0 rounded-xl border border-line bg-ink px-0.5 py-2.5 text-muted sm:px-1 data-[state~=live]:border-bone data-[state~=live]:bg-bone data-[state~=live]:text-ink data-[state~=preview]:outline-2 data-[state~=preview]:-outline-offset-4 data-[state~=preview]:outline-bone/70 data-[state~=preview]:outline-dashed"
            >
              <span className="block text-[11px] leading-tight font-medium wrap-anywhere sm:text-[12px]">
                {WINDOW_LABELS[zone]}
              </span>
              {window ? (
                <span className="mt-0.5 block text-[13px] tabular-nums">
                  {formatSpan(window.endNs - window.startNs)}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="grid gap-1">
        <label htmlFor={sliderId} className={EYEBROW}>
          Preview another moment
        </label>
        <input
          id={sliderId}
          type="range"
          min={0}
          max={SCRUB_MAX}
          step={1}
          value={position}
          onChange={(event) => move(Number(event.currentTarget.value))}
          aria-valuetext={valueText}
          className="h-10 w-full cursor-pointer accent-seal"
        />
      </div>

      {previewNs !== null ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p data-testid="preview-status" className="text-sm text-muted">
            Preview: {elapsed(previewNs)}
            {live === "settled" ? " (a what-if: this task is already settled)" : ""}
          </p>
          <button type="button" onClick={() => move(null)} className={SECONDARY}>
            Back to now
          </button>
        </div>
      ) : null}

      <div className="grid gap-1.5 rounded-xl border border-line bg-raised p-4">
        <p className={EYEBROW}>
          {previewNs === null ? "Rule now" : "Rule then"} <span className="text-seal">&gt;</span>
        </p>
        <p data-testid="rule" className="text-xl font-semibold tracking-tight text-bone">
          {rule.headline}
        </p>
        <p className="text-sm text-muted">{rule.detail}</p>
      </div>
    </section>
  );
}
