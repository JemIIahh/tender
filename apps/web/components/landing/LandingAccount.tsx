"use client";

import { useSyncExternalStore } from "react";
import { walletStore } from "../../lib/wallet";
import { AccountPill } from "../AccountPill";

/**
 * The landing top bar's account: the connected account's pill, as the app's top bar shows it, or
 * nothing. It reads the tab's wallet as the app shell does, without looking for one (connecting is
 * the app's), so it shows once a page of the app has connected or restored the wallet in this tab;
 * until the browser knows (`ready`), and on the server, it shows nothing.
 */
export function LandingAccount() {
  const { ready, accountId } = useSyncExternalStore(
    walletStore.subscribe,
    walletStore.getSnapshot,
    walletStore.getServerSnapshot,
  );
  if (!ready || accountId === null) return null;
  return <AccountPill accountId={accountId} />;
}
