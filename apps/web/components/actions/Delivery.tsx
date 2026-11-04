"use client";

import { sha256Hex } from "@tender/shared";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { linkHost, safeHref } from "../../lib/links";
import { TEXT_LINK } from "../ui";

type Read =
  | { state: "loading" }
  | { state: "text"; text: string; bytes: number }
  | { state: "missing" }
  | { state: "mismatch" }
  | { state: "error"; message: string };

/** `bytes` as a size a person reads: `812 B`, `3.4 KB`. */
function sizeOf(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * The work an entry revealed, read through Tender's API by its content hash, the hash the entry
 * revealed on chain. The bytes are hashed again here, and shown only if they are what the entry
 * committed to. They are a stranger's: shown as text, never as markup or a link, and set apart so
 * that they are not read as the page's own words. If the API does not serve them, the entry's own
 * address is offered, as the entries list offers it.
 */
export function Delivery({
  account,
  contentHash,
  uri,
}: {
  account: string;
  contentHash: string;
  uri: string | null;
}) {
  const [read, setRead] = useState<Read>({ state: "loading" });

  useEffect(() => {
    let wanted = true;
    setRead({ state: "loading" });
    api.getBlob(contentHash).then(
      (bytes) => {
        if (!wanted) return;
        if (bytes === null) setRead({ state: "missing" });
        else if (sha256Hex(bytes) !== contentHash) setRead({ state: "mismatch" });
        else {
          setRead({
            state: "text",
            text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
            bytes: bytes.length,
          });
        }
      },
      (error) => {
        if (!wanted) return;
        console.error(error);
        setRead({ state: "error", message: errorMessage(error) });
      },
    );
    return () => {
      wanted = false;
    };
  }, [contentHash]);

  if (read.state === "loading") {
    return <p className="text-sm text-muted">Reading the delivery…</p>;
  }
  if (read.state === "text") {
    return (
      <figure className="grid gap-1.5">
        <figcaption className="flex flex-wrap justify-between gap-x-3 text-[12px] text-muted">
          <span>{`Delivered by ${account}, shown as written`}</span>
          <span className="tabular-nums">{`${sizeOf(read.bytes)} · sha256 matches`}</span>
        </figcaption>
        <section
          aria-label={`Delivery of ${account}`}
          // A scroll box of its own: the keyboard has to reach it to scroll it.
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take focus to be scrolled by keyboard
          tabIndex={0}
          className="max-h-64 overflow-auto rounded-xl border border-line bg-ink p-3"
        >
          <pre
            data-testid="delivery"
            className="font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-bone/90 wrap-anywhere"
          >
            {read.text === "" ? "(empty)" : read.text}
          </pre>
        </section>
      </figure>
    );
  }
  const href = uri === null ? undefined : safeHref(uri);
  const fallback =
    href === undefined || uri === null ? null : (
      <>
        {" "}
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          aria-label={`Open content of ${account}`}
          className={TEXT_LINK}
        >
          Open content
        </a>{" "}
        <span className="wrap-anywhere">({linkHost(uri)})</span>
      </>
    );
  const words =
    read.state === "missing"
      ? "Tender's API doesn't serve this delivery."
      : read.state === "mismatch"
        ? "What the API serves for this entry doesn't match the hash it revealed, so it isn't shown."
        : `Couldn't read the delivery. ${read.message}`;
  return (
    <p data-testid="delivery-unavailable" className="text-sm text-muted">
      {words}
      {fallback}
    </p>
  );
}
