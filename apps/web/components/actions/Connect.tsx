"use client";

import { useState } from "react";
import type { UseWallet } from "../../lib/wallet";
import { walletErrorMessage } from "../../lib/walletErrors";
import { PRIMARY } from "../ui";

/** The way in for someone with no wallet connected: a Connect button and its failure. */
export function Connect({ wallet, why }: { wallet: UseWallet; why?: string }) {
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <div className="grid gap-3">
      {why === undefined ? null : <p className="text-[14px] text-muted">{why}</p>}
      <button
        type="button"
        className={PRIMARY}
        onClick={() => {
          setFailure(null);
          wallet.connect().catch((error: unknown) => {
            console.error(error);
            setFailure(walletErrorMessage(error));
          });
        }}
      >
        Connect wallet
      </button>
      {failure === null ? null : (
        <p role="alert" className="text-sm text-seal">
          {failure}
        </p>
      )}
    </div>
  );
}
