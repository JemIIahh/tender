"use client";

import { ApiError, type TelegramLinkResponse } from "@tender/shared";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useApiToken } from "../lib/auth";
import { useNowNs } from "../lib/clock";
import { TelegramLinkRefused, telegramLinkMessage, telegramStartUrl } from "../lib/telegram";
import { type Told, toldFor } from "../lib/told";
import { useWaitedLong } from "../lib/waiting";
import { useWallet } from "../lib/wallet";
import { WALLET_CANNOT_SIGN_MESSAGE, walletErrorMessage } from "../lib/walletErrors";
import { Avatar } from "./Avatar";
import { PageHead } from "./PageHead";
import { CARD, NOTICE, PANEL_TITLE, PRIMARY, SECONDARY, TEXT_LINK } from "./ui";

// The Telegram page: what the alerts are, and one button that links this account to the Tender bot.
// The button connects the wallet, and then signs in to the API (if the page has no token yet), asks
// the API for a one-time link and opens it. The person presses Start in Telegram, and the bot
// links the chat to the account.
//
// The API token is read from `useApiToken` for each request and kept nowhere else: this page holds
// no copy of it and never clears it (the wallet store drops it where the wallet session ends). A
// token the API turns away is replaced by signing in again. The link carries a code that is a
// secret until it is spent, so it is opened and shown as a link and never logged.

/** What is said after the person stopped waiting: nothing was linked. */
const STOPPED =
  "You stopped waiting for your wallet. Nothing was linked. Press the button to try again.";

/** One press of the button. Once `stopped`, nothing it still does or says is for the page. */
interface Run {
  stopped: boolean;
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
    <div role="status" data-testid="link-state" className={`${NOTICE} grid gap-1`}>
      {expired ? (
        <p>That link has expired. Press Link Telegram for a new one.</p>
      ) : (
        <>
          <p>
            Your link is made. It works once, until{" "}
            <time dateTime={link.expiresAt}>{timeOf(link.expiresAt)}</time>.
          </p>
          <p>
            <a href={link.url} target="_blank" rel="noopener noreferrer" className={TEXT_LINK}>
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
  const current = useRef<Run | null>(null);
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

  const link = toldFor(made, accountId);
  const failed = toldFor(failure, accountId);
  const stuck = accountId !== null && !canSignMessage;
  const disabled = running !== null || stuck;
  // A wallet that never answers leaves the button off, and only the Nav to leave by.
  const waitedLong = useWaitedLong(running);

  /**
   * The person gives up on a wallet that has not answered. Nothing is on the chain, so the button is
   * open again at once. What the press still does is not heard, and a link it makes late is not opened.
   */
  const stopWaiting = () => {
    const run = current.current;
    if (run === null || run.stopped || running === null) return;
    run.stopped = true;
    busy.current = false;
    setFailure({ account: accountId, value: STOPPED });
    setRunning(null);
  };

  const connectWallet = async () => {
    if (busy.current) return;
    const run: Run = { stopped: false };
    current.current = run;
    busy.current = true;
    setRunning("connect");
    setFailure(null);
    try {
      await connect();
    } catch (error) {
      console.error(error);
      if (!run.stopped) setFailure({ account: null, value: walletErrorMessage(error) });
    } finally {
      if (!run.stopped) {
        busy.current = false;
        setRunning(null);
      }
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
    const run: Run = { stopped: false };
    current.current = run;
    busy.current = true;
    setRunning("link");
    setFailure(null);
    const account = accountId;
    try {
      const answer = await requestLink();
      // The person can leave the page, or disconnect the wallet, or change it, while the API
      // answers, or give up waiting. The link is for the account that asked, on the page that
      // asked, and for a person who still waits: it is not opened for a page that is gone, no
      // longer that account's, or given up on.
      if (run.stopped || !mounted.current || shown.current !== account) return;
      const url = telegramStartUrl(answer.url);
      if (url === null) throw new TelegramLinkRefused();
      setMade({ account, value: { url, expiresAt: answer.expires_at } });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      console.error(error);
      if (!run.stopped) setFailure({ account, value: telegramLinkMessage(error) });
    } finally {
      if (!run.stopped) {
        busy.current = false;
        setRunning(null);
      }
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      <PageHead title="Telegram alerts">Tender's bot, in a Telegram chat of your own.</PageHead>

      <ul data-testid="alert-lines" className="grid gap-3 sm:grid-cols-3">
        {[
          {
            label: "Your tasks",
            line: "Get messages about tasks you posted or your agents entered.",
          },
          {
            label: "A tag to watch",
            line: "Send /watch research in the chat for new tasks with that tag.",
          },
          { label: "No fee", line: "Your wallet signs a message: no transaction, no fee." },
        ].map(({ label, line }, index) => (
          <li key={line} className={`${CARD} grid content-start gap-4 p-5`}>
            <p className="flex items-center justify-between gap-3 text-[13px] text-muted">
              {label}
              <span aria-hidden="true" className="text-seal">
                0{index + 1}
              </span>
            </p>
            <p className="text-[15px] leading-relaxed text-bone">{line}</p>
          </li>
        ))}
      </ul>

      <section className={`${CARD} grid gap-4 p-5 sm:p-6`}>
        <h2 className={PANEL_TITLE}>Link your chat</h2>
        {!ready ? (
          <p role="status" className="text-sm text-muted">
            Checking for your wallet…
          </p>
        ) : (
          <>
            {accountId === null ? (
              <p className="text-sm text-muted">Connect a wallet to link Telegram.</p>
            ) : (
              <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                <Avatar account={accountId} size={34} />
                <span className="text-sm text-muted">Connected as</span>
                <span
                  data-testid="account-id"
                  className="font-mono text-sm text-bone wrap-anywhere"
                >
                  {accountId}
                </span>
              </p>
            )}
            {stuck ? (
              <div className={`${NOTICE} grid gap-1`}>
                <p role="status" data-testid="cannot-sign">
                  {WALLET_CANNOT_SIGN_MESSAGE}
                </p>
                {/* The wallet page is where Disconnect is. */}
                <p>
                  <Link href="/wallet" className={TEXT_LINK}>
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

        {waitedLong ? (
          <div>
            <button type="button" onClick={stopWaiting} className={SECONDARY}>
              Stop waiting
            </button>
          </div>
        ) : null}

        {failed === null ? null : (
          <p
            role="alert"
            data-testid="link-error"
            className="rounded-xl border border-seal/45 bg-seal/[0.06] p-4 text-sm text-bone"
          >
            {failed}
          </p>
        )}

        {link === null ? null : <LinkState link={link} />}
      </section>
    </div>
  );
}
