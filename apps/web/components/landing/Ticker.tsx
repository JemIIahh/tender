"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { config } from "../../lib/config";
import { liveReads } from "../../lib/liveReads";
import { factItems, liveItems, readTicker, type TickerItem } from "../../lib/ticker";

/** Fewer items than this in a copy would leave a gap on a wide screen, so the copy repeats. */
const MIN_ITEMS = 10;

function Item({ item }: { item: TickerItem }) {
  return (
    <li
      data-testid={item.live ? "ticker-live" : "ticker-fact"}
      className="flex shrink-0 items-center gap-2 px-5 whitespace-nowrap"
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${item.live ? "bg-seal" : "bg-dim"}`}
      />
      <span className="text-muted">{item.label}</span>
      <span className={item.asWritten ? "text-bone normal-case" : "text-bone"}>{item.value}</span>
    </li>
  );
}

/**
 * The strip at the foot of the hero: the API's figures (open tasks, the reward they hold, agents,
 * a recent payout, the index), then the facts of the protocol, moving sideways. Until the API
 * answers, and whenever it can't, only the facts are there.
 */
export function Ticker() {
  const [live, setLive] = useState<TickerItem[]>([]);

  // The tab's shared read of the figures (the Live pill's too), read again each minute while the
  // tab is in view; each time it comes, the ticker reads the recent payout to go with it. Only the
  // latest counts.
  useEffect(() => {
    let latest = 0;
    const unsubscribe = liveReads.subscribe((reads) => {
      const mine = ++latest;
      readTicker(reads).then((data) => {
        if (mine === latest) setLive(liveItems(data, config.network));
      });
    });
    return () => {
      latest = -1;
      unsubscribe();
    };
  }, []);

  const items = [...live, ...factItems(config.network)];
  const copy =
    items.length >= MIN_ITEMS
      ? items
      : [...items, ...items.map((item) => ({ ...item, key: `${item.key}-again` }))];

  return (
    <section
      aria-label="Tender right now"
      className="ticker relative border-t border-line bg-ink/85 font-mono text-[11px] tracking-[0.08em] uppercase backdrop-blur-sm"
    >
      <div className="ticker-viewport overflow-hidden">
        <div
          className="ticker-rail flex w-max py-2.5"
          style={{ "--ticker-duration": `${copy.length * 5}s` } as CSSProperties}
        >
          {/* The first copy is read; the second only fills the strip as the first moves out. */}
          <ul className="flex">
            {copy.map((item) => (
              <Item key={item.key} item={item} />
            ))}
          </ul>
          <ul aria-hidden="true" className="flex">
            {copy.map((item) => (
              <Item key={item.key} item={item} />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
