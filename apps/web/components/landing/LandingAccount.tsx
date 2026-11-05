"use client";

import { useEffect, useSyncExternalStore } from "react";
import { walletStore } from "../../lib/wallet";
import { AccountPill } from "../AccountPill";

/**
 * The landing top bar's account: the connected account's pill, as the app's top bar shows it, or
 * nothing. Once the page is in the browser it starts the tab's wallet store, which loads the wallet
 * library on its own (lib/wallet.ts) and takes up the wallet of an earlier visit, so a person who
 * connected before sees their account at once. It never offers to connect: that is the app's. On
 * the server, and until the store knows (`ready`), it shows nothing.
 */
export function LandingAccount() {
  const { ready, accountId } = useSyncExternalStore(
    walletStore.subscribe,
    walletStore.getSnapshot,
    walletStore.getServerSnapshot,
  );
  useEffect(() => {
    void walletStore.start();
  }, []);
  if (!ready || accountId === null) return null;
  return <AccountPill accountId={accountId} />;
}
