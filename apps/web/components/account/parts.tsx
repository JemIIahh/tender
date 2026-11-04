"use client";

import { tokenMeta } from "@tender/shared";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ByToken } from "../../lib/account";
import { config } from "../../lib/config";
import type { Focus } from "../../lib/dither";
import type { ArtName } from "../../lib/scenes";
import type { UseWallet } from "../../lib/wallet";
import { walletErrorMessage } from "../../lib/walletErrors";
import { Amount } from "../Amount";
import { StillArt } from "../StillArt";
import { CARD, EYEBROW, FACT_LABEL, PRIMARY, SECONDARY } from "../ui";

// The pieces the account pages (My agents, Add an agent, Earnings) are built from, in the app's
// look: the state a page has before a wallet is connected, the stat blocks, the boxed empty state,
// a command to copy, and amounts listed token by token.

/** A card with one of the landing's arts behind its words, fading into the panel from the left. */
export function ArtCard({
  art,
  focus,
  children,
  testId,
}: {
  art: ArtName;
  focus: Focus;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`${CARD} relative isolate grid min-h-[24rem] content-end justify-items-start gap-4 overflow-hidden p-6 sm:min-h-72 sm:p-8`}
    >
      <StillArt art={art} focus={focus} className="absolute inset-0 -z-10 size-full" />
      <div aria-hidden="true" className="scanlines absolute inset-0 -z-10" />
      {/* On a phone the words are under the art, on a wider screen beside it: the ground under
          them is solid either way. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-linear-to-t from-panel from-50% via-panel/80 via-65% to-panel/10 sm:bg-linear-to-r sm:from-panel sm:from-0% sm:via-panel/85 sm:via-50% sm:to-panel/10"
      />
      {children}
    </div>
  );
}

/**
 * The page before it knows the account: "Checking for your wallet…" while the wallet from an
 * earlier visit is looked for, a card that asks to connect one when there is none, and the page
 * (`children`) once there is. The Connect button stays the same button while it waits, so that
 * the person who pressed it keeps their place.
 */
export function ConnectGate({
  wallet,
  why,
  art,
  children,
}: {
  wallet: Pick<UseWallet, "ready" | "accountId" | "connect">;
  /** What connecting shows, in a sentence. */
  why: string;
  art: ArtName;
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
    <ArtCard art={art} focus={{ x: 0.72, y: 0.3, scale: 0.36 }} testId="connect-gate">
      <p className={EYEBROW}>
        Not connected <span className="text-seal">&gt;</span>
      </p>
      <h2 className="max-w-md text-2xl font-semibold tracking-tight text-bone sm:text-3xl">
        Connect your wallet
      </h2>
      <p className="max-w-md text-[15px] leading-relaxed text-muted">{why}</p>
      <button type="button" aria-disabled={waiting} onClick={connect} className={PRIMARY}>
        {waiting ? "Waiting for your wallet…" : "Connect wallet"}
      </button>
      {failed === null ? null : (
        <p role="alert" className="max-w-md text-sm text-seal">
          {failed}
        </p>
      )}
    </ArtCard>
  );
}

/** Whether the app knows `token`'s decimals, so that its amounts read as figures. */
const known = (token: string) => tokenMeta(token, config.network).symbol !== token;

/**
 * Amounts token by token, one to a line, the tokens the app knows first (their amounts read as
 * figures; another token's is in its smallest unit, with its account); `empty` when there are none.
 */
export function Tokens({ amounts, empty = "—" }: { amounts: ByToken; empty?: string }) {
  // Faded from the colour around it, so that it reads on the cream block as on the dark ones.
  if (amounts.length === 0) return <span className="opacity-70">{empty}</span>;
  const ordered = [...amounts].sort(([a], [b]) => Number(known(b)) - Number(known(a)));
  return (
    <ul className="grid gap-1">
      {ordered.map(([token, amount]) => (
        <li key={token} className="min-w-0 wrap-anywhere">
          <Amount value={amount.toString()} token={token} />
        </li>
      ))}
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
      <dt
        className={`font-mono text-[10.5px] tracking-[0.14em] uppercase ${light ? "text-neutral-700" : "text-muted"}`}
      >
        {label}
      </dt>
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

/** A chip with a dot, in mono capitals, as the phase chip is. */
export function Chip({ children, dot = "bg-current" }: { children: ReactNode; dot?: string }) {
  return (
    <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-current/25 px-2.5 py-1 font-mono text-[10.5px] leading-none tracking-[0.12em] whitespace-nowrap uppercase">
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      {children}
    </span>
  );
}
