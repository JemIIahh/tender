"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  type Chooser,
  type ChooserState,
  chooser as pageChooser,
  useChooserState,
  type WalletList,
} from "../lib/chooser";
import { config } from "../lib/config";
import {
  GIFT_PROBLEM_WORDS,
  GIFT_RETRY_HELPS,
  type GiftProblem,
  TESTNET_FAUCET_URL,
} from "../lib/gasGift";
import { shortId } from "../lib/tokens";
import { CopyButton } from "./CopyButton";
import { PRIMARY, SECONDARY } from "./ui";

// The Connect window (lib/chooser.ts has the steps): "Log in or sign up", with the email field
// (Submit sends a code, and the window asks for it), Google, and under them a row for each NEAR
// wallet near-connect lists, which connects that wallet at once. A build with no login shows the
// wallets alone. After a login it shows the one line "Getting your account ready…" while Tender
// sends the new account NEAR for its fees, and, if that is refused or doesn't arrive, one line that
// says so, with Try again first where trying again can help, and the faucet with the account to
// copy as the other way.
//
// It is a modal of the page's own: the focus goes into it and stays there, Escape and the backdrop
// close it, and the focus goes back to where it was when it closes. On a phone it takes the width
// less a 16px gutter, and a window taller than the screen scrolls inside itself.

const FOCUSABLE = "a[href], button, input";

/**
 * A row of the window: a 1px rounded border, an icon tile on the left. The email row's field shows
 * the keyboard's focus with the row's border, so its own ring is turned off: with `!`, since the
 * app's ring (app/globals.css) is outside Tailwind's layers and would win otherwise.
 */
const ROW =
  "flex min-h-14 w-full min-w-0 items-center gap-3 rounded-xl border border-line px-3 text-left text-[14px] font-medium text-bone";

/** A row that is a button. */
const ROW_BUTTON = `${ROW} transition-colors hover:border-bone/30 hover:bg-raised aria-disabled:cursor-wait motion-reduce:transition-none`;

/** The square that holds a row's icon. */
const TILE =
  "grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-raised text-muted";

/** The two lines under the email row and Google when they went wrong, and in the code step. */
const PROBLEM = "px-1 text-[13px] text-seal";

/** The line at the foot of the window: who logs the person in, and how a wallet connects. */
export const FOOTER_LOGIN = "Email and Google login by Privy. NEAR wallets connect directly.";
export const FOOTER_WALLETS = "NEAR wallets connect directly.";

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

/**
 * What is in the way of the account's NEAR for fees, and the ways on: Try again first where it can
 * help, and always the faucet with the account to copy (on testnet; elsewhere, the account to send
 * NEAR to).
 */
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
  const retry = GIFT_RETRY_HELPS[problem];
  const faucet = config.network === "testnet";
  return (
    <div className="grid gap-4">
      <p role="status" data-testid="account-stuck" className="text-[15px] text-bone">
        {GIFT_PROBLEM_WORDS[problem]}
      </p>
      <div className="grid gap-2">
        <p className="text-sm text-muted">
          {faucet
            ? `${retry ? "Or get" : "Get"} free testnet NEAR for this account at the faucet:`
            : `${retry ? "Or send" : "Send"} this account a little NEAR to pay its fees:`}
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
      {retry || faucet ? (
        <div className="flex flex-wrap gap-2">
          {retry ? (
            <button ref={firstRef} type="button" onClick={onRetry} className={PRIMARY}>
              Try again
            </button>
          ) : null}
          {faucet ? (
            <a
              ref={retry ? undefined : firstRef}
              href={TESTNET_FAUCET_URL}
              target="_blank"
              rel="noreferrer"
              className={retry ? SECONDARY : PRIMARY}
            >
              Open the faucet
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LastUsedBadge() {
  return (
    <span
      data-testid="last-used"
      className="shrink-0 rounded-full border border-line bg-raised px-2 py-0.5 text-[11px] font-medium text-muted"
    >
      Last used
    </span>
  );
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const MAIL = (
  <Icon>
    <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
    <path d="M2.5 4.5 8 8.75l5.5-4.25" />
  </Icon>
);

const WALLET = (
  <Icon>
    <path d="M12.5 5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v8A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5V6.5A1.5 1.5 0 0 0 12 5H4" />
    <circle cx="10.75" cy="9.25" r=".75" fill="currentColor" stroke="none" />
  </Icon>
);

/** Google's four-colour G, as its sign-in buttons show it. */
const GOOGLE = (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[18px]">
    <path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z"
    />
    <path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
    />
    <path
      fill="#FBBC05"
      d="M5.84 14.09A6.6 6.6 0 0 1 5.49 12c0-.73.13-1.43.35-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.93l3.66-2.84Z"
    />
    <path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
    />
  </svg>
);

/** The NEAR wallets' rows: one for each wallet near-connect lists, or one that opens its list. */
function WalletRows({
  list,
  lastUsed,
  firstRef,
  onPick,
}: {
  list: WalletList;
  lastUsed: string | null;
  firstRef?: (element: HTMLElement | null) => void;
  onPick: (walletId: string | null) => void;
}) {
  if (list.status === "loading") {
    return (
      <div role="status" className="grid gap-2">
        <span className="sr-only">Loading NEAR wallets…</span>
        <span aria-hidden="true" className="skeleton h-14 rounded-xl" />
        <span aria-hidden="true" className="skeleton h-14 rounded-xl" />
      </div>
    );
  }
  if (list.status === "failed" || list.wallets.length === 0) {
    // near-connect's own window, as Connect opened before.
    return (
      <button
        ref={firstRef}
        type="button"
        data-testid="wallet-list-fallback"
        onClick={() => onPick(null)}
        className={ROW_BUTTON}
      >
        <span className={TILE}>{WALLET}</span>
        <span className="min-w-0 flex-1 truncate">NEAR wallets</span>
      </button>
    );
  }
  return (
    <ul className="grid gap-2">
      {list.wallets.map((wallet, index) => (
        <li key={wallet.id} className="min-w-0">
          <button
            ref={index === 0 ? firstRef : undefined}
            type="button"
            data-testid="wallet-row"
            onClick={() => onPick(wallet.id)}
            className={ROW_BUTTON}
          >
            <span className={TILE}>
              {wallet.icon === null ? (
                WALLET
              ) : (
                // A wallet's icon from near-connect's list: an image of its own, at its own address.
                // biome-ignore lint/performance/noImgElement: a 32px icon from the wallet list, not a page image
                <img
                  src={wallet.icon}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="size-full object-cover"
                />
              )}
            </span>
            <span className="grid min-w-0 flex-1">
              <span className="truncate">{wallet.name}</span>
              {wallet.site === null ? null : (
                <span className="truncate text-[12px] font-normal text-muted">{wallet.site}</span>
              )}
            </span>
            {lastUsed === `wallet:${wallet.id}` ? <LastUsedBadge /> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

type Choosing = Extract<ChooserState, { step: "choose" }>;
type Coding = Extract<ChooserState, { step: "code" }>;

/** The window's first step: the email row, Google, and the NEAR wallets. */
function Choose({
  state,
  store,
  firstRef,
}: {
  state: Choosing;
  store: Chooser;
  firstRef: (element: HTMLElement | null) => void;
}) {
  const problemId = useId();
  const busy = state.busy !== null;
  return (
    <>
      <div className="mt-7 grid gap-2">
        {state.login ? (
          <>
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                const typed = new FormData(event.currentTarget).get("email");
                void store.sendCode(typeof typed === "string" ? typed : "");
              }}
              className={`${ROW} pr-1.5 focus-within:border-bone/50`}
            >
              <span className={TILE}>{MAIL}</span>
              <input
                ref={firstRef}
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                placeholder="your@email.com"
                aria-label="Email address"
                aria-invalid={state.problem !== null && state.busy === null ? true : undefined}
                aria-describedby={state.problem === null ? undefined : problemId}
                defaultValue={state.email}
                readOnly={busy}
                className="h-12 min-w-0 flex-1 bg-transparent text-[14px] font-medium text-bone placeholder:text-muted focus-visible:outline-none!"
              />
              {state.lastUsed === "email" ? <LastUsedBadge /> : null}
              <button
                type="submit"
                aria-disabled={busy ? true : undefined}
                className="shrink-0 rounded-lg px-2.5 py-2 text-[14px] font-medium text-muted transition-colors hover:bg-raised hover:text-bone aria-disabled:cursor-wait motion-reduce:transition-none"
              >
                {state.busy === "email" ? "Sending…" : "Submit"}
              </button>
            </form>
            <button
              type="button"
              aria-disabled={busy ? true : undefined}
              onClick={() => void store.google()}
              className={ROW_BUTTON}
            >
              <span className={`${TILE} border-transparent bg-white`}>{GOOGLE}</span>
              <span className="min-w-0 flex-1 truncate">
                {state.busy === "google" ? "Opening Google…" : "Continue with Google"}
              </span>
              {state.lastUsed === "google" ? <LastUsedBadge /> : null}
            </button>
            {state.problem === null ? null : (
              <p id={problemId} role="alert" className={PROBLEM}>
                {state.problem}
              </p>
            )}
            <p className="flex items-center gap-3 py-2 text-[12px] text-muted">
              <span aria-hidden="true" className="h-px flex-1 bg-line" />
              or use a NEAR wallet
              <span aria-hidden="true" className="h-px flex-1 bg-line" />
            </p>
          </>
        ) : null}
        <WalletRows
          list={state.wallets}
          lastUsed={state.lastUsed}
          firstRef={state.login ? undefined : firstRef}
          onPick={(walletId) => store.pickWallet(walletId)}
        />
      </div>
      <p className="mt-6 text-center text-[12px] leading-relaxed text-balance text-muted">
        {state.login ? FOOTER_LOGIN : FOOTER_WALLETS}
      </p>
    </>
  );
}

/** The code step: the address it went to, one field for the six digits, Log in and Resend. */
function Code({
  state,
  store,
  firstRef,
}: {
  state: Coding;
  store: Chooser;
  firstRef: (element: HTMLElement | null) => void;
}) {
  const [code, setCode] = useState("");
  const problemId = useId();
  const busy = state.busy !== null;
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void store.submitCode(code);
      }}
      className="mt-3 grid gap-4"
    >
      <p className="text-center text-[14px] text-muted">
        Enter the code sent to <span className="break-all text-bone">{state.email}</span>
      </p>
      <input
        ref={firstRef}
        name="code"
        value={code}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, "").slice(0, 6);
          setCode(digits);
          // Six digits are the whole code: it goes at once, as Privy's own window does.
          if (digits.length === 6) void store.submitCode(digits);
        }}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        placeholder="······"
        aria-label="Code"
        aria-invalid={state.problem === null ? undefined : true}
        aria-describedby={state.problem === null ? undefined : problemId}
        readOnly={busy}
        className="h-14 w-full rounded-xl border border-dim bg-ink text-center font-mono text-[22px] tracking-[0.45em] text-bone transition-colors placeholder:text-dim hover:border-bone/60 focus-visible:border-bone focus-visible:outline-none! aria-invalid:border-seal motion-reduce:transition-none"
      />
      {state.problem !== null ? (
        <p id={problemId} role="alert" className={`${PROBLEM} text-center`}>
          {state.problem}
        </p>
      ) : state.resent ? (
        <p role="status" className="text-center text-[13px] text-muted">
          A new code is on its way.
        </p>
      ) : null}
      <button
        type="submit"
        aria-disabled={busy ? true : undefined}
        className={`${PRIMARY} min-h-12 w-full`}
      >
        {state.busy === "code" ? "Logging in…" : "Log in"}
      </button>
      <button
        type="button"
        aria-disabled={busy ? true : undefined}
        onClick={() => void store.resend()}
        className="mx-auto rounded-lg px-2 py-1 text-[13px] text-muted underline decoration-muted/40 underline-offset-4 transition-colors hover:text-bone aria-disabled:cursor-wait motion-reduce:transition-none"
      >
        {state.busy === "resend" ? "Sending a new code…" : "Resend code"}
      </button>
    </form>
  );
}

const TITLE: Record<Exclude<ChooserState["step"], "closed">, string> = {
  choose: "Log in or sign up",
  code: "Check your email",
  preparing: "Your account",
  stuck: "Your account",
};

export function ConnectChooser({ store = pageChooser }: { store?: Chooser } = {}) {
  const state = useChooserState(store);
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // Where the focus was before the window opened, to go back to when it closes.
  const before = useRef<HTMLElement | null>(null);
  const step = state.step;
  // What gives the focus to the first action: a new step; a wrong code, whose field starts again;
  // and, in a build with no login, the wallets' arrival, whose first row is the first action.
  const focusKey =
    state.step === "code"
      ? `code:${state.tries}`
      : state.step === "choose" && !state.login
        ? `choose:${state.wallets.status}`
        : step;

  // The first action takes the focus whenever the step changes, and the page's focus is kept for
  // when the window closes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `focusKey` says when to move the focus
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
  }, [focusKey]);

  if (state.step === "closed") return null;

  const close = () => store.close();
  const firstRef = (element: HTMLElement | null) => {
    first.current = element;
  };
  const title =
    state.step === "choose" && !state.login ? "Sign in with a NEAR wallet" : TITLE[state.step];

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
        className="relative max-h-[calc(100dvh-2rem)] w-full max-w-[360px] overflow-y-auto overscroll-contain rounded-3xl border border-line bg-panel px-6 pt-14 pb-6 shadow-2xl shadow-black/60"
      >
        {state.step === "code" ? (
          <button
            type="button"
            aria-label="Back"
            onClick={() => store.back()}
            className="absolute top-4 left-4 grid size-8 place-items-center rounded-full bg-raised text-muted transition-colors hover:text-bone motion-reduce:transition-none"
          >
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              className="size-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10 3.5 5.5 8l4.5 4.5" />
            </svg>
          </button>
        ) : null}
        <button
          ref={closeButton}
          type="button"
          aria-label="Close"
          onClick={close}
          className="absolute top-4 right-4 grid size-8 place-items-center rounded-full bg-raised text-muted transition-colors hover:text-bone motion-reduce:transition-none"
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>

        <h2
          id={titleId}
          className="text-center text-[18px] leading-7 font-semibold tracking-tight text-bone"
        >
          {title}
        </h2>

        {state.step === "choose" ? (
          <Choose state={state} store={store} firstRef={firstRef} />
        ) : state.step === "code" ? (
          <Code key={state.tries} state={state} store={store} firstRef={firstRef} />
        ) : state.step === "preparing" ? (
          <p
            role="status"
            data-testid="account-preparing"
            className="mt-6 flex items-center justify-center gap-2.5 text-[15px] text-bone"
          >
            <span
              aria-hidden="true"
              className="size-2 shrink-0 animate-pulse rounded-full bg-seal motion-reduce:animate-none"
            />
            Getting your account ready…
          </p>
        ) : (
          <div className="mt-6">
            <Stuck
              accountId={state.accountId}
              problem={state.problem}
              firstRef={firstRef}
              onRetry={() => void store.retry()}
            />
          </div>
        )}
      </div>
    </div>
  );
}
