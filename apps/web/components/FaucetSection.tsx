"use client";

import { type ReactNode, useState } from "react";
import { FAUCET_AMOUNT } from "../lib/faucet";
import { TESTNET_FAUCET_URL } from "../lib/gasGift";
import { describeAmount } from "../lib/vault";
import { FACT_LABEL, PANEL, PANEL_TITLE, PRIMARY, TAG } from "./ui";

/**
 * The testnet faucets of the wallet page, two rows: testnet NEAR, for fees, and the test token. The
 * page decides whether to show it at all (testnet only, lib/faucet.ts); this is the words and the
 * buttons. `accountId` is the connected account; `token` is the test token Tender lists, or null if
 * it lists none.
 *
 * NEAR documents no faucet that an app may call for a person (the faucets are web forms, some with
 * a captcha), so the NEAR row calls none: one press copies the account and opens the public faucet
 * (`TESTNET_FAUCET_URL`, the one the login's "account not ready" step links too) in a new tab, where
 * the person pastes it. The test token's `mint` is open, so its row mints in one approval.
 */
export function FaucetSection({
  accountId,
  token,
  running,
  anyRunning,
  onGet,
  notice,
}: {
  accountId: string;
  token: string | null;
  /** The faucet's own press is under way. */
  running: boolean;
  /** Some action is under way, this one or another. */
  anyRunning: boolean;
  onGet: (token: string) => void;
  notice: ReactNode;
}) {
  return (
    <section data-testid="faucet" className={PANEL}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className={PANEL_TITLE}>Test tokens</h2>
        <span className={`${TAG} text-muted`}>Testnet only</span>
      </div>
      <p className="text-sm text-muted">
        Free test tokens with no value, so you can try Tender without spending anything real: NEAR
        for fees, and tUSDC for tasks and bonds. They exist on testnet only.
      </p>

      <NearFaucet accountId={accountId} />

      <div data-testid="faucet-tusdc" className="grid gap-2 border-t border-line pt-4">
        <p className={FACT_LABEL}>tUSDC, for tasks and bonds</p>
        {token === null ? (
          <p data-testid="faucet-unavailable" className="text-sm text-bone">
            Tender lists no test token right now.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">
              One press adds {describeAmount(FAUCET_AMOUNT, token)} to your wallet, in one approval.
              If the token doesn't know your account yet, it is registered first, for 0.00125 NEAR.
              Then use Add funds to move them into your vault.
            </p>
            {/* A key of its own, as the other buttons have: a press meant for this one is not
                taken by whatever button comes to be in this place. `aria-disabled` does not stop
                a press, so the handler has the same condition. */}
            <button
              key="faucet"
              type="button"
              aria-disabled={anyRunning}
              onClick={() => {
                if (!anyRunning) onGet(token);
              }}
              className={`${PRIMARY} justify-self-start`}
            >
              {running ? "Waiting for your wallet…" : "Get test tUSDC"}
            </button>
          </>
        )}
        {notice}
      </div>
    </section>
  );
}

/**
 * Testnet NEAR: a link to the public faucet that also copies the account, so that the person only
 * pastes it there. A browser that won't let the page write to the clipboard gets the account shown
 * to copy by hand; the faucet opens all the same.
 */
function NearFaucet({ accountId }: { accountId: string }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(accountId);
      setCopied("yes");
    } catch (error) {
      console.error(error);
      setCopied("no");
    }
  };
  return (
    <div data-testid="faucet-near" className="grid gap-2">
      <p className={FACT_LABEL}>NEAR, for fees</p>
      <a
        href={TESTNET_FAUCET_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => void copy()}
        className={`${PRIMARY} justify-self-start`}
      >
        Get testnet NEAR
      </a>
      <p className="text-sm text-muted">
        Paste your account there and pick NEAR. It's free test money.
      </p>
      {copied === "yes" ? (
        <p role="status" data-testid="faucet-near-copied" className="text-sm text-bone">
          Your account is copied.
        </p>
      ) : copied === "no" ? (
        <div role="status" data-testid="faucet-near-copy" className="grid gap-1 text-sm">
          <p className="text-bone">The browser didn't let the page copy it. Your account:</p>
          <p className="rounded-xl border border-line bg-ink px-3 py-2 font-mono text-[13px] text-bone select-all wrap-anywhere">
            {accountId}
          </p>
        </div>
      ) : null}
    </div>
  );
}
