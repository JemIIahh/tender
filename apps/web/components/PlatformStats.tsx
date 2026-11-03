"use client";

import { useEffect, useState } from "react";
import { config } from "../lib/config";
import { liveItems, readStats, type TickerItem } from "../lib/ticker";

/** How often the figures are read again, while the tab is in view: the landing ticker's pace. */
const REFRESH_MS = 60_000;

/**
 * A few live figures of the platform, at the foot of the sidebar: the same ones the landing's
 * ticker reads from the API (lib/ticker.ts), each shown as the API gave it. A figure the API did
 * not give is left out, and with none there is no block at all: nothing is made up to fill it.
 */
export function PlatformStats() {
  const [items, setItems] = useState<TickerItem[]>([]);

  useEffect(() => {
    let gone = false;
    const load = () => {
      readStats().then((data) => {
        if (!gone) setItems(liveItems(data, config.network));
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

  if (items.length === 0) return null;
  return (
    <div data-testid="platform-stats" className="grid gap-3 border-t border-line px-3 pt-5">
      <p className="flex items-center gap-2 font-mono text-[10.5px] tracking-[0.16em] text-muted uppercase">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-seal" />
        Live on Tender
      </p>
      <dl className="grid gap-2 text-xs">
        {items.map((item) => (
          <div
            key={item.key}
            data-testid="stat"
            className="flex items-baseline justify-between gap-3"
          >
            <dt className="text-muted">{item.label}</dt>
            <dd className="text-right font-mono text-bone tabular-nums wrap-anywhere">
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
