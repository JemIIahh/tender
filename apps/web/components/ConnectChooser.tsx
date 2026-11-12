"use client";

import { type KeyboardEvent, useEffect, useId, useRef } from "react";
import { type Chooser, chooser as pageChooser, useChooserState } from "../lib/chooser";
import { config } from "../lib/config";
import {
  GIFT_PROBLEM_WAYS,
  GIFT_PROBLEM_WORDS,
  type GiftProblem,
  TESTNET_FAUCET_URL,
} from "../lib/gasGift";
import { shortId } from "../lib/tokens";
import { CopyButton } from "./CopyButton";
import { CARD, PANEL_TITLE, PRIMARY, SECONDARY } from "./ui";

// The Connect chooser, in a build with the email and Google login (lib/chooser.ts has the steps).
// One big action, the login, and under it the NEAR wallets. After a login it shows the one line
// "Getting your account ready…" while Tender sends the new account NEAR for its fees, and, if that
// is refused or doesn't arrive, one line that says so, with Try again where trying again can help
// and the faucet, with the account to copy, where Tender won't send.
//
// It is a modal of the page's own: the focus goes into it and stays there, Escape and the backdrop
// close it, and the focus goes back to where it was when it closes.

const FOCUSABLE = 'a[href], button:not([aria-disabled="true"])';

/** Keeps Tab and Shift+Tab inside `panel`. */
function trapTab(event: KeyboardEvent<HTMLDivElement>, panel: HTMLElement | null): void {
  if (event.key !== "Tab" || panel === null) return;
  const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = items[0];
  const last = items.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** What is in the way of the account's NEAR for fees, and the ways on. */
function Stuck({
  accountId,
  problem,
  firstRef,
  onRetry,
}: {
  accountId: string;
  problem: GiftProblem;
  firstRef: (element: HTMLElement | null) => void;
  onRetry: () => void;
}) {
  const ways = GIFT_PROBLEM_WAYS[problem];
  // The faucet is testnet's; elsewhere the person is told to send the account some NEAR.
  const faucetLink = ways.faucet && config.network === "testnet";
  return (
    <div className="grid gap-4">
      <p role="status" data-testid="account-stuck" className="text-[15px] text-bone">
        {GIFT_PROBLEM_WORDS[problem]}
      </p>
      {ways.faucet ? (
        <div className="grid gap-2">
          <p className="text-sm text-muted">
            {faucetLink
              ? "Get free testnet NEAR for this account at the faucet:"
              : "Send this account a little NEAR to pay its fees:"}
          </p>
          <p className="flex min-w-0 items-center justify-between gap-2 rounded-xl border border-line bg-ink py-1 pr-1 pl-3">
            <span
              title={accountId}
              data-testid="stuck-account"
              className="min-w-0 truncate font-mono text-[13px] text-bone"
            >
              {shortId(accountId)}
            </span>
            <CopyButton value={accountId} label="Copy account" />
          </p>
        </div>
      ) : null}
      {faucetLink || ways.retry ? (
        <div className="flex flex-wrap gap-2">
          {faucetLink ? (
            <a
              ref={firstRef}
              href={TESTNET_FAUCET_URL}
              target="_blank"
              rel="noreferrer"
              className={PRIMARY}
            >
              Open the faucet
            </a>
          ) : null}
          {ways.retry ? (
            <button
              ref={faucetLink ? undefined : firstRef}
              type="button"
              onClick={onRetry}
              className={faucetLink ? SECONDARY : PRIMARY}
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ConnectChooser({ store = pageChooser }: { store?: Chooser } = {}) {
  const state = useChooserState(store);
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // Where the focus was before the chooser opened, to go back to when it closes.
  const before = useRef<HTMLElement | null>(null);
  const step = state.step;

  // The first action takes the focus whenever the step changes, and the page's focus is kept for
  // when the chooser closes.
  useEffect(() => {
    if (step === "closed") {
      const back = before.current;
      before.current = null;
      if (back?.isConnected === true) back.focus();
      return;
    }
    if (before.current === null && document.activeElement instanceof HTMLElement) {
      before.current = document.activeElement;
    }
    // A step with no action of its own ("Getting your account ready…") gives it to Close.
    (first.current ?? closeButton.current)?.focus();
  }, [step]);

  if (state.step === "closed") return null;

  const close = () => store.close();
  const firstRef = (element: HTMLElement | null) => {
    first.current = element;
  };

  return (
    // The backdrop closes it with a pointer; Escape does from the keyboard (below).
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is not a control; Escape and the close button are
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape, on the dialog, is the keyboard's way to close
    <div
      data-testid="connect-chooser"
      className="fixed inset-0 z-50 grid place-items-center bg-ink/75 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            close();
          } else {
            trapTab(event, panel.current);
          }
        }}
        className={`${CARD} grid w-full max-w-sm gap-5 p-5 shadow-2xl shadow-black/60 sm:p-6`}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className={PANEL_TITLE}>
            {state.step === "choose" ? "Connect to Tender" : "Your account"}
          </h2>
          <button
            ref={closeButton}
            type="button"
            aria-label="Close"
            onClick={close}
            className="-mr-2 grid size-10 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-raised hover:text-bone motion-reduce:transition-none"
          >
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {state.step === "choose" ? (
          <div className="grid gap-3">
            <button
              ref={firstRef}
              type="button"
              onClick={() => store.choose("login")}
              className={`${PRIMARY} min-h-12 w-full text-[15px]`}
            >
              Continue with email or Google
            </button>
            <p className="text-center text-[13px] text-muted">No wallet needed.</p>
            <button
              type="button"
              onClick={() => store.choose("wallet")}
              className={`${SECONDARY} w-full`}
            >
              Use a NEAR wallet
            </button>
          </div>
        ) : state.step === "preparing" ? (
          <p
            role="status"
            data-testid="account-preparing"
            className="flex items-center gap-2.5 text-[15px] text-bone"
          >
            <span
              aria-hidden="true"
              className="size-2 shrink-0 animate-pulse rounded-full bg-seal motion-reduce:animate-none"
            />
            Getting your account ready…
          </p>
        ) : (
          <Stuck
            accountId={state.accountId}
            problem={state.problem}
            firstRef={firstRef}
            onRetry={() => void store.retry()}
          />
        )}
      </div>
    </div>
  );
}
