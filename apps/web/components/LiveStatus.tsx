"use client";

import { formatTokenAmount, tokenMeta } from "@tender/shared";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { config } from "../lib/config";
import { type Live, type LiveState, liveOf, liveReads } from "../lib/live";
import { scrollCue } from "../lib/scrollCue";
import { knownFirst, knowsToken } from "../lib/tokens";
import { RawUnits } from "./Amount";
import { SCROLL_CUE, TEXT_LINK } from "./ui";

/**
 * The segment's size in the top bar's account group (components/AccountPill.tsx): the group's
 * height, and the dot alone on a phone.
 */
const SEGMENT =
  "inline-flex h-10 items-center justify-center gap-2 rounded-l-full pr-3.5 pl-4 text-[13px] whitespace-nowrap text-bone transition-colors hover:bg-raised/60 motion-reduce:transition-none max-sm:w-10 max-sm:px-0";

/** The network this build is for, as the top bar names it. */
export function networkName(): string {
  return config.network === "sandbox"
    ? "Local chain"
    : `${config.network.charAt(0).toUpperCase()}${config.network.slice(1)}`;
}

export const LOOKS: Record<LiveState, { word: string; line: string; dot: string }> = {
  synced: { word: "Live", line: "Up to date", dot: "bg-ok" },
  behind: { word: "Updating", line: "Some numbers may be a few minutes old.", dot: "bg-wait" },
  // Hollow, so that it differs from the other two by its shape as well as its colour.
  offline: {
    word: "Offline",
    line: "Can't reach Tender right now",
    dot: "border-[1.5px] border-muted",
  },
};

export function Dot({ state }: { state: LiveState }) {
  return (
    <span
      aria-hidden="true"
      data-testid="live-dot"
      data-state={state}
      className={`size-2 shrink-0 rounded-full ${LOOKS[state].dot}`}
    />
  );
}

/**
 * One token's amount in escrow, on a line of its own. A number never breaks: it is one unbroken
 * run of figures (the panel is wide enough for the largest u128 at this size). A token the app
 * knows has its symbol after the number. One it does not know shows the amount as the contract
 * holds it, labelled, and cut in the middle with a visible "…" on a line too narrow for it, as a
 * board card shows it (`RawUnits`).
 */
function EscrowLine({ token, amount }: { token: string; amount: bigint }) {
  if (!knowsToken(token)) {
    return (
      <li data-testid="live-escrow" className="grid min-w-0 text-[12px] text-bone">
        <RawUnits
          value={amount.toString()}
          token={token}
          amountTestId="live-escrow-amount"
          unitTestId="live-escrow-unit"
        />
      </li>
    );
  }
  const { symbol, decimals } = tokenMeta(token, config.network);
  return (
    <li data-testid="live-escrow" className="grid min-w-0 gap-0.5">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 font-mono text-[12px] text-bone tabular-nums">
        <span
          ref={scrollCue}
          data-testid="live-escrow-amount"
          className={`inline-block max-w-full overflow-x-auto align-bottom whitespace-nowrap ${SCROLL_CUE}`}
        >
          {formatTokenAmount(amount, decimals)}
        </span>{" "}
        <span className="whitespace-nowrap">{symbol}</span>
      </span>
    </li>
  );
}

function Figures({ live }: { live: Live }) {
  const counts: Array<[string, string]> = [];
  if (live.openTasks !== undefined) counts.push(["Open tasks", live.openTasks]);
  if (live.agents !== undefined) counts.push(["Agents", live.agents]);
  if (counts.length === 0 && live.escrow === undefined) return null;
  // The tokens the app knows first, as `Tokens` orders them.
  const escrow = knownFirst(live.escrow ?? [], ([token]) => token);
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
 * The platform's figures and whether the index is up to date, from the tab's one shared read of
 * them (`liveReads`), read again each minute while the tab is in view: null until the first read
 * is back. The top bar's status and the sidebar's Live block both take it, and make one read.
 */
export function useLive(): Live | null {
  const [live, setLive] = useState<Live | null>(null);
  useEffect(
    () =>
      liveReads.subscribe((reads) => {
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
      }),
    [],
  );
  return live;
}

/**
 * The top bar's status, the first part of its account group: a dot for whether the index is up to
 * date with the chain
 * (green, Live: 30 blocks behind its final block or fewer, about 30 seconds), still catching up or
 * waiting for the chain (amber, Updating), or out of reach (hollow, Offline), and the network's
 * name. Its accessible name and its tooltip say the state's word. On a phone it is the dot alone.
 *
 * A press opens a small panel under it with the platform's figures, as the API gave them: open
 * tasks, agents, and what the open tasks hold in escrow, token by token, and a link to the Metrics
 * page. A figure the API did not give is left out. Escape, or a press anywhere else, closes it;
 * Escape gives the focus back to the pill. Until the first read is back it is the network's name
 * alone, with no state and nothing to press.
 */
export function LiveStatus() {
  const live = useLive();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

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

  if (live === null) {
    return (
      <span data-testid="live-waiting" className={`${SEGMENT} hover:bg-transparent`}>
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-dim" />
        <span className="max-sm:sr-only">{networkName()}</span>
      </span>
    );
  }
  const look = LOOKS[live.state];
  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        // The name says the state, which the dot and the tooltip show, and holds the word the
        // segment shows, the network's (WCAG 2.5.3).
        aria-label={`Status: ${look.word} (${networkName()})`}
        title={`${look.word}: ${look.line}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((was) => !was)}
        // The keyboard moving on to another control closes it; a press on the panel does not.
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (next !== null && !panel.current?.contains(next)) setOpen(false);
        }}
        className={SEGMENT}
      >
        <Dot state={live.state} />
        <span className="max-sm:hidden">{networkName()}</span>
      </button>
      {/* Always in the page, so that `aria-controls` names an element; `hidden` while closed. On
          a phone it is fixed to the screen, under the top bar and across it with a gutter at each
          side; nothing around it is a box that a fixed part is placed in (AppShell's top bar keeps
          its blur on a layer of its own for that). */}
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
        {/* The way on to the platform's figures in full. The keyboard leaving the panel closes it,
            as leaving the pill does; following the link closes it too. */}
        <p className="mt-3 border-t border-line pt-3 text-[13px]">
          <Link
            href="/metrics"
            data-testid="live-metrics-link"
            onClick={() => setOpen(false)}
            onBlur={(event) => {
              const next = event.relatedTarget as Node | null;
              if (next !== null && next !== button.current && !panel.current?.contains(next)) {
                setOpen(false);
              }
            }}
            className={TEXT_LINK}
          >
            See metrics
          </Link>
        </p>
      </div>
    </div>
  );
}
