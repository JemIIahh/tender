"use client";

import { formatTokenAmount, tokenMeta } from "@tender/shared";
import { useEffect, useId, useRef, useState } from "react";
import { config } from "../lib/config";
import { type Live, type LiveState, liveOf, readLive } from "../lib/live";
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

/** A long id with its middle left out, `5f3a9c0e…5f3a9c0e`; a short one as it is. */
function shortId(id: string): string {
  return id.length <= 20 ? id : `${id.slice(0, 8)}…${id.slice(-8)}`;
}

/**
 * One token's amount in escrow, on a line of its own. A number never breaks: it is one unbroken
 * run of figures (the panel is wide enough for the largest u128 at this size, and it scrolls
 * sideways on its own line before it would wrap). A token the app knows has its symbol after the
 * number. One it does not know (`tokenMeta` never guesses decimals) shows the amount as the
 * contract holds it, with a label under it that says so, "smallest units of" and the token's
 * account, its middle left out when it is long; the whole id is the label's title, and is what a
 * screen reader reads.
 */
function EscrowLine({ token, amount }: { token: string; amount: bigint }) {
  const { symbol, decimals } = tokenMeta(token, config.network);
  const known = symbol !== token;
  const short = shortId(token);
  return (
    <li data-testid="live-escrow" className="grid min-w-0 gap-0.5">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 font-mono text-[12px] text-bone tabular-nums">
        <span
          data-testid="live-escrow-amount"
          className="inline-block max-w-full overflow-x-auto align-bottom whitespace-nowrap"
        >
          {known ? formatTokenAmount(amount, decimals) : amount.toString()}
        </span>
        {known ? (
          <>
            {" "}
            <span className="whitespace-nowrap">{symbol}</span>
          </>
        ) : null}
      </span>
      {known ? null : (
        <span data-testid="live-escrow-unit" className="text-[11.5px] text-muted">
          smallest units of{" "}
          {short === token ? (
            <span className="font-mono">{token}</span>
          ) : (
            <span title={token} className="font-mono">
              <span aria-hidden="true">{short}</span>
              <span className="sr-only">{token}</span>
            </span>
          )}
        </span>
      )}
    </li>
  );
}

/** Whether the app knows `token`'s decimals: those lines go first, as `Tokens` orders them. */
const knows = (token: string) => tokenMeta(token, config.network).symbol !== token;

function Figures({ live }: { live: Live }) {
  const counts: Array<[string, string]> = [];
  if (live.openTasks !== undefined) counts.push(["Open tasks", live.openTasks]);
  if (live.agents !== undefined) counts.push(["Agents", live.agents]);
  if (counts.length === 0 && live.escrow === undefined) return null;
  const escrow = [...(live.escrow ?? [])].sort(([a], [b]) => Number(knows(b)) - Number(knows(a)));
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
          <dd>
            {escrow.length === 0 ? (
              <span className="text-bone">None</span>
            ) : (
              <ul className="grid gap-2">
                {escrow.map(([token, amount]) => (
                  <EscrowLine key={token} token={token} amount={amount} />
                ))}
              </ul>
            )}
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
        if (gone) return;
        // A read the page can't make sense of leaves a state that is true, not the last one: the
        // API answered, so it is not offline, but the index can't be said to be up to date.
        let next: Live;
        try {
          next = liveOf(reads);
        } catch (error) {
          console.error(error);
          next = { state: reads.answered ? "behind" : "offline" };
        }
        setLive(next);
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
      {/* Always in the page, so that `aria-controls` names an element; `hidden` while closed. */}
      <div
        ref={panel}
        id={panelId}
        hidden={!open}
        data-testid="live-panel"
        className="absolute top-full right-0 z-40 mt-2 w-[21rem] rounded-2xl border border-line bg-panel p-4 text-bone shadow-xl shadow-black/50 max-sm:fixed max-sm:inset-x-4 max-sm:top-[4.5rem] max-sm:mt-0 max-sm:w-auto"
      >
        <p data-testid="live-line" className="flex items-center gap-2.5 text-sm">
          <Dot state={live.state} />
          {look.line}
        </p>
        <Figures live={live} />
      </div>
    </div>
  );
}
