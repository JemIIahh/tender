"use client";

import { useEffect, useId, useRef, useState } from "react";
import { type Live, type LiveState, liveOf, readLive } from "../lib/live";
import { Tokens } from "./account/parts";
import { SECONDARY } from "./ui";

/** How often the figures are read again, while the tab is in view: the landing ticker's pace. */
const REFRESH_MS = 60_000;

/** The pill's size in the top bar: the bar's other pills', and the dot alone on a phone. */
const PILL = "min-h-10 whitespace-nowrap px-3.5 sm:px-4 max-sm:w-10 max-sm:px-0";

const LOOKS: Record<LiveState, { word: string; line: string; dot: string }> = {
  synced: { word: "Live", line: "Up to date", dot: "bg-ok" },
  behind: { word: "Catching up", line: "Catching up with the chain", dot: "bg-wait" },
  // Hollow, so that it differs from the other two by its shape as well as its colour.
  offline: {
    word: "Offline",
    line: "Can't reach Tender right now",
    dot: "border-[1.5px] border-muted",
  },
};

function Dot({ state }: { state: LiveState }) {
  return (
    <span
      aria-hidden="true"
      data-testid="live-dot"
      data-state={state}
      className={`size-2 shrink-0 rounded-full ${LOOKS[state].dot}`}
    />
  );
}

function Figures({ live }: { live: Live }) {
  const counts: Array<[string, string]> = [];
  if (live.openTasks !== undefined) counts.push(["Open tasks", live.openTasks]);
  if (live.agents !== undefined) counts.push(["Agents", live.agents]);
  if (counts.length === 0 && live.escrow === undefined) return null;
  return (
    <dl className="mt-3 grid gap-2.5 border-t border-line pt-3 text-[13px]">
      {counts.map(([label, value]) => (
        <div
          key={label}
          data-testid="live-figure"
          className="flex items-baseline justify-between gap-4"
        >
          <dt className="text-muted">{label}</dt>
          <dd className="font-mono text-bone tabular-nums">{value}</dd>
        </div>
      ))}
      {/* Its own block: an amount can be 39 digits, or in a token the app has no decimals for. */}
      {live.escrow === undefined ? null : (
        <div data-testid="live-figure" className="grid gap-1.5">
          <dt className="text-muted">In escrow on open tasks</dt>
          <dd className="font-mono text-bone tabular-nums wrap-anywhere">
            <Tokens amounts={live.escrow} empty="None" />
          </dd>
        </div>
      )}
    </dl>
  );
}

/**
 * The top bar's Live pill: a dot and a word for whether the index is up to date with the chain
 * (green, Live), still catching up or waiting for the chain (amber, Catching up), or out of reach
 * (hollow, Offline). On a phone it is the dot alone; its name says the word either way.
 *
 * A press opens a small panel under it with the platform's figures, as the API gave them: open
 * tasks, agents, and what the open tasks hold in escrow, token by token. A figure the API did not
 * give is left out. Escape, or a press anywhere else, closes it; Escape gives the focus back to the
 * pill. Until the first read is back there is no pill.
 */
export function LiveStatus() {
  const [live, setLive] = useState<Live | null>(null);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    let gone = false;
    const load = () => {
      readLive().then((reads) => {
        if (!gone) setLive(liveOf(reads));
      });
    };
    load();
    const every = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    return () => {
      gone = true;
      clearInterval(every);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const onPress = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (button.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPress);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPress);
    };
  }, [open]);

  if (live === null) return null;
  const look = LOOKS[live.state];
  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        // The name holds the word the pill shows (WCAG 2.5.3), and says what it is about.
        aria-label={`Status: ${look.word}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((was) => !was)}
        // The keyboard moving on to another control closes it; a press on the panel does not.
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (next !== null && !panel.current?.contains(next)) setOpen(false);
        }}
        className={`${SECONDARY} ${PILL}`}
      >
        <Dot state={live.state} />
        <span className="max-sm:sr-only">{look.word}</span>
      </button>
      {open ? (
        <div
          ref={panel}
          id={panelId}
          data-testid="live-panel"
          className="absolute top-full right-0 z-40 mt-2 w-72 rounded-2xl border border-line bg-panel p-4 text-bone shadow-xl shadow-black/50 max-sm:fixed max-sm:inset-x-4 max-sm:top-[4.5rem] max-sm:mt-0 max-sm:w-auto"
        >
          <p data-testid="live-line" className="flex items-center gap-2.5 text-sm">
            <Dot state={live.state} />
            {look.line}
          </p>
          <Figures live={live} />
        </div>
      ) : null}
    </div>
  );
}
