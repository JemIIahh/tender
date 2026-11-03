"use client";

import { useEffect, useState } from "react";

// An agent's two calls to Tender's MCP server (packages/mcp/src/tools/write.ts), with the tools'
// real names and fields, typed out at the foot of the hero. The hash is cut short, and what a call
// gives back that would be a real value is left as "…".

type Tone = "mark" | "tool" | "key" | "text" | "note";

const LINES: ReadonlyArray<ReadonlyArray<readonly [Tone, string]>> = [
  [
    ["mark", "> "],
    ["tool", "tender.commit_result"],
    ["text", "({"],
  ],
  [
    ["key", "    task_id"],
    ["text", ': "7", '],
    ["key", "content"],
    ["text", ': "<your result>" })'],
  ],
  [
    ["mark", "< "],
    ["text", "{ "],
    ["key", "commitment"],
    ["text", ': "9c1e…4b07",'],
  ],
  [
    ["key", "    reveal_opens_at"],
    ["text", ': "…" }'],
  ],
  [["note", "  // on chain: a hash. on your disk: the work."]],
  [
    ["mark", "> "],
    ["tool", "tender.reveal_result"],
    ["text", '({ task_id: "7" })'],
  ],
  [
    ["mark", "< "],
    ["text", "{ "],
    ["key", "uri"],
    ["text", ': "…/v1/blobs/…", '],
    ["key", "tx_hash"],
    ["text", ': "…" }'],
  ],
  [["note", "  // scored on the checks, paid by the contract"]],
];

const TONES: Record<Tone, string> = {
  mark: "text-seal",
  tool: "text-bone",
  key: "text-bone/80",
  text: "text-muted",
  note: "text-dim",
};

const TOTAL = LINES.reduce(
  (sum, line) => sum + line.reduce((n, [, text]) => n + text.length, 0),
  0,
);
/** Milliseconds a character, the pause at the end of a line, and how long the whole stays up. */
const CHAR_MS = 24;
const LINE_MS = 320;
const HOLD_MS = 6000;

/** Whether `typed` characters end exactly at the end of a line. */
function atLineEnd(typed: number): boolean {
  let at = 0;
  for (const line of LINES) {
    at += line.reduce((n, [, text]) => n + text.length, 0);
    if (at === typed) return true;
    if (at > typed) return false;
  }
  return false;
}

const Caret = () => <span className="caret bg-bone/80">&nbsp;</span>;

/**
 * The code with the first `typed` characters shown, and the rest kept in place but unseen, so the
 * block has its full size from the start. The caret stands on the next character to come.
 */
function Lines({ typed, caret }: { typed: number; caret: boolean }) {
  let left = typed;
  let placed = !caret;
  return LINES.map((line, row) => {
    const parts = line.map(([tone, text], part) => {
      const shown = Math.min(text.length, Math.max(0, left));
      left -= text.length;
      const here = !placed && shown < text.length;
      if (here) placed = true;
      return (
        // The code never changes: a part's place is its key.
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
        <span key={part}>
          <span className={TONES[tone]}>{text.slice(0, shown)}</span>
          {here ? <Caret /> : null}
          <span className="invisible">{text.slice(shown + (here ? 1 : 0))}</span>
        </span>
      );
    });
    const last = row === LINES.length - 1;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
      <div key={row}>
        {parts}
        {last && !placed ? <Caret /> : null}
      </div>
    );
  });
}

export function TypedCode({ className }: { className?: string }) {
  // Everything, until the page is in the browser: the server's page and a page with reduced
  // motion show the code whole.
  const [typed, setTyped] = useState(TOTAL);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    setMoving(true);
    let timer: ReturnType<typeof setTimeout>;
    let count = 0;
    const step = () => {
      if (count >= TOTAL) {
        timer = setTimeout(() => {
          count = 0;
          setTyped(0);
          timer = setTimeout(step, 500);
        }, HOLD_MS);
        return;
      }
      count++;
      setTyped(count);
      timer = setTimeout(step, atLineEnd(count) ? LINE_MS : CHAR_MS);
    };
    setTyped(0);
    timer = setTimeout(step, 600);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className={className}>
      <p className="sr-only">
        An agent's two calls to Tender: commit_result puts a hash of its answer on chain, and
        reveal_result shows the answer once the commit window has closed.
      </p>
      <pre aria-hidden="true" className="font-mono whitespace-pre">
        <Lines typed={typed} caret={moving} />
      </pre>
    </div>
  );
}
