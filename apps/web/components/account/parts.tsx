"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ByToken } from "../../lib/account";
import { UNTITLED_TASK } from "../../lib/copy";
import { knownFirst, knowsToken } from "../../lib/tokens";
import type { UseWallet } from "../../lib/wallet";
import { walletErrorMessage } from "../../lib/walletErrors";
import { Amount, RawUnits } from "../Amount";
import { EmptyState } from "../EmptyState";
import { EYEBROW, FACT_LABEL, PRIMARY, SECONDARY, TEXT_LINK } from "../ui";

// The pieces the account pages (My agents, Add an agent, Earnings) are built from, in the app's
// look: the state a page has before a wallet is connected, the stat blocks, the boxed empty state,
// a command to copy, and amounts listed token by token.

/**
 * The page before it knows the account: "Checking for your wallet…" while the wallet from an
 * earlier visit is looked for, a card that asks to connect one when there is none, and the page
 * (`children`) once there is. The Connect button stays the same button while it waits, so that
 * the person who pressed it keeps their place.
 */
export function ConnectGate({
  wallet,
  why,
  children,
}: {
  wallet: Pick<UseWallet, "ready" | "accountId" | "connect">;
  /** What connecting shows, in a sentence. */
  why: string;
  children: (accountId: string) => ReactNode;
}) {
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (!wallet.ready) {
    return (
      <p role="status" className={EYEBROW}>
        Checking for your wallet…
      </p>
    );
  }
  if (wallet.accountId !== null) return <>{children(wallet.accountId)}</>;
  const connect = async () => {
    if (waiting) return;
    setWaiting(true);
    setFailed(null);
    try {
      await wallet.connect();
    } catch (error) {
      console.error(error);
      setFailed(walletErrorMessage(error));
    } finally {
      setWaiting(false);
    }
  };
  return (
    <EmptyState
      testId="connect-gate"
      heading="h2"
      title="Connect your wallet"
      action={
        <button type="button" aria-disabled={waiting} onClick={connect} className={PRIMARY}>
          {waiting ? "Waiting for your wallet…" : "Connect wallet"}
        </button>
      }
    >
      <p>{why}</p>
      {failed === null ? null : (
        <p role="alert" className="mt-2 text-sm text-seal">
          {failed}
        </p>
      )}
    </EmptyState>
  );
}

/**
 * Amounts token by token, one to a line, the tokens the app knows first (their amounts read as
 * figures; another token's is in its smallest unit, with its account); `empty` when there are none.
 * `labelled`: another token's amount is labelled as the Live panel and a board card label it
 * (`RawUnits`), its number never broken, instead of being followed by the token's account.
 */
export function Tokens({
  amounts,
  empty = "—",
  labelled = false,
}: {
  amounts: ByToken;
  empty?: string;
  labelled?: boolean;
}) {
  // Faded from the colour around it, so that it reads on the cream block as on the dark ones.
  if (amounts.length === 0) return <span className="opacity-70">{empty}</span>;
  const ordered = knownFirst(amounts, ([token]) => token);
  return (
    <ul className="grid gap-1">
      {ordered.map(([token, amount]) =>
        labelled && !knowsToken(token) ? (
          <li key={token} className="min-w-0 text-[13px] leading-snug">
            <RawUnits value={amount.toString()} token={token} />
          </li>
        ) : (
          <li key={token} className="min-w-0 wrap-anywhere">
            <Amount value={amount.toString()} token={token} />
          </li>
        ),
      )}
    </ul>
  );
}

/**
 * A stat block: a label in mono capitals, the figure, and a line that says what it is. `light` is
 * the page's one cream block, for the figure the page is about.
 */
export function Stat({
  label,
  children,
  sub,
  light = false,
  testId,
}: {
  label: string;
  children: ReactNode;
  sub?: ReactNode;
  light?: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`grid min-w-0 content-start gap-3 rounded-2xl border p-5 ${
        light ? "on-paper border-transparent bg-paper text-ink" : "border-line bg-panel text-bone"
      }`}
    >
      <dt className={`text-[13px] ${light ? "text-neutral-700" : "text-muted"}`}>{label}</dt>
      <dd className="grid gap-2">
        <div className="text-xl leading-tight font-medium tracking-[-0.02em] tabular-nums wrap-anywhere sm:text-2xl [&_.font-mono]:text-xs">
          {children}
        </div>
        {sub === undefined ? null : (
          <p className={`text-[13px] leading-snug ${light ? "text-neutral-700" : "text-muted"}`}>
            {sub}
          </p>
        )}
      </dd>
    </div>
  );
}

/** Stat blocks side by side: two to a row, up to `columns` on a wide screen. */
export function Stats({
  children,
  label,
  columns = 4,
}: {
  children: ReactNode;
  label: string;
  columns?: 3 | 4 | 5;
}) {
  const wide = { 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 5: "lg:grid-cols-3 xl:grid-cols-5" }[
    columns
  ];
  return (
    // Two to a row until the wide screen: a block left alone at the end of an odd count takes the
    // whole row.
    <dl
      aria-label={label}
      className={`grid grid-cols-2 gap-3 sm:gap-4 max-lg:[&>*:last-child:nth-child(odd)]:col-span-2 ${wide}`}
    >
      {children}
    </dl>
  );
}

/**
 * A command to run in a terminal, as it is to be typed, with a button that copies it. The command
 * is text on the page whether or not the copy works: a browser that won't let the page write to
 * the clipboard leaves it to be selected by hand.
 */
export function Command({
  command,
  label,
  account,
  prompt = true,
  testId = "command",
}: {
  command: string;
  label: string;
  /** The account the command is run as, shown after the label as it is written (lower case). */
  account?: string;
  /** Whether a `$` prompt goes before it: not for words to say to an agent. */
  prompt?: boolean;
  testId?: string;
}) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(command);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
    timer.current = setTimeout(() => setCopied(null), 2500);
  };
  return (
    <div className="grid min-w-0 gap-2">
      <p className={`${FACT_LABEL} wrap-anywhere`}>
        {label}
        {account === undefined ? null : (
          <>
            , as{" "}
            <span data-testid="command-account" className="tracking-normal text-bone normal-case">
              {account}
            </span>
          </>
        )}
      </p>
      <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-ink p-3 sm:flex-row sm:items-center sm:pl-4">
        <code
          data-testid={testId}
          className="min-w-0 flex-1 font-mono text-[13px] leading-relaxed text-bone wrap-anywhere"
        >
          {prompt ? (
            <span aria-hidden="true" className="text-seal select-none">
              ${" "}
            </span>
          ) : null}
          {command}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy: ${label}`}
          className={`${SECONDARY} min-h-10 shrink-0 px-4`}
        >
          {copied === "yes" ? "Copied" : "Copy"}
        </button>
      </div>
      <p role="status" className="sr-only">
        {copied === "yes" ? "Copied." : copied === "no" ? "Couldn't copy: select the command." : ""}
      </p>
      {copied === "no" ? (
        <p className="text-sm text-muted">The browser didn't allow copying: select the command.</p>
      ) : null}
    </div>
  );
}

// ---- Rows read as a table (Earnings, My tasks) ---------------------------------------------

/**
 * A list read as a table: the column heads above it from tablet width up, and on a phone each
 * value with its head beside it. The heads are in every row for a screen reader.
 */
export function Rows({
  heads,
  grid,
  testId,
  children,
}: {
  heads: string[];
  /** The columns, as a literal Tailwind class from `md` up. */
  grid: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div className="grid">
      <div
        aria-hidden="true"
        className={`hidden gap-6 border-b border-line px-5 pt-4 pb-3 sm:px-6 md:grid ${grid}`}
      >
        {heads.map((head, index) => (
          <span
            key={head}
            className={`${FACT_LABEL} ${index === heads.length - 1 ? "md:text-right" : ""}`}
          >
            {head}
          </span>
        ))}
      </div>
      <ul data-testid={testId} className="grid">
        {children}
      </ul>
    </div>
  );
}

/** One row of `Rows`: its cells side by side from tablet width up, stacked on a phone. */
export const ROW =
  "grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 border-t border-line px-5 py-4 first:border-t-0 sm:px-6 md:items-center md:gap-6";

/** A cell, with its column's head for a phone and a screen reader. */
export function Cell({
  head,
  children,
  end = false,
  lead = false,
}: {
  head: string;
  children: ReactNode;
  end?: boolean;
  /** The row's first cell, what the row is about: the whole width of a phone, with no head shown. */
  lead?: boolean;
}) {
  return (
    <div
      className={`grid min-w-0 content-start gap-1 md:block ${lead ? "col-span-2 md:col-span-1" : ""} ${end ? "md:text-right" : ""}`}
    >
      <span className={`${FACT_LABEL} ${lead ? "sr-only" : "md:sr-only"}`}>{head}: </span>
      <div className="min-w-0 wrap-anywhere">{children}</div>
    </div>
  );
}

export function TaskCell({ taskId, title }: { taskId: string; title: string | null }) {
  return (
    <span className="grid gap-0.5">
      <Link href={`/tasks/${taskId}`} className={`${TEXT_LINK} w-fit font-medium wrap-anywhere`}>
        {title ?? UNTITLED_TASK}
      </Link>
      <span className="font-mono text-xs text-muted">#{taskId}</span>
    </span>
  );
}

/** A chip with a dot, in mono capitals, as the phase chip is. */
export function Chip({ children, dot = "bg-current" }: { children: ReactNode; dot?: string }) {
  return (
    <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-current/25 px-2.5 py-1 font-mono text-[10.5px] leading-none tracking-[0.12em] whitespace-nowrap uppercase">
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      {children}
    </span>
  );
}
