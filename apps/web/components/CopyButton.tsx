"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A small button that copies `value` (an account, a hash) to the clipboard, named `label`. A tick
 * shows for a moment once it is copied, and a screen reader is told; a browser that won't let the
 * page write to the clipboard leaves the value to be selected by hand, and says so in the title.
 */
export function CopyButton({
  value,
  label,
  className = "",
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
    timer.current = setTimeout(() => setCopied(null), 2000);
  };
  return (
    <button
      type="button"
      aria-label={label}
      title={copied === "no" ? "The browser didn't allow copying" : label}
      onClick={copy}
      className={`grid size-8 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-raised hover:text-bone motion-reduce:transition-none ${className}`}
    >
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {copied === "yes" ? (
          <path d="M3.5 8.5l3 3 6-7" />
        ) : (
          <>
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
            <path d="M10.5 5.5V3.8c0-.7-.6-1.3-1.3-1.3H3.8c-.7 0-1.3.6-1.3 1.3v5.4c0 .7.6 1.3 1.3 1.3h1.7" />
          </>
        )}
      </svg>
      <span aria-live="polite" className="sr-only">
        {copied === "yes" ? "Copied" : copied === "no" ? "Couldn't copy" : ""}
      </span>
    </button>
  );
}
