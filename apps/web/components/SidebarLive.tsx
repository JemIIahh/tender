"use client";

import { formatTokenAmount, tokenMeta } from "@tender/shared";
import Link from "next/link";
import { useId } from "react";
import { config } from "../lib/config";
import { knownFirst, knowsToken } from "../lib/tokens";
import { Dot, LOOKS, useLive } from "./LiveStatus";
import type { TipHandlers } from "./Nav";

/** How the words of the rail fade, as the sidebar's links fade (components/Nav.tsx). */
const FADE = "transition-opacity duration-200 motion-reduce:transition-none";

/**
 * The sidebar's Live block, pinned under its links: whether the index is up to date, and three of
 * the platform's figures (open tasks, agents, and what the open tasks lock in the contract), from
 * the same shared read as the top bar's status (`useLive`), so it asks the API for nothing more.
 * A figure the API did not give is left out, and so is an amount in a token the app has no
 * decimals for. "All metrics" leads to the Metrics page. On the rail it is the dot and the link.
 */
export function SidebarLive({ tip }: { tip?: (label: string) => TipHandlers }) {
  const live = useLive();
  const titleId = useId();
  const figures: Array<[string, string]> = [];
  if (live?.openTasks !== undefined) figures.push(["Open tasks", live.openTasks]);
  if (live?.agents !== undefined) figures.push(["Agents", live.agents]);
  for (const [token, amount] of knownFirst(live?.escrow ?? [], ([one]) => one)) {
    if (!knowsToken(token)) continue;
    const { symbol, decimals } = tokenMeta(token, config.network);
    figures.push(["Locked", `${formatTokenAmount(amount, decimals)} ${symbol}`]);
  }
  return (
    <section
      aria-labelledby={titleId}
      data-testid="sidebar-live"
      className="grid shrink-0 grid-cols-1 gap-3 overflow-hidden border-t border-line pt-4"
    >
      <p
        id={titleId}
        className="flex items-center gap-2.5 overflow-hidden px-3 text-[11px] font-medium tracking-[0.08em] whitespace-nowrap text-muted uppercase lg:rail:pl-4"
      >
        {live === null ? (
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-dim" />
        ) : (
          <Dot state={live.state} />
        )}
        <span className={`${FADE} lg:rail:opacity-0`}>
          {live === null ? "Live" : LOOKS[live.state].word}
        </span>
      </p>
      {figures.length === 0 ? null : (
        <dl className={`grid gap-1.5 px-3 text-[13px] ${FADE} lg:rail:hidden`}>
          {figures.map(([label, value]) => (
            <div
              key={`${label}:${value}`}
              data-testid="sidebar-figure"
              className="flex min-w-0 items-baseline justify-between gap-3"
            >
              <dt className="truncate text-muted">{label}</dt>
              <dd className="shrink-0 font-mono text-bone tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <Link
        href="/metrics"
        aria-label="All metrics"
        {...tip?.("All metrics")}
        className="flex min-h-9 items-center gap-3 overflow-hidden rounded-xl px-3 text-[13px] whitespace-nowrap text-muted transition-colors hover:bg-raised/60 hover:text-bone motion-reduce:transition-none"
      >
        {/* A line rising over two axes: the link's mark on the rail, where its words fade out. */}
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className="hidden size-4 shrink-0 lg:rail:block"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 2.5v11h11" />
          <path d="M5 10.2l2.6-3.1 2.2 1.8L13 4.8" />
        </svg>
        <span className={`${FADE} lg:rail:opacity-0`}>All metrics &rarr;</span>
      </Link>
    </section>
  );
}
