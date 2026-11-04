"use client";

import type { ReactNode } from "react";
import { FAUCET_AMOUNT } from "../lib/faucet";
import { describeAmount } from "../lib/vault";
import { PANEL, PANEL_TITLE, PRIMARY, TAG } from "./ui";

/**
 * The testnet faucet of the wallet page: a button that gives the connected account free test
 * tokens. The page decides whether to show it at all (testnet only, lib/faucet.ts); this is the
 * words and the button. `token` is the test token Tender lists, or null if it lists none.
 */
export function FaucetSection({
  token,
  running,
  anyRunning,
  onGet,
  notice,
}: {
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
        Free test tokens with no value, so you can try Tender without spending anything real. They
        exist on testnet only.
      </p>
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
          {/* A key of its own, as the other buttons have: a press meant for this one is not taken
              by whatever button comes to be in this place. `aria-disabled` does not stop a press,
              so the handler has the same condition. */}
          <button
            key="faucet"
            type="button"
            aria-disabled={anyRunning}
            onClick={() => {
              if (!anyRunning) onGet(token);
            }}
            className={PRIMARY}
          >
            {running ? "Waiting for your wallet…" : "Get test tUSDC"}
          </button>
        </>
      )}
      {notice}
    </section>
  );
}
