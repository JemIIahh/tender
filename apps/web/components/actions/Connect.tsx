"use client";

import { useState } from "react";
import { SIGN_IN } from "../../lib/copy";
import type { UseWallet } from "../../lib/wallet";
import { walletErrorMessage } from "../../lib/walletErrors";
import { PRIMARY } from "../ui";

/** The way in for someone not signed in: Sign in, which opens the Connect window, and its failure. */
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
        {SIGN_IN}
      </button>
      {failure === null ? null : (
        <p role="alert" className="text-sm text-seal">
          {failure}
        </p>
      )}
    </div>
  );
}
