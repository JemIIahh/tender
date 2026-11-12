"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  clearApiToken,
  heldToken,
  noToken,
  subscribeToken,
  tokenForAccount,
} from "../lib/apiToken";
import { config } from "../lib/config";
import { CHECKING_SIGN_IN, SIGN_IN } from "../lib/copy";
import { setRail, sidebarStore } from "../lib/sidebar";
import { useWallet } from "../lib/wallet";
import { walletErrorMessage } from "../lib/walletErrors";
import { PageHead } from "./PageHead";
import { CARD, EYEBROW, FACT_LABEL, PANEL_TITLE, SECONDARY } from "./ui";

// Settings: what this viewer can see and choose here. The account the wallet is connected as, and
// the sign-in to Tender's API, which can be ended; the Telegram link, which is made on its own page;
// how the sidebar opens; and the network the app talks to, to copy. Nothing here changes anything
// on chain, and no secret is shown: the API token never is, and an RPC address is shown without its
// query, where a provider's key can be.

/** A section of the page: a title, a line under it, and its rows. */
function Section({
  title,
  line,
  testId,
  children,
}: {
  title: string;
  line?: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section data-testid={testId} className={`${CARD} grid gap-5 p-5 sm:p-6`}>
      <div className="grid gap-1">
        <h2 className={PANEL_TITLE}>{title}</h2>
        {line === undefined ? null : <p className="text-sm text-muted">{line}</p>}
      </div>
      {children}
    </section>
  );
}

/** A label, and what it says, side by side from tablet width up. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-2 border-t border-line pt-4 first:border-t-0 first:pt-0 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center sm:gap-6">
      <p className={FACT_LABEL}>{label}</p>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** When the API stops taking a token, as this browser writes a time. */
function untilText(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function AccountSection() {
  const wallet = useWallet();
  const stored = useSyncExternalStore(subscribeToken, heldToken, noToken);
  const signedIn = tokenForAccount(stored, wallet.accountId) !== null;
  const [ended, setEnded] = useState(false);
  const [signInFailure, setSignInFailure] = useState<string | null>(null);

  return (
    <Section
      title="Account"
      line="Your wallet holds your keys. A sign-in to Tender's API is kept in this tab until it expires, or until you sign out here."
      testId="settings-account"
    >
      <Row label="Account">
        {!wallet.ready ? (
          <p role="status" className="text-muted">
            {CHECKING_SIGN_IN}
          </p>
        ) : wallet.accountId === null ? (
          <div className="grid gap-2">
            <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-muted">
              You're not signed in.
              {/* The Connect window, over this page: the person stays here once signed in. */}
              <button
                type="button"
                onClick={() => {
                  setSignInFailure(null);
                  wallet.connect().catch((error: unknown) => {
                    console.error(error);
                    setSignInFailure(walletErrorMessage(error));
                  });
                }}
                className={`${SECONDARY} min-h-10 px-4`}
              >
                {SIGN_IN}
              </button>
            </p>
            {signInFailure === null ? null : (
              <p role="alert" className="text-sm text-seal">
                {signInFailure}
              </p>
            )}
          </div>
        ) : (
          <p
            data-testid="settings-wallet"
            className="font-mono text-[14px] text-bone wrap-anywhere"
          >
            {wallet.accountId}
          </p>
        )}
      </Row>
      <Row label="API sign-in">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p data-testid="settings-session" className={signedIn ? "text-bone" : "text-muted"}>
            {signedIn && stored !== null
              ? `Signed in until ${untilText(stored.expiresAtMs)}.`
              : ended
                ? "Signed out in this tab. A page that writes to the API asks you to sign in again."
                : "Not signed in. A page that writes to the API asks you when it needs to."}
          </p>
          {signedIn ? (
            <button
              type="button"
              onClick={() => {
                clearApiToken();
                setEnded(true);
              }}
              className={`${SECONDARY} min-h-10 px-4`}
            >
              Sign out of the API
            </button>
          ) : null}
        </div>
        <p role="status" className="sr-only">
          {ended ? "Signed out of the API in this tab." : ""}
        </p>
      </Row>
      <Row label="Telegram">
        <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-muted">
          Alerts for your tasks and agents, in a Telegram chat.
          <Link href="/telegram" className={`${SECONDARY} min-h-10 px-4`}>
            Telegram settings
          </Link>
        </p>
      </Row>
    </Section>
  );
}

/** Whether the viewer's system asks for reduced motion, and the answer again when it changes. */
function useReducedMotion(): boolean | null {
  const [reduced, setReduced] = useState<boolean | null>(null);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (query === undefined) return;
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function DisplaySection() {
  const id = useId();
  const rail = useSyncExternalStore(
    sidebarStore.subscribe,
    sidebarStore.getSnapshot,
    sidebarStore.getServerSnapshot,
  );
  const reduced = useReducedMotion();
  const choices = [
    { value: false, label: "Full", line: "Icons and names" },
    { value: true, label: "Icons only", line: "Names in a tooltip" },
  ];
  return (
    <Section
      title="Display"
      line="Kept in this browser only. The sidebar's button and ⌘B (Ctrl+B) change it too."
      testId="settings-display"
    >
      <Row label="Sidebar on a laptop">
        <fieldset>
          <legend className="sr-only">Sidebar on a laptop</legend>
          <div className="flex flex-wrap gap-2">
            {choices.map((choice) => (
              <label
                key={choice.label}
                htmlFor={`${id}-${choice.label}`}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line bg-ink px-4 py-2 text-sm text-bone transition-colors has-[:checked]:border-bone/60 has-[:checked]:bg-raised has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-bone motion-reduce:transition-none"
              >
                <input
                  id={`${id}-${choice.label}`}
                  type="radio"
                  name={`${id}-sidebar`}
                  checked={rail === choice.value}
                  onChange={() => setRail(choice.value)}
                  className="size-4 accent-[var(--color-bone)]"
                />
                <span className="grid">
                  <span>{choice.label}</span>
                  <span className="text-xs text-muted">{choice.line}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </Row>
      <Row label="Motion">
        <p data-testid="settings-motion" className="text-muted">
          Follows your system.
          {reduced === null
            ? ""
            : reduced
              ? " Reduced motion is on: nothing moves by itself."
              : " Reduced motion is off."}
        </p>
      </Row>
    </Section>
  );
}

/** A value to copy: shown whole, in mono, with a button that copies exactly what is shown. */
function CopyValue({ label, value, note }: { label: string; value: string; note?: string }) {
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
    timer.current = setTimeout(() => setCopied(null), 2500);
  };
  return (
    <Row label={label}>
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <code
          data-testid="settings-value"
          className="min-w-0 flex-1 font-mono text-[13px] text-bone wrap-anywhere"
        >
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label.toLowerCase()}`}
          className={`${SECONDARY} min-h-10 shrink-0 px-4`}
        >
          {copied === "yes" ? "Copied" : "Copy"}
        </button>
      </div>
      {note === undefined ? null : <p className="mt-1 text-xs text-muted">{note}</p>}
      {copied === "no" ? (
        <p className="mt-1 text-sm text-muted">The browser didn't allow copying: select it.</p>
      ) : null}
      <p role="status" className="sr-only">
        {copied === "yes" ? `${label} copied.` : copied === "no" ? "Couldn't copy." : ""}
      </p>
    </Row>
  );
}

/**
 * `url` without its query, its fragment and any user name or password, where a provider's key can
 * be, and whether it had any of them. One with none, or that is no URL, is shown as it is written.
 */
export function withoutQuery(url: string): { shown: string; cut: boolean } {
  try {
    const parsed = new URL(url);
    const plain =
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.username === "" &&
      parsed.password === "";
    if (plain) return { shown: url, cut: false };
    return { shown: `${parsed.origin}${parsed.pathname}`, cut: true };
  } catch {
    return { shown: url, cut: false };
  }
}

function NetworkSection() {
  const rpc = withoutQuery(config.rpcUrl);
  return (
    <Section
      title="Network"
      line="What this app talks to. It is set when the app is built, and read-only here."
      testId="settings-network"
    >
      <CopyValue label="Network" value={`NEAR ${config.network}`} />
      <CopyValue label="Contract" value={config.contractId} />
      <CopyValue
        label="RPC"
        value={rpc.shown}
        note={
          rpc.cut
            ? "Shown without its query and any user name, where a key is often put. A key in the path still shows: this address is in the app's code."
            : undefined
        }
      />
      <CopyValue label="API" value={config.apiUrl} />
    </Section>
  );
}

export function SettingsView() {
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      <PageHead title="Settings." muted="Yours, in this browser." />
      <AccountSection />
      <DisplaySection />
      <NetworkSection />
      <p className={`${EYEBROW} text-center`}>
        Nothing on this page changes anything on chain.{" "}
        <Link href="/how-it-works" className="underline underline-offset-4">
          How Tender works
        </Link>
      </p>
    </div>
  );
}
