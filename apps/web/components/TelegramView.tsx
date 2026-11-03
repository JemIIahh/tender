"use client";

import { ApiError, type TelegramLinkResponse } from "@tender/shared";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useApiToken } from "../lib/auth";
import { useNowNs } from "../lib/clock";
import { TelegramLinkRefused, telegramLinkMessage, telegramStartUrl } from "../lib/telegram";
import { useWallet } from "../lib/wallet";
import { WALLET_CANNOT_SIGN_MESSAGE, walletErrorMessage } from "../lib/walletErrors";

// The Telegram page: what the alerts are, and one button that links this account to the Tender bot.
// The button connects the wallet, and then signs in to the API (if the page has no token yet), asks
// the API for a one-time link and opens it. The person presses Start in Telegram, and the bot
// links the chat to the account.
//
// The API token is read from `useApiToken` for each request and kept nowhere else: this page holds
// no copy of it and never clears it (the wallet store drops it where the wallet session ends). A
// token the API turns away is replaced by signing in again. The link carries a code that is a
// secret until it is spent, so it is opened and shown as a link and never logged.

const PRIMARY =
  "min-h-11 w-fit rounded border border-neutral-900 bg-neutral-900 px-4 text-white aria-disabled:opacity-60";

/** What the person was told, and for whom: an account's news is not shown for another account. */
interface Told<T> {
  /** The account connected when it happened, or null for the connect button's own failures. */
  account: string | null;
  value: T;
}

interface MadeLink {
  /** The address that was opened: `https://t.me/<bot>?start=<code>`. */
  url: string;
  /** When the link stops working, ISO 8601 as the API gave it. */
  expiresAt: string;
}

/** The time of day `iso` names, in the reader's own zone. */
function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Where a made link stands. It works once, until the time the API gave, and the box says until
 * when. Past that time it says the link is dead and offers no way to open it. The clock ticks only
 * while the box is on the page.
 */
function LinkState({ link }: { link: MadeLink }) {
  const now = useNowNs();
  const expired = Date.parse(link.expiresAt) <= Number(now / 1_000_000n);
  return (
    <div
      role="status"
      data-testid="link-state"
      className="grid gap-1 rounded border border-neutral-900 p-3 text-sm"
    >
      {expired ? (
        <p>That link has expired. Press Link Telegram for a new one.</p>
      ) : (
        <>
          <p>
            Your link is made. It works once, until{" "}
            <time dateTime={link.expiresAt}>{timeOf(link.expiresAt)}</time>.
          </p>
          <p>
            <a href={link.url} target="_blank" rel="noopener noreferrer" className="underline">
              Open Telegram
            </a>{" "}
            if it did not open by itself, and press Start there.
          </p>
        </>
      )}
    </div>
  );
}

export function TelegramView() {
  const { ready, accountId, canSignMessage, connect } = useWallet();
  const { token, signIn } = useApiToken();
  const [running, setRunning] = useState<"connect" | "link" | null>(null);
  const [failure, setFailure] = useState<Told<string> | null>(null);
  const [made, setMade] = useState<Told<MadeLink> | null>(null);
  // Set at once when the button is pressed, where `running` is only set for the next render: a
  // second press before then must not start a second sign-in.
  const busy = useRef(false);
  // Whether the page is still on screen, and which account it is for as of the latest render: for
  // an answer that comes after the person has left, disconnected or changed wallet.
  const mounted = useRef(false);
  const shown = useRef(accountId);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    shown.current = accountId;
  });

  const link = made !== null && made.account === accountId ? made.value : null;
  const failed = failure !== null && failure.account === accountId ? failure.value : null;
  const stuck = accountId !== null && !canSignMessage;
  const disabled = running !== null || stuck;

  const connectWallet = async () => {
    if (busy.current) return;
    busy.current = true;
    setRunning("connect");
    setFailure(null);
    try {
      await connect();
    } catch (error) {
      console.error(error);
      setFailure({ account: null, value: walletErrorMessage(error) });
    } finally {
      busy.current = false;
      setRunning(null);
    }
  };

  /**
   * A link from the API. The token of the first request is the hook's, or else the one a sign-in
   * has just given; it is used at once and kept nowhere. A token the API turns away (it ran out, or
   * the API forgot it) is not cleared here: the person signs in again, through the hook, and the
   * new token is asked with once.
   */
  const requestLink = async (): Promise<TelegramLinkResponse> => {
    const first = token ?? (await signIn());
    try {
      return await api.telegramLink(first);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
    return api.telegramLink(await signIn());
  };

  const linkTelegram = async () => {
    if (busy.current || accountId === null || !canSignMessage) return;
    busy.current = true;
    setRunning("link");
    setFailure(null);
    const account = accountId;
    try {
      const answer = await requestLink();
      // The person can leave the page, or disconnect the wallet, or change it, while the API
      // answers. The link is for the account that asked, on the page that asked: it is not opened
      // for a page that is gone or is no longer that account's.
      if (!mounted.current || shown.current !== account) return;
      const url = telegramStartUrl(answer.url);
      if (url === null) throw new TelegramLinkRefused();
      setMade({ account, value: { url, expiresAt: answer.expires_at } });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      console.error(error);
      setFailure({ account, value: telegramLinkMessage(error) });
    } finally {
      busy.current = false;
      setRunning(null);
    }
  };

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Telegram alerts</h1>

      <ul data-testid="alert-lines" className="grid list-disc gap-2 pl-5">
        <li>Get messages about tasks you posted or your agents entered.</li>
        <li>Send /watch research in the chat for new tasks with that tag.</li>
        <li>Your wallet signs a message: no transaction, no fee.</li>
      </ul>

      <section className="grid gap-2">
        {!ready ? (
          <p role="status">Checking for your wallet…</p>
        ) : (
          <>
            {accountId === null ? (
              <p>Connect a wallet to link Telegram.</p>
            ) : (
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span>Connected as</span>
                <span data-testid="account-id" className="font-mono text-sm wrap-anywhere">
                  {accountId}
                </span>
              </p>
            )}
            {stuck ? (
              <div className="grid gap-1 text-sm">
                <p role="status" data-testid="cannot-sign">
                  {WALLET_CANNOT_SIGN_MESSAGE}
                </p>
                {/* The wallet page is where Disconnect is. */}
                <p>
                  <Link href="/wallet" className="underline">
                    Disconnect it on the Wallet page
                  </Link>
                </p>
              </div>
            ) : null}
            {/* One button, whose words follow the step. It is the same element from one step to
                the next, so the keyboard focus stays on it when the wallet connects. `aria-disabled`
                and not `disabled`: a disabled button cannot hold the focus. */}
            <button
              type="button"
              aria-disabled={disabled}
              onClick={disabled ? undefined : accountId === null ? connectWallet : linkTelegram}
              className={PRIMARY}
            >
              {accountId === null
                ? running === "connect"
                  ? "Waiting for your wallet…"
                  : "Connect wallet"
                : running === "link"
                  ? "Linking…"
                  : "Link Telegram"}
            </button>
          </>
        )}

        {failed === null ? null : (
          <p
            role="alert"
            data-testid="link-error"
            className="rounded border border-neutral-900 p-3 text-sm"
          >
            {failed}
          </p>
        )}

        {link === null ? null : <LinkState link={link} />}
      </section>
    </div>
  );
}
