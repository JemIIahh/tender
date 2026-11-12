"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CHECKING_SIGN_IN, loginLabel, SIGN_IN } from "../lib/copy";
import { walletErrorMessage } from "../lib/walletErrors";
import { CopyButton } from "./CopyButton";
import { LiveStatus } from "./LiveStatus";

/** A pill of the app's top bar. */
export const BAR_PILL = "min-h-10 px-4 whitespace-nowrap";

/** The part of the account group after the status, divided from it by a hairline. */
const PART = "flex h-10 min-w-0 items-center border-l border-line";

/** An implicit account (64 hex characters) with its middle left out; any other id as it is. */
export function shortAccount(accountId: string): string {
  return /^[0-9a-f]{64}$/.test(accountId)
    ? `${accountId.slice(0, 6)}…${accountId.slice(-4)}`
    : accountId;
}

/**
 * The top bar's account group, one joined pill: the status of the index and the network's name
 * (components/LiveStatus), then the connected account, cut short to fit and whole in its title,
 * with a button that copies it, which leads to the Wallet page; or Sign in when no account is
 * connected, which opens the Connect window over the page the person is on (`onSignIn`), so that
 * they stay there once they are signed in. A sign-in that fails says so in one line under the
 * pill, until the next press. While the wallet store looks (`ready` false), the account's place is
 * a placeholder of its size, so that a page that is about to show the account never shows Sign in
 * first. On a phone it is the dot and a short account. An account from the email or Google login
 * (`login` set, null when it does not say which) says so before the account, from a tablet's
 * width up.
 */
export function AccountGroup({
  ready,
  accountId,
  login,
  onSignIn,
}: {
  ready: boolean;
  accountId: string | null;
  login?: "email" | "google" | null;
  onSignIn?: () => Promise<void>;
}) {
  const label = login === undefined ? null : loginLabel(login);
  const [failure, setFailure] = useState<string | null>(null);
  // A failure is about a sign-in that did not happen: an account that is there says otherwise.
  useEffect(() => {
    if (accountId !== null) setFailure(null);
  }, [accountId]);
  return (
    <div className="relative flex h-10 min-w-0 items-center rounded-full border border-line bg-panel">
      <LiveStatus />
      {!ready ? (
        <span className={PART}>
          <span
            role="status"
            aria-label={CHECKING_SIGN_IN}
            data-testid="wallet-pill-placeholder"
            className="mx-3 block h-3 w-16 animate-pulse rounded-full bg-raised motion-reduce:animate-none sm:mx-4 sm:w-28"
          >
            <span className="sr-only">{CHECKING_SIGN_IN}</span>
          </span>
        </span>
      ) : accountId === null ? (
        <span className={PART}>
          <button
            type="button"
            data-testid="bar-sign-in"
            onClick={() => {
              setFailure(null);
              onSignIn?.().catch((error: unknown) => {
                console.error(error);
                setFailure(walletErrorMessage(error));
              });
            }}
            className="flex h-10 items-center rounded-r-full pr-4 pl-3.5 text-[13px] font-medium whitespace-nowrap text-bone transition-colors hover:bg-raised/60 motion-reduce:transition-none"
          >
            {SIGN_IN}
          </button>
          {failure === null ? null : (
            <span
              role="alert"
              className="absolute top-full right-0 z-40 mt-2 w-max max-w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-line bg-raised px-3 py-2 text-[13px] text-bone shadow-lg shadow-black/50"
            >
              {failure}
            </span>
          )}
        </span>
      ) : (
        <span className={`${PART} gap-1 pr-1`}>
          <Link
            href="/wallet"
            title={label === null ? accountId : `${label}: ${accountId}`}
            className="flex h-10 min-w-0 items-center gap-2 rounded-full pr-2.5 pl-3.5 font-mono text-[13px] text-bone decoration-bone/40 underline-offset-4 hover:underline sm:pr-0"
          >
            {label === null ? null : (
              <span
                data-testid="pill-login"
                className="font-sans text-[12px] whitespace-nowrap text-muted max-sm:sr-only"
              >
                {label}
              </span>
            )}
            <span className="max-w-[6.5rem] truncate sm:max-w-44">{shortAccount(accountId)}</span>
          </Link>
          <CopyButton value={accountId} label="Copy account" className="max-sm:hidden" />
        </span>
      )}
    </div>
  );
}
